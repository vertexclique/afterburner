//! `WasmCombustor` — the untrusted-code path. Wasmtime instantiates a
//! per-user self-contained Javy module (QuickJS compiled to WASI with the
//! user's JS embedded as bytecode). Full sandbox: fuel metering, memory
//! caps, epoch-based wall-clock timeouts, and zero ambient authority.
//!
//! Compilation uses Javy's static-link mode (`javy build`): each script
//! produces a self-contained ~1.3 MB module. Dynamic-link mode yields
//! ~500 B stubs but the linker wiring isn't reliable on Javy 8.1.1, and
//! the size win is moot once compiled `wasmtime::Module`s are cached
//! behind `Arc`.

use crate::compiler::compile_js_to_wasm;
use crate::host::HostState;
use crate::intake::serialize_input;
use crate::nozzle::parse_output;
use afterburner_core::log::Level;
use afterburner_core::{
    AfterburnerError, Combustor, EngineMode, FuelGauge, Result, ScriptId, ab_event, sha256,
};
use kovan_map::HopscotchMap;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, Module, OptLevel, Store, Trap};
use wasmtime_wasi::I32Exit;
use wasmtime_wasi::preview1::add_to_linker_sync;

/// How often the shared epoch ticker ticks. The minimum supported timeout
/// granularity is one tick. 10 ms is fine for security-style timeouts and
/// keeps idle CPU at noise level.
const TICK_PERIOD_MS: u64 = 10;

/// Stderr capture limit for the trap-diagnosis fallback. Past this we
/// truncate to keep error strings manageable.
const STDERR_DIAGNOSIS_CAP: usize = 4 * 1024;

/// Per-call stdout buffer. Scripts returning more than this trigger
/// `AfterburnerError::OutputTooLarge`.
const STDOUT_CAPACITY: usize = 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct WasmConfig {
    /// Path to the `javy` CLI used for JS → WASM stub compilation. When
    /// `None`, the literal string `javy` is invoked, relying on `PATH`.
    pub javy_binary: Option<PathBuf>,
}

pub struct WasmCombustor {
    engine: Engine,
    script_cache: HopscotchMap<[u8; 32], Module>,
    /// Resolved Javy CLI path. Configured explicitly via
    /// `WasmConfig::javy_binary`; defaults to `"javy"` (PATH lookup).
    javy_binary: PathBuf,
    /// Long-lived epoch ticker. Owns its own shutdown signal so `Drop`
    /// can join it cleanly.
    ticker_shutdown: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl WasmCombustor {
    pub fn new(config: WasmConfig) -> Result<Self> {
        let mut engine_config = Config::new();
        engine_config
            .consume_fuel(true)
            .epoch_interruption(true)
            .memory_init_cow(true)
            .cranelift_opt_level(OptLevel::Speed);

        let engine = Engine::new(&engine_config)
            .map_err(|e| AfterburnerError::Engine(format!("wasmtime engine: {e}")))?;

        let javy_binary = config.javy_binary.unwrap_or_else(|| PathBuf::from("javy"));

        // One ticker per WasmCombustor. `increment_epoch` is engine-global,
        // so the previous per-thrust sleeper design caused two problems:
        //   1. Any timed thrust's expiry tripped *every* concurrent
        //      thrust whose deadline was set to the same delta.
        //   2. Thread-per-call accumulated under high QPS — a 30 s
        //      timeout with 1 ms calls left thousands of threads alive.
        // The ticker fixes both: tick every TICK_PERIOD_MS and let each
        // thrust's per-store deadline (in ticks) decide independently.
        let ticker_shutdown = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let shutdown = ticker_shutdown.clone();
            thread::spawn(move || {
                while !shutdown.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(TICK_PERIOD_MS));
                    engine.increment_epoch();
                }
            })
        };

        Ok(Self {
            engine,
            script_cache: HopscotchMap::new(),
            javy_binary,
            ticker_shutdown,
            ticker: Some(ticker),
        })
    }
}

impl Drop for WasmCombustor {
    fn drop(&mut self) {
        self.ticker_shutdown.store(true, Ordering::Release);
        if let Some(t) = self.ticker.take() {
            // Worst case: one TICK_PERIOD_MS until the ticker observes
            // the shutdown flag and exits its sleep.
            let _ = t.join();
        }
    }
}

impl Combustor for WasmCombustor {
    #[fastrace::trace(name = "WasmCombustor::ignite")]
    fn ignite(&self, source: &str) -> Result<ScriptId> {
        // Hash the user-facing source so `ScriptId`s match across
        // backends (Adaptive needs that). The bytes handed to `javy
        // build` are the wrapped version.
        let hash = sha256(source.as_bytes());

        if self.script_cache.get(&hash).is_some() {
            ab_event!(Level::Debug, "wasm.ignite.cache_hit", "hash" => hex8(&hash));
            return Ok(ScriptId {
                hash,
                mode: EngineMode::Wasm,
            });
        }

        ab_event!(
            Level::Info,
            "wasm.ignite.compile_start",
            "hash" => hex8(&hash),
            "source_bytes" => source.len(),
        );
        let wrapped = wrap_user_source(source);
        let stub_bytes = compile_js_to_wasm(&self.javy_binary, &wrapped)?;
        let module = Module::new(&self.engine, &stub_bytes)
            .map_err(|e| AfterburnerError::CompileFailed(format!("stub module: {e}")))?;
        self.script_cache.insert(hash, module);
        ab_event!(
            Level::Info,
            "wasm.ignite.compile_done",
            "hash" => hex8(&hash),
            "module_bytes" => stub_bytes.len(),
        );

        Ok(ScriptId {
            hash,
            mode: EngineMode::Wasm,
        })
    }

    #[fastrace::trace(name = "WasmCombustor::thrust")]
    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        // HopscotchMap::get returns V (cloned). Module is Arc-backed so
        // the clone is cheap — no module re-compilation.
        let stub_module = self
            .script_cache
            .get(&id.hash)
            .ok_or(AfterburnerError::ScriptNotFound)?;

        let input_bytes = serialize_input(input)?;
        let state = HostState::new(&input_bytes, limits.memory_bytes, STDOUT_CAPACITY);
        let mut store = Store::new(&self.engine, state);

        // Apply memory limits via the ResourceLimiter on the store.
        store.limiter(|s| &mut s.limits);

        // `consume_fuel(true)` is engine-wide; `None` means uncapped, which
        // we model by setting fuel to u64::MAX.
        let fuel = limits.fuel.unwrap_or(u64::MAX);
        store
            .set_fuel(fuel)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;

        // Each thrust gets an independent absolute deadline expressed in
        // ticks. `set_epoch_deadline(delta)` stores `current_epoch + delta`
        // per-store, so the global ticker firing cannot affect any thrust
        // whose remaining ticks haven't elapsed.
        if let Some(ms) = limits.timeout_ms {
            let ticks = ms.div_ceil(TICK_PERIOD_MS).max(1);
            store.set_epoch_deadline(ticks);
        } else {
            // Half u64::MAX (≈ 2.9 billion years at this tick rate)
            // avoids the overflow that `u64::MAX` would cause inside
            // `current_epoch + delta`.
            store.set_epoch_deadline(u64::MAX / 2);
        }

        // Static-linked Javy modules only need WASI preview1 imports.
        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)
            .map_err(|e| AfterburnerError::Engine(format!("wasi linker: {e}")))?;

        let instance = linker
            .instantiate(&mut store, &stub_module)
            .map_err(|e| AfterburnerError::Engine(format!("instantiate: {e}")))?;

        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;

        let call_result = start.call(&mut store, ());

        if let Err(trap) = call_result {
            if let Some(exit) = trap.downcast_ref::<I32Exit>() {
                if exit.0 != 0 {
                    ab_event!(
                        Level::Warn,
                        "wasm.thrust.nonzero_exit",
                        "code" => exit.0,
                    );
                    return Err(AfterburnerError::WasmTrap(format!(
                        "script exited with non-zero code {}",
                        exit.0
                    )));
                }
                // proc_exit(0) — fall through to stdout drain.
            } else if let Some(t) = trap.downcast_ref::<Trap>() {
                match t {
                    Trap::Interrupt => {
                        ab_event!(Level::Warn, "wasm.thrust.timeout");
                        return Err(AfterburnerError::Timeout);
                    }
                    Trap::OutOfFuel => {
                        ab_event!(Level::Warn, "wasm.thrust.fuel_exhausted");
                        return Err(AfterburnerError::FuelExhausted);
                    }
                    other => {
                        let msg = format_trap_with_stderr(&format!("{other}"), &mut store);
                        ab_event!(Level::Warn, "wasm.thrust.trap", "kind" => other);
                        return Err(AfterburnerError::WasmTrap(msg));
                    }
                }
            } else {
                // Failures that aren't a typed Trap (e.g. memory-grow
                // rejections from the ResourceLimiter) come through as
                // plain anyhow errors; inspect the chain.
                let chain: Vec<String> = trap.chain().map(|e| format!("{e}")).collect();
                let full = chain.join(" => ");
                if full.contains("memory minimum size") || full.contains("memory size") {
                    ab_event!(Level::Warn, "wasm.thrust.memory_limit");
                    return Err(AfterburnerError::MemoryLimit);
                }
                let msg = format_trap_with_stderr(&full, &mut store);
                return Err(AfterburnerError::WasmTrap(msg));
            }
        }

        let stdout_bytes = drain_stdout(&mut store);
        let capacity = store.data().stdout_capacity;
        if stdout_bytes.len() >= capacity {
            ab_event!(
                Level::Warn,
                "wasm.thrust.output_too_large",
                "limit" => capacity,
            );
            return Err(AfterburnerError::OutputTooLarge { limit: capacity });
        }
        parse_output(&stdout_bytes)
    }

    fn extinguish(&self, id: &ScriptId) {
        self.script_cache.remove(&id.hash);
        ab_event!(Level::Info, "wasm.extinguish", "hash" => hex8(&id.hash));
    }
}

fn drain_stdout(store: &mut Store<HostState>) -> Vec<u8> {
    store.data().stdout.contents().to_vec()
}

/// Append a snippet of guest stderr (if any) to a trap message. Helps
/// diagnose `throw`s and runtime errors that QuickJS prints there.
fn format_trap_with_stderr(base: &str, store: &mut Store<HostState>) -> String {
    let stderr = store.data().stderr.contents();
    if stderr.is_empty() {
        return base.to_string();
    }
    let visible = &stderr[..stderr.len().min(STDERR_DIAGNOSIS_CAP)];
    let text = String::from_utf8_lossy(visible);
    let truncated = if stderr.len() > STDERR_DIAGNOSIS_CAP {
        " (truncated)"
    } else {
        ""
    };
    format!("{base}\nstderr{truncated}: {text}")
}

/// Hex-encode the first 8 bytes of a 32-byte hash for logging.
fn hex8(hash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(16);
    for b in &hash[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Wrap a user source (`module.exports = function(input) { ... }`) in a
/// Javy-compatible I/O envelope. The user source is parsed via the
/// `Function` constructor with `module` and `exports` bound as parameters,
/// so user-side text cannot break out of the host wrapper (e.g. by
/// closing an enclosing IIFE early).
fn wrap_user_source(user: &str) -> String {
    let user_lit = js_string_literal(user);
    // Two-layer strategy:
    //
    // 1. Static parse probe (`__ab_parse_probe`): the user source is
    //    inlined into an unused function declaration. `javy build` parses
    //    it at compile time, so syntax errors surface at `ignite` as
    //    `CompileFailed` instead of at `thrust`. Any attempt by the user
    //    to prematurely close the wrapper throws the surrounding braces
    //    out of balance and is rejected by the same parse.
    // 2. Runtime execution via `new Function`: isolates the user's scope
    //    from the host wrapper. The user cannot accidentally clobber
    //    host bindings no matter what control-flow tricks their source
    //    includes.
    format!(
        r#"
        // -- static parse probe (never called; present for compile-time syntax check) --
        function __ab_parse_probe(module, exports) {{
            {user_inline}
        }}

        function __ab_read_stdin() {{
            const buf = new Uint8Array(8192);
            let out = '';
            while (true) {{
                const n = Javy.IO.readSync(0, buf);
                if (n === 0) break;
                out += new TextDecoder().decode(buf.subarray(0, n));
            }}
            return out;
        }}
        function __ab_write_stdout(s) {{
            Javy.IO.writeSync(1, new TextEncoder().encode(s));
        }}
        const __ab_input = __ab_read_stdin();
        const __ab_data = __ab_input.length ? JSON.parse(__ab_input) : null;
        const __ab_module = {{ exports: undefined }};
        const __ab_user = new Function('module', 'exports', {user_lit});
        __ab_user(__ab_module, __ab_module.exports);
        const __ab_fn = __ab_module.exports;
        const __ab_result = (typeof __ab_fn === 'function') ? __ab_fn(__ab_data) : __ab_fn;
        __ab_write_stdout(JSON.stringify(__ab_result === undefined ? null : __ab_result));
        "#,
        user_inline = user,
        user_lit = user_lit,
    )
}

/// Escape a Rust string into a JS string literal for safe embedding.
fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::config_with_resolved_javy;
    use afterburner_core::BurnCache;
    use serde_json::json;

    fn make_combustor() -> Option<WasmCombustor> {
        Some(WasmCombustor::new(config_with_resolved_javy()?).unwrap())
    }

    fn combust(source: &str, input: Value) -> Result<Value> {
        let Some(c) = make_combustor() else {
            return Ok(Value::Null);
        };
        let id = c.ignite(source)?;
        c.thrust(&id, &input, &FuelGauge::unlimited())
    }

    #[test]
    fn eval_arithmetic_module_exports() {
        let Some(_) = make_combustor() else { return };
        let out = combust("module.exports = () => 1 + 2", json!(null)).unwrap();
        assert_eq!(out, json!(3));
    }

    #[test]
    fn eval_reads_input_through_envelope() {
        let Some(_) = make_combustor() else { return };
        let out = combust(
            "module.exports = (d) => ({ doubled: d.n * 2 })",
            json!({ "n": 21 }),
        )
        .unwrap();
        assert_eq!(out, json!({"doubled": 42}));
    }

    #[test]
    fn eval_array_map() {
        let Some(_) = make_combustor() else { return };
        let out = combust(
            "module.exports = (d) => d.xs.map(x => x * 2)",
            json!({ "xs": [1, 2, 3] }),
        )
        .unwrap();
        assert_eq!(out, json!([2, 4, 6]));
    }

    #[test]
    fn hash_is_content_addressed_wasm() {
        let Some(c) = make_combustor() else { return };
        let id1 = c.ignite("const x = 1;").unwrap();
        let id2 = c.ignite("const x = 1;").unwrap();
        assert_eq!(id1.hash, id2.hash);
    }

    #[test]
    fn script_not_found_after_extinguish_wasm() {
        let Some(c) = make_combustor() else { return };
        let id = c.ignite("const x = 1;").unwrap();
        c.extinguish(&id);
        let err = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap_err();
        assert!(matches!(err, AfterburnerError::ScriptNotFound));
    }

    #[test]
    fn compile_failed_on_syntax_error_wasm() {
        let Some(c) = make_combustor() else { return };
        let err = c.ignite("const x = (").unwrap_err();
        assert!(matches!(err, AfterburnerError::CompileFailed(_)));
    }

    #[test]
    fn execute_batch_end_to_end() {
        let Some(c) = make_combustor() else { return };
        let source = "module.exports = (rows) => rows.map(r => ({ doubled: r.n * 2 }))";
        let cache = BurnCache::new(Box::new(c));
        let id = cache.register(source).unwrap();
        let input = json!([{"n": 1}, {"n": 2}, {"n": 3}]);
        let out = cache
            .execute_batch(&id, &input, &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(
            out,
            json!([{"doubled": 2}, {"doubled": 4}, {"doubled": 6}])
        );
    }
}

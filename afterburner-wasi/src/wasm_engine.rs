//! `WasmCombustor` — untrusted-code path. Instantiates a
//! Wizer-preinitialized Afterburner Javy plugin into a fresh `Store`
//! per thrust and feeds the user source + input as a JSON envelope on
//! stdin. The plugin compiles the source in-process via
//! `javy_plugin_api::compile_src` and runs it; `afterburner:host`
//! imports give capability-gated access to fs/crypto/os/http.
//!
//! No `javy` CLI is involved at runtime. The only JS → bytecode work
//! happens inside the sandbox, driven by the plugin.
//!
//! ### Lifecycle
//!
//! * `WasmCombustor::new` pre-compiles the plugin module once and
//!   starts the shared epoch ticker.
//! * `ignite(source)` hashes the source and stashes it in-memory — no
//!   compilation. `ScriptId` is content-addressed so identical sources
//!   hash identically across backends (`Adaptive` relies on that).
//! * `thrust(id, input, limits)` looks up the cached source, serializes
//!   `{source, input}` onto stdin, instantiates plugin + runs `_start`,
//!   and reads the JSON result from stdout.

use crate::host::HostState;
use crate::host_imports;
use crate::nozzle::parse_output;
use afterburner_core::log::Level;
use afterburner_core::{
    AfterburnerError, Combustor, EngineMode, FuelGauge, InMemoryStateStore, Result, ScriptId,
    SharedStateStore, ab_event, sha256,
};
use kovan_map::HopscotchMap;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, Module, OptLevel, Store, Trap};
use wasmtime_wasi::I32Exit;
use wasmtime_wasi::preview1::add_to_linker_sync;

/// The custom plugin binary (Wizer-preinitialized), committed to the
/// repo and baked into the host crate at compile time.
const PLUGIN_BYTES: &[u8] = include_bytes!("../../quickjs-provider/afterburner_plugin.wasm");

/// Epoch ticker period. Minimum timeout granularity = one tick.
const TICK_PERIOD_MS: u64 = 10;

/// Stderr capture limit for trap-diagnosis messages.
const STDERR_DIAGNOSIS_CAP: usize = 4 * 1024;

/// Per-call stdout buffer. Scripts returning more than this trigger
/// `AfterburnerError::OutputTooLarge`.
const STDOUT_CAPACITY: usize = 1024 * 1024;

#[derive(Default, Clone)]
pub struct WasmConfig {
    /// Cross-invocation key/value store visible to scripts via
    /// `require('afterburner:state')`. `None` falls back to a fresh
    /// in-memory store created at `WasmCombustor::new`.
    pub state_store: Option<SharedStateStore>,
    /// Optional embedder-provided host context. Scripts that call
    /// `require('afterburner:host').readColumn` / `emitRow` dispatch
    /// through this context; unset means `readColumn` returns `[]` and
    /// `emitRow` is a no-op.
    pub host_context: Option<Arc<dyn afterburner_core::HostContext>>,
}

pub struct WasmCombustor {
    engine: Engine,
    /// Source store keyed by SHA-256 of the user-facing source. `ignite`
    /// hashes and stashes; `thrust` looks up and feeds to the plugin.
    source_store: HopscotchMap<[u8; 32], String>,
    /// Pre-compiled plugin `Module`. Instantiated into every thrust's
    /// fresh `Store`.
    plugin_module: Module,
    /// Cross-invocation state store passed to every thrust.
    state_store: SharedStateStore,
    /// Optional host context — ScramDB-facing read_column/emit_row hooks.
    host_context: Option<Arc<dyn afterburner_core::HostContext>>,
    /// Long-lived epoch ticker; one per `WasmCombustor`.
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
        let plugin_module = Module::new(&engine, PLUGIN_BYTES)
            .map_err(|e| AfterburnerError::Engine(format!("plugin module: {e}")))?;

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

        let state_store = config
            .state_store
            .unwrap_or_else(InMemoryStateStore::shared);

        Ok(Self {
            engine,
            source_store: HopscotchMap::new(),
            plugin_module,
            state_store,
            host_context: config.host_context,
            ticker_shutdown,
            ticker: Some(ticker),
        })
    }

    /// Hand-out the active `StateStore` so embedders can inspect /
    /// pre-populate it from outside the script.
    pub fn state_store(&self) -> &SharedStateStore {
        &self.state_store
    }
}

impl Drop for WasmCombustor {
    fn drop(&mut self) {
        self.ticker_shutdown.store(true, Ordering::Release);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
}

impl Combustor for WasmCombustor {
    #[fastrace::trace(name = "WasmCombustor::ignite")]
    fn ignite(&self, source: &str) -> Result<ScriptId> {
        let hash = sha256(source.as_bytes());
        if self.source_store.get(&hash).is_some() {
            ab_event!(Level::Debug, "wasm.ignite.cache_hit", "hash" => hex8(&hash));
        } else {
            self.source_store.insert(hash, source.to_string());
            ab_event!(
                Level::Info,
                "wasm.ignite.stashed",
                "hash" => hex8(&hash),
                "source_bytes" => source.len(),
            );
        }
        Ok(ScriptId {
            hash,
            mode: EngineMode::Wasm,
        })
    }

    #[fastrace::trace(name = "WasmCombustor::thrust")]
    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        let source = self
            .source_store
            .get(&id.hash)
            .ok_or(AfterburnerError::ScriptNotFound)?;

        let envelope = serde_json::json!({ "source": source, "input": input });
        let envelope_bytes = serde_json::to_vec(&envelope)?;

        let state = HostState::new(
            &envelope_bytes,
            limits.memory_bytes,
            STDOUT_CAPACITY,
            limits.manifold.clone(),
            self.state_store.clone(),
            self.host_context.clone(),
        );
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);

        let fuel = limits.fuel.unwrap_or(u64::MAX);
        store
            .set_fuel(fuel)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;

        if let Some(ms) = limits.timeout_ms {
            let ticks = ms.div_ceil(TICK_PERIOD_MS).max(1);
            store.set_epoch_deadline(ticks);
        } else {
            store.set_epoch_deadline(u64::MAX / 2);
        }

        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)
            .map_err(|e| AfterburnerError::Engine(format!("wasi linker: {e}")))?;
        host_imports::register(&mut linker)?;

        let instance = linker
            .instantiate(&mut store, &self.plugin_module)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate: {e}")))?;

        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;
        let call_result = start.call(&mut store, ());

        if let Err(trap) = call_result {
            if let Some(exit) = trap.downcast_ref::<I32Exit>() {
                if exit.0 != 0 {
                    ab_event!(Level::Warn, "wasm.thrust.nonzero_exit", "code" => exit.0);
                    let msg = format_trap_with_stderr(
                        &format!("script exited with non-zero code {}", exit.0),
                        &mut store,
                    );
                    return Err(AfterburnerError::WasmTrap(msg));
                }
                // proc_exit(0): fall through to stdout drain.
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
        self.source_store.remove(&id.hash);
        ab_event!(Level::Info, "wasm.extinguish", "hash" => hex8(&id.hash));
    }
}

fn drain_stdout(store: &mut Store<HostState>) -> Vec<u8> {
    store.data().stdout.contents().to_vec()
}

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

fn hex8(hash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(16);
    for b in &hash[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use afterburner_core::BurnCache;
    use serde_json::json;

    fn make_combustor() -> WasmCombustor {
        WasmCombustor::new(WasmConfig::default()).unwrap()
    }

    #[test]
    fn eval_arithmetic_module_exports() {
        let c = make_combustor();
        let id = c.ignite("module.exports = () => 1 + 2").unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!(3));
    }

    #[test]
    fn eval_reads_input_through_envelope() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = (d) => ({ doubled: d.n * 2 })")
            .unwrap();
        let out = c
            .thrust(&id, &json!({ "n": 21 }), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!({"doubled": 42}));
    }

    #[test]
    fn eval_array_map() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = (d) => d.xs.map(x => x * 2)")
            .unwrap();
        let out = c
            .thrust(&id, &json!({ "xs": [1, 2, 3] }), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!([2, 4, 6]));
    }

    #[test]
    fn wasm_require_path_join_works() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = () => require('path').join('/a', 'b', 'c.js')")
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("/a/b/c.js"));
    }

    #[test]
    fn wasm_require_buffer_base64_roundtrip() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    const { Buffer } = require('buffer');
                    return Buffer.from('hello world').toString('base64');
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("aGVsbG8gd29ybGQ="));
    }

    #[test]
    fn wasm_require_events_emitter_roundtrip() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    const EE = require('events');
                    const e = new EE();
                    let hits = 0;
                    e.on('tick', (n) => { hits += n; });
                    e.emit('tick', 3);
                    e.emit('tick', 4);
                    return hits;
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!(7));
    }

    #[test]
    fn wasm_require_unknown_module_throws() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    try { require('no-such-module'); return 'unexpected'; }
                    catch (e) { return e.message; }
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("Cannot find module 'no-such-module'"));
    }

    #[test]
    fn hash_is_content_addressed_wasm() {
        let c = make_combustor();
        let id1 = c.ignite("const x = 1;").unwrap();
        let id2 = c.ignite("const x = 1;").unwrap();
        assert_eq!(id1.hash, id2.hash);
    }

    #[test]
    fn script_not_found_after_extinguish_wasm() {
        let c = make_combustor();
        let id = c.ignite("const x = 1;").unwrap();
        c.extinguish(&id);
        let err = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap_err();
        assert!(matches!(err, AfterburnerError::ScriptNotFound));
    }

    #[test]
    fn execute_batch_end_to_end() {
        let c = make_combustor();
        let source = "module.exports = (rows) => rows.map(r => ({ doubled: r.n * 2 }))";
        let cache = BurnCache::new(Box::new(c));
        let id = cache.register(source).unwrap();
        let input = json!([{"n": 1}, {"n": 2}, {"n": 3}]);
        let out = cache
            .execute_batch(&id, &input, &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!([{"doubled": 2}, {"doubled": 4}, {"doubled": 6}]));
    }
}

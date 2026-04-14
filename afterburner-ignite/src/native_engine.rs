//! `NativeCombustor` — executes JS via `rquickjs` FFI directly (no WASM).
//!
//! The trusted-code path. No sandbox beyond QuickJS's own fuel/memory
//! knobs, but startup is <300 μs and throughput is higher than the WASM
//! route for short-lived scripts.
//!
//! ### Concurrency model — thread-local runtimes
//!
//! rquickjs's `Runtime`/`Context` are `!Send`/`!Sync` (without the
//! `parallel` feature, which drags in tokio). Rather than serialize
//! access with a Mutex, each client thread gets its own lazily-created
//! `Runtime` via `thread_local!`. There is **no cross-thread
//! synchronization** on the hot path — two client threads can call
//! `thrust` concurrently without ever talking to each other.
//!
//! Shared state:
//! * `source_store` — lock-free `kovan_map::HopscotchMap` caching the
//!   JS source text, keyed by SHA-256 of the source. Any thread can
//!   read a source another thread ignited.
//!
//! Trade-off: each client thread carries a per-thread Runtime (~100 KB
//! residual memory). In practice the caller is a small pool of worker
//! threads, so the memory footprint is bounded and the throughput win
//! is substantial.

use afterburner_core::log::Level;
use afterburner_core::{
    AfterburnerError, Combustor, EngineMode, FuelGauge, InMemoryStateStore, Result, ScriptId,
    SharedStateStore, ab_event, sha256,
};
use kovan_map::HopscotchMap;
use rquickjs::{Context, Ctx, Error as RquickjsError, Runtime, Value as RqValue};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

thread_local! {
    /// One rquickjs Runtime per client thread. Lazily initialized on
    /// first use. Wrapped in RefCell because we need `&mut` access to
    /// the interrupt-handler slot; RefCell is single-threaded, not a
    /// synchronization primitive.
    static THREAD_RT: RefCell<Option<ThreadRuntime>> = const { RefCell::new(None) };
}

struct ThreadRuntime {
    runtime: Runtime,
    context: Context,
}

impl ThreadRuntime {
    fn new() -> std::result::Result<Self, AfterburnerError> {
        let runtime = Runtime::new()
            .map_err(|e| AfterburnerError::Engine(format!("rquickjs runtime init: {e}")))?;
        let context = Context::full(&runtime)
            .map_err(|e| AfterburnerError::Engine(format!("rquickjs context init: {e}")))?;

        // Eval the plenum bundle once per thread-local Runtime so every
        // thrust on this thread can `require('path')` etc. without
        // paying the ~45 KB parse cost again. Host-backed modules
        // (`fs`, `crypto`, `os`, `http`) are wired here too — the
        // per-thrust Manifold is read via a thread-local slot that
        // `do_thrust` populates for the duration of each call.
        context.with(|ctx| -> std::result::Result<(), AfterburnerError> {
            install_host_globals(&ctx)?;
            afterburner_node_compat::register_native_builtins(&ctx)?;
            ctx.eval::<(), _>(afterburner_node_compat::PLENUM_BUNDLE.as_bytes())
                .map_err(|e| AfterburnerError::Engine(format!("plenum bundle eval: {e}")))?;
            Ok(())
        })?;

        Ok(Self { runtime, context })
    }
}

/// Install the small set of host-provided globals the plenum bundle
/// expects (currently just `__host_log` for `console.*`). Keeps the JS
/// side agnostic to where logs end up.
fn install_host_globals(ctx: &Ctx<'_>) -> std::result::Result<(), AfterburnerError> {
    use rquickjs::Function;
    let globals = ctx.globals();
    globals
        .set(
            "__host_log",
            Function::new(ctx.clone(), |level: String, msg: String| {
                host_log(&level, &msg);
            })
            .map_err(|e| AfterburnerError::Engine(format!("Function::new host_log: {e}")))?,
        )
        .map_err(|e| AfterburnerError::Engine(format!("globals.set host_log: {e}")))?;
    Ok(())
}

fn host_log(level: &str, msg: &str) {
    use afterburner_core::ab_event;
    use afterburner_core::log::Level;
    let level = match level {
        "error" => Level::Error,
        "warn" => Level::Warn,
        "debug" => Level::Debug,
        _ => Level::Info,
    };
    ab_event!(level, "script.console", "message" => msg);
}

/// Run a closure with access to the current thread's `ThreadRuntime`,
/// initializing it lazily on first use.
fn with_thread_rt<R>(f: impl FnOnce(&ThreadRuntime) -> Result<R>) -> Result<R> {
    THREAD_RT.with(|slot| {
        let mut borrow = slot.borrow_mut();
        if borrow.is_none() {
            *borrow = Some(ThreadRuntime::new()?);
        }
        let rt = borrow
            .as_ref()
            .ok_or_else(|| AfterburnerError::Engine("thread runtime uninitialized".into()))?;
        f(rt)
    })
}

pub struct NativeCombustor {
    source_store: HopscotchMap<[u8; 32], String>,
    state_store: SharedStateStore,
}

impl NativeCombustor {
    pub fn new() -> Result<Self> {
        Self::with_state_store(InMemoryStateStore::shared())
    }

    /// Construct a combustor backed by an explicit state store.
    pub fn with_state_store(state_store: SharedStateStore) -> Result<Self> {
        with_thread_rt(|_rt| Ok(()))?;
        Ok(Self {
            source_store: HopscotchMap::new(),
            state_store,
        })
    }

    pub fn state_store(&self) -> &SharedStateStore {
        &self.state_store
    }
}

impl Combustor for NativeCombustor {
    #[fastrace::trace(name = "NativeCombustor::ignite")]
    fn ignite(&self, source: &str) -> Result<ScriptId> {
        let hash = sha256(source.as_bytes());
        // Fast-path: source already registered — skip the parse probe.
        if self.source_store.get(&hash).is_some() {
            ab_event!(Level::Debug, "native.ignite.cache_hit");
            return Ok(ScriptId {
                hash,
                mode: EngineMode::Native,
            });
        }
        // Cheap parse check against this thread's Runtime. Syntax errors
        // surface here rather than at thrust time.
        with_thread_rt(|rt| {
            rt.context.with(|ctx| -> Result<()> {
                let probe = format!("(function(){{ {source}\nreturn undefined; }})");
                let _: RqValue<'_> = ctx
                    .eval(probe.as_bytes())
                    .map_err(|e| AfterburnerError::CompileFailed(format!("{e}")))?;
                Ok(())
            })
        })?;
        self.source_store.insert(hash, source.to_string());
        ab_event!(Level::Info, "native.ignite.compiled", "source_bytes" => source.len());
        Ok(ScriptId {
            hash,
            mode: EngineMode::Native,
        })
    }

    #[fastrace::trace(name = "NativeCombustor::thrust")]
    fn thrust(&self, id: &ScriptId, input: &JsonValue, limits: &FuelGauge) -> Result<JsonValue> {
        let source = self
            .source_store
            .get(&id.hash)
            .ok_or(AfterburnerError::ScriptNotFound)?;
        let input_json = serde_json::to_string(input)?;
        let output_json = with_thread_rt(|rt| {
            // Thread the engine's state store into the per-thrust slot.
            let _g = afterburner_node_compat::state_active::activate(self.state_store.clone());
            do_thrust(rt, &source, &input_json, limits)
        })?;
        Ok(serde_json::from_str(&output_json)?)
    }

    fn extinguish(&self, id: &ScriptId) {
        self.source_store.remove(&id.hash);
        ab_event!(Level::Info, "native.extinguish");
    }
}

/// Actual script execution — runs on the caller's thread against the
/// thread-local `ThreadRuntime`.
fn do_thrust(
    rt: &ThreadRuntime,
    source: &str,
    input_json: &str,
    limits: &FuelGauge,
) -> Result<String> {
    // Activate the per-thrust manifold so host globals can read it. The
    // guard restores the previous value when `do_thrust` returns.
    let _manifold_guard =
        afterburner_node_compat::active_manifold::activate(limits.manifold.clone());

    rt.runtime
        .set_memory_limit(limits.memory_bytes.unwrap_or(0));

    let fuel_budget = limits.fuel;
    let counter = Arc::new(AtomicU64::new(0));
    let counter_clone = counter.clone();
    rt.runtime
        .set_interrupt_handler(Some(Box::new(move || match fuel_budget {
            Some(budget) => counter_clone.fetch_add(1, Ordering::Relaxed) >= budget,
            None => false,
        })));

    let result = rt
        .context
        .with(|ctx| -> Result<String> { run_script(&ctx, source, input_json) });

    // Unwire the interrupt handler so a stale closure doesn't outlive the call.
    rt.runtime.set_interrupt_handler(None);

    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            if let Some(budget) = fuel_budget
                && counter.load(Ordering::Relaxed) >= budget
            {
                ab_event!(Level::Warn, "native.thrust.fuel_exhausted", "budget" => budget);
                return Err(AfterburnerError::FuelExhausted);
            }
            Err(e)
        }
    }
}

/// Build + evaluate the envelope-wrapped script and return
/// `JSON.stringify(result)`.
fn run_script(ctx: &Ctx<'_>, source: &str, input_json: &str) -> Result<String> {
    let stage = format!(
        r#"
        (function() {{
            var __module = {{ exports: undefined }};
            var module = __module;
            var exports = __module.exports;
            var __input = JSON.parse({input});
            (function() {{
                {user_source}
            }})();
            var __fn = module.exports;
            var __result = (typeof __fn === 'function') ? __fn(__input) : __fn;
            return JSON.stringify(__result === undefined ? null : __result);
        }})()
        "#,
        input = js_string_literal(input_json),
        user_source = source,
    );
    let result: String = ctx.eval(stage.as_bytes()).map_err(map_rquickjs_err)?;
    Ok(result)
}

/// Convert rquickjs errors to the typed `AfterburnerError` set.
fn map_rquickjs_err(err: RquickjsError) -> AfterburnerError {
    match err {
        RquickjsError::Allocation => AfterburnerError::MemoryLimit,
        RquickjsError::Unknown => AfterburnerError::Engine("unknown rquickjs error".into()),
        ref other => {
            let msg = format!("{other}");
            if msg.contains("interrupt") || msg.contains("Interrupt") {
                AfterburnerError::FuelExhausted
            } else if msg.contains("out of memory") || msg.contains("OutOfMemory") {
                AfterburnerError::MemoryLimit
            } else if matches!(other, RquickjsError::Exception) {
                AfterburnerError::CompileFailed("uncaught exception".into())
            } else {
                AfterburnerError::Engine(msg)
            }
        }
    }
}

/// Escape a Rust string so it can be embedded as a JS string literal.
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
    use serde_json::json;

    fn combust(source: &str, input: JsonValue) -> Result<JsonValue> {
        let c = NativeCombustor::new()?;
        let id = c.ignite(source)?;
        c.thrust(&id, &input, &FuelGauge::unlimited())
    }

    #[test]
    fn eval_arithmetic() {
        let out = combust("module.exports = () => 1 + 2", json!(null)).unwrap();
        assert_eq!(out, json!(3));
    }

    #[test]
    fn require_path_join_works() {
        let src = r#"
            const path = require('path');
            module.exports = () => path.join('/var', 'data', 'x.json');
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!("/var/data/x.json"));
    }

    #[test]
    fn require_querystring_roundtrip() {
        let src = r#"
            const qs = require('querystring');
            module.exports = () => qs.parse(qs.stringify({ a: '1', b: 'two & three' }));
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!({ "a": "1", "b": "two & three" }));
    }

    #[test]
    fn require_events_emitter_roundtrip() {
        let src = r#"
            const EventEmitter = require('events');
            module.exports = () => {
                const ee = new EventEmitter();
                let captured = null;
                ee.on('ping', (x) => { captured = x; });
                ee.emit('ping', 42);
                return captured;
            };
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!(42));
    }

    #[test]
    fn require_buffer_hex_roundtrip() {
        let src = r#"
            const { Buffer } = require('buffer');
            module.exports = () => Buffer.from('afterburner').toString('hex');
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!("61667465726275726e6572"));
    }

    #[test]
    fn require_unknown_module_throws() {
        let src = r#"
            module.exports = () => {
                try { require('no-such-module'); return 'unexpected'; }
                catch (e) { return e.message; }
            };
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!("Cannot find module 'no-such-module'"));
    }

    #[test]
    fn require_node_prefix_stripped() {
        let src = r#"
            const path = require('node:path');
            module.exports = () => path.basename('/a/b/c.js');
        "#;
        let out = combust(src, json!(null)).unwrap();
        assert_eq!(out, json!("c.js"));
    }

    #[test]
    fn eval_string_ops() {
        let out = combust(
            "module.exports = (d) => d.name.toUpperCase()",
            json!({"name": "alice"}),
        )
        .unwrap();
        assert_eq!(out, json!("ALICE"));
    }

    #[test]
    fn eval_json_roundtrip() {
        let out = combust(
            "module.exports = (d) => ({ doubled: d.n * 2, keys: Object.keys(d).length })",
            json!({"n": 21}),
        )
        .unwrap();
        assert_eq!(out, json!({"doubled": 42, "keys": 1}));
    }

    #[test]
    fn eval_array_methods() {
        let out = combust(
            "module.exports = (d) => d.xs.map(x => x * 2).reduce((a, b) => a + b, 0)",
            json!({"xs": [1, 2, 3, 4]}),
        )
        .unwrap();
        assert_eq!(out, json!(20));
    }

    #[test]
    fn eval_object_destructuring() {
        let out = combust(
            "module.exports = ({a, b}) => ({sum: a + b})",
            json!({"a": 3, "b": 4}),
        )
        .unwrap();
        assert_eq!(out, json!({"sum": 7}));
    }

    #[test]
    fn eval_es2020_optional_chain() {
        let out = combust(
            "module.exports = (d) => d?.nested?.missing ?? 'fallback'",
            json!({"nested": {}}),
        )
        .unwrap();
        assert_eq!(out, json!("fallback"));
    }

    #[test]
    fn compile_failed_on_syntax_error() {
        let c = NativeCombustor::new().unwrap();
        let err = c.ignite("module.exports = (").unwrap_err();
        match err {
            AfterburnerError::CompileFailed(_) => {}
            other => panic!("expected CompileFailed, got {other:?}"),
        }
    }

    #[test]
    fn fuel_exhaustion_returns_typed_error() {
        let c = NativeCombustor::new().unwrap();
        let id = c
            .ignite("module.exports = () => { while (true) {} }")
            .unwrap();
        let limits = FuelGauge {
            fuel: Some(1_000),
            ..FuelGauge::default()
        };
        let err = c.thrust(&id, &json!(null), &limits).unwrap_err();
        match err {
            AfterburnerError::FuelExhausted => {}
            other => panic!("expected FuelExhausted, got {other:?}"),
        }
    }

    #[test]
    fn script_not_found_after_extinguish() {
        let c = NativeCombustor::new().unwrap();
        let id = c.ignite("module.exports = () => 1").unwrap();
        c.extinguish(&id);
        let err = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap_err();
        assert!(matches!(err, AfterburnerError::ScriptNotFound));
    }

    #[test]
    fn hash_is_content_addressed() {
        let c = NativeCombustor::new().unwrap();
        let id1 = c.ignite("module.exports = () => 1").unwrap();
        let id2 = c.ignite("module.exports = () => 1").unwrap();
        assert_eq!(id1.hash, id2.hash);
    }

    #[test]
    fn cross_thread_thrust_uses_per_thread_runtime() {
        use std::thread;

        let c = Arc::new(NativeCombustor::new().unwrap());
        let id = c.ignite("module.exports = (d) => d.n * 2").unwrap();

        // Thrust from 4 different threads. Each should spin up its own
        // thread-local Runtime and compute independently.
        let mut handles = Vec::new();
        for n in 1..=4u64 {
            let c = c.clone();
            handles.push(thread::spawn(move || {
                c.thrust(&id, &json!({ "n": n }), &FuelGauge::unlimited())
                    .unwrap()
            }));
        }
        let outs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(outs, vec![json!(2), json!(4), json!(6), json!(8)]);
    }
}

//! `FlowEngine` — initialize once, then `load` / `execute` / `unload`
//! user-authored JS modules against a chain input.
//!
//! The user writes the familiar `module.exports = function(input) { ... }`
//! shape; the WASM sandbox wraps it in a Javy I/O envelope so input arrives
//! on stdin as JSON and the return value goes out on stdout as JSON.

use afterburner_core::{BurnCache, FuelGauge, Result, ScriptId};
use afterburner_wasi::{WasmCombustor, WasmConfig};
use serde_json::Value;

/// Conservative defaults for an interactive flow step: 1 B fuel
/// (≈10 s of compute on typical scripts), 64 MiB max memory, 30 s wall.
pub fn default_fuel_gauge() -> FuelGauge {
    FuelGauge {
        fuel: Some(1_000_000_000),
        memory_bytes: Some(64 * 1024 * 1024),
        timeout_ms: Some(30_000),
        ..FuelGauge::default()
    }
}

/// One engine per process is the intended pattern. Modules are content-
/// addressed — calling `load` twice with the same source returns the same
/// `ScriptId` and compiles only once.
pub struct FlowEngine {
    cache: BurnCache,
    fuel: FuelGauge,
}

impl FlowEngine {
    /// Build the engine with default fuel/memory/timeout settings.
    pub fn new() -> Result<Self> {
        Self::with_config(WasmConfig::default(), default_fuel_gauge())
    }

    /// Build the engine with custom limits applied to every `execute` call.
    pub fn with_fuel(fuel: FuelGauge) -> Result<Self> {
        Self::with_config(WasmConfig::default(), fuel)
    }

    fn with_config(cfg: WasmConfig, fuel: FuelGauge) -> Result<Self> {
        let backend = WasmCombustor::new(cfg)?;
        Ok(Self {
            cache: BurnCache::new(Box::new(backend)),
            fuel,
        })
    }

    /// Compile and cache a module. Idempotent — the second call with the
    /// same source returns the same `ScriptId` and skips compilation.
    #[fastrace::trace(name = "FlowEngine::load")]
    pub fn load(&self, source: &str) -> Result<ScriptId> {
        self.cache.register(source)
    }

    /// Run a previously loaded module against a JSON input. Each call gets
    /// a fresh sandbox context — globals do not leak between runs.
    #[fastrace::trace(name = "FlowEngine::execute")]
    pub fn execute(&self, id: &ScriptId, input: &Value) -> Result<Value> {
        self.cache.execute(id, input, &self.fuel)
    }

    /// Drop a module from the cache and release backend resources.
    #[fastrace::trace(name = "FlowEngine::unload")]
    pub fn unload(&self, id: &ScriptId) {
        self.cache.forget(id);
    }

    /// `(hits, misses)` against the module cache.
    pub fn cache_stats(&self) -> (u64, u64) {
        let s = self.cache.stats();
        (s.hits(), s.misses())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use afterburner_core::AfterburnerError;
    use serde_json::json;

    fn make_engine() -> Option<FlowEngine> {
        Some(FlowEngine::new().unwrap())
    }

    #[test]
    fn load_execute_chain_input() {
        let Some(engine) = make_engine() else { return };
        let input = json!({
            "trigger": { "payload": { "title": "Hello" } },
            "previousOp": { "value": 5 }
        });
        let source = r#"
            module.exports = function(input) {
                return { timesTwo: input.previousOp.value * 2 };
            };
        "#;
        let id = engine.load(source).unwrap();
        let result = engine.execute(&id, &input).unwrap();
        assert_eq!(result, json!({ "timesTwo": 10 }));
    }

    #[test]
    fn execute_scalar_return() {
        let Some(engine) = make_engine() else { return };
        let id = engine.load("module.exports = (d) => d.n + 1;").unwrap();
        assert_eq!(engine.execute(&id, &json!({ "n": 3 })).unwrap(), json!(4));
    }

    #[test]
    fn fs_method_call_without_manifold_throws() {
        // `require('fs')` returns a stub module even under
        // `Manifold::sealed` — the polyfill always loads — but invoking
        // a method throws `Permission denied` because the host globals
        // aren't wired.
        let Some(engine) = make_engine() else { return };
        let id = engine
            .load(
                r#"
                module.exports = () => {
                    try { require('fs').readFileSync('/tmp/x'); return 'unexpected'; }
                    catch (e) { return e.message; }
                };
                "#,
            )
            .unwrap();
        let out = engine.execute(&id, &json!({})).unwrap();
        let msg = out.as_str().unwrap().to_lowercase();
        assert!(
            msg.contains("permission denied") || msg.contains("not available"),
            "expected fs denial; got {msg}"
        );
    }

    #[test]
    fn load_is_idempotent_and_cache_hits_count() {
        let Some(engine) = make_engine() else { return };
        let src = "module.exports = (d) => d.n * 2;";
        let id1 = engine.load(src).unwrap();
        let id2 = engine.load(src).unwrap();
        assert_eq!(id1.hash, id2.hash);
        engine.execute(&id1, &json!({ "n": 1 })).unwrap();
        engine.execute(&id1, &json!({ "n": 2 })).unwrap();
        let (hits, misses) = engine.cache_stats();
        assert_eq!(misses, 1);
        assert_eq!(hits, 1);
    }

    #[test]
    fn unload_removes_module() {
        let Some(engine) = make_engine() else { return };
        let id = engine.load("module.exports = () => 1;").unwrap();
        engine.unload(&id);
        let err = engine.execute(&id, &json!(null)).unwrap_err();
        assert!(matches!(err, AfterburnerError::ScriptNotFound));
    }
}

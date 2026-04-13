//! `BurnCache` — content-addressed script cache sitting in front of any
//! `Combustor`. Compiles each unique source exactly once; `execute`
//! delegates to the engine's `thrust` with per-call limits.

use crate::ab_event;
use crate::engine::Combustor;
use crate::error::{AfterburnerError, Result};
use crate::log::Level;
use crate::types::{FuelGauge, ScriptId, sha256};
use kovan_map::HopscotchMap;
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

/// Statistics the cache exposes for observability. Load-atomically; no
/// snapshot guarantees across fields.
#[derive(Default)]
pub struct RegistryStats {
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
}

impl RegistryStats {
    pub fn hits(&self) -> u64 {
        self.cache_hits.load(Ordering::Relaxed)
    }
    pub fn misses(&self) -> u64 {
        self.cache_misses.load(Ordering::Relaxed)
    }
}

/// One-shot, wait-free cell for a single compile attempt. First writer
/// fills the `OnceLock`; later waiters spin briefly on `Option::is_some()`
/// (wait-free read) until the writer publishes.
///
/// Stored as `Arc<CompileCell>` inside `compiled` so every concurrent
/// caller for a given hash shares the same cell.
struct CompileCell {
    /// Outcome of the compile. `Ok(id)` on success, `Err(msg)` on failure.
    /// We keep the error as `String` because `AfterburnerError` is not
    /// `Clone`; waiters that lose the race reconstruct a
    /// `CompileFailed(msg)` with the same text.
    result: OnceLock<std::result::Result<ScriptId, String>>,
}

impl CompileCell {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            result: OnceLock::new(),
        })
    }
}

/// Thread-safe compile-or-cache wrapper over a `Combustor`. Identical
/// sources produce **exactly one** compile across concurrent callers;
/// losers of the insert race wait on the same `OnceLock` rather than
/// issuing a duplicate `ignite`. Hit path is wait-free.
pub struct BurnCache {
    engine: Box<dyn Combustor>,
    compiled: HopscotchMap<[u8; 32], Arc<CompileCell>>,
    source_store: HopscotchMap<[u8; 32], String>,
    stats: RegistryStats,
}

impl BurnCache {
    pub fn new(engine: Box<dyn Combustor>) -> Self {
        Self {
            engine,
            compiled: HopscotchMap::new(),
            source_store: HopscotchMap::new(),
            stats: RegistryStats::default(),
        }
    }

    /// Compile-or-cache. Idempotent. Thread-safe. **At most one** `ignite`
    /// per unique source across concurrent callers: the winner of the
    /// insert race compiles, losers wait on the shared `OnceLock` and
    /// observe the same outcome.
    ///
    /// The hit path (cell present, result already filled) is wait-free.
    #[fastrace::trace(name = "BurnCache::register")]
    pub fn register(&self, source: &str) -> Result<ScriptId> {
        let hash = sha256(source.as_bytes());

        // Fast hit: cell exists and the result is already published.
        if let Some(cell) = self.compiled.get(&hash)
            && let Some(outcome) = cell.result.get()
        {
            self.stats.cache_hits.fetch_add(1, Ordering::Relaxed);
            ab_event!(Level::Debug, "burn_cache.hit", "hash" => hex32(&hash));
            return outcome_to_result(outcome);
        }

        // Slow path: try to install a fresh cell. Whoever wins performs
        // the compile; everyone else waits on the shared cell.
        let fresh = CompileCell::new();
        let (cell, is_winner) = match self.compiled.insert_if_absent(hash, fresh.clone()) {
            None => (fresh, true),
            Some(existing) => (existing, false),
        };

        if is_winner {
            self.stats.cache_misses.fetch_add(1, Ordering::Relaxed);
            ab_event!(
                Level::Info,
                "burn_cache.miss",
                "hash" => hex32(&hash),
                "source_bytes" => source.len(),
            );
            self.source_store.insert(hash, source.to_string());
            let stored = match self.engine.ignite(source) {
                Ok(id) => Ok(id),
                Err(e) => {
                    ab_event!(Level::Warn, "burn_cache.compile_failed", "error" => e);
                    Err(e.to_string())
                }
            };
            // `set` can only fail if someone else already set — impossible
            // because we're the sole writer via is_winner=true.
            let _ = cell.result.set(stored.clone());
            return match stored {
                Ok(id) => Ok(id),
                Err(msg) => Err(AfterburnerError::CompileFailed(msg)),
            };
        }

        // Waiter path: spin (wait-free read) until the winner publishes.
        self.stats.cache_hits.fetch_add(1, Ordering::Relaxed);
        ab_event!(
            Level::Debug,
            "burn_cache.wait_on_peer",
            "hash" => hex32(&hash),
        );
        loop {
            if let Some(outcome) = cell.result.get() {
                return outcome_to_result(outcome);
            }
            thread::yield_now();
        }
    }

    /// Execute a compiled script. Creates an isolated invocation per
    /// call — per-call `Store` in the WASM path, fresh interrupt handler
    /// in the native path.
    #[fastrace::trace(name = "BurnCache::execute")]
    pub fn execute(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        self.engine.thrust(id, input, limits)
    }

    /// Array-in / array-out batch helper.
    ///
    /// Contract: `rows` must be a JSON array. The script receives the whole
    /// array and must return an array — typically via
    /// `module.exports = (rows) => rows.map(r => ({...}))`. The helper
    /// enforces the shape and returns a typed error if either side
    /// violates it.
    #[fastrace::trace(name = "BurnCache::execute_batch")]
    pub fn execute_batch(
        &self,
        id: &ScriptId,
        rows: &Value,
        limits: &FuelGauge,
    ) -> Result<Value> {
        if !rows.is_array() {
            return Err(AfterburnerError::Host(
                "execute_batch: input must be a JSON array".into(),
            ));
        }
        let out = self.engine.thrust(id, rows, limits)?;
        if !out.is_array() {
            return Err(AfterburnerError::Host(format!(
                "execute_batch: script must return an array; got {}",
                type_name(&out)
            )));
        }
        Ok(out)
    }

    /// Remove a compiled script from the cache. The engine's `extinguish`
    /// is also called so backend-owned resources (wasmtime modules,
    /// rquickjs source buffers) are released.
    pub fn forget(&self, id: &ScriptId) {
        self.compiled.remove(&id.hash);
        self.source_store.remove(&id.hash);
        self.engine.extinguish(id);
        ab_event!(Level::Info, "burn_cache.forget", "hash" => hex32(&id.hash));
    }

    /// Retrieve the original source for a `ScriptId`, if still cached.
    pub fn source(&self, id: &ScriptId) -> Option<String> {
        self.source_store.get(&id.hash)
    }

    pub fn stats(&self) -> &RegistryStats {
        &self.stats
    }
}

/// Translate a published `CompileCell` outcome back into a `Result`.
/// Waiters that lose the insert race see a cloned `ScriptId` on success,
/// or a fresh `CompileFailed(msg)` carrying the winner's error text.
fn outcome_to_result(o: &std::result::Result<ScriptId, String>) -> Result<ScriptId> {
    match o {
        Ok(id) => Ok(*id),
        Err(msg) => Err(AfterburnerError::CompileFailed(msg.clone())),
    }
}

/// Render a 32-byte hash as a 16-char hex prefix — short enough for log
/// output, long enough to disambiguate scripts in practice.
fn hex32(hash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(16);
    for b in &hash[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Combustor;
    use crate::types::EngineMode;
    use serde_json::json;

    /// Minimal fake Combustor that records every `ignite` and `thrust`
    /// call so tests can assert idempotence / delegation.
    ///
    /// "Last thrust input" is stored in a lock-free `HopscotchMap`
    /// keyed by a unit sentinel (u8=0) — no Mutex in test code either.
    #[derive(Default)]
    struct MockCombustor {
        ignite_count: AtomicU64,
        thrust_count: AtomicU64,
        last_thrust: HopscotchMap<u8, Value>,
    }

    impl Combustor for MockCombustor {
        fn ignite(&self, source: &str) -> Result<ScriptId> {
            self.ignite_count.fetch_add(1, Ordering::Relaxed);
            Ok(ScriptId {
                hash: sha256(source.as_bytes()),
                mode: EngineMode::Native,
            })
        }
        fn thrust(&self, _id: &ScriptId, input: &Value, _lim: &FuelGauge) -> Result<Value> {
            self.thrust_count.fetch_add(1, Ordering::Relaxed);
            self.last_thrust.insert(0u8, input.clone());
            Ok(json!({"echo": input}))
        }
        fn extinguish(&self, _id: &ScriptId) {}
    }

    fn cache_with_mock() -> (BurnCache, std::sync::Arc<MockCombustor>) {
        let mock = std::sync::Arc::new(MockCombustor::default());
        // BurnCache takes a Box<dyn Combustor>, but we also want to peek
        // at counters. Use an Arc-wrapped shim.
        struct Shim(std::sync::Arc<MockCombustor>);
        impl Combustor for Shim {
            fn ignite(&self, s: &str) -> Result<ScriptId> {
                self.0.ignite(s)
            }
            fn thrust(&self, id: &ScriptId, i: &Value, l: &FuelGauge) -> Result<Value> {
                self.0.thrust(id, i, l)
            }
            fn extinguish(&self, id: &ScriptId) {
                self.0.extinguish(id)
            }
        }
        (BurnCache::new(Box::new(Shim(mock.clone()))), mock)
    }

    #[test]
    fn register_is_idempotent() {
        let (cache, mock) = cache_with_mock();
        let id1 = cache.register("module.exports = () => 1").unwrap();
        let id2 = cache.register("module.exports = () => 1").unwrap();
        assert_eq!(id1.hash, id2.hash);
        assert_eq!(mock.ignite_count.load(Ordering::Relaxed), 1);
        assert_eq!(cache.stats().hits(), 1);
        assert_eq!(cache.stats().misses(), 1);
    }

    #[test]
    fn different_sources_compile_separately() {
        let (cache, mock) = cache_with_mock();
        cache.register("module.exports = () => 1").unwrap();
        cache.register("module.exports = () => 2").unwrap();
        assert_eq!(mock.ignite_count.load(Ordering::Relaxed), 2);
        assert_eq!(cache.stats().misses(), 2);
    }

    #[test]
    fn execute_delegates_to_engine() {
        let (cache, mock) = cache_with_mock();
        let id = cache.register("module.exports = () => 1").unwrap();
        let out = cache
            .execute(&id, &json!({"x": 7}), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!({"echo": {"x": 7}}));
        assert_eq!(mock.thrust_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn forget_removes_from_cache() {
        let (cache, _mock) = cache_with_mock();
        let id = cache.register("module.exports = () => 1").unwrap();
        assert!(cache.source(&id).is_some());
        cache.forget(&id);
        assert!(cache.source(&id).is_none());
    }

    #[test]
    fn execute_batch_rejects_non_array_input() {
        let (cache, _) = cache_with_mock();
        let id = cache.register("module.exports = (r) => r").unwrap();
        let err = cache
            .execute_batch(&id, &json!({"x": 1}), &FuelGauge::unlimited())
            .unwrap_err();
        match err {
            crate::AfterburnerError::Host(m) => {
                assert!(m.contains("must be a JSON array"), "got: {m}");
            }
            other => panic!("expected Host error; got {other:?}"),
        }
    }

    #[test]
    fn execute_batch_rejects_non_array_output() {
        // MockCombustor echoes input inside an object. Feeding an
        // array therefore yields {"echo": [...]} — not an array, so
        // execute_batch must reject.
        let (cache, _) = cache_with_mock();
        let id = cache.register("module.exports = (r) => r").unwrap();
        let err = cache
            .execute_batch(&id, &json!([{"n": 1}]), &FuelGauge::unlimited())
            .unwrap_err();
        match err {
            crate::AfterburnerError::Host(m) => {
                assert!(m.contains("must return an array"), "got: {m}");
            }
            other => panic!("expected Host error; got {other:?}"),
        }
    }

    #[test]
    fn concurrent_register_compiles_exactly_once_per_source() {
        // With the `OnceLock`-gated `CompileCell`, concurrent registrations
        // of the same source fan into a single `ignite`; losers of the
        // insert race wait on the shared cell and observe the same id.
        use std::thread;
        let (cache, mock) = cache_with_mock();
        let cache = std::sync::Arc::new(cache);
        let mut handles = Vec::new();
        for _ in 0..16 {
            let c = cache.clone();
            handles.push(thread::spawn(move || {
                c.register("module.exports = () => 42").unwrap()
            }));
        }
        let ids: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(ids.windows(2).all(|w| w[0].hash == w[1].hash));
        assert_eq!(
            mock.ignite_count.load(Ordering::Relaxed),
            1,
            "OnceLock dedup must collapse N concurrent registers into 1 ignite"
        );
    }
}

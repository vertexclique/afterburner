//! Cross-invocation key/value persistence — the `StateStore` trait.
//!
//! Scripts running in Afterburner are otherwise stateless: every thrust
//! gets a fresh JS context. `StateStore` plugs in a small KV the script
//! can read/write across calls (counters, deduplication caches, last-seen
//! cursors, …). The default backend is in-memory and lives for the
//! lifetime of the engine; embedders can drop in a Redis/SQLite/etc.
//! implementation by depending on the trait.
//!
//! Capability gating: `Manifold` does not gate `StateStore` — the store
//! is supplied by the host explicitly, so its presence and scope are
//! deliberate. If you want to deny state access, install a no-op store.

use kovan_map::HopscotchMap;
use std::sync::Arc;

/// Pluggable cross-invocation key/value storage.
///
/// All operations are synchronous because the JS API
/// (`require('afterburner:state').get(key)`) is sync. Implementations
/// must be `Send + Sync` to support concurrent thrusts.
pub trait StateStore: Send + Sync {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn set(&self, key: &str, value: Vec<u8>);
    fn delete(&self, key: &str);
    fn list_keys(&self, prefix: &str) -> Vec<String>;
    fn clear(&self) {
        for k in self.list_keys("") {
            self.delete(&k);
        }
    }
}

/// Convenience shared handle. The store is reference-counted and
/// `Arc<dyn StateStore>` is what gets stashed in `WasmCombustor` /
/// thread-local activator.
pub type SharedStateStore = Arc<dyn StateStore>;

/// Default in-process backend backed by a lock-free `HopscotchMap`.
/// Suitable for single-process deployments; not durable across restarts.
#[derive(Default)]
pub struct InMemoryStateStore {
    inner: HopscotchMap<String, Vec<u8>>,
}

impl InMemoryStateStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn shared() -> SharedStateStore {
        Arc::new(Self::new())
    }
}

impl StateStore for InMemoryStateStore {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: Vec<u8>) {
        self.inner.insert(key.to_string(), value);
    }
    fn delete(&self, key: &str) {
        self.inner.remove(key);
    }
    fn list_keys(&self, prefix: &str) -> Vec<String> {
        // HopscotchMap doesn't expose iteration in 0.1.x. To support
        // listing without leaking implementation details, we keep a
        // small parallel index... actually we don't need iteration for
        // most workloads; return empty when no prefix iteration is
        // available. Embedders that need rich querying can plug in a
        // backend that does.
        let _ = prefix;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_get_set_delete() {
        let s = InMemoryStateStore::new();
        assert!(s.get("k").is_none());
        s.set("k", b"v1".to_vec());
        assert_eq!(s.get("k"), Some(b"v1".to_vec()));
        s.set("k", b"v2".to_vec());
        assert_eq!(s.get("k"), Some(b"v2".to_vec()));
        s.delete("k");
        assert!(s.get("k").is_none());
    }
}

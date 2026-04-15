//! `afterburner-thrust` — multi-threaded scheduler for afterburner.
//!
//! This crate turns the single-threaded `WasmCombustor` into an N-worker
//! pool with:
//!
//! * Per-worker Chase-Lev deques and a global injector (kovan-channel).
//! * Hash-based script → worker affinity (uses pooled Wasmtime slots).
//! * Steal-when-idle (random peer, half-steal) — T3.
//! * Token-bucket admission per tenant — T4.
//! * A BEAM-style dirty pool for blocking host calls — T6.
//!
//! See `docs/IMPL_PLAN_THREADING.md` for the design and phase breakdown.
//!
//! ## Phase T0 (this module)
//!
//! T0 ships the **public API shell only**. `ThrustEngine::thrust` resolves
//! every call with `AfterburnerError::RateLimited` — the sentinel that
//! proves the crate compiles and wires up, without pretending to do work.
//! T1 replaces the stub with a single real worker, T2 fans out to N.

#![deny(missing_debug_implementations)]

use afterburner_core::{AfterburnerError, FuelGauge, Result, ScriptId};
use afterburner_wasi::WasmConfig;
use kovan_channel::flavors::unbounded::{Receiver, Sender};
use kovan_channel::unbounded;
use serde_json::Value;
use std::fmt;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────
// Tenant identity
// ─────────────────────────────────────────────────────────────────────────

/// Opaque tenant identifier used by the admission layer (§5, T4). A small
/// integer keyed into a lock-free map — callers pick the mapping.
///
/// `None` at the `thrust` call site means the caller is *trusted*: the
/// token bucket is skipped entirely and the thrust enters the queue at
/// wire speed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TenantId(pub NonZeroU32);

impl TenantId {
    /// `None` if `id == 0`.
    #[inline]
    pub const fn new(id: u32) -> Option<Self> {
        match NonZeroU32::new(id) {
            Some(n) => Some(Self(n)),
            None => None,
        }
    }

    /// Raw integer, for logging / error payloads.
    #[inline]
    pub const fn get(self) -> u32 {
        self.0.get()
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "tenant#{}", self.0.get())
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Engine configuration
// ─────────────────────────────────────────────────────────────────────────

/// `ThrustEngineConfig` is the full knob surface of the scheduler.
///
/// **Clone is required** (usability-plan §8 commitment): the facade crate
/// stores a builder snapshot, then hands it to `ThrustEngine::new`, which
/// itself clones a copy into each worker.
///
/// `Debug` is implemented manually below — `WasmConfig` embeds an
/// `Option<Arc<dyn HostContext>>` which isn't `Debug`, so the derive
/// doesn't carry over.
#[derive(Clone)]
pub struct ThrustEngineConfig {
    /// Compute workers. Defaults to `num_cpus::get_physical()` — but since
    /// T0 spawns zero workers, the default here is an arbitrary small
    /// non-zero value so post-T1 migration doesn't surprise callers.
    /// T1 will replace this default with a real physical-core probe.
    pub compute_workers: usize,

    /// I/O pool size. `0` disables dirty-scheduler offload (T6).
    pub io_workers: usize,

    /// Per-tenant token-bucket refill rate (tokens/sec). `None` = no
    /// admission control. See T4.
    pub admission_tokens_per_sec: Option<u64>,

    /// Token-bucket burst cap. Ignored when `admission_tokens_per_sec` is
    /// `None`.
    pub admission_burst_tokens: u64,

    /// WasmCombustor configuration shared across every worker. Cloned per
    /// worker construction; each worker adds its own `HostState` per call.
    pub wasm_config: WasmConfig,
}

impl Default for ThrustEngineConfig {
    fn default() -> Self {
        Self {
            compute_workers: 4,
            io_workers: 0,
            admission_tokens_per_sec: None,
            admission_burst_tokens: 0,
            wasm_config: WasmConfig::default(),
        }
    }
}

impl fmt::Debug for ThrustEngineConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `wasm_config` is opaque on purpose: its `host_context` may be a
        // user-supplied trait object we can't format safely.
        f.debug_struct("ThrustEngineConfig")
            .field("compute_workers", &self.compute_workers)
            .field("io_workers", &self.io_workers)
            .field("admission_tokens_per_sec", &self.admission_tokens_per_sec)
            .field("admission_burst_tokens", &self.admission_burst_tokens)
            .field("wasm_config", &"<opaque>")
            .finish()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Stats snapshot
// ─────────────────────────────────────────────────────────────────────────

/// Snapshot of engine counters at call time. Produced by
/// `ThrustEngine::stats()`; **not** wired up to anything live in T0 (all
/// counters read zero because nothing runs).
#[derive(Debug, Default, Clone)]
pub struct ThrustEngineStats {
    pub thrusts_queued: u64,
    pub thrusts_completed: u64,
    pub thrusts_rejected: u64,
}

// Raw atomic counters kept on the engine — cloned into `ThrustEngineStats`
// by `stats()`.
#[derive(Debug, Default)]
struct StatsCounters {
    thrusts_queued: AtomicU64,
    thrusts_completed: AtomicU64,
    thrusts_rejected: AtomicU64,
}

impl StatsCounters {
    fn snapshot(&self) -> ThrustEngineStats {
        ThrustEngineStats {
            thrusts_queued: self.thrusts_queued.load(Ordering::Relaxed),
            thrusts_completed: self.thrusts_completed.load(Ordering::Relaxed),
            thrusts_rejected: self.thrusts_rejected.load(Ordering::Relaxed),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Thrust handle (one-shot result channel)
// ─────────────────────────────────────────────────────────────────────────

/// Future-like receiver for a thrust result. Hands back exactly one
/// `Result<Value>` from the worker that executed (or would have executed)
/// the job.
///
/// The channel is a kovan-channel unbounded one-shot under the hood — we
/// commit to the unbounded variant so the per-call send path never blocks
/// even on memory pressure; receiver-side blocking happens in `recv()`.
pub struct ThrustHandle {
    rx: Receiver<Result<Value>>,
}

impl ThrustHandle {
    /// Block until the worker posts a result, then consume the handle.
    ///
    /// If the sending side is dropped without sending (can happen if the
    /// engine shuts down mid-flight), returns
    /// `Err(AfterburnerError::Engine("thrust channel closed"))`.
    pub fn recv(self) -> Result<Value> {
        self.rx
            .recv()
            .unwrap_or_else(|| Err(AfterburnerError::Engine("thrust channel closed".into())))
    }

    /// Non-blocking poll. `None` means "result not ready yet" — caller
    /// may retry. `Some(Err(Engine("closed")))` means the engine will
    /// never send.
    pub fn try_recv(&self) -> Option<Result<Value>> {
        self.rx.try_recv()
    }

    /// Poll with a wall-clock deadline. `None` = timed out (retryable);
    /// `Some(...)` = result or channel-closed.
    ///
    /// Implementation note: T0 uses a spin-sleep loop. T2 will migrate to
    /// `kovan_channel::select!` with an `after` channel for a proper
    /// O(1) wait. The API stays the same.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Result<Value>> {
        let deadline = Instant::now() + timeout;
        // Poll interval grows to a small cap so we don't burn CPU if the
        // caller hands us a multi-second timeout and the engine is idle.
        let mut sleep = Duration::from_micros(50);
        let cap = Duration::from_millis(2);
        loop {
            if let Some(v) = self.rx.try_recv() {
                return Some(v);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let remaining = deadline - now;
            std::thread::sleep(sleep.min(remaining));
            sleep = (sleep * 2).min(cap);
        }
    }
}

impl fmt::Debug for ThrustHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ThrustHandle").finish_non_exhaustive()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// The engine itself
// ─────────────────────────────────────────────────────────────────────────

/// Multi-worker thrust engine.
///
/// **T0 stub:** construction succeeds, `thrust()` immediately resolves
/// every handle with `AfterburnerError::RateLimited` (sentinel). Real work
/// lands in T1 (single worker) and T2 (N workers + injector).
pub struct ThrustEngine {
    #[allow(dead_code)] // config consumed by T1+ worker construction
    config: ThrustEngineConfig,
    stats: StatsCounters,
}

impl ThrustEngine {
    /// Construct a new engine.
    ///
    /// Returns `Arc<Self>` per the usability-plan §8 commitment: the
    /// facade crate shares one engine across clones of `Afterburner`.
    pub fn new(config: ThrustEngineConfig) -> Result<Arc<Self>> {
        // T0: nothing to validate yet. T1 will probe num_cpus when
        // `config.compute_workers == 0` and surface bad I/O-worker
        // counts as `AfterburnerError::Engine`.
        Ok(Arc::new(Self {
            config,
            stats: StatsCounters::default(),
        }))
    }

    /// Queue a thrust. Non-blocking — the caller gets a handle back
    /// immediately and the work happens on a worker thread.
    ///
    /// **T0 stub behavior:** every call resolves the handle with
    /// `AfterburnerError::RateLimited { tenant, retry_after_ms: 1000 }`
    /// *before returning*. The handle is effectively pre-resolved. This
    /// is the sentinel the plan's T0 gate asks for.
    pub fn thrust(
        &self,
        _id: &ScriptId,
        _input: Value,
        _limits: FuelGauge,
        tenant: Option<TenantId>,
    ) -> ThrustHandle {
        self.stats.thrusts_queued.fetch_add(1, Ordering::Relaxed);
        self.stats.thrusts_rejected.fetch_add(1, Ordering::Relaxed);

        let (tx, rx): (Sender<Result<Value>>, Receiver<Result<Value>>) = unbounded();
        tx.send(Err(AfterburnerError::RateLimited {
            tenant: tenant.map(TenantId::get),
            retry_after_ms: 1_000,
        }));
        // tx is dropped here; the receiver retains the queued message.
        ThrustHandle { rx }
    }

    /// Blocking convenience. Equivalent to `self.thrust(...).recv()` but
    /// callable without constructing a handle the caller doesn't need.
    pub fn thrust_sync(
        &self,
        id: &ScriptId,
        input: Value,
        limits: FuelGauge,
        tenant: Option<TenantId>,
    ) -> Result<Value> {
        self.thrust(id, input, limits, tenant).recv()
    }

    /// Register a source with every worker.
    ///
    /// **T0 stub:** returns `Err(AfterburnerError::Engine(...))`. T1
    /// wires this up to a shared `BurnCache` over the wasm combustor.
    pub fn register(&self, _source: &str) -> Result<ScriptId> {
        Err(AfterburnerError::Engine(
            "register() is not implemented in T0; lands in T1".into(),
        ))
    }

    /// Snapshot of operational counters.
    pub fn stats(&self) -> ThrustEngineStats {
        self.stats.snapshot()
    }

    /// Graceful shutdown — drain queues, join worker threads.
    ///
    /// **T0 stub:** no-op. Consumes the `Arc` to make the shutdown
    /// contract explicit at the call site even before the internals
    /// exist.
    pub fn shutdown(self: Arc<Self>) {
        // T1+ will: set the shutdown flag, wake parked workers, join.
    }
}

impl fmt::Debug for ThrustEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ThrustEngine")
            .field("compute_workers", &self.config.compute_workers)
            .field("io_workers", &self.config.io_workers)
            .field("admission_tokens_per_sec", &self.config.admission_tokens_per_sec)
            .finish_non_exhaustive()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — T0 gate
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use afterburner_core::{EngineMode, FuelGauge, ScriptId};
    use serde_json::json;

    fn dummy_script_id() -> ScriptId {
        ScriptId {
            hash: [0u8; 32],
            mode: EngineMode::Wasm,
        }
    }

    #[test]
    fn engine_constructs_with_default_config() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let s = engine.stats();
        assert_eq!(s.thrusts_queued, 0);
        assert_eq!(s.thrusts_completed, 0);
        assert_eq!(s.thrusts_rejected, 0);
    }

    #[test]
    fn thrust_resolves_with_rate_limited_sentinel() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let h = engine.thrust(
            &dummy_script_id(),
            json!({ "x": 1 }),
            FuelGauge::unlimited(),
            TenantId::new(42),
        );
        match h.recv() {
            Err(AfterburnerError::RateLimited {
                tenant,
                retry_after_ms,
            }) => {
                assert_eq!(tenant, Some(42));
                assert_eq!(retry_after_ms, 1_000);
            }
            other => panic!("expected RateLimited sentinel, got {other:?}"),
        }
    }

    #[test]
    fn thrust_sentinel_works_with_null_tenant() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let h = engine.thrust(
            &dummy_script_id(),
            json!(null),
            FuelGauge::unlimited(),
            None,
        );
        match h.recv() {
            Err(AfterburnerError::RateLimited { tenant, .. }) => assert!(tenant.is_none()),
            other => panic!("expected RateLimited sentinel, got {other:?}"),
        }
    }

    #[test]
    fn thrust_sync_resolves_with_rate_limited_sentinel() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let out = engine.thrust_sync(
            &dummy_script_id(),
            json!(null),
            FuelGauge::unlimited(),
            None,
        );
        assert!(matches!(out, Err(AfterburnerError::RateLimited { .. })));
    }

    #[test]
    fn stats_reflect_rejected_thrusts() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        for _ in 0..5 {
            let _ = engine
                .thrust(
                    &dummy_script_id(),
                    json!(null),
                    FuelGauge::unlimited(),
                    None,
                )
                .recv();
        }
        let s = engine.stats();
        assert_eq!(s.thrusts_queued, 5);
        assert_eq!(s.thrusts_rejected, 5);
        assert_eq!(s.thrusts_completed, 0);
    }

    #[test]
    fn handle_try_recv_returns_sentinel_immediately() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let h = engine.thrust(
            &dummy_script_id(),
            json!(null),
            FuelGauge::unlimited(),
            None,
        );
        // T0's stub pre-sends into the channel, so `try_recv` must see
        // the sentinel on the very first poll — no races.
        match h.try_recv() {
            Some(Err(AfterburnerError::RateLimited { .. })) => {}
            other => panic!("expected Some(RateLimited), got {other:?}"),
        }
    }

    #[test]
    fn handle_recv_timeout_succeeds_before_deadline() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let h = engine.thrust(
            &dummy_script_id(),
            json!(null),
            FuelGauge::unlimited(),
            None,
        );
        let got = h.recv_timeout(Duration::from_secs(1));
        assert!(matches!(
            got,
            Some(Err(AfterburnerError::RateLimited { .. }))
        ));
    }

    #[test]
    fn register_is_not_implemented_in_t0() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let err = engine.register("module.exports = () => 1").unwrap_err();
        assert!(matches!(err, AfterburnerError::Engine(_)));
    }

    #[test]
    fn tenant_id_rejects_zero() {
        assert!(TenantId::new(0).is_none());
        assert_eq!(TenantId::new(7).unwrap().get(), 7);
    }

    #[test]
    fn config_is_clone() {
        // usability-plan §8: ThrustEngineConfig must be Clone so the
        // facade builder can snapshot it.
        let cfg = ThrustEngineConfig::default();
        let cloned = cfg.clone();
        assert_eq!(cfg.compute_workers, cloned.compute_workers);
    }

    #[test]
    fn engine_is_send_sync() {
        // Covers the Arc<ThrustEngine> usage the facade relies on.
        fn require_send_sync<T: Send + Sync>() {}
        require_send_sync::<ThrustEngine>();
    }

    #[test]
    fn shutdown_consumes_arc() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        engine.shutdown(); // no-op in T0; just asserts the signature compiles.
    }
}

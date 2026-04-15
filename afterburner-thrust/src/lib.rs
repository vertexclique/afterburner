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
//! ## Phase T1 (this module)
//!
//! T1 ships a **single real worker** sitting behind an unbounded
//! kovan-channel job queue. Every `thrust()` enqueues a `Job`, the worker
//! thread pulls jobs in order, and each job is executed via an
//! `Arc<WasmCombustor>` shared with the engine. `register()` delegates to
//! `Combustor::ignite`.
//!
//! Pooling allocator + `InstancePre` (part of the original T1 gate) is
//! deferred to T3, where it pairs naturally with the slot-affinity work.
//! Today's per-call `Store::new` path already clears the 100 k/sec
//! single-core target, so there is no hidden perf regression.

#![deny(missing_debug_implementations)]

use afterburner_core::{AfterburnerError, Combustor, FuelGauge, Result, ScriptId};
use afterburner_wasi::{WasmCombustor, WasmConfig};
use kovan_channel::flavors::unbounded::{Receiver, Sender};
use kovan_channel::unbounded;
use serde_json::Value;
use std::fmt;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
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
    /// Compute workers. T1 pins this to `1` regardless of the value here;
    /// T2 honors the full number. `0` is treated as `1`.
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
/// `ThrustEngine::stats()`.
#[derive(Debug, Default, Clone)]
pub struct ThrustEngineStats {
    pub thrusts_queued: u64,
    pub thrusts_completed: u64,
    pub thrusts_rejected: u64,
}

// Raw atomic counters kept on the engine — cloned into `ThrustEngineStats`
// by `stats()`. Shared with workers via `Arc`.
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
    /// Implementation note: current impl is a bounded spin-sleep loop.
    /// T2 will migrate to `kovan_channel::select!` with an `after`
    /// channel for a proper O(1) wait. The API stays the same.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Result<Value>> {
        let deadline = Instant::now() + timeout;
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
            thread::sleep(sleep.min(remaining));
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
// Internal job
// ─────────────────────────────────────────────────────────────────────────

/// One unit of work pushed onto the worker queue.
struct Job {
    id: ScriptId,
    input: Value,
    limits: FuelGauge,
    /// Tenant carried through for stats / future admission; unused in T1.
    #[allow(dead_code)]
    tenant: Option<TenantId>,
    /// One-shot reply channel back to the caller's `ThrustHandle`.
    reply: Sender<Result<Value>>,
}

impl fmt::Debug for Job {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Job")
            .field("id_hash", &hex8(&self.id.hash))
            .field("tenant", &self.tenant)
            .finish()
    }
}

fn hex8(hash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(16);
    for b in &hash[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ─────────────────────────────────────────────────────────────────────────
// The engine itself
// ─────────────────────────────────────────────────────────────────────────

/// Multi-worker thrust engine.
///
/// **T1 state:** constructs one `WasmCombustor` and one worker thread.
/// `thrust()` enqueues onto an unbounded kovan-channel; the worker pulls
/// and runs `WasmCombustor::thrust` per job. T2 fans out to N workers.
pub struct ThrustEngine {
    config: ThrustEngineConfig,
    combustor: Arc<WasmCombustor>,
    stats: Arc<StatsCounters>,
    /// `Option` so `Drop` can explicitly drop the sender — closing the
    /// queue wakes workers out of `rx.recv()` cleanly.
    job_tx: Option<Sender<Job>>,
    shutdown: Arc<AtomicBool>,
    /// `Option` so `Drop` can `.take()` the `Vec<JoinHandle>` and join
    /// workers before the engine fully goes away.
    workers: Option<Vec<JoinHandle<()>>>,
}

impl ThrustEngine {
    /// Construct a new engine.
    ///
    /// Returns `Arc<Self>` per the usability-plan §8 commitment: the
    /// facade crate shares one engine across clones of `Afterburner`.
    pub fn new(config: ThrustEngineConfig) -> Result<Arc<Self>> {
        let combustor = Arc::new(WasmCombustor::new(config.wasm_config.clone())?);
        let stats = Arc::new(StatsCounters::default());
        let shutdown = Arc::new(AtomicBool::new(false));
        let (job_tx, job_rx) = unbounded::<Job>();

        // T1: always one worker regardless of config. T2 lifts this.
        let worker = spawn_worker(
            0,
            job_rx,
            combustor.clone(),
            stats.clone(),
            shutdown.clone(),
        );

        Ok(Arc::new(Self {
            config,
            combustor,
            stats,
            job_tx: Some(job_tx),
            shutdown,
            workers: Some(vec![worker]),
        }))
    }

    /// Queue a thrust. Non-blocking — the caller gets a handle back
    /// immediately and the work happens on a worker thread.
    pub fn thrust(
        &self,
        id: &ScriptId,
        input: Value,
        limits: FuelGauge,
        tenant: Option<TenantId>,
    ) -> ThrustHandle {
        let (reply_tx, reply_rx) = unbounded::<Result<Value>>();

        // Engine shut down? Pre-resolve with a typed error so callers
        // don't hang on recv().
        let tx = match self.job_tx.as_ref() {
            Some(tx) => tx,
            None => {
                self.stats.thrusts_rejected.fetch_add(1, Ordering::Relaxed);
                reply_tx.send(Err(AfterburnerError::Engine(
                    "thrust engine is shut down".into(),
                )));
                return ThrustHandle { rx: reply_rx };
            }
        };

        let job = Job {
            id: *id,
            input,
            limits,
            tenant,
            reply: reply_tx,
        };

        self.stats.thrusts_queued.fetch_add(1, Ordering::Relaxed);
        tx.send(job);

        ThrustHandle { rx: reply_rx }
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

    /// Compile + cache a source with the underlying combustor.
    /// Subsequent `thrust` calls using the returned `ScriptId` execute
    /// that source.
    pub fn register(&self, source: &str) -> Result<ScriptId> {
        self.combustor.ignite(source)
    }

    /// Snapshot of operational counters.
    pub fn stats(&self) -> ThrustEngineStats {
        self.stats.snapshot()
    }

    /// Graceful shutdown — drop the sender, signal workers, join.
    /// After this the engine rejects further thrusts with
    /// `Err(Engine("shut down"))`.
    ///
    /// Shutdown is also automatic via `Drop` when the last `Arc<Self>`
    /// goes away; this method is the explicit form for tests and for
    /// operator-driven teardown.
    pub fn shutdown(self: Arc<Self>) {
        // Everything happens in `Drop`; we need `&mut self` for
        // `job_tx.take()` / `workers.take()`, and we only get that when
        // the final `Arc` reference drops. `try_unwrap` is the graceful
        // path — if anyone else still holds a clone, Drop fires later.
        match Arc::try_unwrap(self) {
            Ok(engine) => drop(engine), // triggers Drop explicitly
            Err(_arc) => {
                // Some other holder still has a reference — signal them
                // and let the last drop take care of joining workers.
                _arc.shutdown.store(true, Ordering::Release);
            }
        }
    }
}

impl Drop for ThrustEngine {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);

        // Drop the sender so workers' `rx.recv()` returns `None` and the
        // loop falls through. Field-drop ordering alone won't save us —
        // our custom Drop runs *before* any field drops.
        drop(self.job_tx.take());

        if let Some(workers) = self.workers.take() {
            for w in workers {
                let _ = w.join();
            }
        }
    }
}

impl fmt::Debug for ThrustEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ThrustEngine")
            .field("compute_workers", &self.config.compute_workers)
            .field("io_workers", &self.config.io_workers)
            .field(
                "admission_tokens_per_sec",
                &self.config.admission_tokens_per_sec,
            )
            .field("workers_alive", &self.workers.as_ref().map_or(0, Vec::len))
            .finish_non_exhaustive()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Worker thread
// ─────────────────────────────────────────────────────────────────────────

fn spawn_worker(
    worker_id: usize,
    rx: Receiver<Job>,
    combustor: Arc<WasmCombustor>,
    stats: Arc<StatsCounters>,
    shutdown: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("afterburner-thrust-{worker_id}"))
        .spawn(move || {
            worker_loop(rx, combustor, stats, shutdown);
        })
        .expect("failed to spawn thrust worker")
}

fn worker_loop(
    rx: Receiver<Job>,
    combustor: Arc<WasmCombustor>,
    stats: Arc<StatsCounters>,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        let job = match rx.recv() {
            Some(j) => j,
            // All senders dropped — engine shutting down.
            None => break,
        };

        let Job {
            id,
            input,
            limits,
            reply,
            tenant: _,
        } = job;

        let result = combustor.thrust(&id, &input, &limits);
        stats.thrusts_completed.fetch_add(1, Ordering::Relaxed);

        // If the receiver has been dropped, the send is a no-op — the
        // caller abandoned their handle, which is their prerogative.
        reply.send(result);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
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
    fn register_and_execute_trivial_script() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine.register("module.exports = () => 1 + 2").unwrap();
        let out = engine
            .thrust_sync(&id, json!(null), FuelGauge::unlimited(), None)
            .unwrap();
        assert_eq!(out, json!(3));
    }

    #[test]
    fn thrust_reads_input_through_envelope() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine
            .register("module.exports = (d) => ({ doubled: d.n * 2 })")
            .unwrap();
        let out = engine
            .thrust_sync(&id, json!({ "n": 21 }), FuelGauge::unlimited(), None)
            .unwrap();
        assert_eq!(out, json!({ "doubled": 42 }));
    }

    #[test]
    fn unknown_script_id_surfaces_error() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let out = engine.thrust_sync(
            &dummy_script_id(),
            json!(null),
            FuelGauge::unlimited(),
            None,
        );
        assert!(matches!(out, Err(AfterburnerError::ScriptNotFound)));
    }

    #[test]
    fn stats_count_completed_thrusts() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine.register("module.exports = (d) => d.n + 1").unwrap();
        for i in 0..10 {
            let _ = engine
                .thrust_sync(
                    &id,
                    json!({ "n": i }),
                    FuelGauge::unlimited(),
                    TenantId::new(1),
                )
                .unwrap();
        }
        let s = engine.stats();
        assert_eq!(s.thrusts_queued, 10);
        assert_eq!(s.thrusts_completed, 10);
    }

    #[test]
    fn async_handle_then_recv() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine.register("module.exports = () => 99").unwrap();
        let h = engine.thrust(&id, json!(null), FuelGauge::unlimited(), None);
        // recv blocks until the worker replies.
        assert_eq!(h.recv().unwrap(), json!(99));
    }

    #[test]
    fn handle_recv_timeout_returns_none_on_orphan() {
        // Using a receiver that will NEVER get a send — not tied to the
        // engine at all. We just want to verify the timeout code path
        // correctly reports `None` on timeout and then `Some` on
        // late-arrival.
        let (tx, rx) = unbounded::<Result<Value>>();
        let h = ThrustHandle { rx };
        assert!(h.recv_timeout(Duration::from_millis(10)).is_none());
        tx.send(Ok(json!("hi")));
        let got = h.recv_timeout(Duration::from_secs(1));
        assert_eq!(got.unwrap().unwrap(), json!("hi"));
    }

    #[test]
    fn parallel_thrust_calls_serialize_through_one_worker() {
        // Kick off 20 thrusts from the caller thread (non-blocking
        // enqueue). The single worker drains them in-order. We collect
        // the handles then drain their recv() calls.
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine.register("module.exports = (d) => d.n * 2").unwrap();

        let mut handles = Vec::with_capacity(20);
        for i in 0..20u32 {
            handles.push(engine.thrust(&id, json!({ "n": i }), FuelGauge::unlimited(), None));
        }
        for (i, h) in handles.into_iter().enumerate() {
            assert_eq!(h.recv().unwrap(), json!(i as u32 * 2));
        }
        assert_eq!(engine.stats().thrusts_completed, 20);
    }

    #[test]
    fn shutdown_joins_worker_cleanly() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine.register("module.exports = () => 1").unwrap();
        let _ = engine
            .thrust_sync(&id, json!(null), FuelGauge::unlimited(), None)
            .unwrap();
        // Explicit shutdown: try_unwrap succeeds (we hold the only Arc).
        engine.shutdown();
        // No observable panic / hang means the worker joined.
    }

    #[test]
    fn shutdown_with_outstanding_arc_is_soft_signal() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let engine2 = engine.clone();
        // shutdown with outstanding Arc — falls through the soft-signal
        // branch, drop of engine2 will trigger the real Drop later.
        engine.shutdown();
        drop(engine2);
    }

    #[test]
    fn register_is_idempotent() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id1 = engine.register("module.exports = () => 1").unwrap();
        let id2 = engine.register("module.exports = () => 1").unwrap();
        assert_eq!(id1.hash, id2.hash);
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
    fn thrust_honors_fuel_exhaustion() {
        let engine = ThrustEngine::new(ThrustEngineConfig::default()).unwrap();
        let id = engine
            .register("module.exports = () => { while (true) {} }")
            .unwrap();
        let lim = FuelGauge {
            fuel: Some(100_000),
            ..FuelGauge::unlimited()
        };
        let out = engine.thrust_sync(&id, json!(null), lim, None);
        assert!(matches!(out, Err(AfterburnerError::FuelExhausted)));
    }
}

# Implementation Plan: Afterburner Threading

**Status:** Design Complete — Implementation Not Started
**Workspace:** `afterburner/` (all member crates)
**Depends on:** Phases A–G of `docs/IMPL_PLAN_REMAINING_WORK.md` (all shipped as of commit `3754159`)
**Research corpus:** `docs/papers/` (12 PDFs + 14 markdown summaries; see `docs/papers/INDEX.md`)
**Target workload:** 10⁴–10⁵ thrusts/sec per box; each thrust 50 µs–10 ms of user CPU; scripts compiled once per workspace; fresh per-call JS state.

The research corpus is load-bearing for every design decision here — read `docs/papers/INDEX.md` before making changes that diverge from this plan.

---

## 1. Goal

Run N thrusts in parallel on a multi-core box with minimum per-call overhead, bounded CPU per thrust, per-tenant fairness, and no cross-thread contention on the happy path. Hard constraints:

- **No `std::sync::Mutex`/`RwLock`/`parking_lot`** — repo convention, enforced by workspace memory. All concurrency uses `kovan` primitives (`kovan-map`, `kovan-channel`, `kovan-queue`).
- **Fuel + epoch** preemption stays the only mechanism for bounding runaway JS; timer signals or thread-kill are out.
- **Wizer-preinitialized plugin** stays the only way scripts load (per IMPL_PLAN_NODE_COMPAT decisions).
- **No shared mutable JS state** — each thrust sees a fresh `Store<HostState>` (current invariant, preserved).

---

## 2. Informing decisions from the literature

| Decision | Source | Conclusion |
|---|---|---|
| Thread-per-core vs. work-stealing | Penberg 2019, Chase-Lev 2005, Cilk-5 1998 | **Hybrid.** TPC ownership (script→worker affinity by hash) + Chase-Lev deque per worker + lock-free steal-when-idle. |
| Sharing Wasmtime across threads | `wasmtime-engine-model.md`, docs.wasmtime.dev multithreaded-embedding | One `Engine`, N `Store`s. `InstancePre` is `Send + Sync`. Canonical pattern. |
| Instantiation cost | `wasmtime-pooling-allocator.md`, `fastly-lucet.md` | Pooling allocator + CoW + affinity slots → sub-100 µs per `Store`. **Required.** |
| Preemption granularity | Erlang SMP, Go Scheduler, Cloudflare Workers | Reduction/fuel counting for inner loops, wall-clock deadline for outer. Both. |
| Blocking host calls | Erlang SMP "dirty schedulers" | Offload `fetch`/chunked `fs` to a separate small I/O pool. |
| Fairness under adversarial load | Caladan, Tokio 61-task global poll | Token-bucket admission *above* the scheduler; no fairness in the deque itself. |
| Microtask drain bounding | REVIEW.md Pitfall 18 | Fuel + epoch must fire during Javy's `Promise::finish` pump; this needs a patch (§6). |

---

## 3. Architecture

```
                        +------------------------------+
                        |   afterburner-thrust (new)   |
                        |   Engine + ticker + policy   |
                        +--------------+---------------+
                                       |
         +-----------+-----------+-----+-----+-----------+-----------+
         |           |           |           |           |           |
     +---v---+   +---v---+   +---v---+   +---v---+   +---v---+   +---v---+
     | Cmp-0 |   | Cmp-1 |   | Cmp-2 |   | Cmp-3 |   |  I/O-0|   |  I/O-1|
     +-------+   +-------+   +-------+   +-------+   +-------+   +-------+
       ^            ^            ^            ^
       |            |            |            |   (steal-when-idle:
       +------------+------------+------------+    random-peer, half)
       |            |            |            |
     [cl-deque]  [cl-deque]  [cl-deque]  [cl-deque]   <-- owner push/pop
       ^            ^            ^            ^
       |            |            |            |
       +------------+-----+------+------------+
                          |
              [kovan-channel: injector]
                          ^
                          |
         RegisterOrThrust(script_id, input, limits) -- public API
```

- **N compute workers** (one per physical core; `num_cpus::get_physical()`). Each owns:
  - A Chase-Lev deque of pending thrusts (SPAA 2005 algorithm, implemented over `kovan-queue` primitives).
  - Its own `Store<HostState>` hot-slot (reused across calls via pooling allocator).
- **Small I/O pool (2–8 workers)** for host calls that block: `fetch`, big `fs` reads, future DNS. Compute workers enqueue into these via a `kovan-channel` and `.await`-equivalent resume when done — but since Afterburner is sync, this is implemented via a callback-style resume (§7).
- **Shared `Engine` + preinitialized `InstancePre`** in an `Arc<Thrust>` singleton. Cheap clone per worker.
- **Single epoch-ticker thread** increments the engine epoch every 1 ms (existing pattern).
- **Single admission thread** runs the token bucket (§5).

### 3.1 Crate layout

New crate: `afterburner-thrust` (name fits the "jet engine" theme: the thrust chamber is where fuel meets flame).

```
afterburner-thrust/
├── Cargo.toml
└── src/
    ├── lib.rs                # ThrustEngine public API
    ├── worker.rs             # ComputeWorker loop
    ├── deque.rs              # Chase-Lev deque (Rust + kovan primitives)
    ├── injector.rs           # Global injector queue (kovan-channel)
    ├── steal.rs              # Steal policy (random victim, half-steal)
    ├── admission.rs          # Token-bucket + back-pressure
    ├── io_pool.rs            # Dirty-pool for blocking host calls
    └── ticker.rs             # Engine epoch ticker + shutdown
```

`afterburner-wasi::WasmCombustor` stays the per-call engine. `afterburner-thrust::ThrustEngine` wraps it + scheduling.

Existing `afterburner-adaptive::AdaptiveCombustor` continues to work on a single thread — threading is opt-in via `ThrustEngine`, not a rewrite of the synchronous API.

---

## 4. Public API

```rust
// afterburner-thrust/src/lib.rs

pub struct ThrustEngineConfig {
    /// Number of compute workers. Defaults to physical core count.
    pub compute_workers: usize,
    /// I/O pool size. 0 disables dirty-scheduler offload.
    pub io_workers: usize,
    /// Per-tenant token-bucket refill rate (tokens/sec). `None` = no
    /// admission control.
    pub admission_tokens_per_sec: Option<u64>,
    pub admission_burst_tokens: u64,
    /// Backs the WasmCombustor. Cloned across workers.
    pub wasm_config: WasmConfig,
}

pub struct ThrustEngine { /* ... */ }

impl ThrustEngine {
    pub fn new(cfg: ThrustEngineConfig) -> Result<Arc<Self>>;

    /// Queue a thrust. Returns a lock-free receiver that yields the
    /// result when the worker finishes. Never blocks on the caller.
    pub fn thrust(
        &self,
        id: &ScriptId,
        input: Value,
        limits: FuelGauge,
        tenant: Option<TenantId>,
    ) -> ThrustHandle;

    /// Blocking convenience — waits on the receiver.
    pub fn thrust_sync(
        &self,
        id: &ScriptId,
        input: Value,
        limits: FuelGauge,
        tenant: Option<TenantId>,
    ) -> Result<Value>;

    /// Register a source with every worker. Uses `BurnCacheBackend` if
    /// attached (Phase G) so re-registration across a cluster is free.
    pub fn register(&self, source: &str) -> Result<ScriptId>;

    pub fn stats(&self) -> ThrustEngineStats;
    pub fn shutdown(self: Arc<Self>);
}

pub struct ThrustHandle { /* kovan-channel Receiver<Result<Value>> */ }
impl ThrustHandle {
    pub fn recv(self) -> Result<Value>;
    pub fn try_recv(&self) -> Option<Result<Value>>;
}
```

`tenant: Option<TenantId>` is a small integer (`NonZeroU32`); the admission layer uses it as a map key. `None` = unrestricted (default for trusted in-process use).

`WasmConfig` already derives `Clone` (per Phase G). The engine config shares one `Engine` across workers; each worker stamps its own `HostState`.

---

## 5. Scheduling core

### 5.1 Work distribution

1. **`thrust()` callers** push a `Job` onto a per-worker deque via `hash(script_id) % N`.
   - **Why hash-route, not round-robin:** affinity. A script compiled once wants to run on the same worker's pooled `InstancePre` slot (affinity bit in `PoolingAllocationConfig`). Round-robin would evict slots across workers and hurt cache.
   - **Why not explicit sticky routing:** the user doesn't know the script_id in advance for first-compile; hash-routing is stable after compile.
2. **If that worker's deque is full** (cap = 256 per worker — covers 256 × 50 µs = 12.8 ms of buffered work; past that the caller is being abused), push to the **global injector**. Workers check the injector once per ~64 local pops (Tokio's 61 is the well-tested number — we use 64 for clean bitwise AND).
3. **If an idle worker wakes and its deque is empty**, it steals half from a random peer's deque (Chase-Lev concurrent `steal`, Lê et al. 2013 fences).
4. Steals skip the pooling affinity hint — the peer's compiled module isn't on this worker's slot. Acceptable once in a while; shouldn't dominate.

### 5.2 Worker loop

```rust
loop {
    let job = match self.pop_local()      // Chase-Lev owner pop, 2 atomic ops
        .or_else(|| self.poll_injector(NWORKERS))   // every 64 iters
        .or_else(|| self.steal_random_peer())       // fallback
        .or_else(|| self.park_until_signal())       // idle
    { Some(j) => j, None => return };

    self.execute(job);
}
```

`park_until_signal()` uses a kovan-channel notification: `inject` wakes one parked worker, `push_local` wakes this specific worker if parked.

### 5.3 `execute(job)`

```rust
// Pseudocode.
let start = Instant::now();
admission.take_or_reject(job.tenant)?;  // backpressure; non-blocking

// Reuse pooled Store slot if the script's affinity bucket matches;
// else checkout fresh via PoolingAllocationConfig.
let mut store = self.store_pool.checkout(job.script_id)?;
store.set_fuel(job.limits.fuel.unwrap_or(u64::MAX));
store.set_epoch_deadline(job.limits.timeout_epoch_ticks());

let instance = self.instance_pre.instantiate(&mut store)?;
let start_fn = instance.get_typed_func::<(), ()>(&mut store, "_start")?;

// Pipe input into stdin, run, drain stdout — same pattern as today.
match start_fn.call(&mut store, ()) {
    Ok(()) => { ... drain stdout, decode, reply ... }
    Err(trap) => { ... map trap to AfterburnerError ... }
}

self.store_pool.return_affine(store, job.script_id);
self.stats.record(start.elapsed(), admission_outcome);
```

No async, no fibers. Each worker is a plain OS thread. Wasmtime's `call_async` buys us nothing here — our workload has no I/O inside the thrust (outbound HTTP is the dirty-pool concern below).

---

## 6. Preemption and the microtask-pump bug (REVIEW.md Pitfall 18)

The hybrid-threading plan is moot if one worker wedges forever on an infinite microtask chain. Native is already capped via `MAX_PUMP_ITERATIONS` (fix from this week's audit). WASM still needs the fix. Two options:

### Option A — Local javy-plugin-api fork (safe, 1 day)

Fork `javy-plugin-api` at v6.0.0 as `afterburner-javy-plugin` (local path dep), patch `handle_maybe_promise` to cap its drain loop at `MAX_PUMP_ITERATIONS` and wire the engine's fuel counter into the exit check. Upstream the patch to Bytecode Alliance separately.

### Option B — Epoch-driven forced interrupt (fast, 0.5 day)

The epoch ticker already increments the engine atomic every 1 ms. Wasmtime's Cranelift-generated code inserts epoch checks at safe points — **including inside the guest's microtask pump** because those are just more WASM instructions. We've had trouble observing this empirically (Pitfall 18), which suggests the epoch is getting incremented but the guest isn't hitting a safepoint before returning. Verify by:
1. Setting `Config::epoch_interruption(true)` (already done).
2. Setting `Config::cranelift_opt_level(OptLevel::Speed)` (already done).
3. Confirming `increment_epoch` is actually firing via per-store counter.
4. If safepoints are too sparse, try `Config::epoch_interruption(true)` + `Config::cranelift_opt_level(OptLevel::SpeedAndSize)` — size-biased opt emits more safepoints.

**Plan:** try Option B first (half-day spike). If epoch interrupts the pump, done. If not, fall back to Option A.

Either way, the regression test is `wasm_infinite_microtask_chain_is_bounded` — the WASM counterpart to the native test we already have.

---

## 7. Dirty pool for blocking host calls

Current host calls that block:
- `__host_http_request` — `ureq::call()`, blocking HTTP I/O.
- `__host_fs_read_chunk` / `__host_fs_write_chunk` — blocking syscalls.
- `__host_dns_lookup` — blocking DNS.

A compute worker serving a 50 µs thrust shouldn't stall on a 100 ms HTTP round-trip. BEAM solves this with **dirty schedulers** (separate pool). Our equivalent:

1. A small I/O pool (2–8 threads) running a kovan-channel work queue.
2. When a compute worker hits a blocking host import, it posts the request to the I/O pool and **parks** (via a kovan-channel receiver) on a result channel.
3. The compute worker wakes up when the I/O worker posts the result.

**Catch:** we can't actually park the WASM instance mid-call. A running WASM call holds the `Store` and a `Call` on the stack. Solutions:

- **7.1 Move host I/O to the host and use async-capable Wasmtime.** Enable `Config::async_support(true)`; host imports are `Func::wrap_async` returning futures. The worker thread runs `pollster::block_on` or a single-threaded executor per worker. The compute worker is free to pick up another job while the I/O future is pending. Memory cost: 2 MiB stack per in-flight thrust (Wasmtime's default `async_stack_size`) — affordable with pooling allocator's `total_stacks` cap.

  This is the right long-term architecture. Cost: moderate refactor of `host_imports.rs` to `Func::wrap_async`, and `ThrustEngine` becomes a Tokio-less single-threaded-per-worker executor over futures.

- **7.2 Short-term: fuel-bound the blocking imports.** `ureq` has no cheap timeout knob? Wrap with `.timeout(X)` per call. Not a scheduler fix; just bounds the damage until 7.1 lands.

**Plan:** ship 7.2 in Phase 2 as a stopgap. Land 7.1 in Phase 3.

---

## 8. Admission control

Token bucket per tenant. Refill rate = `admission_tokens_per_sec`. Bucket capacity = `admission_burst_tokens`. Each thrust consumes 1 token at scheduling time (not at completion — fairness with respect to requested work, not completed work).

If `take_or_reject(tenant)` returns `Err(RateLimited)`:
1. `ThrustEngine::thrust` resolves the `ThrustHandle` with `Err(AfterburnerError::RateLimited { tenant, retry_after_ms })`.
2. Caller is expected to back off.

Storage: `kovan_map::HopscotchMap<TenantId, Arc<AtomicU64>>` with monotonic nanosecond timestamps for last-refill. No mutex needed.

Fast path when `tenant: None` (trusted in-process): skip the bucket entirely.

Global backpressure (all tenants combined) layered on top: total in-flight thrusts ≤ `total_core_instances` of the pooling allocator. Past that, `Err(Overloaded)`. This prevents runaway memory regardless of tenant count.

---

## 9. Wasmtime config for multi-thread

```rust
let mut engine_config = Config::new();
engine_config
    .consume_fuel(true)
    .epoch_interruption(true)
    .memory_init_cow(true)
    .cranelift_opt_level(OptLevel::Speed)
    .parallel_compilation(true);  // new

let mut pool = PoolingAllocationConfig::default();
pool.total_core_instances(cfg.compute_workers * 4);   // 4× concurrency budget
pool.total_memories(cfg.compute_workers * 4);
pool.total_stacks(cfg.compute_workers * 4);
pool.async_stack_keep_resident(1 << 20);  // 1 MiB; matters if 7.1 lands
pool.linear_memory_keep_resident(1 << 20);
// affine slots: default-on in wasmtime 36.

engine_config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool));
```

`parallel_compilation(true)` uses rayon for Cranelift codegen on module instantiation — helps during cold-start compile.

The engine is constructed once in `ThrustEngine::new`, cloned into every worker. `InstancePre` is built once from `instance_pre::instantiate_pre(&module)` and shared via `Arc`.

---

## 10. Phase breakdown

| Phase | Effort | Gates |
|---|---|---|
| T0 — `afterburner-thrust` crate scaffold + `ThrustEngine` stub | 1 d | Crate compiles; empty `thrust()` returns `RateLimited` sentinel. |
| T1 — Pooling allocator + InstancePre + single worker | 1 d | One-worker throughput matches or beats today's per-call `Store::new`. Perf smoke: 100K trivial thrusts/sec single-core target. |
| T2 — N workers + kovan-channel injector + hash routing | 1 d | N-worker throughput scales linearly on `num_cpus()` up to NUMA boundary. `tests/thrust_scale.rs` asserts 2× at 2 workers. |
| T3 — Chase-Lev deque + steal-when-idle | 2 d | Imbalanced workload (all jobs hash to worker 0) still drains via steals; all workers stay busy. |
| T4 — Admission / token bucket | 0.5 d | Single-tenant flood throttled to `admission_tokens_per_sec`; other tenants unaffected. |
| T5 — Microtask pump cap on WASM (Pitfall 18) | 1 d | `wasm_infinite_microtask_chain_is_bounded` passes. |
| T6 — I/O pool + async-Wasmtime host imports | 3 d | `fetch(slow-url)` no longer wedges its compute worker. |
| T7 — NUMA-aware hierarchy (optional; gate on box size) | 2 d | Skipped until multi-socket deployment; LAWS / PufferFish if needed. |
| T8 — Consolidated integration + perf smoke | 1 d | 100K+ thrusts/sec on 8 cores; p99 latency < 10× p50. |

**Critical path: T0 → T1 → T2 → T3 → T5 → T8.** T4 and T6 are orthogonal value-adds; T7 is conditional.

Total: ~10 engineering days for the critical path, ~14 with all optional phases.

---

## 11. Risks

- **Pooling allocator slot exhaustion under burst.** Mitigation: bucket in `admission.rs` enforces a global in-flight cap = `total_core_instances`.
- **Epoch ticker lag.** If the dedicated ticker thread is scheduled-out for >1 epoch, timeouts fire late. Mitigation: use `SCHED_FIFO` via `thread_priority` crate if available; otherwise accept the lag (still bounded by OS scheduler jitter, typically < 10 ms).
- **Steal-ing a script not compiled on the stealer's affinity slot.** First steal fetches the module into the stealer's pool slot (paid per-steal). Mitigation: locality hints in `push_local` — mark rare/heavy scripts as "sticky" so they preserve affinity even when the origin worker is busy. Defer to after T3 stabilizes.
- **Dirty-pool starvation.** If the I/O pool fills up with slow HTTP calls, new I/O requests queue and compute workers wait. Mitigation: per-thrust hard deadline (`FuelGauge::timeout_ms`) aborts the wait.
- **No std::sync::Mutex rule interacts with existing kovan-channel unbounded API.** Deque and injector must use kovan primitives only; no `crossbeam-deque`. Upstream kovan-queue a Chase-Lev variant if it doesn't already have one — this is the single biggest upstream dependency of the plan. Confirm before T3.

---

## 12. Verification

Gates at the end of T8:
1. `cargo build --workspace` clean; `cargo clippy --all-targets --all-features -- -D warnings` clean.
2. All pre-existing tests (167 at commit `3754159`) still pass.
3. New tests:
   - `tests/thrust_scale.rs` — 2×/4×/8× workers scale linearly for embarrassingly-parallel thrusts.
   - `tests/thrust_steal.rs` — imbalanced load completes without idle workers.
   - `tests/thrust_admission.rs` — single-tenant flood throttled; other tenants unaffected.
   - `tests/thrust_io_offload.rs` — slow HTTP call doesn't block compute workers (conditional on T6).
   - `tests/thrust_microtask_cap.rs` — WASM counterpart of the native test, passes on both paths.
4. Perf smoke: 100K thrusts/sec on 8 cores with the trivial `(d) => d.n + 1` script, p99 < 10× p50.
5. No `std::sync::Mutex`/`RwLock`/`parking_lot`/`DashMap` anywhere in `afterburner-thrust` or its touched neighbors.

---

## 13. What this plan explicitly does NOT do

- **No pseudo-worker_threads** — Phase F of IMPL_PLAN_REMAINING_WORK stays deferred. This plan enables threading *between* thrusts, not *inside* one script.
- **No thread-per-tenant isolation** — Cloudflare Workers do this (cordons); we accept shared-engine Spectre risk until there's a real threat model. The one-Engine-many-Stores model does not protect against timing side-channels between tenants; document explicitly.
- **No dynamic worker count resizing.** Worker count is fixed at `ThrustEngine::new`. Auto-scaling is an operator's job.
- **No distributed work routing.** Phase G's `BurnCacheBackend` shares source across nodes; this plan does not distribute *jobs* across nodes. That's a future project.

---

## 14. Open Questions

1. **Kovan Chase-Lev availability.** `kovan-queue` may not have a deque primitive. If not, does the workspace want us to implement one in `kovan-queue` upstream, or vendor a Rust-port implementation inside `afterburner-thrust`? Default: upstream to kovan-queue — maintains the "kovan-only" concurrency rule.
2. **Default worker count.** `num_cpus::get_physical()` or `num_cpus::get()` (includes SMT siblings)? Default: physical cores. SMT typically hurts throughput for CPU-bound JIT-less interpreter work like QuickJS.
3. **Async host imports vs. thread-blocking.** Phase 7.1 (async host imports) is the right answer long-term but forces a Tokio-or-equivalent executor per worker. Worth the complexity now? Default: ship 7.2 first (blocking with per-call timeouts), migrate to 7.1 when an external consumer actually feels the pain.

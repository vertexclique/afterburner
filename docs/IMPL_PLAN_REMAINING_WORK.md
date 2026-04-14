# Implementation Plan: Afterburner Remaining Work

**Workspace:** `afterburner/` (all member crates)
**Status:** Design Complete — Implementation Not Started
**Depends on:** everything shipped so far (Combustor trait, Wasm/Native/Adaptive combustors in progress, Plenum node-compat bundle, 141 tests green as of commit `4d070a7`)

This is the forward roadmap covering everything not already landed. It supersedes the "still open" backlog in `docs/REVIEW.md` and complements `docs/IMPL_PLAN_JS_WASM_ENGINE_WORK.md` (which predates the realized scope changes).

Explicitly **out of scope** per user direction: GPU UDFs, TypeScript/SWC support.
Explicitly **not implementable** (rationale below, not attempted): native `.node` addons.

---

## Open Questions (answer before execution)

These four decisions materially change phase shape. Defaults listed below are what I'll proceed with if no input arrives.

1. **Event loop scope.** Phase E proposes a minimal synchronous-drained microtask queue + an epoch-based deadline timer for `AbortSignal.timeout`, `setTimeout`/`setInterval`, and chainable Promises. This is a meaningful architectural addition to what was originally designed as a sync-only runtime. Alternative: keep `AbortSignal.timeout` as already-aborted and leave `setTimeout` stubbed.
   - **Default:** Add the minimal loop. Scripts that don't use it pay zero runtime cost (queue is empty; drained after `_start` returns).

2. **Worker-thread semantics.** True threads are impossible (single-threaded QuickJS). Phase F proposes *pseudo-workers*: a second `rquickjs::Context` (or a second wasmtime `Store`) per `new Worker(src)`, wired by a synchronous postMessage queue. No actual parallelism; scripts serialize. Alternative: keep `worker_threads` stubbed with `ERR_NOT_SUPPORTED_IN_SANDBOX`.
   - **Default:** Pseudo-workers. Delivers structural compatibility for Node code that uses workers for isolation, at the cost of latency equivalence.

3. **Distributed WASM cache scope.** Phase G proposes only an API surface — a `BurnCacheBackend` trait with `fetch(hash) -> Option<Vec<u8>>` / `publish(hash, bytes)` hooks — so external coordinator infrastructure (Redis, object storage, etc.) can plug in without modifications to afterburner itself. Alternative: include a reference in-memory implementation and skip the trait.
   - **Default:** Trait + default in-process implementation (current `HopscotchMap`). External backends are consumer responsibility.

4. **WASI P2 migration timing.** Phase H has two variants: (a) locally code-gen host imports from the existing `wit/afterburner-host.wit` spec, eliminating Smell #16 (~3 days), without changing the P1 runtime path; or (b) full P2 component model migration (~2 weeks, gated on wasmtime component-linker ergonomics that upstream hasn't stabilized for Wizer-preinitialized plugins).
   - **Default:** (a) only. (b) is deferred indefinitely until upstream tooling converges — I'll document the blocker rather than attempt it.

---

## Phase Ordering

```
                     ┌──────────────────────┐
                     │ A: Streaming hash    │ reuses SignHandleStore
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │ B: WIT codegen       │ dep of C, D, E, F (codegen helps them)
                     └──────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
┌───────▼─────────┐    ┌────────▼───────┐    ┌──────────▼────────┐
│ C: HostFn API   │    │ D: Adaptive    │    │ E: Event loop     │
│    + udf_batch  │    │    Combustor   │    │    (Q1 pending)   │
└────────┬────────┘    └────────┬───────┘    └──────────┬────────┘
         │                      │                       │
         │                      │            ┌──────────▼────────┐
         │                      │            │ F: Pseudo-workers │
         │                      │            │    (Q2 pending)   │
         │                      │            └──────────┬────────┘
         │                      │                       │
         └──────────┬───────────┴───────────────────────┘
                    │
          ┌─────────▼──────────┐
          │ G: Distributed     │  parallel with A-F; no deps
          │    cache API       │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │ H: WIT codegen     │  variant (a) only; parallel with C-G
          │    (cleanup)       │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │ I: Consolidated    │  last — covers everything above
          │    integration     │
          └────────────────────┘
```

Phases with no edges between them can proceed in parallel. The critical path is A → B → (C | D | E → F) → I.

---

## Phase A — Streaming `createHash` / `createHmac`

**Goal.** Eliminate full-buffer hashing for `crypto.createHash('sha256').update(chunk).update(...).digest('hex')`. Memory should be `O(digest state)` not `O(total payload)`.

**Inputs.** `afterburner-node-compat/src/sign_handles.rs` (already built for sign/verify — same pattern extends here), `afterburner-node-compat/src/crypto_host.rs::DigestState` enum.

**Deliverables.**
- Extend `DigestState` to include MD5, SHA-1 (if we keep it), SHA-224 variants so `createHash` can target the full Node.js set.
- New enum `HashHandle { Digest(DigestState), Mac(HmacState) }` or split stores. Reuse `HopscotchMap` with monotonic `AtomicU64` ids.
- Four new host imports, mirroring sign's handle lifecycle:
  - `__host_crypto_hash_open(algorithm) -> i64`
  - `__host_crypto_hash_update(handle, data_b64) -> i32`
  - `__host_crypto_hash_digest(handle, encoding) -> String` (hex/base64)
  - `__host_crypto_hmac_open(algorithm, key_b64) -> i64` (HMAC needs the key at open time)
- Polyfill rewrite in `afterburner-node-compat/polyfills/crypto.js::Hash`/`Hmac` with streaming host path + buffering fallback (same pattern as sign/verify).
- Regression test in both `afterburner-ignite/tests/node_compat_host.rs` and `afterburner-wasi/tests/node_compat_host.rs` asserting a 1 MB payload chunked 100× produces identical output to one-shot `crypto.hash(algo, data)`.

**Risk.** Low. Blueprint is already proven by Pitfall #12. Handle-store, polyfill pattern, and wire format are reused verbatim.

**Effort.** 1–2 days.

---

## Phase B — WIT-Driven Host-Import Codegen

**Goal.** Kill Smell #16 from `docs/REVIEW.md`. Today each host import lives in four places (`wit/afterburner-host.wit`, `afterburner-wasi/src/host_imports.rs` linker wiring, `afterburner-plugin/src/lib.rs` extern decls + Func bindings, `afterburner-node-compat/src/native_install.rs` native glue). After Phase A that's 25+ imports maintained by hand.

**Inputs.** `wit/afterburner-host.wit` (already the source-of-truth spec), `wit-bindgen` Rust code generator.

**Deliverables.**
- A `build.rs` in `afterburner-wasi`, `afterburner-plugin`, and `afterburner-node-compat` that reads `wit/afterburner-host.wit` and emits matched:
  - Wasmtime `linker.func_wrap(...)` registrations (wasi side).
  - `extern "C"` declarations + `Func::from(...)` globals (plugin side).
  - `rquickjs::Function::new(...)` globals (native side).
- The generator uses a small typed IR we define (arg kind: `string | bytes | i32 | f64 | handle`, return kind: `i32 | i64 | string | bytes | void`). We *don't* use `wit-bindgen` directly — its generated bindings target the component model, not our raw P1 base64 ABI.
- Existing hand-written wiring is deleted; the `build.rs` regenerates it on every build. Plugin's `generated.rs` is `include!`'d into `lib.rs`.
- One new integration test: `tests/generated_abi_parity.rs` compiles a trivial script on both paths and asserts they return identical output for every import — guards against codegen drift.

**Risk.** Medium. The codegen must handle the special cases we have today (the base64 wire format, `__HOST_ERR__:` sentinel, buffer-protocol `out_ptr/out_cap` pairs). Expect a few iterations to cover them all. Fallback if codegen turns out brittle: keep the WIT as docs-only, land the rest of the plan on manual wiring.

**Effort.** 3–5 days.

**Open question:** Do we want the codegen embedded in each crate's `build.rs` (three copies) or a new `afterburner-abi-gen` crate that all three build-depend on? Default: new crate, single source.

---

## Phase C — HostFunction API Surface + `udf_batch`

**Goal.** Ship the ScramDB-facing contract: `HostFunction` variants, trait hooks for user-provided implementations, and the `udf_batch(script_id, rows, limits) -> rows` helper that ScramDB's `PipelineOp::JsTransform` will call. This is **API surface only** per the original locked decision — no pipeline wiring in this repo.

**Inputs.** `afterburner-core/src/host.rs` (skeleton exists), `afterburner-core/src/registry.rs` (`BurnCache`).

**Deliverables.**
- `HostFunction` enum: `Log`, `ReadColumn`, `EmitRow`, `GetEnv`, `HttpRequest` — already declared per Phase 1 notes; this phase wires the trait implementation glue.
- `HostContext` trait with one method per variant. Default blanket impl panics with "not implemented by embedder" so unused variants don't surprise.
- `BurnCache::udf_batch(id: &ScriptId, rows: &[Value], limits: &FuelGauge) -> Result<Vec<Value>>` — iterates rows, invokes `thrust` per row, short-circuits on first error. Identity-transform test verifies the shape round-trips.
- Gated behind `host-http` feature for `HttpRequest` (already done; verify this phase didn't regress).
- New inline test in `afterburner-core/tests/udf_batch.rs`: identity transform on a 10-row input, per-row `EmitRow` hook accumulator, wrong-schema row returns typed error from the first bad row.

**Risk.** Low. The hooks are trait-dispatched; the blast radius is contained to `afterburner-core` and a thin `WasmCombustor` linker addition.

**Effort.** 2–3 days.

**Open question:** Should `udf_batch` be parallel across rows (rayon) or sequential? Default: sequential. Rationale: scripts are CPU-bound and each already holds a `Store`; parallelism is the caller's job (e.g. ScramDB morsel-driven execution already spawns per-morsel tasks).

---

## Phase D — `AdaptiveCombustor` (Flying Start Tier Switch)

**Goal.** Deliver the original Step 7: first call runs on native (rquickjs, ~300 μs ignite), meanwhile a background task compiles WASM; subsequent calls route to the WASM path. Failure to compile is sticky — stay native forever.

**Inputs.** `afterburner-adaptive` crate (scaffold exists), `afterburner-ignite::NativeCombustor`, `afterburner-wasi::WasmCombustor`.

**Deliverables.**
- `AdaptiveCombustor::new(native, wasm) -> Self` takes the two existing combustors.
- `CompilationState { Compiling, Ready(wasmtime::Module), Failed(String) }` stored in `HopscotchMap<[u8;32], CompilationState>`.
- Background compilation via a single long-lived worker thread (no per-call spawn — the doc warns against thread-per-thrust). Queue sends use `kovan-channel`.
- `thrust` checks the state map: `Compiling` or `Failed` → route to native; `Ready(module)` → route to wasm with the cached module.
- Inline tests in `afterburner-adaptive/tests/adaptive_tier.rs`:
  - first call uses native (assert via per-backend counter).
  - second call (after compile completes) uses wasm.
  - compile failure stays native.
  - concurrent first calls of the same script compile exactly once (counter asserts).

**Risk.** Medium. Concurrent first-call deduplication requires a single-writer invariant on the state map. Using the compiler channel as the serialization point — first `send` wins; further `Compiling` entries wait on a notifier channel — keeps us lock-free-map-compatible. No `Mutex` anywhere.

**Effort.** 3–4 days.

---

## Phase E — Minimal Event Loop (decide via Q1)

**Goal.** Enable the patterns scripts legitimately need: chained Promises (`fetch().then(...)`), `async/await` (resolved Promise `await`), `AbortSignal.timeout(ms)`, and `setTimeout`/`setInterval` used for deferred work *within* a single thrust.

**Non-goal.** Real async I/O. All host functions remain synchronous; the loop only drains already-resolved microtasks and fires deadline-expired timers.

**Design.**
- Two queues held per `Store`/per native runtime:
  - Microtask queue: resolved Promise callbacks. Drained after every JS call returns. Feed via rquickjs' built-in `runtime.execute_pending_job()` loop; Javy ships the same API (event-loop runtime config is a compile-time flag on the plugin — we flip it).
  - Timer queue: `BinaryHeap<Deadline>` keyed by monotonic time. After microtasks drain, check the heap; if the top deadline is in the past, fire its callback and re-drain microtasks. Ticks synchronously — no wall clock.
- Execution model: `thrust` calls user script → user script schedules stuff → `thrust` pumps microtasks + timers until both queues are empty *or* the timeout epoch fires, whichever first.
- Fuel accounting continues to tick through drains — runaway timer chains get caught.

**Deliverables.**
- Plugin: enable event-loop in `javy-plugin-api` config. Regenerate `afterburner_plugin.wasm` (sidecar sha256 updated).
- `afterburner-wasi/src/wasm_engine.rs`: pump loop in `thrust`.
- `afterburner-ignite/src/native_engine.rs`: call `runtime.execute_pending_job()` in a loop.
- New host functions: `__host_time_monotonic_ms() -> f64` (already partially there for os.hrtime — unify).
- `afterburner-node-compat/polyfills/timers.js`: `setTimeout(cb, ms)` / `setInterval` / `clearTimeout` backed by the host timer queue. `AbortSignal.timeout(ms)` uses the same infrastructure.
- Regression tests: `fetch().then(resp => resp.text()).then(body => ...)` works; `setTimeout(fn, 0)` fires exactly once; `setTimeout(fn, 1000)` fires after 1 s of host time *or* timeout-trap if the thrust deadline is sooner; `AbortSignal.timeout(10)` aborts a fetch mid-retry loop.

**Risk.** High — this touches the execution model. The Javy plugin event-loop path is documented but I haven't personally exercised it at scale. Expect 1–2 days of Javy-specific trial-and-error.

**Effort.** 5–7 days.

**If Q1 = no:** drop Phase E entirely. Phase F also drops (workers need message dispatch via timers).

---

## Phase F — Pseudo-`worker_threads` (decide via Q2)

**Goal.** Make scripts that use `new Worker(sourcePath)` / `parentPort.postMessage` / `worker.postMessage` structurally work — without true threads.

**Design.**
- Each `new Worker(src)` spawns a second `rquickjs::Context` in the same process (native path) or a second wasmtime `Store` re-using the preinitialized Javy `InstancePre` (WASM path).
- `postMessage` serializes via `structured-clone-lite` (we implement the subset that matters: primitives, typed arrays, Map/Set, plain objects — no cycles, no SharedArrayBuffer, no transferables yet).
- Dispatch is cooperative: `worker.postMessage(msg)` queues on the worker's inbound; the next time the worker's event loop drains (Phase E), it runs its handler. Main thread blocks on `new Promise` resolution until the worker has drained all queued messages — not real concurrency, strictly interleaved turns.

**Deliverables.**
- `afterburner-node-compat/polyfills/worker_threads.js`: Worker class, MessagePort pair, parentPort.
- Host-side: per-combustor worker pool keyed by worker-id, storage via `HopscotchMap`, channel-backed queues via `kovan-channel`.
- Large integration test: master script spawns worker that echoes a mutated payload; verify structured-clone correctness on Map/Set/typed-array.

**Risk.** High — serialization is fiddly, and preserving error semantics (uncaught in worker → `worker.on('error')`) across context boundaries takes care. This is the biggest user-visible new feature.

**Effort.** 7–10 days.

**If Q2 = no:** drop Phase F. The existing `ERR_NOT_SUPPORTED_IN_SANDBOX` stub stays.

---

## Phase G — Distributed Content-Addressed Cache API Surface

**Goal.** Let external coordinators plug into `BurnCache`. A Redis/S3/NATS-backed registry can publish compiled WASM keyed by script hash so a 10-node deployment doesn't re-compile the same script 10×.

**Inputs.** `afterburner-core/src/registry.rs::BurnCache`.

**Deliverables.**
- `BurnCacheBackend` trait:
  ```rust
  pub trait BurnCacheBackend: Send + Sync {
      fn fetch(&self, hash: &[u8; 32]) -> Result<Option<Vec<u8>>>;
      fn publish(&self, hash: &[u8; 32], module_bytes: &[u8]) -> Result<()>;
  }
  ```
- Default impl `InProcessCacheBackend` wrapping the current `HopscotchMap<[u8;32], Vec<u8>>`.
- `BurnCache::with_backend(backend: Arc<dyn BurnCacheBackend>)` constructor.
- `register()` flow: compute hash → backend.fetch → on miss, compile → backend.publish → store in-memory for subsequent calls.
- Inline test: two `BurnCache` instances sharing a test backend (just a `HopscotchMap` behind the trait) compile exactly once combined.

**Risk.** Low. Trait hooks only; the interesting work lives in the external coordinator, not here.

**Effort.** 1–2 days.

---

## Phase H — WIT Spec Alignment (variant (a) only per Q4)

**Goal.** Bring `wit/afterburner-host.wit` back in sync with the post-Phase-A host surface, and wire Phase B's codegen to consume it.

**Deliverables.**
- Update the WIT spec: add all Phase A streaming hash imports, all Phase C host functions, any Phase E timer imports.
- CI check (`wit/build.sh` or a dedicated `cargo xtask wit-check`) that diffs the WIT against the generated Rust and fails the build on drift.

**Not in scope:** full P2 component model migration. Rationale: Wizer still flattens components to core modules, `wasmtime::component::Linker` has ergonomic issues with Wizer-preinitialized plugins (reported upstream, unresolved). Revisit when upstream tooling converges.

**Risk.** Low. Spec maintenance is mechanical once codegen exists.

**Effort.** 2 days.

---

## Phase I — Consolidated Integration Tests + Perf Smoke

**Goal.** End-to-end test matrix proving the combined surface. Covers everything from Phase A–G plus existing functionality.

**Deliverables (new tests under top-level `tests/`):**
- `tests/basic_eval.rs` — public API smoke tests.
- `tests/directus_compat.rs` — data-chain passthrough, no-`require`, no-`fs` (extends existing).
- `tests/data_flow.rs` — `udf_batch` array-of-objects shape (Phase C).
- `tests/adaptive_tier.rs` — already drafted at Phase D; moved here for cross-crate coverage.
- `tests/sandbox_security.rs` — already comprehensive; extend with any new surface from E/F.
- `tests/event_loop.rs` — Phase E coverage (if enabled).
- `tests/workers.rs` — Phase F coverage (if enabled).
- `tests/perf_smoke.rs` — extend existing: 100 k trivial thrusts under a wall-clock threshold; mixed streaming-sign workload doesn't regress.

**Risk.** Low. Tests discover issues; doesn't introduce them.

**Effort.** 3–4 days.

---

## Explicitly Not Implemented

| Item | Why not attempted | Alternative |
|------|-------------------|-------------|
| Native `.node` addons | Can't run native code in a WASM sandbox (defeats the point). rquickjs has no N-API shim. | Leave `process.binding` stubbed with `ERR_NOT_SUPPORTED_IN_SANDBOX`. |
| Real threads (`worker_threads` with parallelism) | QuickJS is single-threaded. Sharing values across threads is undefined behavior. | Phase F pseudo-workers via second context. |
| WASI P2 full component-model migration | Wizer flattens components → core modules; upstream wasmtime-component-linker ergonomics unfinished. | Phase H variant (a): use WIT as spec for local codegen only. |
| GPU UDFs | User deferred. | — |
| TypeScript / SWC | User deferred. | — |

---

## Verification

At the end of Phase I, the following must hold:
1. `cargo build` (default members) green with zero warnings.
2. `cargo test` green; test count increases from the current 141 to roughly 200+ depending on Q1/Q2 answers.
3. `cargo clippy --workspace --exclude afterburner-plugin --all-targets -- -D warnings` clean.
4. Perf smoke: 100 k trivial thrusts under the existing threshold; streaming hash 1 MB × 100-chunk under 2× the one-shot cost.
5. Binary drift gate: `afterburner_plugin.wasm.bundle-sha256` matches the regenerated plugin bit-for-bit.
6. `docs/REVIEW.md` backlog table is either empty or references only this doc's "Not Implemented" rationale rows.

---

## Risks (cross-cutting)

- **Event-loop integration with Javy (Phase E).** Javy's event-loop runtime config is documented but under-exercised in embedder-land. If it turns out to conflict with Wizer preinitialization, we either (a) skip Wizer for event-loop-enabled scripts (slower startup) or (b) drop Phase E. Either way, Phases A–D, G, H deliver value independently.
- **Codegen brittleness (Phase B).** The ABI has edge cases (buffer protocol, error sentinel). Mitigation: keep the generator simple — if a case doesn't fit, leave that one import hand-written with a `// HAND-WRITTEN: cannot codegen X` comment and land the rest.
- **Pseudo-worker semantic drift (Phase F).** Scripts that assume real concurrency (`Atomics.wait`, `SharedArrayBuffer`) will silently get wrong behavior. Mitigation: detect `SharedArrayBuffer` and throw `ERR_NOT_SUPPORTED_IN_SANDBOX` at construction; document the "cooperative, not concurrent" semantics in the `worker_threads` polyfill's JSDoc.
- **Phase E and F raise the fuel-exhaustion attack surface.** A hostile script can flood the microtask queue or spawn deep worker chains. Mitigation: fuel ticks through every microtask drain; worker count per thrust is capped (suggest 16).

---

## Sequencing Recommendation

If all four Open Questions get "default" answers, execution order by week:

| Week | Phases | Notes |
|------|--------|-------|
| 1 | A, G | Smallest, independent, unblocks nothing else. |
| 2 | B | Unblocks cleaner wiring for C/D/E. |
| 3 | C, D | Parallel tracks; independent. |
| 4–5 | E | Biggest architectural risk — isolate its own cycle. |
| 6–7 | F | Depends on E landing. |
| 7 | H | Runs alongside F. |
| 8 | I | Hardening and final sign-off. |

Adjust if Q1 or Q2 answer "no": E/F drop from the schedule; plan compresses to ~4 weeks.

# Afterburner — Code Review

All 62 tests pass; clippy is clean. All Bugs, Pitfalls, Smells, and Nits listed below are resolved.

Severity legend: **Bug** (correctness) > **Pitfall** (will bite later) > **Smell** (cleanup) > **Nit** (style).

---

## Bugs

### 1. `AdaptiveCombustor::extinguish` + re-ignite races against in-flight WASM compile **— FIXED**
- **Issue:** After `ignite("foo"); extinguish; ignite("foo")`, a still-running background compile could land `Ready` into the state map after the extinguish had wiped the WASM cache. Subsequent `thrust` routed to WASM and hit `ScriptNotFound`.
- **Fix:** Rewrote `AdaptiveCombustor` around a **single long-lived background worker** fed by a `kovan_channel` queue. Each script owns an `Arc<Slot { state: AtomicU8 }>`; the worker transitions `COMPILING → READY/FAILED` via `compare_exchange`, and `extinguish` swaps the same atomic to `CANCELLED`. A failed CAS tells the worker to roll back the WASM cache entry it just produced. Single-worker serialization guarantees a cancelled compile's cleanup happens-before the next compile of the same hash. Regression tests: `extinguish_then_reignite_thrusts_correctly`, `wait_for_compile_reports_cancelled_after_extinguish`.

### 2. `wasmtime::Engine::increment_epoch` is engine-global; timeout sleeper trips every concurrent thrust **— FIXED**
- **Issue:** Per-thrust sleeper threads all called the engine-global `increment_epoch`, spuriously timing out concurrent thrusts.
- **Fix:** One **long-lived epoch ticker** per `WasmCombustor` ticks every `TICK_PERIOD_MS = 10 ms`. Each thrust sets `set_epoch_deadline(ceil(timeout_ms / TICK_PERIOD_MS))`, which Wasmtime stores as `current_epoch + delta` per-store — deadlines are independent. `Drop` joins the ticker via `AtomicBool`. Trap classification uses typed `wasmtime::Trap::Interrupt`/`OutOfFuel` downcasts instead of string matching. Regression test: `concurrent_thrusts_do_not_steal_each_others_timeouts`.

### 3. Per-thrust timeout thread leaked for the full timeout window **— FIXED (with #2)**
- **Fix:** No per-call thread anymore — the single ticker replaces all per-thrust sleepers.

---

## Pitfalls

### 4. Stdout cap silently truncated → confusing `Serialize` error **— FIXED**
- **Fix:** Added `AfterburnerError::OutputTooLarge { limit }`. `WasmCombustor::thrust` checks `stdout_bytes.len() >= capacity` before parsing and returns the typed error.

### 5. `FuelGauge::fuel` means very different things on Wasm vs Native **— FIXED**
- **Fix:** `FuelGauge` now documents the per-backend semantics explicitly in a table (Wasm = Wasmtime instruction count, Native = QuickJS interrupt-handler ticks, same field ~10⁴× different magnitudes) and clarifies that `timeout_ms` is the only backend-portable limit. Callers writing backend-agnostic code are steered toward the wall-clock knob.

### 6. `unsafe { std::env::set_var(...) }` in tests races concurrent test threads **— FIXED**
- **Fix:** Removed every test-side env-var write. `WasmConfig::javy_binary` now carries the path explicitly. A `test_support` module in `afterburner-wasi` (gated on `cfg(any(test, debug_assertions))`) exposes `resolve_javy()` / `config_with_resolved_javy()` — pure reads, no `set_var` anywhere in the workspace. `FlowEngine::with_javy(path, fuel)` and `AdaptiveCombustor::with_wasm_config(cfg)` let tests construct engines without env-var hacks.

### 7. `AdaptiveCombustor::ignite` spawned an unbounded thread per call **— FIXED (with #1)**
- **Fix:** Replaced with a **single background worker** fed via `kovan_channel::unbounded`. N distinct sources now enqueue N messages to one worker instead of spawning N threads; the worker processes them serially.

### 8. WASM stderr silently discarded **— FIXED**
- **Fix:** Stderr is now captured into its own `MemoryOutputPipe` exposed on `HostState`. On trap paths, `format_trap_with_stderr` appends up to 4 KiB of captured stderr to the `WasmTrap(...)` message (truncated marker included when longer).

### 9. `wrap_user_source` let user source break the IIFE wrapper **— FIXED**
- **Fix:** Execution path now uses `new Function('module', 'exports', <literal>)` where the user source is embedded as a JS string literal (properly escaped). The user cannot break the host wrapper's enclosing scope at runtime. A **static parse probe** — `function __ab_parse_probe(module, exports) { <user source inlined> }` — is still emitted so `javy build` rejects syntax errors at `ignite` time rather than deferring them to `thrust`.

### 10. `wait_for_compile` returned silently on timeout **— FIXED (with #1)**
- **Fix:** `wait_for_compile` now returns a public `CompileOutcome { Ready, Failed, Cancelled, Pending }`.

### 11. Concurrent `BurnCache::register` could run `ignite` multiple times **— FIXED**
- **Fix:** Each registration now installs an `Arc<CompileCell { result: OnceLock<…> }>` via `HopscotchMap::insert_if_absent`. Exactly one caller wins the insert and runs `ignite`; the rest wait-read the published outcome (spinning on `OnceLock::get()`, yielding between polls). Hit path is still wait-free. `concurrent_register_compiles_exactly_once_per_source` asserts `ignite_count == 1` across 16 racing threads.

---

## Smells

### 12. `WasmConfig` Default was a manual impl **— FIXED**
- `#[derive(Debug, Clone, Default)]` on `WasmConfig`; hand-written impl deleted.

### 13. Redundant `let id = id;` in sandbox_security **— FIXED**
- Deleted.

### 14. Collapsible `if let` in `do_thrust` **— FIXED**
- Rewrote as `if let Some(budget) = fuel_budget && counter.load(...) >= budget { ... }`.

### 15. Dead-code shims `_unused_hash` / `_UnusedError` in adaptive.rs **— FIXED**
- Removed (adaptive.rs was rewritten for bug #1 and no longer has them).

### 16. `PLUGIN_BYTES` marked `#[allow(dead_code)]` yet used **— FIXED**
- The const and `materialize_plugin_once` were fully dead (javy build never consumed the plugin path). Both removed along with the `plugin_path` field.

### 17. `compile_js_to_wasm` took an unused `_plugin_path` **— FIXED**
- Signature narrowed to `compile_js_to_wasm(javy_binary: &Path, source: &str)`. `WasmCombustor::plugin_on_disk` and `materialize_plugin_once` deleted.

### 18. `chain::merge` re-exported at crate root **— FIXED**
- Dropped `pub use chain::merge` from `afterburner-flow/src/lib.rs`; callers use `afterburner_flow::chain::merge`.

### 19. `serde_json` should be a dev-dep in `afterburner-adaptive` **— DECLINED**
- Investigated: `adaptive.rs` signature uses `serde_json::Value` in `Combustor::thrust`, so it is a runtime dep, not a test-only one. Leaving as a regular dependency.

### 20. Doc comments referenced design-doc step numbers **— FIXED**
- Replaced "Step 2", "Step 5", "the design doc" references with descriptions of the current contract.

---

## Nits

### 21. Unused `_hits` binding **— FIXED**
- `let (_, misses) = engine.cache_stats();`.

### 22. ASCII `=>` over `⇒` **— FIXED**
- Replaced in trap-chain diagnostic.

---

## Additional work delivered alongside the review fixes

- **Observability via `fastrace`:** `#[fastrace::trace]` spans on every public `Combustor` method (`ignite` / `thrust` / `extinguish`), `BurnCache::{register, execute, execute_batch}`, and `FlowEngine::{load, execute, unload}`. Key state transitions (`cache_hit`, `cache_miss`, `compile_failed`, `tier_switched`, `compile_cancelled`, `fuel_exhausted`, `timeout`, `output_too_large`, etc.) emit events via a level-gated `ab_event!` macro.
- **`AFTERBURNER_LOG` level control:** severity filter (`off | error | warn | info | debug | trace`, default `warn`) parsed from the env var via `afterburner_core::log::current_level()` with `OnceLock` caching. Events above the configured level short-circuit at the call site.
- **`AFTERBURNER_LOG_FORMAT` output selection:** `text` (default, line-based to stderr) or `json` (one JSON document per span to stdout). `afterburner_core::log::init()` installs the appropriate fastrace reporter idempotently; `init_with_format(Format::Text | Format::Json)` lets embedders override the env. Both built-in reporters (`TextReporter`, `JsonReporter`) are public and reusable.
- **Import hygiene:** every file now uses top-level `use` declarations — no fully qualified paths in function bodies.
- **All `eprintln!`/`println!` in workspace sources removed** in favor of `ab_event!` events or outright deletion (test skip messages rely on the skip itself being the signal).

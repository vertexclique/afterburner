# Wasmtime: Fast Instantiation, Engine/Store/InstancePre, and CPU Bounding

**Primary citations:**
- Wasmtime Book, "Fast Instantiation" — https://docs.wasmtime.dev/examples-fast-instantiation.html
- Wasmtime Book, "Pre-Compiling Wasm" — https://docs.wasmtime.dev/examples-pre-compiling-wasm.html
- Rust API: `wasmtime::Engine` — https://docs.rs/wasmtime/latest/wasmtime/struct.Engine.html
- Rust API: `wasmtime::Store` — https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html
- Rust API: `wasmtime::InstancePre` — https://docs.rs/wasmtime/latest/wasmtime/struct.InstancePre.html
- Bytecode Alliance, "Wasmtime 1.0: A Look at Performance" — https://bytecodealliance.org/articles/wasmtime-10-performance

---

## 1. The Engine / Store / Instance triangle

- **`Engine`** — process-global. Holds JIT code caches, compilation config, CPU-feature flags.
  `Send + Sync`; cloning is refcount-cheap. Share across threads.
- **`Module`** — compiled Wasm, deserialized once. `Send + Sync`. Multiple `Store`s can instantiate it.
- **`Store<T>`** — per-execution state (linear memories, tables, host data `T`). `Send + Sync` when
  `T` is, but *designed to be short-lived and single-threaded*.
- **`InstancePre<T>`** — a `Module` with all imports already resolved and type-checked. `Send + Sync`
  and `Clone`-cheap. Instantiation against a `Store` then skips all import validation.

## 2. Fast Instantiation Levers

Three levers, all required together for microsecond instantiation:

1. **`InstancePre`** — pre-resolve and pre-type-check imports once. Leaves only memory/table
   allocation + the start function on the hot path.
2. **Pooling allocator** (`PoolingAllocationConfig`) — pre-reserves a fixed pool of linear-memory
   and table slots; instantiation is "pluck a slot" instead of `mmap`. Must declare max
   concurrent instances; instantiation fails with a trap past the cap, so a backpressure /
   semaphore is mandatory.
3. **Copy-on-write memory init** — the module's data segments are mapped CoW. Pages that are
   read but not written are never duplicated. "Copying memory is deferred from instantiation
   time to when the data is first mutated" — for a read-only JS bytecode blob this means
   **zero copying** at instantiation.

## 3. CPU Bounding

Wasmtime offers two mechanisms; they're complementary.

**Fuel** (`Config::consume_fuel(true)` + `Store::set_fuel(n)`):
- Per-instruction accounting. Most Wasm ops cost 1 unit; control-flow ops cost 0.
- Trap on exhaustion. With `fuel_async_yield_interval()` can yield cooperatively instead.
- Exact but has per-instruction overhead.

**Epoch deadlines** (`Engine::increment_epoch()` + `Store::set_epoch_deadline(k)`):
- Coarse: a single `u64` bump on the Engine, checked at function entry and loop headers.
- `epoch_deadline_trap()` → trap. `epoch_deadline_async_yield_and_update()` → yield to executor.
- Effectively free at runtime; a separate thread bumps the epoch on a timer (e.g. every 10 ms).
- This is Wasmtime's equivalent of Cloudflare's "Linux timer signal → V8 TerminateExecution".

## 4. The Canonical Multi-Threaded Embedder Shape

```
Arc<Engine>                          // shared, tune JIT cache once
  ├─ Arc<Module>                     // one per content-addressed script (SHA-256)
  │    └─ Arc<InstancePre<HostState>> // imports resolved once per (Module, Linker)
  │
  └─ per worker thread:
       loop {
         recv request;
         let mut store = Store::new(&engine, host_state);
         store.set_epoch_deadline(DEADLINE_TICKS);
         let inst = instance_pre.instantiate(&mut store)?;   // µs-scale
         let exp = inst.get_typed_func::<(...), (...)>(...)?;
         let out = exp.call(&mut store, args)?;              // bounded CPU
         send response;
         drop(store);                                        // returns slots to pool
       }
```

A dedicated "ticker" thread calls `engine.increment_epoch()` on a fixed interval (say 5 ms).
Set each request's deadline as `current_epoch + N` where `N × tick = desired CPU budget`.

## 5. Lessons for Afterburner — the direct mapping

Current Afterburner uses "per-call `Store<HostState>` inside a shared `wasmtime::Engine`."
That *is* the right shape. Going multi-threaded means:

1. Make the same `Arc<Engine>` + `Arc<InstancePre>` reachable from every worker thread (already `Send + Sync`).
2. Wrap dispatch in a kovan **channel** or **queue** (no Mutex/DashMap — see workspace policy
   in `~/.claude/projects/.../feedback_concurrent_maps.md`).
3. Enable the **pooling allocator** with max instances = max concurrent in-flight requests.
4. Enable CoW memory init (it's on by default in recent Wasmtime, confirm).
5. Add a ticker thread + `set_epoch_deadline` for CPU bounding.
6. Bound store.data memory via `StoreLimits` / `ResourceLimiter` for per-call RAM cap.

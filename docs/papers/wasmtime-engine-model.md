# Wasmtime Engine / Store Thread-Safety Model

Sources:
- https://docs.rs/wasmtime/latest/wasmtime/struct.Engine.html
- https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html
- https://docs.rs/wasmtime/latest/wasmtime/struct.InstancePre.html
- https://docs.rs/wasmtime/latest/wasmtime/struct.Module.html
- https://docs.wasmtime.dev/examples-multithreaded-embedding.html
- https://docs.wasmtime.dev/contributing-architecture.html
- https://github.com/bytecodealliance/wasmtime/issues/777

## Engine

- `Engine` implements `Send + Sync + Clone`.
- Clone is cheap (internally Arc'd). "Typically created once per program and expected to be shared across multiple threads through atomic reference counting."
- Stores configuration, type interning for `Module` instances, the epoch counter, and pooling pool.
- `Engine::increment_epoch` is signal-safe: atomic increment of `AtomicU64`, no syscalls. Callable from any thread or even a signal handler.
- Does **not** implement `RefUnwindSafe` / `UnwindSafe`.
- Mutations of internals may take an internal lock; shared reads are wait-free for hot paths.

## Store

- `impl<T: Send> Send for Store<T>` and `impl<T: Sync> Sync for Store<T>`.
- "A `Store` cannot be used simultaneously from multiple threads (almost all operations require `&mut self`)."
- Sendable across threads (i.e. you can move a `Store` between OS threads) as long as `T: Send`.
- Not usable concurrently — no interior synchronization, no garbage collection until `Store` drops.
- Holds `InstanceHandle` values; allocator (on-demand or pooling) lives in the `Engine` and is consulted by each `Store`.

## InstancePre

- `Send + Sync + Clone` (Clone does not require `T: Clone`).
- Represents a module post-type-checking and post-import-resolution but pre-instantiation.
- Reusable across many `Store`s and across many threads.
- Produced by `Linker::instantiate_pre(&module)`; `instantiate(&mut store)` / `instantiate_async(&mut store)` creates actual instances.
- Panic if imports aren't owned by the given store, or if async mode is on and the sync variant is called.

## Module

- Thread-safe and safe to share across threads.
- Cheap to clone (Arc'd compiled artifact interned in Engine).

## Recommended multithreaded pattern (docs.wasmtime.dev)

```rust
let engine = Engine::default();
let module = Module::from_file(&engine, "examples/threads.wat")?;
let mut linker = Linker::new(&engine);
linker.func_wrap("global", "hello", || { /* ... */ })?;
let linker = Arc::new(linker);

let children = (0..N_THREADS).map(|_| {
    let engine = engine.clone();
    let module = module.clone();
    let linker = linker.clone();
    std::thread::spawn(move || run(&engine, &module, &linker).unwrap())
}).collect::<Vec<_>>();
```

Each worker thread creates its own `Store::new(&engine, state)` and calls `linker.instantiate(&mut store, &module)`.

## Implications for Afterburner

- One process-wide `Engine` is correct. Clone it cheaply into worker threads.
- `Module` and `InstancePre` (or `Linker`) can be shared via `Arc`.
- Per-call, create a fresh `Store<HostState>` on whichever worker thread is running the job. No lock contention.
- Epoch ticker thread: spawn one OS thread that wakes periodically and calls `engine.increment_epoch()`. This fires across all stores on all threads via the atomic counter.

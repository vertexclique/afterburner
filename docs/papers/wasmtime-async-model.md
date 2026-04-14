# Wasmtime Async / Fiber Model

Sources:
- https://docs.rs/wasmtime/latest/wasmtime/struct.Config.html
- https://docs.wasmtime.dev/examples-async.html
- https://rockwotj.com/blog/async-wasm-in-seastar/
- https://github.com/bytecodealliance/wasmtime/pull/3699 (epoch interruption PR)

## Core model

Wasmtime's async support is built on **stackful coroutines (fibers)**, not a state-machine rewrite.

- When `call_async` is invoked, Wasmtime allocates a fresh native stack (via anonymous mmap) and runs the wasm on that stack.
- Stack-switch implementation saves/restores stack pointer + frame pointer + callee-saved registers, multiplexing N fibers over 1 OS thread.
- Host imported async functions simply yield the fiber; wasm sees them as synchronous.

## Allocation granularity

> "Stacks are allocated **per future produced by `call_async`**, not per Store."

One Store can be used for a sequence of calls; each `call_async` gets its own fresh execution stack. Stacks are not reused across calls unless the pooling allocator manages them via `total_stacks` + `async_stack_keep_resident`.

## Key config knobs

| Method                  | Default | Effect                                                          |
|-------------------------|---------|-----------------------------------------------------------------|
| `async_support(true)`   | off     | Enables fiber-based async execution                             |
| `async_stack_size`      | 2 MiB   | Total fiber stack. Must be > `max_wasm_stack`                   |
| `max_wasm_stack`        | 512 KiB | Budget inside async stack usable by wasm; rest is for host fns  |
| `async_stack_zeroing`   | false   | Zero stacks on reuse (defense-in-depth; costs throughput)       |
| `epoch_interruption`    | off     | Enables epoch-based preemption (see wasmtime-engine-model.md)   |
| `consume_fuel`          | off     | Deterministic fuel-based interruption                           |

## Threading semantics

- `Engine` is `Send + Sync`; one engine can back N async executors on N worker threads.
- Each `Store` is still single-threaded at a time, but because it's `Send` you can move it between tokio tasks / worker threads freely. The typical tokio pattern:

```rust
let store = Store::new(&engine, ctx);
let fut = instance.get_typed_func::<(), ()>(&mut store, "run")?
                  .call_async(&mut store, ());
tokio::spawn(async move { fut.await });
```

- Multiple async Stores from one Engine **can** run concurrently on different tokio worker threads. The fiber library is thread-agnostic.
- "epochs (and fuel) do not assist in handling WebAssembly code blocked in a call to the host" — for stalls inside host imports use `tokio::time::timeout` or similar.

## Async + pooling allocator

When `async_support=true` and pooling is on, `total_stacks` governs how many fibers can be live. Combine with `async_stack_keep_resident` (e.g. 64 KiB) to keep hot stack pages around.

## Implications for Afterburner

- **Option A (sync + OS-thread pool):** Keep the current sync Store, dispatch each thrust to an OS worker thread via a bounded channel. Simplest. No tokio.
- **Option B (async + tokio):** Turn on `async_support`, `call_async`, and let tokio schedule. Better when host I/O is involved in thrusts; overkill if thrusts are pure compute.
- Because Javy plugin calls are pure compute (eval bytecode, return bytes), Option A is likely cheaper per-call (no fiber mmap). A dedicated rayon-style thread pool with mpsc work-stealing will hit tens of kHz easily.

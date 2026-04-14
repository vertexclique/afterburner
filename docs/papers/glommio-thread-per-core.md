# Glommio: Thread-Per-Core Rust Runtime

Primary source: Glauber Costa, "Introducing Glommio, a thread-per-core crate for Rust and Linux" (Datadog eng blog, 2020). https://www.datadoghq.com/blog/engineering/introducing-glommio/

Supplementary:
- DataDog/glommio repo README. https://github.com/DataDog/glommio
- glommio rustdoc. https://docs.rs/glommio/latest/glommio/

## Model

- Each physical (or logical) core runs **one pinned OS thread**. No work stealing. No cross-thread task movement.
- Sharding of state is the **application's** responsibility. Typical pattern: hash a request by key; send it to the owning worker via a lock-free channel; that worker mutates its private state with no locks at all.
- Inspired by SPDK (Storage Performance Dev Kit) and Seastar/ScyllaDB — both also thread-per-core, no-share. Glommio is the Rust port of this philosophy.

## Why no stealing

- Stealing implies a task accesses shared state from two cores. That means cache-coherency traffic on every access. Cost of an L3 miss (~30 ns) dwarfs the cost of the work itself for 1 μs tasks.
- Pinning also **disables OS preemption**: once the thread is on its core, the only context switch is voluntary (`yield_if_needed`) or a timer IRQ. Tail latency drops 50–70% vs stealing runtimes on I/O-bound workloads.

## Scheduler internals

- Each worker has N **task queues** with `(Shares, Latency)` tuples.
- Shares = proportional CPU (like `cgroup cpu.shares`). Latency = soft deadline; a "latency ring" on io_uring forces early yields so deadlines are respected.
- Preemption is **cooperative**: user code calls `yield_if_needed()` at safe points. An async task that never awaits will pin its core forever — same sharp edge as Tokio.

## Performance observations

- Costa's benchmarks: thread-per-core + io_uring beats Tokio by 2–3x on tail latency for I/O-heavy workloads.
- For pure-CPU workloads the gap is smaller; the main wins come from avoiding cache thrash and kernel-side preemption, not from doing work faster.

## Trade-offs vs Tokio

| Property | Tokio work-stealing | Glommio thread-per-core |
|---|---|---|
| Balances across cores | Automatic (stealing) | Manual (sharding) |
| Cross-core state | Any | None allowed |
| Tail latency | Higher | Lower |
| CPU-bound task starvation | Possible | Likely (no rebalance) |
| Sharding required | No | Yes |

## Relevance for Afterburner

- **Best fit for the steady-state happy path** of Afterburner: each worker owns a pool of warmed QuickJS stores, executes thrusts, never touches another worker's store. No inter-thread sync on the hot path. kovan primitives for dispatch, nothing else.
- Need to solve the **manual-sharding** problem: if one script spikes, we cannot just keep piling its thrusts on the same worker. Two options:
  1. Hybrid: thread-per-core for the common case, spillover to a global injector when local queue exceeds a threshold (Tokio-style but rarely hit).
  2. Pure shard-by-script-id with admission control: once a worker is saturated, refuse new invocations for that script and return 429.
- **Cooperative-only preemption is still insufficient** for untrusted JS. Same conclusion as Tokio section: combine with Wasmtime epoch interrupts so a runaway thrust yields under duress.

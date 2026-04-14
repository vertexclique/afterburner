# Tokio Work-Stealing Scheduler

Primary source: Carl Lerche, "Making the Tokio Scheduler 10x Faster" (Tokio blog, Oct 2019). https://tokio.rs/blog/2019-10-scheduler

Supplementary:
- tokio::runtime docs. https://docs.rs/tokio/latest/tokio/runtime/index.html
- "How Tokio Schedules Tasks". https://rustmagazine.org/issue-4/how-tokio-schedule-tasks/

## Architecture

- **Multi-thread runtime** = fixed pool of worker threads. Default is `num_cpus::get()`. Each worker owns a local run queue of ready tasks.
- **Single-producer / multi-consumer** bounded ring buffer per worker. Size 256. Pushes require no atomic RMW for the common case; the head/tail are Acquire/Release-ordered atomics.
- **Global injector queue**: an intrusive linked list behind a mutex. Used for:
  - spawning from outside a worker,
  - overflow when a local queue fills (half of the local queue is drained into the injector),
  - fairness (workers poll the global queue every `global_queue_interval` local tasks, default auto-tuned to ~every 61 tasks).

## Work stealing

- Idle worker picks a random peer and tries to steal **half** of the peer's queue into its own.
- Concurrent stealers are capped at `nworkers / 2` via an atomic "searching" counter to avoid thundering herd and cross-cache thrash.
- "LIFO slot": each worker has a single-slot fast path for the *next task after a wake*; it's checked before the main queue. Optimises request/response patterns (reply goes to the same worker's hot cache).

## Preemption and fairness

- Tokio is **cooperative** — tasks yield at `.await`. No asynchronous preemption. A task that loops without `await` monopolises its worker.
- Fairness knobs: global-queue poll interval, LIFO slot pre-emption, and an explicit `task::yield_now()`.
- There is no CPU-time quantum; a task that takes 10 ms between awaits will hold the worker for 10 ms. This is the sharp edge for CPU-bound workloads.

## Comparison to Go

- Same work-stealing / G-P-M topology at the strategic level.
- Go can **asynchronously preempt** via SIGURG since 1.14. Tokio cannot — it has no signal-based interrupt; it relies entirely on await points.
- Go has ~8 KB goroutine stacks; Tokio tasks are state machines (no stack) so per-task memory is much smaller.

## Relevance for Afterburner

- The work-stealing queue layout (per-worker ring, global injector, half-steal, searching cap) is **proven and copyable**. `kovan-channel`/`kovan-queue` primitives give us the lock-free pieces without DashMap or Mutex.
- But Tokio's **cooperative-only** preemption is the wrong model for untrusted user JS: a malicious or buggy thrust with `while(true){}` would pin a worker indefinitely.
- Fix: combine Tokio-style stealing at the **task dispatch** layer with **Wasmtime epoch interrupts + fuel** at the **execution** layer. Epoch timer fires → interrupt the store → scheduler rotates to the next thrust on that worker. That gives the forced preemption BEAM / Go / Pony provide but Tokio does not.

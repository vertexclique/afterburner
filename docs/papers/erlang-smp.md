# Erlang SMP Scheduler

Primary artifact: `erlang-smp.pdf` — Kenneth Lundin, "Inside the Erlang VM with focus on SMP" (EUC 2008).
URL: https://erlang.org/euc/08/euc_smp.pdf

Supplementary:
- Erlang/OTP docs, "Process Management Optimizations". https://www.erlang.org/doc/apps/erts/processmanagementoptimizations.html
- Riak, "Erlang VM Tuning". https://docs.riak.com/riak/kv/latest/using/performance/erlang/index.html

## Highlights from the EUC 2008 slides

- One **OS thread per scheduler**; one scheduler per logical CPU by default. Pinning is on by default for locality.
- Each scheduler has its **own run queue**, protected by a lightweight per-queue lock (not a global one).
- Load balancer thread periodically samples queue lengths and redistributes. Work stealing kicks in immediately when a scheduler idles out.
- Migration uses a **priority-aware path** so high-priority processes are stolen first.
- I/O is offloaded to a separate pool of **async threads** (`+A N`) so blocking file/port ops do not monopolise a scheduler.

## Dirty schedulers (added in R17)

- NIFs and BIFs that might run long (crypto, decompression, large-term ops) can be marked `dirty_cpu` or `dirty_io`.
- Dirty schedulers are a **separate thread pool** (`+SDcpu`, `+SDio`) so that a 500 ms NIF doesn't break reduction-based fairness on the normal schedulers.
- This is a direct precedent for Afterburner: if any thrust has an unbounded host call (HTTP, DB), route it to a dirty pool so ordinary 50 μs–10 ms JS thrusts keep running on the hot schedulers.

## Relevance for Afterburner

- The slide deck explains *why* per-scheduler queues beat a shared queue once you pass ~4 cores: lock contention dominates.
- The "dirty scheduler" split is the right model for Afterburner's mix of pure-CPU thrusts (stay on the normal pool) vs thrusts that do async I/O (go to a secondary pool).

# BEAM Scheduler: Reduction Counting and SMP

Sources:
- Hamidreza Soleimani, "Erlang Scheduler Details and Why It Matters" (2016). https://hamidreza-s.github.io/erlang/scheduling/real-time/preemptive/migration/2016/02/09/erlang-scheduler-details.html
- AppSignal, "Deep Diving Into the Erlang Scheduler" (2024). https://blog.appsignal.com/2024/04/23/deep-diving-into-the-erlang-scheduler.html
- theBeamBook, scheduling chapter. https://github.com/happi/theBeamBook/blob/master/chapters/scheduling.asciidoc

## Reduction-based preemption

- BEAM preempts processes via a **reduction counter**. A reduction is roughly one function call; the emulator keeps the count in `FCALLS`. When the counter reaches the maximum, the process is preempted and moved off the scheduler.
- Historical max: 2000 reductions per slice (some docs cite 4000 in newer releases). Erlang docs also mention a default slice of 200 reductions at coarse granularity; the value has been tuned across releases.
- The model is **preemptive at the Erlang level, cooperative at the C level**: yield points are inserted by the compiler/VM at function calls and `receive` statements, so the runtime never has to interrupt arbitrary C code.
- Reductions are added for non-call work too: message send, binary ops, BIF calls, allocator pressure — anything that could otherwise starve the scheduler.

## SMP architecture

- Pre-R11B: single scheduler, single run queue — no SMP.
- R11B–R12B: N schedulers, one **shared** run queue behind a lock. Bottlenecked on the lock at high core counts.
- R13B+: one run queue per scheduler (per core). Each scheduler is a dedicated OS thread, by default pinned one-per-core. Count is controlled with `+S MaxAvail:Online`; online count is adjustable at runtime via `erlang:system_flag(schedulers_online, N)`.

## Work stealing and migration

- When a scheduler's run queue is empty it **steals** from a peer's queue. Migration also runs periodically regardless of starvation to equalize load statistics.
- Two distinct mechanisms: *task stealing* (pull from overloaded peer) and *task migration* (push from overloaded to underloaded).
- Four priority classes per process: `max`, `high`, `normal`, `low`. `max`/`high` run exclusively; `normal`/`low` interleave so `low` is not starved outright.

## Relevance for Afterburner

- Reduction counting maps directly onto Wasmtime **fuel** (instruction count) — conceptually the same idea: a per-task counter decremented in the VM so a tight loop cannot hog a core.
- BEAM's "preempt at safe points" is what fuel + epoch already give us. The missing pieces are (a) multiple scheduler threads, (b) per-thread run queues of Thrusts, (c) a steal protocol.

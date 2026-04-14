# Papers index — threading & scheduling references for Afterburner

Research corpus backing `docs/IMPL_PLAN_THREADING.md`. Scope: CPU-bound sandboxed compute on multi-core boxes. Out-of-scope: distributed consensus, GPU offload, generic network I/O.

Each entry links the file to a specific design decision or tradeoff in the threading plan. Load-bearing references are marked **★**.

## Theory — work-stealing foundations

| File | Title | Year | Why it matters |
|---|---|---|---|
| `blumofe-leiserson-1994.pdf` | Blumofe & Leiserson, *Scheduling Multithreaded Computations by Work Stealing* (FOCS) | 1994 | Proves `O(T₁/P + T_∞)` time and `O(S₁·P)` space for fully-strict computations. Sets the theoretical ceiling. |
| `arora-blumofe-plaxton-1998.pdf` | Arora, Blumofe, Plaxton, *Thread Scheduling for Multiprogrammed Multiprocessors* (SPAA) | 1998 | First lock-free deque; proves O(1) competitive under OS preemption. |
| `chase-lev-2005.pdf` | Chase & Lev, *Dynamic Circular Work-Stealing Deque* (SPAA) **★** | 2005 | **Recommended baseline deque.** Fixes ABP's fixed-size flaw; two-atomic-op fast path. The algorithm used by Cilk Plus, Java ForkJoinPool, crossbeam-deque, early Tokio. |
| `frigo-leiserson-cilk5-1998.pdf` | Frigo, Leiserson, Randall, *The Implementation of Cilk-5* (PLDI) **★** | 1998 | "Work-first" principle: pay steal overhead on the critical path, keep serial execution near-baseline. 2–6× C-call cost for spawn. |
| `acar-blelloch-blumofe-2002.pdf` | Acar, Blelloch, Blumofe, *The Data Locality of Work Stealing* (TCS) | 2002 | Cache-miss bound `M₁ + O(C·P·T_∞)`. Steals are the only miss amplifier → motivates locality hints. |
| `le-pop-cohen-correct-efficient-ws-2013.pdf` | Lê, Pop, Cohen, Zappa Nardelli, *Correct and Efficient Work-Stealing for Weak Memory Models* (PPoPP) | 2013 | Proves Chase-Lev correct under ARM/POWER; specifies Rust-relevant fences. Reference when we implement the deque in Rust. |

## Theory — NUMA / modern alternatives

| File | Title | Year | Why it matters |
|---|---|---|---|
| `laws-locality-aware-ws.pdf` | Chen et al., *LAWS: Locality-Aware Work Stealing* | ~2013 | Hierarchical socket-local deques → Phase 2 when we cross a socket boundary. |
| `pufferfish-numa-ws-2020.pdf` | Kumar, *PufferFish: NUMA-Aware Work Stealing* (HiPC) | 2020 | Elastic tasks that shrink/expand on NUMA imbalance. Defer to Phase 2. |
| `arachne-osdi-2018.pdf` | Qin et al., *Arachne: Core-Aware Thread Management* (OSDI) | 2018 | Microsecond user-thread scheduler with a central core arbiter. Relevant if Afterburner ever needs sub-ms latency SLOs. |
| `shenango-nsdi-2019.pdf` | Ousterhout et al., *Shenango* (NSDI) | 2019 | Dedicated scheduler core reallocates cores every 5 µs. Same niche as Arachne. |
| `caladan-osdi-2020.pdf` | Fried et al., *Caladan: Mitigating Interference at Microsecond Timescales* (OSDI) | 2020 | Interference-aware core allocation. Read when we add multi-tenant isolation guarantees. |
| `penberg-tpc-ancs-2019.pdf` | Penberg, *Impact of Thread-Per-Core on Application Tail Latency* (ANCS) | 2019 | Empirical: TPC wins on tail only with load-aware steering; WS wins mean throughput otherwise. Directly informs the hybrid-default choice. |

## VM runtimes — scheduler & preemption

| File | Title | Year | Why it matters |
|---|---|---|---|
| `erlang-smp.pdf` | Lundin, *Inside the Erlang VM — Focus on SMP* (EUC) **★** | 2008 | Per-scheduler run queue, reduction counting (~2000 reductions/slice), dirty-scheduler pool for blocking NIFs. Afterburner's fuel ≈ BEAM's reductions; the "dirty pool" pattern is exactly what we need for `fetch`/`fs` host calls. |
| `beam-scheduler-reductions.md` | BEAM reduction-counting notes | — | Companion summary: how VM-level preemption is woven into call-sites & BIFs. |
| `pony-orca.pdf` | Clebsch et al., *Orca: GC and Type System Co-Design for Actor Languages* (OOPSLA) | 2017 | One scheduler thread per core + work-stealing when idle; GC runs between behaviours, no STW. |
| `go-scheduler-vyukov.pdf` | Vyukov, *Go Scheduler: Implementing a Language with Lightweight Concurrency* **★** | ~2014 | G/M/P model; async signal-based preemption since Go 1.14. Blueprint for attaching forced preemption (epoch signal) onto a user-thread scheduler. |
| `go-scheduler-analysis.pdf` | Deshpande, Sponsler, Weiss, *Analysis of the Go Runtime Scheduler* (Columbia) | 2011 | Empirical measurement of Go's work-stealing steal rate, fairness interval, local-queue depth. |
| `ruby-ractor.md` | Ruby Ractor: per-Ractor GVL, message-passing between Ractors | 2020 | Sharp edges: expensive spawn → pool Ractors. Same lesson for Wasmtime `Store`s. |
| `tokio-scheduler.md` | Tokio work-stealing runtime | — | Cooperative-only preemption; 61-task global-queue poll; LIFO reply slot. Shows the exact fairness knobs we can steal for our scheduler. |
| `glommio-thread-per-core.md` | Glommio thread-per-core + per-queue `(Shares, Latency)` | — | No stealing, shared-nothing, io_uring-driven latency ring. The pure-TPC reference. |

## VM runtimes — isolates

| File | Title | Year | Why it matters |
|---|---|---|---|
| `v8-isolate-threading.md` | V8 Isolate docs + startup snapshots | — | One thread per isolate at a time. Snapshots cut cold-start ~40 ms → <2 ms — direct analogue to our Wizer plugin. |
| `cloudflare-workers-isolates.md` | Varda, *Cloud Computing without Containers* + Workers security model **★** | 2018–20 | Thread-per-request entering one isolate; 50 ms CPU cap via Linux timer → `TerminateExecution`; LRU eviction at memory cap; cordons for Spectre defense. Reference for our epoch+deadline choice. |
| `workerd-architecture.md` | Varda, *Introducing workerd* + KJ IoContext | 2022 | Many isolates per process, zero-cost intra-process RPC. Built-in APIs in native code — matches our host-functions-in-Rust approach. |
| `fastly-lucet.md` | Hickey, *Announcing Lucet* | 2019 | <50 µs instantiation per module, few-kB overhead → tens of thousands of programs per process. Sets the empirical ceiling for our throughput target. |
| `chrome-site-isolation-usenix-2019.pdf` | Reis et al., *Site Isolation* (USENIX Security) | 2019 | Process-per-site; heuristic reuse under memory pressure. Reference for the "soft cap + reuse" policy. |
| `chrome-site-isolation.md` | Companion notes | — | Chromium process model supplementary. |

## Wasmtime specifics

| File | Title | Year | Why it matters |
|---|---|---|---|
| `wasmtime-engine-model.md` | `Engine`/`Store`/`InstancePre` thread-safety | — | **Confirms:** one `Engine`, N `Store`s, `InstancePre` is `Send + Sync`, per-thread `Store` is the canonical pattern. |
| `wasmtime-pooling-allocator.md` | `PoolingAllocationConfig` | — | Pool of preallocated linear-memory slots. CoW + affinity → sub-µs reinstantiation. **Must-enable** for our throughput target. |
| `wasmtime-fast-instantiation.md` | Wasmtime fast-instantiation how-to | — | Recipe: pooling + CoW + `InstancePre`. Our Step 2 checklist. |
| `wasmtime-async-model.md` | Async/fiber embedding model | — | 2 MiB per-fiber stack by default. Only needed if host imports are `async`. We're fully sync; skip. |
| `wasm-component-model-threading.md` | WebAssembly threads + component-model threading proposals | — | Component-model threading remains unresolved. Not a blocker — we stay at Preview 1 for now. |
| `javy-plugin-threading.md` | Javy plugin-api `RUNTIME` lifetime | — | `static mut OnceCell<Runtime>` lives **in the WASM linear memory**, so every new `Store` has its own copy. Per-thread isolation is automatic with per-call `Store`. |
| `lunatic-wasm-actors.md` | Lunatic actor runtime on Wasmtime | — | Existence proof: shared Engine + work-stealing Tokio + per-actor Store is the production pattern at scale. |

## Open questions (resolved in the plan)

- **Preemption: fuel, epoch, or both?** → Both. Fuel bounds inner loops; epoch bounds wall-clock (esp. during microtask drain where fuel-per-opcode accounting undercounts).
- **Dispatch: WS, TPC, hybrid?** → Hybrid. Thread-per-core ownership (script-affinity routing) with Chase-Lev per-worker deques + lock-free steal-when-idle fallback.
- **Store pooling?** → Wasmtime pooling allocator (`PoolingAllocationConfig`) engine-wide. Affinity slots give per-script locality for free.
- **Blocking host calls (HTTP, DB)?** → BEAM-style dirty pool. Separate small pool of "I/O workers"; compute workers offload `fetch` / chunked `fs` to them.

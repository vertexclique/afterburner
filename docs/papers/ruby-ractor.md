# Ruby Ractor: CRuby's Parallel Actor Model

Sources:
- Ruby stdlib, class Ractor (Ruby 3.x / master). https://docs.ruby-lang.org/en/master/Ractor.html
- Prateek, "Ruby Ractors: Breaking the GVL for True Parallelism" (2024). https://prateekcodes.com/ruby-ractors-true-parallelism-part-3/
- Koichi Sasada, original Guild/Ractor proposal (2020). https://www.atdot.net/~ko1/activities/2020_ruby3_ractor.pdf

## Model

- Added in Ruby 3.0 (2020). Originally called "Guild". Goal: real parallelism on CRuby without touching the GVL guarantee for legacy code.
- Each Ractor is an **isolated interpreter**: its own heap of mutable objects, its own main thread, its own GVL.
- Isolation is the enforcement mechanism. Ractors cannot reach each other's objects via closure or global. They exchange data only through channels (`send/receive`, `yield/take`).
- Only **shareable objects** cross Ractor boundaries: frozen primitives, modules, `Ractor::SharedObject` instances. Non-shareable sends are *copied* (deep clone) or *moved* (source ractor loses the object).

## Scheduler

- Each Ractor has one main Thread (+ child threads if created). Internally, Ruby threads within a Ractor share that Ractor's GVL.
- CRuby maps Ractors to a thread pool of native OS threads, but each one holds a **per-Ractor GVL**, so N Ractors on N cores execute Ruby bytecode in parallel.
- There is no work stealing across Ractors — workload is driven by user code via channels.
- Preemption inside a single Ractor still uses CRuby's normal thread model (GVL handoff every ~100 ms or on blocking calls); across Ractors it's OS-scheduled.

## Known limitations (2024-era)

- Startup cost per Ractor is high (tens of ms measured in benchmarks); unsuitable for short-lived work. Pooling is recommended.
- Main-Ractor-only ops: `require`, `ENV`, IO streams, many C extensions.
- GC still has synchronization points — ORCA-style per-actor GC was discussed but not shipped.
- Status: "experimental" through 3.4; many gems lack ractor-safe annotations.

## Relevance for Afterburner

- **Isolation-first** is the clearest template for Afterburner: per-thrust stores are already isolated (no shared WASM memory), so a Ractor-style model — pin a `Store<HostState>` to a worker thread, treat thrust invocations as messages — fits cleanly.
- **Start-up cost matters**. Ractor's big weakness is spawning. Afterburner already compiles once per script; we need to reuse stores across invocations to avoid the same fate. Pool warmed-up stores per worker.
- **No shared mutable state** is a feature, not a constraint. Aligns with kovan channel/map/stm model in this workspace.

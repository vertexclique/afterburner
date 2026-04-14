# WebAssembly Threads and Component Model Threading

Sources:
- https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md (threads proposal)
- https://bytecodealliance.org/articles/wasi-threads (wasi-threads)
- https://github.com/WebAssembly/shared-everything-threads (shared-everything-threads)
- https://component-model.bytecodealliance.org/ (component model)

## Core wasm threads proposal (Phase 4)

**What it provides:**
- `shared` linear memory type
- Atomic load/store, RMW (add/sub/and/or/xor/xchg), cmpxchg on 1/2/4/8-byte values
- `memory.atomic.wait32 / wait64` and `memory.atomic.notify`
- All atomics are **sequentially consistent**. Alignment required; misaligned accesses trap.

**What it does NOT provide:**
- Thread spawn / join — "responsibility of creating and joining threads is deferred to the embedder"
- A wasm module cannot, by itself, create another OS thread. That's the host's job.

## wasi-threads

Fills the spawn gap with `wasi_thread_spawn(thread_id)`.

- **Instance-per-thread model:** each spawned thread instantiates a new wasm instance of the same module, sharing only the `shared` linear memory between them.
- Requires `-Wl,--import-memory,--export-memory`.
- Implementations: Wasmtime has `wasmtime-wasi-threads` (the example referenced in multithreaded-embedding.html wraps `InstancePre` in an `Arc` and uses it across threads).

## shared-everything-threads (successor)

Goal: allow threads to share tables, globals, and functions, not just memory. Still in proposal stage; not yet shipped in Wasmtime 36.

## Component model + threads

- The component model's instance-per-component isolation is in tension with the instance-per-thread model of wasi-threads.
- BA is working through "how to express wasi-threads in WIT." No stable answer as of early 2026.
- **WASI 0.3 is targeting native async + cooperative threads** (not preemptive OS threads). Shipping "on the horizon in 2026" per recent BA writeups.

## Implications for Afterburner

- Afterburner's Javy plugin is **not** a multithreaded wasm module (no shared memory, no wasi_thread_spawn). Host-side parallelism via one Engine + many Stores is the correct model.
- There's no need to adopt wasi-threads or shared memory; the parallelism unit is "one thrust = one instance on one OS thread".
- If a future plugin wants intra-plugin threading (e.g. for vectorized JS operations), that's an orthogonal decision that would require `shared_memory(true)` and would break the per-call-fresh-Store design.

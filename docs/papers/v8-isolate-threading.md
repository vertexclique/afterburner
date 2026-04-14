# V8 Isolate Threading Model and Startup Snapshots

**Primary citations:**
- V8 API: `v8::Isolate` — https://v8.github.io/api/head/classv8_1_1Isolate.html
- V8 Blog: Yang Guo, "Custom startup snapshots", 2015 — https://v8.dev/blog/custom-startup-snapshots
- V8 API: `v8::SnapshotCreator` — https://v8.github.io/api/head/classv8_1_1SnapshotCreator.html
- Blink bindings design — https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/renderer/bindings/core/v8/V8BindingDesign.md

---

## 1. Core Concurrency Rule

> "An Isolate can be entered by at most one thread at any given time."

This is V8's fundamental constraint. Within an isolate everything is single-threaded. To get
parallelism an embedder has **two and only two options**:

1. **Different isolates on different threads** — true parallel JS, independent heaps, independent GCs.
2. **One isolate, `v8::Locker`/`Unlocker`** — multiplexed access, only one thread runs JS at a time.

Blink (Chromium's rendering engine) picks option 1: "In Blink, isolates and threads are in 1:1 relationship."

## 2. Isolate = Heap + GC + JIT State

Each isolate owns:
- Its own managed heap.
- Its own garbage collector.
- Its own compiled code caches.
- Its own set of `v8::Context`s (JS "global scopes"; multiple contexts can share one isolate).

Because of this, isolates do not share objects directly — transferring data between isolates
requires serialization (postMessage semantics).

## 3. Startup Snapshots ("Frozen Pizza")

From the V8 blog:

> "Rather than initializing the JavaScript runtime from scratch each time a context is created,
> the engine deserializes a pre-prepared heap snapshot."

Performance deltas:
- Desktop: context creation **40 ms → <2 ms**.
- Mobile: **270 ms → 10 ms**.

Mechanism:
- `v8::V8::CreateSnapshotDataBlob(init_script)` executes the given JS once and captures the heap.
- Consumers pass the blob via `v8::Isolate::CreateParams` at isolate construction.
- Functions, prototypes, and compiled bytecode defined during snapshot capture appear instantly
  in new isolates — no re-parse, no re-execute.

Limits:
- Snapshots cannot capture external (embedder-side) objects or typed-array backing stores.
- Time-dependent values freeze at snapshot time (`Math.random`, `Date.now`).

## 4. Lessons for Afterburner (Wasmtime + Javy QuickJS)

- The V8 "thread per isolate" rule is our design target. QuickJS is also single-threaded inside
  one `JSRuntime`, so the same pattern applies verbatim.
- Afterburner already uses **Wizer** for the same optimization V8's snapshot serves: execute the
  QuickJS init once, freeze the heap, ship the module. The 2 MB preinitialized plugin is the
  analogue of V8's startup blob.
- For a multi-threaded Afterburner we keep **one `wasmtime::Engine` process-wide** (analogous to a
  single JIT cache/code-space in V8's embedder layer) and pay per-thread cost only for `Store` +
  `Instance`, which is where Wizer + CoW memory make instantiation microseconds-cheap.

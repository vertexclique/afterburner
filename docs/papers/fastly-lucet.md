# Fastly Lucet / Compute@Edge: WebAssembly Isolates at the Edge

**Primary citation:** Pat Hickey, "Announcing Lucet: Fastly's native WebAssembly compiler and runtime",
Fastly Blog, March 2019.
URL: https://www.fastly.com/blog/announcing-lucet-fastly-native-webassembly-compiler-runtime

Companion references:
- `bytecodealliance/lucet` GitHub README — https://github.com/bytecodealliance/lucet
- InfoQ coverage — https://www.infoq.com/news/2019/04/fastly-lucet-web-assembly-open/
- "Better Serverless Computing with WebAssembly" talk — https://www.infoq.com/presentations/webassembly-edge-wasi/

**Status note:** Lucet was end-of-lifed; its instantiation engineering was folded into **Wasmtime**.
Anything true of Lucet's instantiation model is now true of modern Wasmtime with the pooling allocator.

---

## 1. Design Goal

> "A major design requirement for Lucet was to be able to execute on every single request that
> Fastly handles."

Per-request isolates — fresh sandbox per HTTP request, destroyed when the response is sent.

## 2. Performance (2019 numbers)

- **Instantiation: <50 µs** per WebAssembly module.
- **Memory overhead: a few kB** per instance.
- Compare: V8 takes **~5 ms and tens of MB** for the same job — roughly **100× faster, 1000× smaller**.
- Enabled **"tens of thousands of WebAssembly programs simultaneously, in the same process."**

## 3. Architecture

- **AOT compilation** via Cranelift (JIT is not allowed per-request at the edge — too slow, wrong threat model).
- Two-part split: a compiler (WASM bytecode → native object file) and a runtime (manages memory, tables, traps).
- Each request: pluck a pre-allocated linear memory + stack slot from a pool, restore snapshotted data via CoW,
  run the Wasm, discard the slot.
- Thread model is **thread-per-core + async poll** — the runtime is embedded inside Fastly's C/Rust HTTP server,
  so one instance per request is mapped onto whatever thread the request landed on.

## 4. Isolation Boundary

- WASM memory isolation (linear memory + bounds-checked loads/stores) is the primary boundary.
- Guard pages + SFI-style bounds checks obviate the need for OS-process isolation per tenant.
- WASI gates syscalls — no ambient filesystem, no ambient network.

## 5. Lessons for Afterburner

Afterburner's stack is essentially *the same stack* as modern Fastly Compute: **Wasmtime + per-request
`Store` + pooling allocator + CoW memory**. The Lucet numbers are therefore directly applicable as
an upper-bound target:

- **<50 µs instantiation** is achievable only if we enable the **pooling allocator** and **CoW memory
  image**. Our current per-call `Store::new()` path is likely doing per-instance `mmap`s and missing both.
- "Tens of thousands of Wasm programs per process" matches our stated throughput goal of
  "tens of thousands of thrusts/sec per box" — the engineering budget has already been demonstrated feasible.
- AOT compile once per content-addressed script (SHA-256 cached) maps perfectly onto Wasmtime's
  `Module::serialize` / `Module::deserialize` with the `ModuleCache` crate.

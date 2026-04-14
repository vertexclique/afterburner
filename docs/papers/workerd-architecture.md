# workerd: Cloudflare's Open-Source Workers Runtime

**Primary citation:** Kenton Varda, "Introducing workerd: the Open Source Workers runtime",
The Cloudflare Blog, 2022-09-27.
URL: https://blog.cloudflare.com/workerd-open-source-workers-runtime/

Companion references:
- `cloudflare/workerd` GitHub — https://github.com/cloudflare/workerd
- InfoQ coverage: "Cloudflare Open-Source Workerd Nanoservice Runtime Now in Beta", 2022 — https://www.infoq.com/news/2022/10/cloudflare-workerd-nanoservices/

---

## 1. Process / Thread Architecture

- **Many workers, one process.** "Many Workers can be configured to run in the same process."
- **Per-worker V8 isolate.** Each worker runs in its own `v8::Isolate`; code in isolate A cannot
  read memory in isolate B even though they share the process.
- **Zero-latency intra-process calls.** "When one Worker explicitly sends a request to another Worker,
  the destination Worker actually runs **in the same thread** with zero latency." This is the
  **nanoservice** model — microservice boundaries at function-call cost.

## 2. Native APIs, Not JS Polyfills

> "Many runtimes implement significant portions of their built-in APIs in JavaScript, which must
> then be loaded separately into each isolate. Workerd does not; all the APIs are implemented in
> native code, so that all isolates may share the same copy of that code."

Consequence: an isolate is almost pure tenant state; the runtime itself costs ~nothing per tenant
beyond a `v8::Isolate` handle + a heap.

## 3. Implementation Substrate

- **C++**, built with Bazel.
- Built on the **KJ** async framework (from Cap'n Proto) — an event loop that predates libuv
  and natively integrates with Cap'n Proto RPC.
- **`IoContext`** ties an isolate to its current in-flight request; guards like
  `requireCurrentOrThrowJs()` enforce that I/O objects stay on the owning thread.
- Fork of V8 with "a couple of patches to customize the isolate abstraction."
- Configuration by **Cap'n Proto schemas** (`workerd.capnp`) rather than flags.

## 4. Delta vs. Cloudflare's Production Runtime

- workerd is the **core** of the production runtime without the edge plumbing.
- Production adds: cordon/process-segregation, LRU eviction across isolates, 50 ms CPU timer,
  Spectre-mitigating patches, kernel seccomp profiles — none of which is shipped in the
  open-source build.
- workerd itself is explicitly **not a hardened sandbox for untrusted code** without
  additional containerization.

## 5. Lessons for Afterburner

- The "many tenants, one process, zero-latency intra-process calls" pattern matches our goal
  directly. `afterburner-flow` → `afterburner-ignite` is conceptually a nanoservice call today;
  keeping it **within the same OS thread** (a single `tokio::task::spawn_blocking` or a
  dedicated isolate worker) preserves that latency win.
- The rule "implement APIs in native code, not JS" matters for us too: every KB of JS shipped
  into QuickJS is paid once *per cached compile* (thanks to Wizer), but any dynamic helpers
  loaded per-call are pure tax. Prefer exposing Rust hostcalls.
- KJ's `IoContext` pattern — "this object is only valid on the owning event-loop thread" —
  is a pattern we already get for free from Rust's `!Send` types. We should codify it:
  a `QuickJsContext` should be `!Send` and pinned to its executor thread.

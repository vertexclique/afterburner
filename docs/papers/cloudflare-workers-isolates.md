# Cloudflare Workers: Isolate-Based Serverless Architecture

**Primary citation:** Kenton Varda, "Cloud Computing without Containers", The Cloudflare Blog, 2018.
URL: https://blog.cloudflare.com/cloud-computing-without-containers/

Companion references fetched:
- "How Workers works" — https://developers.cloudflare.com/workers/reference/how-workers-works/
- "Mitigating Spectre and Other Security Threats: The Cloudflare Workers Security Model" — https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/
- "Security model" docs — https://developers.cloudflare.com/workers/reference/security-model/
- Kenton Varda, "Fine-Grained Sandboxing with V8 Isolates", InfoQ, QCon 2019 — https://www.infoq.com/presentations/cloudflare-v8/

---

## 1. Core Mechanism

Cloudflare Workers uses **V8 Isolates** instead of containers or virtual machines. Isolates are
"lightweight contexts that group variables with the code allowed to mutate them," enabling
hundreds or thousands to run in a single OS process. V8 was originally designed to isolate
tabs in Chrome; Cloudflare re-used that isolation boundary for server-side tenancy.

## 2. Performance

- **Cold start: ~5 ms** for a fresh isolate (vs. "500 ms to 10 seconds" for Lambda).
- **Memory: ~3 MB** per shared-runtime isolate (vs. 35 MB for a basic Node Lambda).
- Eliminates ~100 µs OS context switches between processes; machine "spends virtually all
  of its time running your code."
- Cost benchmark: "3× less per CPU-cycle than Lambda equivalents."

## 3. Threading Model (from Varda's QCon talk)

- **One isolate per thread at a time**. Production starts "a thread for each incoming HTTP
  connection" and an upstream engine "will only send one HTTP request on that connection at
  a time."
- Rationale: *"what we don't want is for one isolate to be able to block another with a long
  computation and create latency for someone else."*
- Multiple isolates coexist in one process to amortize process overhead and avoid duplicating
  the JS runtime per tenant.
- **LRU eviction**: when a process approaches its ~8 GB memory cap, the least-recently-used
  isolate is evicted.

## 4. CPU Time Bounds

- **50 ms CPU per request** on the free tier (raised to 30 s default / 5 min on paid).
- Wall-clock waits for `fetch` / KV / DB do **not** count against CPU time.
- Enforcement uses **Linux timer signals** that trigger V8's `TerminateExecution`, which throws
  an uncatchable exception to halt runaway code.

## 5. Memory Bounds

- Each guest is kept to "a couple megabytes of memory" so thousands of tenants per machine remain possible.
- V8's isolate-heap boundary (a separate garbage collector per isolate) enforces language-level isolation.
- Process-level **"cordons"**: several copies of the full runtime per box segregate workers by trust
  tier (e.g. free-tier customers never share a process with enterprise customers) to contain V8 zero-days.

## 6. Spectre Defenses (thread-scheduling relevance)

- **No multi-threading, no `SharedArrayBuffer`** inside an isolate — removes thread-racing clocks.
- **`Date.now()` and `performance.now()` are frozen during pure CPU execution**; they only advance
  after a completed I/O. This removes the local timer needed for cache-side-channel attacks.
- Workers displaying suspicious timing behavior are **rescheduled into their own dedicated process**
  as dynamic defense-in-depth.
- Daily runtime restarts shuffle memory layout to thwart ASLR-leaking attackers.

## 7. Lessons for an Afterburner (Wasmtime + QuickJS/Javy) design

- A "shared `Engine` + per-thread `Store`" maps 1-to-1 onto Cloudflare's "shared process + per-thread isolate" model.
- A **50 ms epoch deadline per call** is a defensible starting budget; Wasmtime's `epoch_deadline_trap`
  is the direct analogue of Cloudflare's `TerminateExecution` timer signal.
- LRU isolate eviction is only needed if we cache **warm** isolates across calls. For Afterburner's
  per-call `Store` model, eviction reduces to dropping the `Store` at the end of the request.
- Freezing `Date.now` inside the guest is essentially free and worth adopting even if we do not yet
  face Spectre threat models (it is a trivial host-import implementation).

# Chrome Site Isolation: Process-per-Origin Browser Architecture

**Primary citation:** Reis, Moshchuk, and Oskov, "Site Isolation: Process Separation for Web Sites
within the Browser", USENIX Security Symposium, 2019.
Paper PDF: https://www.usenix.org/system/files/sec19-reis.pdf
**Downloaded to:** `/home/vclq/projects/afterburner/docs/papers/chrome-site-isolation-usenix-2019.pdf`

Companion references:
- Chromium design doc — https://www.chromium.org/developers/design-documents/site-isolation/
- Chromium process model — https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md

---

## 1. Model

- One **OS process** per **site** (scheme + eTLD+1). Within a process, all documents are same-site.
- A compromised renderer sees only one origin's data; cross-origin data is filtered at the
  network stack with CORB / ORB before it ever reaches the renderer.
- `SiteInstance` objects bookkeep which documents must coexist (e.g. same-site iframes with
  synchronous scripting access must share a process).

## 2. Trade-offs the Paper Measured

- Memory overhead: **~10–13 %** more RAM per browsing session.
- CPU overhead: measurable but "practical to deploy while sufficiently preserving compatibility."
- Latency overhead from extra IPC is small, dominated by network RTT.
- Process count is **bounded** — on low-RAM Android (<2 GB) Chrome degrades to partial isolation
  rather than unbounded process spawn, using soft limits + heuristic process reuse.

## 3. Why It's Only Indirectly Relevant to Afterburner

This is **process-per-tenant**, not **thread-per-tenant-in-a-shared-process**. It's the
conservative end of the isolation spectrum and the model Cloudflare explicitly *did not* use
(for cost reasons: 10 000 Workers × one process each is infeasible per edge box).

But a few principles carry over:

- **Soft process caps + heuristic reuse** (as Chrome does on Android) is the right failure mode
  when we approach memory limits. Don't spawn unboundedly; reuse isolates by owner/workspace.
- **Cross-boundary data must be sanitized at the boundary, not inside the sandbox.** For us:
  hostcall inputs from WASM must be validated in Rust before being handed to any
  non-sandboxed component, just as CORB filters cross-origin data before it enters the renderer.
- **Compromised-renderer** is Chrome's threat model; **compromised-script** is ours.
  The mitigation shape is the same: a per-tenant boundary (process in Chrome, `Store` + WASM
  linear memory + WASI capability list in Afterburner) plus boundary-enforced IO policy.

## 4. When Process Isolation *Is* Worth Mixing In

Cloudflare runs **cordons** — i.e. a small number of full-runtime processes per box — precisely
to get OS-level Spectre defenses for free *without* paying process-per-tenant cost. This is a
good pattern for Afterburner to adopt once we have threat models that require it: run **N
worker processes, each managing K threads, each thread hosting one isolate at a time**. N
stays small (4–16); K × N is the concurrency ceiling.

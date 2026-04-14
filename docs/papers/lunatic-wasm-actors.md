# Lunatic: Erlang-Inspired Actor Runtime on Wasmtime

Sources:
- https://lunatic.solutions/
- https://github.com/lunatic-solutions/lunatic (README)
- https://dev.to/bkolobara/lunatic-actor-based-webassembly-runtime-for-the-backend-36oj
- https://kolobara.com/lunatic/index.html
- https://serokell.io/blog/lunatic-with-bernard-kolobara
- https://news.ycombinator.com/item?id=26367029 (HN launch)

## Architecture summary

- Each Lunatic **process is a WebAssembly instance** with its own linear memory and stack. "Each instance has its own stack, heap and syscalls, allowing completely isolated execution environments per actor."
- Built on Wasmtime (one Engine shared) + Tokio + a custom stack-switching implementation inspired by `libfringe`.
- Scheduler: **work-stealing async executor** (via Tokio). "All processes running on Lunatic are preemptively scheduled."
- Hundreds of thousands of concurrent processes per box claimed; create/schedule cost dominated by Wasmtime instantiation (which is why they'd benefit from pooling + `InstancePre` caching).

## Supervision

- Erlang-style supervision trees. Processes can monitor and link, restart children on crash with configurable strategies.
- Type system encodes supervisor structure in Rust-based actor definitions.

## What we cannot confirm from public docs

- Their `ARCHITECTURE.md` is literally `# TODO` — there is no formal architecture document.
- Whether they use `InstancePre` caching for hot-path instantiation is not documented; source inspection would confirm.
- Whether they use Wasmtime's pooling allocator or on-demand; not stated publicly.

## Relevant takeaways for Afterburner

- Lunatic **uses a shared Engine + tokio work-stealing executor + async fibers + per-process Stores**. This is effectively the "Option B" async model described in wasmtime-async-model.md.
- Their process granularity is much finer than a single Javy call — they use it for long-lived actors (web servers, pubsub, etc). Afterburner's use case is short-lived compute bursts; a simpler OS-thread pool suffices.
- **Key borrowed idea:** one Engine, workers as pure Send-units, per-task fresh Store, fail-isolate at the Store level (a panicking wasm trap doesn't affect sibling Stores).

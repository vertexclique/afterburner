# Javy Plugin Threading Model

Sources:
- https://github.com/bytecodealliance/javy
- https://github.com/bytecodealliance/javy/blob/main/crates/plugin-api/src/lib.rs (inspected)
- https://github.com/bytecodealliance/javy/blob/main/crates/plugin/src/lib.rs (inspected)
- https://docs.rs/javy/latest/javy/
- https://github.com/quickjs-ng/quickjs/issues/141 (QuickJS multi-thread note)

## The static RUNTIME (quoted verbatim)

From `crates/plugin-api/src/lib.rs`:

```rust
// Allow these in this file because we only run this program single threaded
// and we can safely reason about the accesses to the Javy Runtime. We also
// don't want to introduce overhead from taking unnecessary mutex locks.
#![allow(static_mut_refs)]
...
use std::cell::OnceCell;
...
thread_local! {
    static COMPILE_SRC_RET_AREA: OnceCell<[u32; 2]> = const { OnceCell::new() }
}

static mut RUNTIME: OnceCell<Runtime> = OnceCell::new();
static mut EVENT_LOOP_ENABLED: bool = false;
```

- `RUNTIME` is a `static mut OnceCell<Runtime>` — **not** `thread_local!`.
- `COMPILE_SRC_RET_AREA` **is** `thread_local!` but that's just a scratch return-area buffer used by the compile path.
- The comment explicitly says "we only run this program single threaded" — safety reasoning is that this code runs **inside** a wasm module, where there is exactly one thread of execution per instance.

## initialize_runtime

```rust
pub fn initialize_runtime<F, G>(config: F, modify_runtime: G) -> Result<()>
where
    F: FnOnce() -> Config,
    G: FnOnce(Runtime) -> Runtime,
{
    let config = config();
    let runtime = Runtime::new(config.runtime_config)?;
    let runtime = modify_runtime(runtime);
    unsafe {
        RUNTIME.take();            // allow re-initializing
        RUNTIME.set(runtime).map_err(|_| anyhow!(...))
    }
}
```

- Called once per wasm-module *instance* at startup via the `initialize-runtime` export.
- The plugin's module invokes this during its start function (or on first call).

## QuickJS/rquickjs threading

Upstream QuickJS explicitly: "several runtimes can exist at the same time but they cannot exchange objects, and inside a given runtime, no multi-threading is supported." `rquickjs::Runtime` inherits this constraint — it is `Send` but `!Sync`.

## Implications for Afterburner

**The `RUNTIME` static lives in the wasm module's linear memory, not in host memory.**

1. Every `Store` we instantiate has its **own copy** of the plugin's linear memory, therefore its **own copy** of `RUNTIME` and `EVENT_LOOP_ENABLED`.
2. Multiple host OS threads, each running its own `Store` with its own instance, are **completely isolated** — they each see a private `RUNTIME`.
3. There is **no host-side thread-local treatment needed**. The question "does Javy's static RUNTIME require thread-local treatment?" is answered by the fact that the static doesn't live on the host at all; it lives in wasm memory which is per-instance.
4. The only caveat: if we ever tried to share a `Store` across threads concurrently (we don't, and wasmtime's API forbids it), we'd see data races on `RUNTIME`. As long as we stick to "one Store = one thread at a time," we're safe.

## Wizer-snapshotting a Javy plugin

- `RUNTIME` after `initialize_runtime` is safe to snapshot with Wizer as long as the plugin doesn't hold `externref`s (it doesn't).
- Snapshot becomes the first-call state; every fresh instantiation skips the runtime-init cost and starts with `RUNTIME` already populated as a pre-baked memory image.
- Combined with pooling allocator + affine slots, this can make instantiation near-zero cost per thrust.

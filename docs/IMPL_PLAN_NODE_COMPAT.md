# Implementation Plan: Afterburner Node.js Compatibility Layer

**Project name:** Afterburner Node Compat (codename: **Plenum**)
**Workspace:** `afterburner/afterburner-node-compat/`
**Language:** Rust + JavaScript
**Priority:** High — unlocks `require('fs')`, `require('crypto')`, etc. inside Afterburner scripts
**Status:** Design Complete — Implementation Not Started
**Depends on:** Afterburner v0.1 (Combustor trait, WasmCombustor, NativeCombustor, AdaptiveCombustor, FlowEngine — all implemented, 62 tests passing)

---

## Verified Crate Versions

All API references in this document are verified against published docs.rs documentation.

| Crate | Version | docs.rs | Key dependency |
|-------|---------|---------|----------------|
| `javy-plugin-api` | 6.0.0 | [docs.rs/javy-plugin-api](https://docs.rs/javy-plugin-api/6.0.0) | `javy ^7.0.0-alpha.1` |
| `javy` | 7.0.0 | [docs.rs/javy/7.0.0](https://docs.rs/javy/7.0.0) | `rquickjs ^0.11.0` |
| `javy-codegen` | 3.0.0 | [docs.rs/javy-codegen](https://docs.rs/javy-codegen/3.0.0) | `wasmtime ^36`, `wizer ^10.0.0` |
| `rquickjs` | 0.11.x | [docs.rs/rquickjs](https://docs.rs/rquickjs/latest) | QuickJS-NG bindings |
| `wasmtime` | 28.x | (workspace) | Used by afterburner-wasi |
| Javy CLI | 8.1.1 | [GitHub releases](https://github.com/bytecodealliance/javy/releases) | Supports WASI P1 + P2 plugins |

**Critical version constraint:** `javy-codegen` v3.0.0 depends on `wasmtime ^36`. Afterburner currently uses `wasmtime 28`. These are incompatible — `javy-codegen` **cannot** be used as an in-process library without bumping afterburner's wasmtime to 36+. The current approach of shelling out to the `javy` CLI (which bundles its own wasmtime) remains correct for now.

---

## Naming Convention

| Element | Name | Rationale |
|---------|------|-----------|
| Crate (shared polyfills + host impls) | `afterburner-node-compat` | Node.js API surface, shared by both engine paths |
| Crate (Javy plugin, target=wasm32) | `afterburner-plugin` | Custom Javy plugin with host import declarations |
| JS polyfill bundle | `plenum.js` | "Plenum chamber" — pressurized space where air (Node APIs) meets fuel (user JS) |
| Capability gate | `Manifold` | Intake manifold controls which APIs enter the combustor |
| Build artifact | `plenum_bundle.js` | Single concatenated JS blob, `include_str!`'d into Rust |
| Feature flag (core) | `node-compat` | Cargo feature on `afterburner-core` |
| Feature flag (fs) | `host-fs` | Cargo feature gating filesystem host functions |
| Feature flag (crypto) | `host-crypto` | Cargo feature gating crypto host functions |
| Feature flag (net) | `host-net` | Cargo feature gating outbound HTTP/net host functions |

---

## Problem Statement

Afterburner executes user-supplied JS inside QuickJS (native via rquickjs or sandboxed via Javy/Wasmtime). Currently, `require('fs')` traps with `WasmTrap` or `ReferenceError`. Users writing flow scripts, UDFs, and ETL transforms expect Node.js built-in modules to be available — at minimum `fs`, `path`, `crypto`, `url`, `http`, `buffer`, `events`, `util`, `os`, `querystring`, `assert`, `stream`, and `timers`.

### Why not Edge.js's approach?

| Dimension | Edge.js (NAPI interception) | Afterburner (polyfill + host functions) |
|-----------|---------------------------|---------------------------------------|
| JS engine | V8 or JSC (native) | QuickJS (native or WASM) |
| Sandbox | WASIX syscall interception | WASM memory isolation + fuel metering |
| Native addons (.node) | Supported via NAPI shim | Not supported (pure JS only) |
| Startup | ~50ms (V8 cold) | <1ms (QuickJS native), ~5ms (WASM) |
| Memory per instance | ~30MB (V8 isolate) | <2MB (QuickJS context) |
| Binary size | +30MB (V8) | +210KB (QuickJS native), ~1.3MB (WASM) |
| Density | ~30 instances/GB | ~500 instances/GB |
| Determinism | Non-deterministic (JIT) | Deterministic (interpreter / AOT) |

Afterburner's density and startup advantages are essential for the morsel-driven pipeline (ScramDB UDFs) and high-frequency flow operations (Directus). The polyfill + host function approach preserves these while delivering the Node.js API surface users expect.

### Performance constraint

| Metric | Current | Target with Node compat |
|--------|---------|------------------------|
| Native thrust (no require) | ~50μs | ~50μs (polyfill loaded lazily) |
| Native thrust (require path) | N/A | <60μs (lazy module init) |
| Native thrust (require fs + readFileSync) | N/A | <100μs + I/O time |
| WASM thrust (no require) | ~200μs | ~220μs (polyfill in source, inert if no require) |
| WASM thrust (require path) | N/A | <240μs |
| Ignition overhead (polyfill bundle) | 0 | <2ms native, <5ms WASM (one-time per script) |

**Key design decision: lazy module initialization.** The `require()` resolver is always present (cheap — a single global function). Individual module implementations are only instantiated when first `require`'d. A script that never calls `require` pays near-zero overhead.

---

## Architecture

### Existing data flow (no change)

```
                    ┌────────────────────────────────┐
                    │         afterburner-core        │
                    │  Combustor trait, BurnCache,    │
                    │  FuelGauge, HostContext          │
                    └────────┬───────────┬───────────┘
                             │           │
              ┌──────────────┘           └──────────────┐
              ▼                                         ▼
┌─────────────────────────┐              ┌─────────────────────────┐
│   afterburner-ignite    │              │    afterburner-wasi     │
│   NativeCombustor       │              │    WasmCombustor        │
│   rquickjs FFI          │              │    Wasmtime + Javy      │
│   thread-local Runtime  │              │    WASI preview1        │
└─────────────────────────┘              └─────────────────────────┘
```

### New data flow (with node-compat)

```
                    ┌────────────────────────────────┐
                    │         afterburner-core        │
                    │  + Manifold (capability gate)   │
                    │  + HostContext extended methods  │
                    └────────┬───────────┬───────────┘
                             │           │
              ┌──────────────┘           └──────────────┐
              ▼                                         ▼
┌─────────────────────────┐              ┌─────────────────────────┐
│   afterburner-ignite    │              │    afterburner-wasi     │
│   + register_builtins() │              │    + plenum.js prepend  │
│   + Rust-backed modules │              │      in wrap_user_source│
│     via rquickjs globals│              │    + custom plugin with │
│                         │              │      host WASM imports  │
│  API: Function::new()   │              │      + dynamic linking  │
│  + MutFn + ctx.globals()│              │                         │
└──────────┬──────────────┘              └──────────┬──────────────┘
           │                                        │
           └──────────────┐    ┌────────────────────┘
                          ▼    ▼
               ┌─────────────────────────┐
               │ afterburner-node-compat  │
               │  polyfills/ (pure JS)   │
               │  host_glue/ (JS shims)  │
               │  src/ (Rust host impls) │
               └─────────────────────────┘
```

---

## Module Classification

### Tier 1 — Pure JS (no host functions, no Rust code)

These modules are implemented entirely in JavaScript. They are bundled into `plenum_bundle.js` and work identically on both engine paths.

| Module | Source | Size est. | Notes |
|--------|--------|-----------|-------|
| `path` | `path-browserify` (npm) | ~8KB | Full `path.posix` + `path.win32`. Default to `posix`. |
| `url` | `url` (npm, browserify) | ~12KB | `url.parse`, `url.format`, `url.resolve`. WHATWG `URL` class via QuickJS built-in. |
| `querystring` | `qs` or `querystring-es3` (npm) | ~4KB | `parse`, `stringify`, `escape`, `unescape`. |
| `events` | `events` (npm, browserify) | ~6KB | `EventEmitter` with `on`, `once`, `emit`, `removeListener`, etc. |
| `assert` | `assert` (npm, browserify) | ~10KB | `ok`, `equal`, `deepEqual`, `throws`, `rejects`. |
| `buffer` | `buffer` (feross/buffer, npm) | ~25KB | `Buffer.from`, `Buffer.alloc`, `Buffer.concat`, `toString('hex'/'base64'/'utf8')`. Backed by `Uint8Array`. |
| `util` | custom subset | ~8KB | `format`, `inspect`, `types`, `inherits`, `promisify`, `deprecate`, `TextEncoder`, `TextDecoder`. |
| `stream` | `readable-stream` (npm) | ~30KB | `Readable`, `Writable`, `Transform`, `Duplex`, `PassThrough`, `pipeline`, `finished`. Official Node.js streams polyfill. |
| `string_decoder` | `string_decoder` (npm) | ~3KB | Dependency of `readable-stream`. |
| `punycode` | `punycode` (npm) | ~4KB | `encode`, `decode`, `toASCII`, `toUnicode`. |
| `timers` | custom shim | ~2KB | `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`. |
| `process` | custom shim | ~3KB | `process.env` (backed by `Manifold`), `process.platform`, `process.arch`, `process.version`, `process.cwd()`, `process.exit()`, `process.nextTick()`, `process.hrtime()`. |
| `console` | custom shim | ~2KB | `console.log`, `console.error`, `console.warn`. Maps to `HostContext::log`. |

**Total pure-JS bundle size estimate:** ~117KB unminified, ~45KB minified.

### Tier 2 — Rust-backed via host functions

These modules require OS-level access. The JS side is a thin glue layer that delegates to Rust host functions. Each is gated by a Cargo feature and a `Manifold` capability flag.

| Module | Feature | Manifold field | Key APIs | Notes |
|--------|---------|---------------|----------|-------|
| `fs` | `host-fs` | `fs: FsAccess` | `readFileSync`, `writeFileSync`, `existsSync`, `statSync`, `readdirSync`, `mkdirSync`, `unlinkSync`, `renameSync` | Capability-gated: `None`, `ReadOnly(roots)`, `ReadWrite(roots)` |
| `crypto` | `host-crypto` | `crypto: bool` | `createHash`, `createHmac`, `randomBytes`, `randomUUID`, `timingSafeEqual` | Rust: `sha2` + `hmac` + `getrandom` |
| `http`/`https` | `host-net` | `net: NetAccess` | `http.request`, `http.get` (outbound only) | Maps to existing `HostFunction::HttpRequest`. No `createServer`. |
| `os` | (always on) | N/A | `platform`, `arch`, `hostname`, `tmpdir`, `cpus`, `totalmem`, `freemem` | Partially faked in WASM sandbox. |
| `child_process` | `host-child-process` | `child_process: bool` | `execSync`, `spawnSync` | **Trusted mode only** (afterburner-ignite). WASM always returns `PermissionDenied`. |
| `dns` | `host-net` | `net: NetAccess` | `dns.lookup` (sync shim) | Maps to Rust `std::net::ToSocketAddrs`. |

### Tier 3 — Stub-only (throw on use)

These modules exist in the `require` resolver to give a clear error instead of `Cannot find module`.

`cluster`, `dgram`, `domain`, `http2`, `inspector`, `readline`, `repl`, `v8`, `vm`, `wasi`, `worker_threads`. Also: `net`/`tls` (TCP/TLS sockets — complex, Phase 3). `zlib` — Phase 3 via pako (pure JS).

---

## Capability Gate: `Manifold`

```rust
// afterburner-core/src/manifold.rs

/// Controls which Node.js built-in modules are available to a script.
/// Default: `Manifold::sealed()` — no OS access, pure-JS modules only.
#[derive(Debug, Clone)]
pub struct Manifold {
    pub fs: FsAccess,
    pub net: NetAccess,
    pub crypto: bool,
    pub child_process: bool,
    pub env: EnvAccess,
    pub allow_exit: bool,
}

#[derive(Debug, Clone)]
pub enum FsAccess {
    None,
    ReadOnly(Vec<PathBuf>),
    ReadWrite(Vec<PathBuf>),
}

#[derive(Debug, Clone)]
pub enum NetAccess {
    None,
    OutboundHttp(Option<Vec<String>>),
    OutboundFull(Option<Vec<String>>),
}

#[derive(Debug, Clone)]
pub enum EnvAccess {
    None,
    AllowList(Vec<String>),
    Full,
}

impl Manifold {
    /// Zero capabilities. Safe for untrusted code.
    pub fn sealed() -> Self { /* all None/false */ }

    /// All capabilities. Trusted/admin contexts only.
    pub fn open() -> Self { /* all enabled */ }
}
```

`Manifold` becomes a field on `FuelGauge` behind `#[cfg(feature = "node-compat")]`.

---

## Host Function Protocol

### Native path (afterburner-ignite) — Direct rquickjs globals

The native path registers Rust functions directly into the rquickjs `Context` using the **same rquickjs 0.11 API** that both `afterburner-ignite` and `javy 7.0` share.

**Verified API from docs.rs/javy/7.0.0 and afterburner-ignite source code:**

```rust
// javy 7.0: pub use rquickjs as quickjs;
// javy crate example (verified from docs.rs):
use javy::quickjs::{function::{MutFn, Rest}, Ctx, Function, Value};

// afterburner-ignite already uses this exact pattern in native_engine.rs:
ctx.globals().set(
    "__host_fs_read_file_sync",
    Function::new(
        ctx.clone(),
        MutFn::new(move |ctx: Ctx<'_>, args: Rest<Value<'_>>| {
            let path: String = args.0.first()
                .ok_or_else(|| rquickjs::Error::new_from_js("value", "string"))?
                .get()?;
            // ... call std::fs::read, gated by Manifold ...
        }),
    )?,
)?;
```

This is a zero-overhead path — no serialization, no IPC, direct Rust function call.

**For simpler typed functions (also verified from docs.rs):**

```rust
// rquickjs 0.11 supports automatic type conversion for simple signatures:
use rquickjs::Function;

ctx.globals().set(
    "__host_fs_exists_sync",
    Function::new(ctx.clone(), |path: String| -> bool {
        std::fs::metadata(&path).is_ok()
    })?,
)?;
```

### WASM path (afterburner-wasi) — Two mechanisms

The WASM path is fundamentally constrained: the WASM module can only communicate with the host via its imports/exports. Two mechanisms are available, with different tradeoffs.

#### Mechanism A: Custom Javy plugin with `extern "C"` host imports (dynamic linking)

**How it works:**

1. Build `afterburner-plugin` crate targeting `wasm32-wasip1`
2. The plugin declares `#[link(wasm_import_module = "afterburner:host")] extern "C" { ... }` imports
3. In `modify_runtime`, register JS globals that call these imports via `Func::from`
4. Use `javy build -C dynamic=y -C plugin=plugin.wasm` to produce ~500B stub modules
5. At runtime, Wasmtime instantiates both plugin + stub, satisfying all imports

**Verified `javy-plugin-api` v6.0.0 API (from docs.rs):**

```rust
// afterburner-plugin/src/lib.rs
// Target: wasm32-wasip1

use javy_plugin_api::{
    import_namespace,
    javy::{quickjs::prelude::Func, Runtime},
    Config,
};

import_namespace!("afterburner-plugin-v1");

#[link(wasm_import_module = "afterburner:host")]
extern "C" {
    fn host_fs_read_file_sync(
        path_ptr: *const u8, path_len: u32,
        out_ptr: *mut u8, out_cap: u32,
    ) -> i32;
    fn host_fs_exists_sync(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_crypto_random_bytes(out_ptr: *mut u8, len: u32) -> i32;
    // ... remaining host functions ...
}

fn config() -> Config {
    let mut config = Config::default();
    config
        .text_encoding(true)     // TextEncoder/TextDecoder for plenum.js
        .javy_stream_io(true)    // Javy.IO.readSync/writeSync for I/O envelope
        .json(true);             // Native JSON support
    config
}

fn modify_runtime(runtime: Runtime) -> Runtime {
    runtime.context().with(|ctx| {
        let globals = ctx.globals();

        // Register host-backed JS globals using Func::from
        // (verified from javy-plugin-api docs: WASI P1 example)
        globals.set("__host_fs_exists_sync", Func::from(|path: String| -> bool {
            let bytes = path.as_bytes();
            unsafe { host_fs_exists_sync(bytes.as_ptr(), bytes.len() as u32) == 1 }
        })).unwrap();

        // For functions returning data, use manual buffer management:
        globals.set("__host_fs_read_file_sync", Func::from(|path: String| -> String {
            let bytes = path.as_bytes();
            let mut buf = vec![0u8; 1024 * 1024];
            let len = unsafe {
                host_fs_read_file_sync(
                    bytes.as_ptr(), bytes.len() as u32,
                    buf.as_mut_ptr(), buf.len() as u32,
                )
            };
            if len < 0 { panic!("fs read error: {}", len); }
            String::from_utf8_lossy(&buf[..len as usize]).into_owned()
        })).unwrap();

        // Evaluate plenum.js polyfill bundle
        ctx.eval_with_options(
            include_str!("../../afterburner-node-compat/generated/plenum_bundle.js"),
            Default::default(),
        ).unwrap();
    });
    runtime
}

// Verified API: initialize_runtime(F, G) -> Result<()>
// where F: FnOnce() -> Config, G: FnOnce(Runtime) -> Runtime
#[export_name = "initialize-runtime"]
fn initialize_runtime() {
    javy_plugin_api::initialize_runtime(config, modify_runtime).unwrap()
}
```

**Critical constraint: Wizer pre-initialization.**

`javy init-plugin` runs Wizer to snapshot the QuickJS runtime state after `initialize-runtime` executes. Wizer instantiates the WASM module, which means **all imports must be satisfied**. WASI imports are provided by Wizer's built-in stubs. BUT: custom imports from `afterburner:host` are **NOT** provided by Wizer.

**Consequence:** If the plugin declares `extern "C"` imports from `afterburner:host`, `javy init-plugin` **fails**.

**Two solutions:**

**Solution 1 — Skip Wizer:** Don't run `javy init-plugin`. Use the plugin binary directly without pre-initialization. Cost: QuickJS runtime init + polyfill eval happens at first `_start` execution instead of being baked into the snapshot. Overhead: ~2-5ms per first instantiation of a unique script. This cost is paid once and amortized by `BurnCache`'s `HopscotchMap<[u8;32], Module>` cache — subsequent `thrust()` calls incur zero overhead.

```bash
# Build the plugin (no Wizer)
cargo build -p afterburner-plugin --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/afterburner_plugin.wasm quickjs-provider/plugin.wasm

# Compile user scripts with dynamic linking
javy build user.js -C dynamic=y -C plugin=quickjs-provider/plugin.wasm -o stub.wasm
```

**Solution 2 — Two-tier plugins:** Build two plugin variants:
- `plugin-pure.wasm` — Wizer pre-initialized, pure-JS polyfills only, no `extern "C"` imports. Used for scripts that don't need host modules.
- `plugin-host.wasm` — NOT Wizer pre-initialized, includes `extern "C"` imports. Used for scripts that need fs/crypto/http.

The `Manifold` determines which plugin to use at `ignite()` time. Scripts with `Manifold::sealed()` (no host access) use the fast Wizer-initialized plugin. Scripts with host capabilities use the slower plugin.

**Decision: Solution 1 for simplicity.** The ~2-5ms first-instantiation overhead is acceptable because it's a one-time cost per unique script, amortized by the content-addressed cache. BurnCache already handles this pattern (first call compiles, subsequent calls are cache hits). Adding a second plugin variant doubles the maintenance surface for a marginal optimization.

**Host-side linker registration (Wasmtime):**

```rust
// afterburner-wasi/src/wasm_engine.rs — register afterburner:host imports

fn register_host_imports(linker: &mut Linker<HostState>) -> Result<()> {
    linker.func_wrap(
        "afterburner:host",
        "host_fs_read_file_sync",
        |mut caller: Caller<'_, HostState>,
         path_ptr: i32, path_len: i32,
         out_ptr: i32, out_cap: i32| -> i32 {
            let memory = caller.get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("memory export");
            let data = memory.data(&caller);
            let path = std::str::from_utf8(
                &data[path_ptr as usize..(path_ptr + path_len) as usize]
            ).unwrap_or("");

            let manifold = &caller.data().manifold;
            match fs_host::read_file_sync(path, manifold) {
                Ok(bytes) => {
                    let len = bytes.len().min(out_cap as usize);
                    memory.data_mut(&mut caller)
                        [out_ptr as usize..(out_ptr as usize + len)]
                        .copy_from_slice(&bytes[..len]);
                    len as i32
                }
                Err(FsError::PermissionDenied) => -1,
                Err(FsError::NotFound) => -2,
                Err(_) => -3,
            }
        },
    )?;
    // ... remaining host functions ...
    Ok(())
}
```

**Required changes to WasmCombustor::thrust:**

Current code creates a new `Linker` per thrust and only registers WASI. Must change to also register `afterburner:host` imports AND load the plugin module alongside the stub:

```rust
// In thrust(), after WASI linker setup:
#[cfg(feature = "node-compat")]
register_host_imports(&mut linker)?;

// For dynamic linking: instantiate plugin first, then stub
let plugin_instance = linker.instantiate(&mut store, &self.plugin_module)?;
// Plugin exports (memory, functions) become available as imports for the stub
// ... link plugin exports to stub imports via linker ...
let stub_instance = linker.instantiate(&mut store, &stub_module)?;
```

**Required changes to compiler.rs:**

Switch from static to dynamic linking when `node-compat` is enabled:

```rust
// Current: javy build user.js -o stub.wasm (static, ~1.3MB)
// New:     javy build user.js -C dynamic=y -C plugin=plugin.wasm -o stub.wasm (~500B)
let output = Command::new(javy_binary)
    .arg("build")
    .arg(&in_path)
    .arg("-C").arg("dynamic=y")
    .arg("-C").arg(format!("plugin={}", self.plugin_path.display()))
    .arg("-o").arg(&out_path)
    .output()?;
```

#### Mechanism B: Polyfill-only prepend (no custom plugin, no host functions)

For scripts that only need pure-JS modules (path, url, buffer, events, etc.), the existing static-linking approach works. The polyfill bundle is prepended in `wrap_user_source()`:

```rust
fn wrap_user_source(user: &str) -> String {
    format!(
        r#"
        {plenum_bundle}

        // ... existing I/O envelope unchanged ...
        "#,
        plenum_bundle = PLENUM_BUNDLE,
    )
}
```

No plugin changes needed. No Wasmtime linker changes needed. Works today.

---

## Changes to Existing Code

### 1. `afterburner-core` changes

**New file `src/manifold.rs`:** `Manifold`, `FsAccess`, `NetAccess`, `EnvAccess` types.

**`src/types.rs`:** Add `manifold: Manifold` to `FuelGauge` behind `#[cfg(feature = "node-compat")]`.

**`src/host.rs`:** Extend `HostContext` trait:

```rust
// New methods (all cfg-gated, default to error)
#[cfg(feature = "host-fs")]
fn fs_read_file_sync(&self, path: &str) -> Result<Vec<u8>>;
fn fs_write_file_sync(&self, path: &str, data: &[u8]) -> Result<()>;
fn fs_exists_sync(&self, path: &str) -> bool;
fn fs_stat_sync(&self, path: &str) -> Result<FsStat>;
fn fs_readdir_sync(&self, path: &str) -> Result<Vec<String>>;
fn fs_mkdir_sync(&self, path: &str, recursive: bool) -> Result<()>;
fn fs_unlink_sync(&self, path: &str) -> Result<()>;

#[cfg(feature = "host-crypto")]
fn crypto_hash(&self, algorithm: &str, data: &[u8]) -> Result<Vec<u8>>;
fn crypto_hmac(&self, algorithm: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>>;
fn crypto_random_bytes(&self, length: usize) -> Result<Vec<u8>>;
```

**`src/error.rs`:** Add `PermissionDenied(String)` variant.

### 2. `afterburner-ignite` changes

**`src/native_engine.rs`:** Modify `run_script()` to register polyfills and host globals:

```rust
fn run_script(ctx: &Ctx<'_>, source: &str, input_json: &str) -> Result<String> {
    #[cfg(feature = "node-compat")]
    {
        // Register host-backed globals (gated by manifold)
        afterburner_node_compat::register_native_builtins(ctx, &manifold)?;

        // Evaluate plenum.js (require resolver + pure-JS modules)
        // Uses rquickjs eval — same API as existing ctx.eval()
        ctx.eval::<(), _>(
            afterburner_node_compat::PLENUM_BUNDLE.as_bytes()
        ).map_err(map_rquickjs_err)?;
    }

    // ... existing IIFE envelope unchanged ...
}
```

**Performance note:** The plenum bundle evaluation happens per-thread (thread-local `ThreadRuntime`). First thrust on each thread pays ~1ms; subsequent thrusts pay zero because the QuickJS context retains the evaluated state.

### 3. `afterburner-wasi` changes

**Phase 1 (pure-JS only):** Prepend `plenum_bundle.js` in `wrap_user_source()`. No linker changes. No plugin changes. Static linking continues to work.

**Phase 2 (host functions):** Switch to dynamic linking with custom plugin. Register `afterburner:host` imports in linker. Load plugin module + stub module together. Pass `Manifold` via input envelope:

```rust
// afterburner-wasi/src/intake.rs
pub fn serialize_input_with_manifold(input: &Value, manifold: &Manifold) -> Result<Vec<u8>> {
    let envelope = json!({
        "__ab_input": input,
        "__ab_manifold": manifold,
    });
    serde_json::to_vec(&envelope).map_err(AfterburnerError::Serialize)
}
```

**`src/host.rs`:** Add `manifold: Manifold` field to `HostState`.

### 4. `afterburner-adaptive` / `afterburner-flow`

No structural changes. Manifold propagated via `FuelGauge`. `FlowEngine::new()` defaults to `Manifold::sealed()`.

---

## The `plenum.js` Bundle

### Build process

```rust
// afterburner-node-compat/build.rs
fn main() {
    println!("cargo:rerun-if-changed=polyfills/");
    let status = Command::new("npx")
        .args(["esbuild", "polyfills/entry.js", "--bundle", "--format=iife",
               "--global-name=__plenum", "--minify", "--target=es2020",
               "--outfile=generated/plenum_bundle.js"])
        .status().expect("esbuild failed");
    assert!(status.success());
}
```

```rust
// afterburner-node-compat/src/bundle.rs
pub const PLENUM_BUNDLE: &str = include_str!("../generated/plenum_bundle.js");
```

### `require()` resolver

```javascript
(function() {
    var __factories = {};
    var __cache = {};

    globalThis.__register_module = function(name, factory) {
        __factories[name] = factory;
    };

    globalThis.require = function(name) {
        var mod = name.replace(/^node:/, '');
        if (__cache[mod]) return __cache[mod];
        if (__factories[mod]) {
            var m = { exports: {} };
            __factories[mod](m, m.exports, require);
            __cache[mod] = m.exports;
            return m.exports;
        }
        throw new Error("Cannot find module '" + name + "'");
    };

    globalThis.__register_host_module = function(name, obj) {
        __cache[name] = obj;
    };
})();
```

### Host-backed glue (FS example)

```javascript
__register_module('fs', function(module, exports, require) {
    exports.readFileSync = function(path, options) {
        if (typeof __host_fs_read_file_sync !== 'function') {
            throw new Error('Permission denied: fs not available');
        }
        var encoding = typeof options === 'string' ? options
            : (options && options.encoding) || 'utf8';
        return __host_fs_read_file_sync(String(path), encoding);
    };

    exports.existsSync = function(path) {
        if (typeof __host_fs_exists_sync !== 'function') return false;
        return __host_fs_exists_sync(String(path));
    };

    // ... remaining methods ...

    // fs.promises wraps sync methods in Promise
    exports.promises = {};
    ['readFile','writeFile','stat','readdir','mkdir','unlink'].forEach(function(n) {
        exports.promises[n] = function() {
            var args = [].slice.call(arguments);
            return new Promise(function(resolve, reject) {
                try { resolve(exports[n + 'Sync'].apply(null, args)); }
                catch (e) { reject(e); }
            });
        };
    });
});
```

---

## Workspace Layout

```
afterburner/
├── Cargo.toml                         # Add new members

├── afterburner-core/
│   ├── src/
│   │   ├── manifold.rs                # NEW
│   │   ├── host.rs                    # MODIFIED — extended HostContext
│   │   ├── types.rs                   # MODIFIED — manifold on FuelGauge
│   │   ├── error.rs                   # MODIFIED — PermissionDenied
│   │   └── ...
│   └── Cargo.toml                     # MODIFIED — feature flags

├── afterburner-node-compat/           # NEW CRATE
│   ├── Cargo.toml
│   ├── build.rs                       # esbuild bundler
│   ├── package.json                   # devDependencies for polyfills
│   ├── src/
│   │   ├── lib.rs                     # PLENUM_BUNDLE + register_native_builtins()
│   │   ├── fs_host.rs                 # Rust impl: read_file_sync etc.
│   │   ├── crypto_host.rs            # Rust impl: hash, hmac, random_bytes
│   │   ├── http_host.rs              # Rust impl: outbound HTTP
│   │   ├── os_host.rs                # Rust impl: platform, arch, etc.
│   │   └── bundle.rs                 # include_str! of generated bundle
│   ├── polyfills/                     # Pure-JS polyfill sources
│   │   ├── entry.js, require.js, path.js, url.js, buffer.js,
│   │   │   events.js, util.js, assert.js, querystring.js,
│   │   │   stream.js, string_decoder.js, punycode.js,
│   │   │   timers.js, process_shim.js, console_shim.js
│   │   └── ...
│   ├── host_glue/                     # JS wrappers for __host_* globals
│   │   ├── fs_glue.js, crypto_glue.js, http_glue.js, os_glue.js
│   │   └── ...
│   └── generated/
│       └── plenum_bundle.js           # gitignored, built by build.rs

├── afterburner-plugin/                # NEW CRATE (Phase 2, target=wasm32-wasip1)
│   ├── Cargo.toml                     # javy-plugin-api = "6", javy = "7"
│   └── src/
│       └── lib.rs                     # import_namespace! + extern "C" + modify_runtime

├── afterburner-ignite/
│   └── src/native_engine.rs           # MODIFIED — register_builtins + plenum init

├── afterburner-wasi/
│   ├── src/
│   │   ├── wasm_engine.rs             # MODIFIED — Phase 1: plenum prepend; Phase 2: host imports
│   │   ├── compiler.rs                # MODIFIED — Phase 2: dynamic linking flag
│   │   ├── intake.rs                  # MODIFIED — manifold envelope
│   │   └── host.rs                    # MODIFIED — manifold field
│   └── Cargo.toml

├── afterburner-flow/                  # MODIFIED — manifold parameter
├── afterburner-adaptive/              # No changes
└── quickjs-provider/
    └── plugin.wasm                    # Phase 2: replaced with custom afterburner-plugin build
```

---

## Dependencies

### New Rust crates

| Crate | Version | Purpose | Used in |
|-------|---------|---------|---------|
| `javy-plugin-api` | 6.0 | Custom plugin API: `import_namespace!`, `initialize_runtime` | `afterburner-plugin` |
| `javy` | 7.x | Re-exports `rquickjs 0.11` for plugin-side QuickJS access | `afterburner-plugin` |
| `sha2` | 0.10 | Already in workspace. SHA-256/384/512 for crypto. | `crypto_host.rs` |
| `hmac` | 0.12 | HMAC for `crypto.createHmac`. | `crypto_host.rs` |
| `md-5` | 0.10 | MD5 for `crypto.createHash('md5')`. | `crypto_host.rs` |
| `getrandom` | 0.2 | `crypto.randomBytes`. | `crypto_host.rs` |
| `base64` | 0.22 | Buffer encoding. | `fs_host.rs` |
| `hex` | 0.4 | Buffer encoding. | `crypto_host.rs` |
| `uuid` | 1.x | `crypto.randomUUID`. | `crypto_host.rs` |

### New npm devDependencies (build-time only)

| Package | Version | Purpose |
|---------|---------|---------|
| `esbuild` | ^0.24 | Bundle polyfills into single IIFE |
| `path-browserify` | ^1.0 | `path` polyfill |
| `buffer` | ^6.0 | `buffer` polyfill (feross) |
| `events` | ^3.3 | `events` polyfill |
| `readable-stream` | ^4.x | `stream` polyfill |
| `string_decoder` | ^1.3 | `string_decoder` polyfill |
| `querystring-es3` | ^0.2 | `querystring` polyfill |
| `assert` | ^2.1 | `assert` polyfill |
| `punycode` | ^2.3 | `punycode` polyfill |
| `url` | ^0.11 | `url` polyfill |

---

## Timeline

| Phase | Step | Description | Crate(s) | Effort | Depends |
|-------|------|-------------|----------|--------|---------|
| **1** | 0 | `Manifold` type + `FuelGauge` integration + `PermissionDenied` error | `core` | 0.5d | — |
| | 1 | `require()` resolver + entry.js scaffold | `node-compat` | 1d | 0 |
| | 2 | Pure-JS polyfills: path, url, querystring, events, assert, buffer, util | `node-compat` | 2d | 1 |
| | 3 | Pure-JS polyfills: stream, string_decoder, punycode, timers, process, console | `node-compat` | 1.5d | 1 |
| | 4 | esbuild `build.rs` pipeline + `PLENUM_BUNDLE` constant | `node-compat` | 0.5d | 2 |
| | 5 | Native engine: `register_native_builtins()` + plenum eval in `run_script()` | `ignite` | 1d | 4 |
| | 6 | WASM engine: prepend `plenum_bundle.js` in `wrap_user_source()` (static linking, pure-JS only) | `wasi` | 1d | 4 |
| | 7 | Tests: pure-JS modules on both native and WASM paths | tests/ | 1d | 5, 6 |
| | | **Phase 1 total** | | **7.5d** | |
| **2** | 8 | `crypto_host.rs`: hash, hmac, randomBytes, randomUUID, timingSafeEqual | `node-compat` | 1d | 7 |
| | 9 | `fs_host.rs`: readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, unlinkSync | `node-compat` | 2d | 7 |
| | 10 | FS path validation: symlink resolution, root-jail, `Manifold::fs` enforcement | `node-compat` | 1d | 9 |
| | 11 | `os_host.rs` + `http_host.rs` | `node-compat` | 1d | 7 |
| | 12 | Native engine: register host-backed globals (fs, crypto, os, http) | `ignite` | 1d | 8-11 |
| | 13 | `afterburner-plugin` crate: `javy-plugin-api` 6.0 WASI P1 plugin with `extern "C"` host imports + `modify_runtime` + polyfill eval | `plugin` | 2d | 4, 8-11 |
| | 14 | WASM engine: switch to dynamic linking, register `afterburner:host` in Wasmtime linker, plugin + stub dual instantiation | `wasi` | 2.5d | 13 |
| | 15 | Tests: host-backed modules, manifold enforcement, security, WASM + native parity | tests/ | 1.5d | 12, 14 |
| | | **Phase 2 total** | | **12d** | |
| **3** | 16 | WASI P2 WIT migration: `afterburner-host.wit` typed interfaces, `javy_plugin!` macro, `wit_bindgen::generate!` | `plugin`, `wasi` | 3d | 15 |
| | 17 | `child_process_host.rs`: execSync, spawnSync (native path only) | `node-compat` | 1d | 15 |
| | 18 | `dns_host.rs`: dns.lookup sync shim | `node-compat` | 0.5d | 15 |
| | 19 | `zlib` polyfill via pako (pure JS) | `node-compat` | 1d | 4 |
| | 20 | Async wrappers: fs.promises, callback-style APIs | `node-compat` | 1d | 15 |
| | 21 | FlowEngine + AdaptiveCombustor E2E integration tests | `flow`, `adaptive` | 1d | 15 |
| | 22 | Performance benchmarks + wasmtime 36 upgrade evaluation (for javy-codegen library usage) | bench/ | 1d | all |
| | | **Phase 3 total** | | **8.5d** | |
| | | **Grand total** | | **28d** | |

---

## Expected Results

| Metric | Target |
|--------|--------|
| `require('path').join('a','b')` | Works on both paths |
| `require('fs').readFileSync('/data/x.json')` | Works when `Manifold.fs != None` |
| `require('crypto').createHash('sha256').update('x').digest('hex')` | Works when `Manifold.crypto == true` |
| `require('http').get(url, cb)` | Works when `Manifold.net != None` (outbound only) |
| `require('fs')` with `Manifold::sealed()` | Throws `PermissionDenied` |
| Thrust overhead (no require, native) | <5% regression |
| Thrust overhead (no require, WASM) | <10% regression (polyfill prepended but inert) |
| Thrust overhead (require path, native) | <10μs additional |
| Thrust overhead (require fs + host call, native) | <5μs additional + I/O |
| Thrust overhead (require fs + host call, WASM) | ~10-20μs additional + I/O (extern "C" call + memory copy) |
| First-instantiation overhead (WASM, no Wizer) | ~2-5ms (QuickJS init + polyfill eval, one-time per unique script) |
| Bundle size (plenum.js minified) | <50KB |
| Node.js API coverage | 13 Tier 1 + 6 Tier 2 = 19 modules |
| Backward compatibility | 100% — scripts without `require` unchanged |

---

## Security Considerations

| Threat | Mitigation |
|--------|------------|
| Path traversal via `fs.readFileSync('../../../etc/passwd')` | `fs_host.rs` resolves symlinks via `std::fs::canonicalize` and validates canonical path is within `Manifold.fs` roots. |
| Environment variable leak | `process.env` filtered by `Manifold.env`. `EnvAccess::None` returns empty object. |
| SSRF via `http.request` | `NetAccess::OutboundHttp(Some(allowlist))` restricts to listed domains. |
| Sandbox escape via `child_process` | Only available when `Manifold.child_process == true`. WASM path always rejects. |
| Polyfill prototype pollution | `require()` uses private closure scope. Module cache prevents post-require mutation. |
| Timing side-channel via `crypto` | Delegate to `sha2`/`hmac` crates (constant-time implementations). |
| WASM memory out-of-bounds in host functions | All pointer arithmetic in linker closures validated against `memory.data_size()` before access. |

---

## Open Questions / Future Work

1. **TypeScript support** — SWC transpile step before `ignite()`. Orthogonal to node-compat.
2. **npm module resolution** — `require('./local-file')` and `require('third-party-package')`. Requires bundler step at script-upload time.
3. **Worker threads** — Not possible with QuickJS single-threaded model.
4. **Native addons (.node files)** — Not possible without V8/NAPI. Hard boundary. Document clearly.
5. **WASI Preview 2 WIT migration** — Phase 3. Javy v8.1.1 supports P2 via `javy_plugin!` macro + `wit_bindgen::generate!`. Typed WIT interfaces replace raw `extern "C"` pointer arithmetic. The `extern "C"` approach works today; WIT is additive and non-breaking.
6. **wasmtime version bump to 36+** — Required for `javy-codegen` as library (eliminates CLI shelling). Evaluate in Phase 3 benchmarks.
7. **Wizer support for custom imports** — If Wizer gains the ability to provide no-op stubs for arbitrary import modules, we can Wizer-initialize the host-backed plugin and eliminate the ~2-5ms first-instantiation overhead. Track Wizer releases.
8. **Streaming transforms with `fs.createReadStream`** — Requires `stream` polyfill + incremental FS host functions. Phase 3+.

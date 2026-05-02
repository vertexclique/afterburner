<p align="center">
  <img src="https://raw.githubusercontent.com/vertexclique/afterburner/main/art/png/afterburner-bg-2000x500.png" alt="Afterburner" width="100%"/>
</p>

<p align="center">
  <strong>A sandboxed JavaScript VM for Rust. Execute untrusted scripts with memory limits, timeouts, capability-gated I/O, and threading.</strong>
</p>

<p align="center">
  <a href="https://crates.io/crates/afterburner-core"><img src="https://img.shields.io/crates/v/afterburner-core?style=flat-square&color=e6832e" alt="crates.io"/></a>
  <a href="https://docs.rs/afterburner-core"><img src="https://img.shields.io/docsrs/afterburner-core?style=flat-square&color=2a9d8f" alt="docs.rs"/></a>
  <img src="https://img.shields.io/badge/rust-1.90%2B_(2024_ed)-blue?style=flat-square&logo=rust&logoColor=white" alt="MSRV"/>
  <img src="https://img.shields.io/badge/license-MIT%2FApache--2.0-green?style=flat-square" alt="License"/>
</p>

---

Afterburner lets you load, execute, and unload JavaScript from Rust with hard resource limits and fine-grained permission controls. Node.js built-ins — `fs`, `crypto`, `http`, `zlib`, `child_process`, and more — are available but locked behind capability gates you configure per-script.

## Library usage

```toml
[dependencies]
afterburner = "0.1"
```

```rust
use afterburner::Afterburner;
use serde_json::json;

let ab = Afterburner::new()?;
let id = ab.register("module.exports = (d) => d.n + 1")?;
let out = ab.run(&id, &json!({ "n": 41 }))?;
assert_eq!(out, json!(42));
```

The default picks the best mode available (`adaptive` → native on the first call, WASM-sandboxed on the second). Use `Afterburner::builder()` for mode + limits + capabilities:

```rust
use afterburner::{Afterburner, Manifold, FsAccess};

let ab = Afterburner::builder()
    .fuel(1_000_000_000)
    .memory_bytes(64 << 20)
    .timeout_ms(30_000)
    .manifold(Manifold {
        fs: FsAccess::ReadWrite(vec!["/var/data".into()]),
        ..Manifold::sealed()
    })
    .threaded(8)  // 8-worker scheduler; hash-routed with steal-when-idle
    .build()?;
```

## `burn` — the command-line runtime

```bash
cargo install afterburner --features bin   # installs the `burn` binary
burn ./script.js                           # run a file
burn -e 'module.exports = () => 42'        # eval inline
echo '{"n":21}' | burn thrust transform.js # UDF mode (stdin → JSON)
burn bench perf.js --iters 10000 --workers 8
burn repl                                  # interactive
```

Deno-style capability grants (deny by default):

```bash
burn --allow-net=api.example.com,*.trusted.io script.js
burn --allow-fs=/tmp,/var/data etl.js
burn --allow-env=HOME,PATH launcher.js
burn -A runall.js                          # grant everything
```

See [`examples/`](./examples/) for standalone projects covering: single
UDF, batched UDF, multi-worker scheduling, streaming crypto,
`HostContext` + capability grants, rebuilding `burn` in 30 lines, and a
**full axum HTTP server dispatching Express-style handlers to
Afterburner** (`examples/express-app`).

---

## Workspace Crates

| Crate | Purpose |
|:------|:--------|
| **`afterburner`**              | Facade: `Afterburner` + builder, `burn` binary, one ergonomic entry point |
| **`afterburner-core`**         | `Combustor` trait, `Manifold`, `FuelGauge`, `BurnCache`, level-gated logging |
| **`afterburner-ignite`**       | Native QuickJS via `rquickjs`, thread-local runtimes |
| **`afterburner-wasi`**         | Wasmtime + Javy plugin sandbox with host-function imports, pooling allocator + InstancePre, bytecode cache |
| **`afterburner-node-compat`**  | `plenum.js` polyfill bundle + Rust-backed host impls (incl. bounded HTTP + DNS with per-call timeouts) |
| **`afterburner-flow`**         | High-level `FlowEngine::load/execute/unload` for flow-style pipelines |
| **`afterburner-adaptive`**     | Flying Start: native → WASM tier switch |
| **`afterburner-thrust`**       | Multi-threaded scheduler: bounded per-worker queues + global injector, token-bucket admission, NUMA-aware steal-when-idle, graceful drain |
| **`afterburner-plugin`**       | WASM-side Javy plugin (`wasm32-wasip1`) |

---

## Requirements

### Runtime

Nothing external is needed at runtime. The Javy plugin is committed as a
Wizer-preinitialized `.wasm` at
`quickjs-provider/afterburner_plugin.wasm` and pulled in via
`include_bytes!`. Consumers just depend on the afterburner crates.

### Build (default workspace)

| Tool | Version | Notes |
|:-----|:--------|:------|
| Rust | 1.90+ (2024 ed) | `rustup install stable` on most systems |
| Cargo | shipped with Rust | `cargo build` / `cargo test` work unmodified |
| libclang | any recent | required by `rquickjs-sys` bindgen |
| C compiler | any recent | required by `rquickjs-sys` / QuickJS |

### Build (plugin regeneration — optional)

Only needed when changing plugin Rust code, the WIT interface, or the
plenum polyfill bundle. The committed `.wasm` is otherwise authoritative.

| Tool | Version | How to get it |
|:-----|:--------|:--------------|
| `wasm32-wasip1` | via rustup | `rustup target add wasm32-wasip1` |
| `javy` CLI | 8.1.1+ | `cargo install javy-cli` or [releases](https://github.com/bytecodealliance/javy/releases) |
| Node bundler | not required | Plenum bundle is produced by a pure-Rust `build.rs` (concat + include_str!) |

Regenerate the plugin:

```bash
# 1. Rebuild the plenum bundle from polyfills/ (sets AFTERBURNER_REBUILD_PLENUM=1)
AFTERBURNER_REBUILD_PLENUM=1 cargo build -p afterburner-node-compat

# 2. Compile + Wizer-preinit the plugin.
#    `javy init-plugin` is required because Javy runtime state has to be
#    frozen into the binary before host imports are satisfiable.
cd afterburner-plugin
./build.sh     # writes to ../quickjs-provider/afterburner_plugin.wasm
```

---

## Runbook

| Command | What it does |
|:--------|:-------------|
| `cargo build` | Builds the six host crates (skips the plugin). |
| `cargo test --workspace --exclude afterburner-plugin` | Runs the full 252-test suite. |
| `cargo clippy --workspace --exclude afterburner-plugin --all-targets` | Linter check. |
| `cargo test -p afterburner-ignite --release perf_smoke` | Native throughput smoke. |
| `cargo test -p afterburner-wasi --release perf_smoke` | WASM throughput smoke. |
| `afterburner-plugin/build.sh` | Rebuild + Wizer-preinit the plugin. |

---

## Environment Variables

| Variable | Default | Purpose |
|:---------|:--------|:--------|
| `AFTERBURNER_LOG` | `warn` | Level filter: `off` / `error` / `warn` / `info` / `debug` / `trace` |
| `AFTERBURNER_LOG_FORMAT` | `text` | Reporter format: `text` (stderr) or `json` (stdout NDJSON) |
| `AFTERBURNER_REBUILD_PLENUM` | unset | Set to `1` to regenerate `generated/plenum_bundle.js`. |

Applications opt in to logging with:

```rust
afterburner_core::log::init();  // reads AFTERBURNER_LOG + AFTERBURNER_LOG_FORMAT
```

---

## Node.js Compat Surface

Afterburner targets the **Node.js 20.x LTS API surface**. The summary
table is below; the full per-module breakdown — with status, links to
the official Node.js docs, and notes on any deliberate divergences —
lives in **[`docs/NODE_COMPAT.md`](./docs/NODE_COMPAT.md)**.

> **Drop-in promise:** code that runs under `node script.js` should
> run unchanged under `burn script.js`. Where it doesn't, that's a
> bug — file an issue with a Node.js docs link and a minimal repro.

| Group | Modules | Gate |
|:------|:--------|:-----|
| **Pure JS** | `path`, `url`, `querystring`, `events`, `assert`, `buffer`, `util`, `string_decoder`, `punycode`, `timers`, `process`, `console`, `stream` | none — always available |
| **Web globals** | `fetch`, `Request`, `Response`, `Headers`, `AbortController`, `AbortSignal`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `btoa`/`atob`, `queueMicrotask`, `performance.now`, `structuredClone` | none |
| **Host-backed** | `fs` (incl. `createReadStream` / `createWriteStream`, `fs.promises`) | `Manifold::fs` (`None` / `ReadOnly(roots)` / `ReadWrite(roots)`) |
| | `crypto` (hash, hmac, AES-GCM/CBC, PBKDF2, scrypt, RSA & ECDSA sign/verify, randomBytes/UUID) | `Manifold::crypto` |
| | `http` / `https` | `Manifold::net` (outbound only) |
| | `dns` | `Manifold::net` |
| | `os` | always on (non-sensitive) |
| | `zlib` (deflate/inflate/gzip/gunzip via Rust `flate2`) | always on (pure compute) |
| | `child_process` | `Manifold::child_process` — **native path only** |
| | `worker_threads` (Worker / parentPort / workerData / postMessage / terminate / threadId) | `Manifold` — children inherit the parent's manifold (never widened); `BURN_WORKER_DEPTH` ≤ 8 |
| | `net` (raw TCP) — `net.connect` / `net.createServer` / Socket / Server / `isIP{,v4,v6}`; daemon-only inbound listening; 64 KiB write HWM with `'drain'` backpressure | `Manifold::net` — outbound requires `OutboundFull` (raw TCP escapes URL-shaped policy, so `OutboundHttp` is rejected); host allow-list supports exact, `*`, and `*.suffix` |
| **Custom** | `afterburner:state` — cross-invocation key/value store | implicit — host installs the `StateStore` |

The library default manifold is `Manifold::sealed()` — safe to hand
untrusted user scripts. The `burn` CLI defaults to `Manifold::open()`
so Node scripts drop in without flags; `--sandbox` flips it back to
sealed. See [`docs/NODE_COMPAT.md`](./docs/NODE_COMPAT.md#sandbox-model)
for the full sandbox-model section.

---

## FAQ

<details>
<summary><b>Why is <code>quickjs-provider/afterburner_plugin.wasm</code> in the repo?</b></summary>

That is the committed Wizer-preinitialized Javy plugin, pulled in at
compile time via `include_bytes!`. Storing it in the repo keeps
`cargo build` reproducible and network-free.
</details>

<details>
<summary><b>Does the runtime shell out to <code>javy</code>?</b></summary>

No. The plugin compiles JS source to bytecode in-process via
`javy_plugin_api::compile_src` and runs it via `javy_plugin_api::invoke`.
`javy` is only used during plugin regeneration (`build.sh`).
</details>

<details>
<summary><b>Can I swap in a newer Wasmtime?</b></summary>

Yes — pin the version in the workspace `Cargo.toml` and run tests. The
workspace is already on Wasmtime 36; bumping further is mostly an
import-path chore (we already live through the `p2::pipe` move).
</details>

<details>
<summary><b>What about WASI Preview 2 / components?</b></summary>

The authoritative interface is specified in `wit/afterburner-host.wit`
and `wit/README.md`. The runtime still uses the core-module path for
pragmatic reasons — `javy init-plugin` requires Wizer preinit, and Wizer
outputs a flattened core module even when given a component input, so
the component-model host-side linker does not meaningfully simplify
things today. The WIT file stays as source-of-truth for future
migration.
</details>

<details>
<summary><b>How do I bundle multiple JS files together?</b></summary>

`FlowEngine::load_bundle(entry, modules)` accepts an entry script plus
a list of `(name, source)` helper modules. Inside the entry,
`require('./util')` resolves to the helper registered under `"./util"`.
Helpers can `require` each other.

```rust
let id = engine.load_bundle(
    "module.exports = (i) => require('./lib').double(i.n);",
    &[("./lib".into(), "module.exports = { double: (n) => n*2 };".into())],
)?;
```
</details>

<details>
<summary><b>Cross-invocation state</b></summary>

Pass a `SharedStateStore` to the engine. The default `InMemoryStateStore`
(lock-free, in-process) ships with the workspace; embedders can plug in
their own (Redis, SQLite, …) by implementing the `StateStore` trait.

```rust
use afterburner_core::InMemoryStateStore;
use afterburner_wasi::WasmConfig;

let store = InMemoryStateStore::shared();
let combustor = WasmCombustor::new(WasmConfig {
    state_store: Some(store.clone()),
})?;
```

Inside JS:

```js
const state = require('afterburner:state');
state.setJSON('lastSeen', Date.now());
const n = state.increment('hits');
```
</details>

---

<p align="center">
  <sub>MIT OR Apache-2.0</sub>
</p>

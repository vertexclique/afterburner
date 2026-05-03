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

### Install (prebuilt binaries)

```bash
# One-line installer (Linux / macOS / Windows-via-bash). Fetches the
# latest GitHub Release, verifies the SHA-256 sidecar, drops `burn`
# into ~/.local/bin (override with BURN_INSTALL=...).
curl -fsSL https://raw.githubusercontent.com/vertexclique/afterburner/master/install.sh | bash

# Pin a specific version
BURN_VERSION=v0.1.0 curl -fsSL https://raw.githubusercontent.com/vertexclique/afterburner/master/install.sh | bash
```

Or grab a tarball directly from the [Releases page](https://github.com/vertexclique/afterburner/releases) — archives are named `burn-<version>-<target>.tar.gz` (or `.zip` for Windows) and ship with a `.sha256` next to them.

Built with `--features release-cli` (every backend + every L3 shadow + TypeScript loader), so it's a single self-contained binary — no runtime libsqlite3 / libssl / libclang required. Plugin `.wasm` is `include_bytes!`-baked into the binary at build time.

### Install (build from source)

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
`crates/afterburner-wasi/plugin/afterburner_plugin.wasm` and pulled in via
`include_bytes!`. Consumers just depend on the afterburner crates.

### Build (default workspace)

| Tool | Version | Notes |
|:-----|:--------|:------|
| Rust | 1.90+ (2024 ed) | `rustup install stable` on most systems |
| Cargo | shipped with Rust | `cargo build` / `cargo test` work unmodified |
| libclang | any recent | required by `rquickjs-sys` bindgen |
| C compiler | any recent | required by `rquickjs-sys` / QuickJS |

### Build (plugin regeneration — required for polyfill / extern changes)

Needed when changing plugin Rust code, plugin extern decls, JS bridges,
or any file under `crates/afterburner-node-compat/polyfills/`. The committed
`.wasm` is otherwise authoritative.

| Tool | Version | How to get it |
|:-----|:--------|:--------------|
| `wasm32-wasip1` target | via rustup | `rustup target add wasm32-wasip1` |
| `javy` CLI | exactly 8.1.1 | `cargo install javy-cli` or [releases](https://github.com/bytecodealliance/javy/releases). Newer / older javy versions are not validated. |
| `wasm-opt` (Binaryen) | 119+ | Required to lower modern WASM features (bulk-memory, sign-ext, nontrapping-fptoint) that javy 8.1.1's bundled validator rejects. Install from [Binaryen releases](https://github.com/WebAssembly/binaryen/releases) or `npm install -g binaryen`. The build script falls back to a direct copy if `wasm-opt` isn't on `$PATH`, but the subsequent `javy init-plugin` will then fail with a wasm-validator error. |

The build script auto-discovers `javy` and `wasm-opt` via `$PATH` first,
then falls back to `~/.local/bin/<tool>`. Override with `JAVY=...` /
`WASM_OPT=...` env vars.

Regenerate the plugin:

```bash
# 1. Rebuild the plenum bundle from polyfills/.
AFTERBURNER_REBUILD_PLENUM=1 cargo build -p afterburner-node-compat

# 2. Compile + lower wasm features + Wizer-preinit.
#    The script:
#      a) cargo build --target wasm32-wasip1 --release
#      b) wasm-opt lowers bulk-memory / sign-ext / nontrapping-fptoint
#         to MVP-compatible ops so javy's validator accepts the module
#      c) javy init-plugin freezes the QuickJS runtime + plenum bundle
#         into the wasm so first-run startup is sub-millisecond
bash crates/afterburner-plugin/build.sh   # writes ../afterburner-wasi/plugin/afterburner_plugin.wasm
```

### Development environment summary

For local development end-to-end, install in this order:

1. **Rust stable 1.90+** with the wasm32-wasip1 target:
   ```bash
   rustup install stable
   rustup target add wasm32-wasip1
   ```
2. **System libraries** for `rquickjs-sys` bindgen:
   ```bash
   # Debian/Ubuntu
   sudo apt install build-essential clang libclang-dev pkg-config
   # macOS
   xcode-select --install
   ```
3. **Plugin regeneration toolchain** (only if you'll touch
   `crates/afterburner-plugin/` or `crates/afterburner-node-compat/polyfills/`):
   ```bash
   # javy CLI 8.1.1
   curl -L https://github.com/bytecodealliance/javy/releases/download/v8.1.1/javy-x86_64-linux-v8.1.1.gz \
     | gunzip > ~/.local/bin/javy && chmod +x ~/.local/bin/javy

   # Binaryen (wasm-opt) 119+
   curl -L https://github.com/WebAssembly/binaryen/releases/download/version_129/binaryen-version_129-x86_64-linux.tar.gz \
     | tar -xz -C /tmp && cp /tmp/binaryen-version_129/bin/wasm-opt ~/.local/bin/
   ```
4. **Build the workspace**:
   ```bash
   cargo build --workspace --exclude afterburner-plugin
   cargo test  --workspace --exclude afterburner-plugin
   ```

The plugin crate is excluded from `--workspace` builds because it
targets `wasm32-wasip1` and can't compile on the host triple — its
behavior is exercised end-to-end through the host crates' tests
that load the committed `.wasm`.

### Release builds

The default `[profile.release]` is already tuned (`opt-level=3`, fat
LTO, single codegen unit, stripped symbols, `panic="abort"`). For
shipping the `burn` CLI:

```bash
cargo build -p afterburner --features bin --release
# 21 MB single binary, statically linked to SQLite (when
# shadow-sqlite3 is on) and rustls. No runtime libsqlite3.so /
# libssl needed.
```

For shipping with **every shadow** baked in:

```bash
cargo build -p afterburner --release --features \
  bin,ts,shadow-bcrypt,shadow-argon2,shadow-jsonwebtoken,shadow-sqlite3,shadow-sharp
```

---

## Runbook

| Command | What it does |
|:--------|:-------------|
| `cargo build` | Builds the six host crates (skips the plugin). |
| `cargo test --workspace --exclude afterburner-plugin` | Runs the full 450+ test suite (set `--features bin,ts,all-shadows` to include the L3 shadow tests). |
| `cargo clippy --workspace --exclude afterburner-plugin --all-targets` | Linter check. |
| `cargo test -p afterburner-ignite --release perf_smoke` | Native throughput smoke. |
| `cargo test -p afterburner-wasi --release perf_smoke` | WASM throughput smoke. |
| `crates/afterburner-plugin/build.sh` | Rebuild + Wizer-preinit the plugin. |
| `cargo build --profile cli-release -p afterburner --bin burn --features release-cli` | Build the shippable `burn` binary locally. |
| `cargo release --execute patch` | Bump workspace version, commit, tag `vX.Y.Z`, push — fires off the GitHub Actions release workflow that builds + uploads multi-platform binaries. See `release.toml`. |

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
| | `dns` — `lookup` + `resolve{4,6,Mx,Txt,Cname,Ns}` + `reverse` (record-type-aware via `hickory-resolver`); `dns.Resolver` class; callback + `dns.promises.*` shapes | `Manifold::net` (any non-`None` unlocks DNS; `None` → `EACCES`) |
| | `os` | always on (non-sensitive) |
| | `zlib` (deflate/inflate/gzip/gunzip via Rust `flate2`) | always on (pure compute) |
| | `child_process` | `Manifold::child_process` — **native path only** |
| | `worker_threads` (Worker / parentPort / workerData / postMessage / terminate / threadId) | `Manifold` — children inherit the parent's manifold (never widened); `BURN_WORKER_DEPTH` ≤ 8 |
| | `net` (raw TCP) — `net.connect` / `net.createServer` / Socket / Server / `isIP{,v4,v6}`; daemon-only inbound listening; 64 KiB write HWM with `'drain'` backpressure | `Manifold::net` — outbound requires `OutboundFull` (raw TCP escapes URL-shaped policy, so `OutboundHttp` is rejected); host allow-list supports exact, `*`, and `*.suffix` |
| | `tls` (raw TLS) — `tls.connect` / `tls.createServer` / TLSSocket on `tokio-rustls`; Mozilla `webpki-roots` for client verification, `rejectUnauthorized: false` + custom `ca:` PEM, ALPN; PEM `cert` + `key` on the server side | `Manifold::net` — same posture as `net` (`OutboundFull` only) |
| **Custom** | `afterburner:state` — cross-invocation key/value store | implicit — host installs the `StateStore` |

The library default manifold is `Manifold::sealed()` — safe to hand
untrusted user scripts. The `burn` CLI defaults to `Manifold::open()`
so Node scripts drop in without flags; `--sandbox` flips it back to
sealed. See [`docs/NODE_COMPAT.md`](./docs/NODE_COMPAT.md#sandbox-model)
for the full sandbox-model section.

---

## FAQ

<details>
<summary><b>Why is <code>crates/afterburner-wasi/plugin/afterburner_plugin.wasm</code> in the repo?</b></summary>

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

The authoritative interface is specified in `docs/wit/afterburner-host.wit`
and `docs/wit/README.md`. The runtime still uses the core-module path for
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

## Releasing

Hands-off, single command from a clean master:

```bash
cargo release --execute patch    # or minor / major
```

What happens:

1. cargo-release bumps the workspace version (every member crate inherits via `version.workspace = true`).
2. Commits the bump (`chore: release X.Y.Z`).
3. Tags the commit `vX.Y.Z` and pushes commit + tag to `origin`.
4. The tag push fires `.github/workflows/release.yml`:
   - Builds `burn` for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-pc-windows-msvc` with `--features release-cli` against the `cli-release` Cargo profile.
   - Bundles the binary + `README.md` + `LICENSE-*` + `EXCLUDED_ENTITIES` + `docs/`.
   - SHA-256 sidecar per archive.
   - Creates / updates the GitHub Release named after the tag and uploads every artifact.

Manual rolls are still supported — bump `version` in `[workspace.package]` by hand, push a `v*.*.*` tag, or run the workflow via the GitHub UI's "Run workflow" button (`workflow_dispatch` accepts the tag as input).

CI itself (`.github/workflows/ci.yml`) runs on every push / PR: `fmt`, `clippy` (default + `release-cli`), workspace tests on Ubuntu + macOS, doc build, and a plugin-`.wasm` rebuild check that compares the bundled-polyfill SHA against the committed sidecar so polyfill drift can't sneak in.

---

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your
option, with one carve-out: the entities listed in [`EXCLUDED_ENTITIES`](EXCLUDED_ENTITIES)
are **not** granted any rights under either license. The list is part of the
license terms — copies and derivatives must include it unmodified.

---

<p align="center">
  <sub>MIT OR Apache-2.0 (with EXCLUDED_ENTITIES)</sub>
</p>

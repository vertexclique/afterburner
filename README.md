<p align="center">
  <img src="https://github.com/vertexclique/afterburner/raw/master/art/svg/afterburner-bg-2000x500.svg" alt="Afterburner" width="100%"/>
</p>

<p align="center">
  <strong>A sandboxed JavaScript VM for Rust. Execute untrusted scripts with memory limits, timeouts, capability-gated I/O, and threading.</strong>
</p>

<p align="center">
  <a href="https://crates.io/crates/afterburner"><img src="https://img.shields.io/crates/v/afterburner?style=flat-square&color=e6832e" alt="crates.io"/></a>
  <a href="https://docs.rs/afterburner"><img src="https://img.shields.io/docsrs/afterburner?style=flat-square&color=2a9d8f" alt="docs.rs"/></a>
  <img src="https://img.shields.io/badge/rust-1.90%2B_(2024_ed)-blue?style=flat-square&logo=rust&logoColor=white" alt="MSRV"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

Afterburner lets you load, execute, and unload JavaScript from Rust with hard resource limits and fine-grained permission controls. Node.js built-ins (`fs`, `crypto`, `http`, `zlib`, `child_process`, and more) are available but locked behind capability gates you configure per-script.

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
    .threaded(8)
    .build()?;
```

## `burn`: the command-line runtime

### Install (prebuilt binaries)

Linux / macOS:

```sh
curl -fsSL https://afterburner.sh | sh
```

Windows (PowerShell):

```powershell
iwr -useb https://afterburner.sh | iex
```

Pin a specific version with `BURN_VERSION`:

```sh
# POSIX
BURN_VERSION=v0.1.1 curl -fsSL https://afterburner.sh | sh
```

```powershell
# PowerShell
$env:BURN_VERSION = 'v0.1.1'; iwr -useb https://afterburner.sh | iex
```

Or grab a tarball directly from the [Releases page](https://github.com/vertexclique/afterburner/releases). Archives are named `burn-<version>-<target>.tar.gz` (or `.zip` for Windows) and ship with a `.sha256` next to them.

Built with `--features release-cli` (every backend, every L3 shadow, TypeScript loader), so it's a single self-contained binary. No runtime libsqlite3, libssl, or libclang required. Plugin `.wasm` is `include_bytes!`-baked into the binary at build time.

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

See [`examples/`](./examples/) for standalone projects covering single
UDF, batched UDF, multi-worker scheduling, streaming crypto,
`HostContext` + capability grants, rebuilding `burn` in 30 lines, and the
real Express app described below.

## Run real Express, unmodified

[`examples/express-app`](./examples/express-app) takes
`express@^4.21` from `node_modules` and serves HTTP through axum +
Afterburner. No mocked router, no rewritten npm package — `const
express = require('express')` resolves the real CommonJS tree out of
the example's `node_modules/express/`, and the JS app runs inside the
Wasmtime + Javy QuickJS sandbox with capability-gated fs and crypto.

```bash
cd examples/express-app
npm install                       # populates ./node_modules/express + deps
cargo run --release
# afterburner-example-express-app
#   thrust workers: 8
#   cwd: …/examples/express-app
#   listening on http://127.0.0.1:3000
```

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/hello/world
curl -X POST -H 'Content-Type: application/json' \
     -d '[1,2,3,4]' http://127.0.0.1:3000/sum
```

The five canonical Express patterns work end-to-end: route registration, path parameters, JSON bodies (pre-parsed at the host boundary, the same pattern serverless adapters use), `res.status(...).json(...)`, the 404 fallback (`app.use((req,res) => res.status(404)...)`), and the four-arg error handler. Express's ETag middleware computes SHA-1 over each response body — granted via `Manifold { crypto: true, ... }`.

```rust
use afterburner::{Afterburner, FsAccess, Manifold};

let example_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
let ab = Afterburner::builder()
    .manifold(Manifold {
        fs: FsAccess::ReadOnly(vec![example_root.clone()]),
        crypto: true,
        ..Manifold::sealed()
    })
    .cwd(example_root)              // require('express') walks node_modules from here
    .threaded(8)
    .build()?;
```

`.cwd(path)` is the new builder switch that pins the require resolver to the example directory. Without it, `require('express')` walks from `/` and fails to find `node_modules/express` — same as Node would behave outside the project tree.

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

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

**Corporate use notice.** Any corporate entity — company, agency, fund, foundation, or any organisation operating commercially — that uses Afterburner (in production, in internal tooling, in a product, or in a service) **must email the maintainer** at `vertexclique@gmail.com` before adopting it. The maintainer reserves the right to refuse permission to use this project to specific entities, at the maintainer's sole discretion, regardless of the underlying Apache-2.0 grant. Individuals and non-commercial open-source use are not subject to this notice.

---

<p align="center">
  <sub>Apache-2.0</sub>
</p>

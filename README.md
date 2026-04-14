# Afterburner

A Rust workspace for running user-supplied JavaScript with two execution
paths sharing one API: a trusted `rquickjs` path for sub-microsecond
throughput and a fully sandboxed Wasmtime + QuickJS-in-WASM path for
untrusted code. Every Node.js built-in an embedder needs — `path`,
`fs`, `crypto`, `http`, `events`, `buffer`, `zlib`, `child_process`, …
— is reachable through a capability gate called `Manifold`.

Two backends, one `Combustor` trait, one `FlowEngine`:

```rust
use afterburner_flow::FlowEngine;
use afterburner_core::{FuelGauge, Manifold, FsAccess};
use serde_json::json;

let engine = FlowEngine::with_fuel(FuelGauge {
    memory_bytes: Some(64 << 20),
    timeout_ms: Some(30_000),
    manifold: Manifold { fs: FsAccess::ReadWrite(vec!["/var/data".into()]),
                         ..Manifold::sealed() },
    ..FuelGauge::default()
})?;

let id = engine.load(r#"
    const fs = require('fs');
    module.exports = (input) => fs.readFileSync('/var/data/' + input.key);
"#)?;

let body = engine.execute(&id, &json!({ "key": "x.json" }))?;
```

## Crates

| Crate                       | Purpose                                                   |
|-----------------------------|-----------------------------------------------------------|
| `afterburner-core`          | `Combustor` trait, `Manifold`, `FuelGauge`, `BurnCache`, level-gated logging |
| `afterburner-ignite`        | Native QuickJS via `rquickjs`, thread-local runtimes      |
| `afterburner-wasi`          | Wasmtime + Javy plugin sandbox with host-function imports |
| `afterburner-node-compat`   | `plenum.js` polyfill bundle + Rust-backed host impls      |
| `afterburner-flow`          | High-level `FlowEngine::load/execute/unload` API          |
| `afterburner-adaptive`      | Flying Start: native → WASM tier switch                   |
| `afterburner-plugin`        | WASM-side Javy plugin (`wasm32-wasip1`)                   |

## Requirements

### Runtime

Nothing external is needed at runtime. The Javy plugin is committed as a
Wizer-preinitialized `.wasm` at
`quickjs-provider/afterburner_plugin.wasm` and pulled in via
`include_bytes!`. Consumers just depend on the afterburner crates.

### Build (default workspace)

| Tool       | Version          | Notes                                          |
|------------|------------------|------------------------------------------------|
| Rust       | 1.90+ (2024 ed)  | `rustup install stable` on most systems        |
| Cargo      | shipped with Rust| `cargo build` / `cargo test` work unmodified   |
| libclang   | any recent       | required by `rquickjs-sys` bindgen             |
| C compiler | any recent       | required by `rquickjs-sys` / QuickJS           |

### Build (plugin regeneration only — optional)

Only needed when changing plugin Rust code, the WIT interface, or the
plenum polyfill bundle. The committed `.wasm` is otherwise authoritative.

| Tool              | Version      | How to get it                                                                 |
|-------------------|--------------|-------------------------------------------------------------------------------|
| `wasm32-wasip1`   | via rustup   | `rustup target add wasm32-wasip1`                                             |
| `javy` CLI        | 8.1.1+       | `cargo install javy-cli` or download from https://github.com/bytecodealliance/javy/releases |
| Node bundler      | not required | Plenum bundle is produced by a pure-Rust `build.rs` (concat + include_str!)    |

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

## Runbook

| Command                                                       | What it does                                    |
|---------------------------------------------------------------|-------------------------------------------------|
| `cargo build`                                                 | Builds the six host crates (skips the plugin).  |
| `cargo test --workspace --exclude afterburner-plugin`         | Runs the full 99-test suite.                    |
| `cargo clippy --workspace --exclude afterburner-plugin --all-targets` | Linter check.                                   |
| `cargo test -p afterburner-ignite --release perf_smoke`       | Native throughput smoke.                        |
| `cargo test -p afterburner-wasi --release perf_smoke`         | WASM throughput smoke.                          |
| `afterburner-plugin/build.sh`                                 | Rebuild + Wizer-preinit the plugin.             |

## Environment variables

| Variable                       | Default    | Purpose                                                    |
|--------------------------------|------------|------------------------------------------------------------|
| `AFTERBURNER_LOG`              | `warn`     | Level filter: `off` / `error` / `warn` / `info` / `debug` / `trace` |
| `AFTERBURNER_LOG_FORMAT`       | `text`     | Reporter format: `text` (stderr) or `json` (stdout NDJSON) |
| `AFTERBURNER_REBUILD_PLENUM`   | unset      | Set to `1` to regenerate `generated/plenum_bundle.js`.     |

Applications opt in to logging with:

```rust
afterburner_core::log::init();  // reads AFTERBURNER_LOG + AFTERBURNER_LOG_FORMAT
```

## Node.js compat surface

| Group      | Modules                                                                                      | Gate                                                |
|------------|----------------------------------------------------------------------------------------------|-----------------------------------------------------|
| Pure JS    | `path`, `url`, `querystring`, `events`, `assert`, `buffer`, `util`, `string_decoder`, `punycode`, `timers`, `process`, `console`, `stream` | none — always available           |
| Host-backed| `fs`                                                                                         | `Manifold::fs` (`None` / `ReadOnly(roots)` / `ReadWrite(roots)`) |
|            | `crypto`                                                                                     | `Manifold::crypto`                                  |
|            | `http` / `https`                                                                             | `Manifold::net` (outbound only)                     |
|            | `dns`                                                                                        | `Manifold::net`                                     |
|            | `os`                                                                                         | always on (non-sensitive)                           |
|            | `zlib`                                                                                       | always on (pure compute)                            |
|            | `child_process`                                                                              | `Manifold::child_process` — **native path only**    |

Default manifold is `Manifold::sealed()` — safe to hand untrusted user
scripts. `Manifold::open()` exists for trusted admin contexts.

## FAQ

### Why do I see a `quickjs-provider/afterburner_plugin.wasm` in the repo?

That is the committed Wizer-preinitialized Javy plugin, pulled in at
compile time via `include_bytes!`. Storing it in the repo keeps
`cargo build` reproducible and network-free.

### Does the runtime shell out to `javy`?

No. The plugin compiles JS source to bytecode in-process via
`javy_plugin_api::compile_src` and runs it via `javy_plugin_api::invoke`.
`javy` is only used during plugin regeneration (`build.sh`).

### Can I swap in a newer Wasmtime?

Yes — pin the version in the workspace `Cargo.toml` and run tests. The
workspace is already on Wasmtime 36; bumping further is mostly an
import-path chore (we already live through the `p2::pipe` move).

### What about WASI Preview 2 / components?

The authoritative interface is specified in `wit/afterburner-host.wit`
and `wit/README.md`. The runtime still uses the core-module path for
pragmatic reasons — `javy init-plugin` requires Wizer preinit, and Wizer
outputs a flattened core module even when given a component input, so
the component-model host-side linker does not meaningfully simplify
things today. The WIT file stays as source-of-truth for future
migration.

## License

MIT OR Apache-2.0.

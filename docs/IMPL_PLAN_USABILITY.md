# Implementation Plan: Afterburner Usability — Facade Crate, `burn` Binary, Examples

**Status:** Design — Implementation gated on `IMPL_PLAN_THREADING.md`
**Workspace:** new `afterburner/` crate + sibling `examples/` standalone project
**Depends on:** All of `IMPL_PLAN_THREADING.md` (T0–T8) must ship first.

---

## 1. Goal

A developer should not have to know that `afterburner-core`, `afterburner-wasi`, `afterburner-ignite`, `afterburner-thrust`, `afterburner-flow`, `afterburner-node-compat`, `afterburner-plugin`, or `afterburner-adaptive` exist. They should type:

```toml
[dependencies]
afterburner = "0.1"
```

and write:

```rust
use afterburner::Afterburner;
use serde_json::json;

let ab = Afterburner::new()?;
let script = ab.register("(d) => d.n + 1")?;
let out = ab.run(&script, &json!({ "n": 41 }))?;
assert_eq!(out, json!({ "n": 42 }));
```

Three deliverables, in this plan's scope:

1. **`afterburner` facade crate.** Re-exports the public API across every member crate behind one ergonomic entry point (`Afterburner` + builder). Feature-gated so users only pay for what they import.
2. **`burn` binary** produced from that facade crate. A Deno/Node/Bun-style runtime: run a `.js` file, eval inline code, drive UDFs from stdin, REPL, bench. Embeds Afterburner; no separate daemon.
3. **`examples/` standalone project.** Its own Cargo workspace, excluded from the root workspace, depends on `afterburner` by path. Houses small demo programs that exercise every supported public pattern.

---

## 2. Prerequisites — why this ships after threading

This plan is explicitly dated **after `IMPL_PLAN_THREADING.md` completes (T0–T8)**. Reasons:

- `Afterburner::builder().threaded(N)` returns a handle that wraps `afterburner_thrust::ThrustEngine`. That type does not exist until T0.
- Performance numbers in example READMEs (`examples/parallel-thrust/README.md`) quote `ThrustEngine` throughput from the T8 perf smoke. Without T8, the numbers are speculative.
- `burn bench --workers N` is a direct passthrough to `ThrustEngineConfig.compute_workers`. Wiring it pre-threading would ship a flag that does nothing.
- Shipping the facade pre-threading means designing and redesigning the public API twice — wasteful.

**Exception:** the facade crate *skeleton* (`afterburner/src/lib.rs` with feature-gated re-exports only) could land pre-threading if it materially unblocks an external caller. Prefer to wait.

---

## 2b. Codebase baseline — verified against HEAD (2026-04-15)

This plan was reconciled against the actual crate contents after the initial draft. Five places where the first draft was wrong — all now corrected below:

- **Flow engine is `afterburner_flow::FlowEngine`, not `ReheatEngine`.** Public surface: `FlowEngine::new`, `::with_fuel`, `::load(source)`, `::load_bundle(entry, modules)`, `::execute(id, input)`, `::unload(id)`, `::cache_stats`. Pattern is **load + execute**, not a one-shot `run_script(source, data_chain)`. (`afterburner-flow/src/engine.rs` ~66+.)
- **`BurnCache` is not generic** over the engine — it holds `Box<dyn Combustor>`. Internal dispatch in the facade uses a trait object, not a type parameter. (`afterburner-core/src/registry.rs:113`.)
- **`HostContext` lives in `afterburner-core`**, re-exported alongside `HostFunction`/`NullHost`/`LogLevel`/`HttpMethod`/`HttpResponse`. `afterburner-node-compat` provides the JS polyfill bundle + the thread-local `host_context_active::{activate, with}` activation API, but *not* the trait itself. (`afterburner-core/src/host.rs:74` ; `afterburner-node-compat/src/host_context_active.rs:15`.)
- **`afterburner-node-compat` has no feature flags today.** All of crypto / HMAC / HTTP / base64 / gzip are unconditionally compiled in. `host-http` exists only on `afterburner-wasi`. `host-fs` exists **nowhere** yet — U5 introduces it across both crates as part of the capability-grant work.
- **`WasmConfig` is a plain struct** (pub fields, `derive(Default, Clone)`), not a builder. The facade constructs it as `WasmConfig { host_context: Some(ctx), state_store: Some(s), ..Default::default() }`. A `.with_host_context()` builder exists on `NativeCombustor` only. (`afterburner-wasi/src/wasm_engine.rs:54`, `afterburner-ignite/src/native_engine.rs:146`.)

Additional facts the draft omitted and the revision now accounts for:

- **State-store subsystem.** `afterburner-core` exports `SharedStateStore` / `StateStore` / `InMemoryStateStore`. Both `NativeCombustor::with_state_store` and `WasmConfig::state_store` consume it. The facade adds a `.state_store(s)` builder knob; default is a fresh in-memory store. (`afterburner-core/src/state_store.rs`.)
- **`FuelGauge` contains `manifold: Manifold`.** Setting the manifold goes through `FuelGauge`, not a sibling field. (`afterburner-core/src/types.rs:51`.)
- **`AdaptiveCombustor::with_wasm_config(cfg: WasmConfig)`** is the way to thread a host context into the adaptive engine. (`afterburner-adaptive/src/adaptive.rs:82`.)
- **`abi_parity.rs` drift test already exists** at `afterburner-wasi/tests/abi_parity.rs`. Extension for the script envelope (§5.4) adds a second bundle to the same comparator.

---

## 3. Architecture

### 3.1 Workspace layout (post-plan)

```
afterburner/                                (git root, Cargo workspace root)
├── Cargo.toml                              (workspace; excludes ./examples)
├── afterburner/                            NEW — facade crate + bin
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                          re-exports + Afterburner + builder
│       ├── builder.rs
│       ├── prelude.rs
│       └── bin/
│           └── burn.rs                     the `burn` CLI
├── afterburner-core/
├── afterburner-wasi/
├── afterburner-ignite/
├── afterburner-adaptive/
├── afterburner-flow/
├── afterburner-node-compat/
├── afterburner-plugin/
├── afterburner-thrust/                     from threading plan
├── quickjs-provider/
├── docs/
├── wit/
└── examples/                               NEW — just a directory; each subdir is its own standalone project
    ├── README.md                           index of all examples
    ├── basic/
    │   ├── Cargo.toml                      self-contained: own [package], own [dependencies], own [workspace] root
    │   ├── Cargo.lock                      example-local lock; committed
    │   ├── README.md
    │   └── src/main.rs
    ├── udf-batch/                       ...each example follows the same shape...
    ├── flow-data-chain/
    ├── parallel-thrust/
    ├── fetch-and-env/
    ├── burn-embedding/
    └── streaming-crypto/
```

**No `examples/Cargo.toml`.** There is no outer workspace wrapping the examples. Each example is an independent Cargo project with its own `[package]`, its own `[dependencies]` (every version pinned locally — *no* `{ workspace = true }` references into the root), its own `Cargo.lock`, and its own `[workspace]` stanza marking it as a standalone root so Cargo doesn't accidentally reach up into the afterburner root workspace.

Each `examples/<name>/Cargo.toml` looks like:

```toml
[package]
name    = "afterburner-example-basic"
version = "0.1.0"
edition = "2024"
publish = false

# Declare this subdir as its own workspace root — prevents Cargo from walking up
# to the afterburner root workspace.
[workspace]

[dependencies]
afterburner = { path = "../../afterburner" }   # or "0.1" once published
serde_json  = "1"
anyhow      = "1"
# ...any example-specific deps (tokio, reqwest, etc.) pinned here by this example alone.
```

Root `Cargo.toml` defensively excludes every example subdirectory so even if a subdir is missing its own `[workspace]` stanza, Cargo still won't swallow it into the root workspace:

```toml
[workspace]
resolver = "2"
members  = [
    "afterburner", "afterburner-core", "afterburner-wasi", "afterburner-ignite",
    "afterburner-adaptive", "afterburner-flow", "afterburner-node-compat",
    "afterburner-plugin", "afterburner-thrust",
]
exclude  = ["examples"]      # belt-and-suspenders; each example is also its own [workspace] root
```

`cargo build --workspace` at the root never touches examples. To build an example you `cd examples/basic && cargo build` — it resolves `afterburner` via path from its own self-contained graph.

### 3.2 Why each example is its own standalone project (not a shared workspace)

- **Self-contained copy-paste starters.** A user can `cp -r examples/basic ~/my-project && cd ~/my-project && cargo run` with nothing else installed, no root repo cloned. That's the whole point.
- **Per-example version autonomy.** `parallel-thrust` might want `tokio = "1.40"`; `fetch-and-env` might want `reqwest = "0.12"`; `udf-batch` might want nothing beyond `serde_json`. A shared `[workspace.dependencies]` pin forces every example onto the same version of everything, which defeats the "each example is its own little project" intent.
- **Independent `Cargo.lock` per example.** Reproducible builds against a pinned `afterburner` version and pinned dep versions — no surprise updates from an unrelated example adding a new dep.
- **No accidental feature unification.** Cargo's workspace feature resolver unifies features across members. If `fetch-and-env` enables `afterburner/host-http`, a shared workspace would leak that feature into `basic`. Separate projects keep feature cross-sections clean.
- **Root `cargo build` / `cargo test` stays fast.** Examples are invisible to the workspace build.
- **Changes to internal crate boundaries don't force examples to recompile** as a side-effect of root-workspace rebuilds.

---

## 4. Public API — the `afterburner` facade crate

### 4.1 `afterburner/Cargo.toml`

```toml
[package]
name    = "afterburner"
version = "0.1.0"
edition = "2024"
license = "MIT OR Apache-2.0"
description = "Sandboxed JavaScript runtime: WASM (Wasmtime) + native (QuickJS) backends, with a threaded scheduler."

[lib]
path = "src/lib.rs"

[[bin]]
name = "burn"
path = "src/bin/burn.rs"
required-features = ["bin"]

[dependencies]
afterburner-core         = { path = "../afterburner-core" }
afterburner-node-compat  = { path = "../afterburner-node-compat" }
afterburner-wasi         = { path = "../afterburner-wasi",      optional = true }
afterburner-ignite       = { path = "../afterburner-ignite",    optional = true }
afterburner-adaptive     = { path = "../afterburner-adaptive",  optional = true }
afterburner-flow         = { path = "../afterburner-flow",      optional = true }
afterburner-thrust       = { path = "../afterburner-thrust",    optional = true }
serde_json = { workspace = true }
# bin-only deps gated behind `bin` feature:
clap       = { version = "4", features = ["derive"], optional = true }
rustyline  = { version = "14", optional = true }
anyhow     = { version = "1", optional = true }

[features]
default   = ["wasm", "native", "thrust"]
wasm      = ["dep:afterburner-wasi"]
native    = ["dep:afterburner-ignite"]
adaptive  = ["dep:afterburner-adaptive", "wasm", "native"]
thrust    = ["dep:afterburner-thrust", "wasm"]
flow      = ["dep:afterburner-flow", "wasm"]
host-http = ["afterburner-wasi?/host-http"]                      # node-compat is always compiled-in today (§2b).
host-fs   = ["afterburner-wasi?/host-fs"]                        # `host-fs` feature added by U5 in both wasi and node-compat.
bin       = ["dep:clap", "dep:rustyline", "dep:anyhow", "adaptive", "thrust"]
```

Default features give the library user a WASM + native + threaded runtime. Heavy/opinionated surfaces (`flow`, `host-http`, `host-fs`) stay opt-in. `bin` is strictly a binary-build concern — library consumers never see it.

`host-http` propagates only to `afterburner-wasi` today because `afterburner-node-compat` has no feature block yet — all of its polyfill support code is unconditionally compiled. That is fine for the facade (nothing breaks), but U5 — when real fs capability gating lands — will introduce matching `host-http`/`host-fs` features on node-compat and the facade's feature lines will grow to propagate them.

### 4.2 Entry types

```rust
// afterburner/src/lib.rs

pub use afterburner_core::{
    // errors + result
    AfterburnerError, Result,
    // script identity + engine tag
    ScriptId, EngineMode, sha256,
    // engine trait (users rarely need it but we expose for custom engines)
    Combustor,
    // runtime limits + capabilities
    FuelGauge, Manifold, FsAccess, NetAccess, EnvAccess,
    // host hook trait + helpers (HostContext lives in core, NOT in node-compat)
    HostContext, HostFunction, HttpMethod, HttpResponse, LogLevel, NullHost,
    // state-store subsystem
    SharedStateStore, StateStore, InMemoryStateStore,
    // registry internals (optional — advanced embedders only)
    BurnCache, BurnCacheBackend, InProcessCacheBackend, RegistryStats,
};

#[cfg(feature = "wasm")]
pub mod wasm    { pub use afterburner_wasi::{WasmCombustor, WasmConfig}; }
#[cfg(feature = "native")]
pub mod native  { pub use afterburner_ignite::NativeCombustor; }
#[cfg(feature = "adaptive")]
pub mod adaptive { pub use afterburner_adaptive::{AdaptiveCombustor, make_adaptive_cache}; }
#[cfg(feature = "flow")]
pub mod flow    { pub use afterburner_flow::{FlowEngine, default_fuel_gauge}; }
#[cfg(feature = "thrust")]
pub mod thrust  {
    pub use afterburner_thrust::{
        TenantId, ThrustEngine, ThrustEngineConfig, ThrustEngineStats, ThrustHandle,
    };
}

pub mod prelude {
    pub use super::{Afterburner, AfterburnerError, FuelGauge, HostContext, Manifold, ScriptId};
}

/// One-stop entry point. Internally holds one of: a single-threaded
/// `BurnCache` wrapping a trait-object `Box<dyn Combustor>`, or an
/// `Arc<ThrustEngine>` (N-worker scheduler). The variant is chosen at
/// `.build()` time and compiled away when only one backend feature is on.
pub struct Afterburner { /* opaque */ }

impl Afterburner {
    /// Defaults: adaptive engine + in-process cache + `NullHost` + fresh `InMemoryStateStore`.
    pub fn new() -> Result<Self> { Self::builder().build() }

    pub fn builder() -> AfterburnerBuilder { AfterburnerBuilder::default() }

    /// Compile + cache a script. Idempotent: same source → same `ScriptId`.
    /// Wraps `BurnCache::register` / `ThrustEngine::register` depending on mode.
    pub fn register(&self, source: &str) -> Result<ScriptId>;

    /// Compile + cache a multi-file ES-module bundle. Flow mode only; other
    /// modes return `Err(AfterburnerError::Host("bundle mode requires .flow()"))`.
    /// Delegates to `FlowEngine::load_bundle`.
    #[cfg(feature = "flow")]
    pub fn register_bundle(&self, entry: &str, modules: &[(String, String)]) -> Result<ScriptId>;

    /// Run with the builder-supplied defaults. Internally constructs a
    /// `FuelGauge` from the builder-captured (fuel, memory_bytes, timeout_ms, manifold)
    /// and calls `Combustor::thrust` (non-threaded) or `ThrustEngine::thrust_sync` (threaded).
    pub fn run(&self, id: &ScriptId, input: &Value) -> Result<Value>;

    /// Run with explicit limits (per-call override).
    pub fn run_with(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value>;

    /// Apply the same script across an array of records. `input` must be a JSON array.
    /// Semantically equivalent to `run` over each element and returning the array of outputs.
    pub fn run_batch(&self, id: &ScriptId, input: &Value) -> Result<Value>;

    /// Drop cached compilation artifacts for `id`. Subsequent `run` calls
    /// will re-compile if the source is still in the backing store.
    pub fn unload(&self, id: &ScriptId);
}

#[derive(Default)]
pub struct AfterburnerBuilder { /* ... */ }

impl AfterburnerBuilder {
    pub fn mode(self, mode: Mode) -> Self;                     // Native | Wasm | Adaptive
    pub fn fuel(self, fuel: u64) -> Self;                      // sets FuelGauge::fuel
    pub fn memory_bytes(self, bytes: usize) -> Self;           // sets FuelGauge::memory_bytes
    pub fn timeout_ms(self, ms: u64) -> Self;                  // sets FuelGauge::timeout_ms
    pub fn manifold(self, m: Manifold) -> Self;                // sets FuelGauge::manifold
    pub fn host_context(self, ctx: Arc<dyn HostContext>) -> Self;
    pub fn state_store(self, store: SharedStateStore) -> Self; // default = fresh in-memory
    pub fn cache_backend(self, b: Arc<dyn BurnCacheBackend>) -> Self;

    #[cfg(feature = "thrust")]
    pub fn threaded(self, workers: usize) -> ThreadedBuilder;  // switches to ThrustEngine backend

    #[cfg(feature = "flow")]
    pub fn flow(self) -> Self;                                 // WASM mode + `FlowEngine::default_fuel_gauge()`

    pub fn build(self) -> Result<Afterburner>;
}

#[cfg(feature = "thrust")]
pub struct ThreadedBuilder { /* ... */ }

#[cfg(feature = "thrust")]
impl ThreadedBuilder {
    pub fn io_workers(self, n: usize) -> Self;
    pub fn admission_tokens_per_sec(self, rate: u64) -> Self;
    pub fn admission_burst(self, tokens: u64) -> Self;
    pub fn build(self) -> Result<Afterburner>;
}

pub enum Mode {
    Native,
    #[cfg(feature = "wasm")] Wasm,
    #[cfg(feature = "adaptive")] Adaptive,
}
```

Shape notes for implementers:

- `AfterburnerBuilder::state_store(...)` feeds `NativeCombustor::with_state_store` on the native side and `WasmConfig { state_store: Some(s), .. }` on the wasm side. `AdaptiveCombustor::with_wasm_config` covers the adaptive path.
- `.host_context(ctx)` threads into `NativeCombustor::with_host_context` and `WasmConfig { host_context: Some(ctx), .. }` respectively. `WasmConfig` is a struct, not a builder — the facade sets fields directly with `..Default::default()`.
- `.flow()` is a mode shortcut, not a separate builder type — it sets `Mode::Wasm` + limits from `afterburner_flow::default_fuel_gauge()`, and enables `register_bundle`. There is no `ReheatEngine`; the old name was speculative in the summary.

### 4.3 Internal dispatch

`BurnCache` is **not generic** over the engine — it holds `Box<dyn Combustor>` (`afterburner-core/src/registry.rs:113`). So the facade's internal enum is not type-parameterized by engine either. Concrete shape:

```rust
enum EngineHolder {
    Cache(BurnCache),                    // wraps Native / Wasm / Adaptive via Box<dyn Combustor>
    #[cfg(feature = "thrust")]
    Thrust(Arc<afterburner_thrust::ThrustEngine>),
}

struct Afterburner {
    engine: EngineHolder,
    defaults: FuelGauge,                  // used when caller invokes `run` without `_with`
    state_store: SharedStateStore,        // handed to the engine at build time
}
```

`run()` reads `defaults`, passes them through to `BurnCache::execute` (`Cache`) or `ThrustEngine::thrust_sync` (`Thrust`). `run_with()` skips `defaults` and uses the caller's `FuelGauge` directly. Build-time `Mode` selection is compiled away when only one backend feature is enabled.

`Mode::Native` plugs in `NativeCombustor::with_state_store(...).with_host_context(...)`. `Mode::Wasm` plugs in `WasmCombustor::new(WasmConfig { state_store: Some(s), host_context: Some(ctx), ..Default::default() })`. `Mode::Adaptive` uses `AdaptiveCombustor::with_wasm_config(cfg)` for the WASM side and inherits the native path defaults for the first-call tier.

### 4.4 `HostContext` is the same trait across modes

`afterburner::HostContext` is **re-exported from `afterburner-core`** (`afterburner-core/src/host.rs:74`), not from `afterburner-node-compat`. Node-compat provides the JS polyfill bundle and the thread-local activation API (`host_context_active::{activate, with}`), but the trait itself lives in core so every engine can see it. Users implement the trait for their domain (DB reader, emit-row pipeline, env policy, HTTP client). The same trait serves:

- An embedding database's UDF pipeline operator (batch-UDF mode)
- A flow engine's data-chain payload (flow mode, via `FlowEngine`)
- `burn --allow-net` (CLI mode — backed by a default `burn::DefaultCtx`)
- Any custom embedding (`fetch-and-env` and `burn-embedding` examples)

One interface, many embeddings. This is the central lever for keeping the facade small.

---

## 5. The `burn` binary

### 5.1 Goals

- `burn script.js` — run top-level JS. `console.log` visible. Exit 0 on success.
- `burn -e 'console.log(1+1)'` — eval inline.
- `burn thrust script.js < input.json` — UDF mode: stdin JSON → `data` → stdout JSON.
- `burn repl` — interactive REPL.
- `burn bench script.js --iters 100000 --workers 8` — perf smoke.
- `burn check script.js` — parse + compile only.
- `burn version` — plugin hash, engine versions, features compiled in.

Default subcommand detection: if `argv[1]` looks like a file path and is not a known subcommand, treat as `burn run argv[1]`. So `burn ./foo.js` works with zero ceremony — matching the user's "put burn in front of commands" ask.

### 5.2 Subcommand surface (clap-derived)

```
burn [GLOBAL FLAGS] <COMMAND> [ARGS]

COMMANDS
  run <FILE>            Execute top-level JS. Default if argv[1] is a path.
  eval <CODE> | -e      Execute inline JS.
  thrust <FILE>         UDF mode: read JSON from stdin, write JSON to stdout.
  repl                  Interactive REPL.
  bench <FILE>          Run N iterations, report throughput + p50/p99.
  check <FILE>          Parse + compile only.
  version               Print version/build info.

GLOBAL FLAGS
  --mode wasm|native|adaptive   [default: adaptive]
  --fuel N                      Opcode fuel budget.
  --memory N                    Bytes (accepts K/M/G suffixes).
  --timeout Nms                 Wall-clock deadline.
  --workers N                   Thrust workers (bench + thrust modes).
  --allow-net[=host1,host2]     Enable fetch (optionally restricted).
  --allow-fs[=path1,path2]      Enable fs.readFile/writeFile (optionally restricted).
  --allow-env[=VAR1,VAR2]       Enable process.env / host getEnv (optionally restricted).
  --allow-all | -A              Enable all capability grants.
  --no-color                    Disable ANSI output.
  -v, --verbose                 Print debug info (plugin hash, fuel used, etc.).
```

### 5.3 Capability grants (Deno-style, deny by default)

Deny by default:

- No fs / net / env / process.
- Available always: `console.*`, `crypto` (digest + HMAC), `Buffer`, `queueMicrotask`, `setTimeout(_, 0)`, `setImmediate`.

Opt-in (each flag expands `Manifold` *and* registers a `HostContext` that allow-lists per the flag argument):

- `--allow-net[=<hosts>]` → gates `fetch`. Empty list = all hosts allowed. Requires the `host-http` feature in the build.
- `--allow-fs[=<paths>]` → gates `fs.readFile` / `fs.writeFile` / streaming chunks. Requires `host-fs`.
- `--allow-env[=<vars>]` → gates `process.env` / host `getEnv`.
- `--allow-all` → all of the above with unrestricted lists.

A denied capability surfaces as `AfterburnerError::Host("permission denied: ...")` — the same structured error path the host-call layer already emits today.

Deno-parity rationale: users already know this model. Copying the flag names lowers the cognitive overhead.

### 5.4 Two envelopes in `afterburner-plugin`

Today's envelope is UDF-shaped: `module.exports = function(data) {...}`, stdin JSON becomes `data`, return value writes to stdout. `burn run` wants top-level JS (no `data`, no stdout JSON wrapping).

Add a **script envelope** alongside the UDF envelope:

- Existing UDF envelope stays byte-for-byte identical (do not regress throughput).
- New script envelope: evaluate source as an ES module with top-level `await`, no stdin injection, no stdout wrapping. `console.log` goes through the existing host log hook.
- `afterburner-plugin` reads a **1-byte mode prefix** from `stdin_buf`: `0x01` UDF (legacy default), `0x02` script. All existing call sites write `0x01`; the `burn run` path writes `0x02`.

The `abi_parity.rs` drift test extends to cover both envelopes' imports — anything imported in one but not the other is a drift error.

Future optional mode bytes: `0x03` ES-module-with-exports, `0x04` classic script (for legacy code that uses `var` top-level). Not in this plan.

### 5.5 REPL (`burn repl`)

Minimal: `rustyline` prompt. Each submitted line is `register`ed as a fresh `ScriptId` (script envelope) and run with `null` input. Meta-commands: `:fuel N`, `:mode M`, `:allow net`, `:clear`, `:help`, `:exit`.

**Persistence caveat:** JS state does not persist across lines. Each line = fresh `Store`. This is a direct consequence of the "fresh per-call JS state" invariant (§1 of the threading plan). Documented in `burn help repl` and the README; adding persistence would require keeping `Runtime`/`Context` alive across lines, which breaks that invariant and isn't worth it for a debug REPL.

### 5.6 Binary = ~30 LoC on top of library

`afterburner/src/bin/burn.rs` is thin. All execution logic lives in the library. A user can reimplement `burn` in ~30 lines — proven by `examples/burn-embedding/`.

```rust
// sketch of burn.rs
let cli = BurnCli::parse();
let ab = build_afterburner_from_flags(&cli)?;
match cli.command {
    Cmd::Run(f)    => run_script_file(&ab, &f),
    Cmd::Eval(c)   => run_script_source(&ab, &c),
    Cmd::Thrust(f) => thrust_from_stdin(&ab, &f),
    Cmd::Repl      => repl_loop(&ab),
    Cmd::Bench(f)  => bench(&ab, &f, cli.iters, cli.workers),
    Cmd::Check(f)  => compile_only(&ab, &f),
    Cmd::Version   => print_version(),
}
```

### 5.7 Installation

`cargo install afterburner --features bin` installs the `burn` binary on `$PATH`. Users then type `burn ./script.js` and go. `cargo install --path afterburner --features bin` is the equivalent from a local checkout.

The `bin` feature guard avoids installing `clap`/`rustyline` for library users.

### 5.8 Non-goals

- **No npm compatibility.** `require('lodash')` fails with "module not found". Stdlib-ish surface only (`crypto`, `buffer`, basic timers, `console`).
- **No TypeScript compilation.** `.ts` accepted as extension but treated as plain JS. Full TS is a separate project (see `docs/IMPL_PLAN_REMAINING_WORK.md`).
- **No `--watch` / hot reload.** Not in scope.
- **No distributed `burn` nodes.** `burn` is a local process. Distributing thrusts across boxes is a separate project.

---

## 6. The `examples/` project

### 6.1 Layout — each subdir is a fully standalone project

```
examples/
├── README.md               index of examples + what each demonstrates
├── basic/
│   ├── Cargo.toml          [package] + own [dependencies] + own [workspace] root
│   ├── Cargo.lock          committed per-example; reproducible
│   ├── README.md
│   └── src/main.rs
├── udf-batch/           same shape
├── flow-data-chain/
├── parallel-thrust/
├── fetch-and-env/
├── burn-embedding/
└── streaming-crypto/
```

**No top-level `examples/Cargo.toml` exists.** Critically, there is no shared `[workspace.dependencies]` — each example pins every version it needs in its own `[dependencies]` independently.

Typical example `Cargo.toml` (e.g. `examples/basic/Cargo.toml`):

```toml
[package]
name    = "afterburner-example-basic"
version = "0.1.0"
edition = "2024"
publish = false

# Standalone-workspace marker. Without this, Cargo would walk up the tree
# searching for a [workspace] and attach this example to the afterburner root —
# which is *not* what we want. This empty stanza says "I am my own workspace."
[workspace]

[dependencies]
afterburner = { path = "../../afterburner" }   # published: `afterburner = "0.1"`
serde_json  = "1"
anyhow      = "1"
```

`parallel-thrust` might pin `tokio = "1.40"` in *its* `Cargo.toml` with nobody else caring; `fetch-and-env` might pin `reqwest = "0.12"` only for itself; `udf-batch` might depend on nothing beyond `serde_json`. No pin is shared or forced. That is the whole point of "completely separate."

Building / running:

```bash
cd examples/basic
cargo run                   # resolves afterburner via its own path dep + own lockfile
```

Users copying an example into a fresh project do this and it just works — no "also copy the workspace `Cargo.toml`" surprise.

### 6.2 The seven starter examples

Each has its own `Cargo.toml` (shape above), `src/main.rs`, `Cargo.lock`, and `README.md`. Each is ≤ 50 LoC of Rust.

- **`basic`** — `Afterburner::new()`, register, run, assert output. ~15 lines. The "hello world."
- **`udf-batch`** — Register one transform, apply to 10 000 records via `run_batch`. Prints rows/sec. Shows the batched-UDF idiom.
- **`flow-data-chain`** — `Afterburner::builder().flow().build()` then `ab.register(source)?; ab.run(&id, &data_chain)?`. Internally delegates to `afterburner_flow::FlowEngine::load` + `::execute`. Also demonstrates `ab.register_bundle(entry, &modules)` for multi-file ES module loads. Gated on `feature = "flow"`.
- **`parallel-thrust`** — `Afterburner::builder().threaded(8).build()`, fan 10 000 thrusts in, collect outputs, print throughput + p99 latency. Gated on `feature = "thrust"` (default).
- **`fetch-and-env`** — Custom `HostContext` that allows `fetch` for a single allow-listed hostname; script pulls from that URL. Gated on `feature = "host-http"`.
- **`burn-embedding`** — Reimplement `burn run` in ~30 lines using only the `afterburner` public API. Proves the binary is thin.
- **`streaming-crypto`** — Script hashes a large buffer via `crypto.createHash` + `update` chunks. Demonstrates the handle-based streaming API end-to-end.

Each example's README states: what it demonstrates, expected output, the equivalent `burn` one-liner (if any), and the Cargo features it relies on.

---

## 7. Phase breakdown

| Phase | Effort | Gates |
|---|---|---|
| U0 — `afterburner` facade scaffold (re-exports + `Afterburner::new()`) | 0.5 d | `cargo add afterburner` + `ab.new().register(...).run(...)` round-trips a trivial script. |
| U1 — `AfterburnerBuilder` + mode selection (native/wasm/adaptive) | 0.5 d | Builder tests cover all three modes + `FuelGauge` + `Manifold` + `HostContext`. |
| U2 — `threaded(N)` wraps `ThrustEngine`; `run_batch` helper | 1 d | `examples/parallel-thrust` scales linearly with workers; matches T8 perf numbers within 5 %. |
| U3 — `burn` binary skeleton + `run` + `eval` + script-mode envelope in plugin | 2 d | `burn -e "console.log(1+2)"` prints `3`; `burn script.js` with top-level code works. |
| U4 — `burn thrust` + `burn check` + global `--fuel/--memory/--timeout` | 1 d | `echo '{"n":41}' \| burn thrust plus.js` prints `{"n":42}`. |
| U5 — Capability grants (`--allow-net`, `--allow-fs`, `--allow-env`, `-A`) | 2 d | Grants correctly gate `Manifold` + `HostContext`; deny-by-default confirmed via negative tests. |
| U6 — `burn repl` + `burn bench` + `burn version` | 1 d | REPL accepts multi-line input; bench reports throughput + p99. |
| U7 — `examples/` directory + all 7 standalone starter example projects | 1.5 d | Each `cd examples/<name> && cargo run` succeeds from a fresh clone and prints its expected output; no shared workspace/lockfile between examples. |
| U8 — Docs: root README, crate docs (`cargo doc -p afterburner`), `burn --help` quality pass | 1 d | `cargo doc --open -p afterburner` renders; root README walks a first-time user from install to running `burn ./hello.js`. |

**Critical path: U0 → U1 → U2 → U3 → U4 → U7.** U5 and U6 are orthogonal quality-of-life adds; U8 is the launch gate.

Total: ~10 engineering days critical path, ~12 with U5/U6 inline.

---

## 8. Adjustments needed inside `IMPL_PLAN_THREADING.md`

Three small API-shape commitments to be made in the threading plan's T0 / T2, specifically so the facade can wrap `ThrustEngine` without re-design:

1. **`ThrustEngine::new` returns `Result<Arc<Self>, AfterburnerError>`** (not a bare `Self`). The facade shares one engine across clones of `Afterburner`.
2. **`ThrustEngineConfig: Clone`.** The builder stores a config snapshot before calling `ThrustEngine::new`, which needs `Clone`.
3. **`ThrustHandle` exposes `recv()`, `try_recv()`, and `recv_timeout(Duration)`.** The threading plan already has `recv` and `try_recv`; `recv_timeout` is added for `burn bench` (per-iteration deadline) and the `parallel-thrust` example.

None of these changes the internals of the threading plan — they're API-surface nits. Made visible here so T0 reviewers catch them early.

---

## 9. Risks

- **Feature-flag explosion.** `afterburner` will expose ≥ 7 features (`wasm`, `native`, `adaptive`, `thrust`, `flow`, `host-http`, `host-fs`, `bin`). Mitigation: the default set (`wasm` + `native` + `thrust`) covers 90 % of users; flow/host-http/host-fs stay opt-in. CI matrix tests the cross-product up to a reasonable bound.
- **Script-mode envelope diverges from UDF envelope.** Two code paths in `afterburner-plugin` ⇒ drift risk. Mitigation: shared internal helpers in the plugin; extend `abi_parity.rs` to cover both envelopes.
- **Cargo workspace quirks with sibling workspaces.** If the root workspace accidentally resolves `examples/` as a member despite `exclude`, builds will break subtly. Mitigation: add a CI job that runs `cargo metadata --format-version 1 | jq '.workspace_members'` and asserts the list matches the expected set.
- **`cargo install afterburner` pulls ~2 MB of plugin binary.** Acceptable; smaller than `deno` (~80 MB) or `bun` (~50 MB). Document the size in the README.
- **Capability grants need host-side enforcement that isn't all wired today.** `Manifold` already has `FsAccess`/`NetAccess`/`EnvAccess` shapes, so the facade's `.allow_fs(...)`/`.allow_net(...)`/`.allow_env(...)` methods can thread through `Manifold`. But `afterburner-wasi` only has the `host-http` feature gate and `afterburner-node-compat` has no feature flags at all — `host-fs` needs to be added to both crates before U5 can enforce fs capability grants end-to-end. Budget that in U5; do not ship half-enforced grants.
- **REPL state doesn't persist across lines.** Users will hit this. Mitigated by up-front docs in `burn help repl` and a clear error/message. Adding persistence breaks the fresh-per-call invariant and isn't worth it for a debug REPL.
- **Binary name collision (`burn`).** Some distros ship a legacy `burn` (CD-recording tool). Mitigation: ship a `[[bin]] name = "afterburn"` alongside; users pick. Default primary name stays `burn`.

---

## 10. Verification — gates at end of U8

1. `cargo build --workspace` clean; `cargo clippy --all-targets --all-features -- -D warnings` clean.
2. `cargo test --workspace` passes (existing 167+ tests + new facade + `burn` unit tests).
3. From a fresh clone: `cargo install --path afterburner --features bin` → `burn` on `$PATH`.
4. `echo '{"n":41}' | burn thrust <(echo 'module.exports = d => ({ n: d.n + 1 });')` outputs `{"n":42}`.
5. `burn -e "console.log(2+2)"` prints `4` on stdout, exit 0.
6. `burn bench plus.js --iters 100000 --workers 8` reports ≥ 100 k thrusts/sec (matches T8 target).
7. Each of the seven examples builds and runs standalone: `cd examples/<name> && cargo run` prints its documented expected output, from a fresh clone, with no shared lockfile or workspace.
8. Capability grants: `burn --allow-net=api.example.com fetch.js` succeeds; `burn fetch.js` fails with `permission denied`.
9. `cargo doc --open -p afterburner` renders the public API; no re-export dead-ends.
10. Root `README.md` walks a first-time user from `cargo install afterburner --features bin` → first working script in < 2 minutes, verified by a fresh-contributor smoke test.

---

## 11. Explicit non-goals

- **No npm / node_modules compatibility.** `require('lodash')` will not work.
- **No TypeScript compilation.** Extensions are ignored; input must be JS.
- **No `--watch` / hot-reload.** Not in this plan.
- **No distributed `burn` orchestration.** One process, one box. Cluster-scale is a different project.
- **No WASI Preview 2 / component model adoption.** Stays at Preview 1 for now (per `IMPL_PLAN_REMAINING_WORK.md` decision).
- **No stable crate-API commitment.** `afterburner` is `0.y.z` during this plan; breaking changes allowed between `0.y` bumps.

---

## 12. Open questions

1. **Primary binary name.** Ship primarily as `burn` with `afterburn` alias, or primarily as `afterburn` with `burn` alias? Default here: `burn` primary (per user ask), `afterburn` alias via a second `[[bin]]` entry. Confirmable at U8 launch.
2. **REPL scope.** Ship the minimal per-line-fresh-`Store` REPL in U6, or defer the REPL entirely to a later release? Default here: ship in U6. It's small, and even a stateless REPL is worth shipping for quick syntax checks.
3. **Examples publishing.** Keep `examples/*/Cargo.toml` on `afterburner = { path = ".." }` forever, or switch to `afterburner = "0.1"` after first crates.io publish? Default: path-based until first publish; switch with a `[patch.crates-io]` escape hatch after.
4. **Capability-grant list format.** Use `--allow-net=host1,host2` (comma-separated) or `--allow-net=host1 --allow-net=host2` (repeatable)? Deno uses comma; that's the precedent. Default: comma-separated.

---

**Ready to execute after `IMPL_PLAN_THREADING.md` T0–T8 complete.**

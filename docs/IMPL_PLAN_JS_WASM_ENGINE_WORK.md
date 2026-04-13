# Implementation Plan: Afterburner — JavaScript-to-WASM Compilation & Execution Engine

**Project name:** Afterburner
**Workspace:** `afterburner/`
**Language:** Rust
**Priority:** High — enables user-defined functions, Directus flow operations, streaming transforms
**Status:** Research Complete — Implementation Not Started

---

## Naming Convention

### Project Identity

| Element | Name | Rationale |
|---------|------|-----------|
| Project | **Afterburner** | Scramjet reheat stage. JS scripts fire in the exhaust of the query pipeline. |
| Workspace root | `afterburner/` | Cargo workspace containing all sub-crates |
| Core engine crate | `afterburner-core` | Engine trait, registry, error types |
| WASM sandbox crate | `afterburner-wasi` | Wasmtime + QuickJS WASM provider |
| Native engine crate | `afterburner-ignite` | rquickjs direct FFI (trusted code path) |
| Directus extension | `directus-extension-reheat` | Directus convention. "Reheat" = afterburner's technical name. Short, distinct. |
| npm scope | `@scramdb/afterburner` | Directus marketplace publishing |
| CLI tool (optional) | `burn` | `burn compile script.js`, `burn exec script.burn` |

### File Extensions

| Extension | Content | Analogy |
|-----------|---------|---------|
| `.burn` | Compiled WASM module (QuickJS bytecode embedded) | `.jetx` (ScramVM bytecode) |
| `.abx` | Afterburner executable — pre-compiled Cranelift artifact | `.jetz` (ScramVM JIT machine code) |
| `.ash` | Execution trace / debug dump | Post-combustion residue |

### Internal Naming

| Rust Symbol | Purpose |
|-------------|---------|
| `Combustor` | Core engine trait — where fuel (JS) meets air (data) |
| `Intake` | Input deserializer — data chain → JS globals |
| `Nozzle` | Output serializer — JS return value → data chain JSON |
| `FuelGauge` | Execution resource limits — fuel metering, memory cap, timeout |
| `ignite()` | Compile JS source → `.burn` module |
| `thrust()` | Execute compiled module, produce output |
| `extinguish()` | Release compiled script resources |

---

## Problem Statement

ScramDB (and any Rust-native query engine operating on data flows) needs to execute user-supplied JavaScript safely and fast. Three concrete use cases drive this:

1. **ScramDB UDFs** — User-defined scalar/aggregate functions written in JS, callable from SQL (`SELECT js_transform(col) FROM t`). Must run inside the morsel-driven pipeline without blocking other pipelines.
2. **Directus Flow Operations** — Directus runs JS in its "Run Script" operation inside `isolated-vm` (replaced `vm2` after CVE GHSA-22rr-f3p8-5gf8). The sandbox is Node.js-specific, cannot call native modules, no FS/network access. A WASM-based replacement gives: deterministic execution, cross-platform portability, fuel-based CPU limiting, memory hard caps, and zero sandbox-escape attack surface.
3. **Streaming/ETL transforms** — JS functions applied per-record or per-batch in CDC/Kafka pipelines (Phase 8 in ROAD_TO_PROD).

### Why compile JS → WASM instead of embedding a JS interpreter directly?

| Approach | Startup | Throughput | Sandbox | Binary Size | Determinism |
|----------|---------|------------|---------|-------------|-------------|
| Embed V8 (rusty_v8) | ~50ms | Excellent (JIT) | Process-level | +30MB | Non-deterministic (JIT) |
| Embed QuickJS (rquickjs) | <1ms | Moderate (interpreter) | Manual limits | +210KB | Deterministic |
| QuickJS → bytecode → WASM (Javy model) | ~5ms | Good (AOT) | WASM sandbox | ~1MB static-linked | Deterministic |
| JS AOT → WASM (JAWSM model) | ~10ms | Good | WASM sandbox | ~50KB per script | Deterministic |
| **Chosen: QuickJS-in-WASM (Javy model)** | **~5ms** | **Good** | **WASM sandbox** | **~16KB dynamic** | **Deterministic** |

The Javy model (Bytecode Alliance) compiles QuickJS itself to WASM once, then each user script becomes a thin WASM component (~1-16KB with dynamic linking) that imports the shared QuickJS engine module. This gives WASM's hard sandbox guarantees (memory isolation, fuel metering, no syscalls unless explicitly imported) while retaining near-complete ES2020 conformance from QuickJS.

JAWSM (direct JS→WASM compiler) is promising but only passes ~25% of test262. Not production-viable yet.

---

## Research Foundation

### Primary References

| Source | Key Insight |
|--------|-------------|
| **Javy** (Bytecode Alliance) — `github.com/bytecodealliance/javy` | QuickJS compiled to `wasm32-wasi`. Dynamic linking produces 1-16KB modules. Production-used at Shopify for serverless functions. |
| **Wasmtime** — `github.com/bytecodealliance/wasmtime` | Cranelift-based WASM runtime. Rust-native embedding. Fuel metering, epoch interrupts, memory limits. Production-grade security (fuzzing, `cargo vet`). |
| **rquickjs** — `crates.io/crates/rquickjs` | High-level safe Rust bindings to QuickJS-NG. ES2020, <300μs lifecycle, 1.5M downloads. Alternative to WASM path for direct embedding. |
| **StarlingMonkey AOT** (cfallin.org, Aug 2024) | SpiderMonkey + weval partial evaluator. AOT JS→WASM achieving 3-5x speedup over interpreter. Passes all SM test suites. Shows ceiling of what's achievable. |
| **Directus Sandbox** (directus.io/docs) | `isolated-vm` sandbox for Run Script. No FS, no network, no node_modules. Input→JSON→output. Scope-based permissions for sandboxed extensions. |
| **Kohn et al. "Adaptive Execution" (PVLDB 2018)** | Flying Start principle: start executing immediately with fast-compile tier, switch to optimized tier at morsel boundary when ready. Applies to WASM module instantiation. |

### Existing Projects Evaluated

| Project | Language | Model | Maturity | Verdict |
|---------|----------|-------|----------|---------|
| **Javy** | Rust | QuickJS→WASM bytecode | Production (Shopify) | **Use as reference architecture** |
| **JAWSM** | Rust | JS AST→WAT→WASM | 25% test262, PoC | Too immature |
| **Porffor** | JS/TS | JS AOT→WASM | 39% ECMA-262 | Too immature |
| **AssemblyScript** | TS | TS-subset→WASM | Mature | Not JS-compatible (strict subset) |
| **rquickjs** | Rust | Direct FFI to QuickJS C | Mature (1.5M downloads) | **Fallback: simpler, no WASM sandbox** |
| **Boa** | Rust | Pure Rust JS engine | Experimental | Incomplete ES coverage |
| **StarlingMonkey** | C++/Rust | SpiderMonkey→WASM+AOT | Beta | Too heavy for embedding |

### Decision: Dual-Mode Architecture

Implement **both** paths behind a trait interface:

1. **`WasmMode`**: QuickJS compiled to WASM, executed via Wasmtime. Full sandbox. Use for untrusted code (Directus flows, user UDFs).
2. **`NativeMode`**: QuickJS via `rquickjs` FFI. No WASM overhead. Use for trusted code (internal transforms, admin scripts).

The trait interface (`Combustor`) allows the caller to select mode based on trust level.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   afterburner workspace                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐  │
│  │  Combustor   │    │  BurnCache                    │  │
│  │  (trait)      │    │  - ignite(src) → ScriptId    │  │
│  │              │    │  - thrust(id, input) → output │  │
│  │  ┌──────────┐│    │  - cache: HopscotchMap<Hash>  │  │
│  │  │WasmCom-  ││    └──────────────────────────────┘  │
│  │  │bustor    ││                                       │
│  │  │ wasmtime  ││    ┌──────────────────────────────┐  │
│  │  │ + quickjs ││    │  HostFunctions                │  │
│  │  │   .wasm   ││    │  - log(msg)                   │  │
│  │  └──────────┘│    │  - read_column(name) → Vec    │  │
│  │  ┌──────────┐│    │  - emit_row(json)             │  │
│  │  │NativeCom-││    │  - get_env(key) → Option<str> │  │
│  │  │bustor    ││    └──────────────────────────────┘  │
│  │  │ rquickjs  ││                                       │
│  │  └──────────┘│                                       │
│  └──────────────┘                                       │
├─────────────────────────────────────────────────────────┤
│  Integration Points:                                    │
│  - ScramDB: UDF operator in pipeline (PipelineOp::Js)  │
│  - Directus: directus-extension-reheat (Run Script)    │
│  - Streaming: per-record transform in CDC pipeline     │
└─────────────────────────────────────────────────────────┘
```

### Data Flow (Directus Flow Compatibility)

```
Directus "Run Script" operation contract:
  Input:  module.exports = function(data) { return { key: value }; }
  data:   { $trigger: {...}, $last: {...}, opKey1: {...}, ... }
  Output: JSON object appended to data chain under operationKey

WASM execution flow:
  1. JS source string → QuickJS bytecode (via Javy compile)
  2. Bytecode embedded in thin WASM module
  3. Wasmtime instantiates module with fuel limit + memory cap
  4. Host provides: stdin (JSON input), stdout (JSON output)
  5. Module runs, produces JSON on stdout
  6. Host reads stdout, deserializes, returns to caller
```

---

## Implementation Steps

### Step 0: Workspace Scaffold (0.5 day)

```
afterburner/
├── Cargo.toml                          # Workspace root
├── README.md
│
├── afterburner-core/                   # Engine trait, registry, types
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                      # pub mod engine, registry, error
│       ├── engine.rs                   # Combustor trait definition
│       ├── registry.rs                 # BurnCache — content-addressed cache
│       ├── types.rs                    # ScriptId, FuelGauge (FuelGauge), EngineMode
│       └── error.rs                    # AfterburnerError
│
├── afterburner-wasi/                   # WASM sandbox engine (untrusted code)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── wasm_engine.rs             # WasmCombustor — Wasmtime + QuickJS WASM
│       ├── compiler.rs                # Ignition: JS source → .burn (WASM module bytes)
│       ├── host.rs                    # Host function imports (log, env, http scope)
│       ├── intake.rs                  # JSON input → WASI stdin serialization
│       └── nozzle.rs                  # WASI stdout → JSON output deserialization
│
├── afterburner-ignite/                 # Native engine (trusted code, no WASM overhead)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       └── native_engine.rs           # NativeCombustor — rquickjs FFI
│
├── afterburner-directus/               # Directus integration layer
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── flow_engine.rs             # ReheatEngine — Run Script replacement
│       └── data_chain.rs              # $trigger/$last/operationKey mapping
│
├── afterburner-adaptive/               # Flying Start tier switching
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       └── adaptive.rs                # AdaptiveCombustor — native-first, WASM-cached
│
├── quickjs-provider/                   # Pre-built QuickJS WASM binary (from Javy)
│   └── quickjs_provider.wasm
│
├── directus-extension-reheat/          # Directus extension package (npm)
│   ├── package.json                   # { "directus:extension": { "type": "operation" } }
│   ├── src/
│   │   ├── api.ts                     # Operation handler — calls afterburner via FFI/HTTP
│   │   └── app.ts                     # Operation UI config (code editor)
│   └── tsconfig.json
│
└── tests/
    ├── basic_eval.rs
    ├── sandbox_security.rs
    ├── fuel_limits.rs
    ├── directus_compat.rs
    ├── data_flow.rs
    └── adaptive_tier.rs
```

**Workspace Cargo.toml:**
```toml
[workspace]
members = [
    "afterburner-core",
    "afterburner-wasi",
    "afterburner-ignite",
    "afterburner-directus",
    "afterburner-adaptive",
]
resolver = "2"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
thiserror = "2"
kovan-map = { path = "../kovan-map" }
```

**afterburner-core/Cargo.toml:**
```toml
[package]
name = "afterburner-core"
version = "0.1.0"
edition = "2021"

[dependencies]
serde.workspace = true
serde_json.workspace = true
sha2.workspace = true
thiserror.workspace = true
kovan-map.workspace = true
```

**afterburner-wasi/Cargo.toml:**
```toml
[package]
name = "afterburner-wasi"
version = "0.1.0"
edition = "2021"

[dependencies]
afterburner-core = { path = "../afterburner-core" }
wasmtime = { version = "28", features = ["cranelift", "cache"] }
wasmtime-wasi = "28"
serde.workspace = true
serde_json.workspace = true
kovan-map.workspace = true
```

**afterburner-ignite/Cargo.toml:**
```toml
[package]
name = "afterburner-ignite"
version = "0.1.0"
edition = "2021"

[dependencies]
afterburner-core = { path = "../afterburner-core" }
rquickjs = { version = "0.11", features = ["bindgen"] }
serde.workspace = true
serde_json.workspace = true
```

**afterburner-directus/Cargo.toml:**
```toml
[package]
name = "afterburner-directus"
version = "0.1.0"
edition = "2021"

[dependencies]
afterburner-core = { path = "../afterburner-core" }
afterburner-wasi = { path = "../afterburner-wasi" }
serde.workspace = true
serde_json.workspace = true
```

**afterburner-adaptive/Cargo.toml:**
```toml
[package]
name = "afterburner-adaptive"
version = "0.1.0"
edition = "2021"

[dependencies]
afterburner-core = { path = "../afterburner-core" }
afterburner-wasi = { path = "../afterburner-wasi" }
afterburner-ignite = { path = "../afterburner-ignite" }
kovan-map.workspace = true
```

**directus-extension-reheat/package.json:**
```json
{
  "name": "directus-extension-reheat",
  "version": "0.1.0",
  "description": "WASM-sandboxed JavaScript execution for Directus Flows — powered by Afterburner",
  "directus:extension": {
    "type": "operation",
    "path": "dist/api.js",
    "source": "src/api.ts",
    "host": "^10.7.0",
    "sandbox": {
      "enabled": false
    }
  },
  "keywords": ["directus", "extension", "wasm", "javascript", "sandbox", "afterburner"],
  "author": "ScramDB <theo@scramdb.com>",
  "license": "PROPRIETARY"
}
```

### Step 1: Combustor Trait — afterburner-core (0.5 day)

```rust
// afterburner-core/src/engine.rs

/// The Combustor trait — where fuel (JS) meets air (data).
/// Two implementations: WasmCombustor (sandboxed) and NativeCombustor (trusted).
pub trait Combustor: Send + Sync {
    /// Ignition: compile JS source to an internal representation.
    /// Returns an opaque handle for repeated invocation.
    fn ignite(&self, source: &str) -> Result<ScriptId, AfterburnerError>;

    /// Thrust: execute a compiled script with JSON input, return JSON output.
    fn thrust(
        &self,
        id: &ScriptId,
        input: &serde_json::Value,
        fuel_gauge: &FuelGauge,
    ) -> Result<serde_json::Value, AfterburnerError>;

    /// Release compiled script resources.
    fn extinguish(&self, id: &ScriptId);
}

// afterburner-core/src/types.rs

/// Execution resource limits — fuel metering for the combustion chamber.
pub struct FuelGauge {
    pub fuel: Option<u64>,           // WASM instruction budget
    pub memory_bytes: Option<usize>, // Linear memory cap
    pub timeout_ms: Option<u64>,     // Wall-clock timeout
}

pub struct ScriptId {
    pub hash: [u8; 32],  // SHA-256 of source
    pub mode: EngineMode,
}

pub enum EngineMode { Wasm, Native }
```

### Step 2: WasmCombustor — afterburner-wasi (2 days)

**2a. Obtain QuickJS WASM provider module**

Two options (try in order):
1. Build Javy from source: `cargo install javy-cli`, which produces `quickjs_provider.wasm`
2. Download pre-built release from `github.com/bytecodealliance/javy/releases`

The provider module is a ~869KB WASM binary containing the full QuickJS runtime. With dynamic linking, user scripts become ~1-16KB stubs that import from this shared provider.

**2b. Wasmtime engine setup**

```rust
// afterburner-wasi/src/wasm_engine.rs

pub struct WasmCombustor {
    engine: wasmtime::Engine,
    provider_module: wasmtime::Module,     // Pre-compiled QuickJS provider
    linker: wasmtime::Linker<HostState>,
    script_cache: kovan_map::HopscotchMap<[u8; 32], wasmtime::Module>,
}

struct HostState {
    wasi: wasmtime_wasi::WasiCtx,
    stdin_buf: Vec<u8>,
    stdout_buf: Vec<u8>,
}

impl WasmCombustor {
    pub fn new(config: WasmConfig) -> Result<Self> {
        let mut engine_config = wasmtime::Config::new();
        engine_config.consume_fuel(true);              // Enable fuel metering
        engine_config.epoch_interruption(true);         // Enable epoch-based interrupts
        engine_config.memory_init_cow(true);            // Copy-on-write for fast instantiation
        engine_config.cranelift_opt_level(OptLevel::Speed);

        let engine = wasmtime::Engine::new(&engine_config)?;
        let provider_module = wasmtime::Module::from_binary(
            &engine,
            include_bytes!("../../quickjs-provider/quickjs_provider.wasm"),
        )?;

        // ... linker setup with WASI
        Ok(Self { engine, provider_module, linker, script_cache: kovan_map::HopscotchMap::new() })
    }
}
```

**2c. Ignition: JS source → `.burn` module**

```rust
// afterburner-wasi/src/compiler.rs

fn ignite(&self, source: &str) -> Result<ScriptId> {
    let hash = sha256(source);

    if self.script_cache.contains_key(&hash) {
        return Ok(ScriptId { hash, mode: EngineMode::Wasm });
    }

    // Option A: Use Javy as a library (if javy-core is available as crate)
    // Option B: Shell out to `javy compile` CLI
    // Option C: Bundle QuickJS bytecode manually

    // For Option C (most portable):
    // 1. Use QuickJS to compile JS to bytecode
    // 2. Embed bytecode in a minimal WASM module that imports the provider
    // 3. The module's _start calls provider's eval_bytecode(bytecode_ptr, len)

    let wasm_bytes = self.compile_js_to_wasm(source)?;
    let module = wasmtime::Module::new(&self.engine, &wasm_bytes)?;
    self.script_cache.insert(hash, module);

    Ok(ScriptId { hash, mode: EngineMode::Wasm })
}
```

**2d. Thrust: execute with FuelGauge limits**

```rust
// afterburner-wasi/src/wasm_engine.rs
fn thrust(
    &self,
    id: &ScriptId,
    input: &serde_json::Value,
    limits: &FuelGauge,
) -> Result<serde_json::Value> {
    let module = self.script_cache.get(&id.hash)
        .ok_or(AfterburnerError::ScriptNotFound)?;

    let input_bytes = serde_json::to_vec(input)?;

    // Create per-invocation store with limits
    let mut store = wasmtime::Store::new(&self.engine, HostState::new(input_bytes));

    if let Some(fuel) = limits.fuel {
        store.set_fuel(fuel)?;
    }

    // Memory limit via Wasmtime's ResourceLimiter
    store.limiter(|state| &mut state.limiter);

    // Epoch-based timeout
    if let Some(timeout_ms) = limits.timeout_ms {
        let engine = self.engine.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout_ms));
            engine.increment_epoch();
        });
        store.epoch_deadline_trap();
        store.set_epoch_deadline(1);
    }

    // Instantiate and run
    let instance = self.linker.instantiate(&mut store, &module)?;
    let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
    start.call(&mut store, ())?;

    // Read stdout
    let output_bytes = &store.data().stdout_buf;
    let output: serde_json::Value = serde_json::from_slice(output_bytes)?;
    Ok(output)
}
```

### Step 3: NativeCombustor — afterburner-ignite (1.5 days)

```rust
// afterburner-ignite/src/native_engine.rs
pub struct NativeCombustor {
    runtime: rquickjs::Runtime,
}

impl Combustor for NativeCombustor {
    fn ignite(&self, source: &str) -> Result<ScriptId> {
        // QuickJS compiles to bytecode internally
        let hash = sha256(source);
        // Store source; QuickJS re-parses fast (<300μs)
        Ok(ScriptId { hash, mode: EngineMode::Native })
    }

    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        self.runtime.set_memory_limit(
            limits.memory_bytes.unwrap_or(16 * 1024 * 1024)
        );

        // rquickjs has interrupt_handler for CPU limits
        let counter = Arc::new(AtomicU64::new(0));
        let fuel = limits.fuel.unwrap_or(u64::MAX);
        let counter_clone = counter.clone();
        self.runtime.set_interrupt_handler(Some(Box::new(move || {
            counter_clone.fetch_add(1, Ordering::Relaxed) >= fuel
        })));

        self.runtime.context().with(|ctx| {
            // Inject input as global `data`
            let data = ctx.json_to_js(input)?;
            ctx.globals().set("__input__", data)?;

            // Wrap user code in Directus-compatible envelope
            let wrapped = format!(
                r#"
                const __fn__ = (function() {{ {source} }})();
                const __result__ = (typeof __fn__ === 'function')
                    ? __fn__(__input__)
                    : __fn__;
                JSON.stringify(__result__);
                "#,
                source = self.source_cache.get(&id.hash).unwrap()
            );

            let result: String = ctx.eval(wrapped)?;
            Ok(serde_json::from_str(&result)?)
        })
    }
}
```

### Step 4: BurnCache — afterburner-core (1 day)

```rust
// afterburner-core/src/registry.rs
pub struct BurnCache {
    engine: Box<dyn Combustor>,
    compiled: kovan_map::HopscotchMap<[u8; 32], ScriptId>,
    source_store: kovan_map::HopscotchMap<[u8; 32], String>,  // For recompilation / debugging
    stats: RegistryStats,
}

impl BurnCache {
    /// Compile-or-cache. Idempotent. Thread-safe.
    pub fn register(&self, source: &str) -> Result<ScriptId> {
        let hash = sha256(source);
        if let Some(id) = self.compiled.get(&hash) {
            self.stats.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Ok(id.clone());
        }
        self.stats.cache_misses.fetch_add(1, Ordering::Relaxed);
        let id = self.engine.ignite(source)?;
        self.source_store.insert(hash, source.to_string());
        self.compiled.insert(hash, id.clone());
        Ok(id)
    }

    /// Execute with limits. Creates isolated instance per call.
    pub fn execute(
        &self,
        id: &ScriptId,
        input: &serde_json::Value,
        limits: &FuelGauge,
    ) -> Result<serde_json::Value> {
        self.engine.thrust(id, input, limits)
    }
}
```

### Step 5: Host Functions — afterburner-wasi (1.5 days)

Define the host API surface available to JS scripts running inside WASM:

```rust
/// Host functions importable by JS scripts.
/// Registered via Wasmtime's Linker before instantiation.
pub enum HostFunction {
    /// Log a message (debug/info/warn/error)
    Log { level: LogLevel, message: String },

    /// Read a named column from the current morsel (ScramDB UDF context)
    ReadColumn { name: String } -> Vec<Value>,

    /// Emit a transformed row (streaming/ETL context)
    EmitRow { row: serde_json::Value },

    /// Read environment variable (allow-listed)
    GetEnv { key: String } -> Option<String>,

    /// HTTP request (Directus sandbox scope: method + URL allow-list)
    HttpRequest { url: String, method: String, body: Option<String> }
        -> HttpResponse,
}
```

For **ScramDB UDFs**, the integration point is a new pipeline operator:

```rust
/// New variant in PipelineOp
PipelineOp::JsTransform {
    script_id: ScriptId,
    input_columns: Vec<ColumnRef>,   // Columns passed to JS function
    output_schema: Schema,           // Expected output columns
    limits: FuelGauge,
}
```

The operator processes each morsel by:
1. Converting input columns to JSON array-of-objects
2. Calling `registry.thrust(script_id, input_json, limits)`
3. Converting JSON output back to columnar Borax format
4. Passing result downstream

### Step 6: ReheatEngine — afterburner-directus (1.5 days)

```rust
// afterburner-directus/src/flow_engine.rs
/// Directus Run Script contract:
/// - Input: data chain as JSON object
/// - Script: `module.exports = function(data) { return {...}; }`
/// - Output: JSON object (appended under operationKey)
///
/// Additional constraints matching Directus behavior:
/// - No require/import (no node modules)
/// - No fs, net, process, child_process
/// - No setTimeout/setInterval (not available in WASI)
/// - console.log maps to host Log function
pub struct ReheatEngine {
    registry: BurnCache,
    default_fuel: FuelGauge,
}

impl ReheatEngine {
    pub fn new() -> Self {
        Self {
            registry: BurnCache::new(Box::new(WasmCombustor::new(Default::default()).unwrap())),
            default_fuel: FuelGauge {
                fuel: Some(1_000_000_000),    // ~10 seconds of compute
                memory_bytes: Some(64 * 1024 * 1024),  // 64MB
                timeout_ms: Some(30_000),     // 30 second wall-clock
            },
        }
    }

    /// Execute a Directus "Run Script" operation
    pub fn run_script(
        &self,
        source: &str,
        data_chain: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id = self.registry.register(source)?;
        self.registry.thrust(&id, data_chain, &self.default_fuel)
    }
}
```

### Step 7: AdaptiveCombustor — afterburner-adaptive (1 day)

Apply the same principle from IMPL_PLAN_v16 (Adaptive Execution):

```
First invocation of JS UDF:
  1. Hash source → check cache → miss
  2. IMMEDIATE: Execute via NativeCombustor (rquickjs, <300μs startup)
  3. BACKGROUND: Compile JS→WASM module (Javy, ~5ms)
  4. BACKGROUND: Pre-compile WASM via Cranelift (wasmtime, ~20ms)
  5. Cache compiled module

Subsequent invocations:
  6. Hash source → cache hit → execute pre-compiled WASM (~0.1ms instantiation)
```

```rust
// afterburner-adaptive/src/adaptive.rs

pub struct AdaptiveCombustor {
    native: NativeCombustor,                       // Tier 0: instant
    wasm: WasmCombustor,                           // Tier 1: sandboxed, pre-compiled
    compilation_state: kovan_map::HopscotchMap<[u8; 32], CompilationState>,
}

enum CompilationState {
    Compiling,                    // Background thread working
    Ready(wasmtime::Module),     // WASM module ready
    Failed(String),              // Compilation failed, stay on native
}

impl Combustor for AdaptiveCombustor {
    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        match self.compilation_state.get(&id.hash) {
            Some(CompilationState::Ready(_)) => {
                // Tier 1: execute pre-compiled WASM
                self.wasm.thrust(id, input, limits)
            }
            _ => {
                // Tier 0: execute natively, trigger background compilation
                self.maybe_start_background_compile(id);
                self.native.thrust(id, input, limits)
            }
        }
    }
}
```

### Step 8: Security Hardening (1 day)

| Threat | Mitigation |
|--------|------------|
| Infinite loop | Fuel metering (Wasmtime `consume_fuel`) + epoch interrupts |
| Memory bomb | `ResourceLimiter` on Wasmtime Store (cap linear memory growth) |
| Sandbox escape | WASM sandbox: no FS/net/process unless explicitly imported via WASI |
| Code injection | Scripts are content-hashed; no `eval` of dynamic strings from host |
| Side-channel timing | Fuel consumption is deterministic; no JIT in WASM (Cranelift is AOT) |
| DoS via compilation | Rate-limit `compile()` calls per session; cache compiled modules |
| Prototype pollution | QuickJS: each invocation gets fresh context (no shared globals) |

**Test matrix (tests/sandbox_security.rs):**
```rust
#[test] fn infinite_loop_terminates() { ... }
#[test] fn memory_bomb_capped() { ... }
#[test] fn no_fs_access() { ... }
#[test] fn no_network_access() { ... }
#[test] fn no_process_spawn() { ... }
#[test] fn fuel_exhaustion_returns_error() { ... }
#[test] fn timeout_terminates() { ... }
#[test] fn concurrent_invocations_isolated() { ... }
```

### Step 9: Tests (1 day)

**tests/basic_eval.rs:**
```rust
#[test] fn eval_arithmetic() { assert_eq!(run("module.exports=()=>1+2"), json!(3)); }
#[test] fn eval_string_ops() { ... }
#[test] fn eval_json_transform() { ... }
#[test] fn eval_array_methods() { ... }
#[test] fn eval_object_destructuring() { ... }
#[test] fn eval_async_not_supported() { ... }  // Explicit: no async in sandboxed scripts
#[test] fn eval_es2020_features() { ... }       // Optional chaining, nullish coalescing
```

**tests/directus_compat.rs:**
```rust
#[test] fn directus_data_chain_passthrough() {
    let input = json!({
        "$trigger": { "payload": { "title": "Hello" } },
        "$last": { "id": 42 },
        "previousOp": { "value": 5 }
    });
    let source = r#"
        module.exports = function(data) {
            return { timesTwo: data.previousOp.value * 2 };
        }
    "#;
    let result = engine.run_script(source, &input).unwrap();
    assert_eq!(result, json!({ "timesTwo": 10 }));
}

#[test] fn directus_no_require() { ... }
#[test] fn directus_no_global_mutation_across_runs() { ... }
#[test] fn directus_error_propagation() { ... }
```

**tests/data_flow.rs (ScramDB integration):**
```rust
#[test] fn udf_scalar_transform() { ... }
#[test] fn udf_batch_transform() { ... }
#[test] fn udf_morsel_isolation() { ... }
```

**tests/adaptive_tier.rs:**
```rust
#[test] fn first_call_uses_native() { ... }
#[test] fn second_call_uses_wasm() { ... }
#[test] fn compilation_failure_stays_native() { ... }
```

### Step 10: directus-extension-reheat (1 day)

Directus operation extension wrapping `afterburner-directus`. Two deployment models:

**Model A — Sidecar (recommended):** Afterburner runs as a standalone HTTP service. The Directus extension calls it via `Webhook / Request URL` operation or a thin custom operation that POSTs `{source, data_chain}` to `http://localhost:9090/burn`.

```
directus-extension-reheat/
├── package.json
├── src/
│   ├── api.ts          # Operation backend — POST to afterburner sidecar
│   └── app.ts          # Operation UI — code editor with JS syntax highlighting
└── tsconfig.json
```

```typescript
// directus-extension-reheat/src/api.ts
import { defineOperationApi } from '@directus/extensions-sdk';

export default defineOperationApi({
    id: 'reheat-run-script',
    handler: async ({ source }, { data, accountability, env }) => {
        const input = { $trigger: data.$trigger, $last: data.$last, ...data };
        const res = await fetch('http://localhost:9090/burn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, data: input }),
        });
        if (!res.ok) throw new Error(`Afterburner: ${res.statusText}`);
        return res.json();
    },
});
```

**Model B — FFI (advanced):** Compile `afterburner-directus` as a shared library (`.so`/`.dylib`), load via Node.js `ffi-napi` or `neon`. Zero network overhead. Requires native build per platform.

Both models expose the same Directus operation UI: a code editor where users write `module.exports = function(data) { ... }` — identical to the built-in Run Script UX.

---

## Timeline

| Step | Description | Crate | Effort | Depends On |
|------|-------------|-------|--------|------------|
| 0 | Workspace scaffold | `afterburner/` | 0.5d | — |
| 1 | Combustor trait + types | `afterburner-core` | 0.5d | 0 |
| 2 | WasmCombustor (Wasmtime + QuickJS WASM) | `afterburner-wasi` | 2.0d | 1 |
| 3 | NativeCombustor (rquickjs) | `afterburner-ignite` | 1.5d | 1 |
| 4 | BurnCache (content-addressed caching) | `afterburner-core` | 1.0d | 2, 3 |
| 5 | Host functions + ScramDB UDF operator | `afterburner-wasi` | 1.5d | 4 |
| 6 | ReheatEngine (Directus compatibility) | `afterburner-directus` | 1.5d | 4 |
| 7 | AdaptiveCombustor (Flying Start) | `afterburner-adaptive` | 1.0d | 2, 3 |
| 8 | Security hardening | `afterburner-wasi` | 1.0d | 2 |
| 9 | Tests | `tests/` | 1.0d | all |
| 10 | directus-extension-reheat npm package | `directus-extension-reheat/` | 1.0d | 6 |
| **Total** | | | **11.5d** | |

---

## Expected Results

| Metric | Target |
|--------|--------|
| Ignition latency (first run) | <10ms (JS→`.burn` WASM bytecode) |
| Instantiation latency (cached `.abx`) | <0.5ms (pre-compiled Cranelift module) |
| Throughput (simple transform) | >100K thrust()/sec on single core |
| Memory per instance | <2MB (WASM linear memory default) |
| Sandbox escape vectors | Zero (WASM memory isolation, no ambient authority) |
| ES2020 conformance | >95% (QuickJS upstream passes ~100% test262 ES2020) |
| Directus Run Script compatibility | 100% (same input/output contract, same restrictions) |
| Binary size overhead | ~900KB (QuickJS WASM provider) or ~16KB per `.burn` (dynamic linking) |

---

## Open Questions / Future Work

1. **WASM Component Model** — Javy is moving toward WASI Preview 2 components. Track this; when stable, adopt for better composability and capability-based security.
2. **TypeScript support** — QuickJS doesn't parse TS. Options: (a) SWC as a pre-processing step (Rust-native TS→JS), (b) accept only JS.
3. **GPU UDFs** — Can WASM functions call into ScramDB's GPU pipeline? Not directly. Would require host function that accepts PTX kernel source. Defer.
4. **Persistent module state** — Some use cases (counters, caches) want state across invocations. Add optional `StateStore` trait behind a feature flag.
5. **Distributed execution** — In multi-node ScramDB, compiled WASM modules must be shipped to worker nodes. Content-hash keying enables this naturally: hash → fetch from coordinator.

---

## Appendix A: Directus Flow Architecture Reference

Directus flows consist of:
- **Trigger**: Event hook (filter/action), webhook (GET/POST), schedule (CRON), another flow, manual
- **Operations**: Condition, Run Script, Create/Read/Update/Delete Data, Send Email, Webhook/Request URL, Transform Payload, Log, Sleep, Trigger Flow
- **Data chain**: JSON object passed between operations. Keys: `$trigger`, `$accountability`, `$env`, `$last`, plus each operation's `operationKey`

The **Run Script** operation:
- Executes in isolated sandbox (currently `isolated-vm` in Node.js)
- No FS, no network, no node_modules
- Input: `data` parameter = full data chain
- Output: return value appended under operation's key
- Replaced `vm2` in v10.6.0 after sandbox escape CVE

Our WASM-based engine is a **drop-in replacement** for `isolated-vm` with stronger guarantees:
- WASM memory isolation > V8 isolate isolation
- Fuel metering > `isolated-vm`'s CPU time limits (deterministic vs wall-clock)
- Portable (runs anywhere Wasmtime runs, not just Node.js)

## Appendix B: Workspace Dependency Graph

```
afterburner/                        (workspace root)
│
├── afterburner-core                (engine trait, types, errors)
│   ├── serde + serde_json          (JSON serialization)
│   ├── sha2                        (content-hash for .burn caching)
│   ├── kovan-map                   (lock-free HopscotchMap, wait-free reads)
│   └── thiserror                   (error types)
│
├── afterburner-wasi                (WASM sandbox — untrusted code)
│   ├── afterburner-core
│   ├── wasmtime 28.x               (WASM runtime, Cranelift AOT compiler)
│   ├── wasmtime-wasi 28.x          (WASI Preview 1 — stdin/stdout/env)
│   └── kovan-map                   (script_cache: HopscotchMap)
│
├── afterburner-ignite              (native QuickJS — trusted code)
│   ├── afterburner-core
│   └── rquickjs 0.11.x             (QuickJS-NG Rust bindings, ES2020)
│
├── afterburner-directus            (Directus Run Script replacement)
│   ├── afterburner-core
│   └── afterburner-wasi
│
├── afterburner-adaptive            (Flying Start tier switching)
│   ├── afterburner-core
│   ├── afterburner-wasi
│   ├── afterburner-ignite
│   └── kovan-map                   (compilation_state: HopscotchMap)
│
└── directus-extension-reheat/      (npm package — Directus operation)
    └── @directus/extensions-sdk
```

No dependency on Javy CLI at runtime. The QuickJS WASM provider binary is compiled once and embedded via `include_bytes!`.

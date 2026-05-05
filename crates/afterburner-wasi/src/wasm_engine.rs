//! `WasmCombustor` — untrusted-code path. Instantiates a
//! Wizer-preinitialized Afterburner Javy plugin into a fresh `Store`
//! per thrust and feeds the user source + input as a JSON envelope on
//! stdin. The plugin compiles the source in-process via
//! `javy_plugin_api::compile_src` and runs it; `afterburner:host`
//! imports give capability-gated access to fs/crypto/os/http.
//!
//! No `javy` CLI is involved at runtime. The only JS → bytecode work
//! happens inside the sandbox, driven by the plugin.
//!
//! ### Lifecycle
//!
//! * `WasmCombustor::new` pre-compiles the plugin module once and
//!   starts the shared epoch ticker.
//! * `ignite(source)` hashes the source and stashes it in-memory — no
//!   compilation. `ScriptId` is content-addressed so identical sources
//!   hash identically across backends (`Adaptive` relies on that).
//! * `thrust(id, input, limits)` looks up the cached source, serializes
//!   `{source, input}` onto stdin, instantiates plugin + runs `_start`,
//!   and reads the JSON result from stdout.

use crate::host::HostState;
use crate::host_imports;
use crate::nozzle::parse_output;
use afterburner_core::log::Level;
use afterburner_core::{
    AfterburnerError, Combustor, EngineMode, FuelGauge, InMemoryStateStore, Manifold, Result,
    ScriptId, ScriptInvocation, ScriptOutcome, SharedStateStore, ab_event, sha256,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use kovan_map::HopscotchMap;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wasmtime::{
    Config, Engine, InstanceAllocationStrategy, InstancePre, Linker, Module, OptLevel,
    PoolingAllocationConfig, Store, Trap,
};
use wasmtime_wasi::I32Exit;
use wasmtime_wasi::preview1::add_to_linker_sync;

/// The custom plugin binary (Wizer-preinitialized), committed to the
/// repo and baked into the host crate at compile time.
const PLUGIN_BYTES: &[u8] = include_bytes!("../plugin/afterburner_plugin.wasm");

/// Epoch ticker period. Minimum timeout granularity = one tick.
const TICK_PERIOD_MS: u64 = 10;

/// Stderr capture limit for trap-diagnosis messages.
const STDERR_DIAGNOSIS_CAP: usize = 4 * 1024;

/// Per-call stdout buffer. Scripts returning more than this trigger
/// `AfterburnerError::OutputTooLarge`.
const STDOUT_CAPACITY: usize = 1024 * 1024;

// ---- pooling allocator defaults -----------------------------------------
//
// Cross-platform high-performance defaults. Wasmtime's `PoolingAllocator`
// is supported on Linux, macOS, and Windows (x86_64 + aarch64) — the same
// values work everywhere. Per-platform sub-features that can fail (e.g.
// memory protection keys on Linux x86_64) are runtime-probed in
// `build_engine` and silently fall back if unsupported.
//
// Memory budget: pre-reserves `MAX_LINEAR_MEMORY_BYTES * POOL_TOTAL_MEMORIES`
// of *virtual* address space (~32 GiB at the defaults). Resident memory
// only grows on first touch via CoW; idle slots reclaim back to
// `LINEAR_MEMORY_KEEP_RESIDENT` of RSS.

/// Per-instance linear-memory ceiling enforced by the pool. Each thrust's
/// `FuelGauge::memory_bytes` (via `ResourceLimiter`) is the per-call
/// dynamic cap below this hard limit.
///
/// 1 GiB by default — comfortably fits the Wizer image (~5 MiB), the
/// plenum polyfill bundle, and a long-running daemon-mode QuickJS Store
/// driving frameworks like Express that keep per-request state alive
/// across the whole listener lifetime.
///
/// Override at startup via `BURN_MAX_LINEAR_MEMORY` (accepts plain
/// bytes or `<N>(K|M|G)` shorthand: `BURN_MAX_LINEAR_MEMORY=4G` →
/// 4 GiB). Capped at 4 GiB because the wasm32 ABI has a hard 4 GiB
/// linear-memory limit per Store; values above that are clamped.
/// Override down (e.g. `=128M`) when running many concurrent
/// instances on small hosts — the pool pre-reserves
/// `MAX_LINEAR_MEMORY_BYTES * POOL_TOTAL_MEMORIES` of virtual address
/// space (4 GiB × 128 = 512 GiB virtual at the defaults; resident only
/// on first touch).
const DEFAULT_MAX_LINEAR_MEMORY_BYTES: usize = 1024 * 1024 * 1024;
const WASM32_MAX_LINEAR_MEMORY_BYTES: usize = 4 * 1024 * 1024 * 1024;

fn max_linear_memory_bytes() -> usize {
    let raw = match std::env::var("BURN_MAX_LINEAR_MEMORY") {
        Ok(v) => v,
        Err(_) => return DEFAULT_MAX_LINEAR_MEMORY_BYTES,
    };
    let s = raw.trim();
    let (num_part, mult) = match s.chars().last() {
        Some('K' | 'k') => (&s[..s.len() - 1], 1024usize),
        Some('M' | 'm') => (&s[..s.len() - 1], 1024 * 1024),
        Some('G' | 'g') => (&s[..s.len() - 1], 1024 * 1024 * 1024),
        _ => (s, 1usize),
    };
    let parsed: usize = match num_part.trim().parse() {
        Ok(n) => n,
        Err(_) => return DEFAULT_MAX_LINEAR_MEMORY_BYTES,
    };
    parsed
        .saturating_mul(mult)
        .min(WASM32_MAX_LINEAR_MEMORY_BYTES)
}

/// Maximum concurrently-instantiated plugin instances. Pool reserves
/// virtual-only address space; on a 64-bit host this is "free" until a
/// slot is touched. 128 covers an 8-core box driven at 16x burst, which
/// is a generous default for commodity hardware.
const POOL_TOTAL_MEMORIES: u32 = 128;

/// Resident bytes kept warm per freed pool slot — CoW reset back to this
/// after a Store drops, so re-instantiation skips the page-zeroing cost
/// for the first 1 MiB. Plan §9.
const LINEAR_MEMORY_KEEP_RESIDENT: usize = 1024 * 1024;

/// Resident bytes kept warm per freed table slot.
const TABLE_KEEP_RESIDENT: usize = 1024 * 1024;

/// Table element ceiling — the Javy plugin uses a single funcref table.
/// 65 536 is the Wasm spec maximum and matches what the plugin requests.
const POOL_TABLE_ELEMENTS: usize = 65_536;

#[derive(Default, Clone)]
pub struct WasmConfig {
    /// Cross-invocation key/value store visible to scripts via
    /// `require('afterburner:state')`. `None` falls back to a fresh
    /// in-memory store created at `WasmCombustor::new`.
    pub state_store: Option<SharedStateStore>,
    /// Optional embedder-provided host context. Scripts that call
    /// `require('afterburner:host').readColumn` / `emitRow` dispatch
    /// through this context; unset means `readColumn` returns `[]` and
    /// `emitRow` is a no-op.
    pub host_context: Option<Arc<dyn afterburner_core::HostContext>>,
    /// called from the JS-side require resolver when loading
    /// `.ts` / `.mts` / `.cts` / `.mjs` files. `None` disables those
    /// extensions (the resolver emits a clean error instead of a JS
    /// parse failure). The CLI wires this to oxc-backed transpile
    /// when built with the `ts` feature.
    pub transpile_hook: Option<crate::host::TranspileFn>,
}

/// Cached payload for a registered script. Built once in `ignite` so
/// `thrust` becomes a slice borrow + an instantiate.
///
/// `raw` is kept for diagnostics + future non-invoke consumers (e.g.
/// the daemon path's `run_init_with_bytecode` if it ever shares this
/// cache). `invoke_envelope_bytes` is the pre-serialized
/// `{"mode":"invoke","bytecode_b64":"<...>"}` JSON the plugin's
/// `invoke` mode reads off stdin — same for every thrust of this
/// script, so the per-call hot path skips both base64 encoding and
/// `serde_json::to_vec` on the envelope side.
pub(crate) struct CompiledScript {
    #[allow(dead_code)]
    pub raw: Vec<u8>,
    pub invoke_envelope_bytes: Vec<u8>,
}

pub struct WasmCombustor {
    engine: Engine,
    /// Source store keyed by SHA-256 of the user-facing source. `ignite`
    /// hashes and stashes so `thrust` can locate the original on a
    /// `ScriptNotFound` retry path. The hot path reads from
    /// `bytecode_cache` directly.
    source_store: HopscotchMap<[u8; 32], String>,
    /// Cached compiled-script payloads keyed by source hash. Populated
    /// by `ignite` (which compiles via the plugin's `compile` mode) and
    /// consumed by `thrust` (which ships the pre-built `invoke`
    /// envelope through the plugin). Skipping per-call source
    /// compilation drops the per-thrust cost from ~2 ms to ~150 µs and
    /// unlocks the plan's 100 K/sec target on commodity 8-core
    /// hardware. The cached payload also pre-bakes the base64-encoded
    /// bytecode + the entire `{"mode":"invoke",...}` JSON envelope, so
    /// per-thrust work is just a slice borrow — no encode, no serde.
    bytecode_cache: HopscotchMap<[u8; 32], Arc<CompiledScript>>,
    /// Counter incremented every time `compile_to_bytecode` actually
    /// invokes the plugin's compile mode. Used by tests to assert the
    /// hot path is genuinely cached (register-once → N thrusts → 1
    /// compile). Lives outside `bytecode_cache` so it survives
    /// extinguish + re-ignite cycles and can distinguish "ignite was
    /// idempotent" from "compile actually ran".
    compile_count: Arc<std::sync::atomic::AtomicU64>,
    /// Pre-resolved plugin instantiation. Built once at `new()` from the
    /// module + linker; per-thrust we just call `instance_pre.instantiate(&mut store)`,
    /// which avoids re-walking imports and re-typechecking on every call.
    instance_pre: Arc<InstancePre<HostState>>,
    /// Cross-invocation state store passed to every thrust.
    state_store: SharedStateStore,
    /// Optional host context — embedder-facing read_column/emit_row hooks.
    host_context: Option<Arc<dyn afterburner_core::HostContext>>,
    /// Transpile hook threaded into every Store's HostState so the JS
    /// require resolver can call `__host_ts_transpile` for TS / ESM.
    transpile_hook: Option<crate::host::TranspileFn>,
    /// Long-lived epoch ticker; one per `WasmCombustor`.
    ticker_shutdown: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl WasmCombustor {
    pub fn new(config: WasmConfig) -> Result<Self> {
        let engine = build_engine()?;
        let plugin_module = Module::new(&engine, PLUGIN_BYTES)
            .map_err(|e| AfterburnerError::Engine(format!("plugin module: {e}")))?;

        // Build the linker once with every host import resolved, then
        // pre-instantiate so the per-call path is just `Store::new` +
        // `instance_pre.instantiate`. Imports never need re-resolution.
        let mut linker: Linker<HostState> = Linker::new(&engine);
        add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)
            .map_err(|e| AfterburnerError::Engine(format!("wasi linker: {e}")))?;
        host_imports::register(&mut linker)?;
        let instance_pre = linker
            .instantiate_pre(&plugin_module)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate_pre: {e}")))?;

        let ticker_shutdown = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let shutdown = ticker_shutdown.clone();
            thread::Builder::new()
                .name("afterburner-epoch-ticker".into())
                .spawn(move || {
                    while !shutdown.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(TICK_PERIOD_MS));
                        engine.increment_epoch();
                    }
                })
                .map_err(|e| AfterburnerError::Engine(format!("epoch ticker spawn: {e}")))?
        };

        let state_store = config
            .state_store
            .unwrap_or_else(InMemoryStateStore::shared);

        Ok(Self {
            engine,
            source_store: HopscotchMap::new(),
            bytecode_cache: HopscotchMap::new(),
            compile_count: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            instance_pre: Arc::new(instance_pre),
            state_store,
            host_context: config.host_context,
            transpile_hook: config.transpile_hook,
            ticker_shutdown,
            ticker: Some(ticker),
        })
    }

    /// Exposed so the daemon path can thread the same hook into its
    /// long-lived Store's HostState.
    pub fn transpile_hook(&self) -> Option<crate::host::TranspileFn> {
        self.transpile_hook.clone()
    }

    /// Compile `source` to QuickJS bytecode by spinning up a one-shot
    /// plugin Store in `compile` mode. Result is the raw bytecode bytes
    /// — `ignite` wraps these in an [`Arc<CompiledScript>`] (alongside
    /// a pre-built invoke envelope) so subsequent thrusts skip the
    /// compile entirely.
    fn compile_to_bytecode(&self, source: &str) -> Result<Vec<u8>> {
        self.compile_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let envelope = serde_json::json!({
            "mode": "compile",
            "source": source,
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;

        // Compile mode runs the plugin with a sealed manifold and no
        // host context — the only thing it does is invoke
        // `javy_plugin_api::compile_src` and write base64 to stdout.
        let state = HostState::new(
            &envelope_bytes,
            None, // no per-call memory cap during compile
            STDOUT_CAPACITY,
            Manifold::sealed(),
            self.state_store.clone(),
            None,
        );
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store
            .set_fuel(u64::MAX)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;
        store.set_epoch_deadline(u64::MAX / 2);

        let instance = self
            .instance_pre
            .instantiate(&mut store)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate: {e}")))?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;
        start.call(&mut store, ()).map_err(|trap| {
            let stderr = format_trap_with_stderr(&format!("compile: {trap}"), &mut store);
            AfterburnerError::CompileFailed(stderr)
        })?;

        let stdout_bytes = drain_stdout(&mut store);
        // Plugin emits the bytecode as base64-encoded ASCII on stdout.
        // Trim any trailing newline / null padding before decoding.
        let trimmed = trim_trailing_whitespace(&stdout_bytes);
        B64.decode(trimmed)
            .map_err(|e| AfterburnerError::CompileFailed(format!("bytecode b64 decode: {e}")))
    }

    /// Hand-out the active `StateStore` so embedders can inspect /
    /// pre-populate it from outside the script.
    pub fn state_store(&self) -> &SharedStateStore {
        &self.state_store
    }

    /// Compile a daemon-init source to QuickJS bytecode by spinning up
    /// a one-shot plugin Store in `compile-script` mode. The wrap +
    /// compile happens here on the host side; the resulting bytecode
    /// can then be handed to one or more `DaemonRuntime` instances
    /// via [`DaemonRuntime::run_init_with_bytecode`], which skips
    /// re-paying the parse + compile cost on each daemon Store.
    ///
    /// `argv` / `env` / `cwd` are baked into the compiled bytecode
    /// via the script-mode envelope wrap; calling
    /// [`DaemonRuntime::run_init_with_bytecode`] reuses these
    /// captured values. Embedders that need different values per
    /// invocation should re-compile.
    ///
    /// Returns `Err(AfterburnerError::CompileFailed)` on syntax
    /// errors or transpile failures, with the plugin's stderr
    /// captured in the message — same surface as
    /// [`Self::compile_to_bytecode`] for the UDF path.
    pub fn compile_daemon_init_bytecode(
        &self,
        source: &str,
        invocation: &ScriptInvocation,
    ) -> Result<Vec<u8>> {
        let envelope = serde_json::json!({
            "mode": "compile-script",
            "source": source,
            "argv": invocation.argv,
            "env": invocation.env,
            "cwd": invocation.cwd,
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;

        // Same posture as the existing `compile_to_bytecode`: sealed
        // Manifold, no host context, no host coordinators. The only
        // thing the plugin does in this mode is wrap + compile +
        // emit base64 on stdout.
        let state = HostState::new(
            &envelope_bytes,
            None,
            STDOUT_CAPACITY,
            Manifold::sealed(),
            self.state_store.clone(),
            None,
        );
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store
            .set_fuel(u64::MAX)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;
        store.set_epoch_deadline(u64::MAX / 2);

        let instance = self
            .instance_pre
            .instantiate(&mut store)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate: {e}")))?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;
        start.call(&mut store, ()).map_err(|trap| {
            let stderr = format_trap_with_stderr(&format!("compile-script: {trap}"), &mut store);
            AfterburnerError::CompileFailed(stderr)
        })?;

        let stdout_bytes = drain_stdout(&mut store);
        let trimmed = trim_trailing_whitespace(&stdout_bytes);
        B64.decode(trimmed).map_err(|e| {
            AfterburnerError::CompileFailed(format!("compile-script bytecode b64 decode: {e}"))
        })
    }

    /// Shared engine — DaemonRuntime::instantiate uses this when the
    /// CLI constructs the daemon from combustor internals.
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Pre-resolved plugin instance — shared between thrust + daemon.
    pub fn instance_pre(&self) -> &Arc<InstancePre<HostState>> {
        &self.instance_pre
    }

    /// Spawn a long-lived daemon runtime with a stub `DaemonHttp`
    /// coordinator — no real TCP binding, just accounting. Used by
    /// tests that exercise the plugin ABI without needing a tokio
    /// runtime or real sockets.
    pub fn spawn_daemon(
        &self,
        source: &str,
        manifold: Manifold,
    ) -> Result<crate::daemon_runtime::DaemonRuntime> {
        self.spawn_daemon_with(source, manifold, crate::daemon_http::DaemonHttp::shared())
    }

    /// Spawn a long-lived daemon runtime against an existing
    /// [`DaemonHttp`] coordinator. The `burn` CLI constructs one via
    /// [`DaemonHttp::with_runtime`] (under the `daemon` feature) so
    /// `__host_http_listen` lands on a real axum listener. Library
    /// callers pass [`DaemonHttp::shared`] for stub mode.
    pub fn spawn_daemon_with(
        &self,
        source: &str,
        manifold: Manifold,
        daemon_http: Arc<crate::daemon_http::DaemonHttp>,
    ) -> Result<crate::daemon_runtime::DaemonRuntime> {
        crate::daemon_runtime::DaemonRuntime::new(
            &self.engine,
            &self.instance_pre,
            source,
            manifold,
            Some(self.state_store.clone()),
            self.host_context.clone(),
            daemon_http,
        )
    }

    /// Like [`spawn_daemon_with`] but threads a [`ScriptInvocation`]
    /// (argv + env) through. Matches the script-mode CLI surface so
    /// `process.argv` / `process.env` inside the daemon-init script
    /// reflect what the user typed.
    pub fn spawn_daemon_with_invocation(
        &self,
        source: &str,
        invocation: &afterburner_core::ScriptInvocation,
        manifold: Manifold,
        daemon_http: Arc<crate::daemon_http::DaemonHttp>,
    ) -> Result<crate::daemon_runtime::DaemonRuntime> {
        crate::daemon_runtime::DaemonRuntime::new_with_invocation(
            &self.engine,
            &self.instance_pre,
            source,
            invocation,
            manifold,
            Some(self.state_store.clone()),
            self.host_context.clone(),
            daemon_http,
        )
    }
}

impl Drop for WasmCombustor {
    fn drop(&mut self) {
        self.ticker_shutdown.store(true, Ordering::Release);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
}

/// Build the wasmtime `Engine` with the highest-performance config the
/// platform supports.
///
/// Cross-platform invariants:
///
/// * `consume_fuel(true)` and `epoch_interruption(true)` — required for
///   per-call fuel + wall-clock bounds. Available on every platform.
/// * `memory_init_cow(true)` — re-initialize linear memory via copy-on-
///   write page mapping. Cross-platform; on Windows the implementation
///   uses file-backed sections and is functionally equivalent.
/// * `cranelift_opt_level(Speed)` — emit optimized code; safepoint
///   density is high enough that epoch interruption fires inside guest
///   loops including the Javy microtask pump (verified by the
///   `wasm_infinite_microtask_chain_is_bounded` regression test).
/// * `parallel_compilation(true)` — Cranelift uses rayon to compile
///   functions in parallel; cuts cold-start when the plugin module
///   first instantiates. Available on every platform.
/// * `allocation_strategy(Pooling)` — pre-reserved per-instance
///   linear-memory + table slots. Slot-affine reuse means
///   re-instantiation skips page zeroing for the first
///   `LINEAR_MEMORY_KEEP_RESIDENT` bytes. Cross-platform.
///
/// Optional sub-features (memory protection keys, etc.) that are
/// platform-specific would be runtime-probed here and silently fall
/// back if unsupported. None are currently enabled — the defaults above
/// already saturate commodity hardware throughput.
fn build_engine() -> Result<Engine> {
    let mut config = Config::new();
    config
        .consume_fuel(true)
        .epoch_interruption(true)
        .memory_init_cow(true)
        .cranelift_opt_level(OptLevel::Speed)
        .parallel_compilation(true);

    let mut pool = PoolingAllocationConfig::default();
    pool.total_core_instances(POOL_TOTAL_MEMORIES);
    pool.total_memories(POOL_TOTAL_MEMORIES);
    pool.max_memory_size(max_linear_memory_bytes());
    pool.linear_memory_keep_resident(LINEAR_MEMORY_KEEP_RESIDENT);
    pool.table_keep_resident(TABLE_KEEP_RESIDENT);
    pool.table_elements(POOL_TABLE_ELEMENTS);

    config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool));

    Engine::new(&config).map_err(|e| AfterburnerError::Engine(format!("wasmtime engine: {e}")))
}

impl Combustor for WasmCombustor {
    #[fastrace::trace(name = "WasmCombustor::ignite")]
    fn ignite(&self, source: &str) -> Result<ScriptId> {
        let hash = sha256(source.as_bytes());
        if self.bytecode_cache.get(&hash).is_some() {
            ab_event!(Level::Debug, "wasm.ignite.cache_hit", "hash" => hex8(&hash));
            return Ok(ScriptId {
                hash,
                mode: EngineMode::Wasm,
            });
        }

        // Cache miss: compile through the plugin, then stash both the
        // source (for diagnostics + future retry) and the bytecode
        // alongside a pre-built `invoke` envelope. Pre-building here
        // hoists the per-thrust base64 encode and per-thrust envelope
        // serde out of the hot path — every subsequent `thrust` for
        // this script borrows the cached bytes directly.
        let bytecode = self.compile_to_bytecode(source)?;
        let bytecode_b64 = B64.encode(&bytecode);
        let invoke_envelope = serde_json::json!({
            "mode": "invoke",
            "bytecode_b64": bytecode_b64,
        });
        let invoke_envelope_bytes = serde_json::to_vec(&invoke_envelope)?;
        self.source_store.insert(hash, source.to_string());
        self.bytecode_cache.insert(
            hash,
            Arc::new(CompiledScript {
                raw: bytecode,
                invoke_envelope_bytes,
            }),
        );
        ab_event!(
            Level::Info,
            "wasm.ignite.compiled",
            "hash" => hex8(&hash),
            "source_bytes" => source.len(),
        );

        Ok(ScriptId {
            hash,
            mode: EngineMode::Wasm,
        })
    }

    #[fastrace::trace(name = "WasmCombustor::thrust")]
    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value> {
        let compiled = self
            .bytecode_cache
            .get(&id.hash)
            .ok_or(AfterburnerError::ScriptNotFound)?;
        // The invoke envelope (mode + base64 bytecode) was built once
        // at `ignite` time and lives in `Arc<CompiledScript>`. Every
        // thrust for the same script reads the same bytes — borrow
        // and go. Saves ~40 µs/call (base64 encode of ~30 KB
        // bytecode) + the per-call serde_json::to_vec on the envelope.
        // Input still serializes per-call because it changes per-call;
        // it goes via `HostState::pending_input` (read by the
        // `host_get_input` linker import) — not via the envelope.
        let envelope_bytes: &[u8] = &compiled.invoke_envelope_bytes;
        let input_bytes = serde_json::to_vec(input)?;

        let mut state = HostState::new_with_input(
            envelope_bytes,
            input_bytes,
            limits.memory_bytes,
            STDOUT_CAPACITY,
            limits.manifold.clone(),
            self.state_store.clone(),
            self.host_context.clone(),
        );
        state.transpile_hook = self.transpile_hook.clone();
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);

        let fuel = limits.fuel.unwrap_or(u64::MAX);
        store
            .set_fuel(fuel)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;

        if let Some(ms) = limits.timeout_ms {
            let ticks = ms.div_ceil(TICK_PERIOD_MS).max(1);
            store.set_epoch_deadline(ticks);
        } else {
            store.set_epoch_deadline(u64::MAX / 2);
        }

        // Pre-resolved imports: this is just a slot checkout from the
        // pooling allocator + a memory-image clone via CoW. No linker
        // re-walk, no import re-typecheck.
        let instance = self
            .instance_pre
            .instantiate(&mut store)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate: {e}")))?;

        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;
        let call_result = start.call(&mut store, ());

        if let Err(trap) = call_result {
            if let Some(exit) = trap.downcast_ref::<I32Exit>() {
                if exit.0 != 0 {
                    ab_event!(Level::Warn, "wasm.thrust.nonzero_exit", "code" => exit.0);
                    let msg = format_trap_with_stderr(
                        &format!("script exited with non-zero code {}", exit.0),
                        &mut store,
                    );
                    return Err(AfterburnerError::WasmTrap(msg));
                }
                // proc_exit(0): fall through to stdout drain.
            } else if let Some(t) = trap.downcast_ref::<Trap>() {
                match t {
                    Trap::Interrupt => {
                        ab_event!(Level::Warn, "wasm.thrust.timeout");
                        return Err(AfterburnerError::Timeout);
                    }
                    Trap::OutOfFuel => {
                        ab_event!(Level::Warn, "wasm.thrust.fuel_exhausted");
                        return Err(AfterburnerError::FuelExhausted);
                    }
                    other => {
                        let msg = format_trap_with_stderr(&format!("{other}"), &mut store);
                        ab_event!(Level::Warn, "wasm.thrust.trap", "kind" => other);
                        return Err(AfterburnerError::WasmTrap(msg));
                    }
                }
            } else {
                let chain: Vec<String> = trap.chain().map(|e| format!("{e}")).collect();
                let full = chain.join(" => ");
                if full.contains("memory minimum size") || full.contains("memory size") {
                    ab_event!(Level::Warn, "wasm.thrust.memory_limit");
                    return Err(AfterburnerError::MemoryLimit);
                }
                let msg = format_trap_with_stderr(&full, &mut store);
                return Err(AfterburnerError::WasmTrap(msg));
            }
        }

        let stdout_bytes = drain_stdout(&mut store);
        let capacity = store.data().stdout_capacity;
        if stdout_bytes.len() >= capacity {
            ab_event!(
                Level::Warn,
                "wasm.thrust.output_too_large",
                "limit" => capacity,
            );
            return Err(AfterburnerError::OutputTooLarge { limit: capacity });
        }
        parse_output(&stdout_bytes)
    }

    fn extinguish(&self, id: &ScriptId) {
        self.source_store.remove(&id.hash);
        self.bytecode_cache.remove(&id.hash);
        ab_event!(Level::Info, "wasm.extinguish", "hash" => hex8(&id.hash));
    }

    #[fastrace::trace(name = "WasmCombustor::run_script")]
    fn run_script(
        &self,
        source: &str,
        invocation: &ScriptInvocation,
        limits: &FuelGauge,
    ) -> Result<ScriptOutcome> {
        // Script mode envelope: source + process.argv + process.env
        // carried through. The plugin unpacks argv/env into JS globals
        // before evaluating the user source (see modes/script.rs).
        let envelope = serde_json::json!({
            "mode": "script",
            "source": source,
            "argv": invocation.argv,
            "env": invocation.env,
            "cwd": invocation.cwd,
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;

        let mut state = HostState::new(
            &envelope_bytes,
            limits.memory_bytes,
            STDOUT_CAPACITY,
            limits.manifold.clone(),
            self.state_store.clone(),
            self.host_context.clone(),
        );
        state.transpile_hook = self.transpile_hook.clone();
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);

        let fuel = limits.fuel.unwrap_or(u64::MAX);
        store
            .set_fuel(fuel)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;

        if let Some(ms) = limits.timeout_ms {
            let ticks = ms.div_ceil(TICK_PERIOD_MS).max(1);
            store.set_epoch_deadline(ticks);
        } else {
            store.set_epoch_deadline(u64::MAX / 2);
        }

        let instance = self
            .instance_pre
            .instantiate(&mut store)
            .map_err(|e| AfterburnerError::Engine(format!("plugin instantiate: {e}")))?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| AfterburnerError::Engine(format!("_start lookup: {e}")))?;
        let call_result = start.call(&mut store, ());

        let stdout_bytes = drain_stdout(&mut store);
        let stderr_bytes = store.data().stderr.contents().to_vec();

        if let Err(trap) = call_result {
            if let Some(exit) = trap.downcast_ref::<I32Exit>() {
                // `process.exit(N)` path: preserve N as the exit code.
                // I32Exit(0) is a clean exit through WASI `proc_exit(0)`.
                ab_event!(Level::Info, "wasm.script.proc_exit", "code" => exit.0);
                return Ok(ScriptOutcome {
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                    exit_code: exit.0,
                });
            } else if let Some(t) = trap.downcast_ref::<Trap>() {
                match t {
                    Trap::Interrupt => {
                        ab_event!(Level::Warn, "wasm.script.timeout");
                        return Err(AfterburnerError::Timeout);
                    }
                    Trap::OutOfFuel => {
                        ab_event!(Level::Warn, "wasm.script.fuel_exhausted");
                        return Err(AfterburnerError::FuelExhausted);
                    }
                    _ => {
                        return map_script_trap(stdout_bytes, stderr_bytes);
                    }
                }
            } else {
                let chain: Vec<String> = trap.chain().map(|e| format!("{e}")).collect();
                let full = chain.join(" => ");
                if full.contains("memory minimum size") || full.contains("memory size") {
                    ab_event!(Level::Warn, "wasm.script.memory_limit");
                    return Err(AfterburnerError::MemoryLimit);
                }
                return map_script_trap(stdout_bytes, stderr_bytes);
            }
        }

        Ok(ScriptOutcome {
            stdout: stdout_bytes,
            stderr: stderr_bytes,
            exit_code: 0,
        })
    }
}

/// Map a generic WASM trap in script mode to either `CompileFailed`
/// (when the plugin wrote its "compile_src (script): …" preface to
/// stderr) or an `Ok(ScriptOutcome { exit_code: 1 })` for an uncaught
/// JS exception. The Err path here is the only non-infrastructural
/// error script mode surfaces; everything else is Ok with captured
/// output so the CLI can still print what the script managed to emit
/// before it failed.
fn map_script_trap(stdout: Vec<u8>, stderr: Vec<u8>) -> Result<ScriptOutcome> {
    let stderr_str = String::from_utf8_lossy(&stderr);
    if stderr_str.contains("compile_src (script):") {
        return Err(AfterburnerError::CompileFailed(stderr_str.into_owned()));
    }
    Ok(ScriptOutcome {
        stdout,
        stderr,
        exit_code: 1,
    })
}

fn drain_stdout(store: &mut Store<HostState>) -> Vec<u8> {
    store.data().stdout.contents().to_vec()
}

/// Trim trailing whitespace + null bytes from a stdout capture before
/// base64-decoding the bytecode emitted by the plugin's `compile` mode.
fn trim_trailing_whitespace(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 {
        let b = bytes[end - 1];
        if b == 0 || b.is_ascii_whitespace() {
            end -= 1;
        } else {
            break;
        }
    }
    &bytes[..end]
}

fn format_trap_with_stderr(base: &str, store: &mut Store<HostState>) -> String {
    let stderr = store.data().stderr.contents();
    if stderr.is_empty() {
        return base.to_string();
    }
    let visible = &stderr[..stderr.len().min(STDERR_DIAGNOSIS_CAP)];
    let text = String::from_utf8_lossy(visible);
    let truncated = if stderr.len() > STDERR_DIAGNOSIS_CAP {
        " (truncated)"
    } else {
        ""
    };
    format!("{base}\nstderr{truncated}: {text}")
}

fn hex8(hash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(16);
    for b in &hash[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use afterburner_core::BurnCache;
    use serde_json::json;

    fn make_combustor() -> WasmCombustor {
        WasmCombustor::new(WasmConfig::default()).unwrap()
    }

    #[test]
    fn eval_arithmetic_module_exports() {
        let c = make_combustor();
        let id = c.ignite("module.exports = () => 1 + 2").unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!(3));
    }

    #[test]
    fn eval_reads_input_through_envelope() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = (d) => ({ doubled: d.n * 2 })")
            .unwrap();
        let out = c
            .thrust(&id, &json!({ "n": 21 }), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!({"doubled": 42}));
    }

    #[test]
    fn eval_array_map() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = (d) => d.xs.map(x => x * 2)")
            .unwrap();
        let out = c
            .thrust(&id, &json!({ "xs": [1, 2, 3] }), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!([2, 4, 6]));
    }

    #[test]
    fn wasm_require_path_join_works() {
        let c = make_combustor();
        let id = c
            .ignite("module.exports = () => require('path').join('/a', 'b', 'c.js')")
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("/a/b/c.js"));
    }

    #[test]
    fn wasm_require_buffer_base64_roundtrip() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    const { Buffer } = require('buffer');
                    return Buffer.from('hello world').toString('base64');
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("aGVsbG8gd29ybGQ="));
    }

    #[test]
    fn wasm_require_events_emitter_roundtrip() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    const EE = require('events');
                    const e = new EE();
                    let hits = 0;
                    e.on('tick', (n) => { hits += n; });
                    e.emit('tick', 3);
                    e.emit('tick', 4);
                    return hits;
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!(7));
    }

    #[test]
    fn wasm_require_unknown_module_throws() {
        let c = make_combustor();
        let id = c
            .ignite(
                r#"
                module.exports = () => {
                    try { require('no-such-module'); return 'unexpected'; }
                    catch (e) { return e.message; }
                };
                "#,
            )
            .unwrap();
        let out = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!("Cannot find module 'no-such-module'"));
    }

    #[test]
    fn hash_is_content_addressed_wasm() {
        let c = make_combustor();
        let id1 = c.ignite("const x = 1;").unwrap();
        let id2 = c.ignite("const x = 1;").unwrap();
        assert_eq!(id1.hash, id2.hash);
    }

    #[test]
    fn script_not_found_after_extinguish_wasm() {
        let c = make_combustor();
        let id = c.ignite("const x = 1;").unwrap();
        c.extinguish(&id);
        let err = c
            .thrust(&id, &json!(null), &FuelGauge::unlimited())
            .unwrap_err();
        assert!(matches!(err, AfterburnerError::ScriptNotFound));
    }

    #[test]
    fn bytecode_cache_compiles_once_per_source() {
        // Phase 0.1 regression: register a script once, thrust it many
        // times, and confirm the plugin's `compile` mode runs exactly
        // once. Catches a bytecode-cache miss the day it happens
        // (would silently 100× slow down every thrust).
        let c = make_combustor();
        assert_eq!(c.compile_count.load(std::sync::atomic::Ordering::Relaxed), 0);

        let id = c
            .ignite("module.exports = (d) => ({ doubled: d.n * 2 })")
            .unwrap();
        assert_eq!(c.compile_count.load(std::sync::atomic::Ordering::Relaxed), 1);

        for n in 0..32 {
            let out = c
                .thrust(&id, &json!({ "n": n }), &FuelGauge::unlimited())
                .unwrap();
            assert_eq!(out, json!({ "doubled": n * 2 }));
        }
        // After 32 thrusts the cache has done its job: still one compile.
        assert_eq!(c.compile_count.load(std::sync::atomic::Ordering::Relaxed), 1);

        // Re-igniting the same source must also hit the cache (no
        // recompile) — content-addressed by hash.
        let id2 = c
            .ignite("module.exports = (d) => ({ doubled: d.n * 2 })")
            .unwrap();
        assert_eq!(id2.hash, id.hash);
        assert_eq!(c.compile_count.load(std::sync::atomic::Ordering::Relaxed), 1);

        // A different source compiles exactly once more.
        let _id3 = c.ignite("module.exports = () => 42").unwrap();
        assert_eq!(c.compile_count.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[test]
    fn invoke_envelope_is_prebuilt_at_ignite() {
        // Phase 0.1: the cached `CompiledScript` must carry both the
        // raw bytecode AND the pre-encoded invoke envelope. Catches a
        // future refactor that accidentally re-introduces per-thrust
        // base64 + serde.
        let c = make_combustor();
        let id = c.ignite("module.exports = () => 'ok'").unwrap();
        let compiled = c.bytecode_cache.get(&id.hash).expect("cached");
        assert!(!compiled.raw.is_empty(), "raw bytecode must be cached");
        assert!(
            !compiled.invoke_envelope_bytes.is_empty(),
            "invoke envelope must be pre-built at ignite",
        );
        let env: serde_json::Value =
            serde_json::from_slice(&compiled.invoke_envelope_bytes).unwrap();
        assert_eq!(env["mode"], json!("invoke"));
        assert!(env["bytecode_b64"].is_string());
        // Sanity: the embedded b64 round-trips back to the raw bytes.
        let b64 = env["bytecode_b64"].as_str().unwrap();
        let decoded = B64.decode(b64).unwrap();
        assert_eq!(decoded, compiled.raw);
    }

    #[test]
    fn execute_batch_end_to_end() {
        let c = make_combustor();
        let source = "module.exports = (rows) => rows.map(r => ({ doubled: r.n * 2 }))";
        let cache = BurnCache::new(Box::new(c));
        let id = cache.register(source).unwrap();
        let input = json!([{"n": 1}, {"n": 2}, {"n": 3}]);
        let out = cache
            .execute_batch(&id, &input, &FuelGauge::unlimited())
            .unwrap();
        assert_eq!(out, json!([{"doubled": 2}, {"doubled": 4}, {"doubled": 6}]));
    }
}

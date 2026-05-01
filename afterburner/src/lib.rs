//! # Afterburner
//!
//! Sandboxed JavaScript runtime for Rust. One crate, one entry point.
//!
//! ```no_run
//! use afterburner::Afterburner;
//! use serde_json::json;
//!
//! let ab = Afterburner::new()?;
//! let id = ab.register("(d) => d.n + 1")?;
//! let out = ab.run(&id, &json!({ "n": 41 }))?;
//! assert_eq!(out, json!(42));
//! # Ok::<_, afterburner::AfterburnerError>(())
//! ```
//!
//! ## Modes
//!
//! * **Adaptive** (default): first call runs via `rquickjs` (native,
//!   sub-microsecond); a background thread compiles the same script to
//!   WASM, and subsequent calls switch to the sandboxed Wasmtime path.
//! * **Native only**: trusted code; sub-microsecond throughput, no
//!   sandbox.
//! * **WASM only**: untrusted code; Wasmtime + QuickJS, capability gates
//!   via [`Manifold`].
//! * **Threaded**: N worker threads behind a single `Afterburner`.
//!   Hash-routed with Chase-Lev-style steal-when-idle, token-bucket
//!   admission, graceful drain. Enable via [`AfterburnerBuilder::threaded`].
//!
//! ## Feature flags
//!
//! | feature      | default | unlocks                                          |
//! |--------------|:-------:|--------------------------------------------------|
//! | `wasm`       |   yes   | Wasmtime backend (`WasmCombustor`)               |
//! | `native`     |   yes   | rquickjs backend (`NativeCombustor`)             |
//! | `thrust`     |   yes   | multi-threaded scheduler (`ThrustEngine`)        |
//! | `adaptive`   |   no    | dual-tier native → wasm auto-switch              |
//! | `flow`       |   no    | flow-engine glue (multi-module bundles)          |
//! | `host-http`  |   no    | outbound HTTP host function                      |
//! | `bin`        |   no    | `burn` CLI binary deps (`clap`, `rustyline`)     |
//!
//! ## Capability gating
//!
//! Every thrust carries a [`Manifold`] (via [`FuelGauge`]) that controls
//! what host-backed modules (`fs`, `crypto`, `net`, `env`) the script can
//! reach. Default is [`Manifold::sealed`] — nothing accessible.

#![warn(missing_debug_implementations)]

mod builder;
#[cfg(feature = "ts")]
pub mod esm;
#[cfg(feature = "ts")]
pub mod ts;
#[cfg(feature = "bin")]
pub mod cli;
pub mod prelude;

pub use afterburner_core::{
    AfterburnerError, BurnCache, BurnCacheBackend, Combustor, EngineMode, EnvAccess, FsAccess,
    FuelGauge, HostContext, HostFunction, HttpMethod, HttpResponse, InMemoryStateStore,
    InProcessCacheBackend, LogLevel, Manifold, NetAccess, NullHost, RegistryStats, Result,
    ScriptId, ScriptInvocation, ScriptOutcome, SharedStateStore, StateStore, sha256,
};

#[cfg(feature = "wasm")]
pub mod wasm {
    //! WASM backend — untrusted code via Wasmtime + QuickJS plugin.
    pub use afterburner_wasi::{
        DaemonHttp, DaemonRuntime, DaemonWorkers, WasmCombustor, WasmConfig, WorkerConfig,
        WorkerEvent,
    };
}

#[cfg(feature = "native")]
pub mod native {
    //! Native backend — trusted code via rquickjs FFI.
    pub use afterburner_ignite::NativeCombustor;
}

#[cfg(feature = "adaptive")]
pub mod adaptive {
    //! Dual-tier adaptive combustor (first call native, subsequent WASM).
    pub use afterburner_adaptive::{AdaptiveCombustor, make_adaptive_cache};
}

#[cfg(feature = "flow")]
pub mod flow {
    //! Flow engine — compile + execute with data-chain payload support.
    pub use afterburner_flow::{FlowEngine, default_fuel_gauge};
}

#[cfg(feature = "thrust")]
pub mod thrust {
    //! Multi-threaded scheduler.
    pub use afterburner_thrust::{
        TenantId, ThrustEngine, ThrustEngineConfig, ThrustEngineStats, ThrustHandle,
    };
}

pub use builder::{Afterburner, AfterburnerBuilder, Mode};

#[cfg(feature = "thrust")]
pub use builder::ThreadedBuilder;

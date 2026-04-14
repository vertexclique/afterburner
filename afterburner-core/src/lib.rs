//! Afterburner core — engine trait, shared types, host-function API surface,
//! and the script registry shell.
//!
//! This crate deliberately has no runtime dependencies on Wasmtime or
//! rquickjs. It defines the contract every backend implements.

pub mod engine;
pub mod error;
pub mod host;
pub mod log;
pub mod manifold;
pub mod registry;
pub mod state_store;
pub mod types;

pub use engine::Combustor;
pub use error::{AfterburnerError, Result};
pub use host::{HostContext, HostFunction, HttpMethod, HttpResponse, LogLevel, NullHost};
pub use manifold::{EnvAccess, FsAccess, Manifold, NetAccess};
pub use registry::{BurnCache, BurnCacheBackend, InProcessCacheBackend, RegistryStats};
pub use state_store::{InMemoryStateStore, SharedStateStore, StateStore};
pub use types::{EngineMode, FuelGauge, ScriptId, sha256};

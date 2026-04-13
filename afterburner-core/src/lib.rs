//! Afterburner core — engine trait, shared types, host-function API surface,
//! and the script registry shell.
//!
//! This crate deliberately has no runtime dependencies on Wasmtime or
//! rquickjs. It defines the contract every backend implements.

pub mod engine;
pub mod error;
pub mod host;
pub mod log;
pub mod registry;
pub mod types;

pub use engine::Combustor;
pub use error::{AfterburnerError, Result};
pub use host::{HostContext, HostFunction, HttpMethod, HttpResponse, LogLevel, NullHost};
pub use registry::{BurnCache, RegistryStats};
pub use types::{EngineMode, FuelGauge, ScriptId, sha256};

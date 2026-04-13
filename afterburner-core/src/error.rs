//! Errors produced by any `Combustor` implementation or the `BurnCache`.

use thiserror::Error;

/// Every failure mode Afterburner exposes to callers. Keep the set closed:
/// callers match on it exhaustively.
#[derive(Debug, Error)]
pub enum AfterburnerError {
    /// JS source failed to compile (syntax error, unsupported construct, etc.).
    #[error("compile failed: {0}")]
    CompileFailed(String),

    /// `thrust` was invoked with a `ScriptId` the engine doesn't know about.
    /// Usually means the script was `extinguish`ed or never `ignite`d.
    #[error("script not found (hash mismatch or extinguished)")]
    ScriptNotFound,

    /// The script consumed all fuel allotted by `FuelGauge::fuel`.
    #[error("fuel exhausted")]
    FuelExhausted,

    /// The script tried to allocate past `FuelGauge::memory_bytes`.
    #[error("memory limit exceeded")]
    MemoryLimit,

    /// Wall-clock `FuelGauge::timeout_ms` elapsed before the script finished.
    #[error("execution timed out")]
    Timeout,

    /// The WASM runtime trapped for any reason not caught above (division by
    /// zero, unreachable, integer overflow, etc.).
    #[error("wasm trap: {0}")]
    WasmTrap(String),

    /// JSON could not be produced or consumed at the host boundary.
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),

    /// The script wrote more bytes to stdout than the host's buffer
    /// permits. Surfaces as a typed error rather than a confusing JSON
    /// parse failure on truncated bytes.
    #[error("script output exceeded {limit} byte capture buffer")]
    OutputTooLarge { limit: usize },

    /// A host function returned an error to the script.
    #[error("host error: {0}")]
    Host(String),

    /// Generic engine-internal failure that doesn't fit a specific variant.
    /// Use sparingly — prefer adding a typed variant.
    #[error("engine error: {0}")]
    Engine(String),
}

/// Convenience alias used across the workspace.
pub type Result<T> = core::result::Result<T, AfterburnerError>;

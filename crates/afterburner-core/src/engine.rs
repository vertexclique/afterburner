//! The `Combustor` trait — where fuel (JS) meets air (data).
//!
//! Two implementations live in sibling crates: `WasmCombustor`
//! (`afterburner-wasi`) for untrusted code, `NativeCombustor`
//! (`afterburner-ignite`) for trusted code. `AdaptiveCombustor`
//! (`afterburner-adaptive`) composes both.

use crate::error::{AfterburnerError, Result};
use crate::types::{FuelGauge, ScriptId, ScriptInvocation, ScriptOutcome};
use serde_json::Value;

/// The engine contract. Implementations must be `Send + Sync` so a single
/// instance can back a shared `BurnCache` across threads.
pub trait Combustor: Send + Sync {
    /// Ignition: compile JS source to an internal representation and return
    /// an opaque handle for repeated invocation. Idempotent — identical
    /// sources produce identical `ScriptId`s (content-addressed).
    fn ignite(&self, source: &str) -> Result<ScriptId>;

    /// Thrust: execute a compiled script with a JSON input value, subject to
    /// the given fuel/memory/timeout limits. Returns the JSON the script
    /// produced.
    fn thrust(&self, id: &ScriptId, input: &Value, limits: &FuelGauge) -> Result<Value>;

    /// Release any resources associated with a compiled script. After this
    /// call, `thrust` with the same `id` returns `ScriptNotFound`.
    fn extinguish(&self, id: &ScriptId);

    /// Script mode: run `source` as top-level code (no UDF envelope).
    /// `invocation` carries `process.argv` / `process.env` values that
    /// the backend wires into the JS runtime before the user code
    /// runs. Returns captured stdout / stderr plus a Node-style exit
    /// code.
    ///
    /// Default impl returns an error — backends that do not support
    /// script mode (currently only the library-facing native path when
    /// script mode is disabled) simply inherit this. WASM and adaptive
    /// combustors override with the real implementation.
    ///
    /// Semantics: `Ok(_)` means the script ran; `exit_code != 0`
    /// indicates the user code threw. `Err(_)` is reserved for
    /// infrastructure failures (compile, fuel, memory, timeout).
    fn run_script(
        &self,
        source: &str,
        invocation: &ScriptInvocation,
        limits: &FuelGauge,
    ) -> Result<ScriptOutcome> {
        let _ = (source, invocation, limits);
        Err(AfterburnerError::Engine(
            "script mode not supported by this backend".into(),
        ))
    }
}

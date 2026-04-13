//! The `Combustor` trait — where fuel (JS) meets air (data).
//!
//! Two implementations live in sibling crates: `WasmCombustor`
//! (`afterburner-wasi`) for untrusted code, `NativeCombustor`
//! (`afterburner-ignite`) for trusted code. `AdaptiveCombustor`
//! (`afterburner-adaptive`) composes both.

use crate::error::Result;
use crate::types::{FuelGauge, ScriptId};
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
}

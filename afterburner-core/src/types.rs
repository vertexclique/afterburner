//! Core value types shared by every `Combustor` implementation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Identifier returned by `Combustor::ignite` and consumed by `thrust` /
/// `extinguish`. Content-addressed: the `hash` is SHA-256 of the JS source,
/// so two identical sources produce the same `ScriptId` regardless of which
/// `Combustor` compiled them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ScriptId {
    pub hash: [u8; 32],
    pub mode: EngineMode,
}

/// Which backend produced a `ScriptId`. Useful for adaptive tier switching
/// and for diagnostics; callers generally shouldn't branch on this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EngineMode {
    /// QuickJS compiled to WASM, executed via Wasmtime. Full sandbox.
    Wasm,
    /// QuickJS via `rquickjs` FFI. Trusted code only — no WASM sandbox.
    Native,
}

/// Execution resource limits applied per call. Each field is optional;
/// `None` means "no cap on this dimension."
///
/// **Backend-portable field:** `timeout_ms` is wall-clock and behaves the
/// same on every backend. Prefer it as the primary safety knob — it is the
/// only limit whose magnitude carries the same meaning across modes.
///
/// **Backend-specific fields:** `fuel` and `memory_bytes` measure
/// backend-internal quantities and are **not** numerically comparable
/// between modes. A `fuel: Some(1_000_000)` value is reasonable in one
/// backend and absurdly small in another — see the table below. Code that
/// runs under [`crate::engine::Combustor`] without knowing the concrete
/// backend should rely on `timeout_ms` and treat `fuel` / `memory_bytes`
/// as backend-tuning hints.
///
/// | Field          | Wasm (`afterburner-wasi`)              | Native (`afterburner-ignite`)        |
/// |----------------|----------------------------------------|--------------------------------------|
/// | `fuel`         | Wasmtime instruction count (1 unit ≈   | QuickJS interrupt-handler ticks. One |
/// |                | one Wasm op). Order ~10⁹ for a long    | tick covers many bytecode ops; order |
/// |                | script.                                | ~10⁵–10⁶ for a long script.          |
/// | `memory_bytes` | Linear-memory cap enforced by          | rquickjs heap cap.                   |
/// |                | Wasmtime's `ResourceLimiter`.          |                                      |
/// | `timeout_ms`   | Wall-clock; trapped by the shared      | Wall-clock; checked in the interrupt |
/// |                | epoch ticker.                          | handler.                             |
#[derive(Debug, Clone, Copy, Default)]
pub struct FuelGauge {
    /// Backend-specific instruction budget. See type-level docs for the
    /// per-mode semantics — values are NOT comparable across modes.
    pub fuel: Option<u64>,
    /// Maximum bytes of linear memory (Wasm) or heap (native).
    pub memory_bytes: Option<usize>,
    /// Wall-clock cap. Same meaning across all backends.
    pub timeout_ms: Option<u64>,
}

impl FuelGauge {
    /// Unrestricted — every field `None`. Useful for tests and trusted code.
    pub const fn unlimited() -> Self {
        Self {
            fuel: None,
            memory_bytes: None,
            timeout_ms: None,
        }
    }
}

/// SHA-256 the given bytes. Shared helper so every engine hashes sources
/// identically and `ScriptId`s round-trip between backends.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_deterministic() {
        let a = sha256(b"module.exports = () => 1");
        let b = sha256(b"module.exports = () => 1");
        assert_eq!(a, b);
    }

    #[test]
    fn sha256_differs_for_different_input() {
        let a = sha256(b"module.exports = () => 1");
        let b = sha256(b"module.exports = () => 2");
        assert_ne!(a, b);
    }

    #[test]
    fn fuel_gauge_unlimited_has_no_caps() {
        let g = FuelGauge::unlimited();
        assert!(g.fuel.is_none());
        assert!(g.memory_bytes.is_none());
        assert!(g.timeout_ms.is_none());
    }
}

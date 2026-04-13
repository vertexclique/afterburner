//! Test-only utilities for locating the Javy CLI without mutating the
//! process environment. Reads `AFTERBURNER_JAVY` and falls back to a
//! well-known local path; never calls `std::env::set_var`.
//!
//! Public so the integration tests in `tests/` can reach it; gated behind
//! `cfg(any(test, debug_assertions))` so it does not bloat release builds
//! used by downstream consumers.

#![cfg(any(test, debug_assertions))]

use crate::WasmConfig;
use std::path::PathBuf;

/// Resolve the Javy CLI path from `AFTERBURNER_JAVY` or a local fallback.
/// Returns `None` if neither is found — callers can use this to skip
/// integration tests on machines without Javy provisioned.
pub fn resolve_javy() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AFTERBURNER_JAVY") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    let fallback = PathBuf::from("/home/vclq/.local/bin/javy");
    if fallback.exists() {
        return Some(fallback);
    }
    if probe_path("javy") {
        return Some(PathBuf::from("javy"));
    }
    None
}

fn probe_path(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build a `WasmConfig` whose `javy_binary` is resolved from the
/// environment. Returns `None` if Javy isn't available.
pub fn config_with_resolved_javy() -> Option<WasmConfig> {
    Some(WasmConfig {
        javy_binary: Some(resolve_javy()?),
    })
}

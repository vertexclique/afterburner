//! Afterburner flow engine — a Rust-native runner for user-authored JS
//! modules consumed in a flow/pipeline. Construct one [`FlowEngine`] up
//! front, then `load` modules, `execute` them against a chain input, and
//! `unload` when no longer needed.

pub mod chain;
pub mod engine;

pub use engine::{FlowEngine, default_fuel_gauge};

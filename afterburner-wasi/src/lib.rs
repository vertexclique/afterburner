//! Afterburner WASM engine — Wasmtime runtime hosting Javy-style
//! QuickJS-in-WASM. Produces hard-sandboxed JS execution with fuel,
//! memory, and wall-clock caps.

pub mod daemon_http;
pub mod daemon_runtime;
pub mod host;
pub mod host_imports;
pub mod intake;
pub mod nozzle;
pub mod test_support;
pub mod wasm_engine;

pub use daemon_http::{DaemonHttp, ReplyEnvelope};
pub use daemon_runtime::DaemonRuntime;
pub use wasm_engine::{WasmCombustor, WasmConfig};

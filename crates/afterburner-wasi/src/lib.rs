#![doc(
    html_logo_url = "https://raw.githubusercontent.com/vertexclique/afterburner/master/art/svg/afterburner-square.svg"
)]
//! Afterburner WASM engine — Wasmtime runtime hosting Javy-style
//! QuickJS-in-WASM. Produces hard-sandboxed JS execution with fuel,
//! memory, and wall-clock caps.

pub mod daemon_http;
#[cfg(feature = "daemon")]
pub mod daemon_net;
#[cfg(feature = "daemon")]
pub mod daemon_tls;
#[cfg(feature = "daemon")]
pub mod daemon_dgram;
pub mod daemon_runtime;
pub mod daemon_workers;
pub mod wasm_loader;
pub mod host;
pub mod host_imports;
pub mod intake;
pub mod manifold_codec;
pub mod nozzle;
pub mod test_support;
pub mod wasm_engine;

pub use daemon_http::{DaemonHttp, ReplyEnvelope};
#[cfg(feature = "daemon")]
pub use daemon_net::{DaemonNet, NetEvent};
#[cfg(feature = "daemon")]
pub use daemon_tls::{DaemonTls, TlsEvent};
#[cfg(feature = "daemon")]
pub use daemon_dgram::{DaemonDgram, DgramEvent};
pub use daemon_runtime::DaemonRuntime;
pub use daemon_workers::{DaemonWorkers, WorkerConfig, WorkerEvent};
pub use manifold_codec::manifold_to_cli_args;
pub use wasm_engine::{WasmCombustor, WasmConfig};

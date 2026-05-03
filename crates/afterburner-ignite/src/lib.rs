#![doc(
    html_logo_url = "https://raw.githubusercontent.com/vertexclique/afterburner/master/art/svg/afterburner-square.svg"
)]
//! Afterburner native engine — QuickJS via rquickjs, no WASM overhead.

pub mod native_engine;

pub use native_engine::NativeCombustor;

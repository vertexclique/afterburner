#![doc(
    html_logo_url = "https://raw.githubusercontent.com/vertexclique/afterburner/master/art/svg/afterburner-square.svg"
)]
//! Afterburner adaptive engine — native-first execution with background
//! WASM compilation and tier switching on hot paths (Flying Start
//! principle).

pub mod adaptive;

pub use adaptive::{AdaptiveCombustor, make_adaptive_cache};

//! L3 shadow modules — pure-Rust substitutes for popular npm
//! packages whose upstream ships a `.node` native addon.
//!
//! Scripts running under `burn` cannot dynamically load a `.node`
//! binary (it's raw native code; the WASM sandbox has no way to
//! execute it). The L3 plan's answer: intercept known package
//! names in `require()` and serve a pure-Rust implementation
//! backed by a host import instead.
//!
//! Each shadow lives behind its own cargo feature so binary size
//! scales with opt-in:
//!
//! * [`bcrypt`] — behind `shadow-bcrypt` (via the Rust `bcrypt`
//!   crate). Covers `hash` / `hashSync` / `compare` / `compareSync`
//!   / `genSalt` / `genSaltSync`.
//!
//! Future shadows follow the same layout:
//! `src/shadows/<pkg>.rs` for the Rust impl, `polyfills/shadow_<pkg>.js`
//! for the JS-facing module registration, gated behind
//! `shadow-<pkg>`.

#[cfg(feature = "shadow-bcrypt")]
pub mod bcrypt;

#[cfg(feature = "shadow-argon2")]
pub mod argon2;

#[cfg(feature = "shadow-jsonwebtoken")]
pub mod jsonwebtoken;

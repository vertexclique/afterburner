//! Afterburner Node.js compatibility layer.
//!
//! * The `plenum.js` bundle (`PLENUM_BUNDLE`) — `require()` resolver and
//!   every pure-JS polyfill, ready to `eval` into a QuickJS context.
//! * Host-side implementations of the capability-gated modules (`fs`,
//!   `crypto`, `os`, `http`), each taking a [`afterburner_core::Manifold`]
//!   for permission checks.
//! * `native_install::register_native_builtins` — binds every `__host_*`
//!   global on an rquickjs `Context` so the plenum glue can call through.
//! * `active_manifold` — per-thread slot the engine sets before running a
//!   user script so globals know which capability profile is active.

pub mod active_manifold;
pub mod bundle;
pub mod child_process_host;
pub mod crypto_host;
pub mod dns_host;
pub mod fs_host;
pub mod http_host;
pub mod native_install;
pub mod os_host;
pub mod sign_handles;
pub mod state_active;
pub mod zlib_host;

pub use bundle::PLENUM_BUNDLE;
pub use native_install::register_native_builtins;

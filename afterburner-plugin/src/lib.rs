//! Afterburner custom Javy plugin.
//!
//! Targets `wasm32-wasip1`. Committed as a Wizer-preinitialized binary
//! (`quickjs-provider/afterburner_plugin.wasm`) so the host never needs
//! the `javy` CLI at runtime.
//!
//! ### Runtime protocol
//!
//! The host instantiates this plugin into a fresh `Store` per thrust
//! and calls the exported `_start` function. `_start`:
//!
//! 1. Reads a JSON envelope from stdin.
//! 2. Dispatches by envelope `mode` field — see [`modes`].
//!
//! ### Module layout
//!
//! - [`host_api`]    — `afterburner:host` extern declarations.
//! - [`stdio`]       — WASI preview1 `fd_read` / `fd_write` helpers.
//! - [`envelope`]    — JS source wrappers (input-inlined + input-via-global).
//! - [`globals`]     — `modify_runtime`-time JS global installers.
//! - [`modes`]       — per-mode dispatchers (`compile`, `invoke`, `legacy`).
//!
//! ### Error reporting
//!
//! Variable-length host responses use a buffer protocol — the callee
//! writes bytes into a caller-provided region and returns either the
//! length or a negative error code. A detailed message is stashed in
//! the host's `last_error` slot and readable via the `host_last_error`
//! import.

#![no_std]
#![cfg(target_arch = "wasm32")]

extern crate alloc;

mod envelope;
mod globals;
mod host_api;
mod modes;
mod stdio;

use javy_plugin_api::javy::Runtime;
use javy_plugin_api::{Config, import_namespace};

import_namespace!("afterburner-plugin-v1");

/// Called by Wizer-preinit so every instantiation starts with the
/// global bridges + plenum polyfill bundle already in the runtime
/// snapshot.
fn modify_runtime(runtime: Runtime) -> Runtime {
    runtime.context().with(globals::install);
    runtime
}

fn config() -> Config {
    let mut c = Config::default();
    // `event_loop(true)` makes Javy automatically drain pending microtasks
    // after every `invoke` call — required for `fetch().then(...)`,
    // `await`, `setTimeout(fn, 0)`, and any Promise chain. Without it,
    // scheduling a microtask traps with "Pending jobs in the event
    // queue. Scheduling events is not supported when the event-loop
    // runtime config is not enabled."
    //
    // `event_loop` lives on the outer `javy_plugin_api::Config`;
    // `text_encoding` / `javy_stream_io` are on the inner `javy::Config`
    // reached through `DerefMut`. Two passes because the chain returns
    // the inner config, not the outer one.
    c.event_loop(true);
    c.text_encoding(true).javy_stream_io(true);
    c
}

#[unsafe(export_name = "initialize-runtime")]
pub extern "C" fn initialize_runtime() {
    if javy_plugin_api::initialize_runtime(config, modify_runtime).is_err() {
        core::arch::wasm32::unreachable()
    }
}

/// `_start` — reads the JSON envelope from stdin and delegates to the
/// mode dispatcher in [`modes`].
#[unsafe(export_name = "_start")]
pub extern "C" fn start() {
    let envelope = match stdio::read_stdin() {
        Ok(bytes) => bytes,
        Err(_) => core::arch::wasm32::unreachable(),
    };

    let parsed: serde_json::Value = match serde_json::from_slice(&envelope) {
        Ok(v) => v,
        Err(_) => core::arch::wasm32::unreachable(),
    };

    modes::dispatch(&parsed);
}

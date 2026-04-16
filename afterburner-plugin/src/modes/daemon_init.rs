//! Daemon-init mode: long-lived-Store path.
//!
//! Envelope `{mode: "daemon-init", source: string}`. Evaluates the
//! user source in script-mode shape (top-level, AsyncFunction-wrapped
//! for top-level await) once per daemon lifetime. User code that
//! calls `http.createServer(cb).listen(port)` registers `cb` into a
//! JS-side map keyed by `server_id` returned from `__host_http_listen`;
//! subsequent `daemon-event` envelopes dispatch against that map.
//!
//! Unlike script mode, we do NOT return the result here — the JS
//! state persists in the Store across calls so handlers stay live.

use alloc::format;
use alloc::string::ToString;

use crate::envelope::wrap_script_source;
use crate::stdio::write_stderr;

pub fn run(envelope: &serde_json::Value) {
    let source = envelope
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // daemon-init argv/env mirror script-mode conventions so
    // `process.argv` / `process.env` inside the daemon code see the
    // same thing a one-shot `burn foo.js` would. Argv/env can be
    // carried in the envelope too for explicit control.
    let argv_json = envelope
        .get("argv")
        .filter(|v| v.is_array())
        .map(serde_json::Value::to_string)
        .unwrap_or_else(|| "[]".into());
    let env_json = envelope
        .get("env")
        .filter(|v| v.is_object())
        .map(serde_json::Value::to_string)
        .unwrap_or_else(|| "{}".into());
    let wrapped = wrap_script_source(source, &argv_json, &env_json);

    let bytecode = match javy_plugin_api::compile_src(wrapped.as_bytes()) {
        Ok(bc) => bc,
        Err(e) => {
            let msg = format!("compile_src (daemon-init): {e}\n");
            write_stderr(msg.as_bytes());
            core::arch::wasm32::unreachable()
        }
    };

    if let Err(e) = javy_plugin_api::invoke(&bytecode, None) {
        let msg = format!("invoke (daemon-init): {e}\n");
        write_stderr(msg.as_bytes());
        core::arch::wasm32::unreachable()
    }
}

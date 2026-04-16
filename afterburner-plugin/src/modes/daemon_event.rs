//! Daemon-event mode: re-enter the long-lived Store with one event.
//!
//! Envelope `{mode: "daemon-event", event: {kind, ...}}`. We compile
//! a tiny dispatch wrapper that reads the full envelope via
//! `__AB_GET_ENVELOPE__()`, parses it, looks up the JS-side handler
//! registered by `daemon-init` code, and invokes it. The response
//! (if any) travels back through host imports (`__host_http_reply`)
//! — this function's own return value is discarded.
//!
//! Top-level `await` resolves through Javy's event loop drain so
//! handlers can be `async` without special wrapping.

use alloc::format;

use crate::stdio::write_stderr;

/// JS-side dispatch wrapper. Keeps the Rust dispatcher lean — the JS
/// already has the handler table on globalThis; we just decode the
/// envelope and delegate. The wrapper is compiled fresh on each
/// daemon-event because it's trivial and cache-invalidation across
/// Store state would be error-prone.
const DISPATCH_SOURCE: &str = r#"
(async function() {
    const env = JSON.parse(__AB_GET_ENVELOPE__());
    const ev = env.event || {};
    const kind = ev.kind || '';
    if (kind === 'http-request') {
        const table = globalThis.__ab_http_handlers || {};
        const cb = table[ev.server_id];
        if (!cb) {
            // Handler-missing path: reply with a 500 so axum doesn't
            // hang. `__host_http_reply` is a no-op if the req_id has
            // already been answered.
            if (typeof globalThis.__host_http_reply === 'function') {
                globalThis.__host_http_reply(
                    Number(ev.req_id),
                    JSON.stringify({status: 500, headers: {}, body: 'no handler for server_id ' + ev.server_id})
                );
            }
            return;
        }
        const ReqRes = globalThis.__ab_build_reqres;
        if (typeof ReqRes !== 'function') {
            throw new Error('daemon-event: __ab_build_reqres not installed');
        }
        const { req, res } = ReqRes(ev);
        try {
            await cb(req, res);
        } catch (e) {
            if (!res.writableEnded) {
                res.statusCode = 500;
                res.end(String((e && e.stack) || e));
            }
        }
    } else {
        // Unknown event kind — surface on stderr for diagnosis.
        try { console.error('daemon-event: unknown kind=' + kind); } catch (_) {}
    }
})();
"#;

pub fn run(_envelope: &serde_json::Value) {
    // Note: we ignore the Rust-side envelope we already parsed —
    // the JS dispatcher re-parses the envelope via __AB_GET_ENVELOPE__()
    // which gives it the authoritative bytes. That keeps the host→JS
    // boundary on exactly one serialization path.
    let bytecode = match javy_plugin_api::compile_src(DISPATCH_SOURCE.as_bytes()) {
        Ok(bc) => bc,
        Err(e) => {
            let msg = format!("compile_src (daemon-event dispatch): {e}\n");
            write_stderr(msg.as_bytes());
            core::arch::wasm32::unreachable()
        }
    };
    if let Err(e) = javy_plugin_api::invoke(&bytecode, None) {
        let msg = format!("invoke (daemon-event): {e}\n");
        write_stderr(msg.as_bytes());
        core::arch::wasm32::unreachable()
    }
}

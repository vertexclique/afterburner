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
    } else if (kind === 'timer-fire') {
        // B3: host-managed timer expired. Look up the callback the JS
        // side registered in `__ab_timer_handlers[timer_id]`.
        const table = globalThis.__ab_timer_handlers || {};
        const cb = table[ev.timer_id];
        if (typeof cb === 'function') {
            try {
                await cb();
            } catch (e) {
                try { console.error('timer callback error:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-online') {
        // B10 parent-side: a child worker finished its handshake.
        const table = globalThis.__ab_worker_handlers || {};
        const w = table[ev.worker_id];
        if (w && typeof w._dispatchOnline === 'function') {
            try { w._dispatchOnline(); } catch (e) {
                try { console.error('worker online dispatch:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-message') {
        const table = globalThis.__ab_worker_handlers || {};
        const w = table[ev.worker_id];
        if (w && typeof w._dispatchMessage === 'function') {
            try { w._dispatchMessage(ev.payload || ''); } catch (e) {
                try { console.error('worker message dispatch:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-error') {
        const table = globalThis.__ab_worker_handlers || {};
        const w = table[ev.worker_id];
        if (w && typeof w._dispatchError === 'function') {
            try { w._dispatchError(ev.message || '', ev.stack || ''); } catch (e) {
                try { console.error('worker error dispatch:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-exit') {
        const table = globalThis.__ab_worker_handlers || {};
        const w = table[ev.worker_id];
        if (w && typeof w._dispatchExit === 'function') {
            try { w._dispatchExit(ev.code | 0); } catch (e) {
                try { console.error('worker exit dispatch:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-parent-message') {
        // B10 child-side: parent sent us a frame.
        const port = globalThis.__ab_worker_parent_port_handlers;
        if (port && typeof port._dispatchMessage === 'function') {
            try { port._dispatchMessage(ev.payload || ''); } catch (e) {
                try { console.error('parentPort message dispatch:', (e && e.stack) || e); } catch (_) {}
            }
        }
    } else if (kind === 'worker-terminate-requested') {
        // B10 child-side: parent has called worker.terminate().
        const port = globalThis.__ab_worker_parent_port_handlers;
        if (port && typeof port._dispatchTerminate === 'function') {
            try { port._dispatchTerminate(); } catch (_) {}
        }
        // The CLI's child event loop also sees this on the Rust side
        // and exits gracefully; the JS-side dispatch is best-effort
        // for user-facing 'close' listeners.
    } else if (kind === 'net-connect') {
        // B7: outbound TCP connect succeeded.
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchConnect === 'function') {
            try { sock._dispatchConnect(ev.local || null, ev.remote || null); }
            catch (e) { try { console.error('net connect dispatch:', (e && e.stack) || e); } catch (_) {} }
        }
    } else if (kind === 'net-data') {
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchData === 'function') {
            try { sock._dispatchData(ev.payload_b64 || ''); }
            catch (e) { try { console.error('net data dispatch:', (e && e.stack) || e); } catch (_) {} }
        }
    } else if (kind === 'net-end') {
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchEnd === 'function') {
            try { sock._dispatchEnd(); } catch (_) {}
        }
    } else if (kind === 'net-drain') {
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchDrain === 'function') {
            try { sock._dispatchDrain(); } catch (_) {}
        }
    } else if (kind === 'net-error') {
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchError === 'function') {
            try { sock._dispatchError(ev.message || '', ev.code || ''); } catch (_) {}
        }
    } else if (kind === 'net-close') {
        const table = globalThis.__ab_net_handlers || {};
        const sock = table[ev.conn_id];
        if (sock && typeof sock._dispatchClose === 'function') {
            try { sock._dispatchClose(!!ev.had_error); } catch (_) {}
        }
    } else if (kind === 'net-listening') {
        const table = globalThis.__ab_net_server_handlers || {};
        const srv = table[ev.server_id];
        if (srv && typeof srv._dispatchListening === 'function') {
            try { srv._dispatchListening(ev.port | 0); } catch (_) {}
        }
    } else if (kind === 'net-connection') {
        const table = globalThis.__ab_net_server_handlers || {};
        const srv = table[ev.server_id];
        if (srv && typeof srv._dispatchConnection === 'function') {
            try { srv._dispatchConnection(ev.conn_id | 0, ev.local || null, ev.remote || null); }
            catch (e) { try { console.error('net connection dispatch:', (e && e.stack) || e); } catch (_) {} }
        }
    } else if (kind === 'net-server-error') {
        const table = globalThis.__ab_net_server_handlers || {};
        const srv = table[ev.server_id];
        if (srv && typeof srv._dispatchServerError === 'function') {
            try { srv._dispatchServerError(ev.message || ''); } catch (_) {}
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

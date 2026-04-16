//! B2.2 — `DaemonRuntime` scaffold tests. Exercises the long-lived
//! Store path end-to-end against the plugin's daemon modes without
//! the axum listener layer (that lands in B2.4).

use afterburner_core::Manifold;
use afterburner_wasi::{WasmCombustor, WasmConfig};
use serde_json::json;

fn fresh() -> WasmCombustor {
    WasmCombustor::new(WasmConfig::default()).expect("combustor")
}

#[test]
fn daemon_init_evaluates_user_source() {
    let c = fresh();
    let daemon = c
        .spawn_daemon(
            r#"
            console.log("daemon startup");
            globalThis.__daemon_ready = true;
            "#,
            Manifold::open(),
        )
        .expect("spawn daemon");

    let stdout = daemon.drain_stdout();
    let text = String::from_utf8_lossy(&stdout);
    assert!(
        text.contains("daemon startup"),
        "expected startup log in stdout, got {text:?}"
    );
}

#[test]
fn daemon_dispatch_invokes_registered_handler() {
    // The plugin's `daemon_event` mode reads
    // `globalThis.__ab_http_handlers[server_id]` and invokes it with
    // `{req, res}` built via `globalThis.__ab_build_reqres`. B2.3
    // will install a real `__ab_build_reqres` via the `http.createServer`
    // polyfill; here we stub it directly from the init script so
    // the daemon path is testable in isolation.
    let c = fresh();
    let mut daemon = c
        .spawn_daemon(
            r#"
            globalThis.__ab_http_handlers = {
                1: function(req, res) {
                    console.log("dispatched: " + req.method + " " + req.url);
                    res.end('');
                }
            };
            globalThis.__ab_build_reqres = function(ev) {
                return {
                    req: { method: ev.req.method, url: ev.req.url },
                    res: {
                        writableEnded: false,
                        statusCode: 200,
                        end: function(_body) { this.writableEnded = true; }
                    }
                };
            };
            "#,
            Manifold::open(),
        )
        .expect("spawn daemon");

    daemon
        .dispatch_event(json!({
            "kind": "http-request",
            "server_id": 1,
            "req_id": 1,
            "req": { "method": "GET", "url": "/hello" }
        }))
        .expect("dispatch 1");
    daemon
        .dispatch_event(json!({
            "kind": "http-request",
            "server_id": 1,
            "req_id": 2,
            "req": { "method": "POST", "url": "/world" }
        }))
        .expect("dispatch 2");

    let stdout = daemon.drain_stdout();
    let text = String::from_utf8_lossy(&stdout);
    assert!(
        text.contains("dispatched: GET /hello"),
        "stdout = {text:?}"
    );
    assert!(
        text.contains("dispatched: POST /world"),
        "stdout = {text:?}"
    );
}

#[test]
fn daemon_persists_js_state_across_dispatches() {
    // `__counter` lives on globalThis and the Store is long-lived —
    // counter MUST survive across dispatch_event calls.
    let c = fresh();
    let mut daemon = c
        .spawn_daemon(
            r#"
            globalThis.__counter = 0;
            globalThis.__ab_http_handlers = {
                1: function(req, res) {
                    globalThis.__counter++;
                    console.log("count=" + globalThis.__counter);
                    res.end('');
                }
            };
            globalThis.__ab_build_reqres = function(ev) {
                return {
                    req: { method: ev.req.method, url: ev.req.url },
                    res: {
                        writableEnded: false,
                        statusCode: 200,
                        end: function(_body) { this.writableEnded = true; }
                    }
                };
            };
            "#,
            Manifold::open(),
        )
        .expect("spawn daemon");

    for i in 1..=3 {
        daemon
            .dispatch_event(json!({
                "kind": "http-request",
                "server_id": 1,
                "req_id": i,
                "req": { "method": "GET", "url": "/" }
            }))
            .expect("dispatch");
    }

    let stdout = daemon.drain_stdout();
    let text = String::from_utf8_lossy(&stdout);
    for want in ["count=1", "count=2", "count=3"] {
        assert!(text.contains(want), "{want} not in stdout: {text:?}");
    }
}

#[test]
fn daemon_handles_missing_handler_without_crashing() {
    // If a request arrives for a server_id with no handler
    // registered (shouldn't happen in practice but defence in
    // depth), the JS dispatcher sends a 500 via __host_http_reply.
    // Without a real reply channel wired, __host_http_reply is a
    // no-op — the important thing is the dispatch returns cleanly.
    let c = fresh();
    let mut daemon = c
        .spawn_daemon(
            "/* empty init — no handlers */",
            Manifold::open(),
        )
        .expect("spawn daemon");
    daemon
        .dispatch_event(json!({
            "kind": "http-request",
            "server_id": 42,
            "req_id": 1,
            "req": { "method": "GET", "url": "/" }
        }))
        .expect("dispatch ok even without handler");
}

#[test]
fn daemon_has_listeners_reflects_host_http_listen() {
    // Without `http.createServer` polyfill, user code can still
    // call `__host_http_listen` directly — that's what this test
    // does to verify the DaemonHttp coordinator accounting.
    let c = fresh();
    let daemon = c
        .spawn_daemon(
            r#"
            const id1 = globalThis.__host_http_listen(3000);
            const id2 = globalThis.__host_http_listen(3001);
            console.log("ids: " + id1 + "," + id2);
            "#,
            Manifold::open(),
        )
        .expect("spawn daemon");
    assert!(daemon.has_listeners(), "should report 2 listeners");
    let stdout = String::from_utf8_lossy(&daemon.drain_stdout()).into_owned();
    assert!(stdout.contains("ids: 1,2"), "stdout = {stdout:?}");
}

#[test]
fn daemon_has_no_listeners_when_init_skips_listen() {
    let c = fresh();
    let daemon = c
        .spawn_daemon("console.log('no listen');", Manifold::open())
        .expect("spawn daemon");
    assert!(!daemon.has_listeners());
}

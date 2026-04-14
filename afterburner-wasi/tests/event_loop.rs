//! Phase E: event-loop regression tests. Scripts can now return
//! Promises / use `await` / chain `.then()` / schedule microtasks via
//! `queueMicrotask`, because:
//!
//! * afterburner-plugin enables `javy_plugin_api::Config::event_loop(true)`
//!   so Javy drains pending microtasks after the script invocation.
//! * afterburner-ignite pumps `ctx.execute_pending_job()` after the
//!   envelope eval when the user returned a thenable.
//!
//! The same JS script runs against both engines — behavior must match.

use afterburner_core::{Combustor, FuelGauge, Manifold};
use afterburner_ignite::NativeCombustor;
use afterburner_wasi::{WasmCombustor, WasmConfig};
use serde_json::{Value, json};

fn native() -> NativeCombustor {
    NativeCombustor::new().unwrap()
}
fn wasm() -> WasmCombustor {
    WasmCombustor::new(WasmConfig::default()).unwrap()
}

fn run_on<C: Combustor>(c: &C, src: &str) -> Value {
    let id = c.ignite(src).unwrap();
    let limits = FuelGauge {
        manifold: Manifold::sealed(),
        ..FuelGauge::default()
    };
    c.thrust(&id, &json!(null), &limits).unwrap()
}

/// Helper for tests that must pass on both engines.
fn run_both(src: &str) -> (Value, Value) {
    let n = run_on(&native(), src);
    let w = run_on(&wasm(), src);
    assert_eq!(n, w, "native vs wasm mismatch");
    (n, w)
}

#[test]
fn returns_plain_value_still_works() {
    // Sanity: the Phase E changes didn't break the fast path. A script
    // that returns a non-thenable goes through the pre-Phase-E code
    // route (no pump, no Promise.from_value) on native; on WASM it's
    // handled directly by Javy.
    let (n, _) = run_both("module.exports = () => 42;");
    assert_eq!(n, json!(42));
}

#[test]
fn returns_resolved_promise() {
    let (n, _) = run_both("module.exports = () => Promise.resolve(123);");
    assert_eq!(n, json!(123));
}

#[test]
fn promise_then_chain() {
    let src = r#"
        module.exports = () =>
            Promise.resolve(10)
                .then(n => n * 2)
                .then(n => n + 1)
                .then(n => ({ result: n }));
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!({ "result": 21 }));
}

#[test]
fn async_await_resolves() {
    let src = r#"
        module.exports = async () => {
            const a = await Promise.resolve(5);
            const b = await Promise.resolve(7);
            return a + b;
        };
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!(12));
}

#[test]
fn queue_microtask_fires_before_return() {
    let src = r#"
        module.exports = () => new Promise(resolve => {
            let hits = 0;
            queueMicrotask(() => { hits++; });
            queueMicrotask(() => { hits++; resolve(hits); });
        });
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!(2));
}

#[test]
fn set_timeout_zero_defers_to_microtask() {
    // Prior to Phase E, `setTimeout(fn, 0)` fired synchronously. Now
    // it queues a microtask: the inline code runs first, then the
    // callback. Observing the order is the test.
    let src = r#"
        module.exports = () => new Promise(resolve => {
            const order = [];
            order.push('before');
            setTimeout(() => {
                order.push('timer');
                resolve(order);
            }, 0);
            order.push('after');
        });
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!(["before", "after", "timer"]));
}

#[test]
fn set_timeout_nonzero_still_throws() {
    let src = r#"
        module.exports = () => {
            try { setTimeout(() => {}, 100); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let (n, _) = run_both(src);
    let msg = n.as_str().unwrap().to_lowercase();
    assert!(
        msg.contains("non-zero") || msg.contains("not supported"),
        "got: {msg}"
    );
}

#[test]
fn set_immediate_defers() {
    let src = r#"
        module.exports = () => new Promise(resolve => {
            const order = [];
            order.push('sync');
            setImmediate(() => {
                order.push('immediate');
                resolve(order);
            });
        });
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!(["sync", "immediate"]));
}

#[test]
fn nested_microtasks_resolve() {
    // Microtask that schedules another microtask — the pump must
    // drain the queue until empty.
    let src = r#"
        module.exports = () => new Promise(resolve => {
            let n = 0;
            function step() {
                n++;
                if (n < 5) queueMicrotask(step);
                else resolve(n);
            }
            queueMicrotask(step);
        });
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!(5));
}

#[test]
fn promise_rejection_surfaces_as_error() {
    let src = r#"
        module.exports = async () => {
            try { await Promise.reject(new Error('boom')); return 'unexpected'; }
            catch (e) { return { caught: e.message }; }
        };
    "#;
    let (n, _) = run_both(src);
    assert_eq!(n, json!({ "caught": "boom" }));
}

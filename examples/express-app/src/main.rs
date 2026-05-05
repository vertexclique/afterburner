//! Real HTTP server (axum + tokio) that dispatches every request to
//! a real Express.js app running inside Afterburner.
//!
//! Setup:
//!
//! ```text
//! $ cd examples/express-app
//! $ npm install        # populates ./node_modules/express + transitive deps
//! $ cargo run --release
//! listening on http://127.0.0.1:3000
//!
//! $ curl http://127.0.0.1:3000/
//! $ curl http://127.0.0.1:3000/health
//! $ curl http://127.0.0.1:3000/hello/world
//! $ curl -X POST -H 'Content-Type: application/json' -d '[1,2,3]' http://127.0.0.1:3000/sum
//! ```
//!
//! Pipeline:
//!
//! * Axum's tokio runtime accepts connections in parallel.
//! * Each request serialises to a JSON envelope and calls
//!   `Afterburner::run`. Because the Afterburner is built with
//!   `threaded(N)`, those calls fan into the N-worker scheduler;
//!   concurrent requests execute on different workers.
//! * Inside the sandbox, `app.js` does `const express = require('express')`
//!   — Afterburner's CommonJS resolver walks up from the example dir
//!   and reads `node_modules/express/...` via the host fs bridge,
//!   gated by the `Manifold` we install below.
//! * JS state is fresh per call (Afterburner invariant). Sessions /
//!   long-lived state must live host-side and ride the envelope.

use afterburner::{Afterburner, FsAccess, Manifold};
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

const JS_APP: &str = include_str!("app.js");
const BODY_LIMIT: usize = 1 << 20; // 1 MiB

struct AppState {
    ab: Arc<Afterburner>,
    script_id: afterburner::ScriptId,
}

fn main() -> Result<()> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);

    // Resolve the example root (the dir containing `package.json` +
    // `node_modules`). `Afterburner::builder().cwd(path)` pins the
    // require resolver to walk `node_modules` from here.
    let example_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let node_modules = example_root.join("node_modules");
    if !node_modules.is_dir() {
        anyhow::bail!(
            "missing {}\n\nThis example uses the real `express` npm package.\n\
             From this directory, run:\n\n    npm install\n\n\
             Then retry `cargo run --release`.",
            node_modules.display()
        );
    }

    eprintln!("afterburner-example-express-app");
    eprintln!("  thrust workers: {workers}");
    eprintln!("  cwd:            {}", example_root.display());

    // Read-only fs grant scoped to the example root + crypto for
    // Express's transitive deps. The `etag` npm package (used by
    // `res.send` to generate response ETags) calls
    // `crypto.createHash('sha1')`. body-parser uses crypto for
    // signed cookies. Sealed manifold (the default) blocks both.
    // Net, env, child_process, exit all stay denied.
    let manifold = Manifold {
        fs: FsAccess::ReadOnly(vec![example_root.clone()]),
        crypto: true,
        ..Manifold::sealed()
    };

    // Build Afterburner *before* any tokio runtime exists. wasmtime-
    // wasi eagerly creates its own internal single-thread runtime on
    // first use, and constructing it from inside a tokio task
    // trips a "cannot start runtime from within runtime" panic.
    //
    // Manifold goes BEFORE threaded() — `ThreadedBuilder` doesn't
    // expose .manifold (typed-builder discipline). cwd is on the
    // base builder too and propagates into the threaded variant.
    let ab = Afterburner::builder()
        .manifold(manifold)
        .cwd(example_root.clone())
        .threaded(workers)
        .build()
        .context("build afterburner")?;

    let script_id = ab.register(JS_APP).context("register app.js")?;
    let state = Arc::new(AppState {
        ab: Arc::new(ab),
        script_id,
    });

    // Manual tokio runtime so the order is explicit: Afterburner
    // first, tokio second.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("tokio runtime")?;
    rt.block_on(serve(state))
}

async fn serve(state: Arc<AppState>) -> Result<()> {
    // Single catch-all route; the JS router (Express) owns path
    // dispatch.
    let app = Router::new()
        .fallback(any(dispatch))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    eprintln!("  listening on http://{}", listener.local_addr()?);

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        eprintln!("  shutting down…");
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn dispatch(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();
    let headers_clone = req.headers().clone();

    let body_bytes = match to_bytes(req.into_body(), BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("body exceeds {BODY_LIMIT} bytes"),
            )
                .into_response();
        }
    };

    let envelope = build_envelope(&method, &path, &query, &headers_clone, &body_bytes);

    // The Afterburner handle is Send + Sync; we can call through
    // without spawning. `run` blocks in the tokio task — with multi-
    // worker tokio rt, other requests keep flowing on other worker
    // threads. For heavier workloads use `spawn_blocking`.
    let ab = state.ab.clone();
    let id = state.script_id;
    let out = tokio::task::spawn_blocking(move || ab.run(&id, &envelope))
        .await
        .map_err(|e| anyhow::anyhow!("tokio join: {e}"))
        .and_then(|r| r.map_err(|e| anyhow::anyhow!("{e}")));

    match out {
        Ok(v) => {
            let resp = shape_response(v);
            eprintln!(
                "  {method} {path} → {} ({:?})",
                resp.status(),
                started.elapsed()
            );
            resp
        }
        Err(e) => {
            eprintln!("  {method} {path} → 500 (handler error: {e})");
            (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response()
        }
    }
}

fn build_envelope(
    method: &Method,
    path: &str,
    query: &str,
    headers: &HeaderMap,
    body_bytes: &[u8],
) -> Value {
    // Only string headers go in; binary headers would need a
    // different transport. Lowercased keys match Express's
    // convention.
    let mut hdrs = Map::new();
    for (name, value) in headers {
        if let Ok(s) = value.to_str() {
            hdrs.insert(name.as_str().to_lowercase(), Value::String(s.to_string()));
        }
    }

    // Try to parse body as JSON; fall back to a string so text/html
    // endpoints still work.
    let body = if body_bytes.is_empty() {
        Value::Null
    } else if let Ok(v) = serde_json::from_slice::<Value>(body_bytes) {
        v
    } else {
        Value::String(String::from_utf8_lossy(body_bytes).into_owned())
    };

    json!({
        "method": method.as_str(),
        "path": path,
        "query": query,
        "headers": Value::Object(hdrs),
        "body": body,
    })
}

fn shape_response(v: Value) -> Response {
    let obj = v.as_object();
    let status_code = obj
        .and_then(|o| o.get("status"))
        .and_then(|s| s.as_u64())
        .unwrap_or(200) as u16;
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);

    let headers_map = obj
        .and_then(|o| o.get("headers"))
        .and_then(|h| h.as_object())
        .cloned()
        .unwrap_or_default();

    let body = obj.and_then(|o| o.get("body")).cloned().unwrap_or(Value::Null);

    // Serialize the response body per `content-type`. If the JS set
    // one, honor it. Otherwise default to JSON.
    let ct = headers_map
        .get("content-type")
        .and_then(|c| c.as_str())
        .unwrap_or("application/json");

    let (body_bytes, content_type): (Vec<u8>, String) = if ct.starts_with("application/json") {
        (serde_json::to_vec(&body).unwrap_or_default(), ct.to_string())
    } else if let Some(s) = body.as_str() {
        (s.as_bytes().to_vec(), ct.to_string())
    } else {
        (
            serde_json::to_vec(&body).unwrap_or_default(),
            "application/json".to_string(),
        )
    };

    let mut builder = Response::builder()
        .status(status)
        .header("content-type", content_type);
    for (k, v) in &headers_map {
        if k == "content-type" {
            continue;
        }
        if let Some(s) = v.as_str() {
            builder = builder.header(k, s);
        }
    }
    builder
        .body(Body::from(body_bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

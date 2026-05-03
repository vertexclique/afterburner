//! Custom `HostContext` + narrow capability grants. The host:
//!
//!   * Grants `NetAccess::OutboundFull` for just `api.github.com`
//!     (sets the right Manifold — scripts that try any other host
//!     get `PermissionDenied`).
//!   * Grants `EnvAccess::AllowList` for `GITHUB_USER` only, backed
//!     by a private map on the custom host so the script never sees
//!     the real process environment.
//!   * Wires a `log` hook that prefixes every message with `[host
//!     LEVEL]`.
//!   * Collects `emitRow` output from the script into a Vec the Rust
//!     side inspects post-run.
//!
//! The demo script reads its allow-listed env var, emits a couple of
//! structured "rows" back to the host, and returns a summary object.
//! Actual outbound HTTP isn't exercised here — it requires the
//! workspace-level `host-http` polyfill to be composed into the JS
//! bundle, which is beyond this example's scope.

use afterburner::{Afterburner, EnvAccess, HostContext, LogLevel, Manifold, NetAccess};
use anyhow::Result;
use kovan_map::HopscotchMap;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

struct DemoHost {
    rows: HopscotchMap<u64, Value>,
    row_counter: AtomicU64,
}

impl DemoHost {
    fn new() -> Self {
        Self {
            rows: HopscotchMap::new(),
            row_counter: AtomicU64::new(0),
        }
    }

    fn collected_rows(&self) -> Vec<Value> {
        let count = self.row_counter.load(Ordering::Acquire);
        (0..count)
            .filter_map(|i| self.rows.get(&i))
            .collect()
    }
}

impl HostContext for DemoHost {
    fn log(&self, level: LogLevel, message: &str) {
        eprintln!("[host {level:?}] {message}");
    }

    fn get_env(&self, key: &str) -> Option<String> {
        match key {
            "GITHUB_USER" => Some("afterburner-bot".to_string()),
            _ => None,
        }
    }

    fn emit_row(&self, row: Value) {
        let idx = self.row_counter.fetch_add(1, Ordering::AcqRel);
        self.rows.insert(idx, row);
    }
}

fn main() -> Result<()> {
    let host = Arc::new(DemoHost::new());

    let manifold = Manifold {
        net: NetAccess::OutboundFull(Some(vec!["api.github.com".to_string()])),
        env: EnvAccess::AllowList(vec!["GITHUB_USER".to_string()]),
        http_timeout_ms: Some(3_000),
        ..Manifold::sealed()
    };

    let ab = Afterburner::builder()
        .manifold(manifold)
        .host_context(host.clone())
        .build()?;

    let id = ab.register(
        "module.exports = () => { \
             const host = require('afterburner:host'); \
             const user = host.getEnv('GITHUB_USER') || 'anonymous'; \
             host.emitRow({ kind: 'audit', action: 'login', user: user }); \
             host.emitRow({ kind: 'audit', action: 'query', target: '/stats' }); \
             return { user: user, emitted: 2 }; \
         };",
    )?;

    let out = ab.run(&id, &json!(null))?;
    println!("script return: {}", serde_json::to_string_pretty(&out)?);

    let rows = host.collected_rows();
    println!("host-collected rows ({}):", rows.len());
    for row in &rows {
        println!("  {row}");
    }

    assert_eq!(rows.len(), 2);
    Ok(())
}

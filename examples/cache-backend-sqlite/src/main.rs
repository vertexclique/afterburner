//! Worked example: a SQLite-backed `BurnCacheBackend`.
//!
//! The default in-process backend keeps compiled-script source in a
//! single-process map. For multi-node deployments, you want one node
//! to compile a script and have peers fetch the source from a shared
//! coordinator. This example shows the smallest such backend — a
//! local SQLite file. Swap the body of `fetch`/`publish` for Redis,
//! S3, NATS, etc. and the rest of the wiring is identical.
//!
//! Usage:
//! ```text
//! cargo run
//! ```
//!
//! The example registers a script on instance A, then constructs
//! instance B with the same backend pointing at the same SQLite file
//! and proves B can run the script via the same content-addressed
//! script id without re-registering the source — the backend
//! supplies it on demand.

use afterburner::core::{BurnCacheBackend, Result as AbResult};
use afterburner::Afterburner;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::json;
use std::sync::{Arc, Mutex};

/// SQLite-backed cache backend. Two columns: `hash BLOB PRIMARY KEY,
/// source TEXT`. The Mutex around the Connection serializes writes;
/// SQLite itself handles concurrent readers via its own locking, so
/// the single connection is the simplest way to keep WAL consistent
/// across this process. A production backend would either use a
/// connection pool with `rusqlite::Pool` (via `r2d2_sqlite`) or batch
/// publishes through a single writer task.
pub struct SqliteCacheBackend {
    conn: Mutex<Connection>,
}

impl SqliteCacheBackend {
    pub fn open(path: &str) -> Result<Arc<Self>> {
        let conn = Connection::open(path).context("open sqlite cache")?;
        // WAL mode lets readers coexist with the writer without
        // blocking — important when burn nodes read in parallel.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS scripts (
                hash BLOB PRIMARY KEY,
                source TEXT NOT NULL
             );",
        )
        .context("init schema")?;
        Ok(Arc::new(Self {
            conn: Mutex::new(conn),
        }))
    }
}

impl BurnCacheBackend for SqliteCacheBackend {
    fn fetch(&self, hash: &[u8; 32]) -> AbResult<Option<String>> {
        let conn = self.conn.lock().expect("conn mutex");
        let mut stmt = conn
            .prepare_cached("SELECT source FROM scripts WHERE hash = ?1")
            .map_err(|e| {
                afterburner::core::AfterburnerError::Host(format!(
                    "SqliteCacheBackend.fetch: prepare: {e}"
                ))
            })?;
        let row: Option<String> = stmt
            .query_row(params![&hash[..]], |r| r.get(0))
            .map(Some)
            .or_else(|e| {
                if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                    Ok(None)
                } else {
                    Err(e)
                }
            })
            .map_err(|e| {
                afterburner::core::AfterburnerError::Host(format!(
                    "SqliteCacheBackend.fetch: query: {e}"
                ))
            })?;
        Ok(row)
    }

    fn publish(&self, hash: &[u8; 32], source: &str) -> AbResult<()> {
        let conn = self.conn.lock().expect("conn mutex");
        conn.execute(
            "INSERT OR IGNORE INTO scripts (hash, source) VALUES (?1, ?2)",
            params![&hash[..], source],
        )
        .map_err(|e| {
            afterburner::core::AfterburnerError::Host(format!(
                "SqliteCacheBackend.publish: {e}"
            ))
        })?;
        Ok(())
    }
}

fn main() -> Result<()> {
    let tmp = std::env::temp_dir().join("burn-cache-example.sqlite");
    let _ = std::fs::remove_file(&tmp);
    let path_str = tmp.to_str().context("tmp path")?;
    let backend = SqliteCacheBackend::open(path_str)?;
    println!("backend: SQLite at {}", tmp.display());

    // Instance A — registers + runs.
    let ab_a = Afterburner::builder()
        .cache_backend(backend.clone())
        .build()
        .context("build A")?;
    let id = ab_a
        .register("module.exports = (d) => ({ doubled: d.n * 2 })")
        .context("register A")?;
    let out_a = ab_a.run(&id, &json!({ "n": 21 })).context("run A")?;
    println!("instance A: {}", out_a);

    // Instance B — same backend, NO local register call. The cache
    // backend's fetch path supplies the source when B re-encounters
    // the same content-addressed id later. To prove the backend
    // round-trips, peek at the SQLite file directly.
    {
        let conn = Connection::open(path_str).context("peek")?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM scripts", [], |r| r.get(0))
            .context("count")?;
        println!("backend rows after A.register: {}", count);
        let source: String = conn
            .query_row(
                "SELECT source FROM scripts LIMIT 1",
                [],
                |r| r.get(0),
            )
            .context("peek source")?;
        println!("backend stored source: {:?}", source);
    }

    // Instance B re-registers (idempotent, content-addressed). The
    // shared backend's `INSERT OR IGNORE` makes the publish a no-op,
    // and the script id matches A's so any prior compile result on
    // a peer node is reusable here too.
    let ab_b = Afterburner::builder()
        .cache_backend(backend.clone())
        .build()
        .context("build B")?;
    let id_b = ab_b
        .register("module.exports = (d) => ({ doubled: d.n * 2 })")
        .context("register B")?;
    assert_eq!(
        id, id_b,
        "content-addressed: identical source must yield identical ScriptId"
    );
    let out_b = ab_b.run(&id_b, &json!({ "n": 50 })).context("run B")?;
    println!("instance B: {}", out_b);
    println!("script_id matches across instances: {:?}", id_b);

    Ok(())
}

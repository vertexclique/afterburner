//! Realistic UDF-on-rows benchmark for billion-row extrapolation.
//!
//! Drives N rows × C columns through a JavaScript UDF via burn's
//! library API and reports throughput so we can extrapolate to 1B
//! rows. Different scenarios use different N to keep wall time
//! sane (the slow scenarios spend tens of seconds at any N; the
//! fast ones need many rows to amortize startup noise).
//!
//! Scenarios:
//!
//! 1. **per-row, serial submit** — every row submitted via
//!    `.run(&id, &row)` from a single thread. The 16-worker pool
//!    is **mostly idle** here because each `.run()` blocks until
//!    its result returns. Captures the per-row wasm-boundary +
//!    JSON cost without parallelism.
//! 2. **per-row, parallel submit (×W)** — W submitter threads
//!    pull rows from a shared atomic index and dispatch
//!    concurrently. Worker pool stays busy. Realistic for
//!    pipelines that read from parallel sources.
//! 3. **batched** — rows pre-grouped into batches of B; UDF gets
//!    `[row, row, ...]` and returns `[result, result, ...]`.
//!    Amortizes the per-call boundary by `B`.
//! 4. **columnar batched** — same B-row group as
//!    `{c0: [...], c1: [...]}` (Arrow shape). Tighter inner loop
//!    on the JS side.

use afterburner::Afterburner;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

const COLS: usize = 32;
/// Default batch size for the headline columnar/batched scenarios.
const DEFAULT_BATCH_SIZE: usize = 1_000;
/// Phase 0.2 sweep — find the per-call-overhead plateau on the
/// user's box. Each B value runs a full ROWS_BATCHED pass so the
/// numbers are directly comparable.
const BATCH_SWEEP: &[usize] = &[1_000, 2_000, 4_000, 8_000, 16_000, 32_000];

// Per-row serial is ~500 rows/s on my Ryzen 7 5800H — 50K rows
// finishes in ~90s, enough for a stable measurement.
const ROWS_PER_ROW_SERIAL: usize = 50_000;
// Per-row parallel ought to scale ~10× — 200K finishes in ~40s.
const ROWS_PER_ROW_PARALLEL: usize = 200_000;
// Batched / columnar are fast; bigger N gets cleaner numbers.
const ROWS_BATCHED: usize = 500_000;

fn make_row(idx: usize) -> Value {
    let mut obj = serde_json::Map::with_capacity(COLS);
    for c in 0..COLS {
        obj.insert(
            format!("c{c}"),
            Value::from((idx as i64 * (c as i64 + 1)) % 100_000),
        );
    }
    Value::Object(obj)
}

fn report(label: &str, rows: usize, elapsed: std::time::Duration) {
    let secs = elapsed.as_secs_f64();
    let rps = rows as f64 / secs;
    let us_per_row = elapsed.as_micros() as f64 / rows as f64;
    let billion_secs = 1_000_000_000.0 / rps;
    let billion_min = billion_secs / 60.0;
    let billion_hours = billion_min / 60.0;
    let billion_label = if billion_hours >= 1.0 {
        format!("{:>5.1} hours", billion_hours)
    } else {
        format!("{:>5.1} min  ", billion_min)
    };
    println!(
        "  {:30} {:>10.0} rows/sec  ({:>7.2} µs/row)  →  1B in {}",
        label, rps, us_per_row, billion_label,
    );
}

fn bench_per_row_serial(burn: &Afterburner, n: usize) -> Result<()> {
    let id = burn.register(
        "module.exports = (row) => {
            let s = 0;
            for (let i = 0; i < 32; i++) s += row['c' + i];
            return { sum: s, hot: s > 16000000 };
        };",
    )?;
    let rows: Vec<Value> = (0..n).map(make_row).collect();
    let t0 = Instant::now();
    for row in &rows {
        let _ = burn.run(&id, row).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    report("per-row (1 submitter)", n, t0.elapsed());
    Ok(())
}

fn bench_per_row_parallel(burn: &Afterburner, n: usize, submitters: usize) -> Result<()> {
    let id = burn.register(
        "module.exports = (row) => {
            let s = 0;
            for (let i = 0; i < 32; i++) s += row['c' + i];
            return { sum: s, hot: s > 16000000 };
        };",
    )?;
    let rows: Vec<Value> = (0..n).map(make_row).collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| {
        for _ in 0..submitters {
            let rows = &rows;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= rows.len() {
                        return Ok(());
                    }
                    let _ = burn
                        .run(&id, &rows[idx])
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            });
        }
    });
    report(
        &format!("per-row ({submitters} submitters)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

fn bench_batched(burn: &Afterburner, n: usize) -> Result<()> {
    bench_batched_with(burn, n, DEFAULT_BATCH_SIZE)
}

fn bench_batched_with(burn: &Afterburner, n: usize, batch_size: usize) -> Result<()> {
    let id = burn.register(
        "module.exports = (batch) => {
            const out = new Array(batch.length);
            for (let i = 0; i < batch.length; i++) {
                const row = batch[i];
                let s = 0;
                for (let c = 0; c < 32; c++) s += row['c' + c];
                out[i] = { sum: s, hot: s > 16000000 };
            }
            return out;
        };",
    )?;
    let rows: Vec<Value> = (0..n).map(make_row).collect();
    let t0 = Instant::now();
    let mut start = 0;
    while start < rows.len() {
        let end = (start + batch_size).min(rows.len());
        let batch = Value::Array(rows[start..end].to_vec());
        let _ = burn.run(&id, &batch).map_err(|e| anyhow::anyhow!("{e}"))?;
        start = end;
    }
    report(
        &format!("batched (B={batch_size}, 1 submitter)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

fn bench_batched_parallel(burn: &Afterburner, n: usize, submitters: usize) -> Result<()> {
    bench_batched_parallel_with(burn, n, submitters, DEFAULT_BATCH_SIZE)
}

fn bench_batched_parallel_with(
    burn: &Afterburner,
    n: usize,
    submitters: usize,
    batch_size: usize,
) -> Result<()> {
    let id = burn.register(
        "module.exports = (batch) => {
            const out = new Array(batch.length);
            for (let i = 0; i < batch.length; i++) {
                const row = batch[i];
                let s = 0;
                for (let c = 0; c < 32; c++) s += row['c' + c];
                out[i] = { sum: s, hot: s > 16000000 };
            }
            return out;
        };",
    )?;
    let rows: Vec<Value> = (0..n).map(make_row).collect();
    // Pre-build batches so we measure dispatch+JS, not the
    // host-side batch construction.
    let batches: Vec<Value> = rows
        .chunks(batch_size)
        .map(|c| Value::Array(c.to_vec()))
        .collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| {
        for _ in 0..submitters {
            let batches = &batches;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= batches.len() {
                        return Ok(());
                    }
                    let _ = burn
                        .run(&id, &batches[idx])
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            });
        }
    });
    report(
        &format!("batched (B={batch_size}, {submitters} submitters)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

fn bench_columnar_parallel(burn: &Afterburner, n: usize, submitters: usize) -> Result<()> {
    bench_columnar_parallel_with(burn, n, submitters, DEFAULT_BATCH_SIZE)
}

fn bench_columnar_parallel_with(
    burn: &Afterburner,
    n: usize,
    submitters: usize,
    batch_size: usize,
) -> Result<()> {
    let id = burn.register(
        "module.exports = (batch) => {
            const len = batch.c0.length;
            const sum = new Array(len);
            const hot = new Array(len);
            for (let i = 0; i < len; i++) {
                let s = 0;
                for (let c = 0; c < 32; c++) s += batch['c' + c][i];
                sum[i] = s;
                hot[i] = s > 16000000;
            }
            return { sum, hot };
        };",
    )?;
    let rows: Vec<Value> = (0..n).map(make_row).collect();
    let batches: Vec<Value> = rows
        .chunks(batch_size)
        .map(|chunk| {
            let mut cols: Vec<Vec<Value>> = vec![Vec::with_capacity(chunk.len()); COLS];
            for r in chunk {
                let obj = r.as_object().unwrap();
                for c in 0..COLS {
                    cols[c].push(obj[&format!("c{c}")].clone());
                }
            }
            let mut batch = serde_json::Map::with_capacity(COLS);
            for (c, col) in cols.into_iter().enumerate() {
                batch.insert(format!("c{c}"), Value::Array(col));
            }
            Value::Object(batch)
        })
        .collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| {
        for _ in 0..submitters {
            let batches = &batches;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= batches.len() {
                        return Ok(());
                    }
                    let _ = burn
                        .run(&id, &batches[idx])
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            });
        }
    });
    report(
        &format!("columnar (B={batch_size}, {submitters} submitters)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

fn main() -> Result<()> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    println!(
        "billion-row-bench: {} cols, {} workers (auto)\n",
        COLS, workers,
    );

    let burn = Afterburner::builder().threaded_auto().build()?;

    println!("(warm-up first run, then results)\n");
    println!("results:");

    bench_per_row_serial(&burn, ROWS_PER_ROW_SERIAL)?;
    bench_per_row_parallel(&burn, ROWS_PER_ROW_PARALLEL, workers)?;
    bench_batched(&burn, ROWS_BATCHED)?;
    bench_batched_parallel(&burn, ROWS_BATCHED, workers)?;
    bench_columnar_parallel(&burn, ROWS_BATCHED, workers)?;

    println!("\nbatch-size sweep (columnar, {workers} submitters, {ROWS_BATCHED} rows):");
    for &b in BATCH_SWEEP {
        bench_columnar_parallel_with(&burn, ROWS_BATCHED, workers, b)?;
    }

    Ok(())
}

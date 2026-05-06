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
use afterburner::wasi::{ColumnDtype, ColumnRef, ColumnarBatch, INLINE_SLOT_BYTES, INLINE_SLOT_INLINE_MAX};
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

/// Phase 1 — typed columnar API (`Afterburner::run_columnar`). Same
/// 32-Float64-column sum-of-columns shape as
/// [`bench_columnar_parallel`], but the data path is now binary
/// blob → wasm linmem → JS-side `Float64Array` view → user UDF →
/// reply blob. No JSON encode/decode anywhere in the per-call path.
///
/// Pre-builds one `ColumnarBatch`-shaped `Vec<u8>` per chunk so the
/// timer measures dispatch+JS, not the host-side encode (the
/// encode is in-process memcpy, not the work we're benchmarking).
fn bench_columnar_typed_parallel(
    burn: &Afterburner,
    n: usize,
    submitters: usize,
    batch_size: usize,
) -> Result<()> {
    let id = burn.register(
        "module.exports = (b) => {
            const n = b.row_count;
            const out = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                let s = 0;
                for (let j = 0; j < 32; j++) s += b.columns['c' + j][i];
                out[i] = s;
            }
            return { row_count: n, columns: { sum: out } };
        };",
    )?;

    // Build column buffers row-major-by-row, then transpose into
    // column-major byte buffers per chunk.
    let chunks = n.div_ceil(batch_size);
    // For each chunk: 32 column buffers, each `batch_size × 8` bytes.
    let chunk_bufs: Vec<Vec<Vec<u8>>> = (0..chunks)
        .map(|chunk_idx| {
            let row_start = chunk_idx * batch_size;
            let row_end = (row_start + batch_size).min(n);
            let chunk_rows = row_end - row_start;
            let mut cols: Vec<Vec<u8>> = (0..COLS)
                .map(|_| Vec::with_capacity(chunk_rows * 8))
                .collect();
            for row_idx in row_start..row_end {
                for c in 0..COLS {
                    let v = ((row_idx as i64 * (c as i64 + 1)) % 100_000) as f64;
                    cols[c].extend_from_slice(&v.to_le_bytes());
                }
            }
            cols
        })
        .collect();
    let names: Vec<String> = (0..COLS).map(|c| format!("c{c}")).collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| -> Result<()> {
        let mut handles = Vec::with_capacity(submitters);
        for _ in 0..submitters {
            let chunk_bufs = &chunk_bufs;
            let names = &names;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            handles.push(s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= chunk_bufs.len() {
                        return Ok(());
                    }
                    let cols = &chunk_bufs[idx];
                    let chunk_rows = (cols[0].len() / 8) as u32;
                    let mut batch = ColumnarBatch::new(chunk_rows);
                    for c in 0..COLS {
                        batch.push(ColumnRef {
                            name: names[c].as_str(),
                            dtype: ColumnDtype::Float64,
                            data: &cols[c],
            heap: None,
                            validity: None,
                        });
                    }
                    let _ = burn
                        .run_columnar(&id, &batch)
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            }));
        }
        // Drain submitter results — surface the first error instead
        // of silently dropping them. The earlier scenarios in this
        // bench fan out and ignore submitter results; that pattern
        // hid a "Mode::Wasm not selected, run_columnar errors out
        // immediately" misconfiguration as a 337M-rows/sec phantom
        // number. Don't repeat that.
        for h in handles {
            h.join()
                .map_err(|_| anyhow::anyhow!("submitter panicked"))??;
        }
        Ok(())
    })?;
    report(
        &format!("columnar-typed (B={batch_size}, {submitters} submitters)"),
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

    println!("\nbatch-size sweep (columnar JSON, {workers} submitters, {ROWS_BATCHED} rows):");
    for &b in BATCH_SWEEP {
        bench_columnar_parallel_with(&burn, ROWS_BATCHED, workers, b)?;
    }

    // Phase 1 typed columnar API — `run_columnar` over a binary
    // `ColumnarBatch`. Adaptive routes columnar to its inner
    // `WasmCombustor` (block-waiting up to 5s for the background
    // wasm compile if needed); the threaded engine bypasses the
    // worker pipeline and dispatches directly into the wasm pool.
    // Either way, N submitters issuing concurrent `run_columnar`
    // calls all run in parallel — the wasmtime pooling allocator
    // is itself thread-safe.
    //
    // The bench above used `threaded_auto()` — same instance works
    // for the columnar path now; no separate single-threaded build
    // needed.
    let burn_st = &burn;
    println!("\nPhase 1 typed-columnar API (run_columnar):");
    bench_columnar_typed_parallel(burn_st, ROWS_BATCHED, workers, DEFAULT_BATCH_SIZE)?;

    println!(
        "\nbatch-size sweep (columnar-typed, {workers} submitters, {ROWS_BATCHED} rows):"
    );
    for &b in BATCH_SWEEP {
        bench_columnar_typed_parallel(burn_st, ROWS_BATCHED, workers, b)?;
    }

    // Compute-light UDF (single Float64 column → doubled). The
    // 32-col sum-of-columns scenario above is *compute-bound* in
    // QuickJS interpretation — 524K element loads + adds + stores
    // per call at QuickJS-speed dominates the boundary savings.
    // This shape isolates the boundary cost itself: trivial JS work,
    // so the numbers reflect almost pure dispatch + JSON-vs-blob
    // boundary cost.
    println!("\ncompute-light UDF (1 Float64 col, doubled):");
    bench_columnar_typed_double(burn_st, ROWS_BATCHED, workers, 16_000)?;

    // Phase 1.5 var-width path — 1 Utf8 input column → 1 Int32 length
    // column. Tests the string boundary throughput separate from the
    // Float64 numeric one (the var-width path has UTF-8 decode +
    // slot/heap layout overhead the numeric path doesn't pay).
    println!("\nPhase 1.5 var-width path (1 Utf8 col → Int32 length):");
    bench_columnar_typed_utf8_length(burn_st, ROWS_BATCHED, workers, 4_000)?;

    Ok(())
}

fn bench_columnar_typed_utf8_length(
    burn: &Afterburner,
    n: usize,
    submitters: usize,
    batch_size: usize,
) -> Result<()> {
    let id = burn.register(
        "module.exports = (b) => {
            const n = b.row_count;
            const xs = b.columns.s;
            const out = new Int32Array(n);
            for (let i = 0; i < n; i++) out[i] = xs[i].length;
            return { row_count: n, columns: { len: out } };
        };",
    )?;
    // Pre-build chunks: each row's value is `row_idx % 100 == 0 ?
    // long-string : short-string`, so ~1% of rows hit the heap path
    // and the rest are inline. This matches a typical "mostly short
    // identifiers, occasional URL/long-text" workload.
    let chunks = n.div_ceil(batch_size);
    let chunk_bufs: Vec<(Vec<u8>, Vec<u8>)> = (0..chunks)
        .map(|chunk_idx| {
            let row_start = chunk_idx * batch_size;
            let row_end = (row_start + batch_size).min(n);
            let chunk_rows = row_end - row_start;
            let mut slots = vec![0u8; chunk_rows * INLINE_SLOT_BYTES];
            let mut heap: Vec<u8> = Vec::new();
            for r in 0..chunk_rows {
                let row_idx = row_start + r;
                let s: String = if row_idx.is_multiple_of(100) {
                    format!("https://example.com/path/{row_idx}/long")
                } else {
                    format!("k{row_idx}")
                };
                let bytes = s.as_bytes();
                let sb = r * INLINE_SLOT_BYTES;
                slots[sb..sb + 4]
                    .copy_from_slice(&(bytes.len() as u32).to_le_bytes());
                if bytes.len() <= INLINE_SLOT_INLINE_MAX {
                    slots[sb + 4..sb + 4 + bytes.len()].copy_from_slice(bytes);
                } else {
                    slots[sb + 4..sb + 8].copy_from_slice(&bytes[0..4]);
                    slots[sb + 12..sb + 16]
                        .copy_from_slice(&(heap.len() as u32).to_le_bytes());
                    heap.extend_from_slice(bytes);
                }
            }
            (slots, heap)
        })
        .collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| -> Result<()> {
        let mut handles = Vec::with_capacity(submitters);
        for _ in 0..submitters {
            let chunk_bufs = &chunk_bufs;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            handles.push(s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= chunk_bufs.len() {
                        return Ok(());
                    }
                    let (slots, heap) = &chunk_bufs[idx];
                    let chunk_rows = (slots.len() / INLINE_SLOT_BYTES) as u32;
                    let mut batch = ColumnarBatch::new(chunk_rows);
                    batch.push(ColumnRef {
                        name: "s",
                        dtype: ColumnDtype::Utf8,
                        data: slots,
                        heap: Some(heap),
                        validity: None,
                    });
                    let _ = burn
                        .run_columnar(&id, &batch)
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            }));
        }
        for h in handles {
            h.join()
                .map_err(|_| anyhow::anyhow!("submitter panicked"))??;
        }
        Ok(())
    })?;
    report(
        &format!("columnar-typed-utf8-len (B={batch_size}, {submitters} submitters)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

fn bench_columnar_typed_double(
    burn: &Afterburner,
    n: usize,
    submitters: usize,
    batch_size: usize,
) -> Result<()> {
    let id = burn.register(
        "module.exports = (b) => {
            const n = b.row_count;
            const x = b.columns.x;
            const out = new Float64Array(n);
            for (let i = 0; i < n; i++) out[i] = x[i] * 2;
            return { row_count: n, columns: { y: out } };
        };",
    )?;
    let chunks = n.div_ceil(batch_size);
    let chunk_bufs: Vec<Vec<u8>> = (0..chunks)
        .map(|chunk_idx| {
            let row_start = chunk_idx * batch_size;
            let row_end = (row_start + batch_size).min(n);
            let mut buf = Vec::with_capacity((row_end - row_start) * 8);
            for row_idx in row_start..row_end {
                buf.extend_from_slice(&((row_idx as f64) * 1.5).to_le_bytes());
            }
            buf
        })
        .collect();
    let next = Arc::new(AtomicUsize::new(0));

    let t0 = Instant::now();
    thread::scope(|s| -> Result<()> {
        let mut handles = Vec::with_capacity(submitters);
        for _ in 0..submitters {
            let chunk_bufs = &chunk_bufs;
            let next = Arc::clone(&next);
            let id = id.clone();
            let burn = burn;
            handles.push(s.spawn(move || -> Result<()> {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= chunk_bufs.len() {
                        return Ok(());
                    }
                    let buf = &chunk_bufs[idx];
                    let chunk_rows = (buf.len() / 8) as u32;
                    let mut batch = ColumnarBatch::new(chunk_rows);
                    batch.push(ColumnRef {
                        name: "x",
                        dtype: ColumnDtype::Float64,
                        data: buf,
            heap: None,
                        validity: None,
                    });
                    let _ = burn
                        .run_columnar(&id, &batch)
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            }));
        }
        for h in handles {
            h.join()
                .map_err(|_| anyhow::anyhow!("submitter panicked"))??;
        }
        Ok(())
    })?;
    report(
        &format!("columnar-typed-1col×2 (B={batch_size}, {submitters} submitters)"),
        n,
        t0.elapsed(),
    );
    Ok(())
}

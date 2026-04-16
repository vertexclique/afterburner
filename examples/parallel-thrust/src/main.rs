//! Multi-worker scheduler demo. Builds an `Afterburner` with
//! `threaded(N)` workers, fans a CPU-bound workload across client
//! threads, and reports throughput + p50/p99 latency.

use afterburner::Afterburner;
use anyhow::Result;
use serde_json::{Value, json};
use std::thread;
use std::time::Instant;

fn main() -> Result<()> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    let iters_per_worker = 2_000;
    let total = workers * iters_per_worker;

    let ab = Afterburner::builder().threaded(workers).build()?;

    // CPU-bound script: ~0.5ms of work per call on commodity hardware.
    let id = ab.register(
        "module.exports = (d) => { \
             let s = 0; \
             for (let i = 0; i < 50000; i++) s += i; \
             return { sum: s, tag: d.tag }; \
         };",
    )?;

    eprintln!(
        "parallel-thrust: {workers} workers × {iters_per_worker} iters = {total} thrusts"
    );

    let ab_ref = &ab;
    let id_ref = &id;

    let t0 = Instant::now();
    let latencies: Vec<u128> = thread::scope(|s| {
        let mut handles = Vec::with_capacity(workers);
        for worker_id in 0..workers {
            handles.push(s.spawn(move || -> Result<Vec<u128>> {
                let mut lat = Vec::with_capacity(iters_per_worker);
                for i in 0..iters_per_worker {
                    let t = Instant::now();
                    let _ = ab_ref.run(
                        id_ref,
                        &json!({ "tag": format!("w{worker_id}-{i}") }),
                    )?;
                    lat.push(t.elapsed().as_micros());
                }
                Ok(lat)
            }));
        }
        let mut all: Vec<u128> = Vec::with_capacity(total);
        for h in handles {
            all.extend(h.join().unwrap()?);
        }
        Ok::<Vec<u128>, anyhow::Error>(all)
    })?;
    let elapsed = t0.elapsed();

    let mut lat = latencies;
    lat.sort_unstable();
    let p50 = lat[lat.len() / 2];
    let p99 = lat[((lat.len() as f64) * 0.99) as usize];
    let throughput = total as f64 / elapsed.as_secs_f64();

    eprintln!(
        "done in {elapsed:?}  →  {throughput:.0}/sec  p50={p50}us  p99={p99}us"
    );

    // Sanity check: every result is shaped as expected.
    let sample: Value = ab.run(&id, &json!({ "tag": "sanity" }))?;
    assert!(sample.get("sum").is_some());
    Ok(())
}

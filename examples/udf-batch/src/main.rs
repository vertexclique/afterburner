//! Batched-UDF idiom. Register one script. Apply it across a JSON
//! array of records via `run_batch`. Prints throughput + the first
//! few results.

use afterburner::Afterburner;
use anyhow::Result;
use serde_json::{Value, json};
use std::time::Instant;

fn main() -> Result<()> {
    let ab = Afterburner::new()?;

    // `run_batch` passes the *whole array* to the script — it's your
    // job to `.map` over it. This shape wins on throughput: one
    // entry-and-exit across the wasm boundary instead of N.
    let id = ab.register(
        "module.exports = (rows) => rows.map((row) => ({ \
             id: row.id, \
             name_upper: row.name.toUpperCase(), \
             total: row.qty * row.price \
         }));",
    )?;

    let n = 2_000;
    let rows: Vec<Value> = (0..n)
        .map(|i| {
            json!({
                "id": i,
                "name": format!("item-{i}"),
                "qty": (i % 17) + 1,
                "price": 0.99 + (i as f64 % 20.0),
            })
        })
        .collect();
    let input = Value::Array(rows);

    let t0 = Instant::now();
    let out = ab.run_batch(&id, &input)?;
    let elapsed = t0.elapsed();

    let out_arr = out.as_array().expect("run_batch returns an array");
    assert_eq!(out_arr.len(), n);

    let throughput = n as f64 / elapsed.as_secs_f64();
    eprintln!(
        "udf-batch: {n} rows in {elapsed:?}  ({throughput:.0} rows/sec)"
    );

    for v in out_arr.iter().take(3) {
        println!("{v}");
    }
    Ok(())
}

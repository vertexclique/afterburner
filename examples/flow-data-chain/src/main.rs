//! Flow engine demo. The "data chain" is a convention where multiple
//! pipeline operations see a shared JSON object under stable keys —
//! the script can read any prior step's output and add its own.
//!
//! `Afterburner::builder().flow()` tunes the defaults for flow-style
//! use (generous fuel, 30s timeout, 64 MiB memory) and unlocks
//! `register_bundle` for multi-file ES module scripts.

use afterburner::Afterburner;
use anyhow::Result;
use serde_json::json;

fn main() -> Result<()> {
    let ab = Afterburner::builder().flow().build()?;

    // A simple data-chain step: reads `$trigger` + an upstream op's
    // output, writes a new key.
    // Note: keep the JS on one logical line — `//` line comments
    // inside Rust's `\ `-joined string would swallow the rest of
    // the source. Use `/* … */` if you need inline notes.
    let id = ab.register(
        "module.exports = (chain) => ({ \
             ...chain, \
             normalized: { \
                 user: chain['$trigger'].user.toLowerCase(), \
                 score: (chain.compute_score || {}).value * 2, \
             }, \
         });",
    )?;

    // Caller owns the key under which the script's output lands — we
    // pretend this step is named "normalize" in the flow. For demo
    // purposes we pass a pre-built chain plus the upstream step's
    // result.
    let chain = json!({
        "$trigger": { "user": "ALICE", "payload": { "x": 1 } },
        "compute_score": { "value": 21 },
    });

    let out = ab.run(&id, &chain)?;
    println!("{}", serde_json::to_string_pretty(&out)?);

    assert_eq!(out["normalized"]["user"], json!("alice"));
    assert_eq!(out["normalized"]["score"], json!(42));
    Ok(())
}

//! Minimal embedding of Afterburner that mimics `burn run <file>` in
//! ~30 lines. Proves the public `afterburner` API is sufficient for
//! building your own JS CLI — you don't need the full `burn` binary.
//!
//! Usage:
//! ```text
//! cargo run -- path/to/script.js
//! ```

use afterburner::Afterburner;
use anyhow::{Context, Result};
use serde_json::Value;
use std::fs;

fn main() -> Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        // Default payload so the example runs cleanly with no args.
        let tmp = std::env::temp_dir().join("afterburner-embedding-demo.js");
        fs::write(
            &tmp,
            "module.exports = () => ({ hello: 'from embedding', answer: 42 });",
        )
        .unwrap();
        tmp.to_string_lossy().into_owned()
    });

    let source = fs::read_to_string(&path).with_context(|| format!("reading {path}"))?;
    let ab = Afterburner::new()?;
    let id = ab.register(&source).context("compile")?;
    let out = ab.run(&id, &Value::Null)?;
    if !out.is_null() {
        println!("{}", serde_json::to_string(&out)?);
    }
    Ok(())
}

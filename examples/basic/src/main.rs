//! The smallest useful Afterburner program. Registers a one-line JS
//! UDF, runs it once, asserts the result, and prints it.
//!
//! ```text
//! $ cargo run
//! { "doubled": 42 }
//! ```

use afterburner::Afterburner;
use anyhow::Result;
use serde_json::json;

fn main() -> Result<()> {
    let ab = Afterburner::new()?;

    let id = ab.register("module.exports = (d) => ({ doubled: d.n * 2 });")?;

    let out = ab.run(&id, &json!({ "n": 21 }))?;
    assert_eq!(out, json!({ "doubled": 42 }));

    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

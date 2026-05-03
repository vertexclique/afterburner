//! Streaming-hash demo. Uses `crypto.createHash` + `.update` +
//! `.digest` — the Node-compat streaming API backed by host-side
//! stateful digest handles (Sha256 / Sha384 / Sha512 / Md5).
//!
//! Crypto requires `Manifold::crypto = true`, which `Manifold::open`
//! grants. Sealed manifold (the default) denies crypto entirely —
//! swap `open()` for `sealed()` to see the `PermissionDenied`.

use afterburner::{Afterburner, Manifold};
use anyhow::Result;
use serde_json::json;

fn main() -> Result<()> {
    let ab = Afterburner::builder().manifold(Manifold::open()).build()?;

    // The script builds a large buffer, feeds it to createHash in 4
    // chunks, and returns the hex digest. The streaming handle lives
    // on the host across update calls — no per-chunk allocation on
    // the JS side.
    let id = ab.register(
        "const { createHash } = require('crypto'); \
         module.exports = () => { \
             const h = createHash('sha256'); \
             const chunk = 'a'.repeat(256 * 1024); \
             for (let i = 0; i < 4; i++) h.update(chunk); \
             return h.digest('hex'); \
         };",
    )?;

    let out = ab.run(&id, &json!(null))?;
    println!("sha256 of 1MiB of 'a': {}", out.as_str().unwrap_or(""));

    // Reference value so the example double-checks its own output.
    // 1 MiB = 1048576 bytes of ASCII 'a' hashes to a known digest.
    assert_eq!(
        out.as_str(),
        Some("9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360")
    );
    Ok(())
}

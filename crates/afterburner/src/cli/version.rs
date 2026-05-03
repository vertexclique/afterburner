//! `burn version` — build info.

use anyhow::Result;

pub fn print_version() -> Result<()> {
    println!("burn {}", env!("CARGO_PKG_VERSION"));
    println!("features:");
    println!("  wasm      = {}", cfg!(feature = "wasm"));
    println!("  native    = {}", cfg!(feature = "native"));
    println!("  adaptive  = {}", cfg!(feature = "adaptive"));
    println!("  thrust    = {}", cfg!(feature = "thrust"));
    println!("  flow      = {}", cfg!(feature = "flow"));
    println!("  host-http = {}", cfg!(feature = "host-http"));
    Ok(())
}

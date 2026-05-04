//! `burn run FILE args…` and `burn -e CODE args…` — execute a
//! top-level script.
//!
//! Routes through the plugin's **daemon mode** (Q2-A): user source
//! runs via `daemon-init`; if it didn't install any HTTP listeners
//! (or `setInterval` — B3) the script exits cleanly like a plain
//! one-shot. When listeners are present the CLI transitions into
//! the dispatcher event loop until SIGINT.
//!
//! The UDF shape (`module.exports = (data) => …`) remains available
//! via `burn thrust`.
//!
//! `.ts` / `.mts` / `.cts` files are transpiled via `oxc` before
//! dispatch when the crate is built with the `ts` feature. Without
//! `ts`, running a `.ts` file surfaces a typed error pointing at the
//! feature flag rather than letting the JS parser choke on
//! type annotations.

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use super::args::Cli;
use super::daemon::{execute, script_label};

pub fn run_file(cli: &Cli, path: &PathBuf, user_args: &[String]) -> Result<()> {
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    let label = script_label(path);
    let js_source = maybe_transpile_ts(&source, path)?;
    if cli.internal_worker {
        // worker child mode. Bootstraps a `DaemonWorkers::new_child`
        // (which blocks on stdin for the init frame) and runs the
        // script under the same daemon-mode plumbing the parent uses.
        return super::worker::execute(cli, &js_source, &label, user_args);
    }
    execute(cli, &js_source, &label, user_args)
}

pub fn run_source(cli: &Cli, source: &str, user_args: &[String]) -> Result<()> {
    if cli.internal_worker {
        return super::worker::execute(cli, source, "[eval]", &[]);
    }
    execute(cli, source, "[eval]", user_args)
}

/// With the `ts` feature: TS files are transpiled (strip-types +
/// ESM→CJS) via oxc, and `.js`/`.mjs` files are ESM-lowered to CJS
/// so `import`/`export` works under our CJS runtime.
///
/// Without the `ts` feature: TS files surface a typed error; `.js`
/// files pass through unchanged (no ESM lowering available without
/// the transpile dep graph).
#[cfg(feature = "ts")]
fn maybe_transpile_ts(source: &str, path: &std::path::Path) -> Result<String> {
    if crate::ts::is_typescript(path) {
        return crate::ts::transpile(source, path).map_err(|e| anyhow::anyhow!("{e}"));
    }
    // lower ESM in plain JS too. Plain CJS source contains no
    // ESM declarations and returns unchanged.
    crate::ts::lower_esm_js(source, path).map_err(|e| anyhow::anyhow!("{e}"))
}

#[cfg(not(feature = "ts"))]
fn maybe_transpile_ts(source: &str, path: &std::path::Path) -> Result<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if matches!(
        ext.as_deref(),
        Some("ts") | Some("mts") | Some("cts") | Some("tsx")
    ) {
        anyhow::bail!(
            "burn: TypeScript support requires the `ts` cargo feature (rebuild with `cargo install afterburner --features ts`). \
             File: {}",
            path.display()
        );
    }
    Ok(source.to_string())
}

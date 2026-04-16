//! Script-mode plumbing shared by `run_file` / `run_source`.
//!
//! Builds a [`ScriptInvocation`] from CLI flags + user-supplied
//! trailing args, then delegates to the facade's
//! [`Afterburner::run_script_with`]. The captured stdout/stderr are
//! streamed to the real host process streams; the Node-style exit
//! code flows out through `std::process::exit`.

use crate::{Afterburner, AfterburnerError, EnvAccess, ScriptInvocation};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use super::args::Cli;
use super::manifold::build_manifold;

/// Compose a [`ScriptInvocation`] matching the Node convention
/// `["program", "<script>", ...user_args]`. `script_label` is the
/// string to put at `argv[1]` — the absolute file path for `run`, or
/// `"[eval]"` for `-e`.
pub fn build_invocation(cli: &Cli, script_label: &str, user_args: &[String]) -> ScriptInvocation {
    let mut argv = Vec::with_capacity(2 + user_args.len());
    argv.push("burn".to_string());
    argv.push(script_label.to_string());
    argv.extend(user_args.iter().cloned());

    ScriptInvocation {
        argv,
        env: collect_env(cli),
    }
}

/// Resolve the `process.env` map per the active [`Manifold`]:
///
/// * `EnvAccess::None` → empty map.
/// * `EnvAccess::AllowList(keys)` → exactly those keys (missing ones
///   are silently omitted rather than surfaced as empty strings).
/// * `EnvAccess::Full` → every env var currently in the host
///   process's environment.
fn collect_env(cli: &Cli) -> BTreeMap<String, String> {
    let manifold = build_manifold(cli);
    match &manifold.env {
        EnvAccess::None => BTreeMap::new(),
        EnvAccess::AllowList(keys) => keys
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| (k.clone(), v)))
            .collect(),
        EnvAccess::Full => std::env::vars().collect(),
    }
}

/// Run `source` in script mode and forward captured stdout / stderr
/// + exit code to the real host process streams. On `exit_code != 0`
/// this calls [`std::process::exit`] — same semantics as Node.
pub fn execute(
    ab: &Afterburner,
    source: &str,
    script_label: &str,
    user_args: &[String],
    cli: &Cli,
) -> Result<()> {
    let invocation = build_invocation(cli, script_label, user_args);
    let outcome = ab
        .run_script_with(source, &invocation, ab.default_limits())
        .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;

    std::io::stdout()
        .write_all(&outcome.stdout)
        .context("write script stdout")?;
    std::io::stderr()
        .write_all(&outcome.stderr)
        .context("write script stderr")?;

    if outcome.exit_code != 0 {
        // Preserve the script's exit code via `process::exit`. Node
        // does the same — and there is no sensible "anyhow::Result"
        // mapping for "script exited cleanly with code 2."
        std::process::exit(outcome.exit_code);
    }
    Ok(())
}

/// Resolve a user-supplied script path to an absolute path suitable
/// for `process.argv[1]`. Falls back to the raw string if the path
/// can't be canonicalised (e.g. not yet created).
pub fn script_label(path: &Path) -> String {
    path.canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

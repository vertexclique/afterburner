//! Pass-through dispatch for `burn node foo.js`, `burn npm install`, etc.
//!
//! B4 lands `node` — the rest of the targets (`npm`, `npx`, `pnpm`,
//! `yarn`, `bun`) need the PATH shim from B5 to intercept child-process
//! `node` invocations.
//!
//! **Q5-A existing-file-wins rule**: if `argv[1]` resolves to a file
//! in cwd, "run this file" takes priority over pass-through. This
//! prevents `burn tsc.js` (a local file) from being confused with
//! `burn tsc` (a global binary). [`detect`] enforces the rule.

use anyhow::Result;
use std::path::PathBuf;

use super::args::Cli;
use super::banner;
use super::run;

/// Known pass-through targets. `node` is handled in B4; the others
/// need the PATH shim from B5.
const PASSTHROUGH_TARGETS: &[&str] = &["node", "npm", "npx", "pnpm", "yarn", "bun"];

/// Check whether `file` is a pass-through target. Returns the target
/// name if:
///
/// 1. The file stem (without extension) matches a known target, AND
/// 2. The path does not resolve to an existing file (Q5-A:
///    existing-file-wins).
///
/// The caller is responsible for routing through [`dispatch`] when
/// this returns `Some`.
pub fn detect(file: &PathBuf) -> Option<&'static str> {
    // Only bare names qualify — `./node`, `/usr/bin/node`,
    // `subdir/node` are file paths the user wants to run directly.
    if file.components().count() != 1 {
        return None;
    }
    let stem = file.to_string_lossy();
    let target = PASSTHROUGH_TARGETS.iter().find(|&&t| stem == t)?;

    // Q5-A: existing-file-wins.
    if file.exists() {
        return None;
    }
    Some(target)
}

/// Dispatch a detected pass-through target.
pub fn dispatch(cli: &mut Cli, target: &str) -> Result<()> {
    banner::maybe_show(cli);
    match target {
        "node" => dispatch_node(cli),
        other => anyhow::bail!(
            "burn: `burn {other} …` requires the PATH shim (B5, not yet implemented).\n\
             Run the command directly and set `node` to `burn` on your PATH,\n\
             or use `burn run <file>` to execute scripts."
        ),
    }
}

/// `burn node foo.js arg1 arg2` → `burn run foo.js arg1 arg2`
/// `burn node -e 'code' arg1`   → `burn -e 'code' arg1`
fn dispatch_node(cli: &mut Cli) -> Result<()> {
    // `-e` is a global flag already parsed by clap into `cli.eval_code`.
    if let Some(code) = cli.eval_code.take() {
        return run::run_source(cli, &code, &cli.rest_args);
    }

    let args = std::mem::take(&mut cli.rest_args);
    if args.is_empty() {
        anyhow::bail!(
            "burn node: missing script path\n\
             usage: burn node <file.js> [args…]\n\
             usage: burn node -e '<code>' [args…]"
        );
    }

    let file = PathBuf::from(&args[0]);
    let user_args = &args[1..];
    run::run_file(cli, &file, user_args)
}

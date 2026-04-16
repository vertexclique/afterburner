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

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use super::args::Cli;
use super::daemon::{execute, script_label};

pub fn run_file(cli: &Cli, path: &PathBuf, user_args: &[String]) -> Result<()> {
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    let label = script_label(path);
    execute(cli, &source, &label, user_args)
}

pub fn run_source(cli: &Cli, source: &str, user_args: &[String]) -> Result<()> {
    execute(cli, source, "[eval]", user_args)
}

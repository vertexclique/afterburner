//! `burn run FILE args…` and `burn -e CODE args…` — execute a
//! top-level script.
//!
//! Both paths route through the plugin's **script mode** (no UDF
//! envelope, `console.log` to real stdout, `process.argv` /
//! `process.env` populated from CLI flags). The UDF shape
//! (`module.exports = (data) => …`) remains available via
//! `burn thrust`.

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use super::args::Cli;
use super::build::build_afterburner;
use super::script::{execute, script_label};

pub fn run_file(cli: &Cli, path: &PathBuf, user_args: &[String]) -> Result<()> {
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    let ab = build_afterburner(cli)?;
    let label = script_label(path);
    execute(&ab, &source, &label, user_args, cli)
}

pub fn run_source(cli: &Cli, source: &str, user_args: &[String]) -> Result<()> {
    let ab = build_afterburner(cli)?;
    execute(&ab, source, "[eval]", user_args, cli)
}

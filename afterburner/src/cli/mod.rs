//! Command-line dispatcher for the `burn` binary.
//!
//! Thin top-level: parse args, match on subcommand, delegate to one of
//! the per-subcommand files in this directory. Everything is gated
//! behind the `bin` cargo feature.
//!
//! Public surface exists so integration tests under `afterburner/tests/`
//! can exercise the flag-to-[`Manifold`] translation without spawning
//! the binary.

mod args;
mod banner;
mod bench;
mod build;
mod check;
mod daemon;
mod manifold;
mod repl;
mod run;
mod script;
mod thrust;
mod version;

use anyhow::Result;
use clap::Parser;

pub use args::{Cli, Cmd, parse_mode};
pub use build::build_afterburner;
pub use manifold::{build_manifold, has_wildcard, is_implicit_open, parse_allow_list};

/// Entry point. `main()` in the `burn` binary delegates here.
pub fn run() -> Result<()> {
    let cli = Cli::parse();
    dispatch(cli)
}

fn dispatch(mut cli: Cli) -> Result<()> {
    let cmd = match cli.command.take() {
        Some(c) => c,
        None => {
            if let Some(code) = cli.eval_code.clone() {
                // With `-e CODE arg1 arg2`, clap binds the *first*
                // positional to `cli.file` (its declared slot), and
                // the rest into `cli.rest_args`. For eval mode, that
                // first positional is actually a script arg — fold it
                // back into `rest_args` so `process.argv` matches the
                // user's intent.
                let mut rest = Vec::new();
                if let Some(f) = cli.file.take() {
                    rest.push(f.to_string_lossy().into_owned());
                }
                rest.extend(std::mem::take(&mut cli.rest_args));
                Cmd::Eval { code, rest_args: rest }
            } else if let Some(file) = cli.file.clone() {
                Cmd::Run {
                    file,
                    rest_args: std::mem::take(&mut cli.rest_args),
                }
            } else {
                anyhow::bail!(
                    "usage: burn <command> | burn <file.js> [args…] | burn -e '<code>' [args…]\n\
                     run `burn --help` for subcommands"
                );
            }
        }
    };

    // Show the open-capabilities banner once per user for script-like
    // subcommands. `version` / `check` are metadata-only and don't
    // execute user code, so they don't warrant the warning.
    if matches!(
        cmd,
        Cmd::Run { .. } | Cmd::Eval { .. } | Cmd::Thrust { .. } | Cmd::Bench { .. } | Cmd::Repl
    ) {
        banner::maybe_show(&cli);
    }

    match cmd {
        Cmd::Run { file, rest_args } => run::run_file(&cli, &file, &rest_args),
        Cmd::Eval { code, rest_args } => run::run_source(&cli, &code, &rest_args),
        Cmd::Thrust { file } => thrust::thrust_from_stdin(&cli, &file),
        Cmd::Check { file } => check::check_file(&cli, &file),
        Cmd::Bench {
            file,
            iters,
            workers,
        } => bench::bench(&cli, &file, iters, workers),
        Cmd::Repl => repl::repl(&cli),
        Cmd::Version => version::print_version(),
    }
}

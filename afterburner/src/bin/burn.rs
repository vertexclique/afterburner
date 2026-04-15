//! `burn` — the Afterburner command-line runtime.
//!
//! This binary is a thin shell over the `afterburner` crate's public
//! API. All execution logic lives in the library; this file is about
//! CLI plumbing (argument parsing, stdin/stdout wiring, exit codes).
//!
//! Phases:
//!
//! * **U3** (this file today): `run`, `eval`, scaffolding for the
//!   dispatcher and the `--mode`/`--fuel`/`--memory`/`--timeout` flags.
//! * **U4**: `thrust`, `check`, plumbed through `Afterburner::run`.
//! * **U5**: Deno-style `--allow-net`, `--allow-fs`, `--allow-env`, `-A`.
//! * **U6**: `repl`, `bench`, `version`.
//!
//! Invoked via `cargo install afterburner --features bin`.

use afterburner::{Afterburner, AfterburnerError, FuelGauge, Manifold};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "burn",
    version,
    about = "Sandboxed JavaScript runtime",
    long_about = "Execute JavaScript in the Afterburner sandbox. \
                  Reads .js files, evaluates inline code, pipes UDFs through stdin."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,

    /// Positional fallback — when no subcommand is given but a path is,
    /// this is treated as `burn run <path>`. Matches the user expectation
    /// of `burn ./script.js` working with zero ceremony.
    #[arg(value_name = "FILE")]
    file: Option<PathBuf>,

    /// Eval inline source (when not using a subcommand).
    #[arg(short = 'e', long = "eval", value_name = "CODE", global = true)]
    eval_code: Option<String>,

    /// Engine mode (`adaptive`, `wasm`, `native`). Default: adaptive.
    #[arg(long, value_name = "MODE", global = true)]
    mode: Option<String>,

    /// Per-call fuel budget (backend-specific instruction count).
    #[arg(long, value_name = "N", global = true)]
    fuel: Option<u64>,

    /// Per-call linear memory cap (bytes).
    #[arg(long, value_name = "BYTES", global = true)]
    memory: Option<usize>,

    /// Per-call wall-clock cap (milliseconds).
    #[arg(long = "timeout", value_name = "MS", global = true)]
    timeout_ms: Option<u64>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Execute a JavaScript file.
    Run {
        #[arg(value_name = "FILE")]
        file: PathBuf,
    },
    /// Evaluate an inline JavaScript snippet.
    Eval {
        #[arg(value_name = "CODE")]
        code: String,
    },
    /// UDF mode — reads JSON from stdin, feeds as `data` to the script,
    /// writes the script's return value as JSON to stdout.
    Thrust {
        #[arg(value_name = "FILE")]
        file: PathBuf,
    },
    /// Parse + compile a script without executing it. Exit code 0 on
    /// success, 1 on syntax or semantic errors.
    Check {
        #[arg(value_name = "FILE")]
        file: PathBuf,
    },
    /// Print the build version + enabled features.
    Version,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match dispatch(cli) {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("burn: {e:#}");
            std::process::exit(1);
        }
    }
}

fn dispatch(mut cli: Cli) -> Result<()> {
    // Resolve to a concrete command. Positional `file` without subcommand
    // → implicit `run`. `-e CODE` without subcommand → implicit `eval`.
    let cmd = match cli.command.take() {
        Some(c) => c,
        None => {
            if let Some(code) = cli.eval_code.clone() {
                Cmd::Eval { code }
            } else if let Some(file) = cli.file.clone() {
                Cmd::Run { file }
            } else {
                anyhow::bail!(
                    "usage: burn <command> | burn <file.js> | burn -e '<code>'\n\
                     run `burn --help` for subcommands"
                );
            }
        }
    };

    match cmd {
        Cmd::Run { file } => run_file(&cli, &file),
        Cmd::Eval { code } => run_source(&cli, &code),
        Cmd::Thrust { file } => thrust_from_stdin(&cli, &file),
        Cmd::Check { file } => check_file(&cli, &file),
        Cmd::Version => print_version(),
    }
}

fn run_file(cli: &Cli, path: &PathBuf) -> Result<()> {
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    run_source(cli, &source)
}

fn run_source(cli: &Cli, source: &str) -> Result<()> {
    let ab = build_afterburner(cli)?;
    let id = ab.register(source).context("compile")?;
    // `burn run` / `burn eval` — legacy/UDF envelope: caller scripts
    // shape as `module.exports = (data) => ...`. Input is JSON `null`.
    // The dedicated `burn thrust` subcommand feeds input from stdin.
    let out = ab
        .run(&id, &Value::Null)
        .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;
    if !out.is_null() {
        println!("{}", serde_json::to_string(&out).unwrap_or_default());
    }
    Ok(())
}

fn thrust_from_stdin(cli: &Cli, path: &PathBuf) -> Result<()> {
    use std::io::Read;
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    let mut stdin_bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut stdin_bytes)
        .context("reading stdin")?;
    let input: Value = if stdin_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&stdin_bytes).context("parse stdin as JSON")?
    };

    let ab = build_afterburner(cli)?;
    let id = ab.register(&source).context("compile")?;
    let out = ab
        .run(&id, &input)
        .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;
    // In UDF mode we always print the return value — null included —
    // so downstream pipes see a well-formed JSON document every time.
    println!("{}", serde_json::to_string(&out).unwrap_or_default());
    Ok(())
}

fn check_file(cli: &Cli, path: &PathBuf) -> Result<()> {
    // "Compile-only": we `register` the source (which runs through the
    // combustor's compile step), then stop. Any syntax / unsupported-
    // construct error surfaces as `AfterburnerError::CompileFailed`.
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;
    let ab = build_afterburner(cli)?;
    ab.register(&source)
        .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;
    // Quiet-on-success for CI friendliness.
    Ok(())
}

fn build_afterburner(cli: &Cli) -> Result<Afterburner> {
    let mut b = Afterburner::builder();
    if let Some(mode_str) = cli.mode.as_deref() {
        b = b.mode(parse_mode(mode_str)?);
    }
    if let Some(fuel) = cli.fuel {
        b = b.fuel(fuel);
    }
    if let Some(mem) = cli.memory {
        b = b.memory_bytes(mem);
    }
    if let Some(ms) = cli.timeout_ms {
        b = b.timeout_ms(ms);
    }
    // Default manifold is sealed. U5 will layer --allow-net / --allow-fs
    // / --allow-env on top of this default.
    b = b.manifold(Manifold::sealed());
    // Silence unused: the builder takes Manifold by value so the assign
    // above is sufficient; this line keeps FuelGauge import live for
    // the U4 thrust subcommand that will build one explicitly.
    let _ = FuelGauge::unlimited();
    b.build().context("build afterburner")
}

fn parse_mode(s: &str) -> Result<afterburner::Mode> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "native" => afterburner::Mode::Native,
        #[cfg(feature = "wasm")]
        "wasm" => afterburner::Mode::Wasm,
        #[cfg(feature = "adaptive")]
        "adaptive" => afterburner::Mode::Adaptive,
        other => anyhow::bail!("unknown --mode '{other}'; expected one of: native, wasm, adaptive"),
    })
}

fn print_version() -> Result<()> {
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

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

use afterburner::{
    Afterburner, AfterburnerError, EnvAccess, FsAccess, FuelGauge, Manifold, NetAccess,
};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
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

    /// Grant outbound HTTP access. Values: `*` = any host;
    /// `api.example.com,*.trusted.io` = comma-separated allow-list with
    /// optional wildcard subdomains. Without this flag all HTTP is
    /// denied (`PermissionDenied`).
    #[arg(long = "allow-net", value_name = "HOSTS", global = true)]
    allow_net: Option<String>,

    /// Grant read+write filesystem access. Values: `*` = entire FS;
    /// `/var/data,/tmp/workspace` = comma-separated root allow-list.
    #[arg(long = "allow-fs", value_name = "PATHS", global = true)]
    allow_fs: Option<String>,

    /// Grant env-var read access. Values: `*` = all env; `HOME,PATH` =
    /// comma-separated name allow-list.
    #[arg(long = "allow-env", value_name = "VARS", global = true)]
    allow_env: Option<String>,

    /// Shortcut: grant all capabilities (net, fs, env). Use with care.
    #[arg(long = "allow-all", short = 'A', global = true)]
    allow_all: bool,
}

#[derive(Subcommand, Debug, Clone)]
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
    /// Measure throughput + p50/p99 latency by running the script N
    /// times. Reports to stderr; script output is suppressed.
    Bench {
        #[arg(value_name = "FILE")]
        file: PathBuf,
        /// Total iterations to submit.
        #[arg(long, default_value_t = 10_000)]
        iters: usize,
        /// Workers for the threaded path. `1` uses the single-threaded
        /// BurnCache. Higher values use ThrustEngine.
        #[arg(long, default_value_t = 1)]
        workers: usize,
    },
    /// Interactive REPL. Each line becomes a fresh script (no state
    /// shared across lines — matches the fresh-per-call invariant).
    Repl,
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
        Cmd::Bench {
            file,
            iters,
            workers,
        } => bench(&cli, &file, iters, workers),
        Cmd::Repl => repl(&cli),
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
    b = b.manifold(build_manifold(cli));
    // Reference FuelGauge here so future changes that rebuild the
    // gauge from CLI flags at this site don't need a fresh import.
    let _ = FuelGauge::unlimited();
    b.build().context("build afterburner")
}

/// Assemble a [`Manifold`] from the Deno-style allow flags.
///
/// * `--allow-all` / `-A` → `Manifold::open()` (every flap wide open).
/// * Each of `--allow-net`, `--allow-fs`, `--allow-env` grants exactly
///   the capability it names. Absent flags stay at the `sealed()`
///   default — `PermissionDenied` on use.
/// * `*` in the value = unrestricted for that capability. Otherwise
///   the value is a comma-separated allow-list (hosts / paths / var
///   names).
fn build_manifold(cli: &Cli) -> Manifold {
    if cli.allow_all {
        return Manifold::open();
    }
    let mut m = Manifold::sealed();

    if let Some(s) = cli.allow_net.as_deref() {
        let hosts = parse_allow_list(s);
        // Wildcard or empty list → unrestricted. We keep `OutboundFull`
        // rather than `OutboundHttp` so scripts that talk raw TCP in a
        // future host expansion don't need a migration.
        m.net = if hosts.is_empty() || has_wildcard(&hosts) {
            NetAccess::OutboundFull(None)
        } else {
            NetAccess::OutboundFull(Some(hosts))
        };
    }

    if let Some(s) = cli.allow_fs.as_deref() {
        let paths = parse_allow_list(s);
        // `*` or empty = full FS access. We model that as a ReadWrite
        // rooted at `/`; host fs code canonicalizes and checks path
        // containment, which trivially passes against root.
        let roots: Vec<PathBuf> = if paths.is_empty() || has_wildcard(&paths) {
            vec![PathBuf::from("/")]
        } else {
            paths.into_iter().map(PathBuf::from).collect()
        };
        m.fs = FsAccess::ReadWrite(roots);
    }

    if let Some(s) = cli.allow_env.as_deref() {
        let vars = parse_allow_list(s);
        m.env = if vars.is_empty() || has_wildcard(&vars) {
            EnvAccess::Full
        } else {
            EnvAccess::AllowList(vars)
        };
    }

    m
}

/// Split `"a,b, c"` into `["a", "b", "c"]`, trimming whitespace and
/// dropping empty segments. `""` returns `[]`.
fn parse_allow_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

fn has_wildcard(list: &[String]) -> bool {
    list.iter().any(|s| s == "*")
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

/// Perf harness. Register once; submit `iters` thrusts via the
/// configured engine; measure total wall-clock + per-iteration
/// latency; report throughput + p50/p99 on stderr.
///
/// For `workers > 1`: we build the threaded engine and fan out `N`
/// submitter threads (matching `workers`) via `std::thread::scope` so
/// the pool is actually exercised in parallel. Per-thread iterations
/// are distributed evenly. Without this, a single-threaded submit
/// loop would serialize the caller side and leave the worker pool
/// mostly idle.
#[allow(clippy::needless_return)] // feature-gated branches need explicit returns
fn bench(cli: &Cli, path: &PathBuf, iters: usize, workers: usize) -> Result<()> {
    use std::time::Instant;
    let source = fs::read_to_string(path).with_context(|| format!("reading {path:?}"))?;

    if workers <= 1 {
        let ab = build_afterburner(cli)?;
        let id = ab.register(&source).context("compile")?;
        let mut latencies = Vec::with_capacity(iters);
        let t0 = Instant::now();
        for _ in 0..iters {
            let i0 = Instant::now();
            ab.run(&id, &Value::Null)
                .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;
            latencies.push(i0.elapsed().as_micros());
        }
        let total = t0.elapsed();
        report_bench(total, &mut latencies, iters, workers);
        return Ok(());
    }

    #[cfg(feature = "thrust")]
    {
        let ab = build_threaded_for_bench(cli, workers)?;
        let id = ab.register(&source).context("compile")?;
        let per_thread = iters / workers;
        let remainder = iters % workers;
        let ab_ref = &ab;
        let id_ref = &id;

        let t0 = Instant::now();
        let all_latencies: Vec<u128> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(workers);
            for w in 0..workers {
                let my_iters = per_thread + if w < remainder { 1 } else { 0 };
                handles.push(s.spawn(move || -> Result<Vec<u128>> {
                    let mut lat = Vec::with_capacity(my_iters);
                    for _ in 0..my_iters {
                        let i0 = Instant::now();
                        ab_ref
                            .run(id_ref, &Value::Null)
                            .map_err(|e: AfterburnerError| anyhow::anyhow!("{e}"))?;
                        lat.push(i0.elapsed().as_micros());
                    }
                    Ok(lat)
                }));
            }
            let mut all: Vec<u128> = Vec::with_capacity(iters);
            for h in handles {
                let part = h
                    .join()
                    .map_err(|_| anyhow::anyhow!("bench thread panic"))??;
                all.extend(part);
            }
            Ok::<Vec<u128>, anyhow::Error>(all)
        })?;
        let total = t0.elapsed();
        let mut lat = all_latencies;
        report_bench(total, &mut lat, iters, workers);
        return Ok(());
    }

    #[cfg(not(feature = "thrust"))]
    anyhow::bail!(
        "bench with --workers > 1 requires the `thrust` feature; rebuild with `--features thrust`"
    );
}

#[cfg(feature = "thrust")]
fn build_threaded_for_bench(cli: &Cli, workers: usize) -> Result<Afterburner> {
    let mut b = Afterburner::builder();
    if let Some(fuel) = cli.fuel {
        b = b.fuel(fuel);
    }
    if let Some(mem) = cli.memory {
        b = b.memory_bytes(mem);
    }
    if let Some(ms) = cli.timeout_ms {
        b = b.timeout_ms(ms);
    }
    b = b.manifold(build_manifold(cli));
    b.threaded(workers).build().context("build threaded")
}

fn report_bench(total: std::time::Duration, latencies: &mut [u128], iters: usize, workers: usize) {
    latencies.sort_unstable();
    let throughput = iters as f64 / total.as_secs_f64();
    let p50 = latencies[latencies.len() / 2];
    let p99_idx = ((latencies.len() as f64) * 0.99) as usize;
    let p99 = latencies[p99_idx.min(latencies.len() - 1)];
    eprintln!(
        "burn bench: iters={iters} workers={workers} total={:.2}ms throughput={:.0}/sec \
         p50={p50}us p99={p99}us",
        total.as_secs_f64() * 1000.0,
        throughput
    );
}

/// Interactive REPL. Submits each submitted line as a fresh script.
/// Meta-commands:
///
/// * `:fuel N` — set the per-call fuel cap.
/// * `:mode native|wasm|adaptive` — rebuild the engine in a given mode.
/// * `:allow net=*`, `:allow fs=/tmp`, `:allow env=HOME` — grant
///   capabilities on the live engine (rebuilds the manifold).
/// * `:help` — list commands. `:exit` / `:quit` — exit.
///
/// Scripts run in UDF shape (`module.exports = () => ...` or plain
/// expressions — the latter are wrapped). No state shared across
/// lines; matches the fresh-per-call invariant.
fn repl(cli: &Cli) -> Result<()> {
    use rustyline::DefaultEditor;
    use rustyline::error::ReadlineError;

    let mut rl = DefaultEditor::new().context("rustyline init")?;
    let mut live_cli = cli.clone();
    let mut ab = build_afterburner(&live_cli)?;

    eprintln!("burn repl — type :help for commands, :exit to quit.");
    loop {
        match rl.readline("burn> ") {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = rl.add_history_entry(trimmed);

                if let Some(rest) = trimmed.strip_prefix(':') {
                    match dispatch_meta(rest, &mut live_cli, &mut ab) {
                        Ok(ReplAction::Continue) => continue,
                        Ok(ReplAction::Exit) => break,
                        Err(e) => {
                            eprintln!("  error: {e}");
                            continue;
                        }
                    }
                }

                // Evaluate as script. We wrap so a naked expression
                // gets its value back (not via module.exports).
                let wrapped = wrap_repl_line(trimmed);
                match ab
                    .register(&wrapped)
                    .and_then(|id| ab.run(&id, &Value::Null))
                {
                    Ok(v) => {
                        if !v.is_null() {
                            println!("{}", serde_json::to_string(&v).unwrap_or_default());
                        }
                    }
                    Err(e) => eprintln!("  error: {e}"),
                }
            }
            Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => break,
            Err(e) => {
                eprintln!("  readline error: {e}");
                break;
            }
        }
    }
    Ok(())
}

enum ReplAction {
    Continue,
    Exit,
}

fn dispatch_meta(rest: &str, cli: &mut Cli, ab: &mut Afterburner) -> Result<ReplAction> {
    let (cmd, arg) = match rest.split_once(char::is_whitespace) {
        Some((c, a)) => (c, a.trim()),
        None => (rest, ""),
    };
    match cmd {
        "help" | "?" => {
            eprintln!("  :fuel N                   set per-call fuel");
            eprintln!("  :mode native|wasm|adaptive");
            eprintln!("  :allow net=*|host,list");
            eprintln!("  :allow fs=*|/path,list");
            eprintln!("  :allow env=*|VAR,list");
            eprintln!("  :exit | :quit");
        }
        "fuel" => {
            let n: u64 = arg.parse().context("parse fuel")?;
            cli.fuel = Some(n);
            *ab = build_afterburner(cli)?;
            eprintln!("  fuel = {n}");
        }
        "mode" => {
            cli.mode = Some(arg.to_string());
            *ab = build_afterburner(cli)?;
            eprintln!("  mode = {arg}");
        }
        "allow" => {
            let (k, v) = arg.split_once('=').context(":allow expects key=value")?;
            match k.trim() {
                "net" => cli.allow_net = Some(v.to_string()),
                "fs" => cli.allow_fs = Some(v.to_string()),
                "env" => cli.allow_env = Some(v.to_string()),
                "all" => cli.allow_all = true,
                other => anyhow::bail!("unknown capability '{other}' (expected: net|fs|env|all)"),
            }
            *ab = build_afterburner(cli)?;
            eprintln!("  {k} = {v}");
        }
        "exit" | "quit" => return Ok(ReplAction::Exit),
        other => anyhow::bail!("unknown command :{other} — try :help"),
    }
    Ok(ReplAction::Continue)
}

fn wrap_repl_line(line: &str) -> String {
    // If the user wrote a full module.exports shape, pass through.
    if line.contains("module.exports") {
        return line.to_string();
    }
    // Otherwise wrap as a nullary-arg function that returns the
    // expression's value.
    format!("module.exports = () => ({line});\n")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cli_with(
        allow_all: bool,
        allow_net: Option<&str>,
        allow_fs: Option<&str>,
        allow_env: Option<&str>,
    ) -> Cli {
        Cli {
            command: None,
            file: None,
            eval_code: None,
            mode: None,
            fuel: None,
            memory: None,
            timeout_ms: None,
            allow_net: allow_net.map(String::from),
            allow_fs: allow_fs.map(String::from),
            allow_env: allow_env.map(String::from),
            allow_all,
        }
    }

    #[test]
    fn parse_allow_list_trims_and_drops_empty() {
        assert_eq!(
            parse_allow_list("a, b ,,c"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert!(parse_allow_list("").is_empty());
        assert!(parse_allow_list("  ,  ,").is_empty());
    }

    #[test]
    fn default_manifold_is_sealed() {
        let m = build_manifold(&cli_with(false, None, None, None));
        assert!(matches!(m.fs, FsAccess::None));
        assert!(matches!(m.net, NetAccess::None));
        assert!(matches!(m.env, EnvAccess::None));
    }

    #[test]
    fn allow_all_opens_every_flap() {
        let m = build_manifold(&cli_with(true, None, None, None));
        assert!(matches!(m.fs, FsAccess::ReadWrite(_)));
        assert!(matches!(m.net, NetAccess::OutboundFull(_)));
        assert!(matches!(m.env, EnvAccess::Full));
    }

    #[test]
    fn allow_net_wildcard_is_unrestricted() {
        let m = build_manifold(&cli_with(false, Some("*"), None, None));
        match m.net {
            NetAccess::OutboundFull(None) => {}
            other => panic!("expected OutboundFull(None), got {other:?}"),
        }
    }

    #[test]
    fn allow_net_host_list_is_restricted() {
        let m = build_manifold(&cli_with(false, Some("api.foo.com,*.bar.io"), None, None));
        match m.net {
            NetAccess::OutboundFull(Some(hosts)) => {
                assert_eq!(
                    hosts,
                    vec!["api.foo.com".to_string(), "*.bar.io".to_string()]
                );
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn allow_fs_paths_become_roots() {
        let m = build_manifold(&cli_with(false, None, Some("/tmp,/var/lib"), None));
        match m.fs {
            FsAccess::ReadWrite(roots) => {
                assert_eq!(
                    roots,
                    vec![PathBuf::from("/tmp"), PathBuf::from("/var/lib")]
                );
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn allow_env_without_wildcard_is_allow_list() {
        let m = build_manifold(&cli_with(false, None, None, Some("HOME,PATH")));
        match m.env {
            EnvAccess::AllowList(keys) => {
                assert_eq!(keys, vec!["HOME".to_string(), "PATH".to_string()]);
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn allow_env_wildcard_is_full() {
        let m = build_manifold(&cli_with(false, None, None, Some("*")));
        assert!(matches!(m.env, EnvAccess::Full));
    }
}

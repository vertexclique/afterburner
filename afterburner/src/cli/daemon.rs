//! `burn <file>` / `burn -e <code>` daemon driver.
//!
//! Every CLI script runs through daemon mode (Q2-A locked decision):
//! `daemon-init` evaluates the user source, and then:
//!
//! * **No listeners registered** → the script is a plain one-shot.
//!   Drain captured stdout / stderr to the real process streams and
//!   exit 0 (or non-zero if daemon-init trapped).
//! * **At least one listener** (via `http.createServer().listen(...)`
//!   → `__host_http_listen`) → we transition into the dispatcher
//!   loop, routing axum-dispatched events to the long-lived Store
//!   until SIGINT. On shutdown we drain any remaining output and
//!   exit cleanly.
//!
//! The library API (`Afterburner::run_script`) does **not** use this
//! path — Q2-A locks that to strict one-shot semantics. Only the CLI
//! can auto-transition into daemon mode.

use crate::wasm::{DaemonHttp, DaemonRuntime, WasmCombustor, WasmConfig};
use crate::{EnvAccess, ScriptInvocation};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use super::args::Cli;
use super::manifold::build_manifold;

/// Run `source` via daemon-init; enter the event loop if the script
/// registered at least one listener. Matches script-mode semantics
/// for plain scripts — captured stdout/stderr flushed, exit code
/// from `process.exit(N)` (once B3 lands) or `0` on clean completion.
pub fn execute(
    cli: &Cli,
    source: &str,
    script_label: &str,
    user_args: &[String],
) -> Result<()> {
    // `burn --mode native` can't host daemon mode (native combustor
    // has no axum hooks). Route such scripts through the library's
    // script mode instead — keeps the `--mode native foo.js` path
    // useful for trusted one-shot scripts.
    if let Some(mode) = cli.mode.as_deref()
        && mode.eq_ignore_ascii_case("native")
    {
        return super::script::execute(
            &super::build::build_afterburner(cli)?,
            source,
            script_label,
            user_args,
            cli,
        );
    }

    let invocation = build_invocation(cli, script_label, user_args);
    let manifold = build_manifold(cli);

    // Start tokio runtime for the axum listeners + signal handler.
    // Multi-thread so axum's spawn happens off the main thread.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("tokio runtime")?;
    let daemon_http = DaemonHttp::with_runtime(rt.handle().clone(), 1024);

    // The WasmCombustor lives at the CLI level (bypasses the
    // Afterburner facade) because daemon mode needs direct access to
    // `spawn_daemon_with_invocation`. For non-daemon codepaths the
    // facade abstraction still applies.
    let combustor = WasmCombustor::new(WasmConfig {
        state_store: None,
        host_context: None,
    })
    .context("wasm combustor")?;

    // Two-phase construction so we can retrieve partial stdout even
    // when daemon-init throws (e.g. user source has a runtime error
    // after some console.log output).
    let mut daemon = DaemonRuntime::instantiate(
        combustor.engine(),
        combustor.instance_pre(),
        manifold,
        Some(combustor.state_store().clone()),
        None,
        Arc::clone(&daemon_http),
    )
    .context("daemon instantiate")?;

    if let Err(e) = daemon.run_init(source, &invocation) {
        flush_streams(&mut daemon)?;
        let _ = std::io::stderr().write_all(format!("burn: {e}\n").as_bytes());
        std::process::exit(1);
    }

    // Flush the daemon-init output (startup `console.log`s) up front
    // so the user sees "listening on ..." before any events arrive.
    flush_streams(&mut daemon)?;

    if !daemon.has_listeners() {
        // Plain script — exit cleanly. `rt` drops; axum had no
        // listeners to drop.
        rt.shutdown_timeout(Duration::from_secs(1));
        return Ok(());
    }

    // Daemon mode — install SIGINT handler, enter event loop.
    let shutdown = Arc::new(AtomicBool::new(false));
    let inflight = Arc::new(AtomicUsize::new(0));
    {
        let shutdown = Arc::clone(&shutdown);
        rt.spawn(async move {
            // `ctrl_c().await` resolves on SIGINT (SIGTERM on Unix
            // needs a separate handler — we add it below on Unix).
            let _ = tokio::signal::ctrl_c().await;
            shutdown.store(true, Ordering::Release);
        });
    }
    #[cfg(unix)]
    {
        let shutdown = Arc::clone(&shutdown);
        rt.spawn(async move {
            if let Ok(mut sigterm) = tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::terminate(),
            ) {
                let _ = sigterm.recv().await;
                shutdown.store(true, Ordering::Release);
            }
        });
    }

    run_event_loop(&mut daemon, &daemon_http, &shutdown, &inflight)?;

    // Shutdown path — drain tokio tasks so in-flight responses can
    // finish (best-effort; bounded by the timeout).
    rt.shutdown_timeout(Duration::from_secs(2));
    flush_streams(&mut daemon)?;
    Ok(())
}

/// Same shape as [`super::script::build_invocation`]. Duplicated here
/// to avoid tangling the script / daemon modules.
fn build_invocation(cli: &Cli, script_label: &str, user_args: &[String]) -> ScriptInvocation {
    let mut argv = Vec::with_capacity(2 + user_args.len());
    argv.push("burn".to_string());
    argv.push(script_label.to_string());
    argv.extend(user_args.iter().cloned());
    ScriptInvocation {
        argv,
        env: collect_env(cli),
    }
}

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

fn run_event_loop(
    daemon: &mut DaemonRuntime,
    http: &Arc<DaemonHttp>,
    shutdown: &Arc<AtomicBool>,
    inflight: &Arc<AtomicUsize>,
) -> Result<()> {
    while !shutdown.load(Ordering::Acquire) {
        match http.try_recv_event() {
            Some(event) => {
                inflight.fetch_add(1, Ordering::Relaxed);
                let envelope = event_to_envelope(&event);
                let res = daemon.dispatch_event(envelope);
                inflight.fetch_sub(1, Ordering::Relaxed);
                flush_streams(daemon)?;
                if let Err(e) = res {
                    // One bad request shouldn't kill the server.
                    // Print the error on stderr and keep going —
                    // matches Node's behaviour for uncaught
                    // per-request exceptions.
                    let _ = std::io::stderr().write_all(
                        format!("burn: dispatch error: {e}\n").as_bytes(),
                    );
                }
            }
            None => {
                // No event available — sleep briefly so we don't
                // peg a core. A signal-based wake would be nicer;
                // B2b (multiplexed listeners) is a good place to
                // revisit this.
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    Ok(())
}

fn event_to_envelope(
    event: &afterburner_wasi::daemon_http::DaemonEvent,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "http-request",
        "server_id": event.server_id,
        "req_id": event.req_id,
        "req": {
            "method": event.method,
            "url": event.url,
            "headers": event.headers.iter().cloned().collect::<BTreeMap<_, _>>(),
            "body": String::from_utf8_lossy(&event.body).into_owned(),
        }
    })
}

/// Write anything the daemon captured since the last call to
/// [`flush_streams`] through the real host stdout / stderr streams,
/// and clear the capture so the next call only sees the delta.
///
/// `DaemonRuntime::drain_stdout` returns a cumulative snapshot today
/// (the `MemoryOutputPipe` has no clear-on-read facility). We stash
/// a per-daemon high-water mark so subsequent calls don't re-emit.
fn flush_streams(daemon: &mut DaemonRuntime) -> Result<()> {
    let stdout = daemon.drain_stdout();
    let stderr = daemon.drain_stderr();

    // Thread-local high-water marks — scoped to a single `execute`
    // call since the CLI is single-threaded.
    thread_local! {
        static HW_STDOUT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        static HW_STDERR: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    let new_stdout_at = HW_STDOUT.with(|c| c.get());
    let new_stderr_at = HW_STDERR.with(|c| c.get());
    if stdout.len() > new_stdout_at {
        std::io::stdout()
            .write_all(&stdout[new_stdout_at..])
            .context("write stdout")?;
        HW_STDOUT.with(|c| c.set(stdout.len()));
    }
    if stderr.len() > new_stderr_at {
        std::io::stderr()
            .write_all(&stderr[new_stderr_at..])
            .context("write stderr")?;
        HW_STDERR.with(|c| c.set(stderr.len()));
    }
    Ok(())
}

/// Resolve a user-supplied script path to an absolute path suitable
/// for `process.argv[1]`. Falls back to the raw string on failure —
/// matches `super::script::script_label`.
pub fn script_label(path: &Path) -> String {
    path.canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}


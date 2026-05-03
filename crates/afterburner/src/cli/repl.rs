//! `burn repl` — interactive REPL.
//!
//! Meta-commands:
//!
//! * `:fuel N` — set the per-call fuel cap.
//! * `:mode native|wasm|adaptive` — rebuild the engine in a given mode.
//! * `:allow net=*`, `:allow fs=/tmp`, `:allow env=HOME` — grant
//!   capabilities on the live engine (rebuilds the manifold).
//! * `:help` — list commands. `:exit` / `:quit` — exit.
//!
//! Scripts run in UDF shape (`module.exports = () => ...` or plain
//! expressions — the latter are wrapped). No state shared across
//! lines; matches the fresh-per-call invariant.

use crate::Afterburner;
use anyhow::{Context, Result};
use serde_json::Value;

use super::args::Cli;
use super::build::build_afterburner;

pub fn repl(cli: &Cli) -> Result<()> {
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

/// Wrap a raw REPL line into a module-exports shape so naked
/// expressions yield their value back to the user.
pub(super) fn wrap_repl_line(line: &str) -> String {
    if line.contains("module.exports") {
        return line.to_string();
    }
    format!("module.exports = () => ({line});\n")
}

//! B4 phase gate: `burn node foo.js` pass-through.
//!
//! Verification target #2 from IMPL_PLAN_BURN_RUNTIME.md §8:
//! `burn node -e 'console.log(1 + 2)'` prints `3`.

#![cfg(feature = "bin")]

use std::fs;
use std::process::{Command, Stdio};

const BURN: &str = env!("CARGO_BIN_EXE_burn");

#[test]
fn burn_node_eval_prints_result() {
    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .args(["node", "-e", "console.log(1 + 2)"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");
    assert!(
        out.status.success(),
        "exit {}: stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "3");
}

#[test]
fn burn_node_runs_script_file() {
    let dir = std::env::temp_dir().join("burn_b4_script");
    fs::create_dir_all(&dir).unwrap();
    let script = dir.join("hello.js");
    fs::write(&script, "console.log('hello from node passthrough');").unwrap();

    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .arg("node")
        .arg(&script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");

    let _ = fs::remove_dir_all(&dir);
    assert!(
        out.status.success(),
        "exit {}: stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("hello from node passthrough"));
}

#[test]
fn burn_node_passes_trailing_args() {
    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .args(["node", "-e", "console.log(process.argv.slice(2).join(','))"])
        .args(["a", "b", "c"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "a,b,c");
}

#[test]
fn burn_node_no_args_is_error() {
    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("missing script") || stderr.contains("usage"),
        "stderr should show helpful message: {stderr}"
    );
}

#[test]
fn existing_file_named_node_wins_over_passthrough() {
    // Q5-A: if there's a file called "node" in cwd, run it.
    let dir = std::env::temp_dir().join("burn_b4_existing");
    fs::create_dir_all(&dir).unwrap();
    let node_file = dir.join("node");
    fs::write(&node_file, "console.log('i am a file called node');").unwrap();

    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .current_dir(&dir)
        .arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");

    let _ = fs::remove_dir_all(&dir);
    assert!(
        out.status.success(),
        "exit {}: stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("i am a file called node"));
}

#[test]
fn burn_npm_shows_not_yet_message() {
    let out = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .args(["npm", "install", "express"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("PATH shim") || stderr.contains("not yet"),
        "should explain npm pass-through needs B5: {stderr}"
    );
}

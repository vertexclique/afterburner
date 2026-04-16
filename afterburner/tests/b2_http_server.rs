//! B2 phase gate: `burn server.js` serves HTTP end-to-end.
//!
//! This is the headline example from `IMPL_PLAN_BURN_RUNTIME.md §1`:
//!
//! ```js
//! const http = require("node:http");
//! http.createServer((_req, res) => {
//!     res.end("hello from burn\n");
//! }).listen(3000, () => console.log("listening on http://localhost:3000"));
//! ```
//!
//! The test spawns `burn` as a subprocess, waits for the listener to
//! bind, fires a real HTTP request over a raw TCP socket, asserts the
//! response, and then kills the subprocess cleanly.

#![cfg(feature = "bin")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

const BURN: &str = env!("CARGO_BIN_EXE_burn");

static PORT_CTR: AtomicU16 = AtomicU16::new(0);

fn pick_port() -> u16 {
    let offset = PORT_CTR.fetch_add(1, Ordering::Relaxed);
    let pid_tail = (std::process::id() & 0xFF) as u16;
    49700 + ((pid_tail * 11 + offset * 19) % 5000)
}

fn wait_for_listener(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .ok();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("write");
    let mut resp = String::new();
    stream.read_to_string(&mut resp).expect("read");
    resp
}

/// Spawn `burn -e <source>` with stdout/stderr piped. Returns the
/// child handle for later cleanup.
fn spawn_burn_inline(source: &str) -> Child {
    Command::new(BURN)
        .env("BURN_QUIET", "1")
        .arg("-e")
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn burn")
}

#[test]
fn burn_serves_hello_from_burn() {
    let port = pick_port();
    let source = format!(
        r#"
        const http = require("node:http");
        http.createServer((_req, res) => {{
            res.end("hello from burn\n");
        }}).listen({port}, () => console.log("listening"));
        "#
    );
    let mut child = spawn_burn_inline(&source);
    assert!(
        wait_for_listener(port, Duration::from_secs(15)),
        "burn listener didn't come up on :{port}"
    );

    let resp = http_get(port, "/");
    assert!(resp.starts_with("HTTP/1.1 200"), "resp:\n{resp}");
    assert!(resp.contains("hello from burn"), "resp:\n{resp}");

    // Cleanup.
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn burn_server_echoes_method_and_path() {
    let port = pick_port();
    let source = format!(
        r#"
        const http = require("http");
        http.createServer((req, res) => {{
            res.setHeader("x-method", req.method);
            res.setHeader("x-url", req.url);
            res.writeHead(201);
            res.end("echo\n");
        }}).listen({port});
        "#
    );
    let mut child = spawn_burn_inline(&source);
    assert!(wait_for_listener(port, Duration::from_secs(15)));

    let resp = http_get(port, "/test?q=1");
    assert!(resp.starts_with("HTTP/1.1 201"), "resp:\n{resp}");
    assert!(resp.contains("x-method: GET"), "resp:\n{resp}");
    assert!(resp.contains("x-url: /test?q=1"), "resp:\n{resp}");
    assert!(resp.contains("echo"), "resp:\n{resp}");

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn burn_plain_script_exits_cleanly() {
    // A script with no `.listen()` should exit 0 quickly — daemon
    // mode detects no listeners and exits.
    let child = Command::new(BURN)
        .env("BURN_QUIET", "1")
        .arg("-e")
        .arg(r#"console.log("no listen")"#)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run burn");
    assert!(
        child.status.success(),
        "exit {}, stderr: {}",
        child.status,
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(String::from_utf8_lossy(&child.stdout).contains("no listen"));
}

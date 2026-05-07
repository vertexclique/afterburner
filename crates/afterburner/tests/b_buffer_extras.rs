//! `Buffer.copyBytesFrom` (Node 19+) / `Buffer.allocUnsafeSlow` /
//! `Buffer.poolSize`.

#![cfg(feature = "bin")]

use std::process::{Command, Stdio};

const BURN: &str = env!("CARGO_BIN_EXE_burn");

fn run_inline(source: &str) -> std::process::Output {
    Command::new(BURN)
        .env("BURN_QUIET", "1")
        .arg("-A")
        .arg("-e")
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn burn")
}

fn assert_marker(out: &std::process::Output, marker: &str) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "burn failed. stdout={stdout}\nstderr={stderr}"
    );
    assert!(
        stdout.contains(marker),
        "missing marker `{marker}`. stdout={stdout}\nstderr={stderr}"
    );
}

#[test]
fn buffer_pool_size_is_node_default() {
    let out = run_inline(
        r#"
        if (Buffer.poolSize === 8192) console.log('POOL-OK');
        else console.log('FAIL', Buffer.poolSize);
        "#,
    );
    assert_marker(&out, "POOL-OK");
}

#[test]
fn buffer_alloc_unsafe_slow_returns_buffer_of_size() {
    let out = run_inline(
        r#"
        const b = Buffer.allocUnsafeSlow(64);
        if (Buffer.isBuffer(b) && b.length === 64) console.log('AUS-OK');
        else console.log('FAIL', b.length);
        "#,
    );
    assert_marker(&out, "AUS-OK");
}

#[test]
fn buffer_copy_bytes_from_uint8array_full() {
    let out = run_inline(
        r#"
        const src = new Uint8Array([1, 2, 3, 4, 5]);
        const b = Buffer.copyBytesFrom(src);
        if (b.length === 5 && b[0] === 1 && b[4] === 5) console.log('CB-FULL-OK');
        else console.log('FAIL', Array.from(b));
        "#,
    );
    assert_marker(&out, "CB-FULL-OK");
}

#[test]
fn buffer_copy_bytes_from_uint8array_with_offset_and_length() {
    let out = run_inline(
        r#"
        const src = new Uint8Array([10, 20, 30, 40, 50]);
        const b = Buffer.copyBytesFrom(src, 1, 3);
        if (b.length === 3 && b[0] === 20 && b[1] === 30 && b[2] === 40)
            console.log('CB-SLICE-OK');
        else console.log('FAIL', Array.from(b));
        "#,
    );
    assert_marker(&out, "CB-SLICE-OK");
}

#[test]
fn buffer_copy_bytes_from_uint32array_uses_byte_count() {
    let out = run_inline(
        r#"
        // Two u32 elements (8 bytes), little-endian: 1, 2
        const src = new Uint32Array([1, 2, 3]);
        const b = Buffer.copyBytesFrom(src, 0, 2);
        if (b.length === 8 && b.readUInt32LE(0) === 1 && b.readUInt32LE(4) === 2)
            console.log('CB-U32-OK');
        else console.log('FAIL', b.length);
        "#,
    );
    assert_marker(&out, "CB-U32-OK");
}

#[test]
fn buffer_copy_bytes_from_invalid_view_throws() {
    let out = run_inline(
        r#"
        try {
            Buffer.copyBytesFrom({});
            console.log('FAIL no-throw');
        } catch (_) { console.log('TYPE-OK'); }
        "#,
    );
    assert_marker(&out, "TYPE-OK");
}

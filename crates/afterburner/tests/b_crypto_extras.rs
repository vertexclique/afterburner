//! `crypto.hash` (Node 21+), `crypto.hkdf` / `hkdfSync` (Node 15+),
//! `crypto.scrypt` (async), `crypto.subtle` alias, `crypto.fips`,
//! and `crypto.KeyObject` / `X509Certificate` /
//! `create{Secret,Private,Public}Key` / `generateKeyPair` /
//! `diffieHellman` stub surface (Node 11+).

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
fn crypto_hash_one_shot_sha256() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        const want = crypto.createHash('sha256').update('hello').digest('hex');
        const got = crypto.hash('sha256', 'hello');
        if (want === got) console.log('HASH-OK');
        else console.log('FAIL', want, got);
        "#,
    );
    assert_marker(&out, "HASH-OK");
}

#[test]
fn crypto_hkdf_sync_returns_array_buffer() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        const ab = crypto.hkdfSync('sha256', 'ikm-bytes', 'salt-bytes', 'context', 32);
        if (ab instanceof ArrayBuffer && ab.byteLength === 32) console.log('HKDFS-OK');
        else console.log('FAIL', ab);
        "#,
    );
    assert_marker(&out, "HKDFS-OK");
}

#[test]
fn crypto_hkdf_async_callback() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        crypto.hkdf('sha256', 'ikm', 'salt', 'info', 16, (err, out) => {
            if (!err && out instanceof ArrayBuffer && out.byteLength === 16)
                console.log('HKDF-OK');
            else console.log('FAIL', err && err.message, out);
        });
        "#,
    );
    assert_marker(&out, "HKDF-OK");
}

#[test]
fn crypto_subtle_aliases_global() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        if (crypto.subtle === globalThis.crypto.subtle) console.log('SUBTLE-OK');
        else console.log('FAIL');
        "#,
    );
    assert_marker(&out, "SUBTLE-OK");
}

#[test]
fn crypto_fips_is_false() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        if (crypto.fips === false && crypto.getFips() === 0) console.log('FIPS-OK');
        else console.log('FAIL');
        "#,
    );
    assert_marker(&out, "FIPS-OK");
}

#[test]
fn crypto_create_secret_key_throws_not_implemented() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        try { crypto.createSecretKey(Buffer.from('a-secret-key')); console.log('FAIL no-throw'); }
        catch (e) { if (e.code === 'ERR_NOT_IMPLEMENTED') console.log('CSK-NI-OK'); else console.log('FAIL', e.code); }
        "#,
    );
    assert_marker(&out, "CSK-NI-OK");
}

#[test]
fn crypto_check_prime_sync_returns_boolean() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        const r = crypto.checkPrimeSync(Buffer.from([7]));
        if (typeof r === 'boolean') console.log('CPS-OK');
        else console.log('FAIL', r);
        "#,
    );
    assert_marker(&out, "CPS-OK");
}

#[test]
fn crypto_scrypt_async_callback() {
    let out = run_inline(
        r#"
        const crypto = require('crypto');
        crypto.scrypt('password', 'salt', 16, (err, derived) => {
            if (!err && Buffer.isBuffer(derived) && derived.length === 16)
                console.log('SCRYPT-OK');
            else console.log('FAIL', err && err.message);
        });
        "#,
    );
    assert_marker(&out, "SCRYPT-OK");
}

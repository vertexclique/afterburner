//! Integration tests for host-backed Node built-ins on the native path.
//! Verifies that `Manifold::sealed` denies access and that an explicit
//! `FsAccess::ReadWrite(roots)` grants scoped access.

use afterburner_core::{Combustor, FsAccess, FuelGauge, Manifold};
use afterburner_ignite::NativeCombustor;
use serde_json::json;
use std::path::PathBuf;

fn run(source: &str, manifold: Manifold) -> serde_json::Value {
    let c = NativeCombustor::new().unwrap();
    let id = c.ignite(source).unwrap();
    let limits = FuelGauge {
        manifold,
        ..FuelGauge::default()
    };
    c.thrust(&id, &json!(null), &limits).unwrap()
}

fn temp_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "afterburner-node-compat-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn sealed_manifold_denies_fs_read() {
    let src = r#"
        module.exports = () => {
            try { require('fs').readFileSync('/etc/hostname'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let msg = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("not available"),
        "expected permission denial; got {msg}"
    );
}

#[test]
fn fs_read_write_roundtrip_under_readwrite_policy() {
    let root = temp_root();
    let file = root.join("greeting.txt");
    let path = file.to_string_lossy().into_owned();

    let src = format!(
        r#"
        module.exports = () => {{
            const fs = require('fs');
            fs.writeFileSync({path:?}, 'hello afterburner');
            return fs.readFileSync({path:?});
        }};
        "#,
        path = path,
    );

    let mut m = Manifold::sealed();
    m.fs = FsAccess::ReadWrite(vec![root.clone()]);
    let out = run(&src, m);
    assert_eq!(out, json!("hello afterburner"));
}

#[test]
fn fs_write_outside_roots_is_rejected() {
    let root = temp_root();
    let outside = std::env::temp_dir().join("afterburner-node-compat-outside.txt");

    let src = format!(
        r#"
        module.exports = () => {{
            try {{
                require('fs').writeFileSync({out:?}, 'should fail');
                return 'unexpected';
            }} catch (e) {{ return e.message; }}
        }};
        "#,
        out = outside.to_string_lossy()
    );

    let mut m = Manifold::sealed();
    m.fs = FsAccess::ReadWrite(vec![root]);
    let out = run(&src, m).as_str().unwrap().to_lowercase();
    assert!(
        out.contains("outside allowed roots") || out.contains("permission denied"),
        "expected root-jail denial; got {out}"
    );
}

#[test]
fn fs_read_only_rejects_writes() {
    let root = temp_root();
    let file = root.join("ro.txt");
    std::fs::write(&file, b"seeded").unwrap();

    let src = format!(
        r#"
        module.exports = () => {{
            const fs = require('fs');
            const read = fs.readFileSync({p:?});
            try {{
                fs.writeFileSync({p:?}, 'nope');
                return {{ read: read, wrote: true }};
            }} catch (e) {{ return {{ read: read, err: e.message }}; }}
        }};
        "#,
        p = file.to_string_lossy()
    );

    let mut m = Manifold::sealed();
    m.fs = FsAccess::ReadOnly(vec![root]);
    let out = run(&src, m);
    assert_eq!(out["read"], json!("seeded"));
    assert!(out["err"].as_str().unwrap().contains("read-only"));
}

#[test]
fn crypto_hash_sha256_matches_known_vector() {
    let src = r#"
        module.exports = () => require('crypto').createHash('sha256').update('abc').digest('hex');
    "#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    // Known SHA-256("abc")
    let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    let out = run(src, m);
    assert_eq!(out, json!(expected));
}

#[test]
fn crypto_hmac_sha256_matches_known_vector() {
    let src = r#"
        module.exports = () => require('crypto').createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex');
    "#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    let expected = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
    let out = run(src, m);
    assert_eq!(out, json!(expected));
}

#[test]
fn crypto_random_uuid_is_v4() {
    let src = r#"module.exports = () => require('crypto').randomUUID();"#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    let out = run(src, m);
    let s = out.as_str().unwrap();
    // v4 format: 8-4-4-4-12 hex with '4' in 13th char and [89ab] in 17th.
    assert_eq!(s.len(), 36);
    assert_eq!(s.as_bytes()[14] as char, '4');
    assert!("89ab".contains(s.as_bytes()[19] as char));
}

#[test]
fn crypto_denied_when_manifold_crypto_false() {
    let src = r#"
        module.exports = () => {
            try { require('crypto').createHash('sha256').update('x').digest('hex'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let msg = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        msg.contains("permission denied"),
        "expected crypto permission denial; got {msg}"
    );
}

#[test]
fn os_platform_returns_host_value() {
    let src = r#"module.exports = () => require('os').platform();"#;
    let out = run(src, Manifold::sealed());
    // os is not capability-gated; should match `std::env::consts::OS`.
    assert_eq!(out, json!(std::env::consts::OS));
}

#[test]
fn child_process_denied_when_manifold_disabled() {
    let src = r#"
        module.exports = () => {
            try { require('child_process').execSync('/bin/true'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let msg = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        msg.contains("permission denied"),
        "expected child_process denial; got {msg}"
    );
}

#[test]
fn child_process_exec_sync_runs_under_trusted_manifold() {
    let src = r#"
        module.exports = () => require('child_process').execSync('echo afterburner').trim();
    "#;
    let mut m = Manifold::sealed();
    m.child_process = true;
    let out = run(src, m);
    assert_eq!(out, json!("afterburner"));
}

#[test]
fn dns_denied_when_manifold_net_none() {
    let src = r#"
        module.exports = () => {
            try { require('dns').lookup('localhost'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let msg = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        msg.contains("permission denied"),
        "expected dns denial; got {msg}"
    );
}

#[test]
fn zlib_gzip_roundtrip() {
    let src = r#"
        module.exports = () => {
            const zlib = require('zlib');
            const { Buffer } = require('buffer');
            const payload = 'hello afterburner ' + 'x'.repeat(1000);
            const compressed = zlib.gzipSync(payload);
            const decompressed = zlib.gunzipSync(compressed).toString('utf8');
            return {
                ok: decompressed === payload,
                shrunk: compressed.length < payload.length,
                original_len: payload.length,
                compressed_len: compressed.length,
            };
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["shrunk"], json!(true));
}

#[test]
fn zlib_deflate_inflate_roundtrip() {
    let src = r#"
        module.exports = () => {
            const zlib = require('zlib');
            const d = zlib.deflateSync('The quick brown fox jumps over the lazy dog');
            return zlib.inflateSync(d).toString('utf8');
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!("The quick brown fox jumps over the lazy dog"));
}

#[test]
fn dns_lookup_localhost_resolves_under_net_manifold() {
    use afterburner_core::NetAccess;
    let src = r#"
        module.exports = () => require('dns').lookup('localhost').address;
    "#;
    let mut m = Manifold::sealed();
    m.net = NetAccess::OutboundHttp(None);
    let out = run(src, m);
    let addr = out.as_str().unwrap();
    assert!(
        addr == "127.0.0.1" || addr == "::1",
        "expected loopback; got {addr}"
    );
}

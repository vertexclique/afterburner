//! End-to-end integration tests for the WASM sandbox's node-compat
//! layer — fs/crypto calls go through the `afterburner:host` imports
//! gated by `Manifold`.

use afterburner_core::{Combustor, FsAccess, FuelGauge, Manifold};
use afterburner_wasi::{WasmCombustor, WasmConfig};
use serde_json::json;
use std::path::PathBuf;

fn combustor() -> WasmCombustor {
    WasmCombustor::new(WasmConfig::default()).unwrap()
}

fn run(source: &str, manifold: Manifold) -> serde_json::Value {
    let c = combustor();
    let id = c.ignite(source).unwrap();
    let limits = FuelGauge {
        manifold,
        ..FuelGauge::default()
    };
    c.thrust(&id, &json!(null), &limits).unwrap()
}

fn temp_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "afterburner-wasi-node-compat-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn wasm_sealed_fs_is_denied() {
    let src = r#"
        module.exports = () => {
            try { require('fs').readFileSync('/etc/hostname'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let out = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        out.contains("permission denied"),
        "expected denial; got {out}"
    );
}

#[test]
fn wasm_fs_roundtrip_under_readwrite() {
    let root = temp_root();
    let file = root.join("hello.txt");
    let path = file.to_string_lossy().into_owned();
    let src = format!(
        r#"
        module.exports = () => {{
            const fs = require('fs');
            fs.writeFileSync({p:?}, 'wasm-sandbox');
            return fs.readFileSync({p:?});
        }};
        "#,
        p = path
    );
    let mut m = Manifold::sealed();
    m.fs = FsAccess::ReadWrite(vec![root]);
    let out = run(&src, m);
    assert_eq!(out, json!("wasm-sandbox"));
}

#[test]
fn wasm_fs_write_outside_roots_is_rejected() {
    let root = temp_root();
    let outside = std::env::temp_dir().join("afterburner-wasm-outside.txt");
    let src = format!(
        r#"
        module.exports = () => {{
            try {{
                require('fs').writeFileSync({o:?}, 'nope');
                return 'unexpected';
            }} catch (e) {{ return e.message; }}
        }};
        "#,
        o = outside.to_string_lossy()
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
fn wasm_crypto_sha256_known_vector() {
    let src = r#"
        module.exports = () =>
            require('crypto').createHash('sha256').update('abc').digest('hex');
    "#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    let out = run(src, m);
    assert_eq!(out, json!(expected));
}

#[test]
fn wasm_crypto_denied_under_sealed() {
    let src = r#"
        module.exports = () => {
            try { require('crypto').createHash('sha256').update('x').digest('hex'); return 'unexpected'; }
            catch (e) { return e.message; }
        };
    "#;
    let out = run(src, Manifold::sealed()).as_str().unwrap().to_lowercase();
    assert!(
        out.contains("permission denied"),
        "expected denial; got {out}"
    );
}

#[test]
fn wasm_zlib_gzip_roundtrip() {
    let src = r#"
        module.exports = () => {
            const zlib = require('zlib');
            const payload = 'wasm-zlib ' + 'y'.repeat(1000);
            const compressed = zlib.gzipSync(payload);
            const decompressed = zlib.gunzipSync(compressed).toString('utf8');
            return {
                ok: decompressed === payload,
                shrunk: compressed.length < payload.length,
            };
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["shrunk"], json!(true));
}

#[test]
fn wasm_os_platform_returns_host_value() {
    let src = r#"module.exports = () => require('os').platform();"#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!(std::env::consts::OS));
}

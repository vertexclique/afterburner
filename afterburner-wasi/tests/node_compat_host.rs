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
    let out = run(src, Manifold::sealed())
        .as_str()
        .unwrap()
        .to_lowercase();
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
    let out = run(src, Manifold::sealed())
        .as_str()
        .unwrap()
        .to_lowercase();
    assert!(
        out.contains("permission denied"),
        "expected denial; got {out}"
    );
}

#[test]
fn wasm_state_store_persists_across_thrusts() {
    use afterburner_core::{Combustor, InMemoryStateStore};
    let store = InMemoryStateStore::shared();
    let cfg = WasmConfig {
        state_store: Some(store.clone()),
    };
    let c = WasmCombustor::new(cfg).unwrap();
    let id = c
        .ignite("module.exports = () => require('afterburner:state').increment('hits')")
        .unwrap();
    let limits = FuelGauge {
        manifold: Manifold::sealed(),
        ..FuelGauge::default()
    };
    assert_eq!(c.thrust(&id, &json!(null), &limits).unwrap(), json!(1));
    assert_eq!(c.thrust(&id, &json!(null), &limits).unwrap(), json!(2));
    assert_eq!(c.thrust(&id, &json!(null), &limits).unwrap(), json!(3));
    assert_eq!(String::from_utf8(store.get("hits").unwrap()).unwrap(), "3");
}

#[test]
fn wasm_state_store_set_get_json() {
    let src = r#"
        module.exports = () => {
            const s = require('afterburner:state');
            s.setJSON('user', { id: 7, tags: ['x'] });
            return s.getJSON('user');
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!({ "id": 7, "tags": ["x"] }));
}

#[test]
fn wasm_process_event_emitter() {
    let src = r#"
        module.exports = () => {
            let captured = null;
            process.on('custom', (msg) => { captured = msg; });
            process.emit('custom', 'wasm');
            return captured;
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!("wasm"));
}

#[test]
fn wasm_fs_stream_roundtrip() {
    let root = temp_root();
    let in_file = root.join("in.txt");
    let out_file = root.join("out.txt");
    std::fs::write(&in_file, "x".repeat(40_000)).unwrap();

    let src = format!(
        r#"
        module.exports = () => {{
            const fs = require('fs');
            const w = fs.createWriteStream({out:?});
            const r = fs.createReadStream({in:?}, {{ highWaterMark: 8 * 1024 }});
            const counts = {{ chunks: 0, bytes: 0 }};
            r.on('end',  () => {{ w.end(); }});
            r.on('data', (chunk) => {{ counts.chunks++; counts.bytes += chunk.length; w.write(chunk); }});
            counts.copied = fs.readFileSync({out:?}).length;
            return counts;
        }};
        "#,
        in = in_file.to_string_lossy(),
        out = out_file.to_string_lossy(),
    );
    let mut m = Manifold::sealed();
    m.fs = FsAccess::ReadWrite(vec![root]);
    let out = run(&src, m);
    assert_eq!(out["bytes"], json!(40_000));
    assert_eq!(out["copied"], json!(40_000));
    let chunks = out["chunks"].as_u64().unwrap();
    assert!((4..=6).contains(&chunks), "got {chunks}");
}

#[test]
fn wasm_aes_gcm_roundtrip() {
    let src = r#"
        module.exports = () => {
            const crypto = require('crypto');
            const { Buffer } = require('buffer');
            const key = Buffer.alloc(32, 9);
            const iv  = Buffer.alloc(12, 0);
            const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
            enc.update('sandboxed');
            const ct = enc.final();
            const tag = enc.getAuthTag();
            const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
            dec.setAuthTag(tag);
            dec.update(ct);
            return dec.final().toString('utf8');
        };
    "#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    let out = run(src, m);
    assert_eq!(out, json!("sandboxed"));
}

#[test]
fn wasm_pbkdf2_sync_works() {
    let src = r#"
        module.exports = () => {
            const crypto = require('crypto');
            return crypto.pbkdf2Sync('pw', 'salt', 1, 32, 'sha256').toString('hex');
        };
    "#;
    let mut m = Manifold::sealed();
    m.crypto = true;
    let out = run(src, m);
    assert!(out.as_str().unwrap().len() == 64);
}

#[test]
fn wasm_abort_controller() {
    let src = r#"
        module.exports = () => {
            const c = new AbortController();
            let hits = 0;
            c.signal.addEventListener('abort', () => { hits++; });
            c.abort();
            c.abort(); // second call should not re-fire
            return hits;
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!(1));
}

#[test]
fn wasm_stubs_give_clear_error() {
    let src = r#"
        module.exports = () => {
            try { require('worker_threads').Worker; return 'unexpected'; }
            catch (e) { return e.code; }
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!("ERR_NOT_SUPPORTED_IN_SANDBOX"));
}

#[test]
fn wasm_buffer_readwrite_numeric() {
    let src = r#"
        module.exports = () => {
            const { Buffer } = require('buffer');
            const b = Buffer.alloc(4);
            b.writeUInt32BE(0x01020304, 0);
            return b.toString('hex');
        };
    "#;
    let out = run(src, Manifold::sealed());
    assert_eq!(out, json!("01020304"));
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

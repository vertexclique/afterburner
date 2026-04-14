//! Afterburner custom Javy plugin.
//!
//! Targets `wasm32-wasip1`. Committed as a Wizer-preinitialized binary
//! (`quickjs-provider/afterburner_plugin.wasm`) so the host never needs
//! the `javy` CLI at runtime.
//!
//! ### Runtime protocol
//!
//! The host instantiates this plugin into a fresh `Store` per thrust
//! and calls the exported `_start` function. `_start`:
//!
//! 1. Reads an envelope from stdin: `{source: string, input: any}`.
//! 2. Wraps the user's `source` in an I/O envelope (reads `__ab_input`,
//!    writes `JSON.stringify(result)` to stdout).
//! 3. Compiles the wrapped source to QuickJS bytecode via
//!    `javy_plugin_api::compile_src`.
//! 4. Invokes the bytecode via `javy_plugin_api::invoke`.
//!
//! JS inside the user source reaches host capabilities through
//! `__host_*` globals wired in `modify_runtime`, each of which calls an
//! `afterburner:host` WASM import that the host resolves to Rust
//! closures gated by the active [`Manifold`].
//!
//! ### Error reporting
//!
//! Variable-length host responses use a buffer protocol — the callee
//! writes bytes into a caller-provided region and returns either the
//! length or a negative error code. A detailed message is stashed in
//! the host's `last_error` slot and readable via the `host_last_error`
//! import.

#![no_std]
#![cfg(target_arch = "wasm32")]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use javy_plugin_api::javy::Runtime;
use javy_plugin_api::javy::quickjs::prelude::Func;
use javy_plugin_api::{Config, import_namespace};

import_namespace!("afterburner-plugin-v1");

#[link(wasm_import_module = "afterburner:host")]
unsafe extern "C" {
    fn host_fs_read_file_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_fs_write_file_sync(
        path_ptr: *const u8,
        path_len: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    fn host_fs_exists_sync(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_fs_stat_sync(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32)
    -> i32;
    fn host_fs_unlink_sync(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_fs_rename_sync(
        from_ptr: *const u8, from_len: u32,
        to_ptr: *const u8, to_len: u32,
    ) -> i32;
    fn host_fs_mkdir_sync(path_ptr: *const u8, path_len: u32, recursive: i32) -> i32;
    fn host_fs_readdir_sync(
        path_ptr: *const u8, path_len: u32,
        out_ptr: *mut u8, out_cap: u32,
    ) -> i32;

    fn host_crypto_hash(
        algo_ptr: *const u8,
        algo_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_random_bytes(len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    fn host_os_platform(out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_os_arch(out_ptr: *mut u8, out_cap: u32) -> i32;

    fn host_http_request(
        method_ptr: *const u8,
        method_len: u32,
        url_ptr: *const u8,
        url_len: u32,
        body_ptr: *const u8,
        body_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    fn host_dns_lookup(name_ptr: *const u8, name_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    fn host_zlib_deflate_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_zlib_inflate_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_zlib_gzip_sync(in_ptr: *const u8, in_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_zlib_gunzip_sync(in_ptr: *const u8, in_len: u32, out_ptr: *mut u8, out_cap: u32)
    -> i32;

    // Sign / verify (RSA + ECDSA). Key passed as PEM string; data + sig
    // base64 over the wire to keep the i32-only ABI uniform.
    fn host_crypto_sign(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_verify(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        sig_ptr: *const u8,
        sig_len: u32,
    ) -> i32;

    // Streaming sign / verify. `open` returns a 64-bit handle (0 = err);
    // `update` feeds a base64 chunk; `finalize` consumes the handle and
    // returns the signature (sign) or a 0/1 verdict (verify).
    fn host_crypto_sign_open(algo_ptr: *const u8, algo_len: u32) -> i64;
    fn host_crypto_sign_update(
        handle: i64,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    fn host_crypto_sign_finalize(
        handle: i64,
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_verify_finalize(
        handle: i64,
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        sig_ptr: *const u8,
        sig_len: u32,
    ) -> i32;

    // Streaming createHash / createHmac. `hash_open` is for unkeyed
    // digests; `hmac_open` takes the MAC key at open time.
    fn host_crypto_hash_open(algo_ptr: *const u8, algo_len: u32) -> i64;
    fn host_crypto_hmac_open(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
    ) -> i64;
    fn host_crypto_hash_update(
        handle: i64,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    fn host_crypto_hash_digest(
        handle: i64,
        enc_ptr: *const u8,
        enc_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // Host context (ScramDB-facing hooks).
    fn host_read_column(
        name_ptr: *const u8,
        name_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_emit_row(row_ptr: *const u8, row_len: u32) -> i32;
    fn host_get_env(
        key_ptr: *const u8,
        key_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // State store (afterburner:state).
    fn host_state_get(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_state_set(
        key_ptr: *const u8,
        key_len: u32,
        value_ptr: *const u8,
        value_len: u32,
    ) -> i32;
    fn host_state_delete(key_ptr: *const u8, key_len: u32) -> i32;
    fn host_state_increment(key_ptr: *const u8, key_len: u32, delta: i64) -> i64;

    // Chunked fs (createReadStream / createWriteStream backing).
    fn host_fs_read_chunk(
        path_ptr: *const u8,
        path_len: u32,
        offset_lo: u32,
        offset_hi: u32,
        chunk_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_fs_write_chunk(
        path_ptr: *const u8,
        path_len: u32,
        offset_lo: u32,
        offset_hi: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    fn host_fs_size(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    // Ciphers + KDFs. Arguments are base64-encoded strings (same wire
    // format as zlib); the host decodes before calling the impl.
    fn host_crypto_aes_gcm_encrypt(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        nonce_ptr: *const u8,
        nonce_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        aad_ptr: *const u8,
        aad_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_aes_gcm_decrypt(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        nonce_ptr: *const u8,
        nonce_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        aad_ptr: *const u8,
        aad_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_aes_cbc_encrypt(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        iv_ptr: *const u8,
        iv_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_aes_cbc_decrypt(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        iv_ptr: *const u8,
        iv_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_pbkdf2_sync(
        digest_ptr: *const u8,
        digest_len: u32,
        password_ptr: *const u8,
        password_len: u32,
        salt_ptr: *const u8,
        salt_len: u32,
        iters: u32,
        key_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    fn host_crypto_scrypt_sync(
        password_ptr: *const u8,
        password_len: u32,
        salt_ptr: *const u8,
        salt_len: u32,
        n: u32,
        r: u32,
        p: u32,
        key_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    fn host_last_error(out_ptr: *mut u8, out_cap: u32) -> i32;
}

/// Default buffer size for variable-length host responses. The retry
/// loop in `call_read` doubles until the host confirms it fits.
const DEFAULT_BUF: usize = 64 * 1024;

/// The plenum.js bundle, baked into the plugin. Evaluated once during
/// `modify_runtime` so Wizer captures it into the preinit snapshot —
/// every thrust starts with `require()` and the Tier-1 polyfills
/// already installed.
const PLENUM_BUNDLE: &str =
    include_str!("../../afterburner-node-compat/generated/plenum_bundle.js");

fn call_read<F>(mut call: F) -> Result<String, String>
where
    F: FnMut(*mut u8, u32) -> i32,
{
    let mut buf = vec![0u8; DEFAULT_BUF];
    let mut cap = buf.len();
    loop {
        let n = call(buf.as_mut_ptr(), cap as u32);
        if n >= 0 {
            buf.truncate(n as usize);
            return String::from_utf8(buf).map_err(|e| format!("utf8: {e}"));
        }
        if n == -4 {
            cap *= 2;
            if cap > 16 * 1024 * 1024 {
                return Err("output exceeded 16 MiB cap".to_string());
            }
            buf.resize(cap, 0);
            continue;
        }
        return Err(read_last_error(n));
    }
}

fn read_last_error(code: i32) -> String {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { host_last_error(buf.as_mut_ptr(), buf.len() as u32) };
    if n >= 0 {
        buf.truncate(n as usize);
        String::from_utf8_lossy(&buf).into_owned()
    } else {
        format!("host error (code {code})")
    }
}

fn modify_runtime(runtime: Runtime) -> Runtime {
    runtime.context().with(|ctx| {
        let globals = ctx.globals();

        // Expose the host's `last_error` slot as a JS-callable global.
        // Useful when a host call returns a sentinel (0 handle, -N code)
        // and the polyfill needs the detailed message — e.g. to
        // distinguish "permission denied" from "algorithm not supported"
        // on a failed `createHash` open.
        let _ = globals.set(
            "__host_last_error",
            Func::from(|| -> String {
                let mut buf = vec![0u8; 4096];
                let n = unsafe { host_last_error(buf.as_mut_ptr(), buf.len() as u32) };
                if n >= 0 {
                    buf.truncate(n as usize);
                    String::from_utf8_lossy(&buf).into_owned()
                } else {
                    String::new()
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_exists_sync",
            Func::from(|path: String| -> bool {
                let bytes = path.as_bytes();
                unsafe { host_fs_exists_sync(bytes.as_ptr(), bytes.len() as u32) == 1 }
            }),
        );

        let _ = globals.set(
            "__host_fs_read_file_sync",
            Func::from(|path: String, _enc: Option<String>| -> String {
                let pb = path.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_fs_read_file_sync(pb.as_ptr(), pb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_write_file_sync",
            Func::from(
                |path: String, data: String, _enc: Option<String>| -> String {
                    let pb = path.as_bytes();
                    let db = data.as_bytes();
                    let code = unsafe {
                        host_fs_write_file_sync(
                            pb.as_ptr(),
                            pb.len() as u32,
                            db.as_ptr(),
                            db.len() as u32,
                        )
                    };
                    if code >= 0 {
                        String::new()
                    } else {
                        format!("__HOST_ERR__:{}", read_last_error(code))
                    }
                },
            ),
        );

        let _ = globals.set(
            "__host_fs_unlink_sync",
            Func::from(|path: String| -> String {
                let pb = path.as_bytes();
                let code = unsafe { host_fs_unlink_sync(pb.as_ptr(), pb.len() as u32) };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_rename_sync",
            Func::from(|from: String, to: String| -> String {
                let fb = from.as_bytes();
                let tb = to.as_bytes();
                let code = unsafe {
                    host_fs_rename_sync(
                        fb.as_ptr(), fb.len() as u32,
                        tb.as_ptr(), tb.len() as u32,
                    )
                };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_mkdir_sync",
            Func::from(|path: String, recursive: Option<bool>| -> String {
                let pb = path.as_bytes();
                let flag = if recursive.unwrap_or(false) { 1 } else { 0 };
                let code = unsafe { host_fs_mkdir_sync(pb.as_ptr(), pb.len() as u32, flag) };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_readdir_sync",
            Func::from(|path: String| -> String {
                let pb = path.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_fs_readdir_sync(pb.as_ptr(), pb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_stat_sync",
            Func::from(|path: String| -> String {
                let pb = path.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_fs_stat_sync(pb.as_ptr(), pb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_crypto_hash",
            Func::from(
                |algo: String, data: String, _enc: Option<String>| -> String {
                    let ab = algo.as_bytes();
                    let db = data.as_bytes();
                    match call_read(|out, cap| unsafe {
                        host_crypto_hash(
                            ab.as_ptr(),
                            ab.len() as u32,
                            db.as_ptr(),
                            db.len() as u32,
                            out,
                            cap,
                        )
                    }) {
                        Ok(s) => s,
                        Err(e) => format!("__HOST_ERR__:{e}"),
                    }
                },
            ),
        );

        let _ = globals.set(
            "__host_crypto_random_bytes",
            Func::from(|len: u32, _enc: Option<String>| -> String {
                match call_read(|out, cap| unsafe { host_crypto_random_bytes(len, out, cap) }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_os_platform",
            Func::from(|| -> String {
                match call_read(|out, cap| unsafe { host_os_platform(out, cap) }) {
                    Ok(s) => s,
                    Err(_) => "unknown".to_string(),
                }
            }),
        );

        let _ = globals.set(
            "__host_os_arch",
            Func::from(|| -> String {
                match call_read(|out, cap| unsafe { host_os_arch(out, cap) }) {
                    Ok(s) => s,
                    Err(_) => "unknown".to_string(),
                }
            }),
        );

        let _ = globals.set(
            "__host_http_request",
            Func::from(
                |method: String, url: String, body: Option<String>| -> String {
                    let mb = method.as_bytes();
                    let ub = url.as_bytes();
                    let body_vec: Vec<u8> = body.map(|b| b.into_bytes()).unwrap_or_default();
                    match call_read(|out, cap| unsafe {
                        host_http_request(
                            mb.as_ptr(),
                            mb.len() as u32,
                            ub.as_ptr(),
                            ub.len() as u32,
                            body_vec.as_ptr(),
                            body_vec.len() as u32,
                            out,
                            cap,
                        )
                    }) {
                        Ok(s) => s,
                        Err(e) => format!(r#"{{"status":0,"body":"__HOST_ERR__:{e}"}}"#),
                    }
                },
            ),
        );

        let _ = globals.set(
            "__host_dns_lookup",
            Func::from(|name: String| -> String {
                let nb = name.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_dns_lookup(nb.as_ptr(), nb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        macro_rules! bind_zlib {
            ($name:literal, $fn:ident) => {
                let _ = globals.set(
                    $name,
                    Func::from(|data_b64: String| -> String {
                        let db = data_b64.as_bytes();
                        match call_read(|out, cap| unsafe {
                            $fn(db.as_ptr(), db.len() as u32, out, cap)
                        }) {
                            Ok(s) => s,
                            Err(e) => format!("__HOST_ERR__:{e}"),
                        }
                    }),
                );
            };
        }
        bind_zlib!("__host_zlib_deflate_sync", host_zlib_deflate_sync);
        bind_zlib!("__host_zlib_inflate_sync", host_zlib_inflate_sync);
        bind_zlib!("__host_zlib_gzip_sync", host_zlib_gzip_sync);
        bind_zlib!("__host_zlib_gunzip_sync", host_zlib_gunzip_sync);

        // AES-GCM (supports optional AAD).
        macro_rules! bind_gcm {
            ($name:literal, $fn:ident) => {
                let _ = globals.set(
                    $name,
                    Func::from(
                        |algo: String,
                         key_b64: String,
                         nonce_b64: String,
                         data_b64: String,
                         aad_b64: Option<String>|
                         -> String {
                            let ab = algo.as_bytes();
                            let kb = key_b64.as_bytes();
                            let nb = nonce_b64.as_bytes();
                            let db = data_b64.as_bytes();
                            let aad = aad_b64.unwrap_or_default();
                            let aadb = aad.as_bytes();
                            match call_read(|out, cap| unsafe {
                                $fn(
                                    ab.as_ptr(),
                                    ab.len() as u32,
                                    kb.as_ptr(),
                                    kb.len() as u32,
                                    nb.as_ptr(),
                                    nb.len() as u32,
                                    db.as_ptr(),
                                    db.len() as u32,
                                    aadb.as_ptr(),
                                    aadb.len() as u32,
                                    out,
                                    cap,
                                )
                            }) {
                                Ok(s) => s,
                                Err(e) => format!("__HOST_ERR__:{e}"),
                            }
                        },
                    ),
                );
            };
        }
        bind_gcm!("__host_crypto_aes_gcm_encrypt", host_crypto_aes_gcm_encrypt);
        bind_gcm!("__host_crypto_aes_gcm_decrypt", host_crypto_aes_gcm_decrypt);

        // AES-CBC.
        macro_rules! bind_cbc {
            ($name:literal, $fn:ident) => {
                let _ = globals.set(
                    $name,
                    Func::from(
                        |algo: String,
                         key_b64: String,
                         iv_b64: String,
                         data_b64: String|
                         -> String {
                            let ab = algo.as_bytes();
                            let kb = key_b64.as_bytes();
                            let ib = iv_b64.as_bytes();
                            let db = data_b64.as_bytes();
                            match call_read(|out, cap| unsafe {
                                $fn(
                                    ab.as_ptr(),
                                    ab.len() as u32,
                                    kb.as_ptr(),
                                    kb.len() as u32,
                                    ib.as_ptr(),
                                    ib.len() as u32,
                                    db.as_ptr(),
                                    db.len() as u32,
                                    out,
                                    cap,
                                )
                            }) {
                                Ok(s) => s,
                                Err(e) => format!("__HOST_ERR__:{e}"),
                            }
                        },
                    ),
                );
            };
        }
        bind_cbc!("__host_crypto_aes_cbc_encrypt", host_crypto_aes_cbc_encrypt);
        bind_cbc!("__host_crypto_aes_cbc_decrypt", host_crypto_aes_cbc_decrypt);

        let _ = globals.set(
            "__host_crypto_pbkdf2_sync",
            Func::from(
                |digest: String,
                 password: String,
                 salt_b64: String,
                 iters: u32,
                 key_len: u32|
                 -> String {
                    let db = digest.as_bytes();
                    let pb = password.as_bytes();
                    let sb = salt_b64.as_bytes();
                    match call_read(|out, cap| unsafe {
                        host_crypto_pbkdf2_sync(
                            db.as_ptr(),
                            db.len() as u32,
                            pb.as_ptr(),
                            pb.len() as u32,
                            sb.as_ptr(),
                            sb.len() as u32,
                            iters,
                            key_len,
                            out,
                            cap,
                        )
                    }) {
                        Ok(s) => s,
                        Err(e) => format!("__HOST_ERR__:{e}"),
                    }
                },
            ),
        );

        // Sign / verify (RSA + ECDSA).
        let _ = globals.set(
            "__host_crypto_sign",
            Func::from(
                |algo: String, key_pem: String, data_b64: String| -> String {
                    let ab = algo.as_bytes();
                    let kb = key_pem.as_bytes();
                    let db = data_b64.as_bytes();
                    match call_read(|out, cap| unsafe {
                        host_crypto_sign(
                            ab.as_ptr(),
                            ab.len() as u32,
                            kb.as_ptr(),
                            kb.len() as u32,
                            db.as_ptr(),
                            db.len() as u32,
                            out,
                            cap,
                        )
                    }) {
                        Ok(s) => s,
                        Err(e) => format!("__HOST_ERR__:{e}"),
                    }
                },
            ),
        );

        let _ = globals.set(
            "__host_crypto_verify",
            Func::from(
                |algo: String, key_pem: String, data_b64: String, sig_b64: String| -> i32 {
                    let ab = algo.as_bytes();
                    let kb = key_pem.as_bytes();
                    let db = data_b64.as_bytes();
                    let sb = sig_b64.as_bytes();
                    unsafe {
                        host_crypto_verify(
                            ab.as_ptr(),
                            ab.len() as u32,
                            kb.as_ptr(),
                            kb.len() as u32,
                            db.as_ptr(),
                            db.len() as u32,
                            sb.as_ptr(),
                            sb.len() as u32,
                        )
                    }
                },
            ),
        );

        // Streaming sign / verify. The JS polyfill opens a handle once,
        // feeds chunks via `update`, and finalizes with the key. Handles
        // are scoped to the host-side `SignHandleStore` (per-thrust in
        // WASM, thread-local on the native path).
        let _ = globals.set(
            "__host_crypto_sign_open",
            Func::from(|algo: String| -> f64 {
                let ab = algo.as_bytes();
                let h = unsafe { host_crypto_sign_open(ab.as_ptr(), ab.len() as u32) };
                // 0 = error (JS falsy); the polyfill throws on that.
                // Negative is also "not supported" — surface as 0 too.
                if h <= 0 { 0.0 } else { h as f64 }
            }),
        );

        let _ = globals.set(
            "__host_crypto_sign_update",
            Func::from(|handle: f64, data_b64: String| -> String {
                let h = handle as i64;
                let db = data_b64.as_bytes();
                let code = unsafe {
                    host_crypto_sign_update(h, db.as_ptr(), db.len() as u32)
                };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_crypto_sign_finalize",
            Func::from(|handle: f64, algo: String, key_pem: String| -> String {
                let h = handle as i64;
                let ab = algo.as_bytes();
                let kb = key_pem.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_crypto_sign_finalize(
                        h,
                        ab.as_ptr(),
                        ab.len() as u32,
                        kb.as_ptr(),
                        kb.len() as u32,
                        out,
                        cap,
                    )
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_crypto_verify_finalize",
            Func::from(
                |handle: f64, algo: String, key_pem: String, sig_b64: String| -> i32 {
                    let h = handle as i64;
                    let ab = algo.as_bytes();
                    let kb = key_pem.as_bytes();
                    let sb = sig_b64.as_bytes();
                    unsafe {
                        host_crypto_verify_finalize(
                            h,
                            ab.as_ptr(),
                            ab.len() as u32,
                            kb.as_ptr(),
                            kb.len() as u32,
                            sb.as_ptr(),
                            sb.len() as u32,
                        )
                    }
                },
            ),
        );

        // Streaming createHash / createHmac.
        let _ = globals.set(
            "__host_crypto_hash_open",
            Func::from(|algo: String| -> f64 {
                let ab = algo.as_bytes();
                let h = unsafe { host_crypto_hash_open(ab.as_ptr(), ab.len() as u32) };
                if h <= 0 { 0.0 } else { h as f64 }
            }),
        );

        let _ = globals.set(
            "__host_crypto_hmac_open",
            Func::from(|algo: String, key_b64: String| -> f64 {
                let ab = algo.as_bytes();
                let kb = key_b64.as_bytes();
                let h = unsafe {
                    host_crypto_hmac_open(
                        ab.as_ptr(),
                        ab.len() as u32,
                        kb.as_ptr(),
                        kb.len() as u32,
                    )
                };
                if h <= 0 { 0.0 } else { h as f64 }
            }),
        );

        let _ = globals.set(
            "__host_crypto_hash_update",
            Func::from(|handle: f64, data_b64: String| -> String {
                let h = handle as i64;
                let db = data_b64.as_bytes();
                let code = unsafe {
                    host_crypto_hash_update(h, db.as_ptr(), db.len() as u32)
                };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_crypto_hash_digest",
            Func::from(|handle: f64, enc: Option<String>| -> String {
                let h = handle as i64;
                let enc_s = enc.unwrap_or_default();
                let eb = enc_s.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_crypto_hash_digest(h, eb.as_ptr(), eb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        // Host context (ScramDB-facing hooks).
        let _ = globals.set(
            "__host_read_column",
            Func::from(|name: String| -> String {
                let nb = name.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_read_column(nb.as_ptr(), nb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(_) => "[]".to_string(),
                }
            }),
        );

        let _ = globals.set(
            "__host_emit_row",
            Func::from(|row_json: String| -> i32 {
                let rb = row_json.as_bytes();
                unsafe { host_emit_row(rb.as_ptr(), rb.len() as u32) }
            }),
        );

        let _ = globals.set(
            "__host_get_env",
            Func::from(|key: String| -> Option<String> {
                let kb = key.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_get_env(kb.as_ptr(), kb.len() as u32, out, cap)
                }) {
                    Ok(s) => Some(s),
                    Err(_) => None,
                }
            }),
        );

        // State store (afterburner:state).
        let _ = globals.set(
            "__host_state_get",
            Func::from(|key: String| -> Option<String> {
                let kb = key.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_state_get(kb.as_ptr(), kb.len() as u32, out, cap)
                }) {
                    Ok(s) => Some(s),
                    Err(_) => None, // -2 NotFound or other -> undefined
                }
            }),
        );

        let _ = globals.set(
            "__host_state_set",
            Func::from(|key: String, value_b64: String| -> i32 {
                let kb = key.as_bytes();
                let vb = value_b64.as_bytes();
                unsafe {
                    host_state_set(kb.as_ptr(), kb.len() as u32, vb.as_ptr(), vb.len() as u32)
                }
            }),
        );

        let _ = globals.set(
            "__host_state_delete",
            Func::from(|key: String| -> i32 {
                let kb = key.as_bytes();
                unsafe { host_state_delete(kb.as_ptr(), kb.len() as u32) }
            }),
        );

        let _ = globals.set(
            "__host_state_increment",
            Func::from(|key: String, delta: f64| -> f64 {
                let kb = key.as_bytes();
                let n = unsafe { host_state_increment(kb.as_ptr(), kb.len() as u32, delta as i64) };
                n as f64
            }),
        );

        // Chunked fs (createReadStream / createWriteStream backing).
        let _ = globals.set(
            "__host_fs_read_chunk",
            Func::from(|path: String, offset: f64, len: u32| -> String {
                let pb = path.as_bytes();
                let off = offset as u64;
                let lo = (off & 0xFFFF_FFFF) as u32;
                let hi = (off >> 32) as u32;
                match call_read(|out, cap| unsafe {
                    host_fs_read_chunk(pb.as_ptr(), pb.len() as u32, lo, hi, len, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_write_chunk",
            Func::from(|path: String, offset: f64, data_b64: String| -> String {
                let pb = path.as_bytes();
                let db = data_b64.as_bytes();
                let off = offset as u64;
                let lo = (off & 0xFFFF_FFFF) as u32;
                let hi = (off >> 32) as u32;
                let code = unsafe {
                    host_fs_write_chunk(
                        pb.as_ptr(),
                        pb.len() as u32,
                        lo,
                        hi,
                        db.as_ptr(),
                        db.len() as u32,
                    )
                };
                if code >= 0 {
                    String::new()
                } else {
                    format!("__HOST_ERR__:{}", read_last_error(code))
                }
            }),
        );

        let _ = globals.set(
            "__host_fs_size",
            Func::from(|path: String| -> String {
                let pb = path.as_bytes();
                match call_read(|out, cap| unsafe {
                    host_fs_size(pb.as_ptr(), pb.len() as u32, out, cap)
                }) {
                    Ok(s) => s,
                    Err(e) => format!("__HOST_ERR__:{e}"),
                }
            }),
        );

        let _ = globals.set(
            "__host_crypto_scrypt_sync",
            Func::from(
                |password: String,
                 salt_b64: String,
                 n: u32,
                 r: u32,
                 p: u32,
                 key_len: u32|
                 -> String {
                    let pb = password.as_bytes();
                    let sb = salt_b64.as_bytes();
                    match call_read(|out, cap| unsafe {
                        host_crypto_scrypt_sync(
                            pb.as_ptr(),
                            pb.len() as u32,
                            sb.as_ptr(),
                            sb.len() as u32,
                            n,
                            r,
                            p,
                            key_len,
                            out,
                            cap,
                        )
                    }) {
                        Ok(s) => s,
                        Err(e) => format!("__HOST_ERR__:{e}"),
                    }
                },
            ),
        );

        // Eval the plenum bundle so Wizer preinit captures `require()`
        // and every Tier-1 polyfill into the snapshot.
        let _ = ctx.eval::<(), _>(PLENUM_BUNDLE);
    });

    runtime
}

fn config() -> Config {
    let mut c = Config::default();
    c.text_encoding(true).javy_stream_io(true);
    c
}

#[unsafe(export_name = "initialize-runtime")]
pub extern "C" fn initialize_runtime() {
    if let Err(_) = javy_plugin_api::initialize_runtime(config, modify_runtime) {
        core::arch::wasm32::unreachable()
    }
}

// ---- custom _start that reads (source, input) from stdin --------------

/// Reads the whole envelope from stdin. Envelope format:
///   `{"source": "...js...", "input": <any json>}`
/// Wraps `source` with the I/O envelope and drives
/// `compile_src` + `invoke`. The wrapped source writes the JSON result
/// of the user function to stdout.
#[unsafe(export_name = "_start")]
pub extern "C" fn start() {
    let envelope = match read_stdin() {
        Ok(bytes) => bytes,
        Err(_) => core::arch::wasm32::unreachable(),
    };

    let parsed: serde_json::Value = match serde_json::from_slice(&envelope) {
        Ok(v) => v,
        Err(_) => core::arch::wasm32::unreachable(),
    };

    let source = parsed.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let input = parsed
        .get("input")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let input_json = input.to_string();

    let wrapped = wrap_user_source(source, &input_json);

    let bytecode = match javy_plugin_api::compile_src(wrapped.as_bytes()) {
        Ok(bc) => bc,
        Err(e) => {
            let msg = format!("compile_src: {e}\n");
            write_stderr(msg.as_bytes());
            core::arch::wasm32::unreachable()
        }
    };

    if let Err(e) = javy_plugin_api::invoke(&bytecode, None) {
        let msg = format!("invoke: {e}\n");
        write_stderr(msg.as_bytes());
        core::arch::wasm32::unreachable()
    }
}

fn read_stdin() -> Result<Vec<u8>, ()> {
    // Read all of stdin via WASI preview1 fd_read on fd 0.
    let mut out = Vec::with_capacity(4096);
    let chunk = [0u8; 4096];
    loop {
        let iov = wasi::Ciovec {
            buf: chunk.as_ptr(),
            buf_len: chunk.len(),
        };
        let iov_arr = [iov];
        let mut nread: usize = 0;
        let res =
            unsafe { wasi::fd_read_raw(0, iov_arr.as_ptr() as *const wasi::Iovec, 1, &mut nread) };
        if res != 0 {
            return Err(());
        }
        if nread == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&chunk[..nread]);
    }
}

fn write_stderr(bytes: &[u8]) {
    let iov = wasi::Ciovec {
        buf: bytes.as_ptr(),
        buf_len: bytes.len(),
    };
    let iov_arr = [iov];
    let mut nwritten: usize = 0;
    let _ = unsafe { wasi::fd_write_raw(2, iov_arr.as_ptr(), 1, &mut nwritten) };
}

fn wrap_user_source(user: &str, input_json: &str) -> String {
    let user_lit = js_string_literal(user);
    let input_lit = js_string_literal(input_json);
    format!(
        r#"
        function __ab_write_stdout(s) {{
            Javy.IO.writeSync(1, new TextEncoder().encode(s));
        }}
        const __ab_data = JSON.parse({input_lit});
        const __ab_module = {{ exports: undefined }};
        const __ab_user = new Function('module', 'exports', 'require', {user_lit});
        __ab_user(__ab_module, __ab_module.exports, globalThis.require);
        const __ab_fn = __ab_module.exports;
        const __ab_result = (typeof __ab_fn === 'function') ? __ab_fn(__ab_data) : __ab_fn;
        __ab_write_stdout(JSON.stringify(__ab_result === undefined ? null : __ab_result));
        "#
    )
}

fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

// Minimal WASI preview1 bindings — avoids pulling the `wasi` crate
// (which would bloat the plugin). Only `fd_read` and `fd_write` are
// needed here.
mod wasi {
    #[repr(C)]
    pub struct Ciovec {
        pub buf: *const u8,
        pub buf_len: usize,
    }
    pub type Iovec = Ciovec;

    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        #[link_name = "fd_read"]
        pub fn fd_read_raw(fd: u32, iovs: *const Iovec, iovs_len: u32, nread: *mut usize) -> u32;
        #[link_name = "fd_write"]
        pub fn fd_write_raw(
            fd: u32,
            iovs: *const Ciovec,
            iovs_len: u32,
            nwritten: *mut usize,
        ) -> u32;
    }
}

//! Wasmtime linker registrations for the `afterburner:host` import
//! module declared by `afterburner-plugin`.
//!
//! Each function follows the plugin's buffer protocol:
//!
//! * Inputs are passed as `(ptr, len)` pairs into guest memory.
//! * Outputs (variable-length) are written into a `(out_ptr, out_cap)`
//!   region supplied by the caller. The return value is either the
//!   number of bytes written, or a negative error code: `-1`
//!   (PermissionDenied), `-2` (NotFound), `-3` (Other), or `-4`
//!   (BufTooSmall).
//!
//! When a negative code is returned, the detailed error message is
//! stashed in `HostState::last_error` and read by the plugin via the
//! `host_last_error` import.

use crate::host::{HostState, TimerSlot};
use afterburner_core::AfterburnerError;
use afterburner_node_compat::{crypto_host, dns_host, fs_host, http_host, os_host, zlib_host};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use std::time::{Duration, Instant};
use wasmtime::{Caller, Linker, Memory};
use wasmtime_wasi::I32Exit;

const NS: &str = "afterburner:host";

const E_PERMISSION: i32 = -1;
const E_NOT_FOUND: i32 = -2;
const E_OTHER: i32 = -3;
const E_BUF_TOO_SMALL: i32 = -4;

/// Install every `afterburner:host` function the plugin imports.
pub fn register(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    wrap_fs(linker)?;
    wrap_fs_chunks(linker)?;
    wrap_crypto(linker)?;
    wrap_crypto_ciphers(linker)?;
    wrap_crypto_kdfs(linker)?;
    wrap_crypto_signing(linker)?;
    wrap_crypto_signing_streaming(linker)?;
    wrap_crypto_hash_streaming(linker)?;
    wrap_os(linker)?;
    wrap_http(linker)?;
    wrap_dns(linker)?;
    wrap_zlib(linker)?;
    wrap_state(linker)?;
    wrap_host_context(linker)?;
    wrap_last_error(linker)?;
    wrap_input(linker)?;
    wrap_envelope(linker)?;
    wrap_http_server(linker)?;
    wrap_transpile(linker)?;
    wrap_shadow_bcrypt(linker)?;
    wrap_shadow_argon2(linker)?;
    wrap_process_exit(linker)?;
    wrap_timers(linker)?;
    Ok(())
}

// ---- fs ------------------------------------------------------------------

fn wrap_fs(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_fs_exists_sync",
            |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(p) => p,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                if fs_host::exists_sync(&path, &m) {
                    1
                } else {
                    0
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_read_file_sync",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    record(&mut caller, "memory export missing");
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(p) => p,
                    None => {
                        record(&mut caller, "invalid utf-8 in path");
                        return E_OTHER;
                    }
                };
                let m = caller.data().manifold.clone();
                match fs_host::read_file_sync(&path, &m) {
                    Ok(bytes) => write_out(&mut caller, &memory, out_ptr, out_cap, &bytes),
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_write_file_sync",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             data_ptr: i32,
             data_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(p) => p,
                    None => return E_OTHER,
                };
                let data = match read_bytes(&memory, &caller, data_ptr, data_len) {
                    Some(d) => d,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::write_file_sync(&path, &data, &m) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_stat_sync",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(p) => p,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::stat_sync(&path, &m) {
                    Ok(s) => {
                        let json = format!(
                            r#"{{"size":{},"isFile":{},"isDirectory":{},"mtimeMs":{}}}"#,
                            s.size, s.is_file, s.is_dir, s.mtime_ms
                        );
                        write_out(&mut caller, &memory, out_ptr, out_cap, json.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    // Unlink / rename / mkdir / readdir — parity with the native path.
    // Without these, `fs.createWriteStream(path, { flags: 'w' })` cannot
    // truncate existing content before rewriting.
    linker
        .func_wrap(
            NS,
            "host_fs_unlink_sync",
            |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::unlink_sync(&path, &m) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_rename_sync",
            |mut caller: Caller<'_, HostState>,
             from_ptr: i32,
             from_len: i32,
             to_ptr: i32,
             to_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let from = match read_str(&memory, &caller, from_ptr, from_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let to = match read_str(&memory, &caller, to_ptr, to_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::rename_sync(&from, &to, &m) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_mkdir_sync",
            |mut caller: Caller<'_, HostState>, ptr: i32, len: i32, recursive: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::mkdir_sync(&path, recursive != 0, &m) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_readdir_sync",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::readdir_sync(&path, &m) {
                    Ok(names) => {
                        let mut json = String::from("[");
                        for (i, name) in names.iter().enumerate() {
                            if i > 0 {
                                json.push(',');
                            }
                            json.push_str(&js_string_literal(name));
                        }
                        json.push(']');
                        write_out(&mut caller, &memory, out_ptr, out_cap, json.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- crypto --------------------------------------------------------------

fn wrap_crypto(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_crypto_hash",
            |mut caller: Caller<'_, HostState>,
             algo_ptr: i32,
             algo_len: i32,
             data_ptr: i32,
             data_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match read_bytes(&memory, &caller, data_ptr, data_len) {
                    Some(d) => d,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match crypto_host::hash(&algo, &data, &m) {
                    Ok(bytes) => {
                        // Return hex-encoded so the plugin can pass the
                        // string straight back to JS without another
                        // host round-trip.
                        let hex = hex::encode(&bytes);
                        write_out(&mut caller, &memory, out_ptr, out_cap, hex.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_random_bytes",
            |mut caller: Caller<'_, HostState>, len: u32, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let m = caller.data().manifold.clone();
                match crypto_host::random_bytes(len as usize, &m) {
                    Ok(bytes) => {
                        let hex = hex::encode(&bytes);
                        write_out(&mut caller, &memory, out_ptr, out_cap, hex.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- os ------------------------------------------------------------------

fn wrap_os(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_os_platform",
            |mut caller: Caller<'_, HostState>, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let s = os_host::platform();
                write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes())
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_os_arch",
            |mut caller: Caller<'_, HostState>, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let s = os_host::arch();
                write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes())
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- http ----------------------------------------------------------------

fn wrap_http(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_http_request",
            |mut caller: Caller<'_, HostState>,
             method_ptr: i32,
             method_len: i32,
             url_ptr: i32,
             url_len: i32,
             body_ptr: i32,
             body_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let method = match read_str(&memory, &caller, method_ptr, method_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let url = match read_str(&memory, &caller, url_ptr, url_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let body = if body_len > 0 {
                    match read_bytes(&memory, &caller, body_ptr, body_len) {
                        Some(b) => Some(b),
                        None => return E_OTHER,
                    }
                } else {
                    None
                };
                let m = caller.data().manifold.clone();
                match http_host::request(&method, &url, &[], body.as_deref(), &m) {
                    Ok(resp) => {
                        let body_text = String::from_utf8_lossy(&resp.body).into_owned();
                        let body_b64 = B64.encode(&resp.body);
                        let json = format!(
                            r#"{{"status":{},"body":{},"body_b64":{}}}"#,
                            resp.status,
                            js_string_literal(&body_text),
                            js_string_literal(&body_b64),
                        );
                        write_out(&mut caller, &memory, out_ptr, out_cap, json.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- dns -----------------------------------------------------------------

fn wrap_dns(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_dns_lookup",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let name = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match dns_host::lookup(&name, &m) {
                    Ok(addr) => write_out(&mut caller, &memory, out_ptr, out_cap, addr.as_bytes()),
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- chunked fs (stream support) -----------------------------------------

fn wrap_fs_chunks(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_fs_read_chunk",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             offset_lo: i32,
             offset_hi: i32,
             chunk_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let offset = ((offset_hi as u64) << 32) | (offset_lo as u32 as u64);
                let m = caller.data().manifold.clone();
                match fs_host::read_chunk(&path, offset, chunk_len as usize, &m) {
                    Ok(bytes) => {
                        let encoded = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &bytes,
                        );
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_write_chunk",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             offset_lo: i32,
             offset_hi: i32,
             data_ptr: i32,
             data_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match B64.decode(data_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let offset = ((offset_hi as u64) << 32) | (offset_lo as u32 as u64);
                let m = caller.data().manifold.clone();
                match fs_host::write_chunk(&path, offset, &data, &m) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_fs_size",
            |mut caller: Caller<'_, HostState>,
             ptr: i32,
             len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let path = match read_str(&memory, &caller, ptr, len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match fs_host::file_size(&path, &m) {
                    Ok(size) => {
                        let s = size.to_string();
                        write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- crypto ciphers + KDFs -----------------------------------------------

type GcmSig = (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32);
type CbcSig = (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32);

fn wrap_crypto_ciphers(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    for (name, encrypt) in [
        ("host_crypto_aes_gcm_encrypt", true),
        ("host_crypto_aes_gcm_decrypt", false),
    ] {
        linker
            .func_wrap(
                NS,
                name,
                move |mut caller: Caller<'_, HostState>,
                      algo_ptr: i32,
                      algo_len: i32,
                      key_ptr: i32,
                      key_len: i32,
                      nonce_ptr: i32,
                      nonce_len: i32,
                      data_ptr: i32,
                      data_len: i32,
                      aad_ptr: i32,
                      aad_len: i32,
                      out_ptr: i32,
                      out_cap: i32|
                      -> i32 {
                    let _ignore: GcmSig = (
                        algo_ptr, algo_len, key_ptr, key_len, nonce_ptr, nonce_len, data_ptr,
                        data_len, aad_ptr, aad_len, out_ptr, out_cap,
                    );
                    let Some(memory) = guest_memory(&mut caller) else {
                        return E_OTHER;
                    };
                    let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let key_b64 = match read_str(&memory, &caller, key_ptr, key_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let nonce_b64 = match read_str(&memory, &caller, nonce_ptr, nonce_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let aad_b64 = match read_str(&memory, &caller, aad_ptr, aad_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let key = match B64.decode(key_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let nonce = match B64.decode(nonce_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let data = match B64.decode(data_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let aad = match B64.decode(aad_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let m = caller.data().manifold.clone();
                    let res = if encrypt {
                        crypto_host::aes_gcm_encrypt(&algo, &key, &nonce, &data, &aad, &m)
                    } else {
                        crypto_host::aes_gcm_decrypt(&algo, &key, &nonce, &data, &aad, &m)
                    };
                    match res {
                        Ok(out) => {
                            let encoded = B64.encode(&out);
                            write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                        }
                        Err(e) => map_err(&mut caller, e),
                    }
                },
            )
            .map_err(link_err)?;
    }

    for (name, encrypt) in [
        ("host_crypto_aes_cbc_encrypt", true),
        ("host_crypto_aes_cbc_decrypt", false),
    ] {
        linker
            .func_wrap(
                NS,
                name,
                move |mut caller: Caller<'_, HostState>,
                      algo_ptr: i32,
                      algo_len: i32,
                      key_ptr: i32,
                      key_len: i32,
                      iv_ptr: i32,
                      iv_len: i32,
                      data_ptr: i32,
                      data_len: i32,
                      out_ptr: i32,
                      out_cap: i32|
                      -> i32 {
                    let _ignore: CbcSig = (
                        algo_ptr, algo_len, key_ptr, key_len, iv_ptr, iv_len, data_ptr, data_len,
                        out_ptr, out_cap,
                    );
                    let Some(memory) = guest_memory(&mut caller) else {
                        return E_OTHER;
                    };
                    let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let key_b64 = match read_str(&memory, &caller, key_ptr, key_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let iv_b64 = match read_str(&memory, &caller, iv_ptr, iv_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let key = match B64.decode(key_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let iv = match B64.decode(iv_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let data = match B64.decode(data_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(_) => return E_OTHER,
                    };
                    let m = caller.data().manifold.clone();
                    let res = if encrypt {
                        crypto_host::aes_cbc_encrypt(&algo, &key, &iv, &data, &m)
                    } else {
                        crypto_host::aes_cbc_decrypt(&algo, &key, &iv, &data, &m)
                    };
                    match res {
                        Ok(out) => {
                            let encoded = B64.encode(&out);
                            write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                        }
                        Err(e) => map_err(&mut caller, e),
                    }
                },
            )
            .map_err(link_err)?;
    }

    Ok(())
}

fn wrap_crypto_kdfs(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_crypto_pbkdf2_sync",
            |mut caller: Caller<'_, HostState>,
             digest_ptr: i32,
             digest_len: i32,
             password_ptr: i32,
             password_len: i32,
             salt_ptr: i32,
             salt_len: i32,
             iters: u32,
             key_len: u32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let digest = match read_str(&memory, &caller, digest_ptr, digest_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let password = match read_str(&memory, &caller, password_ptr, password_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let salt_b64 = match read_str(&memory, &caller, salt_ptr, salt_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let salt = match B64.decode(salt_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match crypto_host::pbkdf2_sync(
                    &digest,
                    password.as_bytes(),
                    &salt,
                    iters,
                    key_len as usize,
                    &m,
                ) {
                    Ok(bytes) => {
                        let encoded = B64.encode(&bytes);
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_scrypt_sync",
            |mut caller: Caller<'_, HostState>,
             password_ptr: i32,
             password_len: i32,
             salt_ptr: i32,
             salt_len: i32,
             n: u32,
             r: u32,
             p: u32,
             key_len: u32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let password = match read_str(&memory, &caller, password_ptr, password_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let salt_b64 = match read_str(&memory, &caller, salt_ptr, salt_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let salt = match B64.decode(salt_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match crypto_host::scrypt_sync(
                    password.as_bytes(),
                    &salt,
                    n,
                    r,
                    p,
                    key_len as usize,
                    &m,
                ) {
                    Ok(bytes) => {
                        let encoded = B64.encode(&bytes);
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- crypto signing (RSA + ECDSA) ---------------------------------------

fn wrap_crypto_signing(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_crypto_sign",
            |mut caller: Caller<'_, HostState>,
             algo_ptr: i32,
             algo_len: i32,
             key_ptr: i32,
             key_len: i32,
             data_ptr: i32,
             data_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let key_pem = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match B64.decode(data_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match crypto_host::sign(&algo, &key_pem, &data, &m) {
                    Ok(sig) => {
                        let encoded = B64.encode(&sig);
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_verify",
            |mut caller: Caller<'_, HostState>,
             algo_ptr: i32,
             algo_len: i32,
             key_ptr: i32,
             key_len: i32,
             data_ptr: i32,
             data_len: i32,
             sig_ptr: i32,
             sig_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let key_pem = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let sig_b64 = match read_str(&memory, &caller, sig_ptr, sig_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match B64.decode(data_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let sig = match B64.decode(sig_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let m = caller.data().manifold.clone();
                match crypto_host::verify(&algo, &key_pem, &data, &sig, &m) {
                    Ok(true) => 1,
                    Ok(false) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- streaming sign / verify --------------------------------------------

fn wrap_crypto_signing_streaming(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_crypto_sign_open",
            |mut caller: Caller<'_, HostState>, algo_ptr: i32, algo_len: i32| -> i64 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return 0;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return 0,
                };
                match caller.data().sign_handles.open(&algo) {
                    Ok(id) => id as i64,
                    Err(e) => {
                        record(&mut caller, &e.to_string());
                        0
                    }
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_sign_update",
            |mut caller: Caller<'_, HostState>, handle: i64, data_ptr: i32, data_len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match B64.decode(data_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                match caller.data().sign_handles.update(handle as u64, &data) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_sign_finalize",
            |mut caller: Caller<'_, HostState>,
             handle: i64,
             algo_ptr: i32,
             algo_len: i32,
             key_ptr: i32,
             key_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let key_pem = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let state = match caller.data().sign_handles.take(handle as u64) {
                    Ok(s) => s,
                    Err(e) => return map_err(&mut caller, e),
                };
                let m = caller.data().manifold.clone();
                match crypto_host::sign_finalize(&algo, &key_pem, state, &m) {
                    Ok(sig) => {
                        let encoded = B64.encode(&sig);
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_verify_finalize",
            |mut caller: Caller<'_, HostState>,
             handle: i64,
             algo_ptr: i32,
             algo_len: i32,
             key_ptr: i32,
             key_len: i32,
             sig_ptr: i32,
             sig_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let key_pem = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let sig_b64 = match read_str(&memory, &caller, sig_ptr, sig_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let sig = match B64.decode(sig_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                let state = match caller.data().sign_handles.take(handle as u64) {
                    Ok(s) => s,
                    Err(e) => return map_err(&mut caller, e),
                };
                let m = caller.data().manifold.clone();
                match crypto_host::verify_finalize(&algo, &key_pem, state, &sig, &m) {
                    Ok(true) => 1,
                    Ok(false) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;
    Ok(())
}

/// Streaming `createHash` / `createHmac`. `hash_open` is for plain
/// digests; `hmac_open` takes the key at open time (MAC is constructed
/// once — HMAC doesn't accept a key change mid-stream). Both share the
/// same handle id space, update, and finalize path.
fn wrap_crypto_hash_streaming(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_crypto_hash_open",
            |mut caller: Caller<'_, HostState>, algo_ptr: i32, algo_len: i32| -> i64 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return 0;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return 0,
                };
                if !caller.data().manifold.crypto {
                    record(&mut caller, "crypto.createHash: permission denied");
                    return 0;
                }
                match caller.data().hash_handles.open_digest(&algo) {
                    Ok(id) => id as i64,
                    Err(e) => {
                        record(&mut caller, &e.to_string());
                        0
                    }
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_hmac_open",
            |mut caller: Caller<'_, HostState>,
             algo_ptr: i32,
             algo_len: i32,
             key_ptr: i32,
             key_len: i32|
             -> i64 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return 0;
                };
                let algo = match read_str(&memory, &caller, algo_ptr, algo_len) {
                    Some(s) => s,
                    None => return 0,
                };
                let key_b64 = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return 0,
                };
                let key = match B64.decode(key_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => {
                        record(&mut caller, "hmac key: invalid base64");
                        return 0;
                    }
                };
                if !caller.data().manifold.crypto {
                    record(&mut caller, "crypto.createHmac: permission denied");
                    return 0;
                }
                match caller.data().hash_handles.open_hmac(&algo, &key) {
                    Ok(id) => id as i64,
                    Err(e) => {
                        record(&mut caller, &e.to_string());
                        0
                    }
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_hash_update",
            |mut caller: Caller<'_, HostState>, handle: i64, data_ptr: i32, data_len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let data_b64 = match read_str(&memory, &caller, data_ptr, data_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let data = match B64.decode(data_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                match caller.data().hash_handles.update(handle as u64, &data) {
                    Ok(()) => 0,
                    Err(e) => map_err(&mut caller, e),
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_crypto_hash_digest",
            |mut caller: Caller<'_, HostState>,
             handle: i64,
             enc_ptr: i32,
             enc_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                // Empty encoding means default — hex. Matches the
                // one-shot host_crypto_hash which always emits hex.
                let enc = if enc_len == 0 {
                    "hex".to_string()
                } else {
                    match read_str(&memory, &caller, enc_ptr, enc_len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    }
                };
                let bytes = match caller.data().hash_handles.finalize(handle as u64) {
                    Ok(b) => b,
                    Err(e) => return map_err(&mut caller, e),
                };
                let encoded: String = match enc.as_str() {
                    "hex" => hex::encode(&bytes),
                    "base64" => B64.encode(&bytes),
                    "binary" | "latin1" => bytes.iter().map(|b| *b as char).collect(),
                    // Parity with the native path's `encode_bytes`. Without
                    // this arm, `crypto.createHash('sha256').digest('utf8')`
                    // works on native but errors on WASM — a silent
                    // cross-engine divergence we don't want to ship.
                    "utf8" | "utf-8" => String::from_utf8_lossy(&bytes).into_owned(),
                    other => {
                        record(
                            &mut caller,
                            &format!("hash.digest: unsupported encoding '{other}'"),
                        );
                        return E_OTHER;
                    }
                };
                write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- state store --------------------------------------------------------

fn wrap_state(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_state_get",
            |mut caller: Caller<'_, HostState>,
             key_ptr: i32,
             key_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let key = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let store = caller.data().state_store.clone();
                match store.get(&key) {
                    Some(bytes) => {
                        let encoded = B64.encode(&bytes);
                        write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                    }
                    None => -2, // NotFound — JS glue maps to undefined.
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_state_set",
            |mut caller: Caller<'_, HostState>,
             key_ptr: i32,
             key_len: i32,
             value_ptr: i32,
             value_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let key = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let value_b64 = match read_str(&memory, &caller, value_ptr, value_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let value = match B64.decode(value_b64.as_bytes()) {
                    Ok(v) => v,
                    Err(_) => return E_OTHER,
                };
                caller.data().state_store.set(&key, value);
                0
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_state_delete",
            |mut caller: Caller<'_, HostState>, key_ptr: i32, key_len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let key = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                caller.data().state_store.delete(&key);
                0
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_state_increment",
            |mut caller: Caller<'_, HostState>, key_ptr: i32, key_len: i32, delta: i64| -> i64 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return 0;
                };
                let key = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return 0,
                };
                caller.data().state_store.increment_i64(&key, delta)
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- zlib (no manifold gate) ---------------------------------------------

fn wrap_zlib(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    for (name, op) in [
        ("host_zlib_deflate_sync", ZlibOp::Deflate),
        ("host_zlib_inflate_sync", ZlibOp::Inflate),
        ("host_zlib_gzip_sync", ZlibOp::Gzip),
        ("host_zlib_gunzip_sync", ZlibOp::Gunzip),
    ] {
        linker
            .func_wrap(
                NS,
                name,
                move |mut caller: Caller<'_, HostState>,
                      ptr: i32,
                      len: i32,
                      out_ptr: i32,
                      out_cap: i32|
                      -> i32 {
                    let Some(memory) = guest_memory(&mut caller) else {
                        return E_OTHER;
                    };
                    // Bytes come in as a base64 string — matches the
                    // native path wire format.
                    let input_b64 = match read_str(&memory, &caller, ptr, len) {
                        Some(s) => s,
                        None => return E_OTHER,
                    };
                    let input = match B64.decode(input_b64.as_bytes()) {
                        Ok(v) => v,
                        Err(e) => {
                            record(&mut caller, &format!("base64 decode: {e}"));
                            return E_OTHER;
                        }
                    };
                    let result = match op {
                        ZlibOp::Deflate => zlib_host::deflate_sync(&input),
                        ZlibOp::Inflate => zlib_host::inflate_sync(&input),
                        ZlibOp::Gzip => zlib_host::gzip_sync(&input),
                        ZlibOp::Gunzip => zlib_host::gunzip_sync(&input),
                    };
                    match result {
                        Ok(bytes) => {
                            let encoded = B64.encode(&bytes);
                            write_out(&mut caller, &memory, out_ptr, out_cap, encoded.as_bytes())
                        }
                        Err(e) => map_err(&mut caller, e),
                    }
                },
            )
            .map_err(link_err)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ZlibOp {
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
}

// ---- host context (ScramDB-facing) ---------------------------------------

fn wrap_host_context(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    // __host_read_column(name) -> JSON-serialized Vec<Value> (string).
    linker
        .func_wrap(
            NS,
            "host_read_column",
            |mut caller: Caller<'_, HostState>,
             name_ptr: i32,
             name_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let name = match read_str(&memory, &caller, name_ptr, name_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let rows = match caller.data().host_context.as_ref() {
                    Some(ctx) => ctx.read_column(&name),
                    None => Vec::new(),
                };
                let json = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                write_out(&mut caller, &memory, out_ptr, out_cap, json.as_bytes())
            },
        )
        .map_err(link_err)?;

    // __host_emit_row(row_json) -> 0 on success.
    linker
        .func_wrap(
            NS,
            "host_emit_row",
            |mut caller: Caller<'_, HostState>, row_ptr: i32, row_len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let row_json = match read_str(&memory, &caller, row_ptr, row_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let row: serde_json::Value = match serde_json::from_str(&row_json) {
                    Ok(v) => v,
                    Err(e) => {
                        record(&mut caller, &format!("emit_row: {e}"));
                        return E_OTHER;
                    }
                };
                if let Some(ctx) = caller.data().host_context.as_ref() {
                    ctx.emit_row(row);
                }
                0
            },
        )
        .map_err(link_err)?;

    // __host_get_env(key) -> option<string>. Empty means None.
    linker
        .func_wrap(
            NS,
            "host_get_env",
            |mut caller: Caller<'_, HostState>,
             key_ptr: i32,
             key_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let key = match read_str(&memory, &caller, key_ptr, key_len) {
                    Some(s) => s,
                    None => return E_OTHER,
                };
                let val = caller
                    .data()
                    .host_context
                    .as_ref()
                    .and_then(|ctx| ctx.get_env(&key));
                match val {
                    Some(v) => write_out(&mut caller, &memory, out_ptr, out_cap, v.as_bytes()),
                    None => E_NOT_FOUND,
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- last_error slot -----------------------------------------------------

fn wrap_last_error(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_last_error",
            |mut caller: Caller<'_, HostState>, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let msg = caller.data().last_error.clone();
                write_out(&mut caller, &memory, out_ptr, out_cap, msg.as_bytes())
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- input slot (bytecode-cache invoke path) ----------------------------
//
// The plugin's bytecode-cache `invoke` mode reads the per-thrust input
// JSON from `HostState::pending_input` via this import — which lets us
// skip the per-thrust preamble compile that would otherwise publish
// the input as a JS global. The cached wrapped source calls
// `__AB_GET_INPUT__()` (installed in `modify_runtime`) which routes
// here.
fn wrap_input(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_get_input",
            |mut caller: Caller<'_, HostState>, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                // Clone is required because `write_out` borrows the
                // store mutably for the memory write; we can't hold a
                // shared borrow on `pending_input` simultaneously.
                let input = caller.data().pending_input.clone();
                write_out(&mut caller, &memory, out_ptr, out_cap, &input)
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- daemon envelope slot (long-lived-Store re-entry) -------------------
//
// Mirrors `wrap_input` but routes to `HostState::pending_envelope`.
// Daemon mode's `daemon_step` export reads each step's envelope via
// this import rather than stdin, because WASI preview1 has no way
// to reset stdin between calls.
fn wrap_envelope(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_get_envelope",
            |mut caller: Caller<'_, HostState>, out_ptr: i32, out_cap: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let env = caller.data().pending_envelope.clone();
                write_out(&mut caller, &memory, out_ptr, out_cap, &env)
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- http server (daemon mode) ------------------------------------------
//
// `host_http_listen` calls into `DaemonHttp::bind_listener` which —
// under the `daemon` feature — binds a real TCP socket and spawns an
// axum task on the stored tokio runtime. Without the feature it
// degrades to an accounting-only stub, matching pre-B2.4 behaviour.
//
// `host_http_reply` parses the JSON payload the JS polyfill handed
// back from `res.end(body)` and forwards it through
// `DaemonHttp::deliver_reply`, waking the per-request reply channel
// the axum task is awaiting.
fn wrap_http_server(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_http_listen",
            |mut caller: Caller<'_, HostState>, port: i32| -> i32 {
                let Some(dh) = caller.data().daemon_http.clone() else {
                    caller.data_mut().last_error =
                        "http.createServer requires daemon mode; run via `burn foo.js` CLI".into();
                    return E_PERMISSION;
                };
                if !(1..=65535).contains(&port) {
                    caller.data_mut().last_error = format!("http.listen: invalid port {port}");
                    return E_OTHER;
                }
                dh.bind_listener(port as u16)
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_http_reply",
            |mut caller: Caller<'_, HostState>, req_id: i64, resp_ptr: i32, resp_len: i32| -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(dh) = caller.data().daemon_http.clone() else {
                    return E_OTHER;
                };
                let Some(bytes) = read_bytes(&memory, &caller, resp_ptr, resp_len) else {
                    return E_OTHER;
                };
                let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(e) => {
                        caller.data_mut().last_error = format!("http_reply json: {e}");
                        return E_OTHER;
                    }
                };
                let status = parsed.get("status").and_then(|v| v.as_u64()).unwrap_or(500) as u16;
                let headers: Vec<(String, String)> = parsed
                    .get("headers")
                    .and_then(|v| v.as_object())
                    .map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();
                let body = parsed
                    .get("body")
                    .and_then(|v| v.as_str())
                    .map(|s| s.as_bytes().to_vec())
                    .unwrap_or_default();
                let reply = crate::daemon_http::ReplyEnvelope {
                    status,
                    headers,
                    body,
                };
                dh.deliver_reply(req_id, reply);
                0
            },
        )
        .map_err(link_err)?;

    // B2b: `server.close()` in JS → `__host_http_close(server_id)`
    // here. Aborts the axum listener task and releases the port so a
    // subsequent `.listen(port)` in the same process succeeds. Idempotent
    // (second call on the same id is a no-op).
    linker
        .func_wrap(
            NS,
            "host_http_close",
            |caller: Caller<'_, HostState>, server_id: i32| -> i32 {
                let Some(dh) = caller.data().daemon_http.clone() else {
                    return 0;
                };
                if dh.close_listener(server_id) { 1 } else { 0 }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- L3 shadows --------------------------------------------------------
//
// Plugin always ships the `__host_shadow_bcrypt_*` imports; without
// the `shadow-bcrypt` feature they return `-1` and set `last_error`
// to "shadow-bcrypt not enabled". The JS-side polyfill surfaces that
// to users as a clean "enable the feature" error rather than a WASM
// instantiation failure.

fn wrap_shadow_bcrypt(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_shadow_bcrypt_hash",
            |mut caller: Caller<'_, HostState>,
             pw_ptr: i32,
             pw_len: i32,
             cost: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(pw_bytes) = read_bytes(&memory, &caller, pw_ptr, pw_len) else {
                    return E_OTHER;
                };
                let password = match std::str::from_utf8(&pw_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                #[cfg(feature = "shadow-bcrypt")]
                {
                    let cost_u = if cost <= 0 { 0 } else { cost as u32 };
                    match afterburner_node_compat::shadows::bcrypt::hash(password, cost_u) {
                        Ok(s) => write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes()),
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-bcrypt"))]
                {
                    let _ = (password, cost, out_ptr, out_cap);
                    caller.data_mut().last_error =
                        "shadow-bcrypt feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_shadow_bcrypt_verify",
            |mut caller: Caller<'_, HostState>,
             pw_ptr: i32,
             pw_len: i32,
             h_ptr: i32,
             h_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(pw_bytes) = read_bytes(&memory, &caller, pw_ptr, pw_len) else {
                    return E_OTHER;
                };
                let Some(h_bytes) = read_bytes(&memory, &caller, h_ptr, h_len) else {
                    return E_OTHER;
                };
                let password = match std::str::from_utf8(&pw_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                let hash = match std::str::from_utf8(&h_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                #[cfg(feature = "shadow-bcrypt")]
                {
                    match afterburner_node_compat::shadows::bcrypt::verify(password, hash) {
                        Ok(true) => 1,
                        Ok(false) => 0,
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-bcrypt"))]
                {
                    let _ = (password, hash);
                    caller.data_mut().last_error =
                        "shadow-bcrypt feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_shadow_bcrypt_gen_salt",
            |mut caller: Caller<'_, HostState>,
             rounds: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                #[cfg(feature = "shadow-bcrypt")]
                {
                    let Some(memory) = guest_memory(&mut caller) else {
                        return E_OTHER;
                    };
                    let cost_u = if rounds <= 0 { 0 } else { rounds as u32 };
                    match afterburner_node_compat::shadows::bcrypt::gen_salt(cost_u) {
                        Ok(s) => write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes()),
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-bcrypt"))]
                {
                    let _ = (rounds, out_ptr, out_cap);
                    caller.data_mut().last_error =
                        "shadow-bcrypt feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- L3 shadow: argon2 -------------------------------------------------

fn wrap_shadow_argon2(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_shadow_argon2_hash",
            |mut caller: Caller<'_, HostState>,
             pw_ptr: i32,
             pw_len: i32,
             ty: i32,
             time_cost: i32,
             memory_cost: i32,
             parallelism: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(pw_bytes) = read_bytes(&memory, &caller, pw_ptr, pw_len) else {
                    return E_OTHER;
                };
                let password = match std::str::from_utf8(&pw_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                #[cfg(feature = "shadow-argon2")]
                {
                    let ty_u = if ty < 0 { 2 } else { ty as u8 };
                    let t_u = if time_cost < 0 { 0 } else { time_cost as u32 };
                    let m_u = if memory_cost < 0 { 0 } else { memory_cost as u32 };
                    let p_u = if parallelism < 0 { 0 } else { parallelism as u32 };
                    match afterburner_node_compat::shadows::argon2::hash(
                        password, ty_u, t_u, m_u, p_u,
                    ) {
                        Ok(s) => write_out(&mut caller, &memory, out_ptr, out_cap, s.as_bytes()),
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-argon2"))]
                {
                    let _ = (password, ty, time_cost, memory_cost, parallelism, out_ptr, out_cap);
                    caller.data_mut().last_error =
                        "shadow-argon2 feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_shadow_argon2_verify",
            |mut caller: Caller<'_, HostState>,
             h_ptr: i32,
             h_len: i32,
             pw_ptr: i32,
             pw_len: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(h_bytes) = read_bytes(&memory, &caller, h_ptr, h_len) else {
                    return E_OTHER;
                };
                let Some(pw_bytes) = read_bytes(&memory, &caller, pw_ptr, pw_len) else {
                    return E_OTHER;
                };
                let hash = match std::str::from_utf8(&h_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                let password = match std::str::from_utf8(&pw_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                #[cfg(feature = "shadow-argon2")]
                {
                    match afterburner_node_compat::shadows::argon2::verify(hash, password) {
                        Ok(true) => 1,
                        Ok(false) => 0,
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-argon2"))]
                {
                    let _ = (hash, password);
                    caller.data_mut().last_error =
                        "shadow-argon2 feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_shadow_argon2_needs_rehash",
            |mut caller: Caller<'_, HostState>,
             h_ptr: i32,
             h_len: i32,
             ty: i32,
             time_cost: i32,
             memory_cost: i32,
             parallelism: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(h_bytes) = read_bytes(&memory, &caller, h_ptr, h_len) else {
                    return E_OTHER;
                };
                let hash = match std::str::from_utf8(&h_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                #[cfg(feature = "shadow-argon2")]
                {
                    let ty_u = if ty < 0 { 2 } else { ty as u8 };
                    let t_u = if time_cost < 0 { 0 } else { time_cost as u32 };
                    let m_u = if memory_cost < 0 { 0 } else { memory_cost as u32 };
                    let p_u = if parallelism < 0 { 0 } else { parallelism as u32 };
                    match afterburner_node_compat::shadows::argon2::needs_rehash(
                        hash, ty_u, t_u, m_u, p_u,
                    ) {
                        Ok(true) => 1,
                        Ok(false) => 0,
                        Err(e) => {
                            caller.data_mut().last_error = e;
                            -1
                        }
                    }
                }
                #[cfg(not(feature = "shadow-argon2"))]
                {
                    let _ = (hash, ty, time_cost, memory_cost, parallelism);
                    caller.data_mut().last_error =
                        "shadow-argon2 feature not enabled".into();
                    -1
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- transpile hook (B8+B9) ---------------------------------------------
//
// `host_ts_transpile(src_ptr, src_len, path_ptr, path_len, out_ptr,
// out_cap) -> i32` invokes the `transpile_hook` stored on HostState
// (wired by the CLI when built with the `ts` feature). Returns the
// number of bytes written into the output buffer, or a negative
// error code if the hook is absent or transpile failed.
//
// Convention: positive = bytes written; 0 = hook returned empty
// string (legitimate); -1 = no hook; -2 = guest buffer too small;
// -3 = transpile error (detail via `host_last_error`).

fn wrap_transpile(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_ts_transpile",
            |mut caller: Caller<'_, HostState>,
             src_ptr: i32,
             src_len: i32,
             path_ptr: i32,
             path_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
                let Some(memory) = guest_memory(&mut caller) else {
                    return E_OTHER;
                };
                let Some(src_bytes) = read_bytes(&memory, &caller, src_ptr, src_len) else {
                    return E_OTHER;
                };
                let Some(path_bytes) = read_bytes(&memory, &caller, path_ptr, path_len) else {
                    return E_OTHER;
                };
                let src = match std::str::from_utf8(&src_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                let path = match std::str::from_utf8(&path_bytes) {
                    Ok(s) => s,
                    Err(_) => return E_OTHER,
                };
                let Some(hook) = caller.data().transpile_hook.clone() else {
                    // No hook registered — caller should fall back to
                    // loading the raw source. `-1` signals "no hook".
                    return -1;
                };
                let transpiled = match hook(src, path) {
                    Ok(s) => s,
                    Err(e) => {
                        caller.data_mut().last_error = format!("ts_transpile: {e}");
                        return -3;
                    }
                };
                let bytes = transpiled.into_bytes();
                write_out(&mut caller, &memory, out_ptr, out_cap, &bytes)
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- process.exit (B3) --------------------------------------------------
//
// `host_process_exit(code)` never returns — the host traps with
// `I32Exit(code)`, which Wasmtime surfaces as an anyhow::Error that
// `map_daemon_trap` converts to `AfterburnerError::ProcessExit(code)`.

fn wrap_process_exit(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_process_exit",
            |_caller: Caller<'_, HostState>, code: i32| -> anyhow::Result<()> {
                Err(I32Exit(code).into())
            },
        )
        .map_err(link_err)?;
    Ok(())
}

// ---- timers (daemon mode B3) --------------------------------------------

fn wrap_timers(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    linker
        .func_wrap(
            NS,
            "host_timer_set",
            |mut caller: Caller<'_, HostState>, delay_ms: i32, repeat: i32| -> i32 {
                // Timers are only supported in daemon mode. In UDF /
                // one-shot script mode `daemon_http` is None and we
                // return -1 so the JS polyfill surfaces a clear error.
                if caller.data().daemon_http.is_none() {
                    return -1;
                }
                let delay = if delay_ms > 0 {
                    delay_ms as u64
                } else {
                    // Node treats delay <= 0 as 1 for setInterval,
                    // and 0 as immediate for setTimeout. Use 1ms floor.
                    1
                };
                let state = caller.data_mut();
                let id = state.next_timer_id;
                state.next_timer_id += 1;
                state.timers.push(TimerSlot {
                    id,
                    fire_at: Instant::now() + Duration::from_millis(delay),
                    interval_ms: if repeat != 0 { Some(delay) } else { None },
                    is_ref: true,
                });
                id
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_timer_clear",
            |mut caller: Caller<'_, HostState>, timer_id: i32| {
                caller.data_mut().timers.retain(|t| t.id != timer_id);
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_timer_unref",
            |mut caller: Caller<'_, HostState>, timer_id: i32| {
                if let Some(t) = caller
                    .data_mut()
                    .timers
                    .iter_mut()
                    .find(|t| t.id == timer_id)
                {
                    t.is_ref = false;
                }
            },
        )
        .map_err(link_err)?;

    linker
        .func_wrap(
            NS,
            "host_timer_ref",
            |mut caller: Caller<'_, HostState>, timer_id: i32| {
                if let Some(t) = caller
                    .data_mut()
                    .timers
                    .iter_mut()
                    .find(|t| t.id == timer_id)
                {
                    t.is_ref = true;
                }
            },
        )
        .map_err(link_err)?;

    Ok(())
}

// ---- helpers -------------------------------------------------------------

fn guest_memory(caller: &mut Caller<'_, HostState>) -> Option<Memory> {
    caller.get_export("memory").and_then(|e| e.into_memory())
}

fn read_str(memory: &Memory, caller: &Caller<'_, HostState>, ptr: i32, len: i32) -> Option<String> {
    let data = memory.data(caller);
    let slice = data.get((ptr as usize)..((ptr + len) as usize))?;
    std::str::from_utf8(slice).ok().map(String::from)
}

fn read_bytes(
    memory: &Memory,
    caller: &Caller<'_, HostState>,
    ptr: i32,
    len: i32,
) -> Option<Vec<u8>> {
    let data = memory.data(caller);
    data.get((ptr as usize)..((ptr + len) as usize))
        .map(|s| s.to_vec())
}

fn write_out(
    caller: &mut Caller<'_, HostState>,
    memory: &Memory,
    out_ptr: i32,
    out_cap: i32,
    data: &[u8],
) -> i32 {
    if data.len() > out_cap as usize {
        record(caller, &format!("output {} > cap {}", data.len(), out_cap));
        return E_BUF_TOO_SMALL;
    }
    let start = out_ptr as usize;
    let end = start + data.len();
    let mem = memory.data_mut(caller);
    match mem.get_mut(start..end) {
        Some(slot) => {
            slot.copy_from_slice(data);
            data.len() as i32
        }
        None => {
            // Can't write last_error here — we already hold a &mut into
            // linear memory; borrow checker would reject touching
            // caller.data_mut(). The raw code at least makes the
            // failure deterministic (E_OTHER with no message).
            E_OTHER
        }
    }
}

fn map_err(caller: &mut Caller<'_, HostState>, err: AfterburnerError) -> i32 {
    let code = match &err {
        AfterburnerError::PermissionDenied(_) => E_PERMISSION,
        AfterburnerError::Host(msg) if msg.to_lowercase().contains("not found") => E_NOT_FOUND,
        _ => E_OTHER,
    };
    record(caller, &err.to_string());
    code
}

fn record(caller: &mut Caller<'_, HostState>, msg: &str) {
    caller.data_mut().last_error = msg.to_string();
}

fn link_err(e: anyhow::Error) -> AfterburnerError {
    AfterburnerError::Engine(format!("linker.func_wrap: {e}"))
}

/// JSON string literal escaping — used for embedding HTTP response
/// bodies inside a JSON result returned to the guest.
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

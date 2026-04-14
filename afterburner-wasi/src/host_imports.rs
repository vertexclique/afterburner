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

use crate::host::HostState;
use afterburner_core::AfterburnerError;
use afterburner_node_compat::{crypto_host, dns_host, fs_host, http_host, os_host, zlib_host};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use wasmtime::{Caller, Linker, Memory};

const NS: &str = "afterburner:host";

const E_PERMISSION: i32 = -1;
const E_NOT_FOUND: i32 = -2;
const E_OTHER: i32 = -3;
const E_BUF_TOO_SMALL: i32 = -4;

/// Install every `afterburner:host` function the plugin imports.
pub fn register(linker: &mut Linker<HostState>) -> Result<(), AfterburnerError> {
    wrap_fs(linker)?;
    wrap_crypto(linker)?;
    wrap_os(linker)?;
    wrap_http(linker)?;
    wrap_dns(linker)?;
    wrap_zlib(linker)?;
    wrap_last_error(linker)?;
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
                if fs_host::exists_sync(&path, &m) { 1 } else { 0 }
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
            |mut caller: Caller<'_, HostState>,
             len: u32,
             out_ptr: i32,
             out_cap: i32|
             -> i32 {
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
                        let json = format!(
                            r#"{{"status":{},"body":{}}}"#,
                            resp.status,
                            js_string_literal(&body_text)
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

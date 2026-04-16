//! Grab-bag globals: `os`, `http`, `dns`, `zlib`, host-context hooks
//! (`readColumn` / `emitRow` / `getEnv`), the state store, the
//! per-thrust input bridge (`__AB_GET_INPUT__`), and the error-message
//! bridge (`__host_last_error`).

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use javy_plugin_api::javy::quickjs::{Object, prelude::Func};

use super::call_read;
use crate::host_api::*;

pub fn install<'js>(globals: &Object<'js>) {
    install_diagnostics(globals);
    install_os(globals);
    install_http_dns(globals);
    install_zlib(globals);
    install_hostctx(globals);
    install_state(globals);
}

fn install_diagnostics<'js>(globals: &Object<'js>) {
    // Expose the host's `last_error` slot as a JS-callable global.
    // Useful when a host call returns a sentinel (0 handle, -N code)
    // and the polyfill needs the detailed message — e.g. to distinguish
    // "permission denied" from "algorithm not supported" on a failed
    // `createHash` open.
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

    // Bytecode-cache invoke path: pulls the per-thrust input JSON bytes
    // from `HostState::pending_input`. The cached wrapped source calls
    // this at the top of every invocation, replacing what would
    // otherwise be a per-thrust preamble compile.
    let _ = globals.set(
        "__AB_GET_INPUT__",
        Func::from(|| -> String {
            // 64 KiB initial buffer covers the vast majority of typical
            // UDF inputs in one call. The host returns
            // `E_BUF_TOO_SMALL = -4` if more is needed; we retry
            // doubling.
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = unsafe { host_get_input(buf.as_mut_ptr(), buf.len() as u32) };
                if n >= 0 {
                    buf.truncate(n as usize);
                    return String::from_utf8_lossy(&buf).into_owned();
                }
                if n == -4 {
                    // BufTooSmall — double and retry.
                    let new_cap = buf.len().saturating_mul(2);
                    buf.resize(new_cap, 0);
                    continue;
                }
                // Any other error → empty input. Caller's JSON.parse
                // will surface the failure clearly.
                return String::new();
            }
        }),
    );
}

fn install_os<'js>(globals: &Object<'js>) {
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
}

fn install_http_dns<'js>(globals: &Object<'js>) {
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
}

fn install_zlib<'js>(globals: &Object<'js>) {
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
}

fn install_hostctx<'js>(globals: &Object<'js>) {
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
            call_read(|out, cap| unsafe {
                host_get_env(kb.as_ptr(), kb.len() as u32, out, cap)
            })
            .ok()
        }),
    );
}

fn install_state<'js>(globals: &Object<'js>) {
    // State store (afterburner:state). `call_read` returns `Err` on `-2
    // NotFound` (or any other negative code); mapping to None here
    // surfaces the absence as JS `undefined`.
    let _ = globals.set(
        "__host_state_get",
        Func::from(|key: String| -> Option<String> {
            let kb = key.as_bytes();
            call_read(|out, cap| unsafe {
                host_state_get(kb.as_ptr(), kb.len() as u32, out, cap)
            })
            .ok()
        }),
    );

    let _ = globals.set(
        "__host_state_set",
        Func::from(|key: String, value_b64: String| -> i32 {
            let kb = key.as_bytes();
            let vb = value_b64.as_bytes();
            unsafe { host_state_set(kb.as_ptr(), kb.len() as u32, vb.as_ptr(), vb.len() as u32) }
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
}

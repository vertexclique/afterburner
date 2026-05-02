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

    // Daemon-mode envelope getter. Same shape as __AB_GET_INPUT__ but
    // routes to `HostState::pending_envelope` — the long-lived Store
    // re-entry channel. Plugin's `daemon_step` export calls this at
    // the top of every dispatch.
    let _ = globals.set(
        "__AB_GET_ENVELOPE__",
        Func::from(|| -> String {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = unsafe { host_get_envelope(buf.as_mut_ptr(), buf.len() as u32) };
                if n >= 0 {
                    buf.truncate(n as usize);
                    return String::from_utf8_lossy(&buf).into_owned();
                }
                if n == -4 {
                    let new_cap = buf.len().saturating_mul(2);
                    buf.resize(new_cap, 0);
                    continue;
                }
                return String::new();
            }
        }),
    );

    // HTTP-server host imports. JS polyfill calls these from
    // `http.createServer().listen(...)` and the `ServerResponse.end()`
    // path. `f64` across the ABI boundary is the JS-number → i64
    // bridge (rquickjs exposes integers through f64 for portability).
    let _ = globals.set(
        "__host_http_listen",
        Func::from(|port: f64| -> f64 { unsafe { host_http_listen(port as u32) as f64 } }),
    );
    let _ = globals.set(
        "__host_http_reply",
        Func::from(|req_id: f64, resp_json: String| -> i32 {
            let b = resp_json.as_bytes();
            unsafe { host_http_reply(req_id as i64, b.as_ptr(), b.len() as u32) }
        }),
    );
    // B2b: server.close() — releases the port + aborts the axum task.
    let _ = globals.set(
        "__host_http_close",
        Func::from(|server_id: f64| -> f64 {
            unsafe { host_http_close(server_id as i32) as f64 }
        }),
    );

    // B8/B9: require() calls this for TS / ESM files. Returns the
    // transpiled JS string, or a host-error-prefixed string if the
    // transpile hook is absent / failed.
    let _ = globals.set(
        "__host_ts_transpile",
        Func::from(|source: String, path: String| -> String {
            let src_bytes = source.as_bytes();
            let path_bytes = path.as_bytes();
            // Generous cap — transpile output is usually under 4x
            // input for common TS+ESM code. If it exceeds the
            // buffer the import returns -2 and we surface the error.
            let cap: u32 = core::cmp::max(src_bytes.len() * 4, 16 * 1024) as u32;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_ts_transpile(
                    src_bytes.as_ptr(),
                    src_bytes.len() as u32,
                    path_bytes.as_ptr(),
                    path_bytes.len() as u32,
                    buf.as_mut_ptr(),
                    cap,
                )
            };
            if n < 0 {
                // Surface the structured error string the JS side
                // already looks for (`__HOST_ERR__:` prefix lets the
                // require resolver convert to a typed Error).
                let detail = match n {
                    -1 => alloc::string::String::from("no transpile hook (build with `ts` feature)"),
                    -2 => alloc::string::String::from("transpile output too large for guest buffer"),
                    _ => {
                        let mut err_buf = alloc::vec![0u8; 2048];
                        let err_n = unsafe {
                            host_last_error(err_buf.as_mut_ptr(), err_buf.len() as u32)
                        };
                        if err_n > 0 {
                            String::from_utf8(err_buf[..err_n as usize].to_vec())
                                .unwrap_or_else(|_| alloc::string::String::from("transpile error"))
                        } else {
                            alloc::string::String::from("transpile error")
                        }
                    }
                };
                return alloc::format!("__HOST_ERR__:{detail}");
            }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:transpile output not utf-8"),
            }
        }),
    );

    // ---- L3 shadow: bcrypt -------------------------------------------
    //
    // Reads `host_last_error` off the host and returns it with the
    // `__HOST_ERR__:` prefix the require resolver / shadow polyfill
    // both look for. Fallback message used when the host didn't set
    // anything (should never happen in practice).
    fn host_err_or_default(fallback: &str) -> alloc::string::String {
        let mut buf = alloc::vec![0u8; 2048];
        let n = unsafe { host_last_error(buf.as_mut_ptr(), buf.len() as u32) };
        let detail = if n > 0 {
            alloc::string::String::from_utf8(buf[..n as usize].to_vec())
                .unwrap_or_else(|_| fallback.into())
        } else {
            fallback.into()
        };
        alloc::format!("__HOST_ERR__:{detail}")
    }

    //
    // Always-present globals that dispatch through the host's
    // shadow-bcrypt import. The imports themselves return -1 with a
    // structured error when the host wasn't built with the feature.
    let _ = globals.set(
        "__host_shadow_bcrypt_hash",
        Func::from(|password: String, cost: f64| -> String {
            let pw = password.as_bytes();
            let cap: u32 = 128;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_shadow_bcrypt_hash(
                    pw.as_ptr(),
                    pw.len() as u32,
                    cost as i32,
                    buf.as_mut_ptr(),
                    cap,
                )
            };
            if n < 0 {
                return host_err_or_default("bcrypt hash failed");
            }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:bcrypt hash output not utf-8"),
            }
        }),
    );
    let _ = globals.set(
        "__host_shadow_bcrypt_verify",
        Func::from(|password: String, hash: String| -> f64 {
            let pw = password.as_bytes();
            let h = hash.as_bytes();
            let n = unsafe {
                host_shadow_bcrypt_verify(
                    pw.as_ptr(),
                    pw.len() as u32,
                    h.as_ptr(),
                    h.len() as u32,
                )
            };
            // `-1`/`0`/`1` preserved across the f64 bridge; JS side
            // branches on the value.
            n as f64
        }),
    );
    let _ = globals.set(
        "__host_shadow_bcrypt_gen_salt",
        Func::from(|rounds: f64| -> String {
            let cap: u32 = 64;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_shadow_bcrypt_gen_salt(rounds as i32, buf.as_mut_ptr(), cap)
            };
            if n < 0 {
                return host_err_or_default("bcrypt gen_salt failed");
            }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:bcrypt gen_salt not utf-8"),
            }
        }),
    );

    // ---- L3 shadow: argon2 ------------------------------------------
    //
    // PHC-formatted output can be ~160 bytes for default params
    // (m=65536, t=3, p=4) + salt + hash; 256 is plenty.
    let _ = globals.set(
        "__host_shadow_argon2_hash",
        Func::from(
            |password: String,
             ty: f64,
             time_cost: f64,
             memory_cost: f64,
             parallelism: f64|
             -> String {
                let pw = password.as_bytes();
                let cap: u32 = 256;
                let mut buf = alloc::vec![0u8; cap as usize];
                let n = unsafe {
                    host_shadow_argon2_hash(
                        pw.as_ptr(),
                        pw.len() as u32,
                        ty as i32,
                        time_cost as i32,
                        memory_cost as i32,
                        parallelism as i32,
                        buf.as_mut_ptr(),
                        cap,
                    )
                };
                if n < 0 {
                    return host_err_or_default("argon2 hash failed");
                }
                match String::from_utf8(buf[..n as usize].to_vec()) {
                    Ok(s) => s,
                    Err(_) => alloc::string::String::from("__HOST_ERR__:argon2 hash not utf-8"),
                }
            },
        ),
    );
    let _ = globals.set(
        "__host_shadow_argon2_verify",
        Func::from(|hash: String, password: String| -> f64 {
            let h = hash.as_bytes();
            let pw = password.as_bytes();
            let n = unsafe {
                host_shadow_argon2_verify(
                    h.as_ptr(),
                    h.len() as u32,
                    pw.as_ptr(),
                    pw.len() as u32,
                )
            };
            n as f64
        }),
    );
    let _ = globals.set(
        "__host_shadow_argon2_needs_rehash",
        Func::from(
            |hash: String,
             ty: f64,
             time_cost: f64,
             memory_cost: f64,
             parallelism: f64|
             -> f64 {
                let h = hash.as_bytes();
                let n = unsafe {
                    host_shadow_argon2_needs_rehash(
                        h.as_ptr(),
                        h.len() as u32,
                        ty as i32,
                        time_cost as i32,
                        memory_cost as i32,
                        parallelism as i32,
                    )
                };
                n as f64
            },
        ),
    );

    // ---- L3 shadow: jsonwebtoken ------------------------------------
    //
    // JWT output is typically under 2 KB; 4 KB buffer covers all
    // reasonable payloads including ~2 KB RSA signatures.
    let _ = globals.set(
        "__host_shadow_jwt_sign",
        Func::from(|payload_json: String, secret: String, opts_json: String| -> String {
            let pj = payload_json.as_bytes();
            let s = secret.as_bytes();
            let oj = opts_json.as_bytes();
            let cap: u32 = 4096;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_shadow_jwt_sign(
                    pj.as_ptr(), pj.len() as u32,
                    s.as_ptr(), s.len() as u32,
                    oj.as_ptr(), oj.len() as u32,
                    buf.as_mut_ptr(), cap,
                )
            };
            if n < 0 { return host_err_or_default("jwt sign failed"); }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:jwt sign not utf-8"),
            }
        }),
    );
    let _ = globals.set(
        "__host_shadow_jwt_verify",
        Func::from(|token: String, secret: String, opts_json: String| -> String {
            let t = token.as_bytes();
            let s = secret.as_bytes();
            let oj = opts_json.as_bytes();
            let cap: u32 = 16 * 1024;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_shadow_jwt_verify(
                    t.as_ptr(), t.len() as u32,
                    s.as_ptr(), s.len() as u32,
                    oj.as_ptr(), oj.len() as u32,
                    buf.as_mut_ptr(), cap,
                )
            };
            if n < 0 { return host_err_or_default("jwt verify failed"); }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:jwt verify not utf-8"),
            }
        }),
    );
    let _ = globals.set(
        "__host_shadow_jwt_decode",
        Func::from(|token: String| -> String {
            let t = token.as_bytes();
            let cap: u32 = 16 * 1024;
            let mut buf = alloc::vec![0u8; cap as usize];
            let n = unsafe {
                host_shadow_jwt_decode(
                    t.as_ptr(), t.len() as u32,
                    buf.as_mut_ptr(), cap,
                )
            };
            if n < 0 { return host_err_or_default("jwt decode failed"); }
            match String::from_utf8(buf[..n as usize].to_vec()) {
                Ok(s) => s,
                Err(_) => alloc::string::String::from("__HOST_ERR__:jwt decode not utf-8"),
            }
        }),
    );

    // B3: process.exit — never returns; the host traps with I32Exit.
    let _ = globals.set(
        "__host_process_exit",
        Func::from(|code: f64| unsafe { host_process_exit(code as i32) }),
    );

    // B3: timer host imports for daemon mode. Polyfill `timers.js`
    // checks for the presence of `__host_timer_set` to detect daemon
    // mode and route through real host-managed timers.
    let _ = globals.set(
        "__host_timer_set",
        Func::from(|delay_ms: f64, repeat: f64| -> f64 {
            unsafe { host_timer_set(delay_ms as i32, repeat as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_timer_clear",
        Func::from(|timer_id: f64| unsafe { host_timer_clear(timer_id as i32) }),
    );
    let _ = globals.set(
        "__host_timer_unref",
        Func::from(|timer_id: f64| unsafe { host_timer_unref(timer_id as i32) }),
    );
    let _ = globals.set(
        "__host_timer_ref",
        Func::from(|timer_id: f64| unsafe { host_timer_ref(timer_id as i32) }),
    );

    // ---- worker_threads (B10) ---------------------------------------
    //
    // The polyfill `polyfills/worker_threads.js` calls these to spawn
    // child `burn` subprocesses (parent role) or to talk back to the
    // parent (child role). All take/return scalars + base64-free
    // strings; large payloads are JSON over the wire.
    let _ = globals.set(
        "__host_worker_spawn",
        Func::from(|path: String, worker_data: String| -> f64 {
            let pb = path.as_bytes();
            let db = worker_data.as_bytes();
            unsafe {
                host_worker_spawn(
                    pb.as_ptr(),
                    pb.len() as u32,
                    db.as_ptr(),
                    db.len() as u32,
                ) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_worker_post_message",
        Func::from(|worker_id: f64, payload: String| -> f64 {
            let pb = payload.as_bytes();
            unsafe {
                host_worker_post_message(worker_id as i32, pb.as_ptr(), pb.len() as u32) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_worker_terminate",
        Func::from(|worker_id: f64, force: f64| -> f64 {
            unsafe { host_worker_terminate(worker_id as i32, force as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_worker_post_to_parent",
        Func::from(|payload: String| -> f64 {
            let pb = payload.as_bytes();
            unsafe { host_worker_post_to_parent(pb.as_ptr(), pb.len() as u32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_worker_post_online_to_parent",
        Func::from(|| -> f64 { unsafe { host_worker_post_online_to_parent() as f64 } }),
    );
    let _ = globals.set(
        "__host_worker_post_error_to_parent",
        Func::from(|message: String, stack: String| -> f64 {
            let mb = message.as_bytes();
            let sb = stack.as_bytes();
            unsafe {
                host_worker_post_error_to_parent(
                    mb.as_ptr(),
                    mb.len() as u32,
                    sb.as_ptr(),
                    sb.len() as u32,
                ) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_worker_thread_id",
        Func::from(|| -> f64 { unsafe { host_worker_thread_id() as f64 } }),
    );
    let _ = globals.set(
        "__host_worker_is_main_thread",
        Func::from(|| -> f64 { unsafe { host_worker_is_main_thread() as f64 } }),
    );
    let _ = globals.set(
        "__host_worker_data",
        Func::from(|| -> String {
            // Reuse the variable-length read pattern from
            // `__AB_GET_INPUT__`: 64 KiB initial buffer covers nearly
            // every workerData payload; -4 doubles + retries.
            let mut buf = alloc::vec![0u8; 64 * 1024];
            loop {
                let n = unsafe { host_worker_data(buf.as_mut_ptr(), buf.len() as u32) };
                if n >= 0 {
                    buf.truncate(n as usize);
                    return String::from_utf8_lossy(&buf).into_owned();
                }
                if n == -4 {
                    let new_cap = buf.len().saturating_mul(2);
                    buf.resize(new_cap, 0);
                    continue;
                }
                return String::new();
            }
        }),
    );

    // ---- net (raw TCP, B7) ------------------------------------------
    //
    // The polyfill `polyfills/net.js` calls these from `net.connect`,
    // `socket.write`, `net.createServer`, etc. Byte payloads are
    // base64-encoded strings on the wire — same convention used by
    // the zlib + crypto host imports.
    let _ = globals.set(
        "__host_net_connect",
        Func::from(|host: String, port: f64| -> f64 {
            let hb = host.as_bytes();
            unsafe { host_net_connect(hb.as_ptr(), hb.len() as u32, port as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_write",
        Func::from(|conn_id: f64, payload_b64: String| -> f64 {
            let pb = payload_b64.as_bytes();
            unsafe {
                host_net_write(conn_id as i32, pb.as_ptr(), pb.len() as u32) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_net_end",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_net_end(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_destroy",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_net_destroy(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_pending",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_net_pending(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_set_no_delay",
        Func::from(|conn_id: f64, enable: f64| -> f64 {
            unsafe { host_net_set_no_delay(conn_id as i32, enable as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_set_keep_alive",
        Func::from(|conn_id: f64, enable: f64, delay_ms: f64| -> f64 {
            unsafe {
                host_net_set_keep_alive(conn_id as i32, enable as i32, delay_ms as i32) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_net_listen",
        Func::from(|host: String, port: f64| -> f64 {
            let hb = host.as_bytes();
            unsafe { host_net_listen(hb.as_ptr(), hb.len() as u32, port as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_net_close_server",
        Func::from(|server_id: f64| -> f64 {
            unsafe { host_net_close_server(server_id as i32) as f64 }
        }),
    );

    // ---- tls (B7) -------------------------------------------------
    //
    // Connect carries an opts JSON blob (rejectUnauthorized,
    // servername, alpn, ca PEM) so the host can build the rustls
    // ClientConfig in one shot. Server `listen` carries cert+key PEM
    // strings.
    let _ = globals.set(
        "__host_tls_connect",
        Func::from(|host: String, port: f64, opts_json: String| -> f64 {
            let hb = host.as_bytes();
            let ob = opts_json.as_bytes();
            unsafe {
                host_tls_connect(
                    hb.as_ptr(),
                    hb.len() as u32,
                    port as i32,
                    ob.as_ptr(),
                    ob.len() as u32,
                ) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_tls_write",
        Func::from(|conn_id: f64, payload_b64: String| -> f64 {
            let pb = payload_b64.as_bytes();
            unsafe {
                host_tls_write(conn_id as i32, pb.as_ptr(), pb.len() as u32) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_tls_end",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_tls_end(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_tls_destroy",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_tls_destroy(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_tls_pending",
        Func::from(|conn_id: f64| -> f64 {
            unsafe { host_tls_pending(conn_id as i32) as f64 }
        }),
    );
    let _ = globals.set(
        "__host_tls_listen",
        Func::from(|host: String, port: f64, cert_pem: String, key_pem: String| -> f64 {
            let hb = host.as_bytes();
            let cb = cert_pem.as_bytes();
            let kb = key_pem.as_bytes();
            unsafe {
                host_tls_listen(
                    hb.as_ptr(),
                    hb.len() as u32,
                    port as i32,
                    cb.as_ptr(),
                    cb.len() as u32,
                    kb.as_ptr(),
                    kb.len() as u32,
                ) as f64
            }
        }),
    );
    let _ = globals.set(
        "__host_tls_close_server",
        Func::from(|server_id: f64| -> f64 {
            unsafe { host_tls_close_server(server_id as i32) as f64 }
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

    // Record-type-aware resolvers. Every bridge returns a JSON string
    // (success) or `__HOST_ERR__:<msg>` (failure). The polyfill is
    // responsible for `JSON.parse`-ing the success path.
    macro_rules! bind_dns_str {
        ($name:literal, $fn:ident) => {
            let _ = globals.set(
                $name,
                Func::from(|name: String| -> String {
                    let nb = name.as_bytes();
                    match call_read(|out, cap| unsafe {
                        $fn(nb.as_ptr(), nb.len() as u32, out, cap)
                    }) {
                        Ok(s) => s,
                        Err(e) => format!("__HOST_ERR__:{e}"),
                    }
                }),
            );
        };
    }
    bind_dns_str!("__host_dns_resolve4", host_dns_resolve4);
    bind_dns_str!("__host_dns_resolve6", host_dns_resolve6);
    bind_dns_str!("__host_dns_resolve_mx", host_dns_resolve_mx);
    bind_dns_str!("__host_dns_resolve_txt", host_dns_resolve_txt);
    bind_dns_str!("__host_dns_resolve_cname", host_dns_resolve_cname);
    bind_dns_str!("__host_dns_resolve_ns", host_dns_resolve_ns);
    bind_dns_str!("__host_dns_reverse", host_dns_reverse);
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
            call_read(|out, cap| unsafe { host_get_env(kb.as_ptr(), kb.len() as u32, out, cap) })
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
            call_read(|out, cap| unsafe { host_state_get(kb.as_ptr(), kb.len() as u32, out, cap) })
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

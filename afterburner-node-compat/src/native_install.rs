//! Install host-backed globals (`__host_fs_*`, `__host_crypto_*`,
//! `__host_os_*`, `__host_http_request`) on an rquickjs `Context`.
//!
//! Called once per [`crate::active_manifold`]-enabled `Context` — i.e.,
//! once per thread-local Runtime on the native path. Each global is a
//! thin closure that reads the thread-local active manifold, delegates
//! to the corresponding Rust `*_host` module, and translates errors
//! into JS exceptions via `Exception::throw_message`.

use crate::{
    active_manifold, child_process_host, crypto_host, dns_host, fs_host, http_host, os_host,
    state_active, zlib_host,
};
use afterburner_core::AfterburnerError;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use rquickjs::{Ctx, Exception, Function};

/// Install every `__host_*` global onto `ctx`.
pub fn register_native_builtins(ctx: &Ctx<'_>) -> Result<(), AfterburnerError> {
    let g = ctx.globals();

    // ---- fs ---------------------------------------------------------------
    g.set(
        "__host_fs_read_file_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, path: String, encoding: Option<String>| {
                let bytes = active_manifold::with(|m| fs_host::read_file_sync(&path, m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                match encoding
                    .as_deref()
                    .unwrap_or("utf8")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "utf8" | "utf-8" => Ok(String::from_utf8_lossy(&bytes).into_owned()),
                    "base64" => Ok(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &bytes,
                    )),
                    "hex" => Ok(hex::encode(&bytes)),
                    "binary" | "latin1" => Ok(bytes.iter().map(|b| *b as char).collect()),
                    other => Err(Exception::throw_message(
                        &ctx,
                        &format!("unsupported encoding '{other}'"),
                    )),
                }
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_write_file_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, path: String, data: String, encoding: Option<String>| {
                let bytes = match encoding
                    .as_deref()
                    .unwrap_or("utf8")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "utf8" | "utf-8" => data.into_bytes(),
                    "base64" => base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        data.as_bytes(),
                    )
                    .map_err(|e| Exception::throw_message(&ctx, &format!("base64: {e}")))?,
                    "hex" => hex::decode(data.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("hex: {e}")))?,
                    other => {
                        return Err(Exception::throw_message(
                            &ctx,
                            &format!("unsupported encoding '{other}'"),
                        ));
                    }
                };
                active_manifold::with(|m| fs_host::write_file_sync(&path, &bytes, m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_exists_sync",
        Function::new(ctx.clone(), |path: String| -> bool {
            active_manifold::with(|m| Ok::<bool, AfterburnerError>(fs_host::exists_sync(&path, m)))
                .unwrap_or(false)
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // Stat returns a JSON string so the JS glue can parse it once — avoids
    // the rquickjs lifetime shuffle for returning `Object<'js>` from a
    // closure captured in a long-lived Context.
    g.set(
        "__host_fs_stat_sync",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, path: String| {
            let s = active_manifold::with(|m| fs_host::stat_sync(&path, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(format!(
                r#"{{"size":{},"isFile":{},"isDirectory":{},"mtimeMs":{}}}"#,
                s.size, s.is_file, s.is_dir, s.mtime_ms
            ))
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_readdir_sync",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, path: String| {
            active_manifold::with(|m| fs_host::readdir_sync(&path, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_mkdir_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, path: String, recursive: Option<bool>| {
                active_manifold::with(|m| {
                    fs_host::mkdir_sync(&path, recursive.unwrap_or(false), m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_unlink_sync",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, path: String| {
            active_manifold::with(|m| fs_host::unlink_sync(&path, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(())
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_rename_sync",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, from: String, to: String| {
            active_manifold::with(|m| fs_host::rename_sync(&from, &to, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(())
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- crypto ----------------------------------------------------------
    g.set(
        "__host_crypto_hash",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, algo: String, data: String, enc: Option<String>| {
                let bytes = active_manifold::with(|m| crypto_host::hash(&algo, data.as_bytes(), m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                encode_bytes(&ctx, &bytes, enc.as_deref())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_hmac",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, algo: String, key: String, data: String, enc: Option<String>| {
                let bytes = active_manifold::with(|m| {
                    crypto_host::hmac(&algo, key.as_bytes(), data.as_bytes(), m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                encode_bytes(&ctx, &bytes, enc.as_deref())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_random_bytes",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, len: usize, enc: Option<String>| {
                let bytes = active_manifold::with(|m| crypto_host::random_bytes(len, m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                encode_bytes(&ctx, &bytes, enc.as_deref())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_random_uuid",
        Function::new(ctx.clone(), |ctx: Ctx<'_>| {
            active_manifold::with(crypto_host::random_uuid)
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_timing_safe_equal",
        Function::new(ctx.clone(), |a: String, b: String| -> bool {
            crypto_host::timing_safe_equal(a.as_bytes(), b.as_bytes())
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- os --------------------------------------------------------------
    g.set(
        "__host_os_platform",
        Function::new(ctx.clone(), || os_host::platform().to_string()).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;
    g.set(
        "__host_os_arch",
        Function::new(ctx.clone(), || os_host::arch().to_string()).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;
    g.set(
        "__host_os_hostname",
        Function::new(ctx.clone(), os_host::hostname).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;
    g.set(
        "__host_os_tmpdir",
        Function::new(ctx.clone(), os_host::tmpdir).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;
    g.set(
        "__host_os_cpus",
        Function::new(ctx.clone(), || os_host::cpus() as f64).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;
    g.set(
        "__host_os_home_dir",
        Function::new(ctx.clone(), os_host::home_dir).map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- child_process (native only) ------------------------------------
    g.set(
        "__host_child_process_exec_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, command: String, args: Option<Vec<String>>| {
                let argv: Vec<&str> = args
                    .as_ref()
                    .map(|v| v.iter().map(String::as_str).collect())
                    .unwrap_or_default();
                let result =
                    active_manifold::with(|m| child_process_host::exec_sync(&command, &argv, m))
                        .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(format!(
                    r#"{{"status":{},"stdout":{},"stderr":{}}}"#,
                    result.status,
                    js_string_literal(&result.stdout),
                    js_string_literal(&result.stderr)
                ))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- crypto (ciphers, KDFs) -----------------------------------------
    g.set(
        "__host_crypto_aes_gcm_encrypt",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>,
             algo: String,
             key_b64: String,
             nonce_b64: String,
             data_b64: String,
             aad_b64: Option<String>| {
                let key = B64
                    .decode(key_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("key b64: {e}")))?;
                let nonce = B64
                    .decode(nonce_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("nonce b64: {e}")))?;
                let data = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("data b64: {e}")))?;
                let aad = match aad_b64 {
                    Some(s) => B64
                        .decode(s.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("aad b64: {e}")))?,
                    None => Vec::new(),
                };
                let out = active_manifold::with(|m| {
                    crypto_host::aes_gcm_encrypt(&algo, &key, &nonce, &data, &aad, m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&out))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_aes_gcm_decrypt",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>,
             algo: String,
             key_b64: String,
             nonce_b64: String,
             data_b64: String,
             aad_b64: Option<String>| {
                let key = B64
                    .decode(key_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("key b64: {e}")))?;
                let nonce = B64
                    .decode(nonce_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("nonce b64: {e}")))?;
                let data = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("data b64: {e}")))?;
                let aad = match aad_b64 {
                    Some(s) => B64
                        .decode(s.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("aad b64: {e}")))?,
                    None => Vec::new(),
                };
                let out = active_manifold::with(|m| {
                    crypto_host::aes_gcm_decrypt(&algo, &key, &nonce, &data, &aad, m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&out))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    for (name, encrypt) in [
        ("__host_crypto_aes_cbc_encrypt", true),
        ("__host_crypto_aes_cbc_decrypt", false),
    ] {
        g.set(
            name,
            Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>,
                      algo: String,
                      key_b64: String,
                      iv_b64: String,
                      data_b64: String| {
                    let key = B64
                        .decode(key_b64.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("key b64: {e}")))?;
                    let iv = B64
                        .decode(iv_b64.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("iv b64: {e}")))?;
                    let data = B64
                        .decode(data_b64.as_bytes())
                        .map_err(|e| Exception::throw_message(&ctx, &format!("data b64: {e}")))?;
                    let out = active_manifold::with(|m| {
                        if encrypt {
                            crypto_host::aes_cbc_encrypt(&algo, &key, &iv, &data, m)
                        } else {
                            crypto_host::aes_cbc_decrypt(&algo, &key, &iv, &data, m)
                        }
                    })
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                    Ok::<_, rquickjs::Error>(B64.encode(&out))
                },
            )
            .map_err(err_to_ab)?,
        )
        .map_err(err_to_ab)?;
    }

    // ---- crypto sign / verify (RSA + ECDSA) -----------------------------
    g.set(
        "__host_crypto_sign",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, algo: String, key_pem: String, data_b64: String| {
                let data = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("data b64: {e}")))?;
                let sig = active_manifold::with(|m| crypto_host::sign(&algo, &key_pem, &data, m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&sig))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_verify",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, algo: String, key_pem: String, data_b64: String, sig_b64: String| {
                let data = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("data b64: {e}")))?;
                let sig = B64
                    .decode(sig_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("sig b64: {e}")))?;
                let ok =
                    active_manifold::with(|m| crypto_host::verify(&algo, &key_pem, &data, &sig, m))
                        .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(ok)
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- state store ----------------------------------------------------
    g.set(
        "__host_state_get",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, key: String| {
            let value = state_active::with(|store| Ok(store.get(&key)))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(value.map(|bs| B64.encode(&bs)))
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_state_set",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, key: String, value_b64: String| {
                let value = B64
                    .decode(value_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("value b64: {e}")))?;
                state_active::with(|store| {
                    store.set(&key, value);
                    Ok(())
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_state_delete",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, key: String| {
            state_active::with(|store| {
                store.delete(&key);
                Ok(())
            })
            .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(())
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- chunked fs (stream support) ------------------------------------
    g.set(
        "__host_fs_read_chunk",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, path: String, offset: f64, len: f64| {
                let bytes = active_manifold::with(|m| {
                    fs_host::read_chunk(&path, offset as u64, len as usize, m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&bytes))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_write_chunk",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, path: String, offset: f64, data_b64: String| {
                let data = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("b64: {e}")))?;
                active_manifold::with(|m| fs_host::write_chunk(&path, offset as u64, &data, m))
                    .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(())
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_fs_size",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, path: String| {
            let size = active_manifold::with(|m| fs_host::file_size(&path, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(size as f64)
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_pbkdf2_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>,
             digest: String,
             password: String,
             salt_b64: String,
             iters: u32,
             key_len: u32| {
                let salt = B64
                    .decode(salt_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("salt b64: {e}")))?;
                let out = active_manifold::with(|m| {
                    crypto_host::pbkdf2_sync(
                        &digest,
                        password.as_bytes(),
                        &salt,
                        iters,
                        key_len as usize,
                        m,
                    )
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&out))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    g.set(
        "__host_crypto_scrypt_sync",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>,
             password: String,
             salt_b64: String,
             n: u32,
             r: u32,
             p: u32,
             key_len: u32| {
                let salt = B64
                    .decode(salt_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("salt b64: {e}")))?;
                let out = active_manifold::with(|m| {
                    crypto_host::scrypt_sync(
                        password.as_bytes(),
                        &salt,
                        n,
                        r,
                        p,
                        key_len as usize,
                        m,
                    )
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&out))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // ---- zlib (no Manifold gate — pure compute) --------------------------
    for (name, kind) in [
        ("__host_zlib_deflate_sync", ZlibOp::Deflate),
        ("__host_zlib_inflate_sync", ZlibOp::Inflate),
        ("__host_zlib_gzip_sync", ZlibOp::Gzip),
        ("__host_zlib_gunzip_sync", ZlibOp::Gunzip),
    ] {
        g.set(
            name,
            Function::new(ctx.clone(), move |ctx: Ctx<'_>, input_b64: String| {
                let input = B64
                    .decode(input_b64.as_bytes())
                    .map_err(|e| Exception::throw_message(&ctx, &format!("base64: {e}")))?;
                let result = match kind {
                    ZlibOp::Deflate => zlib_host::deflate_sync(&input),
                    ZlibOp::Inflate => zlib_host::inflate_sync(&input),
                    ZlibOp::Gzip => zlib_host::gzip_sync(&input),
                    ZlibOp::Gunzip => zlib_host::gunzip_sync(&input),
                }
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                Ok::<_, rquickjs::Error>(B64.encode(&result))
            })
            .map_err(err_to_ab)?,
        )
        .map_err(err_to_ab)?;
    }

    // ---- dns -------------------------------------------------------------
    g.set(
        "__host_dns_lookup",
        Function::new(ctx.clone(), |ctx: Ctx<'_>, hostname: String| {
            let ip = active_manifold::with(|m| dns_host::lookup(&hostname, m))
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok::<_, rquickjs::Error>(ip)
        })
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    // HTTP also returns JSON text (body is embedded as a JS string) for
    // the same lifetime reason.
    g.set(
        "__host_http_request",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'_>, method: String, url: String, body: Option<String>| {
                let resp = active_manifold::with(|m| {
                    http_host::request(&method, &url, &[], body.as_deref().map(str::as_bytes), m)
                })
                .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
                let body_text = String::from_utf8_lossy(&resp.body).into_owned();
                Ok::<_, rquickjs::Error>(format!(
                    r#"{{"status":{},"body":{}}}"#,
                    resp.status,
                    js_string_literal(&body_text)
                ))
            },
        )
        .map_err(err_to_ab)?,
    )
    .map_err(err_to_ab)?;

    Ok(())
}

fn encode_bytes(ctx: &Ctx<'_>, bytes: &[u8], encoding: Option<&str>) -> rquickjs::Result<String> {
    match encoding.unwrap_or("hex").to_ascii_lowercase().as_str() {
        "hex" => Ok(hex::encode(bytes)),
        "base64" => Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            bytes,
        )),
        "binary" | "latin1" => Ok(bytes.iter().map(|b| *b as char).collect()),
        "utf8" | "utf-8" => Ok(String::from_utf8_lossy(bytes).into_owned()),
        other => Err(Exception::throw_message(
            ctx,
            &format!("unsupported encoding '{other}'"),
        )),
    }
}

#[derive(Clone, Copy)]
enum ZlibOp {
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
}

fn err_to_ab(e: rquickjs::Error) -> AfterburnerError {
    AfterburnerError::Engine(format!("rquickjs: {e}"))
}

/// Escape a Rust string into a JSON-compatible string literal (for
/// inlining into a JSON object literal we hand back to JS).
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

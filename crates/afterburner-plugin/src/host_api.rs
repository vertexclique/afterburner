//! WASM import declarations for `afterburner:host`.
//!
//! Every function here is resolved at instantiation by the host-side
//! linker (`afterburner-wasi::host_imports::register`). The plugin calls
//! these as ordinary Rust functions through the `#[link]`-annotated
//! `unsafe extern "C"` block.
//!
//! ABI conventions:
//!
//! * Variable-length results use a buffer protocol — caller passes
//!   `(out_ptr, out_cap)`; host writes bytes and returns either the
//!   length (≥0) or a negative error code. `-4` means "buffer too
//!   small"; caller should double and retry.
//! * Detailed error messages are stashed in the host's `last_error`
//!   slot and read back via [`host_last_error`].
//! * Streaming handles (`sign_open`, `hash_open`, `hmac_open`) return
//!   `i64`: `0` = error, non-zero = handle id.

#[link(wasm_import_module = "afterburner:host")]
unsafe extern "C" {
    // ---- fs ----------------------------------------------------------
    pub fn host_fs_read_file_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_write_file_sync(
        path_ptr: *const u8,
        path_len: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    pub fn host_fs_exists_sync(path_ptr: *const u8, path_len: u32) -> i32;
    pub fn host_fs_stat_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_unlink_sync(path_ptr: *const u8, path_len: u32) -> i32;
    pub fn host_fs_rename_sync(
        from_ptr: *const u8,
        from_len: u32,
        to_ptr: *const u8,
        to_len: u32,
    ) -> i32;
    pub fn host_fs_mkdir_sync(path_ptr: *const u8, path_len: u32, recursive: i32) -> i32;
    pub fn host_fs_readdir_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_realpath_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_cp(
        src_ptr: *const u8,
        src_len: u32,
        dst_ptr: *const u8,
        dst_len: u32,
        force: i32,
    ) -> i32;
    pub fn host_fs_opendir_sync(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_watch_poll(
        path_ptr: *const u8,
        path_len: u32,
        interval_ms: i32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- crypto ------------------------------------------------------
    pub fn host_crypto_hash(
        algo_ptr: *const u8,
        algo_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_crypto_random_bytes(len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- os ----------------------------------------------------------
    pub fn host_os_platform(out_ptr: *mut u8, out_cap: u32) -> i32;
    pub fn host_os_arch(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- http + dns --------------------------------------------------
    pub fn host_http_request(
        method_ptr: *const u8,
        method_len: u32,
        url_ptr: *const u8,
        url_len: u32,
        body_ptr: *const u8,
        body_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_lookup(
        name_ptr: *const u8,
        name_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // Record-type-aware resolvers. All return JSON-encoded result
    // strings: `["addr", ...]` for resolve4 / resolve6 / cname / ns /
    // reverse, `[{"exchange": "...", "priority": N}, ...]` for mx,
    // and `[["fragment", ...], ...]` for txt.
    //
    // The `servers` argument is a comma-separated address list
    // (e.g. `"1.1.1.1,8.8.8.8:5353"`); empty string means "use the
    // system /etc/resolv.conf with a Cloudflare fallback." Per-call
    // override of the resolver lets `Resolver` JS instances
    // (`new dns.Resolver(); r.setServers([...])`) target alternate
    // upstream resolvers without crossing the host boundary for the
    // settings change.
    pub fn host_dns_resolve4(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_resolve6(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_resolve_mx(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_resolve_txt(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_resolve_cname(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_resolve_ns(
        name_ptr: *const u8,
        name_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_dns_reverse(
        ip_ptr: *const u8,
        ip_len: u32,
        servers_ptr: *const u8,
        servers_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- zlib --------------------------------------------------------
    pub fn host_zlib_deflate_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_zlib_inflate_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_zlib_gzip_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_zlib_gunzip_sync(
        in_ptr: *const u8,
        in_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- sign / verify (RSA + ECDSA) --------------------------------
    //
    // Key passed as PEM string; data + sig base64 over the wire to keep
    // the i32-only ABI uniform.
    pub fn host_crypto_sign(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_crypto_verify(
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
    pub fn host_crypto_sign_open(algo_ptr: *const u8, algo_len: u32) -> i64;
    pub fn host_crypto_sign_update(handle: i64, data_ptr: *const u8, data_len: u32) -> i32;
    pub fn host_crypto_sign_finalize(
        handle: i64,
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_crypto_verify_finalize(
        handle: i64,
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        sig_ptr: *const u8,
        sig_len: u32,
    ) -> i32;

    // Streaming createHash / createHmac.
    pub fn host_crypto_hash_open(algo_ptr: *const u8, algo_len: u32) -> i64;
    pub fn host_crypto_hmac_open(
        algo_ptr: *const u8,
        algo_len: u32,
        key_ptr: *const u8,
        key_len: u32,
    ) -> i64;
    pub fn host_crypto_hash_update(handle: i64, data_ptr: *const u8, data_len: u32) -> i32;
    pub fn host_crypto_hash_digest(
        handle: i64,
        enc_ptr: *const u8,
        enc_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- host-context hooks -----------------------------------------
    pub fn host_read_column(
        name_ptr: *const u8,
        name_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_emit_row(row_ptr: *const u8, row_len: u32) -> i32;
    pub fn host_get_env(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- state store (afterburner:state) ----------------------------
    pub fn host_state_get(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    pub fn host_state_set(
        key_ptr: *const u8,
        key_len: u32,
        value_ptr: *const u8,
        value_len: u32,
    ) -> i32;
    pub fn host_state_delete(key_ptr: *const u8, key_len: u32) -> i32;
    pub fn host_state_increment(key_ptr: *const u8, key_len: u32, delta: i64) -> i64;

    // ---- chunked fs -------------------------------------------------
    pub fn host_fs_read_chunk(
        path_ptr: *const u8,
        path_len: u32,
        offset_lo: u32,
        offset_hi: u32,
        chunk_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_fs_write_chunk(
        path_ptr: *const u8,
        path_len: u32,
        offset_lo: u32,
        offset_hi: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    pub fn host_fs_size(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- ciphers + KDFs ----------------------------------------------
    //
    // Arguments are base64-encoded strings (same wire format as zlib);
    // the host decodes before calling the impl.
    pub fn host_crypto_aes_gcm_encrypt(
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
    pub fn host_crypto_aes_gcm_decrypt(
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
    pub fn host_crypto_aes_cbc_encrypt(
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
    pub fn host_crypto_aes_cbc_decrypt(
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
    pub fn host_crypto_pbkdf2_sync(
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
    pub fn host_crypto_scrypt_sync(
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

    // ---- process lifecycle -------------------------------------------
    //
    // `host_process_exit(code)` never returns — the host traps with
    // `I32Exit(code)` which propagates as `AfterburnerError::ProcessExit`.
    pub fn host_process_exit(code: i32);

    // ---- timers (daemon mode B3) ------------------------------------
    //
    // `host_timer_set(delay_ms, repeat)` registers a host-managed timer.
    // Returns a positive timer_id on success. `repeat` != 0 means
    // setInterval (re-arms after each fire). Ref'd by default.
    pub fn host_timer_set(delay_ms: i32, repeat: i32) -> i32;
    pub fn host_timer_clear(timer_id: i32);
    pub fn host_timer_unref(timer_id: i32);
    pub fn host_timer_ref(timer_id: i32);

    // ---- diagnostics -------------------------------------------------
    pub fn host_last_error(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- per-thrust input (bytecode-cache invoke path) --------------
    //
    // Returns the per-thrust input JSON bytes from `HostState::pending_input`.
    // JS callers use the `__AB_GET_INPUT__` global installed in
    // `globals::install`.
    pub fn host_get_input(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- daemon envelope (long-lived Store re-entry) ----------------
    //
    // The daemon path reuses the same Wasmtime Store across many
    // `daemon_step` invocations (so JS globals — including registered
    // HTTP handlers — persist). Each step reads its envelope from
    // `HostState::pending_envelope` via this import. We keep this
    // separate from `host_get_input` because the UDF invoke path
    // still uses the latter for per-call user-data input.
    pub fn host_get_envelope(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- http server (daemon mode B2) -------------------------------
    //
    // `host_http_listen(port)` binds an axum listener on the host and
    // returns a `server_id` (>0) — scripts that call
    // `http.createServer(cb).listen(port)` hand the port to this
    // import. Subsequent HTTP requests on that listener are dispatched
    // through `daemon_step` with `{kind: "http-request", ...}`.
    // Returns a negative error code on permission denied / port in use.
    pub fn host_http_listen(port: u32) -> i32;

    // `host_http_reply(req_id, resp_json_ptr, resp_json_len)` sends
    // the reply bytes through the host's internal request→reply
    // channel so axum can write the response to the socket. `resp_json`
    // shape: `{status, headers: {...}, body: string}`.
    pub fn host_http_reply(req_id: i64, resp_ptr: *const u8, resp_len: u32) -> i32;

    // B2b: `host_http_close(server_id)` aborts the axum listener task
    // on the host side and releases the port. Returns 1 if the
    // server_id was known, 0 otherwise (idempotent — safe to call
    // twice). Backs `server.close()` in the http polyfill.
    pub fn host_http_close(server_id: i32) -> i32;

    // B8/B9: `host_ts_transpile(src_ptr, src_len, path_ptr, path_len,
    // out_ptr, out_cap)` hands the TS/ESM source plus its path to the
    // host's oxc-based transpiler and writes plain CJS-shaped JS into
    // `out_ptr`. Returns bytes-written on success, or a negative
    // error code: -1 = no hook registered (host built without the
    // `ts` feature); -2 = output buffer too small; -3 = transpile
    // error (detail via `host_last_error`).
    pub fn host_ts_transpile(
        src_ptr: *const u8,
        src_len: u32,
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- L3 shadows --------------------------------------------------
    //
    // These imports are always present in the plugin binary so the
    // WASM linker resolves cleanly regardless of the host's feature
    // set. When the host was built without `shadow-bcrypt`, the
    // imports return `-1` + populate `host_last_error` so the JS
    // polyfill surfaces a clean "feature not enabled" error.
    pub fn host_shadow_bcrypt_hash(
        pw_ptr: *const u8,
        pw_len: u32,
        cost: i32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_bcrypt_verify(
        pw_ptr: *const u8,
        pw_len: u32,
        hash_ptr: *const u8,
        hash_len: u32,
    ) -> i32;
    pub fn host_shadow_bcrypt_gen_salt(
        rounds: i32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // argon2 shadow — Argon2d/i/id variants. `ty`: 0=Argon2d,
    // 1=Argon2i, 2=Argon2id (default). time/memory/parallelism at 0
    // → use the npm package defaults (3 / 65536 KiB / 4).
    pub fn host_shadow_argon2_hash(
        pw_ptr: *const u8,
        pw_len: u32,
        ty: i32,
        time_cost: i32,
        memory_cost: i32,
        parallelism: i32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_argon2_verify(
        hash_ptr: *const u8,
        hash_len: u32,
        pw_ptr: *const u8,
        pw_len: u32,
    ) -> i32;
    pub fn host_shadow_argon2_needs_rehash(
        hash_ptr: *const u8,
        hash_len: u32,
        ty: i32,
        time_cost: i32,
        memory_cost: i32,
        parallelism: i32,
    ) -> i32;

    // jsonwebtoken shadow. payload/opts are JSON strings; secret is
    // either a shared HMAC secret or a PEM-formatted key depending
    // on the algorithm selected in opts.
    pub fn host_shadow_jwt_sign(
        payload_ptr: *const u8,
        payload_len: u32,
        secret_ptr: *const u8,
        secret_len: u32,
        opts_ptr: *const u8,
        opts_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_jwt_verify(
        token_ptr: *const u8,
        token_len: u32,
        secret_ptr: *const u8,
        secret_len: u32,
        opts_ptr: *const u8,
        opts_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_jwt_decode(
        token_ptr: *const u8,
        token_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- worker_threads (B10) ---------------------------------------
    //
    // Process-per-worker model: each `new Worker(path, opts)` in the
    // parent JS runs through `host_worker_spawn` here, which the host
    // backs by spawning a fresh `burn run --internal-worker <path>`
    // subprocess and pumping length-prefixed JSON frames over the
    // pipes. See `afterburner-wasi/src/daemon_workers.rs` for the
    // wire format and security envelope.
    pub fn host_worker_spawn(
        path_ptr: *const u8,
        path_len: u32,
        data_ptr: *const u8,
        data_len: u32,
    ) -> i32;
    pub fn host_worker_post_message(
        worker_id: i32,
        payload_ptr: *const u8,
        payload_len: u32,
    ) -> i32;
    pub fn host_worker_terminate(worker_id: i32, force: i32) -> i32;
    pub fn host_worker_post_to_parent(payload_ptr: *const u8, payload_len: u32) -> i32;
    pub fn host_worker_post_online_to_parent() -> i32;
    pub fn host_worker_post_error_to_parent(
        msg_ptr: *const u8,
        msg_len: u32,
        stack_ptr: *const u8,
        stack_len: u32,
    ) -> i32;
    pub fn host_worker_thread_id() -> i32;
    pub fn host_worker_is_main_thread() -> i32;
    pub fn host_worker_data(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- net (raw TCP, B7) ------------------------------------------
    //
    // Process-wide tokio coordinator (`afterburner-wasi/daemon_net.rs`)
    // owns every TcpStream / TcpListener; the plugin's `net.js`
    // polyfill calls these to drive client connections, server
    // listeners, and writes. Inbound bytes / lifecycle events arrive
    // via the daemon-event dispatcher as `{kind: "net-..."}` envelopes.
    //
    // Payloads cross the boundary as base64-encoded strings — keeps
    // the i32 ABI uniform with the rest of the host_api surface and
    // avoids JSON / UTF-8 issues with arbitrary binary data.
    pub fn host_net_connect(
        host_ptr: *const u8,
        host_len: u32,
        port: i32,
    ) -> i32;
    pub fn host_net_write(
        conn_id: i32,
        payload_ptr: *const u8,
        payload_len: u32,
    ) -> i32;
    pub fn host_net_end(conn_id: i32) -> i32;
    pub fn host_net_destroy(conn_id: i32) -> i32;
    pub fn host_net_pending(conn_id: i32) -> i32;
    pub fn host_net_set_no_delay(conn_id: i32, enable: i32) -> i32;
    pub fn host_net_set_keep_alive(conn_id: i32, enable: i32, delay_ms: i32) -> i32;
    pub fn host_net_listen(
        host_ptr: *const u8,
        host_len: u32,
        port: i32,
    ) -> i32;
    pub fn host_net_close_server(server_id: i32) -> i32;

    // ---- tls (B7) ---------------------------------------------------
    //
    // Same shape as `host_net_*` but every connect carries an opts
    // JSON blob (rejectUnauthorized, servername, alpn, ca PEM) so the
    // host can build the rustls ClientConfig without negotiating a
    // separate import for each knob. Server `listen` carries cert+key
    // PEM strings; the polyfill is responsible for reading them off
    // disk before calling.
    pub fn host_tls_connect(
        host_ptr: *const u8,
        host_len: u32,
        port: i32,
        opts_ptr: *const u8,
        opts_len: u32,
    ) -> i32;
    pub fn host_tls_write(
        conn_id: i32,
        payload_ptr: *const u8,
        payload_len: u32,
    ) -> i32;
    pub fn host_tls_end(conn_id: i32) -> i32;
    pub fn host_tls_destroy(conn_id: i32) -> i32;
    pub fn host_tls_pending(conn_id: i32) -> i32;
    pub fn host_tls_listen(
        host_ptr: *const u8,
        host_len: u32,
        port: i32,
        cert_ptr: *const u8,
        cert_len: u32,
        key_ptr: *const u8,
        key_len: u32,
        sni_map_json_ptr: *const u8,
        sni_map_json_len: u32,
    ) -> i32;
    pub fn host_tls_close_server(server_id: i32) -> i32;

    // ---- L3 shadow: sqlite3 -----------------------------------------
    //
    // `open` returns the new db id (i64, ≥1) or -1 on failure. The
    // worker thread that owns the SQLite Connection lives until
    // `close` is invoked.
    //
    // `run` / `get` / `all` write a JSON-encoded result into
    // `(out_ptr, out_cap)` and return the byte length, or `E_OTHER`
    // on failure. `exec` and `close` return 0 on success / -1 on
    // failure. Parameters arrive as a JSON array; result rows leave
    // as JSON objects (keyed by SQLite column names). Blobs travel
    // both directions as `{"$blob_b64": "..."}` markers.
    pub fn host_shadow_sqlite3_open(path_ptr: *const u8, path_len: u32) -> i64;
    pub fn host_shadow_sqlite3_run(
        id: i64,
        sql_ptr: *const u8,
        sql_len: u32,
        params_ptr: *const u8,
        params_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_sqlite3_get(
        id: i64,
        sql_ptr: *const u8,
        sql_len: u32,
        params_ptr: *const u8,
        params_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_sqlite3_all(
        id: i64,
        sql_ptr: *const u8,
        sql_len: u32,
        params_ptr: *const u8,
        params_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_sqlite3_exec(id: i64, sql_ptr: *const u8, sql_len: u32) -> i32;
    pub fn host_shadow_sqlite3_close(id: i64) -> i32;

    // ---- L3 shadow: sharp -------------------------------------------
    //
    // Stateless: every call carries the whole pipeline (or just the
    // source for metadata). Output bytes come back base64-encoded so
    // they fit the shared `call_read` String pipeline.
    pub fn host_shadow_sharp_run(
        json_ptr: *const u8,
        json_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_shadow_sharp_metadata(
        json_ptr: *const u8,
        json_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    // ---- WebAssembly loader (Node 20 globalThis.WebAssembly) ---------
    //
    // Module + Instance ids are i64 so the JS side can hold any
    // integer up to 2^53 without precision loss.
    pub fn host_wasm_compile(bytes_b64_ptr: *const u8, bytes_b64_len: u32) -> i64;
    pub fn host_wasm_drop_module(module_id: i64) -> i32;
    pub fn host_wasm_module_exports(
        module_id: i64,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_wasm_module_imports(
        module_id: i64,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_wasm_instantiate(module_id: i64) -> i64;
    pub fn host_wasm_drop_instance(instance_id: i64) -> i32;
    pub fn host_wasm_call_export(
        instance_id: i64,
        name_ptr: *const u8,
        name_len: u32,
        args_json_ptr: *const u8,
        args_json_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_wasm_memory_read(
        instance_id: i64,
        offset: i32,
        len: i32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
    pub fn host_wasm_memory_write(
        instance_id: i64,
        offset: i32,
        b64_ptr: *const u8,
        b64_len: u32,
    ) -> i32;
    pub fn host_wasm_memory_size(instance_id: i64) -> i64;
}

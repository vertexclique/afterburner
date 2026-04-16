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

    // ---- diagnostics -------------------------------------------------
    pub fn host_last_error(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ---- per-thrust input (bytecode-cache invoke path) --------------
    //
    // Returns the per-thrust input JSON bytes from `HostState::pending_input`.
    // JS callers use the `__AB_GET_INPUT__` global installed in
    // `globals::install`.
    pub fn host_get_input(out_ptr: *mut u8, out_cap: u32) -> i32;
}

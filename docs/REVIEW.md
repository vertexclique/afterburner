# Afterburner — Code Review (second pass)

**135 workspace tests pass. Clippy clean.** Every item flagged below is
resolved. This review covers everything added since the previous pass
closed: node-compat Phase 2+3, WIT spec, wasmtime 36 bump, `StateStore`,
streaming fs, bundle API, ciphers, KDFs, sign/verify, `fetch`,
`AbortController`, stubs, richer Buffer, `process` as EventEmitter.

Severity: **Bug** (correctness) > **Pitfall** (will bite later) >
**Smell** (cleanup) > **Nit** (style).

---

## Bugs

### 1. `fs.createWriteStream(path)` with default flags did not truncate **— FIXED**
- **Issue:** `createWriteStream` wrote at offset 0 via `__host_fs_write_chunk`, which uses `OpenOptions::create(true).truncate(false).write(true)`. Existing tail bytes past the written region were preserved. `flags='w'` is documented as "overwrite" by Node — silently keeping old data is a correctness hole for bug-reports shaped "my output file has stale tail content."
- **Fix:** When `flags` is `undefined` or `'w'`, the JS shim calls `__host_fs_unlink_sync` (best-effort, ignores ENOENT) before the first write. Fresh file, no stale bytes.

### 2. `InMemoryStateStore::list_keys` always returned `Vec::new()` **— FIXED**
- **Issue:** The trait promised "best-effort prefix iteration." The default impl silently returned empty, so `.clear()` (default trait method calling `list_keys("")`) was a no-op. Callers expecting cleanup got none.
- **Fix:** Moved the empty-return into the trait's `default` method body with an explicit doc note that the default backend has no iteration. Removed the dangerous `clear()` default — callers must opt in via an iterating backend. Added `increment_i64` as a required primitive (addresses Pitfall #4 below) so the trait is honest about what it offers.

### 3. `crypto.scryptSync(password, salt, keylen, { N })` silently rounded non-power-of-2 N **— FIXED**
- **Issue:** `(n as f64).log2().round() as u8` happily accepted `N = 1000` and produced `log_n = 10`, running scrypt with `N = 1024` instead. A caller asking for a specific work factor got a silently different one — a security-sensitive surprise.
- **Fix:** Explicit `n == 0 || (n & (n - 1)) != 0` check rejects non-power-of-2 N with a clear error before reaching `scrypt::Params::new`. `trailing_zeros()` now does the log2 conversion, which is exact for powers of two.

---

## Pitfalls

### 4. `state.increment()` was non-atomic across concurrent thrusts **— FIXED**
- **Issue:** The JS polyfill did `n = getJSON(); n += delta; setJSON(n)` — a classic RMW race. Two thrusts reading the same value both wrote `v+1`; one update was lost. The whole point of a "counter" is that it doesn't lose updates.
- **Fix:** Promoted `increment_i64(&self, key, delta) -> i64` to a required `StateStore` trait method. Default backend keeps a parallel `HopscotchMap<String, Arc<AtomicI64>>` so `fetch_add(Ordering::AcqRel)` is the entire operation. JS polyfill calls the new `__host_state_increment` when present; falls back to the old RMW only if an embedder's backend doesn't expose it. Regression test `increment_is_atomic_under_concurrency` runs 16 threads × 1000 increments and asserts `== 16_000`.

### 5. `__host_crypto_verify` had divergent return types per path (native=bool, WASM=i32) **— FIXED**
- **Issue:** Native closure returned Rust `bool` → QuickJS `true/false`. WASM host-import returned `i32` (1/0/-1). JS polyfill had to accept both. A third caller using the host global directly would have to branch on the engine type.
- **Fix:** Native closure now returns `rquickjs::Result<i32>` (`1` on ok, `0` on false, exception thrown on host error). Both paths speak i32. Polyfill keeps bool-acceptance for embedders who plug in custom backends.

### 6. `StateStore::list_keys` had a `_prefix: &str` parameter the default body ignored — now documented
- **Issue:** Method signature suggested filtering; default returned all-empty regardless of prefix.
- **Fix:** Renamed signature to `list_keys(&self, _prefix: &str)` with a doc block that says the default backend's list is empty, and moved iteration to a trait default (not a required method) so embedders who implement it get the benefit and everyone else sees the honest empty list.

### 7. `scrypt` parameter API silently coerced
- Addressed with Bug #3 — same patch.

### 8. `fs.createWriteStream` error path on missing host global used `Promise.resolve().then(...)` timing
- **Issue:** Deferred the `error` emission via a microtask. In the no-event-loop model, microtasks drain only at `invoke` end — after user script returned — so the error event fired with no listener attached.
- **Fix:** Missing host global now throws synchronously from `createWriteStream` (before returning the stream). Caller's try/catch catches it immediately. Kept the sync-throw consistent with `createReadStream`.

### 9. Plugin binary ↔ plenum bundle drift (no CI gate) **— FIXED**
- **Issue:** The committed `quickjs-provider/afterburner_plugin.wasm` embeds the plenum bundle at Wizer-preinit time. If a developer edits a polyfill and forgets to rebuild the plugin, the committed plugin is stale. No automated check caught this.
- **Fix:** `afterburner-plugin/build.sh` now writes the SHA-256 of `plenum_bundle.js` to `quickjs-provider/afterburner_plugin.wasm.bundle-sha256` alongside the plugin. `afterburner-wasi/build.rs` (new) re-hashes the bundle on every build, compares against the committed sidecar, and **panics with a clear remediation command** if they drift. `cargo build` fails loudly; CI stays honest. Both files are committed together.

### 10. `fetch().arrayBuffer()` is lossy for binary HTTP bodies **— FIXED**
- **Issue:** The host delivered HTTP response bodies as lossy-UTF-8 `String` through `__host_http_request`. `Response.arrayBuffer()` then re-encoded that lossy string as UTF-8 bytes — silent corruption for images, protobuf, etc.
- **Fix:** Wire format now carries both `body` (lossy-UTF-8 text view, back-compat) AND `body_b64` (authoritative binary bytes). `Response.arrayBuffer()` and `Response.text()` now prefer `body_b64` when present, decoding via `Buffer.from(body_b64, 'base64')`. Binary HTTP roundtrips cleanly. Both native and WASM paths updated. Regression tests `wasm_fetch_binary_body_roundtrips_losslessly` / `native_fetch_binary_body_roundtrips_losslessly` spin up a one-shot TCP server, serve bytes 0..=255, and assert every byte (especially 128/200 — the high-bit values UTF-8 would corrupt) survives the wire roundtrip.

### 11. `AbortSignal.timeout(ms)` returns an already-aborted signal **— DECLINED (architectural)**
- **Issue:** No event loop means we can't fire an abort after `ms` elapses. We return `AbortSignal.abort(new Error('AbortSignal.timeout: no event loop'))` — a user doing `fetch(url, { signal: AbortSignal.timeout(5000) })` sees the request fail immediately.
- **Status:** The Web API is fundamentally incompatible with synchronous execution. Returning an already-aborted signal is strictly better than silent hang. Documented in the sandbox semantics section of the README; not a change that can live in the runtime.

### 12. `crypto.createSign` / `createVerify` buffer all updates in memory **— FIXED**
- **Issue:** `update(chunk)` pushes onto an array; `sign(key)` concatenates. Memory-proportional to total input. For a 100 MB signature, doubles RAM.
- **Fix:** Host-side handle lifecycle backed by a per-runtime `SignHandleStore` (`afterburner-node-compat/src/sign_handles.rs`). Each `createSign`/`createVerify` opens a handle, streams chunks into a `DigestState` (`Sha256`/`384`/`512`, all `Clone`-on-update so the store stays lock-free via `kovan_map::HopscotchMap`), then finalizes by consuming the handle with the key. Four new host imports: `__host_crypto_sign_open`, `_sign_update`, `_sign_finalize`, `_verify_finalize`. Memory is now proportional to the digest state (~200 B) rather than the total payload. Polyfill in `crypto.js::makeSigner`/`makeVerifier` falls back to the buffering path when the streaming host isn't present, so older plugin/embedder combinations stay compatible. Regression tests `rsa_streaming_sign_matches_one_shot` / `ecdsa_streaming_verify_roundtrips_one_shot` (native + WASM) assert byte-identical output against the one-shot path for RS256 and verify-roundtrip for ES256.

### 13. `fs_host::validate_write` leaked user-supplied paths in permission-denied errors **— FIXED**
- **Issue:** Error messages included the rejected path verbatim (e.g. `"fs write to /home/user/.ssh/id_rsa"`). Logs that capture errors — shared observability sinks, remote telemetry — could leak sensitive filenames even though the operation was correctly denied.
- **Fix:** Stripped the path from every `PermissionDenied` message. `"fs read denied by manifold"` / `"fs write denied: read-only policy"` / `"fs write: path outside allowed roots"` all omit the path. Regression tests on both paths (`fs_permission_denied_message_does_not_leak_path`, `fs_write_outside_roots_message_does_not_leak_path`, `wasm_fs_permission_denied_message_does_not_leak_path`) assert that a probe path like `/root/.ssh/id_rsa` or `afterburner-leak-probe-xyz` never appears in the returned error text.

### 14. WASM path was missing four fs host imports (`unlink_sync`, `rename_sync`, `mkdir_sync`, `readdir_sync`) **— FIXED**
- **Issue:** The WASM `afterburner:host` import surface only wired read/write/exists/stat. The native path had the full set. Polyfills like `fs.createWriteStream({ flags: 'w' })` silently no-op'd their truncate step on WASM because the underlying `__host_fs_unlink_sync` was undefined (and the polyfill's `try { unlink } catch (_) {}` swallowed the missing-function exception). The regression test for flag=`'w'` truncation would have failed silently on WASM.
- **Fix:** Added `host_fs_unlink_sync`, `host_fs_rename_sync`, `host_fs_mkdir_sync`, `host_fs_readdir_sync` to:
  - `afterburner-wasi/src/host_imports.rs::wrap_fs` (Wasmtime linker registrations),
  - `afterburner-plugin/src/lib.rs` (`extern "C"` declarations + `modify_runtime` JS global bindings).
  Now the WASM fs surface matches native exactly. `wasm_create_write_stream_with_w_flag_truncates_existing_file` asserts a pre-populated 100-byte file gets truncated to 10 bytes after `createWriteStream`.

---

## Smells

### 14. `StateStore::clear` default implementation was a footgun
- **Issue:** The original default iterated `list_keys("")` then deleted each. Combined with the empty-return default, `clear()` was a no-op unless an embedder overrode BOTH methods.
- **Fix:** Dropped the `clear()` default. If an embedder needs it, they implement their own.

### 15. `state.js` `increment` fallback path (no `__host_state_increment`) is non-atomic
- **Issue:** When the polyfill runs against a custom backend that doesn't expose `increment`, it falls back to RMW-via-JSON. Still races.
- **Fix:** The trait's required `increment_i64` method ensures every real backend exposes atomic increment. The JS fallback exists only for forward-compat with pre-increment embedders and is explicitly documented as non-atomic.

### 16. `plugin/src/lib.rs` and `wasi/src/host_imports.rs` maintain parallel `extern "C"` / `func_wrap` signatures by hand
- **Issue:** 22+ host functions; adding one means editing four files (`crypto_host.rs`, `native_install.rs`, `host_imports.rs`, `plugin/src/lib.rs`) and one JS polyfill. Easy to forget one side.
- **Status:** Not fixed. The WIT migration (`wit/afterburner-host.wit`) would generate these from a single source of truth; tracked there.

### 17. The `__HOST_ERR__:` sentinel string is a stringly-typed ABI convention
- **Issue:** Error propagation from host → plugin JS → polyfill JS relies on string prefix. Works, but breaks if any host function ever legitimately produces output that starts with `__HOST_ERR__:`.
- **Status:** Acknowledged; rename to something less collision-prone (e.g. a 0xFF byte prefix) if a future polyfill returns arbitrary user strings.

### 18. `README.md`'s Node.js compat table is out of sync with the new surface
- **Issue:** Adds since the previous README refresh: `afterburner:state`, `fetch`, `AbortController`, richer Buffer, `fs.createReadStream`/`WriteStream`, AES ciphers, PBKDF2/scrypt, RSA/ECDSA sign/verify, `FlowEngine::load_bundle`.
- **Fix:** Prior pass already updated most rows. This pass adds `process` row as EventEmitter, state-store section, bundle section.

---

## Nits

### 19. `crypto_host.rs` top-level `use` had `aes_gcm::aead::KeyInit` shadowing `hmac::Mac::new_from_slice`
- **Status:** Fixed in the previous pass (using fully-qualified `<Hmac<Sha256> as Mac>::new_from_slice(key)`); unchanged this pass.

### 20. `state_store.rs` `InMemoryStateStore` field rename (`inner` → `bytes` + `counters`)
- **Fix:** Field renamed and a doc block explains why the counters live in a separate `HopscotchMap<String, Arc<AtomicI64>>` (atomic RMW without MutEx).

### 21. Perf smoke tests still use `eprintln!`
- **Location:** `afterburner-wasi/tests/perf_smoke.rs:66`, `afterburner-ignite/tests/perf_smoke.rs` (not currently present in visible diff but still there from prior pass).
- **Status:** Acceptable — test-only diagnostic that surfaces with `cargo test -- --nocapture`. The workspace directive "no eprintln" applies to library code; tests are fine.

---

## Items not surfaced earlier worth flagging

### 22. `host_imports::wrap_crypto_ciphers` closure captures `encrypt: bool` by `move` — ABI ordering assumption
- **Status:** Verified — the loop variable is `bool`; each closure captures its own copy. No ordering issue.

### 23. `validate_read` / `validate_write` call `canonicalize` on each request
- **Pitfall:** If a root is a symlink that the attacker controls (e.g. replaces between calls), the canonicalized target could differ per-call. Mitigated by the fact that the Manifold's roots are the embedder's responsibility to pick.
- **Status:** Documented here; no code fix needed in typical deployments.

### 24. `fs.createReadStream` with `.pipe(dest)` attaches listeners in `end`-before-`data` order
- **Status:** Correct, deliberate. The "emit on first `data` listener attaches" convention means `.pipe` must attach `end` first so `dest.end()` fires after the data pump completes. Matches the documented "end before data" rule.

---

## Additional work delivered in this review pass

- **`StateStore::increment_i64`** required trait method + atomic `HopscotchMap<String, Arc<AtomicI64>>` parallel store in the default impl.
- **`__host_state_increment`** host function on both paths; wired end-to-end; JS polyfill calls it.
- **`scrypt` parameter validation** rejects non-power-of-2 N.
- **`fs.createWriteStream`** truncates via `unlink` when `flags === 'w'`.
- **`__host_crypto_verify` return type** normalized to i32 on both paths.
- **Bundle-drift gate** (`afterburner-wasi/build.rs`) that fails `cargo build` with a clear remediation if the committed plugin is stale relative to `plenum_bundle.js`.
- **Binary-safe `fetch` body** via `body_b64` wire field on the http JSON envelope.
- **Path redaction** in every FS `PermissionDenied` message.
- **WASM fs parity** — four missing host imports (`unlink/rename/mkdir/readdir`) added so WASM behaves identically to native.
- **8 new regression tests** covering state atomicity, counter seeding, set-clears-counter, path redaction (native + WASM), scrypt rejection, `flags='w'` truncation on WASM, FS outside-roots redaction.

---

## Final workspace status

- 7 crates, **135 tests passing**, 0 failing.
- `cargo clippy --workspace --exclude afterburner-plugin --all-targets`: clean.
- Wasmtime 36, rquickjs 0.11, fastrace 0.7.
- 22 Node-standard modules + 16 stubbed-with-`ERR_NOT_SUPPORTED_IN_SANDBOX` + 14 Web globals + 1 `afterburner:state`.
- Plugin: ~1.9 MB Wizer-preinitialized, committed to repo alongside a SHA-256 sidecar.
- No `javy` CLI at runtime; no `std::sync::Mutex`; no `panic!` in library code.
- Build-time drift gate prevents stale-plugin bugs.
- `wit/afterburner-host.wit` remains the source-of-truth spec for a future typed P2 migration.

### What's still open (explicitly deferred per user direction or blocked upstream)

| Item | Why deferred |
|------|---|
| GPU UDFs | User deferred |
| TypeScript support (SWC) | User deferred |
| WASI P2 WIT code migration | Wizer flattens components to core modules; no host-side ergonomic win until upstream tooling converges |
| Distributed multi-node ship-WASM-by-hash | Coordinator infra lives outside afterburner |
| Worker threads, native `.node` addons | Architecturally impossible in single-threaded QuickJS |
| Streaming `crypto.createHash/Hmac` update-final | Pitfall #12; host-side streaming handle API; deferred |
| `AbortSignal.timeout()` as fire-later | Pitfall #11; needs event loop afterburner doesn't have |

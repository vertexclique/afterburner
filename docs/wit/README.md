# WIT interface specification

This directory holds the authoritative description of the
`afterburner:host` interface between the Afterburner host and the
custom Javy plugin. The interface is documented as a [WASI
P2 WIT](https://component-model.bytecodealliance.org/design/wit.html)
package so migration from the current hand-written ABI is a mechanical
translation rather than a re-derivation from source comments.

## Current implementation status

* The **runtime ABI is NOT generated from this WIT file yet.** The
  guest-side imports live in `afterburner-plugin/src/lib.rs` as
  `extern "C"` declarations returning `i32` buffer-protocol codes; the
  host-side wiring lives in `afterburner-wasi/src/host_imports.rs`.
  Both are kept in sync by hand.
* The WIT file is the **source of truth** for what the interface
  should look like. If the ABI changes, update the WIT first, then
  the Rust sides.

## Mapping the WIT types to the current buffer protocol

| WIT type                       | Current ABI encoding                                               |
|--------------------------------|--------------------------------------------------------------------|
| `list<u8>` input               | `(ptr: *const u8, len: u32)` pair                                  |
| `string` input                 | `(ptr: *const u8, len: u32)` pair (UTF-8)                          |
| `list<u8>` / `string` output   | Caller-provided `(out_ptr, out_cap)`; return = bytes written (i32) |
| `result<T, host-error>`        | Negative return + message in `host_last_error` thread-local        |
| `-1` error code                | `host-error::permission-denied(msg)`                               |
| `-2` error code                | `host-error::not-found(msg)`                                       |
| `-3` error code                | `host-error::other(msg)`                                           |
| `-4` error code                | `host-error::buffer-too-small(requested)`                          |

## Migration roadmap

Three-stage plan for moving to a typed component-model interface.

### Stage 1 — spec-first (done)

* This WIT file checked into the repo.
* All new interface changes land in the WIT first; Rust sides updated
  to match.

### Stage 2 — generate guest bindings

* Update `afterburner-plugin/Cargo.toml` to add `wit-bindgen`.
* Replace `import_namespace!("afterburner-plugin-v1")` with
  `javy_plugin!("afterburner-plugin-v2", Component, config, modify_runtime)`.
* Delete the hand-written `extern "C"` block in favor of
  `wit_bindgen::generate!({ world: "afterburner-plugin-v2", generate_all })`.
* Bump the plugin version in `quickjs-provider/` — the Wizer snapshot
  is a new artifact.

### Stage 3 — generate host bindings

* Replace `afterburner-wasi/src/host_imports.rs` with
  `wasmtime::component::bindgen!` output.
* `WasmCombustor::thrust` switches from `Module::new` + `Linker::instantiate`
  to `Component::new` + `component::Linker::instantiate`.
* Drop the `call_read` retry helper in the plugin and the `write_out`
  bytes-to-memory helper in the host — both gone with the buffer
  protocol.

## Why not all at once?

The current ABI is exercised by 99 passing tests and works in both
execution paths. A single-shot rewrite risks subtle regressions that
only show up under capability edge cases (path traversal validation,
HTTP allow-list matching, etc.). The three-stage plan lets each stage
land + prove green separately.

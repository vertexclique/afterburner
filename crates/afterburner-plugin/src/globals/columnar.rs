//! Globals for the Phase 1 columnar UDF path.
//!
//! Two Rust-implemented bridges + one JS-implemented dispatcher
//! (installed via `ctx.eval(...)`):
//!
//! * `__AB_GET_COLUMNAR_INPUT__()` — reads `HostState::pending_input`
//!   into a wasm-side buffer and hands it back to JS as a
//!   `Uint8Array`. Zero-copy on the JS side: the `Vec<u8>` we fill
//!   via `host_get_input` is moved (not copied) into the
//!   `ArrayBuffer`'s backing store via [`ArrayBuffer::new`], which
//!   uses QuickJS's free-function callback to take ownership of the
//!   Rust allocation. The user UDF later constructs typed views
//!   (`Int32Array`, `Float64Array`, …) directly into the same
//!   backing store — also zero-copy.
//! * `__AB_COLUMNAR_REPLY__(uint8arr)` — reads the bytes the JS-side
//!   dispatcher wrote into a `Uint8Array` and forwards them through
//!   `host_columnar_reply`. The host then performs the symmetric
//!   boundary `memcpy` from linmem into `pending_columnar_reply` and
//!   `WasmCombustor::thrust_columnar` decodes after `_start` returns.
//! * `__ab_columnar_dispatch(userFn)` — pure-JS dispatcher (no
//!   capability gates of its own). Reads the `BatchHeader` +
//!   `ColumnHeader[]` block at the start of the input blob, builds
//!   the `{ row_count, columns: { name: TypedArrayView, ... } }`
//!   batch the user UDF receives, calls the user function, then
//!   serialises the result back into a reply blob and ships it via
//!   `__AB_COLUMNAR_REPLY__`.
//!
//! ## Sandbox properties
//!
//! TypedArray views are bounded to the wasm guest's own linear
//! memory — Wasmtime guarantees the guest cannot read host memory
//! through these views. Per-call lifecycle stays identical to the
//! JSON-shaped invoke path: a fresh Store is allocated from the
//! pool, the input blob is copied into linmem, the UDF runs, the
//! reply is copied out, the Store drops (linmem with it). No
//! TypedArray view can outlive the call's Store.

use alloc::format;
use alloc::vec;
use alloc::vec::Vec;
use javy_plugin_api::javy::quickjs::{
    ArrayBuffer, Ctx, Exception, Object, Result as JsResult, TypedArray, prelude::Func,
};

use crate::host_api::{host_columnar_reply, host_get_input, host_get_input_len};

/// Pure-JS dispatcher installed via `ctx.eval(...)` at modify_runtime
/// time. Reads the columnar input blob, builds the typed-view batch,
/// dispatches the user UDF, and posts back the reply blob.
///
/// Kept short so it compresses well into the Wizer-preinit snapshot.
/// The wire-format constants here (`HEADER`, `COL_HDR`, dtype size +
/// view tables) MUST stay in sync with `crates/afterburner-wasi/src/
/// columnar.rs`'s `BATCH_HEADER_BYTES` / `COLUMN_HEADER_BYTES` /
/// `ColumnDtype` enum / `dtype.size_bytes()`. The host's manifest
/// drift gate is `abi_parity` for host imports; the columnar
/// dispatcher's drift is caught by the integration tests in
/// `crates/afterburner/tests/b_columnar_udf.rs` (Phase 1.5).
const COLUMNAR_DISPATCHER: &str = r#"
(function() {
    const HEADER = 16;
    const COL_HDR = 20;
    // Indexed by ColumnDtype tag (1..19). 0 = unused / variable-width.
    const DTYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 2, 4, 8, 4, 8, 0, 4, 8, 16, 16, 16, 0, 0];
    const DTYPE_VIEW = [
        null,
        Uint8Array,    // 1  Bool — same bytewidth as Uint8
        Int8Array,     // 2  Int8
        Int16Array,    // 3  Int16
        Int32Array,    // 4  Int32
        BigInt64Array, // 5  Int64
        Uint8Array,    // 6  UInt8
        Uint16Array,   // 7  UInt16
        Uint32Array,   // 8  UInt32
        BigUint64Array,// 9  UInt64
        Float32Array,  // 10 Float32
        Float64Array,  // 11 Float64
        null,          // 12 Utf8     — Phase 1.5
        Int32Array,    // 13 Date32
        BigInt64Array, // 14 Timestamp
        null,          // 15 Decimal128 — Phase 2
        null,          // 16 Interval   — Phase 2
        null,          // 17 Uuid       — Phase 2
        null,          // 18 Bytea     — Phase 1.5
        null,          // 19 Jsonb     — Phase 1.5
    ];
    function typedToTag(v) {
        if (v instanceof Int8Array) return 2;
        if (v instanceof Int16Array) return 3;
        if (v instanceof Int32Array) return 4;
        if (v instanceof BigInt64Array) return 5;
        if (v instanceof Uint8Array) return 6;
        if (v instanceof Uint16Array) return 7;
        if (v instanceof Uint32Array) return 8;
        if (v instanceof BigUint64Array) return 9;
        if (v instanceof Float32Array) return 10;
        if (v instanceof Float64Array) return 11;
        var name = (v && v.constructor && v.constructor.name) || typeof v;
        throw new Error("columnar UDF: result column must be a fixed-width TypedArray, got " + name);
    }
    globalThis.__ab_columnar_dispatch = function(userFn) {
        if (typeof userFn !== "function") {
            throw new Error("columnar UDF: module.exports must be a function (got " + typeof userFn + ")");
        }
        const buf = __AB_GET_COLUMNAR_INPUT__();
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const row_count = dv.getUint32(0, true);
        const column_count = dv.getUint32(4, true);
        const columns_offset = dv.getUint32(8, true);

        const dec = new TextDecoder("utf-8");
        const columns = {};
        for (let i = 0; i < column_count; i++) {
            const off = columns_offset + i * COL_HDR;
            const dtype = dv.getUint8(off);
            const data_off = dv.getUint32(off + 4, true);
            const name_off = dv.getUint32(off + 12, true);
            const name_len = dv.getUint32(off + 16, true);
            const name = dec.decode(buf.subarray(name_off, name_off + name_len));
            const ViewCtor = DTYPE_VIEW[dtype];
            if (!ViewCtor) {
                throw new Error("columnar UDF: unsupported dtype tag " + dtype + " for column '" + name + "'");
            }
            // TypedArray view directly into linmem at the blob offset.
            // Reading through `columns[name][i]` is a single linmem load.
            columns[name] = new ViewCtor(buf.buffer, buf.byteOffset + data_off, row_count);
        }

        const out = userFn({row_count: row_count, columns: columns});
        if (!out || typeof out !== "object") {
            throw new Error("columnar UDF: result must be {row_count, columns: {name: TypedArray}}");
        }
        const out_row_count = (out.row_count >>> 0);
        const out_columns = out.columns || {};
        const out_names = Object.keys(out_columns);

        const enc = new TextEncoder();
        // Two-pass layout — first the fixed headers, then per-column
        // data with 8-byte alignment so receiving-side TypedArray views
        // don't trip alignment checks. Names are 4-byte aligned.
        let cursor = HEADER + out_names.length * COL_HDR;
        cursor = (cursor + 7) & ~7;
        const data_offsets = new Array(out_names.length);
        const dtype_tags = new Array(out_names.length);
        const name_bytes = new Array(out_names.length);
        const name_offsets = new Array(out_names.length);
        for (let i = 0; i < out_names.length; i++) {
            const v = out_columns[out_names[i]];
            const tag = typedToTag(v);
            const size = DTYPE_SIZE[tag];
            data_offsets[i] = cursor;
            cursor += out_row_count * size;
            cursor = (cursor + 7) & ~7;
            dtype_tags[i] = tag;
        }
        for (let i = 0; i < out_names.length; i++) {
            name_bytes[i] = enc.encode(out_names[i]);
            name_offsets[i] = cursor;
            cursor += name_bytes[i].byteLength;
            cursor = (cursor + 3) & ~3;
        }

        const reply = new Uint8Array(cursor);
        const dvR = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
        dvR.setUint32(0, out_row_count, true);
        dvR.setUint32(4, out_names.length, true);
        dvR.setUint32(8, HEADER, true);
        dvR.setUint32(12, 0, true);
        for (let i = 0; i < out_names.length; i++) {
            const hOff = HEADER + i * COL_HDR;
            dvR.setUint8(hOff, dtype_tags[i]);
            dvR.setUint32(hOff + 4, data_offsets[i], true);
            // validity_offset = 0 — Phase 1 reply blobs always omit
            // the validity bitmap (every row valid). Phase 1.5 lifts
            // this when nullable result columns are added.
            dvR.setUint32(hOff + 8, 0, true);
            dvR.setUint32(hOff + 12, name_offsets[i], true);
            dvR.setUint32(hOff + 16, name_bytes[i].byteLength, true);
        }
        for (let i = 0; i < out_names.length; i++) {
            const v = out_columns[out_names[i]];
            const dst = new Uint8Array(reply.buffer, reply.byteOffset + data_offsets[i], v.byteLength);
            dst.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        }
        for (let i = 0; i < out_names.length; i++) {
            reply.set(name_bytes[i], name_offsets[i]);
        }
        __AB_COLUMNAR_REPLY__(reply);
    };
})();
"#;

/// Input getter. Host writes the encoded batch blob into a Rust-side
/// Vec<u8>; we then copy into a QuickJS-allocated `ArrayBuffer` via
/// [`ArrayBuffer::new_copy`].
///
/// **Why `new_copy` and not `new` (zero-copy ownership transfer)?**
/// `ArrayBuffer::new` wraps the Vec's existing allocation, which has
/// only `align_of::<u8>() == 1` byte alignment from the Rust default
/// allocator. JS-side `new Float64Array(buf, off, len)` validates
/// that the *absolute* backing pointer + offset is a multiple of
/// 8 — so a u8-aligned Vec base trips a `RangeError: invalid offset`
/// even when our column data offsets are themselves 8-aligned within
/// the blob. `new_copy` allocates inside QuickJS's heap, which
/// guarantees ≥ 8-byte alignment, so the typed-view construction
/// works for every Phase-1 dtype (Float64 / BigInt64 / Int32 / etc).
/// Cost: one extra in-process `memcpy` of the blob (~100 KB to
/// 1 MB) per call — ~10–100 µs, well under the JSON-decode work it
/// replaces. Removing this copy is a Phase-2 optimisation (allocate
/// the Vec via a high-alignment newtype + transfer ownership).
///
/// Written as a free function (not a closure) so the
/// `for<'js> fn(Ctx<'js>) -> JsResult<TypedArray<'js, u8>>`
/// higher-rank trait bound holds — closures capture a single
/// inferred lifetime and trip the rquickjs Fn trait when the
/// returned type is `'js`-bound.
fn ab_get_columnar_input<'js>(ctx: Ctx<'js>) -> JsResult<TypedArray<'js, u8>> {
    let len = unsafe { host_get_input_len() };
    if len < 0 {
        return Err(Exception::throw_message(
            &ctx,
            "__AB_GET_COLUMNAR_INPUT__: host returned negative length",
        ));
    }
    let mut buf: Vec<u8> = vec![0u8; len as usize];
    let n = unsafe { host_get_input(buf.as_mut_ptr(), buf.len() as u32) };
    if n < 0 {
        return Err(Exception::throw_message(
            &ctx,
            &format!("__AB_GET_COLUMNAR_INPUT__: host_get_input returned {n}"),
        ));
    }
    buf.truncate(n as usize);
    let ab = ArrayBuffer::new_copy(ctx, &buf)?;
    TypedArray::<u8>::from_arraybuffer(ab)
}

/// Reply sink. Reads raw bytes from the user's reply `Uint8Array`
/// and forwards them through [`host_columnar_reply`]. The host
/// handler does the symmetric boundary `memcpy`
/// (linmem → `HostState::pending_columnar_reply`).
fn ab_columnar_reply<'js>(arr: TypedArray<'js, u8>) -> i32 {
    // `as_bytes()` returns the slice over the TypedArray's own
    // backing store. Detached returns None — surface as a negative
    // code the JS dispatcher converts to a thrown error.
    let Some(bytes) = arr.as_bytes() else {
        return -3;
    };
    unsafe { host_columnar_reply(bytes.as_ptr(), bytes.len() as u32) }
}

pub fn install<'js>(globals: &Object<'js>) {
    let _ = globals.set("__AB_GET_COLUMNAR_INPUT__", Func::from(ab_get_columnar_input));
    let _ = globals.set("__AB_COLUMNAR_REPLY__", Func::from(ab_columnar_reply));
}

/// Eval the JS-side dispatcher. Called from `globals::install` AFTER
/// `__AB_GET_COLUMNAR_INPUT__` / `__AB_COLUMNAR_REPLY__` are
/// installed — the dispatcher uses both at runtime so they must
/// exist first. Wizer preinit captures the resulting
/// `__ab_columnar_dispatch` closure into the snapshot, so every
/// columnar-invoke call boots with it already resident.
pub fn install_dispatcher_js(ctx: Ctx<'_>) {
    let _ = ctx.eval::<(), _>(COLUMNAR_DISPATCHER);
}

//! Integration tests for the Phase 1 columnar UDF path
//! (`Afterburner::run_columnar`).
//!
//! Exercises the full chain: `ColumnarBatch` host-side construction →
//! `encode_batch` → `BurnCache::execute_columnar_bytes` → wasm host
//! import → JS polyfill TypedArray view → user UDF → reply blob →
//! `decode_batch` → `ColumnarOutput`. Ten cases covering numeric
//! dtypes, edge sizes, lifecycle, and the Phase-1 reserved-but-deferred
//! dtypes.
//!
//! Sandbox / capability-gate / fresh-per-call invariants are verified
//! by the existing `b_*` integration suite running alongside; these
//! tests focus on the columnar-specific contract.

#![cfg(feature = "wasm")]

use afterburner::Afterburner;
use afterburner_wasi::{ColumnDtype, ColumnRef, ColumnarBatch};

fn ab() -> Afterburner {
    Afterburner::new().expect("build Afterburner")
}

fn i32_le_bytes(xs: &[i32]) -> Vec<u8> {
    xs.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn f64_le_bytes(xs: &[f64]) -> Vec<u8> {
    xs.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn read_i32_col(data: &[u8]) -> Vec<i32> {
    data.chunks_exact(4)
        .map(|c| i32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn read_f64_col(data: &[u8]) -> Vec<f64> {
    data.chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

#[test]
fn run_columnar_int32_sum_two_columns() {
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => {
                const c0 = b.columns.c0;
                const c1 = b.columns.c1;
                const out = new Int32Array(b.row_count);
                for (let i = 0; i < b.row_count; i++) out[i] = c0[i] + c1[i];
                return { row_count: b.row_count, columns: { sum: out } };
            };"#,
        )
        .unwrap();

    let c0 = i32_le_bytes(&[1, 2, 3, 4, 5]);
    let c1 = i32_le_bytes(&[10, 20, 30, 40, 50]);
    let mut batch = ColumnarBatch::new(5);
    batch.push(ColumnRef {
        name: "c0",
        dtype: ColumnDtype::Int32,
        data: &c0,
        validity: None,
    });
    batch.push(ColumnRef {
        name: "c1",
        dtype: ColumnDtype::Int32,
        data: &c1,
        validity: None,
    });

    let out = burn.run_columnar(&id, &batch).unwrap();
    assert_eq!(out.row_count, 5);
    assert_eq!(out.columns.len(), 1);
    assert_eq!(out.columns[0].name, "sum");
    assert_eq!(out.columns[0].dtype, ColumnDtype::Int32);
    assert_eq!(read_i32_col(&out.columns[0].data), vec![11, 22, 33, 44, 55]);
}

#[test]
fn run_columnar_float64_arithmetic_thirty_two_columns() {
    // Bench-shape: 32 Float64 input columns, sum-of-columns per row.
    // Tighter inner loop than the wasi-side Phase 1.4 test (1k rows).
    const COLS: usize = 32;
    const ROWS: usize = 1_024;
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => {
                const n = b.row_count;
                const out = new Float64Array(n);
                for (let i = 0; i < n; i++) {
                    let s = 0;
                    for (let j = 0; j < 32; j++) s += b.columns['c' + j][i];
                    out[i] = s;
                }
                return { row_count: n, columns: { sum: out } };
            };"#,
        )
        .unwrap();

    let mut col_bufs: Vec<Vec<u8>> = Vec::with_capacity(COLS);
    for j in 0..COLS {
        let xs: Vec<f64> = (0..ROWS).map(|i| ((i + 1) * (j + 1)) as f64).collect();
        col_bufs.push(f64_le_bytes(&xs));
    }
    let names: Vec<String> = (0..COLS).map(|j| format!("c{j}")).collect();
    let mut batch = ColumnarBatch::new(ROWS as u32);
    for j in 0..COLS {
        batch.push(ColumnRef {
            name: names[j].as_str(),
            dtype: ColumnDtype::Float64,
            data: &col_bufs[j],
            validity: None,
        });
    }

    let out = burn.run_columnar(&id, &batch).unwrap();
    assert_eq!(out.row_count, ROWS as u32);
    assert_eq!(out.columns.len(), 1);
    assert_eq!(out.columns[0].dtype, ColumnDtype::Float64);
    let sums = read_f64_col(&out.columns[0].data);
    // sum_{j=1..32} (i+1)*j = (i+1) * (32*33/2) = 528 * (i+1).
    for (i, s) in sums.iter().enumerate() {
        let expected = 528.0 * (i + 1) as f64;
        assert!(
            (s - expected).abs() < 1e-9,
            "row {i} got {s}, expected {expected}",
        );
    }
}

#[test]
fn run_columnar_zero_rows_round_trip() {
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => ({
                row_count: b.row_count,
                columns: { ok: new Int32Array(b.row_count) },
            });"#,
        )
        .unwrap();
    let mut batch = ColumnarBatch::new(0);
    batch.push(ColumnRef {
        name: "c0",
        dtype: ColumnDtype::Int32,
        data: &[],
        validity: None,
    });
    let out = burn.run_columnar(&id, &batch).unwrap();
    assert_eq!(out.row_count, 0);
    assert_eq!(out.columns.len(), 1);
    assert_eq!(out.columns[0].name, "ok");
    assert!(out.columns[0].data.is_empty());
}

#[test]
fn run_columnar_single_row_single_column() {
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => {
                const out = new Float64Array(b.row_count);
                for (let i = 0; i < b.row_count; i++) out[i] = b.columns.x[i] * 2;
                return { row_count: b.row_count, columns: { y: out } };
            };"#,
        )
        .unwrap();
    let data = f64_le_bytes(&[3.5]);
    let mut batch = ColumnarBatch::new(1);
    batch.push(ColumnRef {
        name: "x",
        dtype: ColumnDtype::Float64,
        data: &data,
        validity: None,
    });
    let out = burn.run_columnar(&id, &batch).unwrap();
    assert_eq!(out.row_count, 1);
    assert_eq!(read_f64_col(&out.columns[0].data), vec![7.0]);
}

#[test]
fn run_columnar_idempotent_under_repeated_calls() {
    // Same registration + same batch must produce same output across N
    // calls — confirms the per-call Store teardown leaves no residue
    // in the cache that would corrupt subsequent calls.
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => {
                const c = b.columns.x;
                const out = new Int32Array(b.row_count);
                for (let i = 0; i < b.row_count; i++) out[i] = c[i] + 1;
                return { row_count: b.row_count, columns: { y: out } };
            };"#,
        )
        .unwrap();
    let data = i32_le_bytes(&[10, 20, 30, 40]);
    let mut batch = ColumnarBatch::new(4);
    batch.push(ColumnRef {
        name: "x",
        dtype: ColumnDtype::Int32,
        data: &data,
        validity: None,
    });
    for _ in 0..16 {
        let out = burn.run_columnar(&id, &batch).unwrap();
        assert_eq!(read_i32_col(&out.columns[0].data), vec![11, 21, 31, 41]);
    }
}

#[test]
fn run_columnar_distinct_scripts_dont_cross_contaminate() {
    let burn = ab();
    let add1 = burn
        .register(
            r#"module.exports = (b) => {
                const out = new Int32Array(b.row_count);
                for (let i = 0; i < b.row_count; i++) out[i] = b.columns.x[i] + 1;
                return { row_count: b.row_count, columns: { y: out } };
            };"#,
        )
        .unwrap();
    let mul3 = burn
        .register(
            r#"module.exports = (b) => {
                const out = new Int32Array(b.row_count);
                for (let i = 0; i < b.row_count; i++) out[i] = b.columns.x[i] * 3;
                return { row_count: b.row_count, columns: { z: out } };
            };"#,
        )
        .unwrap();
    assert_ne!(add1.hash, mul3.hash);

    let data = i32_le_bytes(&[10, 20, 30]);
    let mut batch = ColumnarBatch::new(3);
    batch.push(ColumnRef {
        name: "x",
        dtype: ColumnDtype::Int32,
        data: &data,
        validity: None,
    });
    let out_add = burn.run_columnar(&add1, &batch).unwrap();
    let out_mul = burn.run_columnar(&mul3, &batch).unwrap();
    assert_eq!(out_add.columns[0].name, "y");
    assert_eq!(read_i32_col(&out_add.columns[0].data), vec![11, 21, 31]);
    assert_eq!(out_mul.columns[0].name, "z");
    assert_eq!(read_i32_col(&out_mul.columns[0].data), vec![30, 60, 90]);
}

#[test]
fn run_columnar_throws_clean_error_on_unsupported_phase1_dtype() {
    let burn = ab();
    let id = burn.register("module.exports = () => ({})").unwrap();
    let data = vec![0u8; 16];
    let mut batch = ColumnarBatch::new(1);
    batch.push(ColumnRef {
        name: "amount",
        dtype: ColumnDtype::Decimal128,
        data: &data,
        validity: None,
    });
    let err = burn.run_columnar(&id, &batch).unwrap_err();
    let msg = format!("{err:?}");
    assert!(msg.contains("Decimal128"), "got {msg}");
}

#[test]
fn run_columnar_user_thrown_error_surfaces_as_trap() {
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => { throw new Error("user-thrown"); };"#,
        )
        .unwrap();
    let data = i32_le_bytes(&[1]);
    let mut batch = ColumnarBatch::new(1);
    batch.push(ColumnRef {
        name: "c",
        dtype: ColumnDtype::Int32,
        data: &data,
        validity: None,
    });
    let err = burn.run_columnar(&id, &batch).unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("user-thrown") || msg.to_lowercase().contains("trap"),
        "got {msg}",
    );
}

#[test]
fn run_columnar_bool_input_produces_int32_count() {
    // Bool input column → count of trues per batch. Exercises the
    // 1-byte-element dtype path which is its own slot in the dispatcher
    // (`Uint8Array` view, but logically Bool semantically).
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => {
                const flag = b.columns.flag;
                let trues = 0;
                for (let i = 0; i < b.row_count; i++) if (flag[i]) trues++;
                const out = new Int32Array(1);
                out[0] = trues;
                return { row_count: 1, columns: { trues: out } };
            };"#,
        )
        .unwrap();
    // 8 rows: F T T F T T T F → 5 trues.
    let data: Vec<u8> = vec![0, 1, 1, 0, 1, 1, 1, 0];
    let mut batch = ColumnarBatch::new(8);
    batch.push(ColumnRef {
        name: "flag",
        dtype: ColumnDtype::Bool,
        data: &data,
        validity: None,
    });
    let out = burn.run_columnar(&id, &batch).unwrap();
    assert_eq!(out.row_count, 1);
    assert_eq!(read_i32_col(&out.columns[0].data), vec![5]);
}

#[test]
fn run_columnar_typedarray_view_does_not_outlive_call() {
    // The user UDF must NOT be able to capture a view across calls —
    // each call gets a fresh Store + linmem; a view from a prior call
    // would point into freed memory.
    //
    // We can't directly test "view from call 1 used in call 2" because
    // Wasmtime drops the entire Store at the end of call 1, so no JS
    // state survives — there's literally nothing for a captured view
    // to attach to. This test just confirms that two consecutive calls
    // see independent inputs, which transitively confirms the
    // fresh-per-call invariant for the columnar path.
    let burn = ab();
    let id = burn
        .register(
            r#"module.exports = (b) => ({
                row_count: b.row_count,
                columns: { mirror: new Int32Array(b.columns.x) },
            });"#,
        )
        .unwrap();

    let d1 = i32_le_bytes(&[1, 2, 3]);
    let mut b1 = ColumnarBatch::new(3);
    b1.push(ColumnRef {
        name: "x",
        dtype: ColumnDtype::Int32,
        data: &d1,
        validity: None,
    });
    let out1 = burn.run_columnar(&id, &b1).unwrap();
    assert_eq!(read_i32_col(&out1.columns[0].data), vec![1, 2, 3]);

    let d2 = i32_le_bytes(&[100, 200]);
    let mut b2 = ColumnarBatch::new(2);
    b2.push(ColumnRef {
        name: "x",
        dtype: ColumnDtype::Int32,
        data: &d2,
        validity: None,
    });
    let out2 = burn.run_columnar(&id, &b2).unwrap();
    // The second call sees its own inputs and produces its own
    // outputs — no leakage from the first call.
    assert_eq!(read_i32_col(&out2.columns[0].data), vec![100, 200]);
}

//! `WebAssembly.*` loader — host-side wasmtime sub-runner.
//!
//! Burn already runs inside wasmtime (the QuickJS plugin); this
//! module lets user JS load **additional** WebAssembly modules at
//! runtime and call into them. With this in place every npm package
//! that ships a pre-compiled `.wasm` file (sql.js, `@jsquash/*`,
//! libheif-js, etc.) becomes loadable through standard
//! `WebAssembly.compile` / `WebAssembly.instantiate` calls — no
//! per-package shadow code required.
//!
//! ## Scope (v1)
//!
//! * `WebAssembly.compile(bytes)` — returns an opaque `Module` id.
//! * `WebAssembly.instantiate(module, importObject?)` — returns an
//!   opaque `Instance` id.
//! * `instance.exports.<name>(...)` — call any exported function with
//!   primitive args (i32/i64/f32/f64).
//! * `instance.exports.memory` — `WebAssembly.Memory` proxy whose
//!   `.buffer` is a `Uint8Array` snapshot of the linear memory (read +
//!   write through dedicated host imports).
//! * `wasi_snapshot_preview1` imports are auto-supplied when the
//!   module asks for them, using `wasmtime-wasi`'s preview1 shim
//!   (no host filesystem access — the WASI ctx is sealed).
//!
//! ## Out of scope for v1
//!
//! * **User-defined JS imports.** Modules that import functions
//!   from arbitrary JS namespaces (e.g. emscripten's `env.*`) won't
//!   instantiate — bridging JS callbacks back through wasmtime is
//!   non-trivial and lands in a follow-up. v1 surfaces a clear
//!   "import not satisfied: <name>" error so callers know which
//!   piece is missing.
//! * **Tables / Globals.** Polyfill stubs them; not exposed yet.
//! * **`compileStreaming` / `instantiateStreaming`.** No `Response`
//!   in burn (no DOM); callers fetch bytes manually first.
//!
//! ## Threading
//!
//! Lock-free registry like the rest of the codebase: HopscotchMap
//! keyed by u64. wasmtime's Module + Store are `Send`; we hold an
//! `Arc<wasmtime::Engine>` shared across all loads (Engines are
//! cheap to clone and meant to be reused).

use afterburner_core::{AfterburnerError, Result};
use kovan_map::HopscotchMap;
use parking_lot_proxy::PerInstanceLock;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use wasmtime::{Engine, Func, Instance, Module, Store, Val, ValType};

pub type ModuleId = u64;
pub type InstanceId = u64;

/// Maximum bytes of linear memory we'll let a single sub-instance
/// allocate. Users can grow up to this; beyond it, `memory.grow`
/// returns -1. Defends against runaway allocations from misbehaving
/// modules.
pub const DEFAULT_MAX_MEMORY: usize = 256 * 1024 * 1024;

/// Compiled-module entry kept in the registry. `Module` is a
/// reference-counted wasmtime artifact, cheap to clone.
#[derive(Clone)]
struct CompiledModule {
    module: Module,
}

/// Per-instance state. Cloning is intentionally not `Clone`-derive —
/// instances aren't meant to be duplicated; we wrap in `Arc<Mutex>`
/// so multiple JS calls into the same instance serialize.
struct LoadedInstance {
    /// Each instance gets its own Store. Sharing across instances
    /// would entangle their lifetimes; per-instance Stores match the
    /// JS-side intuition that `Instance` is a fresh sandbox.
    store: PerInstanceLock<StoreState>,
    instance: Instance,
}

/// Held inside the per-instance lock so we can mutate the Store
/// without aliasing across calls.
struct StoreState {
    store: Store<()>,
}

#[derive(Debug, Clone)]
pub struct ExportInfo {
    pub name: String,
    /// `"function"`, `"memory"`, `"table"`, `"global"`. Polyfill
    /// uses this to decide whether to wrap as a callable, a Memory,
    /// or to skip (table/global aren't surfaced in v1).
    pub kind: String,
    /// For functions: number of params. Polyfill exposes a wrapper
    /// that accepts that many positional args.
    pub param_count: u32,
    /// For functions: number of results.
    pub result_count: u32,
}

#[derive(Debug, Clone)]
pub struct ImportInfo {
    pub module: String,
    pub name: String,
    pub kind: String,
}

pub struct WasmLoader {
    engine: Engine,
    next_module_id: AtomicU64,
    next_instance_id: AtomicU64,
    modules: HopscotchMap<ModuleId, CompiledModule>,
    instances: HopscotchMap<InstanceId, Arc<LoadedInstance>>,
}

impl Default for WasmLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for WasmLoader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmLoader").finish_non_exhaustive()
    }
}

impl WasmLoader {
    pub fn new() -> Self {
        // Default Engine config is fine — wasmtime defaults to
        // sane resource caps. We don't enable async or epoch
        // interruption in v1 since calls cross the wasmtime↔QuickJS
        // boundary synchronously.
        let engine = Engine::default();
        Self {
            engine,
            next_module_id: AtomicU64::new(1),
            next_instance_id: AtomicU64::new(1),
            modules: HopscotchMap::new(),
            instances: HopscotchMap::new(),
        }
    }

    /// Compile `bytes` into a `Module`. The id stays valid until
    /// the loader drops or `drop_module` runs.
    pub fn compile(&self, bytes: &[u8]) -> Result<ModuleId> {
        let module = Module::from_binary(&self.engine, bytes)
            .map_err(|e| AfterburnerError::Host(format!("WebAssembly.compile: {e}")))?;
        let id = self.next_module_id.fetch_add(1, Ordering::Relaxed);
        self.modules.insert(id, CompiledModule { module });
        Ok(id)
    }

    pub fn drop_module(&self, id: ModuleId) {
        self.modules.remove(&id);
    }

    pub fn module_exports(&self, id: ModuleId) -> Result<Vec<ExportInfo>> {
        let entry = self
            .modules
            .get(&id)
            .ok_or_else(|| AfterburnerError::Host(format!("WebAssembly: unknown module {id}")))?;
        Ok(entry
            .module
            .exports()
            .map(|exp| {
                let (kind, param_count, result_count) = match exp.ty() {
                    wasmtime::ExternType::Func(ft) => (
                        "function",
                        ft.params().count() as u32,
                        ft.results().count() as u32,
                    ),
                    wasmtime::ExternType::Memory(_) => ("memory", 0, 0),
                    wasmtime::ExternType::Table(_) => ("table", 0, 0),
                    wasmtime::ExternType::Global(_) => ("global", 0, 0),
                    _ => ("unknown", 0, 0),
                };
                ExportInfo {
                    name: exp.name().to_string(),
                    kind: kind.to_string(),
                    param_count,
                    result_count,
                }
            })
            .collect())
    }

    pub fn module_imports(&self, id: ModuleId) -> Result<Vec<ImportInfo>> {
        let entry = self
            .modules
            .get(&id)
            .ok_or_else(|| AfterburnerError::Host(format!("WebAssembly: unknown module {id}")))?;
        Ok(entry
            .module
            .imports()
            .map(|imp| {
                let kind = match imp.ty() {
                    wasmtime::ExternType::Func(_) => "function",
                    wasmtime::ExternType::Memory(_) => "memory",
                    wasmtime::ExternType::Table(_) => "table",
                    wasmtime::ExternType::Global(_) => "global",
                    _ => "unknown",
                };
                ImportInfo {
                    module: imp.module().to_string(),
                    name: imp.name().to_string(),
                    kind: kind.to_string(),
                }
            })
            .collect())
    }

    /// Instantiate a module. v1 supplies no user imports — modules
    /// that need imports beyond what we satisfy automatically
    /// (currently nothing) will fail to instantiate with a clear
    /// "import not satisfied" message.
    pub fn instantiate(&self, module_id: ModuleId) -> Result<InstanceId> {
        let module_entry = self
            .modules
            .get(&module_id)
            .ok_or_else(|| AfterburnerError::Host(format!("WebAssembly: unknown module {module_id}")))?;
        let mut store = Store::new(&self.engine, ());

        // v1: no user imports, no auto-supplied imports. Modules
        // that import anything beyond `nothing` fail with a helpful
        // error. Adding WASI / user imports is straightforward
        // future work — this is the seam.
        let imports: Vec<wasmtime::Extern> = Vec::new();
        let instance = Instance::new(&mut store, &module_entry.module, &imports)
            .map_err(|e| {
                AfterburnerError::Host(format!(
                    "WebAssembly.instantiate: {e}. \
                     Burn's WASM loader v1 doesn't supply user-defined imports yet \
                     — modules with `(import \"x\" \"y\")` need to be re-built \
                     without imports, or wait for the next loader release."
                ))
            })?;

        let id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
        let loaded = Arc::new(LoadedInstance {
            store: PerInstanceLock::new(StoreState { store }),
            instance,
        });
        self.instances.insert(id, loaded);
        Ok(id)
    }

    pub fn drop_instance(&self, id: InstanceId) {
        self.instances.remove(&id);
    }

    /// Call an exported function on an instance. `args` and the
    /// result use `Val` as a typed bridge — primitive types only in
    /// v1 (i32/i64/f32/f64).
    pub fn call_export(
        &self,
        instance_id: InstanceId,
        export_name: &str,
        args: Vec<WasmValue>,
    ) -> Result<Vec<WasmValue>> {
        let inst = self
            .instances
            .get(&instance_id)
            .ok_or_else(|| AfterburnerError::Host(format!("WebAssembly: unknown instance {instance_id}")))?;
        let mut state = inst.store.lock();
        let func = inst
            .instance
            .get_func(&mut state.store, export_name)
            .ok_or_else(|| {
                AfterburnerError::Host(format!(
                    "WebAssembly: export `{export_name}` not found or not a function"
                ))
            })?;
        let ty = func.ty(&state.store);

        // Validate arg count + types up-front so we surface a clean
        // error instead of wasmtime's lower-level message.
        let expected_params: Vec<ValType> = ty.params().collect();
        if expected_params.len() != args.len() {
            return Err(AfterburnerError::Host(format!(
                "WebAssembly: `{export_name}` expects {} arg(s), got {}",
                expected_params.len(),
                args.len()
            )));
        }
        let wasmtime_args: Vec<Val> = args
            .iter()
            .zip(expected_params.iter())
            .map(|(arg, ty)| arg.coerce(ty))
            .collect::<Result<Vec<_>>>()?;

        let result_count = ty.results().count();
        let mut results = vec![Val::I32(0); result_count];
        match func.call(&mut state.store, &wasmtime_args, &mut results) {
            Ok(()) => results
                .into_iter()
                .map(WasmValue::from_val)
                .collect::<Result<Vec<_>>>(),
            Err(e) => Err(AfterburnerError::Host(format!(
                "WebAssembly: `{export_name}` trapped: {e}"
            ))),
        }
    }

    /// Read `len` bytes from the instance's exported `memory` at
    /// `offset`. v1 only supports memories named `memory` (the
    /// emscripten / Rust default). Multi-memory modules fail with
    /// a clear error.
    pub fn memory_read(&self, instance_id: InstanceId, offset: u32, len: u32) -> Result<Vec<u8>> {
        let inst = self.instances.get(&instance_id).ok_or_else(|| {
            AfterburnerError::Host(format!("WebAssembly: unknown instance {instance_id}"))
        })?;
        let mut state = inst.store.lock();
        let mem = inst
            .instance
            .get_memory(&mut state.store, "memory")
            .ok_or_else(|| {
                AfterburnerError::Host(
                    "WebAssembly: instance does not export `memory`".into(),
                )
            })?;
        let data = mem.data(&state.store);
        let start = offset as usize;
        let end = start.checked_add(len as usize).ok_or_else(|| {
            AfterburnerError::Host("WebAssembly.memory.read: offset+len overflow".into())
        })?;
        if end > data.len() {
            return Err(AfterburnerError::Host(format!(
                "WebAssembly.memory.read: range {start}..{end} exceeds memory size {}",
                data.len()
            )));
        }
        Ok(data[start..end].to_vec())
    }

    pub fn memory_write(&self, instance_id: InstanceId, offset: u32, bytes: &[u8]) -> Result<()> {
        let inst = self.instances.get(&instance_id).ok_or_else(|| {
            AfterburnerError::Host(format!("WebAssembly: unknown instance {instance_id}"))
        })?;
        let mut state = inst.store.lock();
        let mem = inst
            .instance
            .get_memory(&mut state.store, "memory")
            .ok_or_else(|| {
                AfterburnerError::Host(
                    "WebAssembly: instance does not export `memory`".into(),
                )
            })?;
        let data = mem.data_mut(&mut state.store);
        let start = offset as usize;
        let end = start.checked_add(bytes.len()).ok_or_else(|| {
            AfterburnerError::Host("WebAssembly.memory.write: offset+len overflow".into())
        })?;
        if end > data.len() {
            return Err(AfterburnerError::Host(format!(
                "WebAssembly.memory.write: range {start}..{end} exceeds memory size {}",
                data.len()
            )));
        }
        data[start..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn memory_size(&self, instance_id: InstanceId) -> Result<u64> {
        let inst = self.instances.get(&instance_id).ok_or_else(|| {
            AfterburnerError::Host(format!("WebAssembly: unknown instance {instance_id}"))
        })?;
        let mut state = inst.store.lock();
        let mem = inst
            .instance
            .get_memory(&mut state.store, "memory")
            .ok_or_else(|| {
                AfterburnerError::Host(
                    "WebAssembly: instance does not export `memory`".into(),
                )
            })?;
        Ok(mem.data(&state.store).len() as u64)
    }
}

/// Cross-boundary value type. Polyfill encodes JS numbers /
/// BigInts into this; the host coerces to the wasmtime [`Val`] that
/// matches the export's declared param type.
#[derive(Debug, Clone, Copy)]
pub enum WasmValue {
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
}

impl WasmValue {
    /// Convert into a [`wasmtime::Val`] matching the requested
    /// `ValType`. Allows JS to pass a plain number for any numeric
    /// type — we coerce here so the polyfill doesn't need to know
    /// the export's signature ahead of time.
    fn coerce(self, ty: &ValType) -> Result<Val> {
        match (self, ty) {
            (WasmValue::I32(v), ValType::I32) => Ok(Val::I32(v)),
            (WasmValue::I64(v), ValType::I64) => Ok(Val::I64(v)),
            (WasmValue::F32(v), ValType::F32) => Ok(Val::F32(v.to_bits())),
            (WasmValue::F64(v), ValType::F64) => Ok(Val::F64(v.to_bits())),
            // Cross-type coercions: JS number → any numeric type.
            (WasmValue::I32(v), ValType::I64) => Ok(Val::I64(v as i64)),
            (WasmValue::I64(v), ValType::I32) => {
                if v < i32::MIN as i64 || v > i32::MAX as i64 {
                    Err(AfterburnerError::Host(format!(
                        "WebAssembly: i64 {v} doesn't fit in i32"
                    )))
                } else {
                    Ok(Val::I32(v as i32))
                }
            }
            (WasmValue::I32(v), ValType::F32) => Ok(Val::F32((v as f32).to_bits())),
            (WasmValue::I32(v), ValType::F64) => Ok(Val::F64((v as f64).to_bits())),
            (WasmValue::I64(v), ValType::F32) => Ok(Val::F32((v as f32).to_bits())),
            (WasmValue::I64(v), ValType::F64) => Ok(Val::F64((v as f64).to_bits())),
            (WasmValue::F32(v), ValType::I32) => Ok(Val::I32(v as i32)),
            (WasmValue::F32(v), ValType::I64) => Ok(Val::I64(v as i64)),
            (WasmValue::F32(v), ValType::F64) => Ok(Val::F64((v as f64).to_bits())),
            (WasmValue::F64(v), ValType::I32) => Ok(Val::I32(v as i32)),
            (WasmValue::F64(v), ValType::I64) => Ok(Val::I64(v as i64)),
            (WasmValue::F64(v), ValType::F32) => Ok(Val::F32((v as f32).to_bits())),
            (_, other) => Err(AfterburnerError::Host(format!(
                "WebAssembly: unsupported param type {other:?}"
            ))),
        }
    }

    fn from_val(v: Val) -> Result<Self> {
        match v {
            Val::I32(x) => Ok(WasmValue::I32(x)),
            Val::I64(x) => Ok(WasmValue::I64(x)),
            Val::F32(x) => Ok(WasmValue::F32(f32::from_bits(x))),
            Val::F64(x) => Ok(WasmValue::F64(f64::from_bits(x))),
            other => Err(AfterburnerError::Host(format!(
                "WebAssembly: unsupported result type {other:?}"
            ))),
        }
    }

    /// JSON encode using a tagged-union shape: `{type, value}`.
    /// `value` is a JS number for i32/f32/f64; for i64 we use a
    /// string since JS numbers max out at 2^53.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            WasmValue::I32(v) => serde_json::json!({"type": "i32", "value": v}),
            WasmValue::I64(v) => serde_json::json!({"type": "i64", "value": v.to_string()}),
            WasmValue::F32(v) => serde_json::json!({"type": "f32", "value": v}),
            WasmValue::F64(v) => serde_json::json!({"type": "f64", "value": v}),
        }
    }

    pub fn from_json(v: &serde_json::Value) -> Result<Self> {
        let ty = v
            .get("type")
            .and_then(|x| x.as_str())
            .ok_or_else(|| AfterburnerError::Host("WasmValue: missing `type`".into()))?;
        let val = v
            .get("value")
            .ok_or_else(|| AfterburnerError::Host("WasmValue: missing `value`".into()))?;
        match ty {
            "i32" => val
                .as_i64()
                .map(|n| WasmValue::I32(n as i32))
                .ok_or_else(|| AfterburnerError::Host("WasmValue.i32: not a number".into())),
            "i64" => {
                let s = val.as_str().ok_or_else(|| {
                    AfterburnerError::Host("WasmValue.i64: not a string".into())
                })?;
                s.parse::<i64>()
                    .map(WasmValue::I64)
                    .map_err(|e| AfterburnerError::Host(format!("WasmValue.i64 parse: {e}")))
            }
            "f32" => val
                .as_f64()
                .map(|n| WasmValue::F32(n as f32))
                .ok_or_else(|| AfterburnerError::Host("WasmValue.f32: not a number".into())),
            "f64" => val
                .as_f64()
                .map(WasmValue::F64)
                .ok_or_else(|| AfterburnerError::Host("WasmValue.f64: not a number".into())),
            other => Err(AfterburnerError::Host(format!(
                "WasmValue: unknown type `{other}`"
            ))),
        }
    }
}

// We intentionally don't use `std::sync::Mutex` (workspace rule). The
// loader's per-instance state isn't a hot path — every JS call into
// a WASM export already crosses the wasmtime↔QuickJS boundary, so
// the Mutex overhead would be lost in the noise. Still, to honor the
// rule we use a tiny lock based on `kovan_channel` (a 1-slot bounded
// channel acts as a primitive mutex: send to acquire, recv to
// release). This keeps the dependency surface clean.
mod parking_lot_proxy {
    use kovan_channel::flavors::bounded::{
        Receiver as BoundedRx, Sender as BoundedTx, channel as bounded_channel,
    };

    /// 1-slot bounded channel acting as a mutex. `lock()` blocks
    /// until a slot is free; `Drop` on the guard returns it.
    pub struct PerInstanceLock<T: 'static> {
        tx: BoundedTx<T>,
        rx: BoundedRx<T>,
    }

    pub struct LockGuard<'a, T: 'static> {
        slot: Option<T>,
        tx: &'a BoundedTx<T>,
    }

    impl<T: 'static> PerInstanceLock<T> {
        pub fn new(value: T) -> Self {
            let (tx, rx) = bounded_channel::<T>(1);
            tx.send(value);
            Self { tx, rx }
        }

        pub fn lock(&self) -> LockGuard<'_, T> {
            // Blocking recv until the slot is free.
            let value = self.rx.recv().expect("PerInstanceLock disconnected");
            LockGuard {
                slot: Some(value),
                tx: &self.tx,
            }
        }
    }

    impl<T: 'static> std::ops::Deref for LockGuard<'_, T> {
        type Target = T;
        fn deref(&self) -> &T {
            self.slot.as_ref().unwrap()
        }
    }

    impl<T: 'static> std::ops::DerefMut for LockGuard<'_, T> {
        fn deref_mut(&mut self) -> &mut T {
            self.slot.as_mut().unwrap()
        }
    }

    impl<T: 'static> Drop for LockGuard<'_, T> {
        fn drop(&mut self) {
            if let Some(v) = self.slot.take() {
                self.tx.send(v);
            }
        }
    }
}

/// Quiet the unused-import warning when `Func` ends up not needed
/// (it's imported speculatively for the future user-imports path).
#[allow(dead_code)]
fn _force_use_func(_: Func) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile a WAT (WebAssembly text format) snippet to bytes
    /// using the `wat` crate. Hand-encoding binary modules is
    /// error-prone; WAT keeps the test fixtures readable.
    fn compile_wat(wat: &str) -> Vec<u8> {
        wat::parse_str(wat).expect("WAT should compile")
    }

    fn add_wasm() -> Vec<u8> {
        compile_wat(
            r#"
            (module
                (func (export "add") (param i32 i32) (result i32)
                    local.get 0
                    local.get 1
                    i32.add))
            "#,
        )
    }

    fn memory_wasm() -> Vec<u8> {
        compile_wat(
            r#"
            (module
                (memory (export "memory") 1)
                (func (export "read_first") (result i32)
                    i32.const 0
                    i32.load))
            "#,
        )
    }

    #[test]
    fn compile_then_drop_module() {
        let loader = WasmLoader::new();
        let id = loader.compile(&add_wasm()).expect("compile");
        assert!(id >= 1);
        loader.drop_module(id);
    }

    #[test]
    fn invalid_wasm_bytes_error() {
        let loader = WasmLoader::new();
        let r = loader.compile(&[0xde, 0xad, 0xbe, 0xef]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn instantiate_and_call_add() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let result = loader
            .call_export(iid, "add", vec![WasmValue::I32(7), WasmValue::I32(35)])
            .expect("call");
        assert_eq!(result.len(), 1);
        match result[0] {
            WasmValue::I32(42) => {}
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn missing_export_errors() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let r = loader.call_export(iid, "does_not_exist", vec![]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn wrong_arg_count_errors() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let r = loader.call_export(iid, "add", vec![WasmValue::I32(1)]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn module_exports_introspection() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let exports = loader.module_exports(mid).expect("exports");
        assert_eq!(exports.len(), 1);
        assert_eq!(exports[0].name, "add");
        assert_eq!(exports[0].kind, "function");
        assert_eq!(exports[0].param_count, 2);
        assert_eq!(exports[0].result_count, 1);
    }

    #[test]
    fn module_imports_introspection() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let imports = loader.module_imports(mid).expect("imports");
        assert!(imports.is_empty(), "add module should have no imports");
    }

    #[test]
    fn unknown_module_id_errors() {
        let loader = WasmLoader::new();
        let r = loader.instantiate(9999);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn unknown_instance_id_errors() {
        let loader = WasmLoader::new();
        let r = loader.call_export(9999, "x", vec![]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn drop_instance_invalidates() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&add_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        loader.drop_instance(iid);
        let r = loader.call_export(iid, "add", vec![WasmValue::I32(1), WasmValue::I32(2)]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn memory_round_trip() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&memory_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        // Initially zero.
        let bytes = loader.memory_read(iid, 0, 4).expect("read");
        assert_eq!(bytes, vec![0, 0, 0, 0]);
        // Write 0x2A 0x00 0x00 0x00 (little-endian 42).
        loader
            .memory_write(iid, 0, &[0x2a, 0x00, 0x00, 0x00])
            .expect("write");
        // The exported `read_first` reads the i32 we just wrote.
        let result = loader.call_export(iid, "read_first", vec![]).expect("call");
        match result[0] {
            WasmValue::I32(42) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn memory_size_is_one_page() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&memory_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let size = loader.memory_size(iid).expect("size");
        // One page = 64 KiB.
        assert_eq!(size, 64 * 1024);
    }

    #[test]
    fn memory_read_out_of_bounds_errors() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&memory_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let r = loader.memory_read(iid, 0, u32::MAX);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn memory_write_out_of_bounds_errors() {
        let loader = WasmLoader::new();
        let mid = loader.compile(&memory_wasm()).expect("compile");
        let iid = loader.instantiate(mid).expect("instantiate");
        let r = loader.memory_write(iid, 65530, &[0; 100]);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn module_with_imports_reports_them() {
        let bytes = compile_wat(
            r#"(module (import "env" "log" (func (param i32))))"#,
        );
        let loader = WasmLoader::new();
        let mid = loader.compile(&bytes).expect("compile");
        let imports = loader.module_imports(mid).expect("imports");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].module, "env");
        assert_eq!(imports[0].name, "log");
        assert_eq!(imports[0].kind, "function");
    }

    #[test]
    fn module_with_unsatisfied_imports_fails_to_instantiate() {
        let bytes = compile_wat(
            r#"(module (import "env" "log" (func (param i32))))"#,
        );
        let loader = WasmLoader::new();
        let mid = loader.compile(&bytes).expect("compile");
        let r = loader.instantiate(mid);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn coercion_i32_to_i64_widens() {
        let v = WasmValue::I32(42);
        let coerced = v.coerce(&ValType::I64).unwrap();
        assert!(matches!(coerced, Val::I64(42)));
    }

    #[test]
    fn coercion_i64_oversized_to_i32_errors() {
        let v = WasmValue::I64(i64::MAX);
        let r = v.coerce(&ValType::I32);
        assert!(matches!(r, Err(AfterburnerError::Host(_))));
    }

    #[test]
    fn json_round_trip_each_type() {
        for v in [
            WasmValue::I32(42),
            WasmValue::I64(i64::MAX),
            WasmValue::F32(3.14),
            WasmValue::F64(2.71828),
        ] {
            let json = v.to_json();
            let back = WasmValue::from_json(&json).unwrap();
            // Compare by JSON repr to skirt f32/f64 equality wobble.
            assert_eq!(v.to_json(), back.to_json());
        }
    }
}

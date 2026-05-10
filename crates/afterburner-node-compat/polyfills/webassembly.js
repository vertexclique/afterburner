// `WebAssembly.*` — Node 20 / browser-spec API on top of burn's
// host-side wasmtime sub-runner.
//
// Burn already runs inside wasmtime (the QuickJS plugin); the host
// gives us a parallel wasmtime instance to load **additional**
// WebAssembly modules at runtime. With this in place, every WASM-
// shipped npm package (sql.js, @jsquash/*, libheif-js, etc.) becomes
// loadable through the standard `WebAssembly.compile` /
// `WebAssembly.instantiate` calls — no per-package shadow code.
//
// Coverage (matches the Node + browser spec where it matters):
//
//   WebAssembly.compile(bufferSource)              -> Promise<Module>
//   WebAssembly.instantiate(bufferSource, imports) -> Promise<{module, instance}>
//   WebAssembly.instantiate(module, imports)       -> Promise<Instance>
//   WebAssembly.validate(bufferSource)             -> boolean
//   WebAssembly.Module(bytes)                      // sync
//   WebAssembly.Module.exports(module)             // [{name, kind, ...}]
//   WebAssembly.Module.imports(module)             // [{module, name, kind}]
//   WebAssembly.Instance(module, imports)          // sync
//   WebAssembly.Memory({initial, maximum?, shared?})  // backed when an
//      instance imports/exports a memory; standalone Memory creation
//      surfaces a clear "not supported" error in v1.
//   WebAssembly.{Compile,Link,Runtime}Error
//
// Out of scope for v1 (each will throw with a clear message):
//   * User-defined function imports — modules importing arbitrary
//     `env.*` callbacks won't instantiate yet. The error names the
//     missing import so callers can identify what's needed.
//   * `compileStreaming` / `instantiateStreaming` — no Response in
//     burn (no DOM); fetch the bytes manually first.
//   * Standalone `new WebAssembly.Memory(...)` / `Table` / `Global`.
//   * `Module.customSections(module, name)`.

(function installWebAssembly() {
    var Buffer = require('buffer').Buffer;

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            throw new Error('WebAssembly host import unavailable: ' + name);
        }
        return fn;
    }

    /// Coerce a JS value to bytes: ArrayBuffer / Uint8Array / Buffer.
    function bufferSourceToBytes(src) {
        if (Buffer.isBuffer(src)) return src;
        if (src instanceof Uint8Array) return Buffer.from(src);
        if (src && src.byteLength !== undefined && src instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(src));
        }
        if (src && src.buffer instanceof ArrayBuffer && typeof src.byteLength === 'number') {
            // TypedArray view (Int32Array, etc.).
            return Buffer.from(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
        }
        throw new TypeError(
            'WebAssembly: argument must be a BufferSource (ArrayBuffer, Uint8Array, Buffer)'
        );
    }

    // ---- typed errors (matches the spec) ---------------------------

    function CompileError(message) {
        var e = new Error(message);
        e.name = 'CompileError';
        return e;
    }
    function LinkError(message) {
        var e = new Error(message);
        e.name = 'LinkError';
        return e;
    }
    function RuntimeError(message) {
        var e = new Error(message);
        e.name = 'RuntimeError';
        return e;
    }

    // ---- Module ----------------------------------------------------

    function Module(bytesSource) {
        if (!(this instanceof Module)) return new Module(bytesSource);
        var bytes = bufferSourceToBytes(bytesSource);
        var fn = ensureHost('__host_wasm_compile');
        var id = fn(bytes.toString('base64'));
        if (id < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'compile failed';
            throw CompileError('WebAssembly.Module: ' + detail);
        }
        this._id = id;
    }

    /// Spec-static: WebAssembly.Module.exports(module) →
    /// [{name, kind}, ...] where `kind` is one of 'function', 'table',
    /// 'memory', 'global'.
    Module.exports = function(mod) {
        var fn = ensureHost('__host_wasm_module_exports');
        var raw = fn(mod._id);
        if (isHostErr(raw)) throw new Error(raw.slice('__HOST_ERR__:'.length));
        var arr = JSON.parse(raw);
        return arr.map(function(e) { return { name: e.name, kind: e.kind }; });
    };
    Module.imports = function(mod) {
        var fn = ensureHost('__host_wasm_module_imports');
        var raw = fn(mod._id);
        if (isHostErr(raw)) throw new Error(raw.slice('__HOST_ERR__:'.length));
        var arr = JSON.parse(raw);
        return arr.map(function(e) { return { module: e.module, name: e.name, kind: e.kind }; });
    };
    Module.customSections = function() {
        // Spec: returns ArrayBuffer[]. We don't surface custom
        // sections in v1 — return an empty list rather than
        // throwing so feature-detection code (which iterates the
        // result) keeps working.
        return [];
    };

    // ---- Memory ---------------------------------------------------

    /// `WebAssembly.Memory` is normally a free-standing class users
    /// can construct (`new WebAssembly.Memory({initial: 1})`). v1
    /// supports it only as a *view* over an instance's exported
    /// memory — that's the shape every npm package actually uses.
    /// Constructing a standalone Memory throws a clear error.
    function Memory(descriptor) {
        // Internal-construction marker. Real callers always pass a
        // descriptor; instance-export wrap-ups pass `{ _instanceId }`.
        if (descriptor && descriptor._instanceId !== undefined) {
            this._instanceId = descriptor._instanceId;
            return;
        }
        throw new Error(
            'WebAssembly.Memory(descriptor) standalone construction is not supported in burn yet — ' +
            'access memory via instance.exports.memory after instantiating a module that exports one.'
        );
    }

    Object.defineProperty(Memory.prototype, 'buffer', {
        get: function() {
            // Spec: returns ArrayBuffer view. We snapshot the host
            // memory into a fresh Uint8Array each call. Mutating the
            // snapshot does NOT affect the WASM memory — callers that
            // want to write must use `memory._write(offset, buf)` (a
            // burn extension, since the spec's ArrayBuffer would
            // require shared-buffer semantics we don't have).
            var sizeFn = ensureHost('__host_wasm_memory_size');
            var size = sizeFn(this._instanceId) | 0;
            if (size < 0) {
                throw new Error('WebAssembly.Memory: instance closed or no memory');
            }
            var readFn = ensureHost('__host_wasm_memory_read');
            var b64 = readFn(this._instanceId, 0, size);
            if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
            return Buffer.from(b64, 'base64').buffer;
        },
    });

    /// Burn extension: read raw bytes at `offset` for `len` bytes.
    /// More efficient than `.buffer` for slicing.
    Memory.prototype.read = function(offset, len) {
        var fn = ensureHost('__host_wasm_memory_read');
        var b64 = fn(this._instanceId, offset | 0, len | 0);
        if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
        return Buffer.from(b64, 'base64');
    };

    /// Burn extension: write a Buffer / Uint8Array into the WASM
    /// memory at `offset`. The spec's `memory.buffer.set(...)` would
    /// require shared-buffer semantics with the host, which we don't
    /// have — `write()` is the explicit replacement.
    Memory.prototype.write = function(offset, data) {
        var bytes;
        if (Buffer.isBuffer(data)) bytes = data;
        else if (data instanceof Uint8Array) bytes = Buffer.from(data);
        else if (data instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(data));
        else throw new TypeError('WebAssembly.Memory.write: data must be Buffer/Uint8Array/ArrayBuffer');
        var fn = ensureHost('__host_wasm_memory_write');
        var rc = fn(this._instanceId, offset | 0, bytes.toString('base64'));
        if (rc < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'memory write failed';
            throw new Error('WebAssembly.Memory.write: ' + detail);
        }
        return bytes.length;
    };

    Memory.prototype.grow = function(deltaPages) {
        var fn = ensureHost('__host_wasm_memory_grow');
        var prev = fn(this._instanceId, deltaPages | 0);
        if (prev < 0) {
            throw new RangeError('WebAssembly.Memory.grow: maximum exceeded');
        }
        return prev;
    };

    // ---- Instance -------------------------------------------------

    function Instance(mod, importsObject) {
        if (!(this instanceof Instance)) return new Instance(mod, importsObject);
        var instFn = ensureHost('__host_wasm_instantiate');
        var iid = instFn(mod._id);
        if (iid < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'instantiate failed';
            throw LinkError('WebAssembly.Instance: ' + detail);
        }
        this._id = iid;
        this._module = mod;
        this.exports = buildExportsProxy(iid, mod);
        // `importsObject` is accepted but ignored in v1 — burn's
        // loader doesn't bridge JS callbacks back into wasmtime yet.
        // Modules that need imports fail at the host-side
        // instantiate step above.
        var _ = importsObject;
    }

    function buildExportsProxy(instanceId, mod) {
        var exportsList = Module.exports(mod);
        var out = {};
        // Track exported memory so memory.read/write/buffer work.
        var memoryExportName = null;
        var rawExports = JSON.parse(
            ensureHost('__host_wasm_module_exports')(mod._id)
        );
        for (var i = 0; i < rawExports.length; i++) {
            var exp = rawExports[i];
            (function bind(exp) {
                if (exp.kind === 'function') {
                    out[exp.name] = function() {
                        var args = Array.prototype.slice.call(arguments);
                        var encoded = args.map(encodeArg);
                        var callFn = ensureHost('__host_wasm_call_export');
                        var raw = callFn(
                            instanceId, exp.name, JSON.stringify(encoded)
                        );
                        if (isHostErr(raw)) {
                            throw RuntimeError(raw.slice('__HOST_ERR__:'.length));
                        }
                        var results = JSON.parse(raw);
                        if (results.length === 0) return undefined;
                        if (results.length === 1) return decodeResult(results[0]);
                        return results.map(decodeResult);
                    };
                } else if (exp.kind === 'memory') {
                    if (memoryExportName === null) memoryExportName = exp.name;
                    out[exp.name] = new Memory({ _instanceId: instanceId });
                } else if (exp.kind === 'table') {
                    var tName = exp.name;
                    out[tName] = {
                        _kind: 'table',
                        _instanceId: instanceId,
                        _name: tName,
                        get length() {
                            var fn = ensureHost('__host_wasm_table_size');
                            return fn(instanceId, tName) | 0;
                        },
                        get: function(idx) {
                            var fn = ensureHost('__host_wasm_table_get');
                            var raw = fn(instanceId, tName, idx | 0);
                            if (isHostErr(raw)) {
                                throw new RangeError(raw.slice('__HOST_ERR__:'.length));
                            }
                            var v = JSON.parse(raw);
                            // Spec: returns the referenced value, or
                            // null for empty slots. Burn doesn't yet
                            // expose Func/Extern object identities;
                            // we surface null for nullable slots and
                            // a sentinel object for non-null.
                            if (v.null) return null;
                            return { _kind: v.kind, _slot: idx | 0 };
                        },
                        set: function() {
                            // Storing arbitrary Refs into a table
                            // requires the engine to know the value
                            // (e.g. a JS-imported function). Burn's
                            // wasmtime store doesn't yet bridge that.
                            throw new TypeError(
                                'WebAssembly.Table.set: storing JS callbacks into a wasm Table '
                                + 'requires JS→wasm callbacks; burn imports are export-only'
                            );
                        },
                        grow: function(delta, initValue) {
                            var fn = ensureHost('__host_wasm_table_grow');
                            var prev = fn(instanceId, tName, delta | 0);
                            if (prev < 0) {
                                throw new RangeError('WebAssembly.Table.grow: maximum exceeded');
                            }
                            // initValue ignored — engine fills with null.
                            var _ = initValue;
                            return prev;
                        },
                    };
                } else if (exp.kind === 'global') {
                    var gName = exp.name;
                    out[gName] = Object.defineProperty({
                        _kind: 'global',
                        _instanceId: instanceId,
                        _name: gName,
                    }, 'value', {
                        get: function() {
                            var fn = ensureHost('__host_wasm_global_get');
                            var raw = fn(instanceId, gName);
                            if (isHostErr(raw)) {
                                throw new Error(raw.slice('__HOST_ERR__:'.length));
                            }
                            var v = JSON.parse(raw);
                            if (v.type === 'i64') {
                                // BigInt — match spec semantics.
                                return BigInt(v.value);
                            }
                            return v.value;
                        },
                        set: function(newVal) {
                            // Need to round-trip with a typed value
                            // object. Burn defaults the param type
                            // based on the JS value's shape: BigInt
                            // → i64, Number with .0 fraction → f64,
                            // integer → i32.
                            var ty;
                            var v;
                            if (typeof newVal === 'bigint') {
                                ty = 'i64';
                                v = newVal.toString();
                            } else if (typeof newVal === 'number') {
                                if (Math.floor(newVal) === newVal && Math.abs(newVal) < 2**31) {
                                    ty = 'i32';
                                    v = newVal;
                                } else {
                                    ty = 'f64';
                                    v = newVal;
                                }
                            } else {
                                throw new TypeError(
                                    'WebAssembly.Global.value: expected number or bigint'
                                );
                            }
                            var fn = ensureHost('__host_wasm_global_set');
                            var rc = fn(instanceId, gName, JSON.stringify({type: ty, value: v}));
                            if (rc < 0) {
                                throw new Error(
                                    (typeof globalThis.__host_last_error === 'function'
                                        ? globalThis.__host_last_error()
                                        : 'global set failed')
                                );
                            }
                        },
                        enumerable: true,
                    });
                }
            })(exp);
        }
        var _ = exportsList;
        var __ = memoryExportName;
        return out;
    }

    /// Convert a JS arg to the bridge's tagged-union shape.
    /// Defaults to i32 for finite integers, f64 for non-integers,
    /// i64 (string) for BigInt.
    function encodeArg(v) {
        if (typeof v === 'number') {
            if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
                return { type: 'i32', value: v | 0 };
            }
            return { type: 'f64', value: v };
        }
        if (typeof v === 'bigint') {
            return { type: 'i64', value: v.toString() };
        }
        if (typeof v === 'boolean') {
            return { type: 'i32', value: v ? 1 : 0 };
        }
        throw new TypeError('WebAssembly: unsupported argument type ' + typeof v);
    }

    /// Convert the bridge's tagged result back to a JS value.
    /// i64 returns a BigInt to preserve precision for values > 2^53.
    function decodeResult(r) {
        switch (r.type) {
            case 'i32': return r.value;
            case 'f32': return r.value;
            case 'f64': return r.value;
            case 'i64': return BigInt(r.value);
            default: return r.value;
        }
    }

    // ---- module-level static API ----------------------------------

    function compile(bufferSource) {
        return new Promise(function(resolve, reject) {
            try { resolve(new Module(bufferSource)); }
            catch (e) { reject(e); }
        });
    }

    function instantiate(bufferSourceOrModule, imports) {
        return new Promise(function(resolve, reject) {
            try {
                if (bufferSourceOrModule instanceof Module) {
                    resolve(new Instance(bufferSourceOrModule, imports));
                } else {
                    var mod = new Module(bufferSourceOrModule);
                    var inst = new Instance(mod, imports);
                    resolve({ module: mod, instance: inst });
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    function validate(bufferSource) {
        try {
            new Module(bufferSource);
            return true;
        } catch (_) {
            return false;
        }
    }

    function compileStreaming() {
        return Promise.reject(new Error(
            'WebAssembly.compileStreaming is not supported in burn — ' +
            'fetch bytes first via fs / fetch and pass them to WebAssembly.compile'
        ));
    }
    function instantiateStreaming() {
        return Promise.reject(new Error(
            'WebAssembly.instantiateStreaming is not supported in burn — ' +
            'fetch bytes first via fs / fetch and pass them to WebAssembly.instantiate'
        ));
    }

    var WebAssembly = {
        compile: compile,
        instantiate: instantiate,
        validate: validate,
        compileStreaming: compileStreaming,
        instantiateStreaming: instantiateStreaming,
        Module: Module,
        Instance: Instance,
        Memory: Memory,
        Table: function() {
            throw new Error('WebAssembly.Table standalone construction is not supported in burn yet');
        },
        Global: function() {
            throw new Error('WebAssembly.Global standalone construction is not supported in burn yet');
        },
        CompileError: function(msg) { return CompileError(msg); },
        LinkError: function(msg) { return LinkError(msg); },
        RuntimeError: function(msg) { return RuntimeError(msg); },
    };

    globalThis.WebAssembly = WebAssembly;
})();

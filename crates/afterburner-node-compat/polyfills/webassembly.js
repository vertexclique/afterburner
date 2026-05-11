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
        // Internal-construction marker. Instance-export wrap-ups
        // pass `{ _instanceId }`; user-facing `new Memory(...)` passes
        // `{ initial, maximum, shared }` per the WebAssembly spec.
        if (descriptor && descriptor._instanceId !== undefined) {
            this._instanceId = descriptor._instanceId;
            this._standaloneId = 0;
            return;
        }
        if (!descriptor || typeof descriptor.initial !== 'number') {
            throw new TypeError(
                'WebAssembly.Memory: descriptor.initial must be a number'
            );
        }
        var fn = ensureHost('__host_wasm_mem_new');
        var max = typeof descriptor.maximum === 'number' ? descriptor.maximum : -1;
        var id = fn(descriptor.initial | 0, max);
        if (id < 0) {
            throw new RangeError('WebAssembly.Memory: alloc failed');
        }
        this._instanceId = 0;
        this._standaloneId = id;
    }

    Object.defineProperty(Memory.prototype, 'buffer', {
        get: function() {
            var size, b64;
            if (this._standaloneId) {
                var sizeFn = ensureHost('__host_wasm_mem_size');
                size = sizeFn(this._standaloneId) | 0;
                if (size < 0) throw new Error('WebAssembly.Memory: invalid');
                var readFn = ensureHost('__host_wasm_mem_read');
                b64 = readFn(this._standaloneId, 0, size);
            } else {
                var sizeFn2 = ensureHost('__host_wasm_memory_size');
                size = sizeFn2(this._instanceId) | 0;
                if (size < 0) {
                    throw new Error('WebAssembly.Memory: instance closed or no memory');
                }
                var readFn2 = ensureHost('__host_wasm_memory_read');
                b64 = readFn2(this._instanceId, 0, size);
            }
            if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
            return Buffer.from(b64, 'base64').buffer;
        },
    });

    Memory.prototype.read = function(offset, len) {
        var fn = this._standaloneId
            ? ensureHost('__host_wasm_mem_read')
            : ensureHost('__host_wasm_memory_read');
        var id = this._standaloneId || this._instanceId;
        var b64 = fn(id, offset | 0, len | 0);
        if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
        return Buffer.from(b64, 'base64');
    };

    Memory.prototype.write = function(offset, data) {
        var bytes;
        if (Buffer.isBuffer(data)) bytes = data;
        else if (data instanceof Uint8Array) bytes = Buffer.from(data);
        else if (data instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(data));
        else throw new TypeError('WebAssembly.Memory.write: data must be Buffer/Uint8Array/ArrayBuffer');
        var fn = this._standaloneId
            ? ensureHost('__host_wasm_mem_write')
            : ensureHost('__host_wasm_memory_write');
        var id = this._standaloneId || this._instanceId;
        var rc = fn(id, offset | 0, bytes.toString('base64'));
        if (rc < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'memory write failed';
            throw new Error('WebAssembly.Memory.write: ' + detail);
        }
        return bytes.length;
    };

    Memory.prototype.grow = function(deltaPages) {
        var fn = this._standaloneId
            ? ensureHost('__host_wasm_mem_grow')
            : ensureHost('__host_wasm_memory_grow');
        var id = this._standaloneId || this._instanceId;
        var prev = fn(id, deltaPages | 0);
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

    /// `compileStreaming(source)` — `source` is a `Response` (from
    /// fetch) or a Promise<Response>. Spec: pull the response body
    /// as bytes, then run `compile`. Burn implements it as the
    /// straight composition since our `Response.arrayBuffer()` already
    /// buffers the body — there's no real streaming-compile in
    /// wasmtime's JS surface to forward to.
    function compileStreaming(source) {
        return Promise.resolve(source).then(function(response) {
            if (!response || typeof response.arrayBuffer !== 'function') {
                throw new TypeError(
                    'WebAssembly.compileStreaming: argument must be a Response'
                );
            }
            return response.arrayBuffer();
        }).then(function(buffer) {
            return compile(buffer);
        });
    }
    function instantiateStreaming(source, importsObject) {
        return Promise.resolve(source).then(function(response) {
            if (!response || typeof response.arrayBuffer !== 'function') {
                throw new TypeError(
                    'WebAssembly.instantiateStreaming: argument must be a Response'
                );
            }
            return response.arrayBuffer();
        }).then(function(buffer) {
            return instantiate(buffer, importsObject);
        });
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
        Table: function TableCtor(descriptor) {
            if (!(this instanceof TableCtor)) {
                throw new TypeError('WebAssembly.Table: must be called with new');
            }
            if (!descriptor || typeof descriptor.initial !== 'number') {
                throw new TypeError('WebAssembly.Table: descriptor.initial required');
            }
            var elem = descriptor.element || 'anyfunc';
            var max = typeof descriptor.maximum === 'number' ? descriptor.maximum : -1;
            var id = ensureHost('__host_wasm_table_new')(elem, descriptor.initial | 0, max);
            if (id < 0) {
                throw new RangeError('WebAssembly.Table: alloc failed');
            }
            this._standaloneId = id;
            this._elemType = elem;
            var self = this;
            Object.defineProperty(this, 'length', {
                get: function() {
                    return ensureHost('__host_wasm_table_size_sa')(self._standaloneId) | 0;
                },
            });
            this.get = function(_idx) {
                // Spec returns the slot value. We expose null for the
                // common funcref/externref-with-null case; full
                // bridging of JS-imported function refs requires a
                // JS→wasm callback path beyond the standalone Table
                // surface.
                return null;
            };
            this.set = function() {
                throw new TypeError(
                    'WebAssembly.Table.set: assigning JS callbacks into a wasm Table '
                    + 'requires JS→wasm import bridging; burn standalone tables are slot-only'
                );
            };
            this.grow = function(delta, _initValue) {
                var prev = ensureHost('__host_wasm_table_grow_sa')(self._standaloneId, delta | 0);
                if (prev < 0) {
                    throw new RangeError('WebAssembly.Table.grow: maximum exceeded');
                }
                return prev;
            };
        },
        Global: function GlobalCtor(descriptor, initialValue) {
            if (!(this instanceof GlobalCtor)) {
                throw new TypeError('WebAssembly.Global: must be called with new');
            }
            if (!descriptor || typeof descriptor.value !== 'string') {
                throw new TypeError('WebAssembly.Global: descriptor.value required');
            }
            var ty = descriptor.value;
            var mutable = !!descriptor.mutable;
            // Encode initial as a typed value JSON the host parses.
            var v;
            if (ty === 'i64') {
                var bn = (typeof initialValue === 'bigint') ? initialValue : BigInt(initialValue || 0);
                v = { type: 'i64', value: bn.toString() };
            } else if (ty === 'i32') {
                v = { type: 'i32', value: (initialValue | 0) };
            } else if (ty === 'f32' || ty === 'f64') {
                v = { type: ty, value: Number(initialValue || 0) };
            } else {
                throw new TypeError('WebAssembly.Global: unknown value type ' + ty);
            }
            var id = ensureHost('__host_wasm_global_new')(ty, mutable ? 1 : 0, JSON.stringify(v));
            if (id < 0) {
                throw new Error('WebAssembly.Global: alloc failed');
            }
            this._standaloneId = id;
            this._type = ty;
            var self = this;
            Object.defineProperty(this, 'value', {
                get: function() {
                    var raw = ensureHost('__host_wasm_global_get_sa')(self._standaloneId);
                    if (isHostErr(raw)) throw new Error(raw.slice('__HOST_ERR__:'.length));
                    var got = JSON.parse(raw);
                    if (got.type === 'i64') return BigInt(got.value);
                    return got.value;
                },
                set: function(newVal) {
                    var nv;
                    if (self._type === 'i64') {
                        var bn = (typeof newVal === 'bigint') ? newVal : BigInt(newVal);
                        nv = { type: 'i64', value: bn.toString() };
                    } else if (self._type === 'i32') {
                        nv = { type: 'i32', value: newVal | 0 };
                    } else {
                        nv = { type: self._type, value: Number(newVal) };
                    }
                    var rc = ensureHost('__host_wasm_global_set_sa')(
                        self._standaloneId, JSON.stringify(nv));
                    if (rc < 0) {
                        throw new Error('WebAssembly.Global.value set failed');
                    }
                },
            });
            this.valueOf = function() { return this.value; };
        },
        CompileError: function(msg) { return CompileError(msg); },
        LinkError: function(msg) { return LinkError(msg); },
        RuntimeError: function(msg) { return RuntimeError(msg); },
    };

    globalThis.WebAssembly = WebAssembly;
})();

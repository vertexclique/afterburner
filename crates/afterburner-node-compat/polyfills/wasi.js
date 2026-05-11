// wasi — Node 20's WASI host. The plain `WebAssembly` polyfill
// already loads modules; this module gives callers the Node-shaped
// `WASI` class so `new WASI({...}).getImportObject()` works against
// our `WebAssembly.instantiate`.
//
// v1 supplies an empty import object — the WASM loader doesn't bridge
// user-defined imports yet, so a module that imports
// `wasi_snapshot_preview1` won't actually get satisfied. The class
// exists to keep `import { WASI } from 'wasi'` from breaking; runtime
// instantiation will surface a LinkError naming the missing import,
// which is the right place to learn what's still pending.

__register_module('wasi', function(module, exports, require) {

    function WASI(opts) {
        opts = opts || {};
        this.args = (opts.args || []).slice();
        this.env = Object.assign({}, opts.env || {});
        this.preopens = Object.assign({}, opts.preopens || {});
        this.returnOnExit = opts.returnOnExit !== false;
        this.version = opts.version || 'preview1';
        this._started = false;
    }

    WASI.prototype.getImportObject = function() {
        // Returns a sentinel object the WebAssembly.Instance shim
        // recognises and routes through `__host_wasm_run_wasi`. The
        // import map's `wasi_snapshot_preview1` entry is a marker
        // — the actual syscall bridge lives in wasmtime-wasi on the
        // host side, which the run_wasi flow links into a fresh Store.
        var self = this;
        return {
            wasi_snapshot_preview1: { __ab_wasi: self },
        };
    };

    function _runHostWasi(wasi, mod) {
        if (typeof globalThis.__host_wasm_run_wasi !== 'function') {
            throw new Error('WASI: host runner not available');
        }
        if (!mod || typeof mod._id !== 'number') {
            throw new TypeError(
                'WASI: argument must be a `WebAssembly.Module` (compile bytes first)'
            );
        }
        var cfg = JSON.stringify({
            args: wasi.args,
            env: wasi.env,
            preopens: wasi.preopens,
        });
        var code = globalThis.__host_wasm_run_wasi(mod._id, cfg);
        return code | 0;
    }

    /// `start(moduleOrInstance)` — runs the wasm module's `_start`
    /// export. Burn deviates from Node's exact instance-flow contract
    /// because WASI imports are bridged on the host (wasmtime-wasi);
    /// passing a Module directly is the supported path. Passing an
    /// already-instantiated Instance also works as long as the
    /// instance was created via `WebAssembly.instantiate(mod,
    /// wasi.getImportObject())` (we re-use the underlying module).
    WASI.prototype.start = function(arg) {
        if (this._started) {
            throw new Error('WASI.start: instance already started');
        }
        this._started = true;
        var mod;
        if (arg && typeof arg._id === 'number') {
            mod = arg;
        } else if (arg && arg._module && typeof arg._module._id === 'number') {
            mod = arg._module;
        } else {
            throw new TypeError(
                'WASI.start: argument must be a `WebAssembly.Module` or Instance'
            );
        }
        try {
            var code = _runHostWasi(this, mod);
            if (this.returnOnExit) return code;
            if (code !== 0) {
                var err = new Error('WASI exited with code ' + code);
                err.code = code;
                throw err;
            }
            return 0;
        } catch (e) {
            if (this.returnOnExit && e && typeof e.code === 'number') {
                return e.code;
            }
            throw e;
        }
    };

    /// `initialize(moduleOrInstance)` — runs the wasm module's
    /// `_initialize` export instead of `_start`. Spec-defined alt
    /// entry for "reactor" modules (libraries, not commands).
    WASI.prototype.initialize = function(_arg) {
        // For reactor modules, instantiation alone runs `_initialize`
        // — wasmtime-wasi's `add_to_linker_sync` plus instantiate is
        // sufficient. The host's run_wasi path includes that step,
        // so the most direct mapping is to no-op when the user calls
        // `initialize` after a sentinel-shaped Instance — the
        // initialization already happened during instantiation.
    };

    exports.WASI = WASI;
});

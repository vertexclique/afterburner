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
        // v1 returns an empty import map. WASM modules that import
        // `wasi_snapshot_preview1.<func>` will fail at instantiate
        // with `LinkError: import not satisfied: wasi_snapshot_preview1.<func>`,
        // which tells the caller which entry is still pending.
        return {};
    };

    WASI.prototype.start = function(instance) {
        if (this._started) {
            throw new Error('WASI.start: instance already started');
        }
        this._started = true;
        var fn = instance && instance.exports && instance.exports._start;
        if (typeof fn !== 'function') {
            throw new TypeError(
                'WASI.start: instance must export `_start` (compile module ' +
                'with `wasm32-wasi` / `wasi-libc` to get the standard entry)'
            );
        }
        try {
            fn();
        } catch (e) {
            // WASI exits via a special trap; surface the exit code
            // when present.
            if (e && typeof e.code === 'number') {
                if (this.returnOnExit) return e.code;
                throw e;
            }
            throw e;
        }
        return 0;
    };

    WASI.prototype.initialize = function(instance) {
        var fn = instance && instance.exports && instance.exports._initialize;
        if (typeof fn !== 'function') return;
        fn();
    };

    exports.WASI = WASI;
});

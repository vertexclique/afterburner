// async_hooks — Node 20's async-tracking + AsyncLocalStorage API.
//
// Burn's sandbox has no async stack to trace, but `AsyncLocalStorage`
// is the API the vast majority of users actually reach for (request
// context propagation, fastify / pino / pg style). We back it with
// a synchronous storage stack — `getStore()` returns the value at
// the top of that stack, `run(value, callback)` pushes/pops around
// the callback. Without an event loop, "running async" collapses to
// "running synchronously," which preserves the contract.

__register_module('async_hooks', function(module, exports, require) {

    // ---- AsyncLocalStorage ----------------------------------------

    function AsyncLocalStorage() {
        // Stack of stores currently in scope. The top of the stack
        // is what `getStore()` reports.
        this._stack = [];
    }
    AsyncLocalStorage.prototype.run = function(store, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.run: callback must be a function');
        }
        this._stack.push(store);
        try {
            var args = Array.prototype.slice.call(arguments, 2);
            return callback.apply(null, args);
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.exit = function(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.exit: callback must be a function');
        }
        // Spec: temporarily disable the store for the duration of
        // the callback. We push `undefined` and restore.
        this._stack.push(undefined);
        try {
            return callback.apply(null, Array.prototype.slice.call(arguments, 1));
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.getStore = function() {
        return this._stack.length === 0
            ? undefined
            : this._stack[this._stack.length - 1];
    };
    AsyncLocalStorage.prototype.enterWith = function(store) {
        // Spec: replace the current store. With no async stack
        // tracking we just rewrite the top entry.
        if (this._stack.length === 0) this._stack.push(store);
        else this._stack[this._stack.length - 1] = store;
    };
    AsyncLocalStorage.prototype.disable = function() {
        this._stack = [];
    };
    AsyncLocalStorage.bind = function(fn) {
        // Captures the current store snapshot at bind time. Sandbox
        // is sync — store snapshot equals "the current state", so
        // bind is identity.
        return fn;
    };
    AsyncLocalStorage.snapshot = function() {
        // Returns a thunk that runs `cb` under the current snapshot.
        // Sync sandbox → just runs `cb`.
        return function(cb) {
            return cb.apply(null, Array.prototype.slice.call(arguments, 1));
        };
    };

    // ---- AsyncResource --------------------------------------------
    //
    // Used by Node's worker pools, db drivers, etc. to track async
    // boundaries. Sandbox has none, so the resource is essentially
    // a no-op wrapper that exposes a `runInAsyncScope` for compat.

    function AsyncResource(type, options) {
        this._type = type;
        this._triggerAsyncId = (options && options.triggerAsyncId) | 0;
        this._asyncId = nextAsyncId();
    }
    AsyncResource.prototype.runInAsyncScope = function(fn, thisArg /*, ...args */) {
        var args = Array.prototype.slice.call(arguments, 2);
        return fn.apply(thisArg, args);
    };
    AsyncResource.prototype.bind = function(fn) {
        return fn;
    };
    AsyncResource.prototype.asyncId = function() { return this._asyncId; };
    AsyncResource.prototype.triggerAsyncId = function() { return this._triggerAsyncId; };
    AsyncResource.prototype.emitDestroy = function() { return this; };
    AsyncResource.bind = function(fn) { return fn; };

    var _asyncIdCounter = 1;
    function nextAsyncId() { return ++_asyncIdCounter; }

    // ---- async hook lifecycle (no-op) -----------------------------
    //
    // We accept hook callbacks but never fire them — there's no async
    // stack to observe. Code that calls `.enable()` / `.disable()`
    // for context propagation often pairs it with AsyncLocalStorage
    // anyway; this surface keeps pino/winston-style logging from
    // crashing.

    function createHook(callbacks) {
        var enabled = false;
        return {
            enable: function() { enabled = true; return this; },
            disable: function() { enabled = false; return this; },
        };
        // `callbacks` (init/before/after/destroy/promiseResolve)
        // are accepted but never invoked.
    }

    function executionAsyncId() { return _asyncIdCounter; }
    function triggerAsyncId() { return _asyncIdCounter; }
    function executionAsyncResource() { return Object.create(null); }

    // ---- exports --------------------------------------------------

    exports.AsyncLocalStorage = AsyncLocalStorage;
    exports.AsyncResource = AsyncResource;
    exports.createHook = createHook;
    exports.executionAsyncId = executionAsyncId;
    exports.triggerAsyncId = triggerAsyncId;
    exports.executionAsyncResource = executionAsyncResource;
    exports.asyncWrapProviders = {
        NONE: 0,
        DIRHANDLE: 1,
        FILEHANDLE: 2,
        TCPWRAP: 3,
        TIMERWRAP: 4,
    };
});

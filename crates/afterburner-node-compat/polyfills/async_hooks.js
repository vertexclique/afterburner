// async_hooks — Node 20's async-tracking + AsyncLocalStorage API.
//
// Real hook firing: `createHook({init, before, after, destroy,
// promiseResolve}).enable()` causes every subsequent async resource
// (timer, microtask, AsyncResource subclass, then/finally/catch
// handler) to fire the registered callbacks at the matching point
// in its lifecycle.
//
// Wire-up:
//
// * **AsyncResource** — `new AsyncResource(type)` fires `init`;
//   `runInAsyncScope(fn, this, ...args)` pushes the asyncId,
//   fires `before`, runs `fn`, fires `after`, pops.
//   `emitDestroy()` fires `destroy`.
// * **Promise.prototype.then/catch/finally** — wrapped at module
//   load to register a synthetic `PROMISE` resource for each
//   handler. The handler runs inside `runInAsyncScope`. `then`
//   also fires `promiseResolve` when the producing promise
//   settles.
// * **AsyncLocalStorage** — store stack snapshots at the point
//   where a handler is queued, restored at run time. With Promise
//   hooks live, this propagates through `await` boundaries
//   without a per-call user wrapper.
//
// `executionAsyncId()` / `triggerAsyncId()` reflect the live
// asyncId stack so logging libraries can correlate work units.

__register_module('async_hooks', function(module, exports, require) {

    // ---- async-id stack + hook registry --------------------------

    var _asyncIdCounter = 1;
    function nextAsyncId() { return ++_asyncIdCounter; }

    // Stack frames are [{asyncId, triggerAsyncId}, ...]. Top is the
    // currently-executing scope. Bottom is the synthetic root.
    var _stack = [{ asyncId: 1, triggerAsyncId: 0 }];

    function _peek() { return _stack[_stack.length - 1]; }
    function _push(asyncId, triggerAsyncId) {
        _stack.push({ asyncId: asyncId, triggerAsyncId: triggerAsyncId });
    }
    function _pop() {
        if (_stack.length > 1) _stack.pop();
    }

    // Active hooks. Each entry: { init, before, after, destroy, promiseResolve, enabled }.
    var _hooks = [];
    var _hooksDirty = false;
    // We re-read enabled hooks lazily so adding/removing during a
    // fire iteration doesn't reorder the active set mid-iteration.
    var _activeCache = [];
    function _activeHooks() {
        if (_hooksDirty) {
            _activeCache = _hooks.filter(function(h) { return h.enabled; });
            _hooksDirty = false;
        }
        return _activeCache;
    }

    function _fire(name, asyncId, type, triggerAsyncId, resource) {
        var arr = _activeHooks();
        for (var i = 0; i < arr.length; i++) {
            var fn = arr[i][name];
            if (typeof fn !== 'function') continue;
            try {
                if (name === 'init') fn(asyncId, type, triggerAsyncId, resource);
                else if (name === 'promiseResolve') fn(asyncId);
                else fn(asyncId);
            } catch (e) {
                // Match Node: hook errors are reported on stderr but
                // do not abort the program. Avoiding throw here also
                // protects users that emit destroy from a destructor
                // (where throwing would leak resources).
                try { console.error('async_hooks ' + name + ' callback error:', (e && e.stack) || e); }
                catch (_) {}
            }
        }
    }

    // ---- AsyncResource -------------------------------------------

    function AsyncResource(type, options) {
        if (!(this instanceof AsyncResource)) return new AsyncResource(type, options);
        var trigger;
        if (typeof options === 'number') {
            trigger = options | 0;
        } else if (options && typeof options.triggerAsyncId === 'number') {
            trigger = options.triggerAsyncId | 0;
        } else {
            trigger = _peek().asyncId;
        }
        this._type = type || 'AsyncResource';
        this._triggerAsyncId = trigger;
        this._asyncId = nextAsyncId();
        this._destroyed = false;
        _fire('init', this._asyncId, this._type, this._triggerAsyncId, this);
    }
    AsyncResource.prototype.runInAsyncScope = function(fn, thisArg /*, ...args */) {
        var args = Array.prototype.slice.call(arguments, 2);
        _push(this._asyncId, this._triggerAsyncId);
        _fire('before', this._asyncId);
        try {
            return fn.apply(thisArg, args);
        } finally {
            _fire('after', this._asyncId);
            _pop();
        }
    };
    AsyncResource.prototype.bind = function(fn, thisArg) {
        var self = this;
        var bound = function() {
            var args = Array.prototype.slice.call(arguments);
            return self.runInAsyncScope(fn, thisArg || this, args.length === 0 ? undefined : args);
        };
        // Accept the alternate Node-22 calling convention: bind() also
        // returns a function whose direct call applies the args.
        var direct = function() {
            return self.runInAsyncScope.apply(self,
                [fn, thisArg || this].concat(Array.prototype.slice.call(arguments)));
        };
        // Use `direct` so `(asyncRes.bind(fn))(a, b)` runs `fn(a, b)`
        // under the resource's scope — this is the documented shape.
        return direct;
        // (The unused `bound` keeps closure shape for any future
        // pickle/tooling that expects two refs; not exposed.)
    };
    AsyncResource.prototype.asyncId = function() { return this._asyncId; };
    AsyncResource.prototype.triggerAsyncId = function() { return this._triggerAsyncId; };
    AsyncResource.prototype.emitDestroy = function() {
        if (!this._destroyed) {
            this._destroyed = true;
            _fire('destroy', this._asyncId);
        }
        return this;
    };
    AsyncResource.bind = function(fn, type, thisArg) {
        var r = new AsyncResource(type || 'AsyncResource');
        return r.bind(fn, thisArg);
    };

    // ---- AsyncLocalStorage --------------------------------------
    //
    // Store stack tracks the live "current store" per ALS instance.
    // Promise / timer / AsyncResource handlers capture the per-ALS
    // top-of-stack at queue time and restore on run, so the store
    // visible inside an `await` matches the store visible at the
    // statement that produced the awaited promise.

    function AsyncLocalStorage() {
        this._stack = [];
        this._enabled = true;
    }
    AsyncLocalStorage.prototype.run = function(store, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.run: callback must be a function');
        }
        this._stack.push(store);
        try {
            return callback.apply(null, Array.prototype.slice.call(arguments, 2));
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.exit = function(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.exit: callback must be a function');
        }
        this._stack.push(undefined);
        try {
            return callback.apply(null, Array.prototype.slice.call(arguments, 1));
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.getStore = function() {
        if (!this._enabled) return undefined;
        return this._stack.length === 0 ? undefined : this._stack[this._stack.length - 1];
    };
    AsyncLocalStorage.prototype.enterWith = function(store) {
        if (this._stack.length === 0) this._stack.push(store);
        else this._stack[this._stack.length - 1] = store;
    };
    AsyncLocalStorage.prototype.disable = function() {
        this._stack = [];
        this._enabled = false;
    };
    // Snapshot the entire ALS-store world so async boundaries can
    // restore each registered ALS to what it was at queue time.
    function _snapshotALS() {
        var snap = [];
        for (var i = 0; i < _alsRegistry.length; i++) {
            var als = _alsRegistry[i];
            var top = als._stack.length === 0 ? undefined : als._stack[als._stack.length - 1];
            snap.push({ als: als, value: top });
        }
        return snap;
    }
    function _enterSnapshot(snap) {
        for (var i = 0; i < snap.length; i++) {
            snap[i].als._stack.push(snap[i].value);
        }
    }
    function _exitSnapshot(snap) {
        for (var i = 0; i < snap.length; i++) {
            snap[i].als._stack.pop();
        }
    }
    var _alsRegistry = [];
    var _OrigALS = AsyncLocalStorage;
    AsyncLocalStorage = function() {
        var inst = new _OrigALS();
        _alsRegistry.push(inst);
        return inst;
    };
    AsyncLocalStorage.prototype = _OrigALS.prototype;
    AsyncLocalStorage.bind = function(fn) {
        var snap = _snapshotALS();
        return function() {
            _enterSnapshot(snap);
            try { return fn.apply(this, arguments); }
            finally { _exitSnapshot(snap); }
        };
    };
    AsyncLocalStorage.snapshot = function() {
        var snap = _snapshotALS();
        return function(cb) {
            var args = Array.prototype.slice.call(arguments, 1);
            _enterSnapshot(snap);
            try { return cb.apply(null, args); }
            finally { _exitSnapshot(snap); }
        };
    };

    // ---- createHook ---------------------------------------------

    function createHook(callbacks) {
        callbacks = callbacks || {};
        var entry = {
            init: typeof callbacks.init === 'function' ? callbacks.init : null,
            before: typeof callbacks.before === 'function' ? callbacks.before : null,
            after: typeof callbacks.after === 'function' ? callbacks.after : null,
            destroy: typeof callbacks.destroy === 'function' ? callbacks.destroy : null,
            promiseResolve: typeof callbacks.promiseResolve === 'function'
                ? callbacks.promiseResolve : null,
            enabled: false,
        };
        _hooks.push(entry);
        return {
            enable: function() {
                entry.enabled = true;
                _hooksDirty = true;
                return this;
            },
            disable: function() {
                entry.enabled = false;
                _hooksDirty = true;
                return this;
            },
        };
    }

    function executionAsyncId() { return _peek().asyncId; }
    function triggerAsyncId() { return _peek().triggerAsyncId; }
    function executionAsyncResource() { return Object.create(null); }

    // ---- Promise hooks ------------------------------------------
    //
    // Patch Promise.prototype.{then,catch,finally} so each handler
    // runs inside an AsyncResource('PROMISE'). The init hook fires
    // when the user attaches the handler; before/after fire around
    // the handler's invocation; promiseResolve fires when the
    // producing promise settles. Destroy fires after the handler
    // completes (Node fires it lazily; we fire eagerly because
    // microtask cleanup is bounded).
    //
    // The patch is one-shot — applied at module load — so all
    // promises minted in this realm carry the wrapped handlers.
    // Native promises produced by host code (e.g. fetch's body
    // reader) inherit the same prototype, so they also get tracked.

    var _origThen = Promise.prototype.then;
    var _origCatch = Promise.prototype.catch;
    var _origFinally = Promise.prototype.finally;

    function _wrapHandler(fn, type) {
        if (typeof fn !== 'function') return fn;
        var resource = new AsyncResource(type || 'PROMISE');
        var alsSnap = _snapshotALS();
        var wrapped = function(value) {
            _enterSnapshot(alsSnap);
            try {
                return resource.runInAsyncScope(fn, undefined, value);
            } finally {
                _exitSnapshot(alsSnap);
                resource.emitDestroy();
            }
        };
        wrapped._ah_resource = resource;
        return wrapped;
    }

    Promise.prototype.then = function(onFulfilled, onRejected) {
        var wrappedF = _wrapHandler(onFulfilled, 'PROMISE');
        var wrappedR = _wrapHandler(onRejected, 'PROMISE');
        var p = _origThen.call(this, wrappedF, wrappedR);
        // Fire promiseResolve when this producing promise settles.
        // We chain a sentinel handler that doesn't add semantic
        // surface but observes settlement.
        var producerId = (wrappedF && wrappedF._ah_resource && wrappedF._ah_resource._asyncId)
            || (wrappedR && wrappedR._ah_resource && wrappedR._ah_resource._asyncId);
        if (producerId !== undefined) {
            _origThen.call(this, function() { _fire('promiseResolve', producerId); },
                function() { _fire('promiseResolve', producerId); });
        }
        return p;
    };

    Promise.prototype.catch = function(onRejected) {
        return this.then(undefined, onRejected);
    };

    Promise.prototype.finally = function(onFinally) {
        if (typeof onFinally !== 'function') {
            return _origFinally.call(this, onFinally);
        }
        var wrapped = _wrapHandler(onFinally, 'PROMISE');
        return _origFinally.call(this, wrapped);
    };

    // ---- Timer hooks --------------------------------------------
    //
    // Wrap the global setTimeout/setInterval/setImmediate so the
    // callback runs inside an AsyncResource('Timeout'/'Immediate').
    // The host's timer plumbing isn't aware of asyncId, but the
    // surface the user observes (executionAsyncId during the
    // callback) reflects the right id.

    var _origSetTimeout = globalThis.setTimeout;
    var _origSetInterval = globalThis.setInterval;
    var _origSetImmediate = globalThis.setImmediate;

    if (typeof _origSetTimeout === 'function') {
        globalThis.setTimeout = function(fn /*, ms, ...args */) {
            if (typeof fn !== 'function') return _origSetTimeout.apply(this, arguments);
            var rest = Array.prototype.slice.call(arguments, 1);
            var resource = new AsyncResource('Timeout');
            var alsSnap = _snapshotALS();
            var wrapped = function() {
                _enterSnapshot(alsSnap);
                try {
                    return resource.runInAsyncScope.apply(resource,
                        [fn, undefined].concat(Array.prototype.slice.call(arguments)));
                } finally {
                    _exitSnapshot(alsSnap);
                    resource.emitDestroy();
                }
            };
            return _origSetTimeout.apply(this, [wrapped].concat(rest));
        };
    }
    if (typeof _origSetInterval === 'function') {
        globalThis.setInterval = function(fn /*, ms, ...args */) {
            if (typeof fn !== 'function') return _origSetInterval.apply(this, arguments);
            var rest = Array.prototype.slice.call(arguments, 1);
            var resource = new AsyncResource('Timeout');
            var alsSnap = _snapshotALS();
            var wrapped = function() {
                _enterSnapshot(alsSnap);
                try {
                    return resource.runInAsyncScope.apply(resource,
                        [fn, undefined].concat(Array.prototype.slice.call(arguments)));
                } finally {
                    _exitSnapshot(alsSnap);
                }
            };
            return _origSetInterval.apply(this, [wrapped].concat(rest));
        };
    }
    if (typeof _origSetImmediate === 'function') {
        globalThis.setImmediate = function(fn /*, ...args */) {
            if (typeof fn !== 'function') return _origSetImmediate.apply(this, arguments);
            var rest = Array.prototype.slice.call(arguments, 1);
            var resource = new AsyncResource('Immediate');
            var alsSnap = _snapshotALS();
            var wrapped = function() {
                _enterSnapshot(alsSnap);
                try {
                    return resource.runInAsyncScope.apply(resource,
                        [fn, undefined].concat(Array.prototype.slice.call(arguments)));
                } finally {
                    _exitSnapshot(alsSnap);
                    resource.emitDestroy();
                }
            };
            return _origSetImmediate.apply(this, [wrapped].concat(rest));
        };
    }

    // ---- queueMicrotask hook ------------------------------------
    var _origQueueMicrotask = globalThis.queueMicrotask;
    if (typeof _origQueueMicrotask === 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') return _origQueueMicrotask.call(this, fn);
            var resource = new AsyncResource('Microtask');
            var alsSnap = _snapshotALS();
            var wrapped = function() {
                _enterSnapshot(alsSnap);
                try {
                    return resource.runInAsyncScope(fn);
                } finally {
                    _exitSnapshot(alsSnap);
                    resource.emitDestroy();
                }
            };
            return _origQueueMicrotask.call(this, wrapped);
        };
    }

    // ---- exports -------------------------------------------------

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

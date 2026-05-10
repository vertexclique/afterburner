// worker_threads — process-per-worker polyfill (B10).
//
// Each `new Worker(path, opts)` in the parent JS spawns a child
// `burn run --internal-worker <path>` subprocess via the host import
// __host_worker_spawn. IPC is JSON over length-prefixed pipes; the
// host's daemon-event dispatcher delivers worker→parent frames here
// as `{kind:"worker-message"|"worker-online"|"worker-error"|"worker-exit"}`
// envelopes.
//
// Inside a worker child the same module surfaces a `parentPort` whose
// postMessage routes to __host_worker_post_to_parent. Parent → child
// frames arrive via daemon-event as `{kind:"worker-parent-message"}`
// or `{kind:"worker-terminate-requested"}`.
//
// **Not supported in the minimal subset:**
// - `new Worker(code, { eval: true })` — explicit error
// - MessageChannel / MessagePort standalone (only Worker / parentPort)
// - transferList / SharedArrayBuffer
// - worker.stdout / worker.stderr as readable streams (forwarded to
//   parent stderr instead — see daemon_workers.rs)
// - resourceLimits
// - argv / env / execArgv overrides

(function bootstrapWorkerThreadsGlobals() {
    if (!globalThis.__ab_worker_handlers) {
        globalThis.__ab_worker_handlers = {};
    }
    if (!globalThis.__ab_worker_parent_port_handlers) {
        globalThis.__ab_worker_parent_port_handlers = null;
    }
})();

__register_module('worker_threads', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function isMainThreadFn() {
        if (typeof globalThis.__host_worker_is_main_thread !== 'function') return true;
        return globalThis.__host_worker_is_main_thread() !== 0;
    }

    function threadIdFn() {
        if (typeof globalThis.__host_worker_thread_id !== 'function') return 0;
        return globalThis.__host_worker_thread_id() | 0;
    }

    function workerDataValue() {
        if (typeof globalThis.__host_worker_data !== 'function') return undefined;
        var s = globalThis.__host_worker_data();
        if (!s) return undefined;
        try {
            var obj = JSON.parse(s);
            return _reattachSABs(obj);
        } catch (_) { return undefined; }
    }

    /// Walk a parsed workerData tree replacing every
    /// `{__ab_sab:true, descriptor, byteLength}` marker with a fresh
    /// SharedArrayBuffer that re-attaches to the parent's region.
    /// Plain values (numbers, strings, etc.) pass through untouched.
    function _reattachSABs(value) {
        if (!value || typeof value !== 'object') return value;
        if (value.__ab_sab === true) {
            var SAB = globalThis.SharedArrayBuffer;
            return new SAB({
                __ab_sab_attach: true,
                descriptor: value.descriptor,
                byteLength: value.byteLength | 0,
            });
        }
        if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i++) {
                value[i] = _reattachSABs(value[i]);
            }
            return value;
        }
        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) {
            value[keys[k]] = _reattachSABs(value[keys[k]]);
        }
        return value;
    }

    /// Inverse of [`_reattachSABs`]: walk a tree pre-`JSON.stringify`
    /// and replace SharedArrayBuffer instances with markers the child
    /// can reconstruct. Mutates a *clone* of the input so the user's
    /// workerData object isn't disturbed.
    function _markSABs(value, seen) {
        if (!value || typeof value !== 'object') return value;
        seen = seen || new WeakMap();
        if (seen.has(value)) return seen.get(value);
        // SharedArrayBuffer shadow detection — our shadow stores the
        // host region id on `_regionId`. A literal SAB the engine
        // produced (no descriptor) can't be shared cross-process; we
        // pass it as null so the child observes a missing entry.
        if (typeof value._regionId === 'number'
            && typeof value._descriptor === 'string') {
            return {
                __ab_sab: true,
                descriptor: value._descriptor,
                byteLength: value.byteLength | 0,
            };
        }
        if (Array.isArray(value)) {
            var arr = [];
            seen.set(value, arr);
            for (var i = 0; i < value.length; i++) arr.push(_markSABs(value[i], seen));
            return arr;
        }
        var out = {};
        seen.set(value, out);
        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) {
            out[keys[k]] = _markSABs(value[keys[k]], seen);
        }
        return out;
    }

    var IS_MAIN = isMainThreadFn();
    var THREAD_ID = threadIdFn();
    var WORKER_DATA = IS_MAIN ? undefined : workerDataValue();

    // ----------------------------------------------------------------
    // Worker (parent-side handle to a child process)
    // ----------------------------------------------------------------

    function Worker(scriptPath, opts) {
        if (!(this instanceof Worker)) return new Worker(scriptPath, opts);
        EventEmitter.call(this);

        opts = opts || {};
        if (opts.eval) {
            throw new Error(
                "worker_threads: `new Worker(code, { eval: true })` is not supported in burn"
            );
        }
        if (typeof scriptPath !== 'string') {
            // Node accepts a URL object. We stringify; Node's URL polyfill
            // (if loaded) will provide .toString() compatible output.
            scriptPath = String(scriptPath);
        }
        if (scriptPath.indexOf('file:') === 0) {
            // Strip a `file://` prefix produced by URL.toString() — the
            // host validator wants a regular FS path.
            scriptPath = scriptPath.replace(/^file:\/\//, '');
        }

        if (typeof globalThis.__host_worker_spawn !== 'function') {
            throw new Error(
                "worker_threads requires daemon mode; run via `burn foo.js` CLI"
            );
        }

        var dataJson = '';
        if (typeof opts.workerData !== 'undefined') {
            try {
                // Replace SharedArrayBuffer instances with markers the
                // child reconstructs via host_sab_open. Plain values
                // (and non-SAB ArrayBuffers) pass through unchanged.
                dataJson = JSON.stringify(_markSABs(opts.workerData));
            }
            catch (e) {
                throw new TypeError(
                    'workerData must be JSON-serializable: ' + e.message
                );
            }
        }

        var rc = globalThis.__host_worker_spawn(scriptPath, dataJson);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw mapSpawnError(rc, detail);
        }

        this.threadId = rc | 0;
        this._terminated = false;
        // Register self in the dispatch table so daemon-event can route
        // 'message' / 'online' / 'error' / 'exit' to this instance.
        globalThis.__ab_worker_handlers[this.threadId] = this;
    }

    Worker.prototype = Object.create(EventEmitter.prototype);
    Worker.prototype.constructor = Worker;

    Worker.prototype.postMessage = function(value) {
        if (this._terminated) {
            // Match Node's silent drop on already-exited workers; the
            // host returns E_BAD_ID anyway.
            return;
        }
        var json;
        try { json = JSON.stringify(value); }
        catch (e) {
            throw new TypeError(
                'postMessage value must be JSON-serializable: ' + e.message
            );
        }
        var rc = globalThis.__host_worker_post_message(this.threadId, json);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw new Error('worker.postMessage: ' + (detail || ('rc=' + rc)));
        }
    };

    Worker.prototype.terminate = function() {
        var self = this;
        if (self._terminated) return Promise.resolve(0);
        self._terminated = true;
        var rc = globalThis.__host_worker_terminate(self.threadId, 1);
        return new Promise(function(resolve) {
            // Resolve once the daemon-event pump fires `exit` for us.
            // If the worker was already gone, the exit may have been
            // emitted before terminate() was called; resolve quickly
            // in that case via a microtask.
            self.once('exit', function(code) { resolve(code | 0); });
            // Best-effort: if the host already returned an error code
            // (worker not found), cancel the wait.
            if (rc === -9) {
                self._dispatchExit(0);
            }
        });
    };

    // Internal: called by the daemon-event dispatcher when an
    // online/message/error/exit envelope arrives for this thread id.
    Worker.prototype._dispatchOnline = function() {
        try { this.emit('online'); } catch (_) {}
    };
    Worker.prototype._dispatchMessage = function(payloadJson) {
        var value;
        try { value = JSON.parse(payloadJson); } catch (_) { return; }
        try { this.emit('message', value); } catch (_) {}
    };
    Worker.prototype._dispatchError = function(message, stack) {
        var err = new Error(message || 'worker error');
        if (stack) err.stack = stack;
        try { this.emit('error', err); } catch (_) {}
    };
    Worker.prototype._dispatchExit = function(code) {
        if (this._terminated) {
            // Already removed from the table — re-entering from a
            // late exit notification.
        }
        this._terminated = true;
        try { this.emit('exit', code | 0); } catch (_) {}
        delete globalThis.__ab_worker_handlers[this.threadId];
    };

    function mapSpawnError(rc, detail) {
        var msg = detail || '';
        switch (rc) {
            case -1: return new Error(
                'worker_threads requires daemon mode; run via `burn foo.js`' +
                (msg ? (' (' + msg + ')') : '')
            );
            case -2: return new Error('worker_threads: permission denied' +
                (msg ? (': ' + msg) : ''));
            case -3: return new Error(msg ||
                'worker_threads: depth limit reached (BURN_WORKER_DEPTH)');
            case -4: return new Error(msg ||
                'worker_threads: concurrency cap reached');
            case -5: return new Error(msg ||
                'worker_threads: worker script path is outside fs allow-list');
            case -6: return new Error(msg ||
                'worker_threads: failed to spawn child process');
            case -7: return new Error(msg ||
                'worker_threads: payload exceeds frame size cap');
            case -11: return new Error(
                'worker_threads: { eval: true } is not supported in burn');
            default: return new Error('worker_threads: error rc=' + rc +
                (msg ? (': ' + msg) : ''));
        }
    }

    // ----------------------------------------------------------------
    // parentPort (child-side handle back to the parent)
    // ----------------------------------------------------------------

    function ParentPort() {
        EventEmitter.call(this);
        this._closed = false;
    }
    ParentPort.prototype = Object.create(EventEmitter.prototype);
    ParentPort.prototype.constructor = ParentPort;

    ParentPort.prototype.postMessage = function(value) {
        if (this._closed) return;
        var json;
        try { json = JSON.stringify(value); }
        catch (e) {
            throw new TypeError(
                'parentPort.postMessage value must be JSON-serializable: ' + e.message
            );
        }
        var rc = globalThis.__host_worker_post_to_parent(json);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw new Error('parentPort.postMessage: ' + (detail || ('rc=' + rc)));
        }
    };

    ParentPort.prototype.close = function() {
        this._closed = true;
    };

    ParentPort.prototype._dispatchMessage = function(payloadJson) {
        var value;
        try { value = JSON.parse(payloadJson); } catch (_) { return; }
        try { this.emit('message', value); } catch (_) {}
    };

    ParentPort.prototype._dispatchTerminate = function() {
        try { this.emit('close'); } catch (_) {}
        this._closed = true;
    };

    var parentPort = null;
    if (!IS_MAIN) {
        parentPort = new ParentPort();
        globalThis.__ab_worker_parent_port_handlers = parentPort;

        // Fire `online` exactly once after the worker module finishes
        // its top-level evaluation. We use a microtask so any
        // `parentPort.on('message', cb)` the user installed during
        // top-level eval is registered before we signal readiness.
        Promise.resolve().then(function() {
            try { globalThis.__host_worker_post_online_to_parent(); } catch (_) {}
        });
    }

    // ----------------------------------------------------------------
    // Module exports
    // ----------------------------------------------------------------

    exports.Worker = Worker;
    exports.parentPort = parentPort;
    exports.workerData = WORKER_DATA;
    exports.isMainThread = IS_MAIN;
    exports.threadId = THREAD_ID;

    // Re-export the global MessageChannel + MessagePort. They live
    // on `globalThis` for parity with browser semantics; `node:worker_threads`
    // exposes the same constructors so library code that pulls them
    // from this module gets the live class instead of a throwing stub.
    exports.MessageChannel = globalThis.MessageChannel;
    exports.MessagePort = globalThis.MessagePort;
    var _untransferable = new WeakSet();
    exports.markAsUntransferable = function(value) {
        try { _untransferable.add(value); } catch (_) {}
    };
    exports.isMarkedAsUntransferable = function(value) {
        try { return _untransferable.has(value); } catch (_) { return false; }
    };
    /// Single-context runtime — there is one realm per shard, so
    /// "moving" a port between contexts is the identity operation.
    /// Keeping the same MessagePort handle is spec-equivalent to a
    /// successful move in a multi-realm engine.
    exports.moveMessagePortToContext = function(port, _ctx) {
        return port;
    };
    exports.receiveMessageOnPort = function() {
        return undefined;
    };
    exports.SHARE_ENV = Symbol('SHARE_ENV');

    // ---- Environment-data slot (Node 14.5+) -----------------
    //
    // `setEnvironmentData(key, value)` / `getEnvironmentData(key)`
    // exchanges plain values across the parent → spawned-worker
    // boundary. We keep a single in-process map; spawned workers
    // see whatever was set in the parent before `new Worker(...)`.
    // The values flow through workerData on spawn.
    if (!globalThis.__ab_worker_env_data) {
        globalThis.__ab_worker_env_data = new Map();
    }
    var _envData = globalThis.__ab_worker_env_data;
    exports.setEnvironmentData = function setEnvironmentData(key, value) {
        if (value === undefined) _envData.delete(key);
        else _envData.set(key, value);
    };
    exports.getEnvironmentData = function getEnvironmentData(key) {
        return _envData.get(key);
    };

    // ---- BroadcastChannel re-export ------------------------
    // Node exports BroadcastChannel from worker_threads in addition
    // to the global. Keep the surfaces in sync.
    if (typeof globalThis.BroadcastChannel === 'function') {
        exports.BroadcastChannel = globalThis.BroadcastChannel;
    }
});

// cluster — Node 20's primary/worker multi-process clustering.
//
// Burn's sandbox doesn't fork the main process; instead, the
// `worker_threads` shadow (`burn run --internal-worker`) covers the
// "isolated parallelism" use case. We expose `cluster` as a thin
// wrapper that delegates `cluster.fork()` to `new Worker(...)` so
// existing cluster-using code (Express load balancers, pino-cluster)
// keeps running. Each `Worker` here is a `worker_threads.Worker`,
// not a separate OS process; for most middleware this is a fine
// substitution since the contract — multiple isolated JS contexts
// processing requests — is preserved.

__register_module('cluster', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var workerThreads = require('worker_threads');

    var _isPrimary = !!workerThreads.isMainThread;
    var _workers = Object.create(null);
    var _nextId = 1;

    var primary = new EventEmitter();
    primary.workers = _workers;

    function fork(env) {
        if (!_isPrimary) {
            throw new Error('cluster.fork: can only be called from the primary');
        }
        if (!process.argv[1]) {
            throw new Error(
                'cluster.fork: no entry script — `cluster` needs `process.argv[1]` ' +
                'to point at a JS file the workers can re-run'
            );
        }
        var id = _nextId++;
        var w = new workerThreads.Worker(process.argv[1], {
            workerData: { __ab_cluster_id: id },
            env: Object.assign({}, process.env, env || {}),
        });
        var workerWrapper = {
            id: id,
            process: { pid: id }, // approximation — no real OS pid for thread workers
            isDead: function() { return _workers[id] === undefined; },
            isConnected: function() { return _workers[id] !== undefined; },
            kill: function(signal) { w.terminate(); _ = signal; },
            disconnect: function() { w.terminate(); },
            send: function(msg) { w.postMessage(msg); return true; },
            on: function(event, listener) { w.on(event, listener); return this; },
            once: function(event, listener) { w.once(event, listener); return this; },
            removeListener: function(event, listener) { w.removeListener(event, listener); return this; },
            _worker: w,
        };
        var _;
        w.on('exit', function(code) {
            delete _workers[id];
            try { primary.emit('exit', workerWrapper, code, null); } catch (_) {}
        });
        w.on('message', function(msg) {
            try { primary.emit('message', workerWrapper, msg); } catch (_) {}
        });
        _workers[id] = workerWrapper;
        try { primary.emit('fork', workerWrapper); } catch (_) {}
        try { primary.emit('online', workerWrapper); } catch (_) {}
        return workerWrapper;
    }

    function setupPrimary(opts) {
        // Spec: schedules an exec / args / silent setting. We accept
        // and remember the values for surface compat; the actual
        // worker entry comes from process.argv[1] (the same script
        // re-running with a cluster id in workerData).
        primary.settings = Object.assign(primary.settings || {}, opts || {});
    }

    primary.fork = fork;
    primary.setupPrimary = setupPrimary;
    primary.setupMaster = setupPrimary; // legacy alias
    primary.disconnect = function(cb) {
        var ids = Object.keys(_workers);
        ids.forEach(function(id) { _workers[id].disconnect(); });
        if (typeof cb === 'function') {
            Promise.resolve().then(cb);
        }
    };
    primary.settings = {};

    Object.defineProperty(primary, 'isPrimary', {
        get: function() { return _isPrimary; },
    });
    Object.defineProperty(primary, 'isMaster', {
        // Legacy alias — Node still exposes it for back-compat.
        get: function() { return _isPrimary; },
    });
    Object.defineProperty(primary, 'isWorker', {
        get: function() { return !_isPrimary; },
    });

    // When running inside a worker, expose the worker-side surface.
    if (!_isPrimary) {
        var wd = workerThreads.workerData || {};
        primary.worker = {
            id: wd.__ab_cluster_id || 0,
            process: { pid: wd.__ab_cluster_id || 0 },
            isDead: function() { return false; },
            isConnected: function() { return true; },
            send: function(msg) {
                if (workerThreads.parentPort) {
                    workerThreads.parentPort.postMessage(msg);
                    return true;
                }
                return false;
            },
            disconnect: function() {
                if (workerThreads.parentPort) workerThreads.parentPort.close();
            },
            kill: function() {
                if (workerThreads.parentPort) workerThreads.parentPort.close();
            },
            on: function(event, listener) {
                if (event === 'message' && workerThreads.parentPort) {
                    workerThreads.parentPort.on('message', listener);
                }
                return this;
            },
        };
    }

    primary.schedulingPolicy = 1; // SCHED_RR — symbolic
    primary.SCHED_NONE = 0;
    primary.SCHED_RR = 1;

    module.exports = primary;
});

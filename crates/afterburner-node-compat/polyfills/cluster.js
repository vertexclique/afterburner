// cluster — Node 20+ primary/worker multi-process clustering.
//
// Real subprocess workers via `worker_threads`. Each `cluster.fork()`
// in the primary spawns a fresh `burn` subprocess that re-evaluates
// `process.argv[1]`. The forked subprocess sets `cluster.isWorker`
// truthy so the user's `if (cluster.isPrimary) { fork(); } else { app.listen(); }`
// shape Just Works.
//
// Per-CPU accept-balance: every worker sets `BURN_CLUSTER_REUSEPORT=1`
// in its own env (propagated by the primary at fork time via
// `__host_worker_spawn_env`), which flips the daemon's TCP/UDP bind
// path to `SO_REUSEPORT` (Linux/macOS/BSD) or `SO_REUSEADDR`
// (Windows). The kernel then 4-tuple-hashes incoming connections
// across the listening sockets — that's exactly what Node's default
// `SCHED_RR` strategy is at the OS level on the same platforms.
//
// `Worker.process.pid` reports the OS pid via `__host_worker_pid`.
// IPC (`worker.send` / `cluster.worker.send`) routes through the
// existing parentPort message channel — JSON frames over the
// length-prefixed pipes set up by `worker_threads`.

__register_module('cluster', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var workerThreads = require('worker_threads');

    var _isPrimary = !!workerThreads.isMainThread;
    var _workers = Object.create(null);
    var _nextId = 1;

    var primary = new EventEmitter();
    primary.workers = _workers;

    function _hostWorkerPid(id) {
        if (typeof globalThis.__host_worker_pid === 'function') {
            try { return globalThis.__host_worker_pid(id) | 0; } catch (_) { return 0; }
        }
        return 0;
    }

    function _spawnWorker(scriptPath, workerData, envOverrides) {
        var dataJson = JSON.stringify(workerData || {});
        var envJson = JSON.stringify(envOverrides || {});
        var rc;
        if (typeof globalThis.__host_worker_spawn_env === 'function') {
            rc = globalThis.__host_worker_spawn_env(scriptPath, dataJson, envJson);
        } else if (typeof globalThis.__host_worker_spawn === 'function') {
            // Plugin pre-dates the env extension. Fall through to the
            // legacy spawn path; SO_REUSEPORT won't be active for the
            // child, so multi-worker `app.listen(port)` will EADDRINUSE.
            rc = globalThis.__host_worker_spawn(scriptPath, dataJson);
        } else {
            throw new Error('cluster requires daemon mode; run via `burn foo.js` CLI');
        }
        if (rc < 0) {
            throw new Error('cluster.fork: spawn failed (rc=' + rc + ')');
        }
        return rc | 0;
    }

    function fork(env) {
        if (!_isPrimary) {
            throw new Error('cluster.fork: can only be called from the primary');
        }
        if (!process.argv[1]) {
            throw new Error(
                'cluster.fork: no entry script — `cluster` needs `process.argv[1]`'
            );
        }

        var id = _nextId++;
        var clusterEnv = { __ab_cluster_id: id };
        // SO_REUSEPORT gating in the spawned subprocess's daemon.
        // The merged env wins over any user override since
        // accept-balance is the entire point of cluster mode.
        var subEnv = Object.assign({}, env || {}, {
            BURN_CLUSTER_REUSEPORT: '1',
            NODE_UNIQUE_ID: String(id),
        });

        var threadId = _spawnWorker(process.argv[1], clusterEnv, subEnv);
        var pid = _hostWorkerPid(threadId);

        var workerWrapper = new EventEmitter();
        workerWrapper.id = id;
        workerWrapper.threadId = threadId;
        workerWrapper.process = {
            pid: pid || threadId,
            kill: function(sig) {
                _hostTerminate(threadId, true);
                _ = sig;
            },
        };
        workerWrapper.exitedAfterDisconnect = false;
        workerWrapper.state = 'online';
        workerWrapper.isDead = function() { return _workers[id] === undefined; };
        workerWrapper.isConnected = function() { return _workers[id] !== undefined && workerWrapper.state !== 'disconnected'; };
        workerWrapper.kill = function(signal) {
            workerWrapper.exitedAfterDisconnect = true;
            _hostTerminate(threadId, true);
            _ = signal;
        };
        workerWrapper.disconnect = function() {
            workerWrapper.exitedAfterDisconnect = true;
            workerWrapper.state = 'disconnected';
            try { workerWrapper.emit('disconnect'); } catch (_) {}
            try { primary.emit('disconnect', workerWrapper); } catch (_) {}
            _hostTerminate(threadId, false);
            return workerWrapper;
        };
        workerWrapper.send = function(message, _handle, _opts, cb) {
            var rc = _hostPostMessage(threadId, JSON.stringify({
                __ab_cluster_msg: true,
                payload: message,
            }));
            if (typeof cb === 'function') {
                Promise.resolve().then(function() { cb(rc < 0 ? new Error('send rc=' + rc) : null); });
            }
            return rc >= 0;
        };

        // Wire daemon-event routing via the existing worker_threads
        // dispatcher. The host pumps `worker-message` / `worker-online`
        // / `worker-error` / `worker-exit` envelopes through
        // globalThis.__ab_worker_handlers[threadId]; we install a
        // facade there that fans out to the cluster wrapper.
        globalThis.__ab_worker_handlers[threadId] = {
            _dispatchOnline: function() {
                workerWrapper.state = 'online';
                try { workerWrapper.emit('online'); } catch (_) {}
                try { primary.emit('online', workerWrapper); } catch (_) {}
            },
            _dispatchMessage: function(payloadJson) {
                var value;
                try { value = JSON.parse(payloadJson); } catch (_) { return; }
                if (value && value.__ab_cluster_listening) {
                    workerWrapper.state = 'listening';
                    try { workerWrapper.emit('listening', value.address || {}); } catch (_) {}
                    try { primary.emit('listening', workerWrapper, value.address || {}); } catch (_) {}
                    return;
                }
                if (value && value.__ab_cluster_msg) {
                    try { workerWrapper.emit('message', value.payload); } catch (_) {}
                    try { primary.emit('message', workerWrapper, value.payload); } catch (_) {}
                    return;
                }
                // Plain message (worker called parentPort.postMessage
                // outside the cluster envelope) — surface it on both
                // emitters so library code that mixes worker_threads
                // and cluster idioms isn't surprised.
                try { workerWrapper.emit('message', value); } catch (_) {}
                try { primary.emit('message', workerWrapper, value); } catch (_) {}
            },
            _dispatchError: function(message, stack) {
                var err = new Error(message || 'worker error');
                if (stack) err.stack = stack;
                try { workerWrapper.emit('error', err); } catch (_) {}
                try { primary.emit('error', workerWrapper, err); } catch (_) {}
            },
            _dispatchExit: function(code) {
                workerWrapper.state = 'dead';
                delete _workers[id];
                delete globalThis.__ab_worker_handlers[threadId];
                try { workerWrapper.emit('exit', code | 0, null); } catch (_) {}
                try { primary.emit('exit', workerWrapper, code | 0, null); } catch (_) {}
            },
            // Compat with worker_threads.Worker shape so any code that
            // walks __ab_worker_handlers won't fail.
            threadId: threadId,
        };

        _workers[id] = workerWrapper;
        var _;
        try { primary.emit('fork', workerWrapper); } catch (_) {}
        // 'online' is dispatched when the worker child posts its
        // online frame after top-level evaluation finishes. Until
        // then state stays 'online' (matches Node — the wrapper
        // is online from the parent's POV the moment fork returns).
        return workerWrapper;
    }

    function _hostTerminate(threadId, force) {
        if (typeof globalThis.__host_worker_terminate === 'function') {
            try {
                return globalThis.__host_worker_terminate(threadId, force ? 1 : 0) | 0;
            } catch (_) { return -1; }
        }
        return -1;
    }
    function _hostPostMessage(threadId, json) {
        if (typeof globalThis.__host_worker_post_message === 'function') {
            try {
                return globalThis.__host_worker_post_message(threadId, json) | 0;
            } catch (_) { return -1; }
        }
        return -1;
    }

    function setupPrimary(opts) {
        primary.settings = Object.assign(primary.settings || {}, opts || {});
    }

    primary.fork = fork;
    primary.setupPrimary = setupPrimary;
    primary.setupMaster = setupPrimary; // legacy alias
    primary.disconnect = function(cb) {
        var ids = Object.keys(_workers);
        var pending = ids.length;
        if (pending === 0) {
            if (typeof cb === 'function') Promise.resolve().then(cb);
            return;
        }
        ids.forEach(function(id) {
            var w = _workers[id];
            if (!w) { pending--; return; }
            w.once('exit', function() {
                pending--;
                if (pending === 0 && typeof cb === 'function') cb();
            });
            w.disconnect();
        });
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

    // ---- Worker-side surface ------------------------------------
    //
    // When running inside a forked worker, the same `cluster` import
    // exposes `cluster.worker` — the handle used by user code to
    // talk back to the primary, signal 'listening' once a server
    // binds, and observe shutdown signals.

    if (!_isPrimary) {
        var wd = workerThreads.workerData || {};
        var workerObj = new EventEmitter();
        workerObj.id = wd.__ab_cluster_id || 0;
        workerObj.process = {
            pid: typeof process !== 'undefined' && process.pid ? process.pid : 0,
        };
        workerObj.exitedAfterDisconnect = false;
        workerObj.state = 'online';
        workerObj.isDead = function() { return false; };
        workerObj.isConnected = function() { return !workerObj._closed; };
        workerObj.send = function(message, _handle, _opts, cb) {
            if (workerThreads.parentPort) {
                try {
                    workerThreads.parentPort.postMessage({
                        __ab_cluster_msg: true,
                        payload: message,
                    });
                    if (typeof cb === 'function') Promise.resolve().then(function() { cb(null); });
                    return true;
                } catch (e) {
                    if (typeof cb === 'function') Promise.resolve().then(function() { cb(e); });
                    return false;
                }
            }
            return false;
        };
        workerObj.disconnect = function() {
            workerObj._closed = true;
            workerObj.exitedAfterDisconnect = true;
            try { workerObj.emit('disconnect'); } catch (_) {}
            if (workerThreads.parentPort) {
                try { workerThreads.parentPort.close(); } catch (_) {}
            }
        };
        workerObj.kill = workerObj.disconnect;

        // Forward parentPort 'message' frames here so user code that
        // listens on `cluster.worker.on('message', ...)` sees them.
        if (workerThreads.parentPort) {
            workerThreads.parentPort.on('message', function(msg) {
                if (msg && msg.__ab_cluster_msg) {
                    try { workerObj.emit('message', msg.payload); } catch (_) {}
                } else {
                    try { workerObj.emit('message', msg); } catch (_) {}
                }
            });
            // When the primary calls `worker.disconnect()`, the host
            // delivers a `worker-terminate-requested` envelope which
            // surfaces here as parentPort 'close'. Cluster contract:
            // emit 'disconnect' on cluster.worker, run any user
            // shutdown callbacks via the same event, then exit. The
            // worker's HTTP listeners would otherwise keep the process
            // alive (`daemon.has_refs() == true`), so we force-exit.
            workerThreads.parentPort.on('close', function() {
                workerObj._closed = true;
                workerObj.exitedAfterDisconnect = true;
                try { workerObj.emit('disconnect'); } catch (_) {}
                // Microtask gap so user-installed 'disconnect' handlers
                // observe synchronous side-effects before we tear the
                // process down.
                Promise.resolve().then(function() {
                    try { process.exit(0); } catch (_) {}
                });
            });
        }

        primary.worker = workerObj;
    }

    // ---- 'listening' signalling --------------------------------
    //
    // The primary fires 'listening' when a worker calls
    // `server.listen(...)`. The worker side calls
    // `cluster._signalListening(addr)` from inside http.Server's
    // listen path; we hop the address up to the primary via the
    // existing parentPort message channel.
    primary._signalListening = function(addr) {
        if (_isPrimary) return;
        if (!workerThreads.parentPort) return;
        try {
            workerThreads.parentPort.postMessage({
                __ab_cluster_listening: true,
                address: addr || {},
            });
        } catch (_) {}
    };

    primary.schedulingPolicy = 1; // SCHED_RR — symbolic; the actual
    primary.SCHED_NONE = 0;       // accept-balance is SO_REUSEPORT
    primary.SCHED_RR = 1;         // at the kernel level.

    module.exports = primary;
});

// process — eager-installed as `globalThis.process` and registered as
// the CommonJS `process` module. Acts as an EventEmitter so scripts
// using `process.on('exit', …)` etc. do not blow up.
//
// The IIFE runs at bundle-load time so `globalThis.process` is set
// regardless of whether the user script ever calls `require('process')`.

(function bootstrapProcess() {
    // EventEmitter is provided by events.js; we lookup directly from
    // the require resolver since this runs before user code.
    var EventEmitter = require('events');

    // `__host_env` / `__ab_argv` are installed per-thrust by script
    // mode (see plugin's modes/script.rs). Both globals are absent in
    // UDF mode, which is intentional — UDF scripts only see their
    // `data` input.
    var hostEnv = globalThis.__host_env || {};
    var argv    = globalThis.__ab_argv   || ['afterburner'];
    var proc = Object.create(EventEmitter.prototype);
    EventEmitter.call(proc);

    var fields = {
        platform: globalThis.__host_platform || 'linux',
        arch:     globalThis.__host_arch     || 'x64',
        // We claim Node 26 (latest stable, the project's target). Most
        // libraries gate features on numeric ranges (`>=18.17.0`,
        // `>=20.5.0`, `>=22.0.0`) — claiming the current major
        // version unblocks every reasonable engines check while
        // still surfacing the `-afterburner` suffix so version-aware
        // code paths (rare) can detect us.
        version:  'v26.0.0-afterburner',
        versions: { node: '26.0.0', v8: '13.0.0.0', afterburner: '0.1.0' },
        env:      hostEnv,
        argv:     argv,
        execPath: '/usr/bin/afterburner',
        pid:      1,
        title:    'afterburner',

        cwd:      function() { return globalThis.__host_cwd || '/'; },
        chdir:    function() { throw new Error('process.chdir is not supported'); },

        // `umask([mask])` — Node returns the previous mask; with an
        // arg, sets it. Sandbox doesn't surface umask through the
        // bridge; return a sensible default and accept (silent) the
        // setter call. Node reduced the deprecation noise around
        // calling umask() with no args; we mirror that.
        umask:    function(_mask) { return 0o022; },

        // `process.getuid` / `getgid` / `geteuid` / `getegid` — POSIX
        // identity functions. Sandbox returns 0 for everything; some
        // libraries (npm install, sqlite open) probe these to decide
        // whether to drop privileges.
        getuid:   function() { return 0; },
        getgid:   function() { return 0; },
        geteuid:  function() { return 0; },
        getegid:  function() { return 0; },
        getgroups: function() { return [0]; },
        // `setuid`/`setgid` — sandbox doesn't allow privilege change.
        // Throw a Node-style typed error so callers can fall through.
        setuid:   function() { var e = new Error('setuid not supported'); e.code = 'EPERM'; throw e; },
        setgid:   function() { var e = new Error('setgid not supported'); e.code = 'EPERM'; throw e; },
        seteuid:  function() { var e = new Error('seteuid not supported'); e.code = 'EPERM'; throw e; },
        setegid:  function() { var e = new Error('setegid not supported'); e.code = 'EPERM'; throw e; },
        setgroups: function() { var e = new Error('setgroups not supported'); e.code = 'EPERM'; throw e; },

        // Node 18+ `process.permission` / `process.constrainedMemory`
        // / `process.availableMemory` — light probe surface that
        // libraries (express's inspector, nodemon) check at module
        // init.
        constrainedMemory:  function() { return 0; },
        availableMemory:    function() { return 0; },
        memoryUsage:        Object.assign(function() {
            return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
        }, { rss: function() { return 0; } }),
        // Node 24+ `process.threadCpuUsage` — return a zeroed object.
        threadCpuUsage:     function() { return { user: 0, system: 0 }; },
        cpuUsage:           function(_prev) { return { user: 0, system: 0 }; },
        resourceUsage:      function() {
            return {
                userCPUTime: 0, systemCPUTime: 0, maxRSS: 0,
                sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
                minorPageFault: 0, majorPageFault: 0, swappedOut: 0,
                fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0,
                signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
            };
        },
        loadEnvFile: function(_path) { /* no-op: we read env at startup */ },
        // process.permission — Node 20.x experimental. Always-allow
        // posture matches the sandbox's "manifold gates everything"
        // model; permission checks happen at the manifold layer.
        permission: { has: function(_scope, _ref) { return true; } },

        // Real Node drains the nextTick queue synchronously between
        // each macrotask but BEFORE the microtask queue. Express's
        // `finalhandler` (the 404/500 fallback) defers its response
        // with `process.nextTick`, expecting middleware that called
        // `next(err)` to run first. The pre-fix synchronous-call
        // implementation broke that ordering: a nextTick scheduled
        // from inside a Promise microtask ran INSIDE the microtask
        // instead of after it.
        //
        // We approximate Node's semantics by queueing nextTick
        // callbacks into `__ntQueue` and draining via a single
        // `queueMicrotask`. Microtask order is FIFO, so a nextTick
        // scheduled in current sync code runs before any user
        // `Promise.then` queued AFTER it. Exceptions in a nextTick
        // callback are caught + logged so a single failure doesn't
        // poison the rest of the queue (Node's behaviour: emit
        // `uncaughtException` and continue; we surface to console
        // until we wire a real uncaughtException emitter).
        //
        // Caveat: nested nextTicks (callback A queues callback B)
        // run on the *next* drain pass here, not the same one. Real
        // Node has an inner/outer queue that drains nested ticks
        // greedily before the microtask queue. Document the
        // divergence; revisit if a real workload hits it.
        nextTick: function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            var args = Array.prototype.slice.call(arguments, 1);
            if (!globalThis.__ntQueue) globalThis.__ntQueue = [];
            globalThis.__ntQueue.push({ fn: fn, args: args });
            if (!globalThis.__ntScheduled) {
                globalThis.__ntScheduled = true;
                queueMicrotask(function drainNT() {
                    var queue = globalThis.__ntQueue;
                    globalThis.__ntQueue = [];
                    globalThis.__ntScheduled = false;
                    for (var i = 0; i < queue.length; i++) {
                        var item = queue[i];
                        try {
                            item.fn.apply(null, item.args);
                        } catch (e) {
                            // Per Node convention, exceptions in
                            // nextTick callbacks emit
                            // `uncaughtException`. Until that's
                            // wired, log + continue so the rest of
                            // the queue still runs.
                            if (globalThis.console && globalThis.console.error) {
                                globalThis.console.error('Uncaught (in nextTick): ' + (e && e.stack || e));
                            }
                        }
                    }
                });
            }
        },

        exit: function(code) {
            try { proc.emit('exit', code || 0); } catch (_) {}
            if (globalThis.__host_process_exit) globalThis.__host_process_exit(code || 0);
            var err = new Error('process.exit(' + (code || 0) + ')');
            err.code = 'ERR_PROCESS_EXIT';
            err.exitCode = code || 0;
            throw err;
        },

        hrtime: function(prev) {
            var now = Date.now();
            var seconds = Math.floor(now / 1000);
            var nanos = (now % 1000) * 1e6;
            if (prev) {
                var ds = seconds - prev[0];
                var dn = nanos - prev[1];
                if (dn < 0) { ds -= 1; dn += 1e9; }
                return [ds, dn];
            }
            return [seconds, nanos];
        },

        stdout: { write: function(s) { if (globalThis.console) console.log(String(s)); return true; } },
        stderr: { write: function(s) { if (globalThis.console) console.error(String(s)); return true; } },
        stdin:  { on: function() {}, read: function() { return null; } },

        // `process.binding(name)` is Node's internal hook for native
        // bindings (e.g. `process.binding('uv')`, `'tcp_wrap'`,
        // `'fs_event_wrap'`). They expose libuv-side primitives
        // that have no analogue in the WASM sandbox. Surface a
        // clear error that names the requested binding so users
        // can identify which library is reaching for an
        // unsupported internal.
        binding: function(name) {
            var which = typeof name === 'string' ? name : String(name);
            // Return narrow stubs for the bindings real-world libraries
            // probe at module-init for limit/feature flags — eager
            // throws here break safer-buffer / fs-minipass / pacote at
            // module load, which is far enough from any actual native
            // primitive use that the user has no way to act on the
            // error. Keep the throw for everything else so honest
            // libuv consumers (rare in the sandbox) still surface a
            // typed error pointing at the missing binding.
            switch (which) {
                case 'buffer':
                    return {
                        kStringMaxLength: 0x3fffffe7,        // ~1 GiB - 8
                        kMaxLength:       0x7fffffff,        // INT32_MAX
                    };
                case 'fs':
                    // fs-minipass gates a libuv fallback on
                    // `!fs.writev`. We provide writev now, so the
                    // binding is dead code; an empty object lets the
                    // module-init `process.binding('fs')` complete
                    // without exposing any libuv methods.
                    return {};
                case 'constants':
                    // Return the merged fs+os+crypto constants so
                    // legacy `require('process').binding('constants')`
                    // gets a usable map (Node had this for years).
                    try {
                        var c = {};
                        var fs = require('fs');
                        var os = require('os');
                        if (fs && fs.constants) Object.assign(c, fs.constants);
                        if (os && os.constants) {
                            if (os.constants.errno) Object.assign(c, os.constants.errno);
                            if (os.constants.signals) Object.assign(c, os.constants.signals);
                        }
                        return c;
                    } catch (_) { return {}; }
            }
            var err = new Error(
                "process.binding('" + which + "') is not supported in the " +
                "Afterburner sandbox: native bindings (libuv internals and " +
                ".node addons) require executing native machine code, which " +
                "the WASM sandbox cannot do by design (different ISA from " +
                "the bytecode the runtime executes)."
            );
            err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
            err.bindingName = which;
            throw err;
        },

        // Same surface as `process.binding` but for the post-Node-16
        // internal-only API.
        _linkedBinding: function(name) {
            var err = new Error(
                "process._linkedBinding('" + String(name) + "') is not " +
                "supported in the Afterburner sandbox"
            );
            err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
            err.bindingName = String(name);
            throw err;
        }
    };

    fields.hrtime.bigint = function() {
        var t = fields.hrtime();
        return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
    };

    Object.keys(fields).forEach(function(k) { proc[k] = fields[k]; });

    globalThis.process = proc;
    __register_host_module('process', proc);
})();

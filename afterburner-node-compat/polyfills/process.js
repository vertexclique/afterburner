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
        version:  'v20.0.0-afterburner',
        versions: { node: '20.0.0', afterburner: '0.1.0' },
        env:      hostEnv,
        argv:     argv,
        execPath: '/usr/bin/afterburner',
        pid:      1,
        title:    'afterburner',

        cwd:      function() { return globalThis.__host_cwd || '/'; },
        chdir:    function() { throw new Error('process.chdir is not supported'); },

        nextTick: function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args);
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
            var err = new Error(
                "process.binding('" + which + "') is not supported in the " +
                "Afterburner sandbox: native bindings (libuv internals, " +
                ".node addons) cannot run in WASM. See " +
                "docs/STATUS.md → 'Why we cannot run .node addons inside the sandbox'."
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

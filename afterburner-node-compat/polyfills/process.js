// process — a lean facade. `env` / `platform` / `arch` are backed by
// host globals when the native/WASM layer sets them; otherwise defaults.
// `nextTick` is treated like `setImmediate` (synchronous per timers.js).

__register_module('process', function(module, exports, require) {

    // Host-populated; guard for absence.
    var hostEnv = globalThis.__host_env || {};

    var proc = {
        platform:  globalThis.__host_platform  || 'linux',
        arch:      globalThis.__host_arch      || 'x64',
        version:   'v20.0.0-afterburner',
        versions:  { node: '20.0.0', afterburner: '0.1.0' },
        env:       hostEnv,
        argv:      ['afterburner'],
        execPath:  '/usr/bin/afterburner',
        pid:       1,
        title:     'afterburner',

        cwd:       function() { return globalThis.__host_cwd || '/'; },
        chdir:     function(_d) { throw new Error('process.chdir is not supported'); },

        nextTick:  function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args);
        },

        exit:      function(code) {
            if (globalThis.__host_process_exit) globalThis.__host_process_exit(code || 0);
            var err = new Error('process.exit(' + (code || 0) + ')');
            err.code = 'ERR_PROCESS_EXIT';
            err.exitCode = code || 0;
            throw err;
        },

        hrtime:    function(prev) {
            // No high-res clock in the sandbox. Fall back to Date.now().
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

        stdout:    { write: function(s) { if (globalThis.console) console.log(String(s)); return true; } },
        stderr:    { write: function(s) { if (globalThis.console) console.error(String(s)); return true; } },
        stdin:     { on: function() {}, read: function() { return null; } }
    };

    proc.hrtime.bigint = function() {
        var t = proc.hrtime();
        return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
    };

    module.exports = proc;

    // Expose as a global, matching Node.
    if (!globalThis.process) globalThis.process = proc;
});

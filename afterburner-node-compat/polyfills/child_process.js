// child_process — native-only. The WASM plugin does not expose this
// surface, so `require('child_process').execSync(...)` throws on WASM.
//
// Sync methods only: Afterburner has no event loop to drive async
// callbacks.

__register_module('child_process', function(module, exports, require) {

    function ensureHost() {
        var fn = globalThis.__host_child_process_exec_sync;
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: child_process is not available in this sandbox");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function parseResult(raw) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var err = new Error("child_process: " + raw.slice('__HOST_ERR__:'.length));
            err.code = 'EACCES';
            throw err;
        }
        return JSON.parse(raw);
    }

    exports.execSync = function(command, options) {
        // Node's `execSync` takes a whole command string; we split on
        // whitespace for the simple shim.
        var parts = String(command).split(/\s+/).filter(Boolean);
        if (parts.length === 0) throw new Error("child_process.execSync: empty command");
        var argv = parts.slice(1);
        var raw = ensureHost()(parts[0], argv);
        var result = parseResult(raw);
        if (result.status !== 0) {
            var err = new Error("Command failed: " + command + "\n" + result.stderr);
            err.status = result.status;
            err.stdout = result.stdout;
            err.stderr = result.stderr;
            throw err;
        }
        return result.stdout;
    };

    exports.spawnSync = function(command, args, options) {
        args = args || [];
        var raw = ensureHost()(String(command), args.map(String));
        return parseResult(raw);
    };
});

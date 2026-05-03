// child_process — sync subset (execSync / spawnSync), backed by
// `__host_child_process_exec_sync` on both the native (rquickjs) path
// and the WASM-sandbox path. Argv crosses the host import boundary as
// a JSON-encoded array string so the wire shape stays primitive
// (host_imports work in (ptr, len) pairs, no array marshalling).
//
// Sync methods only: burn does not drive async child_process events.

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

    function callHost(cmd, argv) {
        // Always serialize argv as JSON for both native and wasm paths
        // — the wasm host import only accepts scalar args, and keeping
        // the wire identical means a single `parseResult` works for
        // both backends.
        var argvJson = JSON.stringify((argv || []).map(String));
        return ensureHost()(String(cmd), argvJson);
    }

    exports.execSync = function(command, options) {
        // Node's `execSync` takes a whole command string; we split on
        // whitespace for the simple shim.
        var parts = String(command).split(/\s+/).filter(Boolean);
        if (parts.length === 0) throw new Error("child_process.execSync: empty command");
        var argv = parts.slice(1);
        var raw = callHost(parts[0], argv);
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
        var raw = callHost(command, args);
        return parseResult(raw);
    };
});

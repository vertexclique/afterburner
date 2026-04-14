// afterburner:host — ScramDB-facing hooks. Not part of Node's standard
// surface; lives under the `afterburner:` package namespace. The host
// wires a `HostContext` trait implementation on the combustor side
// that answers `readColumn`/`emitRow`/`getEnv`; if no context is
// attached, `readColumn` returns `[]`, `emitRow` is a no-op, and
// `getEnv` returns `undefined`.

__register_module('afterburner:host', function(module, exports, require) {

    exports.readColumn = function(name) {
        var fn = globalThis.__host_read_column;
        if (typeof fn !== 'function') return [];
        var raw = fn(String(name));
        try { return JSON.parse(raw); } catch (_) { return []; }
    };

    exports.emitRow = function(row) {
        var fn = globalThis.__host_emit_row;
        if (typeof fn !== 'function') return;
        var json;
        try { json = JSON.stringify(row); }
        catch (e) { throw new TypeError('emitRow: row must be JSON-serializable: ' + e.message); }
        fn(json);
    };

    exports.getEnv = function(key) {
        var fn = globalThis.__host_get_env;
        if (typeof fn !== 'function') return undefined;
        var v = fn(String(key));
        return (v === null || v === undefined) ? undefined : v;
    };
});

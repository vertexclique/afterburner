// afterburner:state — cross-invocation key/value store. Not part of
// Node's standard surface; lives under the `afterburner:` package
// namespace so it can never collide with a real Node module.
//
// Values are stored as opaque bytes by the host. JS exposes:
//   * get(key)   -> Buffer | null
//   * set(key, value)  (string | Buffer | Uint8Array)
//   * delete(key)
//   * getJSON / setJSON convenience wrappers

__register_module('afterburner:state', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    function ensure(name) {
        var fn = globalThis['__host_state_' + name];
        if (typeof fn !== 'function') {
            throw new Error('afterburner:state.' + name + ' is not available');
        }
        return fn;
    }

    function toBytesB64(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
        if (Buffer.isBuffer(value))    return value.toString('base64');
        if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
        throw new TypeError('state.set: value must be string/Buffer/Uint8Array');
    }

    exports.get = function(key) {
        var raw = ensure('get')(String(key));
        if (raw === null || raw === undefined) return null;
        return Buffer.from(raw, 'base64');
    };

    exports.set = function(key, value) {
        ensure('set')(String(key), toBytesB64(value));
    };

    exports['delete'] = function(key) {
        ensure('delete')(String(key));
    };

    exports.has = function(key) {
        return exports.get(key) !== null;
    };

    // JSON helpers — the most common usage.
    exports.getJSON = function(key) {
        var b = exports.get(key);
        if (b === null) return undefined;
        try { return JSON.parse(b.toString('utf8')); } catch (e) { return undefined; }
    };
    exports.setJSON = function(key, value) {
        exports.set(key, JSON.stringify(value));
    };

    // Numeric helper for counters.
    exports.increment = function(key, delta) {
        var n = exports.getJSON(key);
        if (typeof n !== 'number') n = 0;
        n += (delta === undefined ? 1 : delta);
        exports.setJSON(key, n);
        return n;
    };
});

// querystring — the legacy Node module. For new code `URLSearchParams`
// (a QuickJS built-in) is a better fit; this module exists for parity
// with code that still imports it.

__register_module('querystring', function(module, exports, require) {

    function enc(s) { return encodeURIComponent(String(s)); }
    function dec(s) {
        try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }
        catch (_) { return String(s); }
    }

    exports.escape = enc;
    exports.unescape = dec;

    exports.stringify = function(obj, sep, eq, options) {
        sep = sep || '&';
        eq = eq || '=';
        if (obj === null || typeof obj !== 'object') return '';
        var keys = Object.keys(obj);
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = obj[k];
            var ek = enc(k);
            if (Array.isArray(v)) {
                for (var j = 0; j < v.length; j++) {
                    parts.push(ek + eq + enc(v[j]));
                }
            } else if (v === null || v === undefined) {
                parts.push(ek + eq);
            } else {
                parts.push(ek + eq + enc(v));
            }
        }
        return parts.join(sep);
    };

    exports.parse = function(str, sep, eq, options) {
        var obj = Object.create(null);
        if (typeof str !== 'string' || str.length === 0) return obj;
        sep = sep || '&';
        eq = eq || '=';
        var maxKeys = (options && options.maxKeys) || 1000;
        var pairs = str.split(sep);
        var limit = pairs.length;
        if (maxKeys > 0 && limit > maxKeys) limit = maxKeys;
        for (var i = 0; i < limit; i++) {
            var pair = pairs[i];
            var idx = pair.indexOf(eq);
            var k, v;
            if (idx >= 0) { k = dec(pair.slice(0, idx)); v = dec(pair.slice(idx + eq.length)); }
            else          { k = dec(pair); v = ''; }
            if (!Object.prototype.hasOwnProperty.call(obj, k)) obj[k] = v;
            else if (Array.isArray(obj[k])) obj[k].push(v);
            else obj[k] = [obj[k], v];
        }
        return obj;
    };

    exports.encode = exports.stringify;
    exports.decode = exports.parse;
});

// crypto — Node-style hash/hmac/randomBytes/randomUUID, all backed by
// the engine's `__host_crypto_*` globals. A Hash/Hmac object accumulates
// data and returns the final digest on `.digest(encoding)`.

__register_module('crypto', function(module, exports, require) {

    function ensureHost(name) {
        var fn = globalThis['__host_crypto_' + name];
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: crypto." + name);
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function Hash(algorithm) {
        this._algo = String(algorithm).toLowerCase();
        this._chunks = [];
    }
    Hash.prototype.update = function(data) {
        this._chunks.push(typeof data === 'string' ? data : String(data));
        return this;
    };
    function checkErr(result, op) {
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("crypto." + op + ": " + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
            throw err;
        }
        return result;
    }

    Hash.prototype.digest = function(encoding) {
        return checkErr(
            ensureHost('hash')(this._algo, this._chunks.join(''), encoding || 'hex'),
            'hash'
        );
    };

    function Hmac(algorithm, key) {
        this._algo = String(algorithm).toLowerCase();
        this._key  = typeof key === 'string' ? key : String(key);
        this._chunks = [];
    }
    Hmac.prototype.update = function(data) {
        this._chunks.push(typeof data === 'string' ? data : String(data));
        return this;
    };
    Hmac.prototype.digest = function(encoding) {
        return checkErr(
            ensureHost('hmac')(this._algo, this._key, this._chunks.join(''), encoding || 'hex'),
            'hmac'
        );
    };

    exports.createHash = function(algorithm) { return new Hash(algorithm); };
    exports.createHmac = function(algorithm, key) { return new Hmac(algorithm, key); };

    exports.randomBytes = function(len, encoding) {
        var enc = typeof encoding === 'string' ? encoding : 'hex';
        return checkErr(ensureHost('random_bytes')(len, enc), 'randomBytes');
    };

    exports.randomUUID = function() {
        return checkErr(ensureHost('random_uuid')(), 'randomUUID');
    };

    exports.timingSafeEqual = function(a, b) {
        var fn = globalThis.__host_crypto_timing_safe_equal;
        if (typeof fn !== 'function') return false;
        return fn(typeof a === 'string' ? a : String(a),
                  typeof b === 'string' ? b : String(b));
    };

    // `randomFillSync` — filled for completeness; returns a string too.
    exports.randomFillSync = function(buffer) {
        var len = buffer && buffer.length ? buffer.length : 16;
        return ensureHost('random_bytes')(len, 'hex');
    };
});

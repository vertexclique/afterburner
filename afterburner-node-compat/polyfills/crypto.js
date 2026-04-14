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

    // ---- ciphers (AES-GCM / AES-CBC) --------------------------------
    var Buffer = require('buffer').Buffer;

    function toB64(x) {
        if (typeof x === 'string') return Buffer.from(x, 'utf8').toString('base64');
        if (Buffer.isBuffer(x))    return x.toString('base64');
        if (x instanceof Uint8Array) return Buffer.from(x).toString('base64');
        throw new TypeError('expected string/Buffer/Uint8Array');
    }
    function fromB64(s, tag) {
        if (typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(tag + ': ' + s.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(s, 'base64');
    }

    function makeGcmCipher(algo, key, iv, opts) {
        var aad = null;
        var finalized = false;
        var queued = [];
        var mode = opts && opts.mode; // 'encrypt' | 'decrypt'
        var authTag = null;
        return {
            setAAD: function(buf) { aad = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); return this; },
            setAutoPadding: function() { return this; },
            update: function(data) {
                if (finalized) throw new Error('cipher finalized');
                queued.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                return Buffer.alloc(0);
            },
            setAuthTag: function(tag) { authTag = tag; return this; },
            getAuthTag: function() {
                if (mode !== 'encrypt' || !finalized) {
                    throw new Error('getAuthTag available only after encrypt final');
                }
                return authTag;
            },
            final: function() {
                if (finalized) throw new Error('cipher finalized');
                finalized = true;
                var data = Buffer.concat(queued);
                var fn = mode === 'encrypt' ? '__host_crypto_aes_gcm_encrypt' : '__host_crypto_aes_gcm_decrypt';
                var rawIn = mode === 'encrypt' ? data
                    : Buffer.concat([data, authTag || Buffer.alloc(16)]);
                var raw = globalThis[fn](
                    algo,
                    toB64(key),
                    toB64(iv),
                    toB64(rawIn),
                    aad ? toB64(aad) : null
                );
                var out = fromB64(raw, 'cipher');
                if (mode === 'encrypt') {
                    authTag = out.slice(out.length - 16);
                    return out.slice(0, out.length - 16);
                } else {
                    return out;
                }
            }
        };
    }

    function makeCbcCipher(algo, key, iv, mode) {
        var finalized = false;
        var queued = [];
        return {
            setAutoPadding: function() { return this; },
            update: function(data) {
                if (finalized) throw new Error('cipher finalized');
                queued.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                return Buffer.alloc(0);
            },
            final: function() {
                if (finalized) throw new Error('cipher finalized');
                finalized = true;
                var data = Buffer.concat(queued);
                var fn = mode === 'encrypt' ? '__host_crypto_aes_cbc_encrypt' : '__host_crypto_aes_cbc_decrypt';
                var raw = globalThis[fn](algo, toB64(key), toB64(iv), toB64(data));
                return fromB64(raw, 'cipher');
            }
        };
    }

    function makeCipher(algo, key, iv, mode) {
        var a = String(algo).toLowerCase();
        if (a.indexOf('-gcm') > 0) return makeGcmCipher(a, key, iv, { mode: mode });
        if (a.indexOf('-cbc') > 0) return makeCbcCipher(a, key, iv, mode);
        throw new Error('Unsupported cipher: ' + algo);
    }

    exports.createCipheriv = function(algo, key, iv) { return makeCipher(algo, key, iv, 'encrypt'); };
    exports.createDecipheriv = function(algo, key, iv) { return makeCipher(algo, key, iv, 'decrypt'); };

    // ---- KDFs --------------------------------------------------------
    exports.pbkdf2Sync = function(password, salt, iterations, keylen, digest) {
        var fn = globalThis.__host_crypto_pbkdf2_sync;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.pbkdf2Sync');
        }
        var pwd = typeof password === 'string' ? password
            : Buffer.isBuffer(password) ? password.toString('binary')
            : String(password);
        var saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt));
        var raw = fn(String(digest || 'sha256'), pwd, saltBuf.toString('base64'), iterations >>> 0, keylen >>> 0);
        return fromB64(raw, 'pbkdf2Sync');
    };

    // ---- sign / verify (RSA + ECDSA) ----------------------------------
    function signImpl(algorithm, keyPem, data) {
        var fn = globalThis.__host_crypto_sign;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.sign');
        }
        var dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        var raw = fn(String(algorithm), String(keyPem), dataBuf.toString('base64'));
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            throw new Error('crypto.sign: ' + raw.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(raw, 'base64');
    }

    function verifyImpl(algorithm, keyPem, data, signature) {
        var fn = globalThis.__host_crypto_verify;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.verify');
        }
        var dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        var sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature));
        var code = fn(
            String(algorithm),
            String(keyPem),
            dataBuf.toString('base64'),
            sigBuf.toString('base64')
        );
        // Both paths now return i32 (1/0/negative). Accept bool too in
        // case an embedder wires a host that returns it directly.
        if (code === 1 || code === true) return true;
        if (code === 0 || code === false) return false;
        throw new Error('crypto.verify: host error (code ' + code + ')');
    }

    exports.sign = signImpl;
    exports.verify = verifyImpl;

    // Node's stream-style createSign / createVerify. Streaming-backed:
    // chunks are hashed incrementally on the host side, so memory is
    // proportional to the digest state (~200 B) rather than the total
    // payload size.
    var ALGO_ALIASES = {
        'RSA-SHA256': 'RS256', 'RSA-SHA384': 'RS384', 'RSA-SHA512': 'RS512',
        'sha256WithRSAEncryption': 'RS256',
        'sha384WithRSAEncryption': 'RS384',
        'sha512WithRSAEncryption': 'RS512',
    };
    function canonicalAlgo(algo) { return ALGO_ALIASES[algo] || algo; }

    function streamingHostPresent() {
        return typeof globalThis.__host_crypto_sign_open === 'function'
            && typeof globalThis.__host_crypto_sign_update === 'function';
    }

    function makeSigner(algo) {
        var canonical = canonicalAlgo(algo);
        if (streamingHostPresent()) {
            var handle = globalThis.__host_crypto_sign_open(canonical);
            if (!handle) throw new Error('crypto.createSign: ' + canonical + ' not supported');
            return {
                update: function(d) {
                    var buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
                    var r = globalThis.__host_crypto_sign_update(handle, buf.toString('base64'));
                    if (typeof r === 'string' && r.indexOf('__HOST_ERR__:') === 0) {
                        throw new Error('crypto.sign.update: ' + r.slice('__HOST_ERR__:'.length));
                    }
                    return this;
                },
                sign: function(key) {
                    var raw = globalThis.__host_crypto_sign_finalize(handle, canonical, String(key));
                    if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                        throw new Error('crypto.sign: ' + raw.slice('__HOST_ERR__:'.length));
                    }
                    return Buffer.from(raw, 'base64');
                }
            };
        }
        // Fallback for older plugins / embedders that haven't wired
        // streaming: buffer everything and use the one-shot API.
        var chunks = [];
        return {
            update: function(d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return this; },
            sign:   function(key) { return signImpl(canonical, key, Buffer.concat(chunks)); }
        };
    }

    function makeVerifier(algo) {
        var canonical = canonicalAlgo(algo);
        if (streamingHostPresent() && typeof globalThis.__host_crypto_verify_finalize === 'function') {
            var handle = globalThis.__host_crypto_sign_open(canonical);
            if (!handle) throw new Error('crypto.createVerify: ' + canonical + ' not supported');
            return {
                update: function(d) {
                    var buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
                    var r = globalThis.__host_crypto_sign_update(handle, buf.toString('base64'));
                    if (typeof r === 'string' && r.indexOf('__HOST_ERR__:') === 0) {
                        throw new Error('crypto.verify.update: ' + r.slice('__HOST_ERR__:'.length));
                    }
                    return this;
                },
                verify: function(key, sig) {
                    var sigBuf = Buffer.isBuffer(sig) ? sig : Buffer.from(String(sig));
                    var code = globalThis.__host_crypto_verify_finalize(
                        handle, canonical, String(key), sigBuf.toString('base64'));
                    if (code === 1 || code === true) return true;
                    if (code === 0 || code === false) return false;
                    throw new Error('crypto.verify: host error (code ' + code + ')');
                }
            };
        }
        var chunks = [];
        return {
            update: function(d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return this; },
            verify: function(key, sig) { return verifyImpl(canonical, key, Buffer.concat(chunks), sig); }
        };
    }
    exports.createSign = makeSigner;
    exports.createVerify = makeVerifier;

    exports.scryptSync = function(password, salt, keylen, options) {
        var fn = globalThis.__host_crypto_scrypt_sync;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.scryptSync');
        }
        options = options || {};
        var N = options.N || options.cost || 16384;
        var r = options.r || options.blockSize || 8;
        var p = options.p || options.parallelization || 1;
        var pwd = typeof password === 'string' ? password
            : Buffer.isBuffer(password) ? password.toString('binary')
            : String(password);
        var saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt));
        var raw = fn(pwd, saltBuf.toString('base64'), N >>> 0, r >>> 0, p >>> 0, keylen >>> 0);
        return fromB64(raw, 'scryptSync');
    };
});

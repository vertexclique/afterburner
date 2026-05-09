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

    function checkErr(result, op) {
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("crypto." + op + ": " + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
            throw err;
        }
        return result;
    }

    function streamingHashPresent() {
        return typeof globalThis.__host_crypto_hash_open === 'function'
            && typeof globalThis.__host_crypto_hash_update === 'function'
            && typeof globalThis.__host_crypto_hash_digest === 'function';
    }

    // Encode whatever the user handed us as a base64 string for the
    // streaming host wire. String inputs go through UTF-8 to match
    // Node's default. Buffer / Uint8Array pass through as their raw
    // bytes, so binary data roundtrips cleanly.
    function toUpdateB64(data) {
        if (data == null) return '';
        var B = require('buffer').Buffer;
        if (typeof data === 'string') {
            return B.from(data, 'utf8').toString('base64');
        }
        if (B.isBuffer(data)) return data.toString('base64');
        if (data instanceof Uint8Array) return B.from(data).toString('base64');
        // Fall back to String() coercion — matches old behavior for
        // weird input types.
        return B.from(String(data), 'utf8').toString('base64');
    }

    // When a host `open` returns the 0-sentinel, the detailed reason
    // is in `__host_last_error` on WASM. Native throws the exception
    // inline, so this path only fires in the WASM sandbox.
    function throwOpenErr(op, algo) {
        var msg = '';
        if (typeof globalThis.__host_last_error === 'function') {
            msg = String(globalThis.__host_last_error() || '');
        }
        if (!msg) msg = "'" + algo + "' not supported";
        var err = new Error('crypto.' + op + ': ' + msg);
        if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
        throw err;
    }

    function Hash(algorithm) {
        this._algo = String(algorithm).toLowerCase();
        this._finalized = false;
        this._streaming = streamingHashPresent();
        if (this._streaming) {
            this._handle = globalThis.__host_crypto_hash_open(this._algo);
            if (!this._handle) throwOpenErr('createHash', this._algo);
        } else {
            this._chunks = [];
        }
    }
    Hash.prototype.update = function(data) {
        if (this._finalized) throw new Error('Digest already called');
        if (this._streaming) {
            var r = globalThis.__host_crypto_hash_update(this._handle, toUpdateB64(data));
            if (typeof r === 'string' && r.indexOf('__HOST_ERR__:') === 0) {
                throw new Error('crypto.hash.update: ' + r.slice('__HOST_ERR__:'.length));
            }
        } else {
            this._chunks.push(typeof data === 'string' ? data : String(data));
        }
        return this;
    };
    Hash.prototype.digest = function(encoding) {
        if (this._finalized) throw new Error('Digest already called');
        this._finalized = true;
        var enc = encoding || 'hex';
        if (this._streaming) {
            return checkErr(
                globalThis.__host_crypto_hash_digest(this._handle, enc),
                'hash'
            );
        }
        return checkErr(
            ensureHost('hash')(this._algo, this._chunks.join(''), enc),
            'hash'
        );
    };

    function Hmac(algorithm, key) {
        this._algo = String(algorithm).toLowerCase();
        this._finalized = false;
        this._streaming = streamingHashPresent()
            && typeof globalThis.__host_crypto_hmac_open === 'function';
        if (this._streaming) {
            var B = require('buffer').Buffer;
            var keyB64 = typeof key === 'string'
                ? B.from(key, 'utf8').toString('base64')
                : (B.isBuffer(key) ? key.toString('base64')
                   : B.from(String(key), 'utf8').toString('base64'));
            this._handle = globalThis.__host_crypto_hmac_open(this._algo, keyB64);
            if (!this._handle) throwOpenErr('createHmac', this._algo);
        } else {
            this._key = typeof key === 'string' ? key : String(key);
            this._chunks = [];
        }
    }
    Hmac.prototype.update = function(data) {
        if (this._finalized) throw new Error('Digest already called');
        if (this._streaming) {
            var r = globalThis.__host_crypto_hash_update(this._handle, toUpdateB64(data));
            if (typeof r === 'string' && r.indexOf('__HOST_ERR__:') === 0) {
                throw new Error('crypto.hmac.update: ' + r.slice('__HOST_ERR__:'.length));
            }
        } else {
            this._chunks.push(typeof data === 'string' ? data : String(data));
        }
        return this;
    };
    Hmac.prototype.digest = function(encoding) {
        if (this._finalized) throw new Error('Digest already called');
        this._finalized = true;
        var enc = encoding || 'hex';
        if (this._streaming) {
            return checkErr(
                globalThis.__host_crypto_hash_digest(this._handle, enc),
                'hmac'
            );
        }
        return checkErr(
            ensureHost('hmac')(this._algo, this._key, this._chunks.join(''), enc),
            'hmac'
        );
    };

    exports.createHash = function(algorithm) { return new Hash(algorithm); };
    exports.createHmac = function(algorithm, key) { return new Hmac(algorithm, key); };

    // Supported hash + cipher catalogues. Keep these aligned with the
    // host's crypto bridge — packaging tools (npm/ssri/node-tap) call
    // `getHashes()` at module-init time and crash with TypeError when
    // it is missing.
    var SUPPORTED_HASHES = [
        'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
        'shake128', 'shake256'
    ];
    var SUPPORTED_CIPHERS = [
        'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
        'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'
    ];
    exports.getHashes  = function() { return SUPPORTED_HASHES.slice(); };
    exports.getCiphers = function() { return SUPPORTED_CIPHERS.slice(); };
    exports.getCurves  = function() { return ['P-256', 'P-384', 'P-521']; };

    /// `crypto.randomBytes(len[, callback])` — Node returns a Buffer
    /// of `len` cryptographically random bytes. The callback form
    /// (Node 0.5+) takes `(err, buf)`. We get the bytes from the host
    /// as a hex string, then re-pack into a Buffer to match Node's
    /// API surface.
    exports.randomBytes = function(len, cb) {
        var hex = checkErr(ensureHost('random_bytes')(len, 'hex'), 'randomBytes');
        var buf = Buffer.from(hex, 'hex');
        if (typeof cb === 'function') {
            Promise.resolve().then(function() { cb(null, buf); });
            return undefined;
        }
        return buf;
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

    // `randomFillSync(buffer[, offset[, size]])` — fills the buffer
    // in-place with cryptographically random bytes. Returns the buffer.
    exports.randomFillSync = function(buffer, offset, size) {
        if (!buffer || typeof buffer.length !== 'number') {
            throw new TypeError('randomFillSync: buffer must be a TypedArray');
        }
        var off = (offset | 0) || 0;
        var len = (typeof size === 'number') ? (size | 0) : (buffer.length - off);
        if (len <= 0) return buffer;
        var hex = ensureHost('random_bytes')(len, 'hex');
        if (typeof hex !== 'string') return buffer;
        var view = (buffer.buffer && typeof buffer.buffer === 'object')
            ? new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length)
            : buffer;
        for (var i = 0; i < len; i++) {
            view[off + i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return buffer;
    };

    /// `randomFill(buffer[, offset[, size]], cb)` — async variant.
    /// Same operation; calls cb on next microtask.
    exports.randomFill = function(buffer, offset, size, cb) {
        if (typeof offset === 'function') { cb = offset; offset = undefined; size = undefined; }
        else if (typeof size === 'function') { cb = size; size = undefined; }
        try {
            exports.randomFillSync(buffer, offset, size);
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(null, buffer); });
        } catch (e) {
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(e); });
        }
    };

    /// `crypto.randomInt([min, ]max[, callback])` — uniform integer
    /// in `[min, max)`. Sync if no callback. Min defaults to 0.
    exports.randomInt = function(min, max, cb) {
        if (typeof min === 'function') { cb = min; min = 0; max = 0xffffffff; }
        else if (typeof max === 'function') { cb = max; max = min; min = 0; }
        else if (max === undefined) { max = min; min = 0; }
        if (min < 0 || max <= min || max - min > Math.pow(2, 48)) {
            var err = new RangeError('randomInt: min/max out of range');
            if (typeof cb === 'function') {
                Promise.resolve().then(function() { cb(err); });
                return;
            }
            throw err;
        }
        var range = max - min;
        // Sample 6 bytes (2^48), reject + retry to avoid modulo bias.
        function sample() {
            var hex = ensureHost('random_bytes')(6, 'hex');
            var n = 0;
            for (var i = 0; i < 12; i++) n = n * 16 + parseInt(hex.charAt(i), 16);
            var max48 = Math.pow(2, 48);
            var fold = max48 - (max48 % range);
            if (n >= fold) return sample(); // discard biased range
            return min + (n % range);
        }
        var v = sample();
        if (typeof cb === 'function') {
            Promise.resolve().then(function() { cb(null, v); });
            return;
        }
        return v;
    };

    /// `crypto.timingSafeEqual` already exists (inline below); the
    /// alias below matches Node's Web Crypto export for callers that
    /// reach for `crypto.webcrypto.subtle`.
    exports.webcrypto = (typeof globalThis.crypto === 'object') ? globalThis.crypto : undefined;

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

    /// `crypto.scrypt(password, salt, keylen, options, cb)` — Node's
    /// async wrapper. Our scrypt is host-side synchronous, so we
    /// dispatch on a microtask to preserve the cb-after-IO contract.
    exports.scrypt = function(password, salt, keylen, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.scryptSync(password, salt, keylen, options)); }
            catch (e) { cb(e); }
        });
    };

    /// `crypto.hash(algorithm, data, encoding)` — Node 21+ one-shot
    /// hash that skips the `createHash` ceremony. Returns the digest
    /// directly in the requested encoding (default 'hex').
    exports.hash = function(algorithm, data, encoding) {
        var h = exports.createHash(algorithm);
        h.update(data);
        return h.digest(encoding || 'hex');
    };

    /// `crypto.hkdfSync(digest, ikm, salt, info, length)` — Node 15+.
    /// Composes HKDF-Extract + HKDF-Expand from createHmac. Returns
    /// the OKM as an ArrayBuffer (Node returns ArrayBuffer too).
    exports.hkdfSync = function(digest, ikm, salt, info, length) {
        var Buffer = require('buffer').Buffer;
        var ikmBuf  = Buffer.isBuffer(ikm)  ? ikm  : Buffer.from(ikm);
        var saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt || '');
        var infoBuf = Buffer.isBuffer(info) ? info : Buffer.from(info || '');
        // HKDF-Extract: PRK = HMAC(salt, IKM)
        var extract = exports.createHmac(digest, saltBuf);
        extract.update(ikmBuf);
        var prk = Buffer.from(extract.digest('hex'), 'hex');
        // HKDF-Expand: T(0) = empty; T(i) = HMAC(PRK, T(i-1) || info || 0xi)
        var hashLen = prk.length;
        var n = Math.ceil(length / hashLen);
        if (n > 255) {
            throw new RangeError('HKDF: length too large');
        }
        var okm = Buffer.alloc(0);
        var t = Buffer.alloc(0);
        for (var i = 1; i <= n; i++) {
            var h = exports.createHmac(digest, prk);
            h.update(Buffer.concat([t, infoBuf, Buffer.from([i])]));
            t = Buffer.from(h.digest('hex'), 'hex');
            okm = Buffer.concat([okm, t]);
        }
        var out = okm.slice(0, length);
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    };

    /// `crypto.hkdf(...)` — async sibling. Mirrors hkdfSync on a
    /// microtask.
    exports.hkdf = function(digest, ikm, salt, info, length, cb) {
        Promise.resolve().then(function() {
            try { cb(null, exports.hkdfSync(digest, ikm, salt, info, length)); }
            catch (e) { cb(e); }
        });
    };

    /// `crypto.subtle` — alias to globalThis.crypto.subtle (Node 15+
    /// ships SubtleCrypto via the crypto module, not just globally).
    Object.defineProperty(exports, 'subtle', {
        get: function() {
            return globalThis.crypto && globalThis.crypto.subtle;
        },
        configurable: true,
    });

    /// `crypto.fips` — boolean flag exposed since Node 0.12. We're
    /// not FIPS-validated; surfacing `false` matches what most non-
    /// FIPS Node builds report.
    Object.defineProperty(exports, 'fips', {
        value: false, writable: false, configurable: true, enumerable: true,
    });

    /// `crypto.KeyObject` / `X509Certificate` / `createSecretKey` /
    /// `createPrivateKey` / `createPublicKey` / `generateKeyPair` /
    /// `generateKeyPairSync` / `diffieHellman` / `checkPrime` /
    /// `generatePrime` — Node's typed key surface. We don't ship a
    /// real OpenSSL; the stubs throw a clear ERR_NOT_IMPLEMENTED so
    /// libraries that probe for these names get a graceful failure
    /// instead of a `is not a function` crash.
    function _notImpl(name) {
        return function() {
            var err = new Error('crypto.' + name + ' is not implemented in burn');
            err.code = 'ERR_NOT_IMPLEMENTED';
            throw err;
        };
    }
    exports.KeyObject = function KeyObject() { throw _notImpl('KeyObject ctor')(); };
    exports.KeyObject.from = _notImpl('KeyObject.from');
    exports.X509Certificate = function X509Certificate() { throw _notImpl('X509Certificate ctor')(); };
    exports.createSecretKey = _notImpl('createSecretKey');
    exports.createPrivateKey = _notImpl('createPrivateKey');
    exports.createPublicKey = _notImpl('createPublicKey');
    exports.generateKeyPairSync = _notImpl('generateKeyPairSync');
    exports.generateKeyPair = function(type, options, cb) {
        if (typeof options === 'function') { cb = options; }
        Promise.resolve().then(function() {
            cb(new Error('crypto.generateKeyPair is not implemented in burn'));
        });
    };
    exports.diffieHellman = _notImpl('diffieHellman');
    exports.createDiffieHellman = _notImpl('createDiffieHellman');
    exports.createDiffieHellmanGroup = _notImpl('createDiffieHellmanGroup');
    exports.getDiffieHellman = _notImpl('getDiffieHellman');
    exports.createECDH = _notImpl('createECDH');
    /// `crypto.checkPrimeSync(candidate, options?)` — Miller-Rabin
    /// primality test. Accepts `BigInt`, `number`, `Buffer` (BE bytes),
    /// `Uint8Array`. Node's `options.checks` is honoured (default 0 →
    /// host picks 40 rounds for ≤2^-80 false-positive probability).
    function _candidateToHex(c) {
        if (typeof c === 'bigint') {
            var s = c.toString(16);
            if (s.length % 2 !== 0) s = '0' + s;
            return s;
        }
        if (typeof c === 'number') {
            if (!Number.isFinite(c) || c < 0) return '00';
            var s2 = Math.floor(c).toString(16);
            if (s2.length % 2 !== 0) s2 = '0' + s2;
            return s2;
        }
        if (c instanceof ArrayBuffer) c = new Uint8Array(c);
        if (ArrayBuffer.isView(c) || c instanceof Uint8Array
            || (typeof Buffer !== 'undefined' && Buffer.isBuffer(c))) {
            var bytes = (typeof Buffer !== 'undefined' && Buffer.isBuffer(c))
                ? c : new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                hex += ('0' + bytes[i].toString(16)).slice(-2);
            }
            return hex || '00';
        }
        throw new TypeError('checkPrime: candidate must be number / BigInt / Buffer');
    }
    exports.checkPrimeSync = function(p, options) {
        var checks = (options && (options.checks | 0)) || 0;
        var hex = _candidateToHex(p);
        if (typeof globalThis.__host_crypto_check_prime !== 'function') {
            throw new Error('crypto.checkPrimeSync: host fn missing');
        }
        var r = globalThis.__host_crypto_check_prime(hex, checks);
        if (r < 0) throw new Error('checkPrime: host error code ' + r);
        return r === 1;
    };
    exports.checkPrime = function(p, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.checkPrimeSync(p, options)); }
            catch (e) { cb(e); }
        });
    };
    /// `crypto.generatePrimeSync(size, options?)` — Generate a probable
    /// prime of `size` bits. `options.safe` requires `(p-1)/2` also
    /// prime. Returns BigInt by default (matches Node 15+).
    exports.generatePrimeSync = function(size, options) {
        if (typeof globalThis.__host_crypto_generate_prime !== 'function') {
            throw new Error('crypto.generatePrimeSync: host fn missing');
        }
        var safe = !!(options && options.safe);
        var hex = globalThis.__host_crypto_generate_prime(size | 0, safe);
        if (typeof hex === 'string' && hex.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(hex.slice('__HOST_ERR__:'.length));
        }
        if (options && options.bigint === false) {
            // Buffer of BE bytes when the caller opts out of BigInt.
            return Buffer.from(hex, 'hex');
        }
        return BigInt('0x' + hex);
    };
    exports.generatePrime = function(size, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.generatePrimeSync(size, options)); }
            catch (e) { cb(e); }
        });
    };
    exports.secureHeapUsed = function() {
        return { total: 0, min: 0, used: 0, utilization: 0 };
    };
    exports.setEngine = function() { /* no-op */ };
    exports.setFips = function() { /* no-op */ };
    exports.getFips = function() { return 0; };

    // ---- crypto.constants -----------------------------------------
    //
    // Subset that real-world packages probe: OpenSSL flag bits + the
    // signing/padding scheme constants used by `crypto.sign` /
    // `subtle.sign` callers. Burn doesn't use these for gating
    // (the host-side rust-crypto crates encode the algorithm in the
    // call shape), but exposing them keeps `require('crypto').constants.RSA_PKCS1_PADDING`
    // probes from being `undefined` and crashing.
    exports.constants = {
        // SSL options
        SSL_OP_ALL: 0x80000bff,
        SSL_OP_NO_SSLv2: 0x01000000,
        SSL_OP_NO_SSLv3: 0x02000000,
        SSL_OP_NO_TLSv1: 0x04000000,
        SSL_OP_NO_TLSv1_1: 0x10000000,
        SSL_OP_NO_TLSv1_2: 0x08000000,
        SSL_OP_NO_TLSv1_3: 0x20000000,
        // RSA padding
        RSA_PKCS1_PADDING: 1,
        RSA_SSLV23_PADDING: 2,
        RSA_NO_PADDING: 3,
        RSA_PKCS1_OAEP_PADDING: 4,
        RSA_X931_PADDING: 5,
        RSA_PKCS1_PSS_PADDING: 6,
        // PSS salt
        RSA_PSS_SALTLEN_DIGEST: -1,
        RSA_PSS_SALTLEN_MAX_SIGN: -2,
        RSA_PSS_SALTLEN_AUTO: -2,
        // DH point formats
        POINT_CONVERSION_COMPRESSED: 2,
        POINT_CONVERSION_UNCOMPRESSED: 4,
        POINT_CONVERSION_HYBRID: 6,
        // Hash algorithms (for crypto.diffieHellman)
        ENGINE_METHOD_NONE: 0x00,
        ENGINE_METHOD_ALL: 0xffff,
        DH_CHECK_P_NOT_SAFE_PRIME: 2,
        DH_CHECK_P_NOT_PRIME: 1,
        DH_NOT_SUITABLE_GENERATOR: 8,
        DH_UNABLE_TO_CHECK_GENERATOR: 4,
        defaultCoreCipherList:
            'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:'
            + 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:'
            + 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384',
    };
});

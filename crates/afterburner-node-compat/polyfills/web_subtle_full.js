// Web Crypto Subtle — round-out to full Node 26 / WHATWG parity.
//
// `web_compat.js` ships a base SubtleCrypto with AES-GCM/CBC + HMAC +
// PBKDF2 + HKDF + SHA-* digest. This file extends it with everything
// else Node 26 lists as stable: AES-CTR, AES-KW, RSA-OAEP / RSA-PSS /
// RSASSA-PKCS1-v1_5, ECDSA / ECDH on P-256/384/521, Ed25519, X25519.
//
// The dispatch routes through a single host import,
// `__host_crypto_subtle_op(op, args_json)`, which pure-Rust implements
// every algorithm. JS handles parameter shaping + key shaping; the
// host does crypto. This keeps the JS surface tight and the trust
// boundary inside Rust.
//
// All wire bytes cross as base64url-encoded strings. The dispatcher
// returns either a base64url string (single output) or a JSON
// `["<b64>","<b64>"]` array (key-pair output).

(function installFullSubtle() {
    if (typeof globalThis.crypto !== 'object' || !globalThis.crypto.subtle) {
        return; // no base subtle — web_compat.js is the gate
    }
    var subtle = globalThis.crypto.subtle;

    function _toBytes(input) {
        if (input == null) return new Uint8Array(0);
        if (input instanceof ArrayBuffer) return new Uint8Array(input);
        if (ArrayBuffer.isView(input)) {
            return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        }
        if (typeof input === 'string') return new TextEncoder().encode(input);
        return new Uint8Array(input);
    }
    function _b64UrlEncodeBytes(bytes) {
        var Buf = globalThis.Buffer || require('buffer').Buffer;
        return Buf.from(bytes).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function _b64UrlDecodeToBytes(b64) {
        var s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4 !== 0) s += '=';
        var Buf = globalThis.Buffer || require('buffer').Buffer;
        return new Uint8Array(Buf.from(s, 'base64'));
    }
    function _algoName(a) {
        return (typeof a === 'string') ? a.toLowerCase()
             : (a && a.name) ? String(a.name).toLowerCase()
             : '';
    }
    function _hashCanonical(h) {
        // Web Crypto canonical: 'SHA-256'; we accept lowercase + sha256.
        var s = (typeof h === 'string') ? h : (h && h.name) || '';
        s = String(s).toUpperCase();
        if (s === 'SHA1' || s === 'SHA-1') return 'SHA-1';
        if (s === 'SHA224' || s === 'SHA-224') return 'SHA-224';
        if (s === 'SHA256' || s === 'SHA-256') return 'SHA-256';
        if (s === 'SHA384' || s === 'SHA-384') return 'SHA-384';
        if (s === 'SHA512' || s === 'SHA-512') return 'SHA-512';
        return s;
    }
    function _curveCanonical(c) {
        if (!c) return '';
        var s = String(c).toUpperCase().replace(/[_]/g, '-');
        if (s === 'P-256' || s === 'P256') return 'P-256';
        if (s === 'P-384' || s === 'P384') return 'P-384';
        if (s === 'P-521' || s === 'P521') return 'P-521';
        return s;
    }
    function _hashFromCurve(curve) {
        if (curve === 'P-256') return 'SHA-256';
        if (curve === 'P-384') return 'SHA-384';
        if (curve === 'P-521') return 'SHA-512';
        return 'SHA-256';
    }

    // --- single dispatcher -------------------------------------------
    function _hostOp(op, byteArgs) {
        if (typeof globalThis.__host_crypto_subtle_op !== 'function') {
            throw new Error('crypto.subtle: host dispatcher missing — '
                + 'rebuild plugin to expose __host_crypto_subtle_op');
        }
        var jsonArgs = '[' + byteArgs.map(function(b) {
            return JSON.stringify(_b64UrlEncodeBytes(_toBytes(b)));
        }).join(',') + ']';
        var out = globalThis.__host_crypto_subtle_op(op, jsonArgs);
        if (typeof out === 'string' && out.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(out.slice('__HOST_ERR__:'.length));
        }
        return out;
    }
    function _hostOpBytes(op, byteArgs) {
        return _b64UrlDecodeToBytes(_hostOp(op, byteArgs));
    }
    function _hostOpPair(op, byteArgs) {
        var s = _hostOp(op, byteArgs);
        var arr = JSON.parse(s);
        return [_b64UrlDecodeToBytes(arr[0]), _b64UrlDecodeToBytes(arr[1])];
    }

    // --- key shape helper -----------------------------------------
    function _makeKey(algorithm, raw, type, extractable, usages) {
        var k = Object.create(null);
        Object.defineProperty(k, 'algorithm', { value: algorithm, enumerable: true });
        Object.defineProperty(k, 'type', { value: type, enumerable: true });
        Object.defineProperty(k, 'extractable', { value: !!extractable, enumerable: true });
        Object.defineProperty(k, 'usages', { value: usages.slice(), enumerable: true });
        Object.defineProperty(k, '_raw', { value: raw, enumerable: false });
        return k;
    }

    // ============================================================
    // Augment generateKey
    // ============================================================
    var _origGenerateKey = subtle.generateKey.bind(subtle);
    subtle.generateKey = function(algorithm, extractable, usages) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'aes-kw') {
                    var len = (algorithm.length | 0) || 256;
                    var raw = new Uint8Array(len / 8);
                    globalThis.crypto.getRandomValues(raw);
                    resolve(_makeKey(
                        { name: 'AES-KW', length: len },
                        raw, 'secret', extractable, usages));
                    return;
                }
                if (name === 'rsa-oaep' || name === 'rsassa-pkcs1-v1_5'
                    || name === 'rsa-pss') {
                    var bits = (algorithm.modulusLength | 0) || 2048;
                    var pubExp = algorithm.publicExponent
                        ? Number(BigInt('0x' + Array.from(_toBytes(algorithm.publicExponent))
                            .map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('')))
                        : 65537;
                    var pair = _hostOpPair('rsa:keygen', [
                        new TextEncoder().encode(String(bits)),
                        new TextEncoder().encode(String(pubExp)),
                    ]);
                    var hash = _hashCanonical(algorithm.hash);
                    var algoOut = {
                        name: name === 'rsa-oaep' ? 'RSA-OAEP'
                            : name === 'rsa-pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
                        modulusLength: bits,
                        publicExponent: _toBytes(algorithm.publicExponent || new Uint8Array([1, 0, 1])),
                        hash: { name: hash },
                    };
                    var privKey = _makeKey(algoOut, pair[0], 'private', extractable, usages);
                    var pubKey  = _makeKey(algoOut, pair[1], 'public', extractable,
                        // public key gets only verify/encrypt/wrapKey usages
                        usages.filter(function(u) {
                            return u === 'verify' || u === 'encrypt' || u === 'wrapKey';
                        }));
                    resolve({ privateKey: privKey, publicKey: pubKey });
                    return;
                }
                if (name === 'ecdsa' || name === 'ecdh') {
                    var curve = _curveCanonical(algorithm.namedCurve);
                    var ecPair = _hostOpPair('ec:keygen', [new TextEncoder().encode(curve)]);
                    var ecAlgo = {
                        name: name === 'ecdsa' ? 'ECDSA' : 'ECDH',
                        namedCurve: curve,
                    };
                    var priv = _makeKey(ecAlgo, ecPair[0], 'private', extractable, usages);
                    var pub  = _makeKey(ecAlgo, ecPair[1], 'public', extractable,
                        usages.filter(function(u) {
                            return u === 'verify' || u === 'deriveBits' || u === 'deriveKey';
                        }));
                    resolve({ privateKey: priv, publicKey: pub });
                    return;
                }
                if (name === 'ed25519') {
                    var edPair = _hostOpPair('ed25519:keygen', []);
                    var edAlgo = { name: 'Ed25519' };
                    var edPriv = _makeKey(edAlgo, edPair[0], 'private', extractable, usages);
                    var edPub  = _makeKey(edAlgo, edPair[1], 'public', extractable,
                        usages.filter(function(u) { return u === 'verify'; }));
                    resolve({ privateKey: edPriv, publicKey: edPub });
                    return;
                }
                if (name === 'x25519') {
                    var xPair = _hostOpPair('x25519:keygen', []);
                    var xAlgo = { name: 'X25519' };
                    var xPriv = _makeKey(xAlgo, xPair[0], 'private', extractable, usages);
                    var xPub  = _makeKey(xAlgo, xPair[1], 'public', extractable, []);
                    resolve({ privateKey: xPriv, publicKey: xPub });
                    return;
                }
                // Fall through to the base dispatcher.
                _origGenerateKey(algorithm, extractable, usages).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    // ============================================================
    // Augment encrypt / decrypt (AES-CTR + RSA-OAEP)
    // ============================================================
    var _origEncrypt = subtle.encrypt.bind(subtle);
    subtle.encrypt = function(algorithm, key, data) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'aes-ctr') {
                    var counter = _toBytes(algorithm.counter);
                    var ct = _hostOpBytes('aes-ctr:apply',
                        [_toBytes(key._raw), counter, _toBytes(data)]);
                    resolve(ct.buffer);
                    return;
                }
                if (name === 'rsa-oaep') {
                    var hash = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var label = algorithm.label ? _toBytes(algorithm.label) : new Uint8Array(0);
                    var ct2 = _hostOpBytes('rsa-oaep:encrypt', [
                        new TextEncoder().encode(hash),
                        _toBytes(key._raw),
                        label,
                        _toBytes(data),
                    ]);
                    resolve(ct2.buffer);
                    return;
                }
                _origEncrypt(algorithm, key, data).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    var _origDecrypt = subtle.decrypt.bind(subtle);
    subtle.decrypt = function(algorithm, key, data) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'aes-ctr') {
                    var counter = _toBytes(algorithm.counter);
                    var pt = _hostOpBytes('aes-ctr:apply',
                        [_toBytes(key._raw), counter, _toBytes(data)]);
                    resolve(pt.buffer);
                    return;
                }
                if (name === 'rsa-oaep') {
                    var hash = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var label = algorithm.label ? _toBytes(algorithm.label) : new Uint8Array(0);
                    var pt2 = _hostOpBytes('rsa-oaep:decrypt', [
                        new TextEncoder().encode(hash),
                        _toBytes(key._raw),
                        label,
                        _toBytes(data),
                    ]);
                    resolve(pt2.buffer);
                    return;
                }
                _origDecrypt(algorithm, key, data).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    // ============================================================
    // Augment sign / verify
    // ============================================================
    var _origSign = subtle.sign.bind(subtle);
    subtle.sign = function(algorithm, key, data) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'rsassa-pkcs1-v1_5' || name === 'rsa-pkcs1' || name === 'rsa-pkcs1-v1_5') {
                    var hash = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var sig = _hostOpBytes('rsa-pkcs1:sign', [
                        new TextEncoder().encode(hash),
                        _toBytes(key._raw),
                        _toBytes(data),
                    ]);
                    resolve(sig.buffer);
                    return;
                }
                if (name === 'rsa-pss') {
                    var hash2 = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var saltLen = (algorithm.saltLength | 0) || 32;
                    var sig2 = _hostOpBytes('rsa-pss:sign', [
                        new TextEncoder().encode(hash2),
                        new TextEncoder().encode(String(saltLen)),
                        _toBytes(key._raw),
                        _toBytes(data),
                    ]);
                    resolve(sig2.buffer);
                    return;
                }
                if (name === 'ecdsa') {
                    var curve = _curveCanonical(key.algorithm && key.algorithm.namedCurve);
                    var hashEc = _hashCanonical(algorithm.hash) || _hashFromCurve(curve);
                    var sig3 = _hostOpBytes('ecdsa:sign', [
                        new TextEncoder().encode(curve),
                        new TextEncoder().encode(hashEc),
                        _toBytes(key._raw),
                        _toBytes(data),
                    ]);
                    resolve(sig3.buffer);
                    return;
                }
                if (name === 'ed25519') {
                    var sig4 = _hostOpBytes('ed25519:sign', [_toBytes(key._raw), _toBytes(data)]);
                    resolve(sig4.buffer);
                    return;
                }
                _origSign(algorithm, key, data).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    var _origVerify = subtle.verify.bind(subtle);
    subtle.verify = function(algorithm, key, signature, data) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'rsassa-pkcs1-v1_5' || name === 'rsa-pkcs1' || name === 'rsa-pkcs1-v1_5') {
                    var hash = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var ok = _hostOp('rsa-pkcs1:verify', [
                        new TextEncoder().encode(hash),
                        _toBytes(key._raw),
                        _toBytes(data),
                        _toBytes(signature),
                    ]);
                    resolve(ok === '1');
                    return;
                }
                if (name === 'rsa-pss') {
                    var hash2 = _hashCanonical(key.algorithm && key.algorithm.hash);
                    var saltLen = (algorithm.saltLength | 0) || 32;
                    var ok2 = _hostOp('rsa-pss:verify', [
                        new TextEncoder().encode(hash2),
                        new TextEncoder().encode(String(saltLen)),
                        _toBytes(key._raw),
                        _toBytes(data),
                        _toBytes(signature),
                    ]);
                    resolve(ok2 === '1');
                    return;
                }
                if (name === 'ecdsa') {
                    var curve = _curveCanonical(key.algorithm && key.algorithm.namedCurve);
                    var hashEc = _hashCanonical(algorithm.hash) || _hashFromCurve(curve);
                    var ok3 = _hostOp('ecdsa:verify', [
                        new TextEncoder().encode(curve),
                        new TextEncoder().encode(hashEc),
                        _toBytes(key._raw),
                        _toBytes(data),
                        _toBytes(signature),
                    ]);
                    resolve(ok3 === '1');
                    return;
                }
                if (name === 'ed25519') {
                    var ok4 = _hostOp('ed25519:verify',
                        [_toBytes(key._raw), _toBytes(data), _toBytes(signature)]);
                    resolve(ok4 === '1');
                    return;
                }
                _origVerify(algorithm, key, signature, data).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    // ============================================================
    // Augment deriveBits (ECDH + X25519)
    // ============================================================
    var _origDeriveBits = subtle.deriveBits.bind(subtle);
    subtle.deriveBits = function(algorithm, baseKey, length) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if (name === 'ecdh') {
                    var curve = _curveCanonical(baseKey.algorithm && baseKey.algorithm.namedCurve);
                    var pubKey = algorithm['public'] || algorithm.public;
                    if (!pubKey || !pubKey._raw) {
                        return reject(new Error('ECDH: public key required'));
                    }
                    var shared = _hostOpBytes('ecdh:derive', [
                        new TextEncoder().encode(curve),
                        _toBytes(baseKey._raw),
                        _toBytes(pubKey._raw),
                    ]);
                    var n = (length || 0) > 0 ? length / 8 : shared.length;
                    resolve(shared.slice(0, n).buffer);
                    return;
                }
                if (name === 'x25519') {
                    var pubKey2 = algorithm['public'] || algorithm.public;
                    if (!pubKey2 || !pubKey2._raw) {
                        return reject(new Error('X25519: public key required'));
                    }
                    var shared2 = _hostOpBytes('x25519:derive',
                        [_toBytes(baseKey._raw), _toBytes(pubKey2._raw)]);
                    var n2 = (length || 0) > 0 ? length / 8 : shared2.length;
                    resolve(shared2.slice(0, n2).buffer);
                    return;
                }
                _origDeriveBits(algorithm, baseKey, length).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    // ============================================================
    // Augment importKey / exportKey for asymmetric key formats
    // ============================================================
    var _origImportKey = subtle.importKey.bind(subtle);
    subtle.importKey = function(format, keyData, algorithm, extractable, usages) {
        return new Promise(function(resolve, reject) {
            try {
                var name = _algoName(algorithm);
                if ((format === 'pkcs8' || format === 'spki') &&
                    (name === 'rsa-oaep' || name === 'rsa-pss'
                     || name === 'rsassa-pkcs1-v1_5' || name === 'ecdsa' || name === 'ecdh'
                     || name === 'ed25519' || name === 'x25519')) {
                    var raw = _toBytes(keyData);
                    var algo = { name: name.toUpperCase() === 'RSASSA-PKCS1-V1_5' ? 'RSASSA-PKCS1-v1_5'
                                       : (name === 'rsa-oaep' ? 'RSA-OAEP'
                                          : name === 'rsa-pss' ? 'RSA-PSS'
                                          : name.toUpperCase()) };
                    if (algorithm.namedCurve) algo.namedCurve = _curveCanonical(algorithm.namedCurve);
                    if (algorithm.hash) algo.hash = { name: _hashCanonical(algorithm.hash) };
                    resolve(_makeKey(algo, raw,
                        format === 'pkcs8' ? 'private' : 'public',
                        extractable, usages));
                    return;
                }
                if (format === 'raw' && (name === 'ed25519' || name === 'x25519')) {
                    var raw2 = _toBytes(keyData);
                    if (raw2.length !== 32) {
                        return reject(new Error(name + ': raw key must be 32 bytes'));
                    }
                    resolve(_makeKey({ name: name.toUpperCase() }, raw2, 'public', extractable, usages));
                    return;
                }
                _origImportKey(format, keyData, algorithm, extractable, usages).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    var _origExportKey = subtle.exportKey.bind(subtle);
    subtle.exportKey = function(format, key) {
        return new Promise(function(resolve, reject) {
            try {
                if (!key.extractable) {
                    return reject(new Error('SubtleCrypto.exportKey: key not extractable'));
                }
                var algoName = (key.algorithm && key.algorithm.name) || '';
                var lower = String(algoName).toLowerCase();
                // pkcs8 / spki — return raw DER bytes from `_raw`.
                if ((format === 'pkcs8' && key.type === 'private') ||
                    (format === 'spki'  && key.type === 'public')) {
                    if (lower.indexOf('rsa') === 0 || lower === 'ecdsa' || lower === 'ecdh'
                        || lower === 'ed25519' || lower === 'x25519') {
                        resolve(new Uint8Array(_toBytes(key._raw)).buffer);
                        return;
                    }
                }
                // raw — for Ed25519/X25519 keys it's the 32-byte body.
                if (format === 'raw' && (lower === 'ed25519' || lower === 'x25519')) {
                    resolve(new Uint8Array(_toBytes(key._raw)).buffer);
                    return;
                }
                // jwk — RSA via host helper.
                if (format === 'jwk' && lower.indexOf('rsa') === 0) {
                    var verb = key.type === 'private'
                        ? 'rsa:export-jwk-priv'
                        : 'rsa:export-jwk-pub';
                    var jsonBytes = _hostOpBytes(verb, [_toBytes(key._raw)]);
                    var jwk = JSON.parse(new TextDecoder().decode(jsonBytes));
                    jwk.alg = (lower === 'rsa-oaep')
                        ? ('RSA-OAEP-' + (_hashCanonical(key.algorithm.hash).slice(4) || '256'))
                        : (lower === 'rsa-pss')
                            ? ('PS' + (_hashCanonical(key.algorithm.hash).slice(4) || '256'))
                            : ('RS' + (_hashCanonical(key.algorithm.hash).slice(4) || '256'));
                    jwk.ext = true;
                    jwk.key_ops = key.usages.slice();
                    resolve(jwk);
                    return;
                }
                _origExportKey(format, key).then(resolve, reject);
            } catch (e) { reject(e); }
        });
    };

    // ============================================================
    // wrapKey / unwrapKey: AES-KW path
    // ============================================================
    var _origWrap = subtle.wrapKey.bind(subtle);
    subtle.wrapKey = function(format, key, wrappingKey, wrapAlgorithm) {
        var wname = _algoName(wrapAlgorithm);
        if (wname === 'aes-kw') {
            return subtle.exportKey(format, key).then(function(rawBuf) {
                var raw = _toBytes(rawBuf);
                var wrapped = _hostOpBytes('aes-kw:wrap',
                    [_toBytes(wrappingKey._raw), raw]);
                return wrapped.buffer;
            });
        }
        return _origWrap(format, key, wrappingKey, wrapAlgorithm);
    };

    var _origUnwrap = subtle.unwrapKey.bind(subtle);
    subtle.unwrapKey = function(format, wrapped, unwrappingKey, unwrapAlgorithm,
                                 unwrappedKeyAlgorithm, extractable, usages) {
        var wname = _algoName(unwrapAlgorithm);
        if (wname === 'aes-kw') {
            var unwrapped = _hostOpBytes('aes-kw:unwrap',
                [_toBytes(unwrappingKey._raw), _toBytes(wrapped)]);
            return subtle.importKey(format, unwrapped.buffer, unwrappedKeyAlgorithm,
                                    extractable, usages);
        }
        return _origUnwrap(format, wrapped, unwrappingKey, unwrapAlgorithm,
                           unwrappedKeyAlgorithm, extractable, usages);
    };
})();

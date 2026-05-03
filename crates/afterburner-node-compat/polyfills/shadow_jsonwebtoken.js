// L3 shadow for the `jsonwebtoken` npm package.
//
// require('jsonwebtoken') resolves to this polyfill. Backed by the
// Rust `jsonwebtoken` crate for HMAC (HS256/384/512), RSA (RS256/
// 384/512, PS256/384/512), ECDSA (ES256/384), and EdDSA. Secrets are
// passed as strings for HMAC, PEM-formatted keys for the asymmetric
// algorithms.
//
// The npm package documents both sync `jwt.sign(...)` and callback
// `jwt.sign(..., (err, token) => {})` shapes for sign and verify.
// We match both. decode is always sync in upstream — we match that
// too.

__register_module('jsonwebtoken', function(module, exports, require) {

    // Algorithm shortlist matching jsonwebtoken's published surface.
    // Unknown algorithm in a sign/verify call falls back to HS256,
    // matching the upstream default.
    var DEFAULT_ALG = 'HS256';

    function checkHostErr(out, op) {
        if (typeof out === 'string' && out.indexOf('__HOST_ERR__:') === 0) {
            var msg = out.slice('__HOST_ERR__:'.length);
            var err = new Error('jwt.' + op + ': ' + msg);
            // jsonwebtoken exposes several named error classes. We
            // approximate with `.name` set to the closest match.
            if (/expired/i.test(msg)) err.name = 'TokenExpiredError';
            else if (/signature|invalid/i.test(msg)) err.name = 'JsonWebTokenError';
            else err.name = 'JsonWebTokenError';
            err.code = 'ERR_SHADOW_JWT';
            throw err;
        }
        return out;
    }

    function normalizeSecret(secret) {
        // Accept Buffer (from node-compat Buffer polyfill), string,
        // or object with `.key` / `.passphrase`. Passphrase on
        // encrypted keys isn't supported today — documented below.
        if (typeof secret === 'string') return secret;
        if (secret && typeof secret.toString === 'function') return secret.toString();
        return '';
    }

    function normalizeOptions(opts) {
        // jsonwebtoken accepts `expiresIn` as either a number (seconds)
        // or a string like "1h" / "7d". The upstream parses the
        // string via the `ms` npm package; we keep a minimal subset
        // to avoid pulling in a duration parser.
        if (!opts) return {};
        var out = {};
        if (typeof opts.algorithm === 'string') out.algorithm = opts.algorithm;
        if (typeof opts.issuer === 'string') out.issuer = opts.issuer;
        if (typeof opts.subject === 'string') out.subject = opts.subject;
        if (opts.audience != null) out.audience = opts.audience;
        if (typeof opts.jwtid === 'string') out.jwtid = opts.jwtid;
        if (typeof opts.keyid === 'string') out.keyid = opts.keyid;
        if (opts.noTimestamp === true) out.noTimestamp = true;
        if (opts.ignoreExpiration === true) out.ignoreExpiration = true;
        if (opts.ignoreNotBefore === true) out.ignoreNotBefore = true;
        if (opts.expiresIn != null) out.expiresIn = toSeconds(opts.expiresIn);
        if (opts.notBefore != null) out.notBefore = toSeconds(opts.notBefore);
        return out;
    }

    // Minimal "ms-like" parser. Covers `s`, `m`, `h`, `d`.
    // Anything more exotic: pass a plain number of seconds.
    function toSeconds(v) {
        if (typeof v === 'number') return v | 0;
        if (typeof v !== 'string') return 0;
        var m = v.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)?$/i);
        if (!m) return 0;
        var n = parseInt(m[1], 10);
        var unit = (m[2] || 's').toLowerCase();
        if (unit[0] === 'm' && unit[1] !== undefined && unit[1] !== 'i' && unit[1] !== 's') {
            // "m" alone = minutes; guard against "month/ms" oddities.
            return n * 60;
        }
        switch (unit[0]) {
            case 's': return n;
            case 'm': return n * 60;
            case 'h': return n * 3600;
            case 'd': return n * 86400;
            default: return n;
        }
    }

    function signSync(payload, secret, options) {
        if (payload == null || typeof payload !== 'object') {
            throw new TypeError('jwt.sign: payload must be an object');
        }
        var fn = globalThis.__host_shadow_jwt_sign;
        if (typeof fn !== 'function') {
            throw new Error('jsonwebtoken not available: rebuild with `shadow-jsonwebtoken` feature');
        }
        var opts = normalizeOptions(options);
        if (!opts.algorithm) opts.algorithm = DEFAULT_ALG;
        return checkHostErr(
            fn(JSON.stringify(payload), normalizeSecret(secret), JSON.stringify(opts)),
            'sign'
        );
    }

    function verifySync(token, secret, options) {
        if (typeof token !== 'string') {
            throw new TypeError('jwt.verify: token must be a string');
        }
        var fn = globalThis.__host_shadow_jwt_verify;
        if (typeof fn !== 'function') {
            throw new Error('jsonwebtoken not available: rebuild with `shadow-jsonwebtoken` feature');
        }
        var opts = normalizeOptions(options);
        if (!opts.algorithm) opts.algorithm = DEFAULT_ALG;
        var raw = checkHostErr(
            fn(token, normalizeSecret(secret), JSON.stringify(opts)),
            'verify'
        );
        return JSON.parse(raw);
    }

    function decodeSync(token, options) {
        if (typeof token !== 'string') return null;
        var fn = globalThis.__host_shadow_jwt_decode;
        if (typeof fn !== 'function') {
            throw new Error('jsonwebtoken not available: rebuild with `shadow-jsonwebtoken` feature');
        }
        var raw = fn(token);
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            // Upstream `decode` returns null on malformed input
            // rather than throwing.
            return null;
        }
        var parsed = JSON.parse(raw);
        // `{ complete: true }` → return `{ header, payload, signature }`;
        // default returns just the payload.
        if (options && options.complete === true) {
            // Signature isn't surfaced by our host decode; derive
            // from the token string to match upstream shape.
            var sig = token.split('.')[2] || '';
            return { header: parsed.header, payload: parsed.payload, signature: sig };
        }
        return parsed.payload;
    }

    // sign / verify accept an optional trailing callback. When
    // present, result flows through the callback; when absent, we
    // return synchronously (matches upstream when `algorithm` is
    // supplied in options).
    exports.sign = function(payload, secret, optionsOrCb, cb) {
        var options = null;
        if (typeof optionsOrCb === 'function') {
            cb = optionsOrCb;
        } else {
            options = optionsOrCb;
        }
        if (typeof cb === 'function') {
            try {
                var tok = signSync(payload, secret, options);
                queueMicrotask(function() { cb(null, tok); });
            } catch (e) {
                queueMicrotask(function() { cb(e); });
            }
            return;
        }
        return signSync(payload, secret, options);
    };

    exports.verify = function(token, secret, optionsOrCb, cb) {
        var options = null;
        if (typeof optionsOrCb === 'function') {
            cb = optionsOrCb;
        } else {
            options = optionsOrCb;
        }
        if (typeof cb === 'function') {
            try {
                var decoded = verifySync(token, secret, options);
                queueMicrotask(function() { cb(null, decoded); });
            } catch (e) {
                queueMicrotask(function() { cb(e); });
            }
            return;
        }
        return verifySync(token, secret, options);
    };

    exports.decode = decodeSync;

    // Error classes — users may do `if (e instanceof jwt.JsonWebTokenError)`.
    // We approximate: the thrown errors above carry `.name` set to
    // the closest match; these constructors exist mostly so
    // `instanceof` doesn't blow up.
    function makeErrorClass(name) {
        function Cls(msg) {
            var e = new Error(msg);
            e.name = name;
            return e;
        }
        return Cls;
    }
    exports.JsonWebTokenError = makeErrorClass('JsonWebTokenError');
    exports.TokenExpiredError = makeErrorClass('TokenExpiredError');
    exports.NotBeforeError = makeErrorClass('NotBeforeError');
});

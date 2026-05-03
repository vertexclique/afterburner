// L3 shadow for the `argon2` npm package.
//
// require('argon2') resolves to this polyfill regardless of whether
// node_modules/argon2 exists; the upstream package ships a .node
// native addon that cannot load inside the WASM sandbox, so the
// shadow kicks in transparently.
//
// Surface: hash() / verify() / needsRehash() — all async, matching
// the npm package. Type constants (argon2d / argon2i / argon2id)
// and default options match upstream defaults.

__register_module('argon2', function(module, exports, require) {

    // Match upstream's numeric constants (available as
    // `argon2.argon2d` etc. + the default type `argon2id`).
    var TYPES = { argon2d: 0, argon2i: 1, argon2id: 2 };

    // Upstream defaults (time=3, memory=65536 KiB, parallelism=4,
    // type=argon2id). Hash length is intentionally not passed to the
    // host — the crate derives it from the chosen output size.
    var DEFAULTS = {
        type: 2,  // argon2id
        timeCost: 3,
        memoryCost: 65536,
        parallelism: 4,
    };

    function optInt(opt, key, fallback) {
        if (!opt) return fallback;
        var v = opt[key];
        return (typeof v === 'number' && isFinite(v) && v >= 0) ? (v | 0) : fallback;
    }

    function optType(opt) {
        if (!opt) return DEFAULTS.type;
        var t = opt.type;
        if (typeof t === 'number' && t >= 0 && t <= 2) return t | 0;
        return DEFAULTS.type;
    }

    function checkHostErr(out, op) {
        if (typeof out === 'string' && out.indexOf('__HOST_ERR__:') === 0) {
            var msg = out.slice('__HOST_ERR__:'.length);
            var err = new Error('argon2.' + op + ': ' + msg);
            err.code = 'ERR_SHADOW_ARGON2';
            throw err;
        }
        return out;
    }

    function hashSync(password, options) {
        if (typeof password !== 'string') {
            throw new TypeError('argon2.hash: password must be a string');
        }
        var fn = globalThis.__host_shadow_argon2_hash;
        if (typeof fn !== 'function') {
            throw new Error('argon2 not available: rebuild with `shadow-argon2` feature');
        }
        var ty = optType(options);
        var tc = optInt(options, 'timeCost', DEFAULTS.timeCost);
        var mc = optInt(options, 'memoryCost', DEFAULTS.memoryCost);
        var par = optInt(options, 'parallelism', DEFAULTS.parallelism);
        return checkHostErr(fn(password, ty, tc, mc, par), 'hash');
    }

    function verifySync(hash, password) {
        if (typeof hash !== 'string' || typeof password !== 'string') {
            throw new TypeError('argon2.verify: hash + password must be strings');
        }
        var fn = globalThis.__host_shadow_argon2_verify;
        if (typeof fn !== 'function') {
            throw new Error('argon2 not available: rebuild with `shadow-argon2` feature');
        }
        var rc = fn(hash, password);
        if (rc === 1) return true;
        if (rc === 0) return false;
        var detail = (typeof globalThis.__host_last_error === 'function')
            ? globalThis.__host_last_error()
            : ('rc=' + rc);
        var err = new Error('argon2.verify: ' + detail);
        err.code = 'ERR_SHADOW_ARGON2';
        throw err;
    }

    function needsRehashSync(hash, options) {
        if (typeof hash !== 'string') {
            throw new TypeError('argon2.needsRehash: hash must be a string');
        }
        var fn = globalThis.__host_shadow_argon2_needs_rehash;
        if (typeof fn !== 'function') {
            throw new Error('argon2 not available: rebuild with `shadow-argon2` feature');
        }
        var ty = optType(options);
        var tc = optInt(options, 'timeCost', DEFAULTS.timeCost);
        var mc = optInt(options, 'memoryCost', DEFAULTS.memoryCost);
        var par = optInt(options, 'parallelism', DEFAULTS.parallelism);
        var rc = fn(hash, ty, tc, mc, par);
        if (rc === 1) return true;
        if (rc === 0) return false;
        var detail = (typeof globalThis.__host_last_error === 'function')
            ? globalThis.__host_last_error()
            : ('rc=' + rc);
        var err = new Error('argon2.needsRehash: ' + detail);
        err.code = 'ERR_SHADOW_ARGON2';
        throw err;
    }

    // Async-only API per upstream. All three return Promises.
    exports.hash = function(password, options) {
        try { return Promise.resolve(hashSync(password, options)); }
        catch (e) { return Promise.reject(e); }
    };
    exports.verify = function(hash, password) {
        try { return Promise.resolve(verifySync(hash, password)); }
        catch (e) { return Promise.reject(e); }
    };
    exports.needsRehash = function(hash, options) {
        try { return Promise.resolve(needsRehashSync(hash, options)); }
        catch (e) { return Promise.reject(e); }
    };

    // Constants matching upstream.
    exports.argon2d = TYPES.argon2d;
    exports.argon2i = TYPES.argon2i;
    exports.argon2id = TYPES.argon2id;
    exports.defaults = Object.freeze(Object.assign({ hashLength: 32 }, DEFAULTS));
    exports.limits = Object.freeze({
        hashLength: { min: 4, max: 0x7fffffff },
        memoryCost: { min: 8, max: 0x7fffffff },
        timeCost: { min: 2, max: 0x7fffffff },
        parallelism: { min: 1, max: 0x7fffff },
    });
});

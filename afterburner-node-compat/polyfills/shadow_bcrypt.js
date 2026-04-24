// L3 shadow for the `bcrypt` npm package.
//
// require('bcrypt') resolves to THIS polyfill regardless of whether
// node_modules/bcrypt exists on disk, because pre-registered modules
// always win in the require() precedence (B6). Users whose
// node_modules/bcrypt carries a `.node` native addon (which bcrypt
// upstream always does) land here automatically inside the WASM
// sandbox — no code changes needed.
//
// The three host globals this polyfill calls
// (`__host_shadow_bcrypt_*`) are always present in the plugin
// binary. The host-side implementation is feature-gated by
// `shadow-bcrypt` on afterburner-wasi; without the feature the
// imports return a structured error we surface as a clean JS
// exception naming the feature flag.

__register_module('bcrypt', function(module, exports, require) {

    function checkHostErr(out, op) {
        if (typeof out === 'string' && out.indexOf('__HOST_ERR__:') === 0) {
            var msg = out.slice('__HOST_ERR__:'.length);
            var err = new Error('bcrypt.' + op + ': ' + msg);
            err.code = 'ERR_SHADOW_BCRYPT';
            throw err;
        }
        return out;
    }

    function asCost(saltOrRounds) {
        // bcrypt accepts either a number of rounds or a salt string.
        // Pure numbers pass through; salt strings carry the cost
        // embedded in the "$2b$CC$..." prefix, but since we always
        // regenerate via the Rust crate's own cost arg, we parse
        // the cost out of the salt string when one is passed.
        if (typeof saltOrRounds === 'number') return saltOrRounds | 0;
        if (typeof saltOrRounds === 'string') {
            // Match "$2b$12$..." — rounds are positions 4-5.
            var m = saltOrRounds.match(/^\$2[aby]\$(\d\d)\$/);
            if (m) return parseInt(m[1], 10);
        }
        return 0;  // 0 signals "use default" to the host side
    }

    function hashSyncImpl(data, saltOrRounds) {
        if (typeof data !== 'string') {
            throw new TypeError('bcrypt.hash: data must be a string');
        }
        var cost = asCost(saltOrRounds);
        var fn = globalThis.__host_shadow_bcrypt_hash;
        if (typeof fn !== 'function') {
            throw new Error('bcrypt not available: rebuild with `shadow-bcrypt` feature');
        }
        return checkHostErr(fn(data, cost), 'hash');
    }

    function compareSyncImpl(data, hash) {
        if (typeof data !== 'string' || typeof hash !== 'string') {
            throw new TypeError('bcrypt.compare: data + hash must be strings');
        }
        var fn = globalThis.__host_shadow_bcrypt_verify;
        if (typeof fn !== 'function') {
            throw new Error('bcrypt not available: rebuild with `shadow-bcrypt` feature');
        }
        var rc = fn(data, hash);
        if (rc === 1) return true;
        if (rc === 0) return false;
        // Negative return → host populated last_error; fetch via
        // the standard diagnostic bridge the existing polyfills use.
        var detail = (typeof globalThis.__host_last_error === 'function')
            ? globalThis.__host_last_error()
            : ('rc=' + rc);
        var err = new Error('bcrypt.compare: ' + detail);
        err.code = 'ERR_SHADOW_BCRYPT';
        throw err;
    }

    function genSaltSyncImpl(rounds) {
        var fn = globalThis.__host_shadow_bcrypt_gen_salt;
        if (typeof fn !== 'function') {
            throw new Error('bcrypt not available: rebuild with `shadow-bcrypt` feature');
        }
        return checkHostErr(fn(typeof rounds === 'number' ? rounds | 0 : 0), 'genSalt');
    }

    // Async variants wrap sync in a resolved Promise. bcrypt's cost
    // parameter already bounds CPU time per-call, and our runtime
    // doesn't have a background thread pool — wrapping in a Promise
    // matches the npm API surface without pretending there's
    // concurrency underneath. Callbacks also supported for parity
    // with the pre-Promise npm API.
    function wrapAsync(sync) {
        return function(/* ..., cb? */) {
            var args = Array.prototype.slice.call(arguments);
            var cb = typeof args[args.length - 1] === 'function'
                ? args.pop() : null;
            try {
                var v = sync.apply(null, args);
                if (cb) {
                    queueMicrotask(function() { cb(null, v); });
                    return undefined;
                }
                return Promise.resolve(v);
            } catch (e) {
                if (cb) {
                    queueMicrotask(function() { cb(e); });
                    return undefined;
                }
                return Promise.reject(e);
            }
        };
    }

    exports.hashSync = hashSyncImpl;
    exports.compareSync = compareSyncImpl;
    exports.genSaltSync = genSaltSyncImpl;

    exports.hash = wrapAsync(hashSyncImpl);
    exports.compare = wrapAsync(compareSyncImpl);
    exports.genSalt = wrapAsync(genSaltSyncImpl);

    // `getRounds(hash)` — pure-JS inspection, no host call needed.
    exports.getRounds = function(hash) {
        if (typeof hash !== 'string') {
            throw new TypeError('bcrypt.getRounds: hash must be a string');
        }
        var m = hash.match(/^\$2[aby]\$(\d\d)\$/);
        if (!m) {
            throw new Error('bcrypt.getRounds: malformed hash');
        }
        return parseInt(m[1], 10);
    };

    // `truncates(password)` — pure-JS check for bcrypt's 72-byte
    // password truncation boundary. Node's upstream ships this so we
    // do too; users who care about long passwords can gate on it.
    exports.truncates = function(password) {
        if (typeof password !== 'string') return false;
        // Use TextEncoder for accurate byte count (multibyte chars).
        if (typeof TextEncoder === 'function') {
            return new TextEncoder().encode(password).length > 72;
        }
        return password.length > 72;
    };
});

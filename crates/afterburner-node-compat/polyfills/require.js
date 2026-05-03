// The plenum.js require() resolver.
//
// Bare names and `node:*` resolve through the factory map installed
// by `__register_module` — that covers every Node stdlib module the
// plenum bundle ships. B6 extends this with:
//
//   * Filesystem resolution for `./`, `../`, `/` paths
//     (`require('./lib')`, `require('../util')`, `require('/abs')`).
//   * `node_modules` walk for bare names not in the stdlib factory
//     map (`require('express')` starts at the caller's `__dirname`
//     and walks up looking for `node_modules/express`).
//   * `package.json "main"` + `index.js` / `index.json` resolution
//     matching Node's CommonJS semantics.
//   * Per-module `require` closures so `./sibling` inside a loaded
//     file resolves relative to THAT file's dir, not the entry
//     script's — same as Node.
//   * `.json` file support: `require('./config.json')` returns the
//     parsed object, no need to JSON.parse by hand.
//   * `require.cache` keyed by absolute resolved path.
//   * `require.resolve(name)` → the absolute path that `require`
//     would load, without actually loading it.
//
// Filesystem lookups go through `__host_fs_*`; if the active
// Manifold denies fs access, filesystem-backed requires throw a
// clean EACCES the same way `fs.readFileSync` would.

(function plenumRequire() {
    var factories = Object.create(null);
    // Cache is shared across all per-module requires and keyed by the
    // resolved identifier: stdlib names (e.g. "path"), or absolute
    // filesystem paths (e.g. "/home/me/server.js").
    var cache = Object.create(null);

    function stripNodePrefix(name) {
        return typeof name === 'string' && name.indexOf('node:') === 0
            ? name.slice(5)
            : name;
    }

    function loadStdlib(mod) {
        var cached = cache[mod];
        if (cached !== undefined) return cached;
        var factory = factories[mod];
        if (typeof factory !== 'function') return undefined;
        var m = { exports: {} };
        // Install before invoking so cyclic requires see a partial
        // exports object rather than triggering an infinite loop.
        cache[mod] = m.exports;
        factory(m, m.exports, globalThis.require);
        // Factories may replace `module.exports` wholesale
        // (e.g. `module.exports = EventEmitter`). Pick up the final
        // binding before handing it out.
        cache[mod] = m.exports;
        return m.exports;
    }

    // ---- fs + path helpers (internal, do not depend on polyfills) ----------
    //
    // The require resolver can be reached before the `path` module's
    // factory has run on the first user invocation, so we inline the
    // sliver of path logic we need. Only POSIX-style separators —
    // Windows hosts normalize to forward slashes in `__host_cwd`.

    // fs host functions have two failure shapes depending on the
    // backend: the WASI path returns a string prefixed with
    // `__HOST_ERR__:`, and the native (rquickjs) path throws
    // directly. Both collapse here to "module not found" so a
    // sealed-Manifold `require('no-such-module')` surfaces the
    // Node-shaped "Cannot find module" error rather than leaking
    // a permission-denied message that sounds like a misconfigured
    // sandbox.

    function fsExists(p) {
        var fn = globalThis.__host_fs_exists_sync;
        if (typeof fn !== 'function') return false;
        try { return !!fn(String(p)); } catch (_) { return false; }
    }

    function fsRead(p) {
        var fn = globalThis.__host_fs_read_file_sync;
        if (typeof fn !== 'function') return null;
        try {
            // The host bridge always sends bytes as base64 (binary-safe
            // wire format — see `polyfills/fs.js` for the full
            // contract). Decode to a UTF-8 string here; require()
            // never reads non-text files.
            var b64 = fn(String(p), 'base64');
            if (typeof b64 === 'string' && b64.indexOf('__HOST_ERR__:') === 0) return null;
            // We can't `require('buffer')` from inside require.js
            // (circular bootstrap), so decode base64 inline. The
            // implementation matches `Buffer.from(b64, 'base64')` →
            // UTF-8 decode but without crossing the module boundary.
            return base64ToUtf8(b64);
        } catch (_) {
            return null;
        }
    }

    // Tiny inlined base64→UTF-8 decoder. Used only by the require
    // resolver's source loader; cleaner than calling out to
    // `Buffer` (which lives in a module we may be in the middle of
    // bootstrapping). globalThis.atob produces a "binary string"
    // (each char = one byte, ≤255), then we re-decode as UTF-8.
    var B64_INV = (function() {
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var inv = new Int16Array(256);
        for (var i = 0; i < 256; i++) inv[i] = -1;
        for (var j = 0; j < alphabet.length; j++) inv[alphabet.charCodeAt(j)] = j;
        return inv;
    })();

    function base64ToUtf8(s) {
        // Strip padding for length math.
        var clean = s.replace(/=+$/, '');
        var bytesLen = Math.floor(clean.length * 3 / 4);
        var bytes = new Uint8Array(bytesLen);
        var bi = 0;
        for (var i = 0; i + 4 <= clean.length; i += 4) {
            var n = (B64_INV[clean.charCodeAt(i)]   << 18) |
                    (B64_INV[clean.charCodeAt(i+1)] << 12) |
                    (B64_INV[clean.charCodeAt(i+2)] << 6)  |
                    (B64_INV[clean.charCodeAt(i+3)]);
            bytes[bi++] = (n >> 16) & 0xff;
            bytes[bi++] = (n >> 8)  & 0xff;
            bytes[bi++] = n & 0xff;
        }
        var rem = clean.length - i;
        if (rem === 2) {
            var n2 = (B64_INV[clean.charCodeAt(i)]   << 18) |
                     (B64_INV[clean.charCodeAt(i+1)] << 12);
            bytes[bi++] = (n2 >> 16) & 0xff;
        } else if (rem === 3) {
            var n3 = (B64_INV[clean.charCodeAt(i)]   << 18) |
                     (B64_INV[clean.charCodeAt(i+1)] << 12) |
                     (B64_INV[clean.charCodeAt(i+2)] << 6);
            bytes[bi++] = (n3 >> 16) & 0xff;
            bytes[bi++] = (n3 >> 8)  & 0xff;
        }
        if (typeof TextDecoder === 'function') {
            return new TextDecoder('utf-8').decode(bytes.subarray(0, bi));
        }
        // Fallback — correct for ASCII; user source under burn is JS
        // which is overwhelmingly ASCII / latin-1 friendly. Non-ASCII
        // identifiers would require the TextDecoder path above
        // (always present in QuickJS post-Phase E).
        var out = '';
        for (var k = 0; k < bi; k++) out += String.fromCharCode(bytes[k]);
        return out;
    }

    function fsIsDir(p) {
        var fn = globalThis.__host_fs_stat_sync;
        if (typeof fn !== 'function') return false;
        try {
            var raw = fn(String(p));
            if (typeof raw !== 'string' || raw.indexOf('__HOST_ERR__:') === 0) return false;
            return JSON.parse(raw).isDirectory === true;
        } catch (_) {
            return false;
        }
    }

    function dirname(p) {
        if (!p || p === '/') return '/';
        var trimmed = p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p;
        var i = trimmed.lastIndexOf('/');
        if (i < 0) return '.';
        if (i === 0) return '/';
        return trimmed.slice(0, i);
    }

    function normalize(p) {
        var absolute = p.charAt(0) === '/';
        var parts = p.split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            if (seg === '' || seg === '.') continue;
            if (seg === '..') {
                if (out.length > 0 && out[out.length - 1] !== '..') {
                    out.pop();
                } else if (!absolute) {
                    out.push('..');
                }
            } else {
                out.push(seg);
            }
        }
        var joined = out.join('/');
        return absolute ? '/' + joined : (joined || '.');
    }

    function resolveJoin(base, rel) {
        if (rel.charAt(0) === '/') return normalize(rel);
        return normalize(base + '/' + rel);
    }

    function isRelativeOrAbsolute(name) {
        if (typeof name !== 'string' || name.length === 0) return false;
        var c0 = name.charAt(0);
        if (c0 === '/') return true;
        if (c0 !== '.') return false;
        var c1 = name.charAt(1);
        return c1 === '/' || (c1 === '.' && name.charAt(2) === '/') || name.length === 1 || name === '..';
    }

    // Given a candidate absolute path, try the Node CJS resolution
    // ladder. Extensions tried (in order): exact, .js, .json, .mjs,
    // .cjs, .ts, .mts, .cts. TS/ESM extensions are opt-in — the
    // loader asks the host to transpile them before running. If the
    // host has no transpile hook (built without `ts`), loading a
    // .ts/.mjs surfaces a clean error instead of a JS parse failure.
    var EXTENSION_LADDER = ['.js', '.json', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

    function resolveCandidate(candidate) {
        if (fsExists(candidate) && !fsIsDir(candidate)) return candidate;
        for (var i = 0; i < EXTENSION_LADDER.length; i++) {
            var p = candidate + EXTENSION_LADDER[i];
            if (fsExists(p)) return p;
        }
        if (fsIsDir(candidate)) {
            var pkg = candidate + '/package.json';
            if (fsExists(pkg)) {
                var data = fsRead(pkg);
                if (typeof data === 'string') {
                    try {
                        var parsed = JSON.parse(data);
                        var main = parsed && typeof parsed.main === 'string' ? parsed.main : null;
                        if (main) {
                            var mainAbs = resolveJoin(candidate, main);
                            var resolved = resolveCandidate(mainAbs);
                            if (resolved) return resolved;
                        }
                    } catch (_) { /* malformed package.json falls through to index */ }
                }
            }
            // Directory fallback — match the extension order above.
            for (var j = 0; j < EXTENSION_LADDER.length; j++) {
                var idx = candidate + '/index' + EXTENSION_LADDER[j];
                if (fsExists(idx)) return idx;
            }
        }
        return null;
    }

    // Transpile if the extension needs it (TS or ESM .mjs). `.cjs`
    // is plain CommonJS, no transpile. Returns the transformed
    // source or throws a "transpile needed but unavailable" error
    // if the host hook isn't wired.
    function maybeTranspile(source, absPath) {
        var lower = absPath.toLowerCase();
        var needs = lower.slice(-3) === '.ts'
                 || lower.slice(-4) === '.mts'
                 || lower.slice(-4) === '.cts'
                 || lower.slice(-4) === '.mjs';
        if (!needs) return source;
        var fn = globalThis.__host_ts_transpile;
        if (typeof fn !== 'function') {
            var e = new Error("Loading '" + absPath + "' requires the `ts` cargo feature");
            e.code = 'ERR_UNSUPPORTED_EXTENSION';
            throw e;
        }
        var out = fn(source, absPath);
        if (typeof out === 'string' && out.indexOf('__HOST_ERR__:') === 0) {
            var err = new Error("Transpile failed for '" + absPath + "': " + out.slice('__HOST_ERR__:'.length));
            err.code = 'ERR_TRANSPILE_FAILED';
            throw err;
        }
        return out;
    }

    // Walk up `fromDir` looking for `node_modules/<name>`. Returns the
    // absolute resolved file path, or null if nothing matches up to
    // the filesystem root.
    function resolvePackage(name, fromDir) {
        var dir = fromDir;
        // Guard against pathological inputs (empty dir, etc.).
        if (typeof dir !== 'string' || dir.length === 0) dir = '/';
        // Safety bound: 64 parent walks is far more than any real tree.
        for (var i = 0; i < 64; i++) {
            var cand = dir + '/node_modules/' + name;
            var r = resolveCandidate(cand);
            if (r) return r;
            var parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    function loadAbsoluteFile(absPath, scopedRequire) {
        if (cache[absPath] !== undefined) return cache[absPath];
        var source = fsRead(absPath);
        if (source === null) {
            var ePerm = new Error("Cannot find module '" + absPath + "'");
            ePerm.code = 'MODULE_NOT_FOUND';
            throw ePerm;
        }
        if (absPath.slice(-5) === '.json') {
            var parsed = JSON.parse(source);
            cache[absPath] = parsed;
            return parsed;
        }
        // B8/B9: .ts/.mts/.cts/.mjs files go through the host's
        // oxc-based transpiler before landing in the CJS wrapper.
        // Plain .js / .cjs pass through untouched.
        source = maybeTranspile(source, absPath);
        // Node CJS wrapper — `module.exports` / `exports` are the
        // user-visible outputs; `require` is the scoped copy; the two
        // `__filename` / `__dirname` bindings match Node.
        var modObj = { exports: {}, filename: absPath, loaded: false };
        // Install before invoking so cyclic requires see a partial
        // exports object rather than triggering an infinite loop.
        cache[absPath] = modObj.exports;
        var dir = dirname(absPath);
        try {
            var fn = new Function(
                'module', 'exports', 'require', '__filename', '__dirname',
                source
            );
            fn(modObj, modObj.exports, scopedRequire, absPath, dir);
        } catch (e) {
            // Broken module — evict so a retry can re-run the factory
            // cleanly.
            delete cache[absPath];
            throw e;
        }
        modObj.loaded = true;
        cache[absPath] = modObj.exports;
        return modObj.exports;
    }

    // Construct a `require` closure scoped to `fromDir`. This is what
    // user modules see as their local `require` — `./sibling` resolves
    // relative to `fromDir`, bare names resolve via stdlib then
    // `fromDir`-rooted `node_modules` walk.
    function makeRequire(fromDir) {
        function resolveOnly(name) {
            if (typeof name !== 'string') {
                throw new TypeError('require.resolve(name) expects a string');
            }
            var stripped = stripNodePrefix(name);
            // Pre-registered modules return their registration name
            // as the "resolved identifier" — no path materializes.
            if (factories[stripped] || cache[stripped] !== undefined) {
                return stripped;
            }
            if (isRelativeOrAbsolute(name)) {
                var base = name.charAt(0) === '/' ? name : resolveJoin(fromDir, name);
                var r = resolveCandidate(base);
                if (!r) {
                    var e = new Error("Cannot find module '" + name + "'");
                    e.code = 'MODULE_NOT_FOUND';
                    throw e;
                }
                return r;
            }
            var pkg = resolvePackage(name, fromDir);
            if (pkg) return pkg;
            var notFound = new Error("Cannot find module '" + name + "'");
            notFound.code = 'MODULE_NOT_FOUND';
            throw notFound;
        }

        function req(name) {
            if (typeof name !== 'string') {
                throw new TypeError('require(name) expects a string');
            }
            // Pre-registered modules always win, regardless of name
            // shape. This matters for programmatic registration (e.g.
            // FlowEngine::load_bundle) that uses literal names like
            // './util' to key helper modules into the factory map —
            // those should short-circuit the filesystem lookup.
            var preregistered = loadStdlib(stripNodePrefix(name));
            if (preregistered !== undefined) return preregistered;

            if (isRelativeOrAbsolute(name)) {
                var base = name.charAt(0) === '/' ? name : resolveJoin(fromDir, name);
                var r = resolveCandidate(base);
                if (!r) {
                    var e = new Error("Cannot find module '" + name + "'");
                    e.code = 'MODULE_NOT_FOUND';
                    throw e;
                }
                return loadAbsoluteFile(r, makeRequire(dirname(r)));
            }
            // Bare name — fall through to `node_modules` walk.
            var pkg = resolvePackage(name, fromDir);
            if (pkg) return loadAbsoluteFile(pkg, makeRequire(dirname(pkg)));
            var notFound = new Error("Cannot find module '" + name + "'");
            notFound.code = 'MODULE_NOT_FOUND';
            throw notFound;
        }

        req.cache = cache;
        req.resolve = resolveOnly;
        return req;
    }

    function entryDir() {
        // For file-mode invocations (`burn run foo.js`), argv[1] is
        // the canonicalized absolute script path — its dirname is the
        // entry module's `__dirname`, matching Node's semantics where
        // `require('./sibling')` in the entry script resolves next to
        // the entry file, NOT next to the shell's cwd.
        var argv = globalThis.__ab_argv;
        if (argv && typeof argv[1] === 'string') {
            var label = argv[1];
            if (label.length > 0 && label.charAt(0) === '/'
                && label !== '[eval]' && label !== '[test]') {
                return dirname(label);
            }
        }
        // Eval mode (`-e CODE`, argv[1] = '[eval]') has no file of
        // its own, so we fall back to the shell's cwd — matches what
        // the user would expect when they type `burn -e 'require("./x")'`
        // in a project dir.
        var cwd = globalThis.__host_cwd;
        if (typeof cwd === 'string' && cwd.length > 0) return cwd;
        return '/';
    }

    // The entry-point require. Re-computed on each access so per-
    // invocation `__host_cwd` / `__ab_argv` updates are picked up
    // without a global reset.
    function installEntryRequire() {
        var req = makeRequire(entryDir());
        // Expose the factory-map registration helpers on the entry
        // require for debugging / tests.
        req.__plenum_modules_installed = function() {
            return Object.keys(factories).concat(Object.keys(cache));
        };
        globalThis.require = req;
    }

    installEntryRequire();

    globalThis.__register_module = function(name, factory) {
        factories[stripNodePrefix(name)] = factory;
    };

    globalThis.__register_host_module = function(name, obj) {
        cache[stripNodePrefix(name)] = obj;
    };

    globalThis.__plenum_modules_installed = function() {
        return Object.keys(factories).concat(Object.keys(cache));
    };

    // Per-invocation hook: when the host updates `__host_cwd` via the
    // script envelope, the entry-point `require` should rebase its
    // starting dir. Called from the plugin's script/daemon-init
    // wrappers immediately after they set `__host_cwd`.
    globalThis.__plenum_refresh_entry_require = installEntryRequire;
})();

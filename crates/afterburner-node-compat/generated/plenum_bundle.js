// GENERATED — do not edit. Source: afterburner-node-compat/polyfills/
// Rebuild with: AFTERBURNER_REBUILD_PLENUM=1 cargo build -p afterburner-node-compat

// ---- require.js ----
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

    // Transpile if the extension or contents need it. TS / `.mts` /
    // `.mjs` always go through the host transpile hook. Plain `.js`
    // files are scanned for ESM syntax — if found, they are routed
    // through the same hook so `import` / `export` lower to
    // CommonJS. ESM-only npm packages (chalk, ora, etc., which set
    // `"type": "module"` and ship .js files) reach us via this
    // path; without it `require('chalk')` would parse-fail at
    // `import` keywords. The fast string-scan keeps plain CJS
    // modules off the oxc parse path.
    function maybeTranspile(source, absPath) {
        var lower = absPath.toLowerCase();
        var explicit = lower.slice(-3) === '.ts'
                    || lower.slice(-4) === '.mts'
                    || lower.slice(-4) === '.cts'
                    || lower.slice(-4) === '.mjs';
        var needs = explicit;
        if (!needs && (lower.slice(-3) === '.js' || lower.slice(-4) === '.cjs')) {
            // Cheap pre-check: top-of-line `import …` / `export …` /
            // `import.meta` are the markers that warrant a real
            // lowering pass. Mid-line `import` (in strings, comments,
            // member access) is fine — oxc would no-op those — but we
            // skip the parse to keep CJS imports cheap.
            needs = /(^|\n)\s*(import\s|import\(|export\s|export\{)/.test(source)
                 || source.indexOf('import.meta') >= 0;
        }
        if (!needs) return source;
        var fn = globalThis.__host_ts_transpile;
        if (typeof fn !== 'function') {
            // Only TS files hard-require the hook. `.js` callers fall
            // back to the unmodified source and let the CJS parser
            // surface its own error if it actually contained ESM —
            // matches the no-`ts`-feature flow on the CLI side.
            if (!explicit) return source;
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

    // Subpath imports (`#name`) — Node's mechanism for a package to
    // reference its own internal modules without exposing them to
    // consumers. We walk up from `fromDir` for the nearest
    // `package.json`, look up its `imports` field, and resolve the
    // matched entry relative to that package's root. Conditional
    // exports collapse to `node` → `default` (we don't support
    // `import` vs `require` discrimination since we have a single
    // require-shaped resolver). Returns the absolute path or null.
    function resolveSubpathImport(name, fromDir) {
        var dir = fromDir;
        if (typeof dir !== 'string' || dir.length === 0) dir = '/';
        for (var i = 0; i < 64; i++) {
            var pkgPath = dir + '/package.json';
            if (fsExists(pkgPath)) {
                var raw = fsRead(pkgPath);
                if (typeof raw === 'string') {
                    var pkg;
                    try { pkg = JSON.parse(raw); } catch (_) { pkg = null; }
                    if (pkg && pkg.imports && typeof pkg.imports === 'object') {
                        var entry = pkg.imports[name];
                        if (entry === undefined) {
                            // Pattern subpath imports like
                            // `#feature/*` would land here in Node.
                            // We don't support patterns yet — fall
                            // through to upper package.json.
                        } else {
                            var relative = pickConditional(entry);
                            if (typeof relative === 'string') {
                                var abs = resolveJoin(dir, relative);
                                var r = resolveCandidate(abs);
                                if (r) return r;
                            }
                        }
                    }
                }
            }
            var parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    // Conditional-exports resolver: pick `node` then `default` then
    // the first string entry. Strings are returned as-is.
    function pickConditional(entry) {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
            if (typeof entry.node === 'string') return entry.node;
            if (typeof entry.default === 'string') return entry.default;
            // Object form with `import`/`require` — prefer require shape
            // since we resolve through a CJS lens.
            if (typeof entry.require === 'string') return entry.require;
            if (typeof entry.import === 'string') return entry.import;
            // Recurse into nested condition objects (e.g. `node: {default}`).
            for (var k in entry) {
                if (typeof entry[k] === 'object') {
                    var nested = pickConditional(entry[k]);
                    if (nested) return nested;
                }
            }
        }
        return null;
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

    // Cache stores `module` records, not bare `module.exports`. This
    // mirrors Node's `require.cache` shape (`{ [path]: Module }` —
    // `Module.exports` resolved at read-time) and is the ONLY way
    // circular requires work correctly: when `a.js` partially loads
    // and requires `b.js`, which requires `a.js` back, `b.js` must
    // see the LATEST `a.js` exports object — including any
    // `module.exports = NewClass` reassignment that happened between
    // the cache install and the cycle re-entry. Caching the bare
    // `module.exports` snapshot misses every such reassignment and
    // hands cycles a stale empty object, which surfaces in user code
    // as `parent class must be constructor` or
    // `Cannot read property 'X' of undefined`.
    function getCached(path) {
        var rec = cache[path];
        if (rec === undefined) return undefined;
        // JSON modules are cached as the parsed value directly; only
        // module records have an `exports` property + `loaded` flag.
        if (rec && typeof rec === 'object' && Object.prototype.hasOwnProperty.call(rec, 'exports')
            && Object.prototype.hasOwnProperty.call(rec, 'filename')) {
            return rec.exports;
        }
        return rec;
    }

    function loadAbsoluteFile(absPath, scopedRequire) {
        var cached = getCached(absPath);
        if (cached !== undefined) return cached;
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
        // Node strips a leading hashbang before handing source to V8;
        // QuickJS rejects `#!`. Replace with `//` so line numbers
        // stay aligned with the on-disk file. Also drops a UTF-8 BOM
        // if one is present (which would otherwise reach the Function
        // constructor and parse-fail the same way).
        if (source.charCodeAt(0) === 0xFEFF) {
            source = source.slice(1);
        }
        if (source.charCodeAt(0) === 0x23 /* # */ &&
            source.charCodeAt(1) === 0x21 /* ! */) {
            source = '//' + source.slice(2);
        }
        // Dynamic `import(spec)` has no module loader registered in
        // QuickJS, so the bare expression throws "could not load
        // module 'X'" the moment it runs. Rewrite to a require-based
        // shim BEFORE the source reaches the Function constructor.
        // This keeps the npm / corepack / yarn dispatch chain
        // (which uses `await import('chalk')`) functional under our
        // CJS-shaped require resolver. The shim resolves to a
        // namespace-shaped object (matches Node's CJS-from-ESM
        // interop). The pattern is conservative — only `import(`
        // followed by a non-`.` (excludes `import.meta` /
        // `imports.foo`) and not preceded by an identifier char
        // (excludes `aimport(`). Strings/comments containing
        // `import(` are a known false-positive but vanishingly rare
        // in distributed npm packages.
        if (source.indexOf('import(') >= 0 || source.indexOf('import (') >= 0) {
            // Capture the closure-scoped `require` as the FIRST arg so
            // the import resolves relative to *this* file's dir, not
            // the entry script's. Async dynamic imports inside class
            // methods would otherwise lose the active-require frame
            // by the time they fire.
            source = source.replace(
                /([^A-Za-z0-9_$]|^)import(\s*)\(/g,
                '$1globalThis.__ab_dyn_import$2(require,'
            );
        }
        // Node CJS wrapper — `module.exports` / `exports` are the
        // user-visible outputs; `require` is the scoped copy; the two
        // `__filename` / `__dirname` bindings match Node.
        var modObj = { exports: {}, filename: absPath, loaded: false };
        // Install the MODULE record (not the exports snapshot) before
        // invoking the user body. Cycles look up `cache[absPath]` and
        // pull `.exports` at access time — so any
        // `module.exports = NewClass` reassignment inside the user
        // body is visible to a re-entrant require immediately.
        cache[absPath] = modObj;
        var dir = dirname(absPath);
        try {
            var fn = new Function(
                'module', 'exports', 'require', '__filename', '__dirname',
                source
            );
            // Stash the current scoped require before running the
            // user body so dynamic `import(...)` (rewritten to
            // `__ab_dyn_import(spec)`) walks `node_modules` from the
            // importing file's dir. JS is single-threaded so the
            // simple save/restore is race-free; nested requires nest
            // their saves naturally.
            var prevActive = globalThis.__ab_active_require;
            globalThis.__ab_active_require = scopedRequire;
            try {
                fn(modObj, modObj.exports, scopedRequire, absPath, dir);
            } finally {
                globalThis.__ab_active_require = prevActive;
            }
        } catch (e) {
            // Broken module — evict so a retry can re-run the factory
            // cleanly.
            delete cache[absPath];
            throw e;
        }
        modObj.loaded = true;
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

            // Subpath imports (`#name`) — Node looks up the closest
            // package.json's `imports` field and resolves the matched
            // entry relative to that package root. ESM-only npm
            // packages (chalk, ora) ship internal deps like
            // `#ansi-styles` via this mechanism.
            if (name.charAt(0) === '#') {
                var resolvedSubpath = resolveSubpathImport(name, fromDir);
                if (resolvedSubpath) {
                    return loadAbsoluteFile(resolvedSubpath, makeRequire(dirname(resolvedSubpath)));
                }
                var eImp = new Error("Cannot find module '" + name + "'");
                eImp.code = 'ERR_PACKAGE_IMPORT_NOT_DEFINED';
                throw eImp;
            }

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
        // Node's `require.main` — descriptor for the script that
        // launched the process. For `burn run foo.js` it points at
        // foo.js; for `-e` and stdin modes it points at the
        // synthetic [eval] entry. The fields match Node's
        // Module-instance shape (id, filename, exports, paths,
        // children) closely enough for the canonical idiom
        // `require.main === module` to work in burn.
        var argv = globalThis.__ab_argv;
        var entry = (argv && typeof argv[1] === 'string') ? argv[1] : '[eval]';
        req.main = {
            id: entry,
            filename: entry,
            exports: {},
            loaded: false,
            paths: [entryDir()],
            children: [],
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

    // Dynamic-import shim. QuickJS has no registered module loader,
    // so bare `import('foo')` throws "could not load module" the
    // moment it runs — that breaks every npm-side dispatcher (npm
    // imports `chalk` / `supports-color`; corepack imports the proxy
    // agent; pnpm imports its own engine). At source-rewrite time
    // we replace `import(` with `globalThis.__ab_dyn_import(`; this
    // function returns a Promise resolving to the module's
    // namespace-shaped object, matching Node's CJS-from-ESM interop:
    // CJS modules whose `module.exports` is an object are returned
    // as-is; anything else is wrapped under `default`.
    globalThis.__ab_dyn_import = function(reqOrSpec, maybeSpec) {
        // Two-arg shape: rewriter passes `(require, spec)` so the
        // import resolves relative to the importing file's dir.
        // One-arg shape: entry-script eval / CLI code that's outside
        // a CJS wrapper — fall back to the entry require.
        var r;
        var spec;
        if (typeof maybeSpec !== 'undefined' && typeof reqOrSpec === 'function') {
            r = reqOrSpec;
            spec = maybeSpec;
        } else {
            r = globalThis.require;
            spec = reqOrSpec;
        }
        try {
            var mod = r(spec);
            // Already namespace-shaped (ESM-lowered files include
            // `__esModule: true` + named keys, plus `default`).
            if (mod && typeof mod === 'object' && mod.__esModule) {
                return Promise.resolve(mod);
            }
            // CJS fallback: synthesise a namespace with `default` set
            // to the require result. Spread the object's enumerable
            // keys so `import('cjs').namedExport` still works when
            // the CJS module exports a plain object.
            var ns = { default: mod };
            if (mod && typeof mod === 'object') {
                for (var k in mod) {
                    if (k === 'default') continue;
                    ns[k] = mod[k];
                }
            }
            return Promise.resolve(ns);
        } catch (e) {
            return Promise.reject(e);
        }
    };
})();

// ---- abort.js ----
// AbortController + AbortSignal — standard Web API, not built into
// QuickJS. Supports the listener-based cancellation protocol used by
// `fetch`, timers, and most async libraries.

(function installAbort() {
    if (typeof globalThis.AbortController === 'function') return;

    function AbortSignal() {
        this.aborted = false;
        this.reason = undefined;
        this._listeners = [];
    }
    AbortSignal.prototype.addEventListener = function(event, fn) {
        if (event !== 'abort' || typeof fn !== 'function') return;
        this._listeners.push(fn);
    };
    AbortSignal.prototype.removeEventListener = function(event, fn) {
        if (event !== 'abort') return;
        var i = this._listeners.indexOf(fn);
        if (i >= 0) this._listeners.splice(i, 1);
    };
    AbortSignal.prototype.throwIfAborted = function() {
        if (this.aborted) throw this.reason;
    };
    Object.defineProperty(AbortSignal.prototype, 'onabort', {
        get: function() { return this._onabort || null; },
        set: function(fn) {
            if (this._onabort) this.removeEventListener('abort', this._onabort);
            this._onabort = fn;
            if (typeof fn === 'function') this.addEventListener('abort', fn);
        }
    });
    AbortSignal.abort = function(reason) {
        var s = new AbortSignal();
        s.aborted = true;
        s.reason = reason !== undefined ? reason : new Error('Aborted');
        return s;
    };
    AbortSignal.timeout = function(ms) {
        ms = (ms | 0);
        // Daemon mode (host timers available) — schedule a real fire-
        // later abort so callers get the canonical pattern:
        //   fetch(url, { signal: AbortSignal.timeout(5000) })
        // works as expected. setTimeout itself routes through the same
        // host import, so this stays consistent with the rest of the
        // event-loop polyfill.
        if (typeof globalThis.setTimeout === 'function'
            && typeof globalThis.__host_timer_set === 'function') {
            var s = new AbortSignal();
            globalThis.setTimeout(function() {
                if (s.aborted) return;
                s.aborted = true;
                s.reason = new Error('signal timed out (' + ms + 'ms)');
                var listeners = s._listeners.slice();
                for (var i = 0; i < listeners.length; i++) {
                    try { listeners[i]({ type: 'abort' }); } catch (_) {}
                }
            }, ms);
            return s;
        }
        // Library mode (no host timers): a timeout-based abort would
        // never fire. Produce a signal that's already aborted so
        // scripts fail loudly rather than silently hang.
        return AbortSignal.abort(new Error('AbortSignal.timeout: no event loop'));
    };

    function AbortController() {
        this.signal = new AbortSignal();
    }
    AbortController.prototype.abort = function(reason) {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.reason = reason !== undefined ? reason : new Error('Aborted');
        var listeners = this.signal._listeners.slice();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i]({ type: 'abort' }); } catch (_) {}
        }
    };

    globalThis.AbortController = AbortController;
    globalThis.AbortSignal = AbortSignal;
})();

// ---- assert.js ----
// assert — subset. Deep-equality is structural; follows the Node.js
// "strict" semantics (=== for primitives, shape-recursive for objects).

__register_module('assert', function(module, exports, require) {

    function AssertionError(opts) {
        var message = opts && opts.message;
        if (!message) {
            var act = safeStringify(opts && opts.actual);
            var exp = safeStringify(opts && opts.expected);
            var op  = (opts && opts.operator) || 'fail';
            message = act + ' ' + op + ' ' + exp;
        }
        var err = new Error(message);
        err.name = 'AssertionError';
        err.actual = opts && opts.actual;
        err.expected = opts && opts.expected;
        err.operator = opts && opts.operator;
        err.generatedMessage = !(opts && opts.message);
        err.code = 'ERR_ASSERTION';
        return err;
    }

    function safeStringify(v) {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function deepEqual(a, b, strict) {
        if (strict ? a === b : a == b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
            return false;
        }
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        var ka = Object.keys(a);
        var kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            var k = ka[i];
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k], strict)) return false;
        }
        return true;
    }

    function assertFn(value, message) {
        if (!value) throw AssertionError({ actual: value, expected: true, operator: '==', message: message });
    }

    assertFn.ok = assertFn;
    assertFn.fail = function(message) {
        throw AssertionError({ message: message || 'Failed' });
    };
    assertFn.equal = function(a, e, m) {
        if (a != e) throw AssertionError({ actual: a, expected: e, operator: '==', message: m });
    };
    assertFn.notEqual = function(a, e, m) {
        if (a == e) throw AssertionError({ actual: a, expected: e, operator: '!=', message: m });
    };
    assertFn.strictEqual = function(a, e, m) {
        if (a !== e) throw AssertionError({ actual: a, expected: e, operator: '===', message: m });
    };
    assertFn.notStrictEqual = function(a, e, m) {
        if (a === e) throw AssertionError({ actual: a, expected: e, operator: '!==', message: m });
    };
    assertFn.deepEqual = function(a, e, m) {
        if (!deepEqual(a, e, false)) throw AssertionError({ actual: a, expected: e, operator: 'deepEqual', message: m });
    };
    assertFn.deepStrictEqual = function(a, e, m) {
        if (!deepEqual(a, e, true)) throw AssertionError({ actual: a, expected: e, operator: 'deepStrictEqual', message: m });
    };
    assertFn.throws = function(fn, expected, message) {
        var threw = false;
        var err;
        try { fn(); } catch (e) { threw = true; err = e; }
        if (!threw) throw AssertionError({ message: message || 'Expected function to throw' });
        if (expected instanceof RegExp && !expected.test(String(err))) {
            throw AssertionError({ actual: err, expected: expected, operator: 'throws', message: message });
        }
    };
    assertFn.doesNotThrow = function(fn, message) {
        try { fn(); } catch (e) {
            throw AssertionError({ actual: e, operator: 'doesNotThrow', message: message || 'Unexpected throw' });
        }
    };
    assertFn.AssertionError = AssertionError;
    assertFn.strict = assertFn;

    module.exports = assertFn;
});

// ---- async_hooks.js ----
// async_hooks — Node 20's async-tracking + AsyncLocalStorage API.
//
// Burn's sandbox has no async stack to trace, but `AsyncLocalStorage`
// is the API the vast majority of users actually reach for (request
// context propagation, fastify / pino / pg style). We back it with
// a synchronous storage stack — `getStore()` returns the value at
// the top of that stack, `run(value, callback)` pushes/pops around
// the callback. Without an event loop, "running async" collapses to
// "running synchronously," which preserves the contract.

__register_module('async_hooks', function(module, exports, require) {

    // ---- AsyncLocalStorage ----------------------------------------

    function AsyncLocalStorage() {
        // Stack of stores currently in scope. The top of the stack
        // is what `getStore()` reports.
        this._stack = [];
    }
    AsyncLocalStorage.prototype.run = function(store, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.run: callback must be a function');
        }
        this._stack.push(store);
        try {
            var args = Array.prototype.slice.call(arguments, 2);
            return callback.apply(null, args);
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.exit = function(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('AsyncLocalStorage.exit: callback must be a function');
        }
        // Spec: temporarily disable the store for the duration of
        // the callback. We push `undefined` and restore.
        this._stack.push(undefined);
        try {
            return callback.apply(null, Array.prototype.slice.call(arguments, 1));
        } finally {
            this._stack.pop();
        }
    };
    AsyncLocalStorage.prototype.getStore = function() {
        return this._stack.length === 0
            ? undefined
            : this._stack[this._stack.length - 1];
    };
    AsyncLocalStorage.prototype.enterWith = function(store) {
        // Spec: replace the current store. With no async stack
        // tracking we just rewrite the top entry.
        if (this._stack.length === 0) this._stack.push(store);
        else this._stack[this._stack.length - 1] = store;
    };
    AsyncLocalStorage.prototype.disable = function() {
        this._stack = [];
    };
    AsyncLocalStorage.bind = function(fn) {
        // Captures the current store snapshot at bind time. Sandbox
        // is sync — store snapshot equals "the current state", so
        // bind is identity.
        return fn;
    };
    AsyncLocalStorage.snapshot = function() {
        // Returns a thunk that runs `cb` under the current snapshot.
        // Sync sandbox → just runs `cb`.
        return function(cb) {
            return cb.apply(null, Array.prototype.slice.call(arguments, 1));
        };
    };

    // ---- AsyncResource --------------------------------------------
    //
    // Used by Node's worker pools, db drivers, etc. to track async
    // boundaries. Sandbox has none, so the resource is essentially
    // a no-op wrapper that exposes a `runInAsyncScope` for compat.

    function AsyncResource(type, options) {
        this._type = type;
        this._triggerAsyncId = (options && options.triggerAsyncId) | 0;
        this._asyncId = nextAsyncId();
    }
    AsyncResource.prototype.runInAsyncScope = function(fn, thisArg /*, ...args */) {
        var args = Array.prototype.slice.call(arguments, 2);
        return fn.apply(thisArg, args);
    };
    AsyncResource.prototype.bind = function(fn) {
        return fn;
    };
    AsyncResource.prototype.asyncId = function() { return this._asyncId; };
    AsyncResource.prototype.triggerAsyncId = function() { return this._triggerAsyncId; };
    AsyncResource.prototype.emitDestroy = function() { return this; };
    AsyncResource.bind = function(fn) { return fn; };

    var _asyncIdCounter = 1;
    function nextAsyncId() { return ++_asyncIdCounter; }

    // ---- async hook lifecycle (no-op) -----------------------------
    //
    // We accept hook callbacks but never fire them — there's no async
    // stack to observe. Code that calls `.enable()` / `.disable()`
    // for context propagation often pairs it with AsyncLocalStorage
    // anyway; this surface keeps pino/winston-style logging from
    // crashing.

    function createHook(callbacks) {
        var enabled = false;
        return {
            enable: function() { enabled = true; return this; },
            disable: function() { enabled = false; return this; },
        };
        // `callbacks` (init/before/after/destroy/promiseResolve)
        // are accepted but never invoked.
    }

    function executionAsyncId() { return _asyncIdCounter; }
    function triggerAsyncId() { return _asyncIdCounter; }
    function executionAsyncResource() { return Object.create(null); }

    // ---- exports --------------------------------------------------

    exports.AsyncLocalStorage = AsyncLocalStorage;
    exports.AsyncResource = AsyncResource;
    exports.createHook = createHook;
    exports.executionAsyncId = executionAsyncId;
    exports.triggerAsyncId = triggerAsyncId;
    exports.executionAsyncResource = executionAsyncResource;
    exports.asyncWrapProviders = {
        NONE: 0,
        DIRHANDLE: 1,
        FILEHANDLE: 2,
        TCPWRAP: 3,
        TIMERWRAP: 4,
    };
});

// ---- buffer.js ----
// buffer — a `Buffer` class backed by `Uint8Array`, covering the
// slice of the API that scripts normally touch. UCS-2 / UTF-16 are
// intentionally omitted — callers who need them can fall back to
// TextDecoder directly.

__register_module('buffer', function(module, exports, require) {

    // ---- encoding helpers -------------------------------------------------

    var HEX = '0123456789abcdef';

    function utf8Encode(str) {
        // QuickJS exposes TextEncoder globally; prefer it when available.
        if (typeof TextEncoder === 'function') {
            return new TextEncoder().encode(str);
        }
        // Fallback — correct for BMP, good enough for ASCII-heavy payloads.
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80)       out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            else                out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        return new Uint8Array(out);
    }

    function utf8Decode(bytes) {
        if (typeof TextDecoder === 'function') {
            return new TextDecoder('utf-8').decode(bytes);
        }
        var out = '';
        for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function hexEncode(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i];
            out += HEX[(b >> 4) & 0x0F] + HEX[b & 0x0F];
        }
        return out;
    }

    function hexDecode(str) {
        str = String(str);
        if (str.length % 2) str = str.slice(0, str.length - 1);
        var bytes = new Uint8Array(str.length / 2);
        for (var i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(str.substr(i * 2, 2), 16) & 0xFF;
        }
        return bytes;
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64_INV = (function() {
        var a = new Int8Array(256).fill(-1);
        for (var i = 0; i < 64; i++) a[B64.charCodeAt(i)] = i;
        a['='.charCodeAt(0)] = 0;
        return a;
    })();

    function b64Encode(bytes) {
        // Bulk-encode by chunk into an array, join once at the end.
        // QuickJS's `+=` string concat creates a fresh string per
        // step which goes quadratic on multi-KB inputs (50 KB took
        // ~800ms; 315 KB hung). Joining a small array of pre-
        // encoded segments collapses that to ~one alloc per chunk.
        // Chunk size 768 bytes = 1024 base64 chars per segment;
        // picked to keep the temporary char arrays cache-friendly
        // while bounding the array overhead.
        var n = bytes.length;
        if (n === 0) return '';
        var chunks = [];
        var i = 0;
        var CHUNK = 768;
        for (; i + CHUNK <= n; i += CHUNK) {
            var seg = '';
            for (var j = i; j < i + CHUNK; j += 3) {
                var v = (bytes[j] << 16) | (bytes[j+1] << 8) | bytes[j+2];
                seg += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
            }
            chunks.push(seg);
        }
        var tail = '';
        for (; i + 3 <= n; i += 3) {
            var v2 = (bytes[i] << 16) | (bytes[i+1] << 8) | bytes[i+2];
            tail += B64[(v2 >> 18) & 63] + B64[(v2 >> 12) & 63] + B64[(v2 >> 6) & 63] + B64[v2 & 63];
        }
        var rem = n - i;
        if (rem === 1) {
            var n1 = bytes[i] << 16;
            tail += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '==';
        } else if (rem === 2) {
            var n2 = (bytes[i] << 16) | (bytes[i+1] << 8);
            tail += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '=';
        }
        if (tail) chunks.push(tail);
        return chunks.join('');
    }

    function b64Decode(str) {
        str = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
        var pad = 0;
        if (str.charAt(str.length - 1) === '=') pad++;
        if (str.charAt(str.length - 2) === '=') pad++;
        var out = new Uint8Array(Math.floor(str.length * 3 / 4) - pad);
        var o = 0;
        for (var i = 0; i < str.length; i += 4) {
            var n = (B64_INV[str.charCodeAt(i)]   << 18) |
                    (B64_INV[str.charCodeAt(i+1)] << 12) |
                    (B64_INV[str.charCodeAt(i+2)] << 6)  |
                    (B64_INV[str.charCodeAt(i+3)]);
            if (o < out.length) out[o++] = (n >> 16) & 0xFF;
            if (o < out.length) out[o++] = (n >> 8) & 0xFF;
            if (o < out.length) out[o++] = n & 0xFF;
        }
        return out;
    }

    // ---- Buffer class -----------------------------------------------------

    function Buffer(arg, encodingOrLength) {
        if (typeof arg === 'number') {
            var u = new Uint8Array(arg);
            makeBuffer(u);
            return u;
        }
        if (typeof arg === 'string') return Buffer.from(arg, encodingOrLength);
        if (arg instanceof Uint8Array) {
            makeBuffer(arg);
            return arg;
        }
        if (Array.isArray(arg)) return Buffer.from(arg);
        throw new TypeError('unsupported Buffer argument');
    }

    function makeBuffer(u8) {
        u8.__isBuffer = true;
        u8.toString = function(encoding, start, end) {
            encoding = (encoding || 'utf8').toLowerCase();
            var slice = (start !== undefined || end !== undefined) ? u8.subarray(start || 0, end) : u8;
            if (encoding === 'utf8' || encoding === 'utf-8') return utf8Decode(slice);
            if (encoding === 'hex')                          return hexEncode(slice);
            if (encoding === 'base64')                       return b64Encode(slice);
            if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') {
                var s = '';
                for (var i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
                return s;
            }
            throw new Error('Unknown encoding: ' + encoding);
        };
        u8.slice = function(start, end) {
            var s = Uint8Array.prototype.subarray.call(u8, start, end);
            makeBuffer(s);
            return s;
        };
        u8.equals = function(other) {
            if (!other || other.length !== u8.length) return false;
            for (var i = 0; i < u8.length; i++) if (u8[i] !== other[i]) return false;
            return true;
        };
        u8.compare = function(other, targetStart, targetEnd, sourceStart, sourceEnd) {
            var a = u8.subarray(sourceStart || 0, sourceEnd !== undefined ? sourceEnd : u8.length);
            var b = other.subarray(targetStart || 0, targetEnd !== undefined ? targetEnd : other.length);
            var len = Math.min(a.length, b.length);
            for (var i = 0; i < len; i++) {
                if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
            }
            return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
        };
        u8.indexOf = function(value, byteOffset, encoding) {
            var needle;
            if (typeof value === 'number') {
                for (var i = byteOffset || 0; i < u8.length; i++) if (u8[i] === (value & 0xff)) return i;
                return -1;
            }
            if (typeof value === 'string') needle = Buffer.from(value, encoding || 'utf8');
            else if (value instanceof Uint8Array) needle = value;
            else throw new TypeError('Buffer.indexOf: unsupported value');
            outer: for (var j = byteOffset || 0; j <= u8.length - needle.length; j++) {
                for (var k = 0; k < needle.length; k++) if (u8[j + k] !== needle[k]) continue outer;
                return j;
            }
            return -1;
        };
        u8.includes = function(value, byteOffset, encoding) {
            return u8.indexOf(value, byteOffset, encoding) !== -1;
        };
        u8.copy = function(target, targetStart, sourceStart, sourceEnd) {
            targetStart = targetStart || 0;
            sourceStart = sourceStart || 0;
            sourceEnd = sourceEnd !== undefined ? sourceEnd : u8.length;
            var n = Math.min(sourceEnd - sourceStart, target.length - targetStart);
            for (var i = 0; i < n; i++) target[targetStart + i] = u8[sourceStart + i];
            return n;
        };
        u8.write = function(str, offset, length, encoding) {
            offset = offset || 0;
            if (typeof length === 'string') { encoding = length; length = undefined; }
            var bytes = Buffer.from(str, encoding || 'utf8');
            var n = Math.min(length !== undefined ? length : bytes.length, u8.length - offset);
            for (var i = 0; i < n; i++) u8[offset + i] = bytes[i];
            return n;
        };
        // Numeric readers (little-endian + big-endian, unsigned + signed).
        u8.readUInt8 = function(o) { return u8[o || 0]; };
        u8.readInt8  = function(o) { var v = u8[o || 0]; return v > 127 ? v - 256 : v; };
        u8.readUInt16LE = function(o) { o = o || 0; return u8[o] | (u8[o + 1] << 8); };
        u8.readUInt16BE = function(o) { o = o || 0; return (u8[o] << 8) | u8[o + 1]; };
        u8.readInt16LE  = function(o) { var v = u8.readUInt16LE(o); return v > 32767 ? v - 65536 : v; };
        u8.readInt16BE  = function(o) { var v = u8.readUInt16BE(o); return v > 32767 ? v - 65536 : v; };
        u8.readUInt32LE = function(o) { o = o || 0;
            return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) + (u8[o + 3] * 0x1000000); };
        u8.readUInt32BE = function(o) { o = o || 0;
            return (u8[o] * 0x1000000) + ((u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]); };
        u8.readInt32LE  = function(o) { o = o || 0;
            return u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24); };
        u8.readInt32BE  = function(o) { o = o || 0;
            return (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]; };

        u8.writeUInt8 = function(v, o) { u8[o || 0] = v & 0xff; return (o || 0) + 1; };
        u8.writeInt8  = u8.writeUInt8;
        u8.writeUInt16LE = function(v, o) { o = o || 0; u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff; return o + 2; };
        u8.writeUInt16BE = function(v, o) { o = o || 0; u8[o] = (v >>> 8) & 0xff; u8[o + 1] = v & 0xff; return o + 2; };
        u8.writeInt16LE  = u8.writeUInt16LE;
        u8.writeInt16BE  = u8.writeUInt16BE;
        u8.writeUInt32LE = function(v, o) { o = o || 0;
            u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff;
            u8[o + 2] = (v >>> 16) & 0xff; u8[o + 3] = (v >>> 24) & 0xff;
            return o + 4;
        };
        u8.writeUInt32BE = function(v, o) { o = o || 0;
            u8[o] = (v >>> 24) & 0xff; u8[o + 1] = (v >>> 16) & 0xff;
            u8[o + 2] = (v >>> 8) & 0xff; u8[o + 3] = v & 0xff;
            return o + 4;
        };
        u8.writeInt32LE = u8.writeUInt32LE;
        u8.writeInt32BE = u8.writeUInt32BE;
        return u8;
    }

    Buffer.from = function(source, encoding) {
        if (typeof source === 'string') {
            encoding = (encoding || 'utf8').toLowerCase();
            if (encoding === 'utf8' || encoding === 'utf-8') return makeBuffer(utf8Encode(source));
            if (encoding === 'hex')                          return makeBuffer(hexDecode(source));
            if (encoding === 'base64')                       return makeBuffer(b64Decode(source));
            if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') {
                var u = new Uint8Array(source.length);
                for (var i = 0; i < source.length; i++) u[i] = source.charCodeAt(i) & 0xFF;
                return makeBuffer(u);
            }
            throw new Error('Unknown encoding: ' + encoding);
        }
        if (source instanceof ArrayBuffer) return makeBuffer(new Uint8Array(source));
        if (source instanceof Uint8Array || Array.isArray(source)) {
            var copy = new Uint8Array(source.length);
            copy.set(source);
            return makeBuffer(copy);
        }
        throw new TypeError('Buffer.from: unsupported source');
    };

    Buffer.alloc = function(size, fill) {
        var u = new Uint8Array(size);
        if (fill !== undefined && fill !== 0) {
            var byteFill = typeof fill === 'number' ? fill : fill.charCodeAt ? fill.charCodeAt(0) : 0;
            u.fill(byteFill & 0xFF);
        }
        return makeBuffer(u);
    };

    Buffer.allocUnsafe = Buffer.alloc;

    Buffer.concat = function(list, totalLength) {
        if (!Array.isArray(list)) throw new TypeError('list argument must be an Array');
        if (list.length === 0) return Buffer.alloc(0);
        if (totalLength === undefined) {
            totalLength = 0;
            for (var i = 0; i < list.length; i++) totalLength += list[i].length;
        }
        var out = new Uint8Array(totalLength);
        var offset = 0;
        for (var j = 0; j < list.length; j++) {
            var buf = list[j];
            var take = Math.min(buf.length, totalLength - offset);
            out.set(buf.subarray(0, take), offset);
            offset += take;
        }
        return makeBuffer(out);
    };

    Buffer.isBuffer = function(x) {
        return !!(x && x.__isBuffer === true);
    };

    Buffer.byteLength = function(str, encoding) {
        if (typeof str !== 'string') return str.length || 0;
        encoding = (encoding || 'utf8').toLowerCase();
        if (encoding === 'hex')    return Math.floor(str.length / 2);
        if (encoding === 'base64') return Math.floor(str.replace(/=/g, '').length * 3 / 4);
        return utf8Encode(str).length;
    };

    exports.Buffer = Buffer;
    exports.kMaxLength = 0x7fffffff;
    exports.INSPECT_MAX_BYTES = 50;
});

// ---- child_process.js ----
// child_process — sync subset (execSync / spawnSync), backed by
// `__host_child_process_exec_sync` on both the native (rquickjs) path
// and the WASM-sandbox path. Argv crosses the host import boundary as
// a JSON-encoded array string so the wire shape stays primitive
// (host_imports work in (ptr, len) pairs, no array marshalling).
//
// Sync methods only: burn does not drive async child_process events.

__register_module('child_process', function(module, exports, require) {

    function ensureHost() {
        var fn = globalThis.__host_child_process_exec_sync;
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: child_process is not available in this sandbox");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function parseResult(raw) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var err = new Error("child_process: " + raw.slice('__HOST_ERR__:'.length));
            err.code = 'EACCES';
            throw err;
        }
        return JSON.parse(raw);
    }

    function callHost(cmd, argv) {
        // Always serialize argv as JSON for both native and wasm paths
        // — the wasm host import only accepts scalar args, and keeping
        // the wire identical means a single `parseResult` works for
        // both backends.
        var argvJson = JSON.stringify((argv || []).map(String));
        return ensureHost()(String(cmd), argvJson);
    }

    exports.execSync = function(command, options) {
        // Node's `execSync` takes a whole command string; we split on
        // whitespace for the simple shim.
        var parts = String(command).split(/\s+/).filter(Boolean);
        if (parts.length === 0) throw new Error("child_process.execSync: empty command");
        var argv = parts.slice(1);
        var raw = callHost(parts[0], argv);
        var result = parseResult(raw);
        if (result.status !== 0) {
            var err = new Error("Command failed: " + command + "\n" + result.stderr);
            err.status = result.status;
            err.stdout = result.stdout;
            err.stderr = result.stderr;
            throw err;
        }
        return result.stdout;
    };

    exports.spawnSync = function(command, args, options) {
        args = args || [];
        var raw = callHost(command, args);
        return parseResult(raw);
    };
});

// ---- cluster.js ----
// cluster — Node 20's primary/worker multi-process clustering.
//
// Burn's sandbox doesn't fork the main process; instead, the
// `worker_threads` shadow (`burn run --internal-worker`) covers the
// "isolated parallelism" use case. We expose `cluster` as a thin
// wrapper that delegates `cluster.fork()` to `new Worker(...)` so
// existing cluster-using code (Express load balancers, pino-cluster)
// keeps running. Each `Worker` here is a `worker_threads.Worker`,
// not a separate OS process; for most middleware this is a fine
// substitution since the contract — multiple isolated JS contexts
// processing requests — is preserved.

__register_module('cluster', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var workerThreads = require('worker_threads');

    var _isPrimary = !!workerThreads.isMainThread;
    var _workers = Object.create(null);
    var _nextId = 1;

    var primary = new EventEmitter();
    primary.workers = _workers;

    function fork(env) {
        if (!_isPrimary) {
            throw new Error('cluster.fork: can only be called from the primary');
        }
        if (!process.argv[1]) {
            throw new Error(
                'cluster.fork: no entry script — `cluster` needs `process.argv[1]` ' +
                'to point at a JS file the workers can re-run'
            );
        }
        var id = _nextId++;
        var w = new workerThreads.Worker(process.argv[1], {
            workerData: { __ab_cluster_id: id },
            env: Object.assign({}, process.env, env || {}),
        });
        var workerWrapper = {
            id: id,
            process: { pid: id }, // approximation — no real OS pid for thread workers
            isDead: function() { return _workers[id] === undefined; },
            isConnected: function() { return _workers[id] !== undefined; },
            kill: function(signal) { w.terminate(); _ = signal; },
            disconnect: function() { w.terminate(); },
            send: function(msg) { w.postMessage(msg); return true; },
            on: function(event, listener) { w.on(event, listener); return this; },
            once: function(event, listener) { w.once(event, listener); return this; },
            removeListener: function(event, listener) { w.removeListener(event, listener); return this; },
            _worker: w,
        };
        var _;
        w.on('exit', function(code) {
            delete _workers[id];
            try { primary.emit('exit', workerWrapper, code, null); } catch (_) {}
        });
        w.on('message', function(msg) {
            try { primary.emit('message', workerWrapper, msg); } catch (_) {}
        });
        _workers[id] = workerWrapper;
        try { primary.emit('fork', workerWrapper); } catch (_) {}
        try { primary.emit('online', workerWrapper); } catch (_) {}
        return workerWrapper;
    }

    function setupPrimary(opts) {
        // Spec: schedules an exec / args / silent setting. We accept
        // and remember the values for surface compat; the actual
        // worker entry comes from process.argv[1] (the same script
        // re-running with a cluster id in workerData).
        primary.settings = Object.assign(primary.settings || {}, opts || {});
    }

    primary.fork = fork;
    primary.setupPrimary = setupPrimary;
    primary.setupMaster = setupPrimary; // legacy alias
    primary.disconnect = function(cb) {
        var ids = Object.keys(_workers);
        ids.forEach(function(id) { _workers[id].disconnect(); });
        if (typeof cb === 'function') {
            Promise.resolve().then(cb);
        }
    };
    primary.settings = {};

    Object.defineProperty(primary, 'isPrimary', {
        get: function() { return _isPrimary; },
    });
    Object.defineProperty(primary, 'isMaster', {
        // Legacy alias — Node still exposes it for back-compat.
        get: function() { return _isPrimary; },
    });
    Object.defineProperty(primary, 'isWorker', {
        get: function() { return !_isPrimary; },
    });

    // When running inside a worker, expose the worker-side surface.
    if (!_isPrimary) {
        var wd = workerThreads.workerData || {};
        primary.worker = {
            id: wd.__ab_cluster_id || 0,
            process: { pid: wd.__ab_cluster_id || 0 },
            isDead: function() { return false; },
            isConnected: function() { return true; },
            send: function(msg) {
                if (workerThreads.parentPort) {
                    workerThreads.parentPort.postMessage(msg);
                    return true;
                }
                return false;
            },
            disconnect: function() {
                if (workerThreads.parentPort) workerThreads.parentPort.close();
            },
            kill: function() {
                if (workerThreads.parentPort) workerThreads.parentPort.close();
            },
            on: function(event, listener) {
                if (event === 'message' && workerThreads.parentPort) {
                    workerThreads.parentPort.on('message', listener);
                }
                return this;
            },
        };
    }

    primary.schedulingPolicy = 1; // SCHED_RR — symbolic
    primary.SCHED_NONE = 0;
    primary.SCHED_RR = 1;

    module.exports = primary;
});

// ---- console.js ----
// console — routes messages through the host log hook when available,
// falling back to a noop-buffer if no host is wired. `util.format` is
// used for message rendering so `%s`, `%d`, `%j` behave as expected.
//
// Eager-installed as `globalThis.console` via bootstrap IIFE, matching
// Node's drop-in posture where `console` is always available without an
// explicit `require('console')`. Also registered as the CommonJS
// `console` module so `require('console')` returns the same object.
//
// If `globalThis.console` already exists when this loads (e.g. Javy's
// built-in console on the wasm path, which writes to fd 1/2 directly),
// we leave it alone — the runtime's native impl is strictly better
// than our host-log bridge.

__register_module('console', function(module, exports, require) {
    module.exports = globalThis.console;
});

(function bootstrapConsole() {
    function resolveHost() {
        return typeof globalThis.__host_log === 'function' ? globalThis.__host_log : null;
    }

    // `util` isn't available yet at bundle-load time if this runs before
    // util.js registers — so render lazily.
    function render() {
        try {
            var util = require('util');
            return util.format.apply(null, arguments);
        } catch (_) {
            // Pre-util fallback: concatenate arguments the way Node does.
            var parts = [];
            for (var i = 0; i < arguments.length; i++) {
                parts.push(String(arguments[i]));
            }
            return parts.join(' ');
        }
    }

    function logAt(level) {
        return function() {
            var host = resolveHost();
            var msg = render.apply(null, arguments);
            if (host) host(level, msg);
            // No fallback sink in the sandbox — msg is dropped if host
            // isn't wired. Users who want host-less output should call
            // `globalThis.__host_log = function(lvl, m) { ... }`.
        };
    }

    // Build the full Node-shaped console contract. On wasm Javy ships
    // its own `globalThis.console` with just `log`/`error`; we keep
    // those (they write directly to fd 1/2 — strictly better than the
    // host-log bridge) and only fill in the methods Javy doesn't
    // provide. Missing methods like `assert`/`warn`/`info`/`debug`
    // are what break npm/pnpm/clipanion deep in their bundles, so the
    // fill-in is non-optional.
    var existing = globalThis.console || {};
    var defaults = {
        log:     logAt('info'),
        info:    logAt('info'),
        warn:    logAt('warn'),
        error:   logAt('error'),
        debug:   logAt('debug'),
        trace:   logAt('debug'),
        dir:     function(obj) {
            try {
                var util = require('util');
                logAt('info')(util.inspect(obj));
            } catch (_) {
                logAt('info')(String(obj));
            }
        },
        assert:  function(cond) {
            if (!cond) {
                var args = Array.prototype.slice.call(arguments, 1);
                logAt('error').apply(null, ['Assertion failed:'].concat(args));
            }
        },
        group:    function() {},
        groupCollapsed: function() {},
        groupEnd: function() {},
        count:    function() {},
        countReset: function() {},
        time:     function() {},
        timeLog:  function() {},
        timeEnd:  function() {},
        timeStamp: function() {},
        profile:  function() {},
        profileEnd: function() {},
        table:    function(t) { logAt('info')(JSON.stringify(t, null, 2)); },
        dirxml:   function() { logAt('info').apply(null, arguments); },
        clear:    function() {},
        Console:  function Console() { return existing; },
    };
    for (var name in defaults) {
        if (typeof existing[name] !== 'function') {
            existing[name] = defaults[name];
        }
    }
    globalThis.console = existing;
})();

// ---- crypto.js ----
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
        'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'
    ];
    var SUPPORTED_CIPHERS = [
        'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
        'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'
    ];
    exports.getHashes  = function() { return SUPPORTED_HASHES.slice(); };
    exports.getCiphers = function() { return SUPPORTED_CIPHERS.slice(); };
    exports.getCurves  = function() { return ['P-256', 'P-384', 'P-521']; };

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

// ---- dgram.js ----
// dgram — Node 20's UDP socket module. The host-side coordinator
// (`crates/afterburner-wasi/src/daemon_dgram.rs`) owns every
// `tokio::net::UdpSocket`; this polyfill is a thin EventEmitter
// façade. `dgram` requires daemon mode (the coordinator is tokio-
// backed); calling `bind` / `send` from library mode surfaces a clear
// `ERR_NO_DAEMON` rather than silently dropping packets.
//
// What works today: bind / address / send / close + `'listening'`
// and `'close'` events. Inbound `'message'` event delivery requires
// the CLI's daemon-event translator to route `dgram-message`
// envelopes through `__ab_dgram_handlers`; until that lands, sockets
// can be bound and used to *send* but won't observe inbound packets.

(function bootstrapDgramGlobals() {
    if (!globalThis.__ab_dgram_handlers) globalThis.__ab_dgram_handlers = {};
})();

__register_module('dgram', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;

    function mapHostErrorCode(rc) {
        switch (rc) {
            case -1: return 'ENO_DAEMON';
            case -2: return 'EACCES';
            case -3: return 'EBADID';
            case -4: return 'EINVAL';
            case -5: return 'EINVAL';
            case -6: return 'EINVAL';
            default: return 'EOTHER';
        }
    }

    function makeError(rc, prefix) {
        var detail = '';
        if (typeof globalThis.__host_last_error === 'function') {
            detail = globalThis.__host_last_error();
        }
        var msg = detail ? (prefix + ': ' + detail) : prefix;
        var err = new Error(msg);
        err.code = mapHostErrorCode(rc);
        return err;
    }

    function Socket(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.type = (typeof opts === 'string') ? opts : (opts.type || 'udp4');
        this._reuseAddr = !!opts.reuseAddr;
        this._ipv6Only = !!opts.ipv6Only;
        this._socketId = 0;
        this._bound = false;
        this._closed = false;
    }
    Socket.prototype = Object.create(EventEmitter.prototype);
    Socket.prototype.constructor = Socket;

    function ensureHost(name) {
        var fn = globalThis['__host_dgram_' + name];
        if (typeof fn !== 'function') {
            var err = new Error(
                'dgram.' + name + ': host coordinator not installed (daemon mode required)'
            );
            err.code = 'ERR_NO_DAEMON';
            throw err;
        }
        return fn;
    }

    Socket.prototype.bind = function(port, address, callback) {
        if (typeof port === 'function') { callback = port; port = 0; address = undefined; }
        else if (typeof address === 'function') { callback = address; address = undefined; }
        if (this._bound) {
            var bindErr = new Error('dgram.bind: socket already bound');
            bindErr.code = 'ERR_SOCKET_ALREADY_BOUND';
            if (typeof callback === 'function') {
                Promise.resolve().then(function() { callback(bindErr); });
            }
            throw bindErr;
        }
        port = port | 0;
        address = address || (this.type === 'udp6' ? '::' : '0.0.0.0');
        var fn;
        try { fn = ensureHost('bind'); }
        catch (e) {
            var self0 = this;
            Promise.resolve().then(function() { try { self0.emit('error', e); } catch (_) {} });
            if (typeof callback === 'function') Promise.resolve().then(function() { callback(e); });
            return this;
        }
        var rc = fn(String(address), port);
        if (rc < 0) {
            var err = makeError(rc, 'dgram.bind');
            var self = this;
            Promise.resolve().then(function() { try { self.emit('error', err); } catch (_) {} });
            if (typeof callback === 'function') Promise.resolve().then(function() { callback(err); });
            return this;
        }
        this._socketId = rc;
        this._bound = true;
        globalThis.__ab_dgram_handlers[this._socketId] = this;
        var self2 = this;
        Promise.resolve().then(function() {
            try { self2.emit('listening'); } catch (_) {}
            if (typeof callback === 'function') callback();
        });
        return this;
    };

    Socket.prototype.send = function(msg /*, [offset, length,] port, address, callback */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var callback = (args.length && typeof args[args.length - 1] === 'function')
            ? args.pop() : null;
        // Argument shapes:
        //   send(msg, port[, address][, cb])
        //   send(msg, offset, length, port[, address][, cb])
        var port, address;
        if (args.length >= 3) {
            // (offset, length, port[, address])
            var offset = args[0] | 0;
            var length = args[1] | 0;
            port = args[2] | 0;
            address = args[3];
            if (typeof msg === 'string') msg = Buffer.from(msg, 'utf8');
            if (!Buffer.isBuffer(msg)) msg = Buffer.from(msg);
            msg = msg.slice(offset, offset + length);
        } else {
            // (port[, address])
            port = args[0] | 0;
            address = args[1];
            if (typeof msg === 'string') msg = Buffer.from(msg, 'utf8');
            if (!Buffer.isBuffer(msg)) msg = Buffer.from(msg);
        }
        address = address || (this.type === 'udp6' ? '::1' : '127.0.0.1');
        if (!this._bound) {
            // Implicit bind to ephemeral port — matches Node.
            try { this.bind(0); }
            catch (e) {
                if (callback) Promise.resolve().then(function() { callback(e); });
                return;
            }
        }
        var fn;
        try { fn = ensureHost('send'); }
        catch (e) {
            if (callback) Promise.resolve().then(function() { callback(e); });
            else throw e;
            return;
        }
        var b64 = msg.toString('base64');
        var rc = fn(this._socketId, String(address), port, b64);
        var self = this;
        if (rc < 0) {
            var err = makeError(rc, 'dgram.send');
            if (callback) Promise.resolve().then(function() { callback(err); });
            else Promise.resolve().then(function() {
                try { self.emit('error', err); } catch (_) {}
            });
            return;
        }
        if (callback) Promise.resolve().then(function() { callback(null, rc); });
    };

    Socket.prototype.close = function(callback) {
        if (this._closed) {
            if (typeof callback === 'function') Promise.resolve().then(function() { callback(); });
            return this;
        }
        this._closed = true;
        if (this._socketId) {
            try { ensureHost('close')(this._socketId); } catch (_) {}
            delete globalThis.__ab_dgram_handlers[this._socketId];
        }
        var self = this;
        Promise.resolve().then(function() {
            try { self.emit('close'); } catch (_) {}
            if (typeof callback === 'function') callback();
        });
        return this;
    };

    Socket.prototype.address = function() {
        if (!this._bound) {
            var e = new Error('Not running');
            e.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
            throw e;
        }
        var fn;
        try { fn = ensureHost('address'); }
        catch (_) {
            return { address: '0.0.0.0', port: 0, family: this.type === 'udp6' ? 'IPv6' : 'IPv4' };
        }
        var raw = fn(this._socketId);
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var err = new Error('dgram.address: ' + raw.slice('__HOST_ERR__:'.length));
            err.code = 'EOTHER';
            throw err;
        }
        try {
            var parsed = JSON.parse(raw);
            return {
                address: parsed.address,
                port: parsed.port,
                family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
            };
        } catch (e) {
            var err2 = new Error('dgram.address: malformed host response');
            err2.code = 'EOTHER';
            throw err2;
        }
    };

    // Hook for the daemon-event dispatcher (not yet wired) to deliver
    // inbound 'message' events. The CLI's translator will call this
    // when a dgram-message envelope arrives.
    Socket.prototype._dispatchMessage = function(payloadB64, fromAddress, fromPort) {
        var msg;
        try { msg = Buffer.from(payloadB64, 'base64'); }
        catch (_) { return; }
        var rinfo = {
            address: fromAddress,
            port: fromPort,
            family: (fromAddress && fromAddress.indexOf(':') >= 0) ? 'IPv6' : 'IPv4',
            size: msg.length,
        };
        try { this.emit('message', msg, rinfo); } catch (_) {}
    };
    Socket.prototype._dispatchError = function(message) {
        var err = new Error(message || 'dgram error');
        err.code = 'EOTHER';
        try { this.emit('error', err); } catch (_) {}
    };

    // Unsupported / no-op options. UDP socket options below the
    // bind/send line aren't needed for the canonical use cases
    // (metrics push, request-response loops) and would expand the
    // host coordinator's surface for marginal value. They no-op so
    // libraries that defensively call them don't crash.
    Socket.prototype.connect = function() { throw notWired('connect'); };
    Socket.prototype.disconnect = function() { throw notWired('disconnect'); };
    Socket.prototype.remoteAddress = function() { throw notWired('remoteAddress'); };
    Socket.prototype.setBroadcast = function() {};
    Socket.prototype.setTTL = function() {};
    Socket.prototype.setMulticastTTL = function() {};
    Socket.prototype.setMulticastInterface = function() {};
    Socket.prototype.setMulticastLoopback = function() {};
    Socket.prototype.addMembership = function() {};
    Socket.prototype.dropMembership = function() {};
    Socket.prototype.addSourceSpecificMembership = function() {};
    Socket.prototype.dropSourceSpecificMembership = function() {};
    Socket.prototype.setRecvBufferSize = function() {};
    Socket.prototype.setSendBufferSize = function() {};
    Socket.prototype.getRecvBufferSize = function() { return 0; };
    Socket.prototype.getSendBufferSize = function() { return 0; };
    Socket.prototype.ref = function() { return this; };
    Socket.prototype.unref = function() { return this; };

    function notWired(name) {
        var e = new Error(
            'dgram.Socket.' + name + ' is not wired in burn — implementations focus '
            + 'on canonical bind/send use cases. File an issue if you need this.'
        );
        e.code = 'ERR_NOT_IMPLEMENTED';
        return e;
    }

    function createSocket(opts, callback) {
        var sock = new Socket(opts);
        if (typeof callback === 'function') sock.on('message', callback);
        return sock;
    }

    exports.createSocket = createSocket;
    exports.Socket = Socket;
});

// ---- dns.js ----
// dns — synchronous host-backed lookups, presented through Node's
// dual callback / promise API.
//
// API coverage:
//
//   dns.lookup(host[, opts], cb)        — A/AAAA via system resolver
//   dns.resolve(host[, rrtype], cb)     — dispatcher for record types
//   dns.resolve4 / resolve6             — A / AAAA arrays
//   dns.resolveMx                       — [{exchange, priority}]
//   dns.resolveTxt                      — [["fragment", ...], ...]
//   dns.resolveCname / resolveNs        — [hostname, ...]
//   dns.reverse(ip, cb)                 — PTR records
//   dns.promises.{lookup,resolve*,reverse}  — Promise-returning twins
//
// We have no event loop, so callbacks fire synchronously inside the
// resolver call; the Promise versions wrap the same result. The host
// applies a per-call timeout (`Manifold.http_timeout_ms`) so a hung
// resolver can never wedge the runtime.
//
// Error shape matches Node where it matters: `e.code` carries
// 'ENODATA' / 'ENOTFOUND' / 'EACCES' depending on what went wrong.
// The host-side `__HOST_ERR__:` prefix is unwrapped here so user
// callbacks see plain `Error` instances.

__register_module('dns', function(module, exports, require) {

    // ---- error wrapping --------------------------------------------

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function hostErrToError(s, hostname) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var code;
        // Heuristic mapping — the host returns kind-tagged strings in
        // most paths. PermissionDenied → EACCES; everything else
        // (timeouts, NXDOMAIN, garbage records) → ENODATA.
        if (/PermissionDenied/i.test(msg) || /Permission denied/i.test(msg)) {
            code = 'EACCES';
        } else if (/timed out/i.test(msg)) {
            code = 'ETIMEOUT';
        } else if (/no result|no record/i.test(msg)) {
            code = 'ENODATA';
        } else {
            code = 'ENODATA';
        }
        var err = new Error('dns: ' + msg);
        err.code = code;
        err.hostname = hostname;
        return err;
    }

    // ---- core call helper ------------------------------------------

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('Permission denied: ' + name + ' is not available');
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    /// Module-level + per-Resolver server overrides. Empty string =
    /// "use the system /etc/resolv.conf", which the host falls back to
    /// Cloudflare for if the file is missing. `setServers` and
    /// `Resolver.setServers` write through to these slots.
    var _moduleServersCsv = '';

    function callJsonResolver(hostFnName, hostname, serversCsv) {
        var fn = ensureHost(hostFnName);
        var raw = fn(String(hostname), String(serversCsv || ''));
        if (isHostErr(raw)) {
            throw hostErrToError(raw, hostname);
        }
        try {
            return JSON.parse(raw);
        } catch (e) {
            var err = new Error('dns: malformed host response: ' + e.message);
            err.code = 'EBADRESP';
            throw err;
        }
    }

    function callStringResolver(hostFnName, hostname) {
        var fn = ensureHost(hostFnName);
        var raw = fn(String(hostname));
        if (isHostErr(raw)) {
            throw hostErrToError(raw, hostname);
        }
        return raw;
    }

    function serversToCsv(arr) {
        if (!Array.isArray(arr)) return '';
        return arr.map(function(s) { return String(s).trim(); })
                  .filter(function(s) { return s.length > 0; })
                  .join(',');
    }

    // ---- callback / promise dual-shape glue ------------------------

    function dual(producer) {
        // Returns a function that accepts an optional trailing
        // callback. Without a callback it returns the value (sync —
        // matches the way Node's tests of the sync path run, since we
        // have no event loop). With a callback it invokes synchronously
        // with `(null, value)` or `(err)`.
        return function() {
            var args = Array.prototype.slice.call(arguments);
            var cb;
            if (args.length && typeof args[args.length - 1] === 'function') {
                cb = args.pop();
            }
            try {
                var v = producer.apply(null, args);
                if (cb) { cb(null, v); return; }
                return v;
            } catch (e) {
                if (cb) { cb(e); return; }
                throw e;
            }
        };
    }

    function promiseOf(producer) {
        return function() {
            var args = arguments;
            return new Promise(function(resolve, reject) {
                try { resolve(producer.apply(null, args)); }
                catch (e) { reject(e); }
            });
        };
    }

    // ---- lookup (A/AAAA dispatcher) --------------------------------

    function _lookupOne(hostname) {
        return {
            address: callStringResolver('__host_dns_lookup', hostname),
            family: 4, // host returns first IP; family detection lives in resolve4/6
        };
    }

    exports.lookup = function(hostname, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        if (typeof cb === 'function') {
            try {
                var r = _lookupOne(hostname);
                cb(null, r.address, r.family);
            } catch (e) { cb(e); }
            return;
        }
        return _lookupOne(hostname);
    };

    // ---- record-type-aware resolvers -------------------------------

    function makeArrayResolver(hostFnName) {
        return function(hostname, serversCsv) {
            var v = callJsonResolver(hostFnName, hostname, serversCsv);
            if (!Array.isArray(v)) {
                var err = new Error('dns: expected array from host');
                err.code = 'EBADRESP';
                throw err;
            }
            return v;
        };
    }

    /// Module-level resolvers — fall back to the module's setServers
    /// override (or system config when none is set).
    function moduleArrayResolver(hostFnName) {
        var inner = makeArrayResolver(hostFnName);
        return function(hostname) {
            return inner(hostname, _moduleServersCsv);
        };
    }

    var _resolve4 = moduleArrayResolver('__host_dns_resolve4');
    var _resolve6 = moduleArrayResolver('__host_dns_resolve6');
    var _resolveMx = moduleArrayResolver('__host_dns_resolve_mx');
    var _resolveTxt = moduleArrayResolver('__host_dns_resolve_txt');
    var _resolveCname = moduleArrayResolver('__host_dns_resolve_cname');
    var _resolveNs = moduleArrayResolver('__host_dns_resolve_ns');
    var _reverse = function(ip) {
        return moduleArrayResolver('__host_dns_reverse')(ip);
    };

    exports.resolve4 = dual(_resolve4);
    exports.resolve6 = dual(_resolve6);
    exports.resolveMx = dual(_resolveMx);
    exports.resolveTxt = dual(_resolveTxt);
    exports.resolveCname = dual(_resolveCname);
    exports.resolveNs = dual(_resolveNs);
    exports.reverse = dual(_reverse);

    // resolve(hostname, [rrtype], cb) — Node's umbrella entry. Default
    // rrtype is 'A'. We dispatch into the typed resolvers.
    exports.resolve = function(hostname, rrtype, cb) {
        if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
        rrtype = String(rrtype || 'A').toUpperCase();
        var fn;
        switch (rrtype) {
            case 'A':     fn = _resolve4; break;
            case 'AAAA':  fn = _resolve6; break;
            case 'MX':    fn = _resolveMx; break;
            case 'TXT':   fn = _resolveTxt; break;
            case 'CNAME': fn = _resolveCname; break;
            case 'NS':    fn = _resolveNs; break;
            default:
                var err = new Error('dns.resolve: unsupported rrtype ' + rrtype);
                err.code = 'ENOTIMP';
                if (cb) { cb(err); return; }
                throw err;
        }
        if (typeof cb === 'function') {
            try { cb(null, fn(hostname)); }
            catch (e) { cb(e); }
            return;
        }
        return fn(hostname);
    };

    /// Per-instance Resolver. `setServers([...])` plumbs through to
    /// hickory's `ResolverConfig`: every method on this Resolver
    /// targets those upstream addresses instead of the system's
    /// `/etc/resolv.conf`. Each method is bound to the instance so
    /// the right server list is captured per call.
    function Resolver() {
        this._servers = [];
        this._serversCsv = '';
    }
    Resolver.prototype.setServers = function(servers) {
        if (!Array.isArray(servers)) {
            throw new TypeError('Resolver.setServers: argument must be an array');
        }
        // Validate each entry — Node's setServers rejects malformed
        // addresses up front rather than failing on the first lookup.
        for (var i = 0; i < servers.length; i++) {
            var s = servers[i];
            if (typeof s !== 'string') {
                throw new TypeError('Resolver.setServers: each server must be a string');
            }
        }
        this._servers = servers.slice();
        this._serversCsv = serversToCsv(this._servers);
    };
    Resolver.prototype.getServers = function() {
        return this._servers.slice();
    };
    Resolver.prototype.cancel = function() { /* no-op — calls are sync */ };

    /// Build a per-instance method that captures `this._serversCsv`
    /// and dispatches to the right host import via `makeArrayResolver`.
    function instanceArrayMethod(hostFnName) {
        var inner = makeArrayResolver(hostFnName);
        return dual(function(hostname) {
            // `this` is the Resolver instance.
            return inner(hostname, this._serversCsv);
        });
    }

    // Each Resolver method is its own dual()-wrapped fn so the
    // server list goes through to the host. We can't share with
    // the module-level resolvers because those use the global
    // `_moduleServersCsv`.
    Resolver.prototype.resolve4 = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve4')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolve6 = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve6')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolveMx = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve_mx')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolveTxt = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve_txt')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolveCname = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve_cname')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolveNs = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_resolve_ns')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.reverse = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            var v = makeArrayResolver('__host_dns_reverse')(args[0], this._serversCsv);
            if (cb) { cb(null, v); return; }
            return v;
        } catch (e) {
            if (cb) { cb(e); return; }
            throw e;
        }
    };
    Resolver.prototype.resolve = function(hostname, rrtype, cb) {
        if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
        rrtype = String(rrtype || 'A').toUpperCase();
        var byType = {
            'A': this.resolve4, 'AAAA': this.resolve6, 'MX': this.resolveMx,
            'TXT': this.resolveTxt, 'CNAME': this.resolveCname, 'NS': this.resolveNs,
        };
        var fn = byType[rrtype];
        if (!fn) {
            var err = new Error('dns.resolve: unsupported rrtype ' + rrtype);
            err.code = 'ENOTIMP';
            if (cb) { cb(err); return; }
            throw err;
        }
        return fn.call(this, hostname, cb);
    };

    exports.Resolver = Resolver;

    // Module-level setServers / getServers — Node exposes these on
    // both the namespace and the Resolver class. They mutate the
    // shared `_moduleServersCsv` so the next module-level call uses
    // the new list.
    exports.setServers = function(servers) {
        if (!Array.isArray(servers)) {
            throw new TypeError('dns.setServers: argument must be an array');
        }
        _moduleServersCsv = serversToCsv(servers);
    };
    exports.getServers = function() {
        return _moduleServersCsv.length === 0 ? [] : _moduleServersCsv.split(',');
    };
    exports.setDefaultResultOrder = function(order) {
        // Stable accept; Node uses this for IPv4-first vs IPv6-first
        // ordering. With record-type-specific resolvers the option
        // is mostly cosmetic for the polyfill.
        var _ = order;
    };
    exports.getDefaultResultOrder = function() { return 'verbatim'; };

    // RR-type constants — surface so callers can do `dns.A`, etc.
    exports.A = 'A';
    exports.AAAA = 'AAAA';
    exports.MX = 'MX';
    exports.TXT = 'TXT';
    exports.CNAME = 'CNAME';
    exports.NS = 'NS';
    exports.PTR = 'PTR';

    // ---- Promises mirror -------------------------------------------

    exports.promises = {
        lookup: promiseOf(_lookupOne),
        resolve4: promiseOf(_resolve4),
        resolve6: promiseOf(_resolve6),
        resolveMx: promiseOf(_resolveMx),
        resolveTxt: promiseOf(_resolveTxt),
        resolveCname: promiseOf(_resolveCname),
        resolveNs: promiseOf(_resolveNs),
        reverse: promiseOf(_reverse),
        resolve: function(hostname, rrtype) {
            return new Promise(function(resolve, reject) {
                try {
                    exports.resolve(hostname, rrtype, function(err, v) {
                        if (err) reject(err); else resolve(v);
                    });
                } catch (e) { reject(e); }
            });
        },
        Resolver: Resolver,
    };
});

// ---- domain.js ----
// domain — deprecated since Node 4 but still imported by older
// libraries (winston < 3, some Express middleware). Real Node's
// `domain` is an error-handling boundary tied to the async stack;
// without an async stack we provide a synchronous shim that runs
// the callback inline and re-throws errors with a `domain`-like
// `'error'` event.

__register_module('domain', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function Domain() {
        EventEmitter.call(this);
        this.members = [];
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Domain.prototype.constructor = Domain;

    Domain.prototype.run = function(fn) {
        try {
            return fn();
        } catch (e) {
            try { this.emit('error', e); } catch (_) {}
            throw e;
        }
    };
    Domain.prototype.add = function(emitter) { this.members.push(emitter); return this; };
    Domain.prototype.remove = function(emitter) {
        var i = this.members.indexOf(emitter);
        if (i !== -1) this.members.splice(i, 1);
        return this;
    };
    Domain.prototype.bind = function(callback) {
        var self = this;
        return function() {
            try { return callback.apply(this, arguments); }
            catch (e) { try { self.emit('error', e); } catch (_) {} throw e; }
        };
    };
    Domain.prototype.intercept = function(callback) {
        var self = this;
        return function(err) {
            if (err) {
                try { self.emit('error', err); } catch (_) {}
                return;
            }
            try {
                return callback.apply(this, Array.prototype.slice.call(arguments, 1));
            } catch (e) {
                try { self.emit('error', e); } catch (_) {}
                throw e;
            }
        };
    };
    Domain.prototype.enter = function() {};
    Domain.prototype.exit = function() {};
    Domain.prototype.dispose = function() {};

    function create() { return new Domain(); }

    exports.create = create;
    exports.createDomain = create;
    exports.Domain = Domain;
    exports.active = null;
});

// ---- events.js ----
// events — a minimal EventEmitter with the APIs scripts actually use.

__register_module('events', function(module, exports, require) {

    function EventEmitter() {
        if (!(this instanceof EventEmitter)) return new EventEmitter();
        ensureEvents(this);
        this._maxListeners = undefined;
    }

    // Lazy-init for the `_events` bag. Real Node's EventEmitter does
    // the same thing: `init()` runs at constructor-call time, but
    // every accessor method also bails out cleanly when `_events`
    // wasn't yet allocated (treats absence as empty). The npm
    // pattern of `mixin(target, EventEmitter.prototype, false)` —
    // used by Express's `merge-descriptors` to graft EventEmitter
    // methods onto a plain `app` object without running the
    // constructor — depends on this. Without it, `app.on('mount',
    // cb)` throws `cannot read property 'mount' of undefined`
    // because `this._events` was never set.
    function ensureEvents(self) {
        if (!self._events) self._events = Object.create(null);
        return self._events;
    }

    EventEmitter.prototype.setMaxListeners = function(n) {
        this._maxListeners = n;
        return this;
    };
    EventEmitter.prototype.getMaxListeners = function() {
        return this._maxListeners === undefined ? 10 : this._maxListeners;
    };

    EventEmitter.prototype.on = function(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('listener must be a function');
        var events = ensureEvents(this);
        var list = events[name];
        if (!list) events[name] = [fn];
        else list.push(fn);
        return this;
    };
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;

    EventEmitter.prototype.once = function(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('listener must be a function');
        var self = this;
        function wrapper() {
            self.removeListener(name, wrapper);
            fn.apply(self, arguments);
        }
        wrapper.listener = fn;
        return this.on(name, wrapper);
    };

    EventEmitter.prototype.removeListener = function(name, fn) {
        if (!this._events) return this;
        var list = this._events[name];
        if (!list) return this;
        for (var i = list.length - 1; i >= 0; i--) {
            if (list[i] === fn || list[i].listener === fn) {
                list.splice(i, 1);
                break;
            }
        }
        if (list.length === 0) delete this._events[name];
        return this;
    };
    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

    EventEmitter.prototype.removeAllListeners = function(name) {
        if (name === undefined) this._events = Object.create(null);
        else if (this._events) delete this._events[name];
        return this;
    };

    EventEmitter.prototype.emit = function(name) {
        if (!this._events) return name === 'error' ? false : false;
        var list = this._events[name];
        if (!list) return name === 'error';
        // Copy before iterating — listeners may mutate the list.
        var copy = list.slice();
        var args = new Array(arguments.length - 1);
        for (var i = 1; i < arguments.length; i++) args[i - 1] = arguments[i];
        for (var j = 0; j < copy.length; j++) copy[j].apply(this, args);
        return true;
    };

    EventEmitter.prototype.listeners = function(name) {
        if (!this._events) return [];
        var list = this._events[name];
        return list ? list.slice() : [];
    };

    EventEmitter.prototype.listenerCount = function(name) {
        if (!this._events) return 0;
        var list = this._events[name];
        return list ? list.length : 0;
    };

    EventEmitter.prototype.eventNames = function() {
        return this._events ? Object.keys(this._events) : [];
    };

    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.defaultMaxListeners = 10;

    module.exports = EventEmitter;
});

// ---- fetch.js ----
// fetch / Request / Response / Headers — Web API, synchronous under
// the hood (our http host is sync) but Promise-wrapped to match the
// standard interface.

(function installFetch() {
    if (typeof globalThis.fetch === 'function') return;

    function Headers(init) {
        this._m = Object.create(null);
        if (!init) return;
        if (init instanceof Headers) {
            for (var k in init._m) this._m[k] = init._m[k];
            return;
        }
        if (Array.isArray(init)) {
            for (var i = 0; i < init.length; i++) this.set(init[i][0], init[i][1]);
            return;
        }
        var keys = Object.keys(init);
        for (var j = 0; j < keys.length; j++) this.set(keys[j], init[keys[j]]);
    }
    Headers.prototype.get = function(k)       { return this._m[String(k).toLowerCase()] || null; };
    Headers.prototype.has = function(k)       { return String(k).toLowerCase() in this._m; };
    Headers.prototype.set = function(k, v)    { this._m[String(k).toLowerCase()] = String(v); };
    Headers.prototype.append = function(k, v) {
        var key = String(k).toLowerCase();
        this._m[key] = (this._m[key] ? this._m[key] + ', ' : '') + String(v);
    };
    Headers.prototype['delete'] = function(k) { delete this._m[String(k).toLowerCase()]; };
    Headers.prototype.forEach = function(cb)  {
        var keys = Object.keys(this._m);
        for (var i = 0; i < keys.length; i++) cb(this._m[keys[i]], keys[i], this);
    };
    Headers.prototype.entries = function() {
        var keys = Object.keys(this._m);
        var self = this;
        var i = 0;
        return { next: function() {
            if (i >= keys.length) return { done: true };
            var k = keys[i++];
            return { value: [k, self._m[k]], done: false };
        } };
    };

    function Request(url, init) {
        init = init || {};
        this.url = String(url);
        this.method = (init.method || 'GET').toUpperCase();
        this.headers = new Headers(init.headers);
        this.body = init.body != null ? String(init.body) : null;
        this.signal = init.signal || null;
    }

    function Response(body, init) {
        init = init || {};
        // Body storage: prefer `bodyB64` (authoritative bytes) if
        // provided, fall back to `body` string (lossy-utf8 text view).
        this._bodyText = body != null ? String(body) : '';
        this._bodyB64 = init.bodyB64 || null;
        this.status = init.status !== undefined ? init.status : 200;
        this.statusText = init.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(init.headers);
        this.url = init.url || '';
        this.bodyUsed = false;
    }
    Response.prototype.text = function() {
        if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
        this.bodyUsed = true;
        // Decode base64 → utf8 when binary bytes are authoritative so
        // text() sees proper decoded characters rather than the lossy
        // roundtrip.
        if (this._bodyB64 !== null) {
            var Buffer = require('buffer').Buffer;
            return Promise.resolve(Buffer.from(this._bodyB64, 'base64').toString('utf8'));
        }
        return Promise.resolve(this._bodyText);
    };
    Response.prototype.json = function() {
        return this.text().then(function(s) { return JSON.parse(s); });
    };
    Response.prototype.arrayBuffer = function() {
        if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
        this.bodyUsed = true;
        var Buffer = require('buffer').Buffer;
        // `bodyB64` roundtrips binary losslessly; fall back to utf8
        // encode of the text view when the host didn't provide it.
        if (this._bodyB64 !== null) {
            var buf = Buffer.from(this._bodyB64, 'base64');
            return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
        }
        return Promise.resolve(Buffer.from(this._bodyText, 'utf8').buffer);
    };
    Response.prototype.clone = function() {
        var r = new Response(this._bodyText, {
            status: this.status,
            statusText: this.statusText,
            headers: this.headers,
            url: this.url,
            bodyB64: this._bodyB64,
        });
        return r;
    };

    function fetch(input, init) {
        var req = input instanceof Request ? input : new Request(input, init);
        if (req.signal && req.signal.aborted) {
            return Promise.reject(req.signal.reason || new Error('Aborted'));
        }
        if (typeof globalThis.__host_http_request !== 'function') {
            return Promise.reject(new Error('fetch: net capability not granted'));
        }
        var raw = globalThis.__host_http_request(req.method, req.url, req.body);
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { return Promise.reject(new Error('fetch: malformed host response: ' + e.message)); }
        if (typeof parsed.body === 'string' && parsed.body.indexOf('__HOST_ERR__:') === 0) {
            return Promise.reject(new Error('fetch: ' + parsed.body.slice('__HOST_ERR__:'.length)));
        }
        var resp = new Response(parsed.body, {
            status: parsed.status,
            url: req.url,
            bodyB64: parsed.body_b64 || null,
        });
        return Promise.resolve(resp);
    }

    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
})();

// ---- fs.js ----
// fs — thin glue over the __host_fs_* globals installed by the engine.
// Every method throws if the host global isn't present (meaning the
// engine didn't wire fs, usually because Manifold::fs == None).
//
// The WASM plugin signals host-side errors by returning a string that
// starts with "__HOST_ERR__:" — we check for that prefix and rethrow.

__register_module('fs', function(module, exports, require) {

    function requireHost(name) {
        var fn = globalThis['__host_fs_' + name];
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: fs." + name + " is not available");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function checkHostError(result, op) {
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("fs." + op + ": " + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) {
                err.code = 'EACCES';
            } else if (msg.toLowerCase().indexOf('not found') !== -1) {
                err.code = 'ENOENT';
            }
            throw err;
        }
        return result;
    }

    // Match Node.js exactly: the host bridge always sends bytes as
    // base64 (binary-safe wire format). The polyfill decodes and
    // converts based on the caller's encoding choice.
    //
    //   fs.readFileSync(path)              → Buffer        (Node default)
    //   fs.readFileSync(path, 'utf8')      → string
    //   fs.readFileSync(path, {encoding})  → string
    //   fs.readFileSync(path, {encoding: null}) → Buffer
    var BufferLazy;
    function bufferModule() {
        if (!BufferLazy) BufferLazy = require('buffer').Buffer;
        return BufferLazy;
    }

    function pickEncoding(options) {
        if (typeof options === 'string') return options;
        if (options && typeof options === 'object') {
            // Node treats `encoding: null` as "give me a Buffer".
            return options.encoding === undefined ? undefined : options.encoding;
        }
        return undefined;
    }

    exports.readFileSync = function(path, options) {
        var encoding = pickEncoding(options);
        // The encoding hint goes to the host so native (rquickjs)
        // bindings can short-circuit if they want; the WASM path
        // ignores it and always returns base64. Either way the
        // decode below is the source of truth.
        var b64 = requireHost('read_file_sync')(String(path), 'base64');
        b64 = checkHostError(b64, 'readFileSync');
        var Buffer = bufferModule();
        var buf = Buffer.from(b64, 'base64');
        if (encoding == null) return buf;
        return buf.toString(encoding);
    };

    exports.writeFileSync = function(path, data, options) {
        var encoding = pickEncoding(options);
        var Buffer = bufferModule();
        var bytes;
        if (Buffer.isBuffer(data)) {
            bytes = data;
        } else if (data instanceof Uint8Array) {
            bytes = Buffer.from(data);
        } else if (typeof data === 'string') {
            bytes = Buffer.from(data, encoding || 'utf8');
        } else {
            throw new TypeError('fs.writeFileSync: data must be Buffer, Uint8Array, or string');
        }
        var b64 = bytes.toString('base64');
        // Pass 'base64' through as the encoding hint (the WASM bridge
        // reads bytes from memory either way; this just keeps the
        // 3-arg shape stable for the native binding).
        var out = requireHost('write_file_sync')(String(path), b64, 'base64');
        checkHostError(out, 'writeFileSync');
    };

    exports.existsSync = function(path) {
        var fn = globalThis.__host_fs_exists_sync;
        return typeof fn === 'function' ? fn(String(path)) : false;
    };

    // Fully fleshed-out Stats object. Node's `Stats` exposes seven
    // type-test methods (isFile / isDirectory / isSymbolicLink /
    // isBlockDevice / isCharacterDevice / isSocket / isFIFO) plus a
    // handful of mode/ino/size/mtime/atime/ctime/birthtime fields and
    // their `*Ms` counterparts. Libraries like path-scurry and chokidar
    // call `entToType(s)` over every field; missing methods crash with
    // "not a function" deep in their walkers. The host gives us file/
    // directory bits via `stat_sync`; everything else is `false` (we
    // don't surface block/char/socket/fifo through the bridge today).
    function shapeStats(parsed) {
        var s = parsed || {};
        s.isFile             = wrapBool(!!s.isFile);
        s.isDirectory        = wrapBool(!!s.isDirectory);
        s.isSymbolicLink     = wrapBool(!!s.isSymbolicLink);
        s.isBlockDevice      = wrapBool(!!s.isBlockDevice);
        s.isCharacterDevice  = wrapBool(!!s.isCharacterDevice);
        s.isSocket           = wrapBool(!!s.isSocket);
        s.isFIFO             = wrapBool(!!s.isFIFO);
        if (typeof s.mode  !== 'number') s.mode  = s.isDirectory() ? 0o040755 : 0o100644;
        if (typeof s.size  !== 'number') s.size  = 0;
        if (typeof s.ino   !== 'number') s.ino   = 0;
        if (typeof s.dev   !== 'number') s.dev   = 0;
        if (typeof s.nlink !== 'number') s.nlink = 1;
        if (typeof s.uid   !== 'number') s.uid   = 0;
        if (typeof s.gid   !== 'number') s.gid   = 0;
        if (typeof s.rdev  !== 'number') s.rdev  = 0;
        if (typeof s.blksize !== 'number') s.blksize = 4096;
        if (typeof s.blocks  !== 'number') s.blocks  = Math.ceil(s.size / 512);
        // Time fields. Node exposes both `ms` numeric and Date-shaped.
        var nowMs = (typeof s.mtimeMs === 'number') ? s.mtimeMs : Date.now();
        if (typeof s.atimeMs !== 'number')    s.atimeMs    = nowMs;
        if (typeof s.mtimeMs !== 'number')    s.mtimeMs    = nowMs;
        if (typeof s.ctimeMs !== 'number')    s.ctimeMs    = nowMs;
        if (typeof s.birthtimeMs !== 'number') s.birthtimeMs = nowMs;
        if (!s.atime)     s.atime     = new Date(s.atimeMs);
        if (!s.mtime)     s.mtime     = new Date(s.mtimeMs);
        if (!s.ctime)     s.ctime     = new Date(s.ctimeMs);
        if (!s.birthtime) s.birthtime = new Date(s.birthtimeMs);
        return s;
    }
    function wrapBool(v) { return function() { return v; }; }

    exports.statSync = function(path) {
        var raw = checkHostError(requireHost('stat_sync')(String(path)), 'statSync');
        return shapeStats(JSON.parse(raw));
    };
    // lstatSync — Node's `lstat` differs from `stat` only for
    // symlinks (it returns info about the link itself). The sandbox
    // bridge doesn't surface symlink-specific bits today; falling
    // back to `statSync` matches the symlink-followed posture we
    // already have for `readFileSync` / `readdirSync`.
    exports.lstatSync = function(path) {
        return exports.statSync(path);
    };

    // statfsSync(path[, options]) — file-system-level info (Node 19+).
    // We don't have a host bridge for `statvfs`; surface conservative
    // defaults so probing libraries don't crash. `bsize` matches the
    // common Linux page size; `bfree` / `bavail` are flagged as
    // available so callers don't think the volume is full.
    exports.statfsSync = function(path, options) {
        // We could route to `__host_fs_statfs_sync` if one becomes
        // available; for now return a synthesised StatFs object that
        // satisfies the standard property shape.
        var bigint = options && options.bigint === true;
        var fields = {
            type: 0,
            bsize: 4096,
            blocks: 0,
            bfree: 1 << 20,
            bavail: 1 << 20,
            files: 0,
            ffree: 1 << 20,
        };
        if (bigint) {
            for (var k in fields) {
                if (Object.prototype.hasOwnProperty.call(fields, k)) {
                    fields[k] = BigInt(fields[k]);
                }
            }
        }
        return fields;
    };
    exports.statfs = function(path, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        try {
            var v = exports.statfsSync(path, options);
            if (cb) queueMicrotask(function() { cb(null, v); });
            return new Promise(function(resolve) { resolve(v); });
        } catch (e) {
            if (cb) queueMicrotask(function() { cb(e); });
            return new Promise(function(_r, reject) { reject(e); });
        }
    };

    // readlinkSync — no host bridge, so fail with ENOSYS so callers
    // can fall through (most archive / module-resolution code probes
    // and degrades gracefully when readlink fails).
    exports.readlinkSync = function(path) {
        var fn = globalThis.__host_fs_readlink_sync;
        if (typeof fn === 'function') {
            return checkHostError(fn(String(path)), 'readlinkSync');
        }
        var e = new Error("readlinkSync is not implemented");
        e.code = 'ENOSYS';
        throw e;
    };

    // accessSync — Node uses bitwise mode constants. We map any
    // mode to `existsSync`, which is the semantic the vast majority
    // of consumers care about (does the path exist + is reachable).
    var F_OK = 0, R_OK = 4, W_OK = 2, X_OK = 1;
    exports.accessSync = function(path, _mode) {
        if (!exports.existsSync(path)) {
            var e = new Error("ENOENT: no such file or directory, access '" + String(path) + "'");
            e.code = 'ENOENT';
            e.errno = -2;
            e.path = String(path);
            throw e;
        }
    };

    exports.readdirSync = function(path) {
        // The host returns either an array of entries (success) or a
        // string starting with `__HOST_ERR__:` (failure — non-existent
        // path, permission denied, etc). Throwing on the error string
        // matches Node's contract and prevents callers from iterating
        // a single string as if it were a directory entry.
        var result = requireHost('readdir_sync')(String(path));
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("ENOENT: no such file or directory, scandir '" + String(path) + "'");
            err.code = 'ENOENT';
            err.errno = -2;
            err.syscall = 'scandir';
            err.path = String(path);
            // Preserve the original detail in case callers introspect
            // beyond `code`.
            err.message = err.message + ' (' + msg + ')';
            throw err;
        }
        return result;
    };

    exports.mkdirSync = function(path, options) {
        var recursive = !!(options && options.recursive);
        requireHost('mkdir_sync')(String(path), recursive);
    };

    exports.unlinkSync = function(path) {
        requireHost('unlink_sync')(String(path));
    };

    exports.renameSync = function(from, to) {
        requireHost('rename_sync')(String(from), String(to));
    };

    // Append. Build on readFileSync + writeFileSync — atomic-ish for
    // small files which is the only shape we'd hit in the sandbox.
    exports.appendFileSync = function(path, data, options) {
        var existing;
        try { existing = exports.readFileSync(path); } catch (_) { existing = ''; }
        var combined;
        if (Buffer.isBuffer(existing) || Buffer.isBuffer(data)) {
            combined = Buffer.concat([
                Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing)),
                Buffer.isBuffer(data) ? data : Buffer.from(String(data))
            ]);
        } else {
            combined = String(existing) + String(data);
        }
        exports.writeFileSync(path, combined, options);
    };

    // copyFileSync — straight read-then-write, matches Node when
    // `flags` is the default 0 (copy contents, overwrite if exists).
    exports.copyFileSync = function(src, dst, _flags) {
        var data = exports.readFileSync(src);
        exports.writeFileSync(dst, data);
    };

    // truncateSync — read existing, truncate, rewrite. Sandbox-wide
    // libraries (npm, tar, etc.) only ever truncate small lockfiles
    // so the read+write path is fine.
    exports.truncateSync = function(path, len) {
        len = len || 0;
        var existing;
        try { existing = exports.readFileSync(path); } catch (_) { existing = Buffer.alloc(0); }
        var buf = Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing));
        var truncated = buf.slice(0, len);
        exports.writeFileSync(path, truncated);
    };

    // rmdirSync / rmSync — no host bridge for recursive dir removal,
    // so we walk the tree and delete leaves. Slow for huge trees but
    // correct for lockfile / cache cleanup the sandbox actually sees.
    function _rmDir(path) {
        var entries;
        try { entries = exports.readdirSync(path); } catch (e) { entries = []; }
        for (var i = 0; i < entries.length; i++) {
            var child = String(path) + '/' + entries[i];
            var s;
            try { s = exports.statSync(child); } catch (_) { continue; }
            if (s.isDirectory()) _rmDir(child);
            else { try { exports.unlinkSync(child); } catch (_) {} }
        }
        try { requireHost('unlink_sync')(String(path)); } catch (_) {}
    }
    exports.rmdirSync = function(path, options) {
        if (options && options.recursive) { _rmDir(path); return; }
        try { requireHost('unlink_sync')(String(path)); }
        catch (e) {
            // Some hosts route directory removal through a separate fn;
            // fall back to the recursive walker if it's empty.
            _rmDir(path);
        }
    };
    exports.rmSync = function(path, options) {
        options = options || {};
        if (!exports.existsSync(path)) {
            if (options.force) return;
            var e = new Error("ENOENT: no such file or directory, rm '" + String(path) + "'");
            e.code = 'ENOENT';
            throw e;
        }
        var s;
        try { s = exports.statSync(path); } catch (_) { s = null; }
        if (s && s.isDirectory()) {
            if (options.recursive) _rmDir(path);
            else {
                var ee = new Error("EISDIR: illegal operation on a directory, rm '" + String(path) + "'");
                ee.code = 'EISDIR';
                throw ee;
            }
        } else {
            try { exports.unlinkSync(path); } catch (e) { if (!options.force) throw e; }
        }
    };

    // mkdtempSync — atomic-name temp dir creation. Use a 6-char
    // suffix matching Node's contract.
    exports.mkdtempSync = function(prefix) {
        var p = String(prefix);
        for (var attempt = 0; attempt < 16; attempt++) {
            var rnd = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
            var name = p + rnd;
            try {
                requireHost('mkdir_sync')(name, false);
                return name;
            } catch (_) { /* collision — try again */ }
        }
        var e = new Error("mkdtempSync: failed to create unique directory");
        e.code = 'EEXIST';
        throw e;
    };

    // No-op chmod / chown / utimes / link / symlink / lchown —
    // the sandbox doesn't grant arbitrary metadata mutation, but
    // libraries that defensively call these (npm cache, tar
    // extraction) expect them to silently succeed when the
    // operation is harmless.
    exports.chmodSync   = function(_p, _m) {};
    exports.fchmodSync  = function(_fd, _m) {};
    exports.lchmodSync  = function(_p, _m) {};
    exports.chownSync   = function(_p, _u, _g) {};
    exports.fchownSync  = function(_fd, _u, _g) {};
    exports.lchownSync  = function(_p, _u, _g) {};
    exports.utimesSync  = function(_p, _a, _m) {};
    exports.lutimesSync = function(_p, _a, _m) {};
    exports.futimesSync = function(_fd, _a, _m) {};
    exports.linkSync    = function(existing, target) {
        // Best-effort: copy contents. Hard-link semantics are not
        // representable through the bridge, but most callers only
        // need the file to exist at the new path.
        exports.copyFileSync(existing, target);
    };
    exports.symlinkSync = function(target, p, _type) {
        // Same posture as linkSync — copy. Real symlink behavior
        // (lstat differing from stat) isn't representable.
        try { exports.copyFileSync(target, p); }
        catch (e) {
            // Source missing is the typical npm install case for
            // workspace symlinks; fail loudly so callers can
            // fall through to a real install path.
            throw e;
        }
    };

    // fs constants. Most tools probe `fs.constants.{F,R,W,X}_OK`
    // (access mode flags) and `O_*` (open flag bits). Linux numeric
    // values; we mirror Node's table.
    exports.constants = {
        F_OK: F_OK, R_OK: R_OK, W_OK: W_OK, X_OK: X_OK,
        O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
        O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536,
        O_NOATIME: 262144, O_NOFOLLOW: 131072, O_SYNC: 1052672,
        O_DSYNC: 4096, O_SYMLINK: 0, O_DIRECT: 16384, O_NONBLOCK: 2048,
        S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000,
        S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000,
        S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
        S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
        S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
        S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,
        UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1,
        UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2,
        UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
    };

    // ---- streaming -----------------------------------------------------
    var EventEmitter = require('events');
    var Buffer = require('buffer').Buffer;

    // No event loop in the sandbox: stream emission has to be triggered
    // synchronously by something. We adopt the convention that emission
    // fires when the first `data` listener is added (or when the user
    // calls `.resume()` explicitly). Attach `end` / `error` listeners
    // *before* attaching `data`.
    function createReadStream(path, options) {
        options = options || {};
        var chunkSize = options.highWaterMark || 64 * 1024;
        var startOffset = options.start || 0;
        var endOffset = options.end;  // inclusive per Node semantics
        var encoding = options.encoding || null;

        var ee = new EventEmitter();
        var pumped = false;

        function pump() {
            if (pumped) return;
            pumped = true;
            try {
                var sizeFn = globalThis.__host_fs_size;
                if (typeof sizeFn !== 'function') throw new Error('fs.createReadStream: not available');
                var sizeRaw = sizeFn(String(path));
                if (typeof sizeRaw === 'string' && sizeRaw.indexOf('__HOST_ERR__:') === 0) {
                    throw new Error('fs: ' + sizeRaw.slice('__HOST_ERR__:'.length));
                }
                var total = parseInt(sizeRaw, 10);
                var endIdx = (endOffset === undefined || endOffset >= total) ? total - 1 : endOffset;

                var off = startOffset;
                var readFn = globalThis.__host_fs_read_chunk;
                if (typeof readFn !== 'function') throw new Error('fs.createReadStream: chunk reader not available');
                while (off <= endIdx) {
                    var want = Math.min(chunkSize, endIdx - off + 1);
                    var raw = readFn(String(path), off, want);
                    if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                        throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
                    }
                    var buf = Buffer.from(raw, 'base64');
                    if (buf.length === 0) break;
                    var emitted = encoding ? buf.toString(encoding) : buf;
                    ee.emit('data', emitted);
                    off += buf.length;
                }
                ee.emit('end');
                ee.emit('close');
            } catch (e) {
                ee.emit('error', e);
            }
        }

        var origOn = ee.on.bind(ee);
        ee.on = function(name, fn) {
            origOn(name, fn);
            if (name === 'data') pump();
            return ee;
        };
        ee.addListener = ee.on;
        ee.resume = pump;
        ee.pipe = function(dest) {
            ee.on('end',  function() { if (dest.end) dest.end(); });
            ee.on('data', function(chunk) { dest.write(chunk); });
            return dest;
        };
        return ee;
    }

    function createWriteStream(path, options) {
        options = options || {};
        var off = options.start || 0;
        // Default flags='w' → overwrite, matching Node. Delete first so
        // existing file contents past the written region don't linger.
        var truncateFirst = (options.flags === undefined) || options.flags === 'w';
        var ee = new EventEmitter();
        var writeFn = globalThis.__host_fs_write_chunk;
        if (typeof writeFn !== 'function') {
            throw new Error('fs.createWriteStream: not available');
        }
        if (truncateFirst && typeof globalThis.__host_fs_unlink_sync === 'function') {
            // Ignore errors — file may not exist.
            try { globalThis.__host_fs_unlink_sync(String(path)); } catch (_) {}
        }
        ee.write = function(chunk) {
            try {
                var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
                var raw = writeFn(String(path), off, buf.toString('base64'));
                if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                    throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
                }
                off += buf.length;
                return true;
            } catch (e) { ee.emit('error', e); return false; }
        };
        ee.end = function(chunk) {
            if (chunk) ee.write(chunk);
            ee.emit('finish');
            ee.emit('close');
        };
        return ee;
    }

    exports.createReadStream  = createReadStream;
    exports.createWriteStream = createWriteStream;

    // ----- fd-based sync API ----------------------------------------
    //
    // tar's Unpack writes file contents via the classic Node
    // `openSync` / `writeSync` / `closeSync` triple. We don't have
    // real OS-level fds inside the wasm sandbox; instead, we keep a
    // per-process JS-side fd table that maps a small integer to
    // `{ path, offset }`. Writes go through `__host_fs_write_chunk`
    // (the same entry `createWriteStream` uses) — which means npm's
    // tarball extraction works end-to-end without us needing a real
    // libc-shaped fd surface.
    if (!globalThis.__ab_fd_table) globalThis.__ab_fd_table = { next: 3, slots: {} };
    var FDS = globalThis.__ab_fd_table;

    function _allocFd(slot) {
        var n = FDS.next++;
        FDS.slots[n] = slot;
        return n;
    }
    function _fdSlot(fd) {
        var s = FDS.slots[fd];
        if (!s) {
            var e = new Error('EBADF: bad file descriptor');
            e.code = 'EBADF';
            e.errno = -9;
            throw e;
        }
        return s;
    }

    exports.openSync = function(path, flags, _mode) {
        flags = flags || 'r';
        var pathStr = String(path);
        // Truncate when opening with `w` or `wx`. We don't model
        // every flag; `r`/`r+`/`a`/`w`/`wx` are the realistic set.
        var truncate = false;
        if (typeof flags === 'string') {
            if (flags === 'w' || flags === 'wx' || flags === 'w+' || flags === 'wx+') truncate = true;
        } else if (typeof flags === 'number') {
            // O_TRUNC = 0x200
            if (flags & 0x200) truncate = true;
        }
        if (truncate && typeof globalThis.__host_fs_unlink_sync === 'function') {
            try { globalThis.__host_fs_unlink_sync(pathStr); } catch (_) {}
        }
        return _allocFd({ path: pathStr, offset: 0, flags: flags });
    };

    exports.openAsBlob && (exports.openAsBlob = exports.openAsBlob); // keep ref
    exports.closeSync = function(fd) {
        var slot = FDS.slots[fd];
        if (!slot) {
            var e = new Error('EBADF: bad file descriptor');
            e.code = 'EBADF';
            throw e;
        }
        delete FDS.slots[fd];
    };

    // writeSync(fd, buffer[, offset[, length[, position]]])
    // Accepts both Buffer/Uint8Array and string forms.
    exports.writeSync = function(fd, buffer, offset, length, position) {
        var slot = _fdSlot(fd);
        var data;
        if (typeof buffer === 'string') {
            // writeSync(fd, string, position, encoding)
            // — string variant: offset arg becomes the position.
            var enc = (length && typeof length === 'string') ? length : 'utf8';
            data = Buffer.from(buffer, enc);
            if (typeof offset === 'number') position = offset;
            offset = 0;
            length = data.length;
        } else {
            offset = offset || 0;
            length = (typeof length === 'number') ? length : (buffer.length - offset);
            data = (Buffer.isBuffer(buffer) && offset === 0 && length === buffer.length)
                ? buffer
                : Buffer.from(buffer.buffer || buffer, (buffer.byteOffset || 0) + offset, length);
        }
        var pos = (typeof position === 'number') ? position : slot.offset;
        var writeFn = globalThis.__host_fs_write_chunk;
        if (typeof writeFn !== 'function') {
            var e = new Error('writeSync: __host_fs_write_chunk not available');
            e.code = 'ENOSYS';
            throw e;
        }
        var raw = writeFn(slot.path, pos, data.toString('base64'));
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var e2 = new Error('fs.writeSync: ' + raw.slice('__HOST_ERR__:'.length));
            throw e2;
        }
        if (typeof position !== 'number') slot.offset = pos + length;
        return length;
    };

    // readSync(fd, buffer, offset, length, position)
    exports.readSync = function(fd, buffer, offset, length, position) {
        var slot = _fdSlot(fd);
        var pos = (typeof position === 'number' && position !== null) ? position : slot.offset;
        var readFn = globalThis.__host_fs_read_chunk;
        if (typeof readFn !== 'function') {
            var e = new Error('readSync: __host_fs_read_chunk not available');
            e.code = 'ENOSYS';
            throw e;
        }
        var raw = readFn(slot.path, pos, length);
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var e2 = new Error('fs.readSync: ' + raw.slice('__HOST_ERR__:'.length));
            throw e2;
        }
        var got = Buffer.from(raw, 'base64');
        var n = Math.min(got.length, length);
        got.copy(buffer, offset, 0, n);
        if (typeof position !== 'number' || position === null) slot.offset = pos + n;
        return n;
    };

    // fstatSync(fd) — same shape as statSync, keyed by fd.
    exports.fstatSync = function(fd) {
        var slot = _fdSlot(fd);
        return exports.statSync(slot.path);
    };

    // fsyncSync / fdatasyncSync / ftruncateSync — best-effort no-ops.
    // Sandbox writes go through the host bridge synchronously already;
    // there's no buffer to flush.
    exports.fsyncSync     = function(_fd) {};
    exports.fdatasyncSync = function(_fd) {};
    exports.ftruncateSync = function(fd, len) {
        var slot = _fdSlot(fd);
        len = len || 0;
        var existing;
        try { existing = exports.readFileSync(slot.path); }
        catch (_) { existing = Buffer.alloc(0); }
        var buf = Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing));
        var truncated = buf.slice(0, len);
        exports.writeFileSync(slot.path, truncated);
    };

    // Callback-style equivalents — auto-wrap the sync versions on a
    // microtask. The CALLBACK_NAMES forEach below already does this
    // for the existing entries; we add fd-shaped names here so they
    // get the same treatment without polluting that list.
    function _asyncWrap(syncName) {
        return function() {
            var args = [].slice.call(arguments);
            var cb = (typeof args[args.length - 1] === 'function') ? args.pop() : null;
            Promise.resolve().then(function() {
                try {
                    var r = exports[syncName].apply(null, args);
                    if (cb) cb(null, r);
                } catch (e) {
                    if (cb) cb(e);
                }
            });
        };
    }
    exports.open       = _asyncWrap('openSync');
    exports.close      = _asyncWrap('closeSync');
    // write(fd, buffer, ...rest, cb) — Node calls back with
    // `(err, bytesWritten, buffer)`. Keep that shape.
    exports.write = function(fd, buffer, offset, length, position, cb) {
        // Tolerate the (fd, buffer, cb) shorthand and
        // (fd, string, position, encoding, cb) string variant.
        if (typeof offset === 'function') { cb = offset; offset = undefined; }
        if (typeof length === 'function') { cb = length; length = undefined; }
        if (typeof position === 'function') { cb = position; position = undefined; }
        Promise.resolve().then(function() {
            try {
                var n = exports.writeSync(fd, buffer, offset, length, position);
                if (cb) cb(null, n, buffer);
            } catch (e) {
                if (cb) cb(e);
            }
        });
    };
    exports.read = function(fd, buffer, offset, length, position, cb) {
        Promise.resolve().then(function() {
            try {
                var n = exports.readSync(fd, buffer, offset, length, position);
                if (cb) cb(null, n, buffer);
            } catch (e) {
                if (cb) cb(e);
            }
        });
    };
    exports.fstat       = _asyncWrap('fstatSync');
    exports.fsync       = _asyncWrap('fsyncSync');
    exports.fdatasync   = _asyncWrap('fdatasyncSync');
    exports.ftruncate   = _asyncWrap('ftruncateSync');

    // ----- realpath ---------------------------------------------------

    exports.realpathSync = function(path) {
        var fn = requireHost('realpath_sync');
        return checkHostError(fn(String(path)), 'realpath');
    };
    exports.realpath = function(path, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        var self = exports;
        Promise.resolve().then(function() {
            try { cb(null, self.realpathSync(path)); }
            catch (e) { cb(e); }
        });
    };
    exports.realpath.native = exports.realpath;

    // ----- cp (recursive copy) ----------------------------------------

    exports.cpSync = function(src, dst, options) {
        var fn = requireHost('cp');
        var force = !!(options && options.force);
        // Node's default is force: true; match that.
        if (options === undefined || (options && options.force === undefined)) {
            force = true;
        }
        checkHostError(fn(String(src), String(dst), force), 'cp');
    };
    exports.cp = function(src, dst, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { exports.cpSync(src, dst, options); cb(null); }
            catch (e) { cb(e); }
        });
    };

    // ----- opendir / Dir / Dirent -------------------------------------

    function Dirent(entry, parentPath) {
        this.name = entry.name;
        this.parentPath = parentPath;
        this.path = parentPath; // legacy alias
        this._isFile = !!entry.isFile;
        this._isDir = !!entry.isDir;
        this._isSymlink = !!entry.isSymlink;
    }
    Dirent.prototype.isFile = function() { return this._isFile; };
    Dirent.prototype.isDirectory = function() { return this._isDir; };
    Dirent.prototype.isSymbolicLink = function() { return this._isSymlink; };
    Dirent.prototype.isBlockDevice = function() { return false; };
    Dirent.prototype.isCharacterDevice = function() { return false; };
    Dirent.prototype.isFIFO = function() { return false; };
    Dirent.prototype.isSocket = function() { return false; };

    function rawDirEntries(path) {
        var fn = requireHost('opendir_sync');
        var json = checkHostError(fn(String(path)), 'opendir');
        try {
            var arr = JSON.parse(json);
            if (!Array.isArray(arr)) throw new Error('non-array');
            return arr;
        } catch (e) {
            var err = new Error('fs.opendir: malformed host response: ' + e.message);
            err.code = 'EOTHER';
            throw err;
        }
    }

    function Dir(path, entries) {
        this.path = path;
        this._entries = entries;
        this._idx = 0;
        this._closed = false;
    }
    Dir.prototype.read = function(cb) {
        var self = this;
        if (cb) {
            Promise.resolve().then(function() {
                try {
                    var ent = self._readNextSync();
                    cb(null, ent);
                } catch (e) { cb(e); }
            });
            return;
        }
        return new Promise(function(resolve, reject) {
            try { resolve(self._readNextSync()); }
            catch (e) { reject(e); }
        });
    };
    Dir.prototype.readSync = function() { return this._readNextSync(); };
    Dir.prototype._readNextSync = function() {
        if (this._closed) {
            var err = new Error('fs.Dir: read after close');
            err.code = 'ERR_DIR_CLOSED';
            throw err;
        }
        if (this._idx >= this._entries.length) return null;
        return new Dirent(this._entries[this._idx++], this.path);
    };
    Dir.prototype.close = function(cb) {
        this._closed = true;
        if (cb) { Promise.resolve().then(function() { cb(null); }); return; }
        return Promise.resolve();
    };
    Dir.prototype.closeSync = function() { this._closed = true; };
    // async iterator
    Dir.prototype[Symbol.asyncIterator] = function() {
        var self = this;
        return {
            next: function() {
                return self.read().then(function(ent) {
                    if (!ent) { self.close(); return { value: undefined, done: true }; }
                    return { value: ent, done: false };
                });
            },
            return: function() { return self.close().then(function() { return { value: undefined, done: true }; }); },
        };
    };

    exports.opendirSync = function(path, _options) {
        return new Dir(String(path), rawDirEntries(path));
    };
    exports.opendir = function(path, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.opendirSync(path)); }
            catch (e) { cb(e); }
        });
    };
    exports.Dir = Dir;
    exports.Dirent = Dirent;

    // Augment readdirSync with `withFileTypes` and `recursive` support
    // (Node 22+). The existing overload returns a plain string array;
    // opendir_sync gives us typed entries. `recursive: true` walks
    // the tree depth-first and returns paths relative to `path`.
    var _readdirSyncBasic = exports.readdirSync;
    exports.readdirSync = function(path, options) {
        var recursive = !!(options && options.recursive);
        var withFileTypes = !!(options && options.withFileTypes);
        var encoding = options && options.encoding;
        if (recursive) {
            // DFS walk. `parentPath` on Dirent is set to the dir we
            // listed (Node 20+ contract); names are relative to `path`.
            var rootStr = String(path);
            var out = [];
            var stack = [{ dir: rootStr, prefix: '' }];
            while (stack.length) {
                var top = stack.pop();
                var children;
                try { children = rawDirEntries(top.dir); }
                catch (_) { children = []; }
                for (var i = 0; i < children.length; i++) {
                    var c = children[i];
                    var rel = top.prefix ? (top.prefix + '/' + c.name) : c.name;
                    var abs = top.dir + '/' + c.name;
                    if (withFileTypes) {
                        var d = new Dirent(c, top.dir);
                        // Node-26 path field — the absolute joined path.
                        d.path = abs;
                        d.parentPath = top.dir;
                        out.push(d);
                    } else {
                        out.push(rel);
                    }
                    if (c.isDir) {
                        stack.push({ dir: abs, prefix: rel });
                    }
                }
            }
            return out;
        }
        if (withFileTypes) {
            var entries = rawDirEntries(path);
            var pp = String(path);
            return entries.map(function(e) {
                var d = new Dirent(e, pp);
                d.parentPath = pp;
                d.path = pp + '/' + e.name;
                return d;
            });
        }
        var raw = _readdirSyncBasic(path);
        if (encoding === 'buffer') {
            return raw.map(function(n) { return Buffer.from(String(n)); });
        }
        return raw;
    };

    // ----- watch (polling-based FSWatcher) ----------------------------

    var EventEmitter = require('events').EventEmitter;

    function FSWatcher(path, options) {
        EventEmitter.call(this);
        this._path = String(path);
        this._interval = (options && options.interval) || 250;
        this._closed = false;
        this._tick = this._tick.bind(this);
        this._scheduleNext();
    }
    FSWatcher.prototype = Object.create(EventEmitter.prototype);
    FSWatcher.prototype.constructor = FSWatcher;

    FSWatcher.prototype._scheduleNext = function() {
        if (this._closed) return;
        // Use setTimeout(0) so the first poll happens off the current
        // tick — matches Node's behavior of registering the watcher
        // synchronously and emitting events asynchronously.
        if (typeof setTimeout === 'function') {
            setTimeout(this._tick, 0);
        } else {
            // Fallback: microtask. Won't actually deliver host-watched
            // changes (host_fs_watch_poll blocks for `interval`ms), but
            // at least the watcher API surface works in environments
            // without a timer host (`burn` library mode).
            Promise.resolve().then(this._tick);
        }
    };

    FSWatcher.prototype._tick = function() {
        if (this._closed) return;
        var self = this;
        var fn;
        try { fn = requireHost('watch_poll'); }
        catch (e) {
            this.emit('error', e);
            this._closed = true;
            return;
        }
        var raw;
        try {
            raw = fn(self._path, self._interval);
        } catch (e) {
            this.emit('error', e);
            return this._scheduleNext();
        }
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var msg = raw.slice('__HOST_ERR__:'.length);
            var err = new Error('fs.watch: ' + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
            this.emit('error', err);
            this._closed = true;
            return;
        }
        try {
            var events = JSON.parse(raw);
            if (Array.isArray(events)) {
                for (var i = 0; i < events.length; i++) {
                    var ev = events[i];
                    self.emit('change', ev.kind, ev.filename);
                }
            }
        } catch (_) {}
        this._scheduleNext();
    };

    FSWatcher.prototype.close = function() {
        this._closed = true;
        try { this.emit('close'); } catch (_) {}
    };
    FSWatcher.prototype.ref = function() { return this; };
    FSWatcher.prototype.unref = function() { return this; };

    exports.FSWatcher = FSWatcher;
    exports.watch = function(path, options, listener) {
        if (typeof options === 'function') { listener = options; options = undefined; }
        var w = new FSWatcher(path, options);
        if (typeof listener === 'function') w.on('change', listener);
        return w;
    };

    // ----- FileHandle (fs.promises.open) ------------------------------

    function FileHandle(path, flags) {
        this._path = String(path);
        this._flags = flags || 'r';
        this._closed = false;
    }
    Object.defineProperty(FileHandle.prototype, 'fd', {
        // Node's fd is a small integer; we don't expose a real fd from
        // the WASM sandbox. Surface the path-keyed pseudo-fd so caller
        // code that just uses `.fd` for logging won't crash.
        get: function() { return -1; },
    });

    function _checkOpen(fh) {
        if (fh._closed) {
            var e = new Error('FileHandle: already closed');
            e.code = 'EBADF';
            throw e;
        }
    }

    FileHandle.prototype.read = function(buffer, offset, length, position) {
        _checkOpen(this);
        var Buffer = bufferModule();
        var path = this._path;
        // node-style positional or options-object call
        if (buffer && typeof buffer === 'object' && !Buffer.isBuffer(buffer)
            && !(buffer instanceof Uint8Array)) {
            var opts = buffer;
            buffer = opts.buffer;
            offset = opts.offset;
            length = opts.length;
            position = opts.position;
        }
        offset = offset | 0;
        length = (length === undefined || length === null) ? buffer.length - offset : length | 0;
        position = (position === undefined || position === null) ? 0 : position;
        return new Promise(function(resolve, reject) {
            try {
                var fn = requireHost('read_chunk');
                // host returns base64 encoded bytes
                var b64 = checkHostError(fn(path, position, length), 'FileHandle.read');
                var chunk = Buffer.from(b64, 'base64');
                var n = Math.min(chunk.length, length);
                for (var i = 0; i < n; i++) buffer[offset + i] = chunk[i];
                resolve({ bytesRead: n, buffer: buffer });
            } catch (e) { reject(e); }
        });
    };

    FileHandle.prototype.write = function(data, positionOrOffset, lengthOrEncoding, position) {
        _checkOpen(this);
        var Buffer = bufferModule();
        var path = this._path;
        var bytes;
        var pos;
        if (typeof data === 'string') {
            // (string, position, encoding)
            bytes = Buffer.from(data, lengthOrEncoding || 'utf8');
            pos = (positionOrOffset === undefined || positionOrOffset === null) ? 0 : positionOrOffset;
        } else {
            // (buffer, offset, length, position)
            var offset = positionOrOffset | 0;
            var length = (lengthOrEncoding === undefined || lengthOrEncoding === null)
                ? data.length - offset : lengthOrEncoding | 0;
            bytes = Buffer.from(data.slice(offset, offset + length));
            pos = (position === undefined || position === null) ? 0 : position;
        }
        return new Promise(function(resolve, reject) {
            try {
                var fn = requireHost('write_chunk');
                checkHostError(fn(path, pos, bytes.toString('base64')), 'FileHandle.write');
                resolve({ bytesWritten: bytes.length, buffer: data });
            } catch (e) { reject(e); }
        });
    };

    FileHandle.prototype.readFile = function(options) {
        _checkOpen(this);
        return Promise.resolve(exports.readFileSync(this._path, options));
    };

    FileHandle.prototype.writeFile = function(data, options) {
        _checkOpen(this);
        return Promise.resolve(exports.writeFileSync(this._path, data, options));
    };

    FileHandle.prototype.stat = function() {
        _checkOpen(this);
        return Promise.resolve(exports.statSync(this._path));
    };

    FileHandle.prototype.truncate = function(len) {
        _checkOpen(this);
        len = len | 0;
        var Buffer = bufferModule();
        var existing;
        try { existing = exports.readFileSync(this._path); }
        catch (e) { return Promise.reject(e); }
        var truncated = Buffer.alloc(len);
        existing.copy(truncated, 0, 0, Math.min(existing.length, len));
        try { exports.writeFileSync(this._path, truncated); return Promise.resolve(); }
        catch (e) { return Promise.reject(e); }
    };

    FileHandle.prototype.close = function() {
        this._closed = true;
        return Promise.resolve();
    };

    FileHandle.prototype[Symbol.asyncDispose] = function() { return this.close(); };

    // ----- fs.promises ------------------------------------------------

    exports.promises = {};
    // Auto-promisify every sync function that has a 1:1 promise twin.
    // Node 26 keeps these stable; if the upstream surface grows,
    // adding a new entry here is enough.
    [
        'readFile','writeFile','stat','lstat','readdir','mkdir',
        'unlink','rename','readlink','access','chmod','fchmod','lchmod',
        'chown','fchown','lchown','utimes','lutimes','futimes','link',
        'symlink','copyFile','appendFile','truncate','mkdtemp','rmdir','rm',
    ].forEach(function(name) {
        exports.promises[name] = function() {
            var args = [].slice.call(arguments);
            var syncName = name + 'Sync';
            return new Promise(function(resolve, reject) {
                try { resolve(exports[syncName].apply(null, args)); }
                catch (e) { reject(e); }
            });
        };
    });

    // New promise-only entries.
    exports.promises.realpath = function(path) {
        return new Promise(function(resolve, reject) {
            try { resolve(exports.realpathSync(path)); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.cp = function(src, dst, options) {
        return new Promise(function(resolve, reject) {
            try { exports.cpSync(src, dst, options); resolve(); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.opendir = function(path, options) {
        return new Promise(function(resolve, reject) {
            try { resolve(exports.opendirSync(path, options)); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.watch = function(path, options) {
        // Async-iterable wrapper around FSWatcher.
        var w = new FSWatcher(path, options);
        var queue = [];
        var pending = null;
        w.on('change', function(eventType, filename) {
            if (pending) {
                var p = pending; pending = null;
                p({ value: { eventType: eventType, filename: filename }, done: false });
            } else {
                queue.push({ eventType: eventType, filename: filename });
            }
        });
        w.on('error', function(err) {
            if (pending) { var p = pending; pending = null; p(Promise.reject(err)); }
        });
        return {
            [Symbol.asyncIterator]: function() { return this; },
            next: function() {
                if (queue.length) {
                    return Promise.resolve({ value: queue.shift(), done: false });
                }
                return new Promise(function(resolve) { pending = resolve; });
            },
            return: function() {
                w.close();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    };
    exports.promises.open = function(path, flags, _mode) {
        return new Promise(function(resolve, reject) {
            try {
                // Validate path is reachable; statSync will throw ENOENT
                // for read-only opens and give us a clean error path.
                if (typeof flags === 'string' && flags.indexOf('r') === 0) {
                    exports.statSync(path);
                }
                resolve(new FileHandle(path, flags));
            } catch (e) { reject(e); }
        });
    };
    exports.FileHandle = FileHandle;

    // Node 22+ added `fs.glob` / `fs.globSync` / `fs.promises.glob`
    // for pattern-matched directory walks. We don't pull in a full
    // micromatch engine; libraries that genuinely need glob semantics
    // import the `glob` npm package, which works on top of
    // `readdirSync` / `lstatSync`. The shim returns the bare-leaf
    // shape (no globs interpreted) so callers that pass a literal
    // path get the right answer and pattern callers fall through to
    // the empty-result path matching Node's no-match behavior.
    function _matchPattern(pattern, root) {
        var p = String(pattern);
        // Literal path passthrough — no `*` / `?` / `[` markers.
        if (!/[*?[]/.test(p)) {
            try {
                exports.statSync(p);
                return [p];
            } catch (_) { return []; }
        }
        // For pattern globs, walk the directory and return entries
        // whose name matches the trailing star-segment. Cheap but
        // correct enough for the npm log-cleanup `*.log` case.
        var slash = p.lastIndexOf('/');
        var dir = slash >= 0 ? p.slice(0, slash) : (root || '.');
        var rest = slash >= 0 ? p.slice(slash + 1) : p;
        var re = new RegExp('^' + rest
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$');
        var entries;
        try { entries = exports.readdirSync(dir); }
        catch (_) { return []; }
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            if (re.test(entries[i])) out.push(dir + '/' + entries[i]);
        }
        return out;
    }
    exports.globSync = function(pattern, options) {
        var pats = Array.isArray(pattern) ? pattern : [pattern];
        var cwd = (options && options.cwd) ? String(options.cwd) : (typeof globalThis.__host_cwd === 'string' ? globalThis.__host_cwd : '.');
        var seen = {};
        var out = [];
        for (var i = 0; i < pats.length; i++) {
            var matches = _matchPattern(pats[i], cwd);
            for (var j = 0; j < matches.length; j++) {
                if (!seen[matches[j]]) { seen[matches[j]] = true; out.push(matches[j]); }
            }
        }
        return out;
    };
    exports.glob = function(pattern, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.globSync(pattern, options)); }
            catch (e) { cb(e); }
        });
    };
    exports.promises.glob = function(pattern, options) {
        return new Promise(function(resolve, reject) {
            try { resolve(exports.globSync(pattern, options)); }
            catch (e) { reject(e); }
        });
    };

    // Callback-style entry points for every sync function. Node ships
    // both shapes for the entire fs surface; libraries (path-scurry,
    // chokidar, npm's lockfile cleanup) call the callback form
    // directly. We auto-wrap each `*Sync` in an async-callback shim
    // — the result fires on a microtask so handlers attached after
    // dispatch see it (matches Node's CB-after-IO contract).
    var CALLBACK_NAMES = [
        'readFile','writeFile','appendFile','stat','lstat','fstat','exists',
        'readdir','mkdir','rmdir','rm','unlink','rename','readlink','access',
        'chmod','fchmod','lchmod','chown','fchown','lchown','utimes','lutimes',
        'futimes','link','symlink','copyFile','truncate','mkdtemp','realpath',
    ];
    CALLBACK_NAMES.forEach(function(name) {
        if (typeof exports[name] === 'function') return; // already defined (e.g. realpath)
        var syncName = name + 'Sync';
        if (typeof exports[syncName] !== 'function') return; // sync entry missing
        exports[name] = function() {
            var args = [].slice.call(arguments);
            var cb = (typeof args[args.length - 1] === 'function') ? args.pop() : null;
            // Schedule on a microtask so the cb fires after the
            // calling expression returns — matches Node's
            // async-callback contract for code like:
            //   `const r = fs.readdir(path, opts, cb); /* … */`.
            Promise.resolve().then(function() {
                try {
                    var r = exports[syncName].apply(null, args);
                    if (cb) cb(null, r);
                } catch (e) {
                    if (cb) cb(e);
                }
            });
        };
    });
    // existsSync's callback form has a single-arg shape (no err).
    exports.exists = function(path, cb) {
        Promise.resolve().then(function() {
            if (cb) cb(exports.existsSync(path));
        });
    };

    // `fs.writev` / `writevSync` — vectored writes. fs-minipass
    // gates a libuv-binding fallback on `!fs.writev`, so providing
    // even a sequential implementation skips the binding path
    // entirely. The fd is the path-keyed handle from FileHandle /
    // openSync; we serialise the iovec by concatenating buffers
    // and dispatching one write per call. `position === null` means
    // "current position" (Node default); a numeric value seeks first.
    exports.writevSync = function(fd, buffers, position) {
        var total = 0;
        var pos = (typeof position === 'number') ? position : 0;
        // FileHandle stores its path on `_path`; for raw numeric fds
        // we don't have a path mapping and fall through to sync write
        // via the chunk bridge.
        var path = (fd && typeof fd === 'object' && fd._path) ? fd._path : String(fd);
        var writeFn = globalThis.__host_fs_write_chunk;
        if (typeof writeFn !== 'function') {
            throw new Error('fs.writev: not available');
        }
        for (var i = 0; i < buffers.length; i++) {
            var b = buffers[i];
            var bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
            var raw = writeFn(path, pos, bb.toString('base64'));
            if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
            }
            pos += bb.length;
            total += bb.length;
        }
        return total;
    };
    exports.writev = function(fd, buffers, position, cb) {
        if (typeof position === 'function') { cb = position; position = null; }
        Promise.resolve().then(function() {
            try {
                var n = exports.writevSync(fd, buffers, position);
                if (cb) cb(null, n, buffers);
            } catch (e) { if (cb) cb(e); }
        });
    };
    // `fs.readv` — gather-read vectored. Same posture: serialise.
    exports.readvSync = function(fd, buffers, position) {
        var total = 0;
        var pos = (typeof position === 'number') ? position : 0;
        var path = (fd && typeof fd === 'object' && fd._path) ? fd._path : String(fd);
        var readFn = globalThis.__host_fs_read_chunk;
        if (typeof readFn !== 'function') {
            throw new Error('fs.readv: not available');
        }
        for (var i = 0; i < buffers.length; i++) {
            var b = buffers[i];
            var want = b.length;
            var raw = readFn(path, pos, want);
            if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
            }
            var got = Buffer.from(raw, 'base64');
            got.copy(b, 0, 0, Math.min(got.length, want));
            pos += got.length;
            total += got.length;
            if (got.length < want) break;
        }
        return total;
    };
    exports.readv = function(fd, buffers, position, cb) {
        if (typeof position === 'function') { cb = position; position = null; }
        Promise.resolve().then(function() {
            try {
                var n = exports.readvSync(fd, buffers, position);
                if (cb) cb(null, n, buffers);
            } catch (e) { if (cb) cb(e); }
        });
    };

    // `fs.openAsBlob` — Node 19+. Returns a Blob backed by the
    // file's content. Sandbox-safe: we read eagerly via the host
    // bridge (no streaming Blob support yet, but the shape is
    // there for libraries that probe).
    exports.openAsBlob = function(path, _options) {
        var data = exports.readFileSync(path);
        if (typeof Blob === 'function') {
            return Promise.resolve(new Blob([data]));
        }
        // Pre-Blob runtimes — return a minimal blob-shaped object.
        var bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        return Promise.resolve({
            size: bytes.length,
            type: '',
            arrayBuffer: function() { return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); },
            text:        function() { return Promise.resolve(bytes.toString('utf8')); },
            slice:       function() { return this; },
        });
    };
});

// ---- host.js ----
// afterburner:host — embedder-facing hooks. Not part of Node's standard
// surface; lives under the `afterburner:` package namespace. The host
// wires a `HostContext` trait implementation on the combustor side
// that answers `readColumn`/`emitRow`/`getEnv`; if no context is
// attached, `readColumn` returns `[]`, `emitRow` is a no-op, and
// `getEnv` returns `undefined`.

__register_module('afterburner:host', function(module, exports, require) {

    exports.readColumn = function(name) {
        var fn = globalThis.__host_read_column;
        if (typeof fn !== 'function') return [];
        var raw = fn(String(name));
        try { return JSON.parse(raw); } catch (_) { return []; }
    };

    exports.emitRow = function(row) {
        var fn = globalThis.__host_emit_row;
        if (typeof fn !== 'function') return;
        var json;
        try { json = JSON.stringify(row); }
        catch (e) { throw new TypeError('emitRow: row must be JSON-serializable: ' + e.message); }
        fn(json);
    };

    exports.getEnv = function(key) {
        var fn = globalThis.__host_get_env;
        if (typeof fn !== 'function') return undefined;
        var v = fn(String(key));
        return (v === null || v === undefined) ? undefined : v;
    };
});

// ---- http.js ----
// http / https — outbound `request`/`get` + server-side
// `createServer` + IncomingMessage / ServerResponse.
//
// Outbound is a synchronous wrapper around `__host_http_request`.
// Server-side threads through the host's daemon-mode HTTP
// coordinator (`__host_http_listen` + `__host_http_reply`) — when
// user code calls `http.createServer(cb).listen(port)`, we register
// `cb` on `globalThis.__ab_http_handlers[server_id]`, and the
// plugin's `daemon_event` mode dispatches matching incoming
// requests back through it.

function __plenum_install_http(moduleName) {
    __register_module(moduleName, function(module, exports, require) {
        var EventEmitter = require('events');

        // -------- outbound request / get --------------------------------

        function requestImpl(opts, cb) {
            if (typeof globalThis.__host_http_request !== 'function'
                && typeof globalThis.__host_http_request_async !== 'function') {
                throw new Error("Permission denied: http.request is not available");
            }
            var url;
            if (typeof opts === 'string') {
                url = opts;
            } else if (opts && typeof opts.url === 'string') {
                url = opts.url;
            } else {
                url = (opts.protocol || 'http:') + '//' + (opts.host || opts.hostname)
                    + (opts.port ? ':' + opts.port : '') + (opts.path || '/');
            }
            var method = (opts && opts.method) || 'GET';
            var body = opts && opts.body;

            // Prefer the async path when a daemon is attached. The
            // sync function still runs the request inline on the wasm
            // thread; the async one dispatches onto Tokio and the
            // shard event loop fans the response back through a
            // `daemon-event`. Real Node-style: caller awaits a Promise
            // that resolves when the host signals completion, instead
            // of blocking the wasm thread for the full round-trip.
            var asyncFn = globalThis.__host_http_request_async;
            var asyncReqId = -1;
            var resultPromise = null;
            if (typeof asyncFn === 'function') {
                try {
                    var rid = asyncFn(method, url, body || null);
                    if (typeof rid === 'bigint') rid = Number(rid);
                    if (typeof rid === 'number' && rid > 0) {
                        asyncReqId = rid;
                        resultPromise = new Promise(function(resolve) {
                            if (!globalThis.__ab_http_pending) globalThis.__ab_http_pending = {};
                            globalThis.__ab_http_pending[asyncReqId] = { resolve: resolve };
                        });
                    }
                } catch (_) {
                    // fall through to sync path
                }
            }

            // The whole `result → resp → emit` pipeline is wrapped in
            // `buildAndDispatch` so the same code path covers both
            // the sync and async flavours. Sync calls it immediately
            // with the just-fetched result; async chains it onto the
            // Promise the daemon resolves when the response arrives.
            var Buffer = require('buffer').Buffer;
            var EventEmitter = require('events');
            var req = Object.create(EventEmitter.prototype);
            EventEmitter.call(req);
            req.end          = function() { return req; };
            req.write        = function() { return true; };
            req.setHeader    = function() { return req; };
            req.getHeader    = function() {};
            req.removeHeader = function() {};
            req.setTimeout   = function() { return req; };
            req.destroy      = function() { return req; };
            req.abort        = function() { return req; };
            req.flushHeaders = function() { return req; };
            req.socket = { setKeepAlive: function() {}, setTimeout: function() {}, unref: function() {}, ref: function() {} };
            req.connection = req.socket;

            function buildAndDispatch(result) {
                if (typeof result.body === 'string' && result.body.indexOf('__HOST_ERR__:') === 0) {
                    var hostErr = new Error("http: " + result.body.slice('__HOST_ERR__:'.length));
                    if (hostErr.message.toLowerCase().indexOf('permission denied') !== -1) hostErr.code = 'EACCES';
                    Promise.resolve().then(function() {
                        try { req.emit('socket', req.socket); } catch (_) {}
                        req.emit('error', hostErr);
                    });
                    return req;
                }
                if (typeof result.error === 'string' && result.error.length > 0) {
                    var hostErr2 = new Error("http: " + result.error);
                    Promise.resolve().then(function() {
                        try { req.emit('socket', req.socket); } catch (_) {}
                        req.emit('error', hostErr2);
                    });
                    return req;
                }
                var resp = makeResp(result, method, url);
                Promise.resolve().then(function() {
                    try { req.emit('socket', req.socket); } catch (_) {}
                    if (cb) {
                        try { cb(resp); } catch (e) { req.emit('error', e); return; }
                    }
                    req.emit('response', resp);
                });
                return req;
            }

            if (asyncReqId > 0) {
                resultPromise.then(buildAndDispatch);
                return req;
            }
            return buildAndDispatch(result);
        }

        // makeResp / IncomingMessage factory — extracted so both the
        // sync and async dispatch paths share one shape. `result` is
        // the host envelope: `{status, headers, body, body_b64,
        // error?}`. Returns a Node-shaped IncomingMessage with the
        // full readable-stream surface our consumers (npm, undici,
        // node-fetch / minipass-fetch) require.
        function makeResp(result, method, url) {
            // Shape the response like a Node IncomingMessage with a
            // working EventEmitter contract plus the readable-stream
            // pieces user code commonly touches: `.resume()`,
            // `.pause()`, `.pipe(dest)`, `.read()`, async iteration.
            // The body is materialised eagerly by the host bridge — we
            // just have to stage it through the listener queue so user
            // code that registers handlers AFTER the cb fires (the
            // normal Node pattern) still sees `data` + `end`. We
            // prefer the host's base64 body when it is sent (binary-
            // safe, what npm tar / pacote requires) and fall back to
            // the lossy UTF-8 body for legacy callers that read text.
            var bodyBytes = null;
            if (typeof result.body_b64 === 'string') {
                try { bodyBytes = Buffer.from(result.body_b64, 'base64'); }
                catch (_) { bodyBytes = null; }
            }
            if (!bodyBytes && typeof result.body === 'string') {
                bodyBytes = Buffer.from(result.body, 'utf8');
            }
            if (!bodyBytes) bodyBytes = Buffer.alloc(0);

            var resp = Object.create(EventEmitter.prototype);
            EventEmitter.call(resp);
            resp.statusCode    = result.status;
            resp.statusMessage = '';
            resp.httpVersion   = '1.1';
            resp.headers       = result.headers && typeof result.headers === 'object' ? result.headers : {};
            resp.rawHeaders    = [];
            for (var hk in resp.headers) {
                resp.rawHeaders.push(hk, resp.headers[hk]);
            }
            resp.trailers      = {};
            resp.method        = method;
            resp.url           = url;
            resp.complete      = false;
            resp.readable      = true;
            resp.readableEnded = false;
            resp.body          = result.body;
            resp._bodyBytes    = bodyBytes;
            var _paused = true; // start paused — drain on first listener / resume()
            var _flushed = false;
            // Encoding switch — `setEncoding('utf8')` etc. tells Node
            // to deliver string chunks instead of Buffers. We honor
            // this so libraries that probe via `setEncoding` then
            // collect string output keep their post-conditions.
            var _encoding = null;
            function flushBody() {
                if (_flushed) return;
                _flushed = true;
                resp.complete      = true;
                resp.readableEnded = true;
                if (bodyBytes && bodyBytes.length > 0) {
                    var chunk = _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
                    resp.emit('data', chunk);
                }
                resp.emit('end');
                resp.emit('close');
            }
            // Schedule the flush as a microtask so user code has a
            // chance to register `data` / `end` / `close` listeners
            // *after* calling `resume()` — the canonical Node pattern.
            // Microtasks fire after the current synchronous turn but
            // before any timer callback, so the outer envelope's
            // `await` reliably drains them even for one-shot scripts.
            function maybeFlush() {
                if (_paused || _flushed) return;
                Promise.resolve().then(flushBody);
            }
            resp.resume      = function() { _paused = false; maybeFlush(); return resp; };
            resp.pause       = function() { _paused = true; return resp; };
            resp.setEncoding = function(enc) {
                if (typeof enc === 'string') _encoding = enc.toLowerCase() === 'utf8' ? 'utf8' : enc;
                return resp;
            };
            resp.read        = function() {
                if (_flushed) return null;
                _flushed = true;
                resp.complete = true;
                resp.readableEnded = true;
                return _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
            };
            resp.destroy     = function(err) {
                if (err) resp.emit('error', err);
                resp.emit('close');
                return resp;
            };
            resp.unpipe      = function() { return resp; };
            // Convenience body-shaping helpers (Undici `.text()`/`.json()`
            // shape) — handy for fetch-flavoured callers.
            resp.text        = function() {
                return Promise.resolve(bodyBytes.toString('utf8'));
            };
            resp.json        = function() {
                try { return Promise.resolve(JSON.parse(bodyBytes.toString('utf8'))); }
                catch (e) { return Promise.reject(e); }
            };
            // Auto-resume when a `data` listener attaches (Node's
            // backwards-compat path: registering a `data` listener
            // implicitly switches the stream to flowing mode).
            var origOn = resp.on.bind(resp);
            resp.on = resp.addListener = function(event, handler) {
                origOn(event, handler);
                if (event === 'data' || event === 'readable') {
                    _paused = false;
                    maybeFlush();
                }
                return resp;
            };
            resp.pipe = function(dest) {
                resp.on('data', function(chunk) { if (dest && dest.write) dest.write(chunk); });
                resp.on('end',  function()      { if (dest && dest.end)   dest.end(); });
                _paused = false;
                maybeFlush();
                return dest;
            };
            // Async-iterator support so `for await (const chunk of res)`
            // works. Single-chunk: yield the body once and end. Yield
            // a Buffer (or encoded string when setEncoding was set)
            // so binary callers (npm tar, image decoders) get bytes.
            if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
                resp[Symbol.asyncIterator] = function() {
                    var done = false;
                    return {
                        next: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            _flushed = true;
                            resp.complete = true;
                            resp.readableEnded = true;
                            var v = _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
                            return Promise.resolve({ value: v, done: false });
                        },
                        return: function() { done = true; return Promise.resolve({ value: undefined, done: true }); },
                    };
                };
            }
            return resp;
        }

        // Node accepts both `(url[, options][, cb])` and
        // `(options[, cb])`. Coalesce the URL+options form into a
        // single opts object before handing off — corepack /
        // node-fetch / pacote all reach for the 3-arg shape.
        function normaliseRequestArgs(args) {
            var arr = Array.prototype.slice.call(args);
            var cb = (arr.length && typeof arr[arr.length - 1] === 'function') ? arr.pop() : undefined;
            var first = arr[0];
            var second = arr[1];
            var opts;
            if (typeof first === 'string') {
                opts = (second && typeof second === 'object') ? Object.assign({}, second) : {};
                // Stash the URL string for requestImpl's url-or-opts branch.
                opts.url = first;
                // Decompose the URL the cheap way so opts.hostname/port
                // are usable when callers downstream introspect.
                var m = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?/i.exec(first);
                if (m) {
                    if (!opts.protocol) opts.protocol = m[1] + ':';
                    if (!opts.hostname) opts.hostname = m[2];
                    if (!opts.port && m[3]) opts.port = parseInt(m[3], 10);
                    if (!opts.path) opts.path = (m[4] || '/') + (m[5] || '');
                }
            } else {
                opts = first || {};
            }
            return { opts: opts, cb: cb };
        }
        exports.request = function() {
            var n = normaliseRequestArgs(arguments);
            return requestImpl(n.opts, n.cb);
        };
        exports.get = function() {
            var n = normaliseRequestArgs(arguments);
            // Node's `get` auto-ends the request and forces GET.
            if (n.opts && typeof n.opts === 'object') n.opts.method = n.opts.method || 'GET';
            return requestImpl(n.opts, n.cb);
        };

        // -------- server-side createServer ------------------------------

        function createServer(requestListener) {
            var server = Object.create(EventEmitter.prototype);
            EventEmitter.call(server);

            if (typeof requestListener === 'function') {
                server.on('request', requestListener);
            }

            server.listen = function(portOrOpts, hostOrBacklogOrCb, backlogOrCb, cbArg) {
                // `.listen(port, [host], [backlog], [cb])` and
                // `.listen({port, host, backlog}, [cb])` — both shapes.
                var port;
                var cb;
                if (portOrOpts && typeof portOrOpts === 'object') {
                    port = portOrOpts.port;
                    cb = hostOrBacklogOrCb;
                } else {
                    port = portOrOpts;
                    if (typeof hostOrBacklogOrCb === 'function') cb = hostOrBacklogOrCb;
                    else if (typeof backlogOrCb === 'function') cb = backlogOrCb;
                    else if (typeof cbArg === 'function')       cb = cbArg;
                }
                if (typeof port !== 'number') {
                    throw new TypeError('http.listen: port must be a number');
                }
                if (typeof globalThis.__host_http_listen !== 'function') {
                    // Library one-shot / no daemon — surface as an
                    // async error event rather than a synchronous
                    // throw so `server.on('error', …)` catches it,
                    // matching Node's listen-failure contract.
                    queueMicrotask(function() {
                        var e = new Error('http.listen requires daemon mode (run via `burn` CLI)');
                        e.code = 'EACCES';
                        server.emit('error', e);
                    });
                    return server;
                }
                var id = globalThis.__host_http_listen(port);
                if (id <= 0) {
                    // B2b: -1 = no daemon (EACCES), -2 = EADDRINUSE,
                    // -3 = other IO. Node emits 'error' async — we
                    // match so `server.on('error', …)` handlers run.
                    queueMicrotask(function() {
                        var err = new Error('http.listen failed (code ' + id + ')');
                        if (id === -1) err.code = 'EACCES';
                        else if (id === -2) err.code = 'EADDRINUSE';
                        else err.code = 'EIO';
                        err.port = port;
                        server.emit('error', err);
                    });
                    return server;
                }
                server._serverId = id;
                server._port = port;

                if (!globalThis.__ab_http_handlers) globalThis.__ab_http_handlers = {};
                globalThis.__ab_http_handlers[id] = function(req, res) {
                    server.emit('request', req, res);
                };

                if (cb) {
                    // Node fires the listen callback async — we match
                    // with queueMicrotask so userland observing order
                    // doesn't diverge.
                    queueMicrotask(function() { cb(); });
                }
                server.emit('listening');
                return server;
            };

            server.close = function(cb) {
                var id = server._serverId;
                if (id && globalThis.__ab_http_handlers) {
                    delete globalThis.__ab_http_handlers[id];
                }
                // B2b: release the port so a subsequent `.listen(port)`
                // on the same port succeeds. No-op if the host import
                // isn't installed (library/no-daemon path).
                if (id && typeof globalThis.__host_http_close === 'function') {
                    globalThis.__host_http_close(id);
                }
                server._serverId = undefined;
                if (cb) queueMicrotask(function() { cb(); });
                server.emit('close');
                return server;
            };

            // Address info stub — Node exposes server.address() returning
            // `{port, family, address}` post-listen.
            server.address = function() {
                if (!server._serverId) return null;
                return { port: server._port, family: 'IPv4', address: '0.0.0.0' };
            };

            // Symbol.asyncDispose (Node 20+) — `await using server =
            // http.createServer(...)` calls this when the binding goes
            // out of scope. Wraps `close()` in a Promise.
            server[Symbol.asyncDispose] = function() {
                return new Promise(function(resolve) {
                    server.close(function() { resolve(); });
                });
            };

            return server;
        }

        exports.createServer = createServer;

        // Install the daemon-event dispatcher's `req`/`res` builder on
        // globalThis so the plugin's JS dispatcher (see
        // `afterburner-plugin/src/modes/daemon_event.rs`) can find it
        // regardless of module-load order within user code.
        globalThis.__ab_build_reqres = function(ev) {
            return {
                req: __ab_make_incoming_message(ev.req || {}),
                res: __ab_make_server_response(ev.req_id || 0)
            };
        };

        function __ab_make_incoming_message(reqData) {
            var msg = Object.create(EventEmitter.prototype);
            EventEmitter.call(msg);
            msg.method = reqData.method || 'GET';
            msg.url = reqData.url || '/';
            msg.headers = reqData.headers || {};
            msg.httpVersion = reqData.httpVersion || '1.1';
            // Stream-ish: body arrives as one chunk then 'end'. Deliver in
            // a microtask so listeners attached synchronously after the
            // handler starts still see the data event.
            //
            // Chunk type matters: real Node `IncomingMessage` emits
            // `Buffer`s unless `setEncoding` was called. body-parser /
            // multer / busboy all collect chunks then call
            // `Buffer.concat(chunks)` at `'end'`, which throws if any
            // chunk is a string. Wrap string bodies as Buffer; pass
            // through already-binary inputs.
            var body = reqData.body;
            var delivered = false;
            function deliver() {
                if (delivered) return;
                delivered = true;
                if (body !== undefined && body !== null && body !== '') {
                    var Buf = require('buffer').Buffer;
                    var chunk;
                    if (typeof body === 'string') {
                        chunk = Buf.from(body, 'utf8');
                    } else if (Buf.isBuffer && Buf.isBuffer(body)) {
                        chunk = body;
                    } else if (body && typeof body.byteLength === 'number') {
                        // ArrayBuffer / TypedArray — wrap as Buffer
                        // (zero-copy in real Node; copy here for
                        // simplicity since we're already in user-mode
                        // QuickJS).
                        chunk = Buf.from(body);
                    } else {
                        chunk = Buf.from(String(body), 'utf8');
                    }
                    msg.emit('data', chunk);
                }
                msg.emit('end');
            }
            msg._deliver = deliver;
            queueMicrotask(deliver);

            // Convenience: req.text() / req.json() so handlers that want
            // the body in one shot don't need to wire data/end manually.
            msg.text = function() { return Promise.resolve(body); };
            msg.json = function() {
                return new Promise(function(resolve, reject) {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            };
            return msg;
        }

        function __ab_make_server_response(reqId) {
            var res = Object.create(EventEmitter.prototype);
            EventEmitter.call(res);
            res.statusCode = 200;
            res.statusMessage = undefined;
            res._headers = {};
            res._buffered = '';
            res.writableEnded = false;
            res.headersSent = false;

            res.setHeader = function(name, value) {
                res._headers[String(name).toLowerCase()] = String(value);
                return res;
            };
            res.getHeader = function(name) {
                return res._headers[String(name).toLowerCase()];
            };
            res.hasHeader = function(name) {
                return Object.prototype.hasOwnProperty.call(
                    res._headers, String(name).toLowerCase()
                );
            };
            res.removeHeader = function(name) {
                delete res._headers[String(name).toLowerCase()];
            };
            res.writeHead = function(status, messageOrHeaders, maybeHeaders) {
                res.statusCode = status;
                var headers;
                if (typeof messageOrHeaders === 'string') {
                    res.statusMessage = messageOrHeaders;
                    headers = maybeHeaders;
                } else {
                    headers = messageOrHeaders;
                }
                if (headers) {
                    Object.keys(headers).forEach(function(k) {
                        res.setHeader(k, headers[k]);
                    });
                }
                return res;
            };
            res.write = function(chunk) {
                if (res.writableEnded) throw new Error('write after end');
                res._buffered += chunk != null ? String(chunk) : '';
                return true;
            };
            res.end = function(chunk) {
                if (res.writableEnded) return;
                if (chunk != null) res._buffered += String(chunk);
                res.writableEnded = true;
                var payload = {
                    status: res.statusCode,
                    headers: res._headers,
                    body: res._buffered
                };
                if (typeof globalThis.__host_http_reply === 'function') {
                    globalThis.__host_http_reply(Number(reqId), JSON.stringify(payload));
                }
                res.emit('finish');
                res.emit('close');
            };

            return res;
        }

        // Expose the helpers on the http module too so tests and
        // advanced consumers can build req/res directly if they need
        // to.
        exports._makeIncomingMessage = __ab_make_incoming_message;
        exports._makeServerResponse  = __ab_make_server_response;

        // `http.METHODS` — sorted, frozen array of every HTTP method
        // Node recognises. Express 5's `lib/utils.js` does
        // `const { METHODS } = require('node:http')` at module load
        // and crashes with `cannot read property 'map' of undefined`
        // when the export is missing. The set below matches Node 22's
        // exposed list.
        exports.METHODS = Object.freeze([
            'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET',
            'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY',
            'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH',
            'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'REBIND',
            'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND',
            'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
        ]);

        // `http.STATUS_CODES` — { numeric-status: reason-phrase } map.
        // Used by `finalhandler`, body-parser error responses, and any
        // npm package that maps status numbers to default text. Node's
        // own list is the IANA-registered set; we ship the same.
        exports.STATUS_CODES = {
            100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
            103: 'Early Hints',
            200: 'OK', 201: 'Created', 202: 'Accepted',
            203: 'Non-Authoritative Information', 204: 'No Content',
            205: 'Reset Content', 206: 'Partial Content',
            207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used',
            300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
            303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy',
            307: 'Temporary Redirect', 308: 'Permanent Redirect',
            400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
            403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
            406: 'Not Acceptable', 407: 'Proxy Authentication Required',
            408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
            411: 'Length Required', 412: 'Precondition Failed',
            413: 'Payload Too Large', 414: 'URI Too Long',
            415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
            417: 'Expectation Failed', 418: "I'm a Teapot",
            421: 'Misdirected Request', 422: 'Unprocessable Entity',
            423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early',
            426: 'Upgrade Required', 428: 'Precondition Required',
            429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
            451: 'Unavailable For Legal Reasons',
            500: 'Internal Server Error', 501: 'Not Implemented',
            502: 'Bad Gateway', 503: 'Service Unavailable',
            504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
            506: 'Variant Also Negotiates', 507: 'Insufficient Storage',
            508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded',
            510: 'Not Extended', 511: 'Network Authentication Required',
        };

        // Minimal Server/IncomingMessage/ServerResponse constructors.
        // The prototypes inherit from `EventEmitter.prototype` so npm
        // packages that walk `Object.getPrototypeOf(req)` (Express's
        // `setPrototypeOf(req, app.request)` lands the prototype on
        // top of `http.IncomingMessage.prototype`) still find the
        // EventEmitter methods (`on`, `emit`, `once`, `removeListener`).
        // Without the inheritance, Express's request loses `.on` after
        // its init middleware re-roots the prototype chain, and
        // `body-parser`'s `raw-body` throws "argument stream must be
        // a stream".
        //
        // The constructors themselves are not callable — instances
        // come from the `_make*` factories. The classes exist for
        // `instanceof` checks and for npm consumers that read
        // `http.IncomingMessage.prototype`.
        exports.Server = function Server() {
            throw new Error('new http.Server() is not implemented; use http.createServer()');
        };
        exports.IncomingMessage = function IncomingMessage() {
            throw new Error('new http.IncomingMessage() is not implemented');
        };
        exports.IncomingMessage.prototype = Object.create(EventEmitter.prototype);
        exports.IncomingMessage.prototype.constructor = exports.IncomingMessage;
        exports.ServerResponse = function ServerResponse() {
            throw new Error('new http.ServerResponse() is not implemented');
        };
        exports.ServerResponse.prototype = Object.create(EventEmitter.prototype);
        exports.ServerResponse.prototype.constructor = exports.ServerResponse;

        // `http.Agent` / `https.Agent` — minimal constructable stand-ins.
        // npm's @npmcli/agent and many keep-alive helpers do
        // `class MyAgent extends http.Agent { ... }` at module-init time.
        // Without a real constructor here that fails QuickJS's
        // "parent class must be constructor" guard before any user
        // logic runs. We don't pool sockets (host bridge owns
        // connections); the class exists so subclasses can
        // instantiate.
        function Agent(opts) {
            EventEmitter.call(this);
            this.options    = opts || {};
            this.keepAlive  = !!(this.options.keepAlive);
            this.maxSockets = this.options.maxSockets || Infinity;
            this.maxFreeSockets = this.options.maxFreeSockets || 256;
            this.requests   = {};
            this.sockets    = {};
            this.freeSockets = {};
            this.protocol   = (moduleName === 'https') ? 'https:' : 'http:';
        }
        Agent.prototype = Object.create(EventEmitter.prototype);
        Agent.prototype.constructor = Agent;
        Agent.prototype.addRequest    = function() {};
        Agent.prototype.createConnection = function() { return null; };
        Agent.prototype.keepSocketAlive  = function() { return false; };
        Agent.prototype.reuseSocket      = function() {};
        Agent.prototype.destroy          = function() {};
        Agent.prototype.getName          = function() { return 'afterburner-agent'; };
        exports.Agent = Agent;
        // The default global agent (Node exposes it; libraries pass it
        // around). Single instance, idempotent across requires.
        if (!globalThis.__plenum_default_agents) globalThis.__plenum_default_agents = {};
        if (!globalThis.__plenum_default_agents[moduleName]) {
            globalThis.__plenum_default_agents[moduleName] = new Agent({ keepAlive: false });
        }
        exports.globalAgent = globalThis.__plenum_default_agents[moduleName];

        // ClientRequest — same posture as Server / IncomingMessage:
        // exists for `instanceof` plus prototype reads, not callable.
        function ClientRequest() {
            throw new Error('new http.ClientRequest() is not implemented; use http.request()');
        }
        ClientRequest.prototype = Object.create(EventEmitter.prototype);
        ClientRequest.prototype.constructor = ClientRequest;
        exports.ClientRequest = ClientRequest;

        // OutgoingMessage — base class some libs subclass.
        function OutgoingMessage() { EventEmitter.call(this); }
        OutgoingMessage.prototype = Object.create(EventEmitter.prototype);
        OutgoingMessage.prototype.constructor = OutgoingMessage;
        OutgoingMessage.prototype.setHeader = function() {};
        OutgoingMessage.prototype.getHeader = function() {};
        OutgoingMessage.prototype.removeHeader = function() {};
        OutgoingMessage.prototype.write = function() { return true; };
        OutgoingMessage.prototype.end = function() {};
        exports.OutgoingMessage = OutgoingMessage;

        // Maximum number of sockets allowed per host — Node default is
        // Infinity, but some libraries read it. Match Node.
        exports.maxHeaderSize = 16384;
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

// ---- http2.js ----
// http2 — Node 20's HTTP/2 module. A real HTTP/2 implementation
// requires negotiating the TLS ALPN handshake, parsing HPACK,
// scheduling streams within a connection — substantial enough to
// be its own phase. Until then, this polyfill exposes the API
// surface so `import { connect } from 'http2'` doesn't blow up at
// import time, and routes the most common usage (single-stream
// requests) through the existing `https` polyfill where possible.

__register_module('http2', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;

    function notImpl(name) {
        var e = new Error(
            'http2.' + name + ' is not yet implemented in burn — full HTTP/2 ' +
            'frame handling lands in a follow-up. For most outbound HTTP/2 use ' +
            'cases the `https` module already negotiates HTTP/1.1 over TLS ' +
            'against HTTP/2-capable servers; switch to https for now.'
        );
        e.code = 'ERR_HTTP2_NOT_IMPLEMENTED';
        return e;
    }

    // ---- ClientHttp2Session ---------------------------------------

    function ClientHttp2Session() {
        EventEmitter.call(this);
        this.closed = false;
        this.destroyed = false;
        this.alpnProtocol = 'h2';
        this.connecting = false;
    }
    ClientHttp2Session.prototype = Object.create(EventEmitter.prototype);
    ClientHttp2Session.prototype.constructor = ClientHttp2Session;
    ClientHttp2Session.prototype.request = function() { throw notImpl('Session.request'); };
    ClientHttp2Session.prototype.close = function() { this.closed = true; };
    ClientHttp2Session.prototype.destroy = function() { this.destroyed = true; };
    ClientHttp2Session.prototype.ping = function(_payload, callback) {
        if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(notImpl('Session.ping')); });
        }
        return false;
    };
    ClientHttp2Session.prototype.settings = function() {};
    ClientHttp2Session.prototype.setTimeout = function() {};
    ClientHttp2Session.prototype.unref = function() { return this; };
    ClientHttp2Session.prototype.ref = function() { return this; };

    function connect(authority, options, listener) {
        var session = new ClientHttp2Session();
        session.authority = authority;
        if (typeof listener === 'function') session.on('connect', listener);
        Promise.resolve().then(function() {
            try { session.emit('error', notImpl('connect')); } catch (_) {}
        });
        return session;
    }

    // ---- Server side ----------------------------------------------

    function Http2Server() {
        EventEmitter.call(this);
    }
    Http2Server.prototype = Object.create(EventEmitter.prototype);
    Http2Server.prototype.constructor = Http2Server;
    Http2Server.prototype.listen = function() { throw notImpl('Server.listen'); };
    Http2Server.prototype.close = function() {};
    Http2Server.prototype.address = function() { return null; };
    Http2Server.prototype.setTimeout = function() {};

    function createServer() { return new Http2Server(); }
    function createSecureServer() { return new Http2Server(); }

    // ---- constants ------------------------------------------------

    var constants = {
        NGHTTP2_NO_ERROR: 0,
        NGHTTP2_PROTOCOL_ERROR: 1,
        NGHTTP2_INTERNAL_ERROR: 2,
        HTTP2_HEADER_AUTHORITY: ':authority',
        HTTP2_HEADER_METHOD: ':method',
        HTTP2_HEADER_PATH: ':path',
        HTTP2_HEADER_SCHEME: ':scheme',
        HTTP2_HEADER_STATUS: ':status',
    };

    function getDefaultSettings() {
        return {
            headerTableSize: 4096,
            enablePush: true,
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            maxConcurrentStreams: 4294967295,
            maxHeaderListSize: 65535,
            maxHeaderSize: 65535,
        };
    }
    function getPackedSettings() { return Buffer.alloc(0); }
    function getUnpackedSettings() { return getDefaultSettings(); }
    function performServerHandshake() {
        return new Http2Server();
    }
    function sensitiveHeaders() { return Symbol('sensitiveHeaders'); }

    exports.connect = connect;
    exports.createServer = createServer;
    exports.createSecureServer = createSecureServer;
    exports.constants = constants;
    exports.Http2Session = ClientHttp2Session;
    exports.ClientHttp2Session = ClientHttp2Session;
    exports.ServerHttp2Session = ClientHttp2Session;
    exports.Http2Stream = function() { throw notImpl('Stream'); };
    exports.Http2ServerRequest = function() { throw notImpl('ServerRequest'); };
    exports.Http2ServerResponse = function() { throw notImpl('ServerResponse'); };
    exports.Http2Server = Http2Server;
    exports.getDefaultSettings = getDefaultSettings;
    exports.getPackedSettings = getPackedSettings;
    exports.getUnpackedSettings = getUnpackedSettings;
    exports.performServerHandshake = performServerHandshake;
    exports.sensitiveHeaders = sensitiveHeaders();
});

// ---- inspector.js ----
// inspector — Node 20's V8 inspector protocol bridge.
//
// The DevTools / Chrome Inspector protocol requires a long-lived
// channel that responds to a JSON-RPC stream of CDP messages. Burn
// has no live inspector and no debugger UI. We expose the API so
// instrumentation code that calls `inspector.open()` /
// `inspector.url()` doesn't crash on import; methods that would
// genuinely require a debugger session (the `Session` class's
// `post()` actually doing something) accept commands but reply with
// "no debugger attached" errors.

__register_module('inspector', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    var _opened = false;
    var _port = 9229;
    var _host = '127.0.0.1';

    function open(port, host /*, wait */) {
        _opened = true;
        if (typeof port === 'number') _port = port;
        if (typeof host === 'string') _host = host;
    }
    function close() { _opened = false; }
    function url() {
        if (!_opened) return undefined;
        return 'ws://' + _host + ':' + _port + '/burn-noop';
    }
    function waitForDebugger() {
        // Real Node blocks until a debugger attaches. We never get
        // a debugger; return immediately so callers don't deadlock.
    }

    // ---- Session class --------------------------------------------

    function Session() {
        EventEmitter.call(this);
        this._connected = false;
    }
    Session.prototype = Object.create(EventEmitter.prototype);
    Session.prototype.constructor = Session;

    Session.prototype.connect = function() {
        this._connected = true;
        return this;
    };
    Session.prototype.connectToMainThread = function() {
        return this.connect();
    };
    Session.prototype.disconnect = function() {
        this._connected = false;
        return this;
    };
    Session.prototype.post = function(method, params, callback) {
        if (typeof params === 'function') { callback = params; params = undefined; }
        var err = new Error(
            "inspector.Session.post('" + method + "'): no debugger attached " +
            'in the burn sandbox; use the host-side wasmtime debugger if you ' +
            'need stepping.'
        );
        err.code = 'ERR_INSPECTOR_NOT_CONNECTED';
        if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(err); });
            return;
        }
        throw err;
    };

    exports.open = open;
    exports.close = close;
    exports.url = url;
    exports.waitForDebugger = waitForDebugger;
    exports.console = globalThis.console || { log: function() {} };
    exports.Session = Session;
    exports.Network = {
        // Node 20 added a `Network` namespace on inspector for
        // request tracing. Stub the surface so callers don't crash.
        requestWillBeSent: function() {},
        responseReceived: function() {},
        loadingFinished: function() {},
        loadingFailed: function() {},
    };
});

// ---- module.js ----
// module — Node 20's introspection for the module loader. Real Node
// exposes this so callers can do `Module.builtinModules`,
// `Module.createRequire(filename)`, etc.

__register_module('module', function(module, exports, require) {

    /// Every Node-built-in name that has a polyfill registered with
    /// the require resolver. Updated when new polyfills land.
    var BUILTINS = [
        'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
        'console', 'constants', 'crypto', 'dgram', 'dns', 'dns/promises',
        'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https',
        'inspector', 'module', 'net', 'os', 'path', 'path/posix',
        'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring',
        'readline', 'repl', 'stream', 'stream/promises', 'stream/web',
        'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
        'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm',
        'wasi', 'worker_threads', 'zlib',
    ];

    /// Burn's `require` is set up at `require.js` bootstrap; callers
    /// asking for a require-from-elsewhere (`createRequire(__filename)`)
    /// get the same object — paths are interpreted from the supplied
    /// filename.
    function createRequire(filename) {
        // Real Node returns a function with `.cache`, `.resolve`, etc.
        // attached. The global require already has those (see
        // require.js). We bind a local proxy that uses `filename`
        // as the resolution base.
        if (typeof filename !== 'string' && !(filename && typeof filename.toString === 'function')) {
            throw new TypeError(
                'module.createRequire: filename must be a string or URL'
            );
        }
        var base = String(filename);
        // Strip `file://` prefix if a URL was passed.
        if (base.indexOf('file://') === 0) base = base.slice(7);

        function localRequire(id) {
            // Defer to the global require with a `from` hint. The
            // require resolver in `require.js` understands this hint.
            if (typeof globalThis.__plenum_require_from === 'function') {
                return globalThis.__plenum_require_from(id, base);
            }
            return globalThis.require(id);
        }
        localRequire.resolve = function(id) {
            if (globalThis.require && globalThis.require.resolve) {
                return globalThis.require.resolve(id);
            }
            return id;
        };
        localRequire.cache = (globalThis.require && globalThis.require.cache) || {};
        localRequire.extensions = (globalThis.require && globalThis.require.extensions) || {};
        localRequire.main = (globalThis.require && globalThis.require.main) || undefined;
        return localRequire;
    }

    function isBuiltin(name) {
        if (typeof name !== 'string') return false;
        var bare = name.indexOf('node:') === 0 ? name.slice(5) : name;
        return BUILTINS.indexOf(bare) !== -1;
    }

    /// Resolve hook registry. `register()` and `getSourceMapsSupport()`
    /// are accepted but no-ops since burn's resolver is its own
    /// pipeline (no Node-style loader hooks).
    function register() { return undefined; }
    function getSourceMapsSupport() {
        return { enabled: false, generatedFromBuiltin: false };
    }
    function setSourceMapsSupport() {}
    function findSourceMap() { return undefined; }

    function syncBuiltinESMExports() { /* no-op */ }
    function enableCompileCache() { return { status: 'disabled' }; }
    function flushCompileCache() {}
    function getCompileCacheDir() { return undefined; }

    function Module(id, parent) {
        this.id = id || '';
        this.path = '';
        this.exports = {};
        this.filename = id || '';
        this.loaded = false;
        this.children = [];
        this.parent = parent || null;
    }
    Module.prototype.require = function(id) { return require(id); };
    Module.prototype.load = function() { this.loaded = true; };
    Module._cache = (globalThis.require && globalThis.require.cache) || {};
    Module._pathCache = {};
    Module._extensions = {
        '.js': function() {},
        '.json': function() {},
    };
    Module.builtinModules = BUILTINS.slice();
    Module.createRequire = createRequire;
    Module.isBuiltin = isBuiltin;
    Module.runMain = function() {};
    Module.register = register;
    Module.getSourceMapsSupport = getSourceMapsSupport;
    Module.setSourceMapsSupport = setSourceMapsSupport;
    Module.findSourceMap = findSourceMap;
    Module.syncBuiltinESMExports = syncBuiltinESMExports;
    Module.enableCompileCache = enableCompileCache;
    Module.flushCompileCache = flushCompileCache;
    Module.getCompileCacheDir = getCompileCacheDir;
    Module.SourceMap = function SourceMap() {};
    Module.findPackageJSON = function() { return undefined; };
    Module.constants = {
        compileCacheStatus: { ENABLED: 1, ALREADY_ENABLED: 2, FAILED: 0, DISABLED: 0 },
    };

    exports = Module;
    exports.builtinModules = BUILTINS.slice();
    exports.createRequire = createRequire;
    exports.isBuiltin = isBuiltin;
    exports.Module = Module;
    exports.register = register;
    exports.getSourceMapsSupport = getSourceMapsSupport;
    exports.setSourceMapsSupport = setSourceMapsSupport;
    exports.findSourceMap = findSourceMap;
    exports.syncBuiltinESMExports = syncBuiltinESMExports;
    exports.enableCompileCache = enableCompileCache;
    exports.flushCompileCache = flushCompileCache;
    exports.getCompileCacheDir = getCompileCacheDir;
    exports.runMain = Module.runMain;
    exports.SourceMap = Module.SourceMap;
    exports.findPackageJSON = Module.findPackageJSON;
    exports.constants = Module.constants;

    module.exports = Module;
});

// ---- net.js ----
// net — raw TCP polyfill (B7).
//
// `Socket` is the JS-side façade for a host-owned `tokio::TcpStream`.
// Operations cross into Rust via `__host_net_*` imports; inbound
// bytes / lifecycle events arrive via the daemon-event dispatcher
// as `{kind:"net-..."}` envelopes. The dispatcher routes them
// through `__ab_net_handlers[conn_id]` and
// `__ab_net_server_handlers[server_id]`.
//
// API coverage (minimum-viable for real DB drivers):
//
//   net.connect / net.createConnection
//     ({port, host}[, listener])
//     (port[, host][, listener])
//   socket.{write, end, destroy, setNoDelay, setKeepAlive, setTimeout,
//           address, remoteAddress, remotePort, localAddress, localPort,
//           bytesRead, bytesWritten, destroyed, connecting, readable,
//           writable, pause, resume, on('data'|'end'|'close'|'error'|
//           'connect'|'drain'|'timeout')}
//   net.createServer([options][, connectionListener])
//   server.{listen, close, address, getConnections,
//            on('listening'|'connection'|'close'|'error')}
//   net.{isIP, isIPv4, isIPv6}
//
// Deferred (will throw a clear error if used):
//   - Unix-domain sockets (path-based listen/connect)
//   - net.BlockList
//   - socket.setEncoding (callers should decode bytes themselves)
//   - allowHalfOpen option on Server (always allowed by default)

(function bootstrapNetGlobals() {
    if (!globalThis.__ab_net_handlers) globalThis.__ab_net_handlers = {};
    if (!globalThis.__ab_net_server_handlers) globalThis.__ab_net_server_handlers = {};
})();

__register_module('net', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;

    // ----- error mapping --------------------------------------------

    function mapHostErrorCode(rc) {
        switch (rc) {
            case -1: return 'ENO_DAEMON';
            case -2: return 'EACCES';
            case -3: return 'ENOTFOUND';
            case -4: return 'EINVAL';
            case -5: return 'EINVAL';
            case -6: return 'EINVAL';
            default: return 'EOTHER';
        }
    }

    function makeError(rc, prefix) {
        var detail = '';
        if (typeof globalThis.__host_last_error === 'function') {
            detail = globalThis.__host_last_error();
        }
        var code = mapHostErrorCode(rc);
        var e = new Error(prefix + ': ' + (detail || ('rc=' + rc)));
        e.code = code;
        return e;
    }

    // ----- Socket ----------------------------------------------------

    function Socket(opts) {
        if (!(this instanceof Socket)) return new Socket(opts);
        EventEmitter.call(this);
        opts = opts || {};

        // Internal state
        this._connId = 0;            // 0 until connect / accept binds it
        this._connecting = false;
        this._destroyed = false;
        // Separate from `_destroyed` so the host's terminal Close event
        // can still emit `'close'` after a user-initiated destroy(). The
        // destroy path flips `_destroyed` synchronously to make
        // `socket.destroyed === true` observable from inside the
        // 'close' listener (Node-compat).
        this._closeEmitted = false;
        this._readable = true;
        this._writable = true;
        this._wantsDrain = false;    // true after write() returned false
        this._pendingHWM = 64 * 1024;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.remoteAddress = undefined;
        this.remotePort = undefined;
        this.remoteFamily = undefined;
        this.localAddress = undefined;
        this.localPort = undefined;

        this._timeoutMs = 0;
        this._timeoutHandle = null;

        // Ready-state mirrors Node's. Set as connect/end/close fire.
        this.readyState = 'opening';
    }
    Socket.prototype = Object.create(EventEmitter.prototype);
    Socket.prototype.constructor = Socket;

    // Internal: bind a host-allocated conn_id to this socket and
    // register so daemon-event dispatch can find us.
    Socket.prototype._attach = function(connId) {
        if (this._connId) {
            // Should never happen unless a caller reuses a Socket.
            throw new Error('net.Socket already attached to conn ' + this._connId);
        }
        this._connId = connId | 0;
        globalThis.__ab_net_handlers[this._connId] = this;
    };

    Socket.prototype._dispatchConnect = function(local, remote) {
        this._connecting = false;
        this.readyState = 'open';
        this.localAddress = local && local.address;
        this.localPort = local && local.port;
        this.remoteAddress = remote && remote.address;
        this.remotePort = remote && remote.port;
        this.remoteFamily = remote && remote.family;
        this._resetTimeout();
        try { this.emit('connect'); } catch (_) {}
        try { this.emit('ready'); } catch (_) {}
    };

    Socket.prototype._dispatchData = function(payloadB64) {
        if (this._destroyed || !this._readable) return;
        this._resetTimeout();
        // Default: emit Buffer. Callers needing strings can call
        // .setEncoding (deferred — they can also decode themselves).
        var bytes;
        try {
            bytes = Buffer.from(payloadB64, 'base64');
        } catch (_) {
            return;
        }
        this.bytesRead += bytes.length;
        try { this.emit('data', bytes); } catch (_) {}
    };

    Socket.prototype._dispatchEnd = function() {
        if (!this._readable) return;
        this._readable = false;
        this.readyState = this._writable ? 'writeOnly' : 'closed';
        try { this.emit('end'); } catch (_) {}
    };

    Socket.prototype._dispatchDrain = function() {
        if (!this._wantsDrain) return;
        this._wantsDrain = false;
        try { this.emit('drain'); } catch (_) {}
    };

    Socket.prototype._dispatchError = function(message, code) {
        var e = new Error(message || 'net error');
        e.code = code || 'EOTHER';
        try { this.emit('error', e); } catch (_) {}
    };

    Socket.prototype._dispatchClose = function(hadError) {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this._destroyed = true;
        this._readable = false;
        this._writable = false;
        this.readyState = 'closed';
        this._clearTimeout();
        try { this.emit('close', !!hadError); } catch (_) {}
        if (this._connId) {
            delete globalThis.__ab_net_handlers[this._connId];
        }
    };

    Socket.prototype.connect = function() {
        // connect(port, host?, cb?) | connect({port, host}, cb?)
        var args = Array.prototype.slice.call(arguments);
        var opts;
        var cb;
        if (args.length && typeof args[args.length - 1] === 'function') {
            cb = args.pop();
        }
        if (args.length === 1 && typeof args[0] === 'object' && args[0]) {
            opts = args[0];
        } else {
            opts = { port: args[0], host: args[1] };
        }
        var port = opts.port | 0;
        var host = opts.host || '127.0.0.1';
        if (!port || port < 1 || port > 65535) {
            throw new RangeError('net.connect: port out of range: ' + opts.port);
        }
        this._connecting = true;
        this.readyState = 'opening';
        var rc = globalThis.__host_net_connect(String(host), port);
        if (rc < 0) {
            var err = makeError(rc, 'net.connect');
            // Defer the error event to a microtask so handlers added
            // after connect() (the typical pattern) still fire.
            var self = this;
            Promise.resolve().then(function() {
                self._connecting = false;
                self._destroyed = true;
                self.readyState = 'closed';
                try { self.emit('error', err); } catch (_) {}
                try { self.emit('close', true); } catch (_) {}
            });
            return this;
        }
        this._attach(rc);
        if (cb) this.once('connect', cb);
        return this;
    };

    Socket.prototype.write = function(data, encoding, cb) {
        if (this._destroyed || !this._writable) {
            if (cb) Promise.resolve().then(function() { cb(new Error('not writable')); });
            return false;
        }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

        var b64;
        if (Buffer.isBuffer(data)) {
            b64 = data.toString('base64');
        } else if (typeof data === 'string') {
            b64 = Buffer.from(data, encoding || 'utf8').toString('base64');
        } else if (data instanceof Uint8Array) {
            b64 = Buffer.from(data).toString('base64');
        } else {
            var t = typeof data;
            throw new TypeError('net.Socket.write: unsupported chunk type ' + t);
        }

        var rc = globalThis.__host_net_write(this._connId, b64);
        if (rc < 0) {
            var err = makeError(rc, 'net.write');
            if (cb) cb(err);
            try { this.emit('error', err); } catch (_) {}
            return false;
        }
        // bytesWritten counts the raw bytes, not the base64 string.
        var n = Buffer.isBuffer(data) ? data.length :
                (typeof data === 'string' ? Buffer.byteLength(data, encoding || 'utf8') :
                 (data && data.length) || 0);
        this.bytesWritten += n;
        this._resetTimeout();
        if (cb) Promise.resolve().then(cb);

        var pending = globalThis.__host_net_pending(this._connId) | 0;
        if (pending >= this._pendingHWM) {
            this._wantsDrain = true;
            return false;
        }
        return true;
    };

    Socket.prototype.end = function(data, encoding, cb) {
        if (typeof data === 'function') { cb = data; data = undefined; encoding = undefined; }
        else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (data !== undefined && data !== null) {
            this.write(data, encoding);
        }
        this._writable = false;
        if (this._connId && !this._destroyed) {
            globalThis.__host_net_end(this._connId);
        }
        if (cb) this.once('close', cb);
        return this;
    };

    Socket.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._readable = false;
        this._writable = false;
        if (this._connId) {
            globalThis.__host_net_destroy(this._connId);
        }
        if (err) {
            try { this.emit('error', err); } catch (_) {}
        }
        return this;
    };

    Socket.prototype.setNoDelay = function(enable) {
        if (this._connId) {
            globalThis.__host_net_set_no_delay(this._connId, enable === false ? 0 : 1);
        }
        return this;
    };

    Socket.prototype.setKeepAlive = function(enable, initialDelay) {
        if (this._connId) {
            globalThis.__host_net_set_keep_alive(
                this._connId,
                enable ? 1 : 0,
                (initialDelay | 0) || 0
            );
        }
        return this;
    };

    Socket.prototype.setTimeout = function(timeout, cb) {
        this._timeoutMs = timeout | 0;
        if (cb) this.on('timeout', cb);
        this._resetTimeout();
        return this;
    };

    Socket.prototype._resetTimeout = function() {
        this._clearTimeout();
        if (this._timeoutMs > 0) {
            var self = this;
            this._timeoutHandle = setTimeout(function() {
                try { self.emit('timeout'); } catch (_) {}
            }, this._timeoutMs);
        }
    };

    Socket.prototype._clearTimeout = function() {
        if (this._timeoutHandle) {
            clearTimeout(this._timeoutHandle);
            this._timeoutHandle = null;
        }
    };

    Socket.prototype.address = function() {
        if (!this.localAddress) return {};
        return {
            address: this.localAddress,
            family: this.remoteFamily ||
                    (String(this.localAddress || '').indexOf(':') >= 0 ? 'IPv6' : 'IPv4'),
            port: this.localPort,
        };
    };

    Socket.prototype.pause = function() {
        // Backpressure on the read side isn't wired in this minimum
        // subset — host always pumps. This is a no-op so callers that
        // call .pause() defensively don't crash.
        return this;
    };
    Socket.prototype.resume = function() { return this; };
    Socket.prototype.ref = function() { return this; };
    Socket.prototype.unref = function() { return this; };
    Socket.prototype.setEncoding = function() {
        // Deferred: callers can decode bytes themselves from the
        // Buffer instances we emit.
        throw new Error('net.Socket.setEncoding is not supported in burn yet (decode bytes manually)');
    };

    Object.defineProperty(Socket.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(Socket.prototype, 'connecting', {
        get: function() { return this._connecting; },
    });
    Object.defineProperty(Socket.prototype, 'readable', {
        get: function() { return this._readable; },
    });
    Object.defineProperty(Socket.prototype, 'writable', {
        get: function() { return this._writable; },
    });
    Object.defineProperty(Socket.prototype, 'pending', {
        get: function() {
            if (!this._connId) return 0;
            return globalThis.__host_net_pending(this._connId) | 0;
        },
    });

    // ----- Server ----------------------------------------------------

    function Server(opts, connectionListener) {
        if (!(this instanceof Server)) return new Server(opts, connectionListener);
        EventEmitter.call(this);
        if (typeof opts === 'function') {
            connectionListener = opts;
            opts = {};
        }
        this._serverId = 0;
        this._listening = false;
        this._closed = false;
        this._port = 0;
        this._host = '';
        this._connections = new Set();
        if (connectionListener) this.on('connection', connectionListener);
    }
    Server.prototype = Object.create(EventEmitter.prototype);
    Server.prototype.constructor = Server;

    Server.prototype.listen = function() {
        // listen(port[, host][, backlog][, cb])
        // listen({port, host, backlog}[, cb])
        // listen(cb) — port 0
        var args = Array.prototype.slice.call(arguments);
        var cb;
        if (args.length && typeof args[args.length - 1] === 'function') {
            cb = args.pop();
        }
        var opts;
        if (args.length === 1 && typeof args[0] === 'object' && args[0]) {
            opts = args[0];
        } else if (args.length === 0) {
            opts = { port: 0 };
        } else {
            opts = { port: args[0], host: args[1] };
        }
        var port = opts.port | 0;
        var host = opts.host || '0.0.0.0';
        if (port < 0 || port > 65535) {
            throw new RangeError('net.listen: port out of range: ' + opts.port);
        }
        var rc = globalThis.__host_net_listen(String(host), port);
        if (rc < 0) {
            var err = makeError(rc, 'net.listen');
            var self = this;
            Promise.resolve().then(function() {
                try { self.emit('error', err); } catch (_) {}
            });
            return this;
        }
        this._serverId = rc | 0;
        this._port = port;
        this._host = host;
        globalThis.__ab_net_server_handlers[this._serverId] = this;
        if (cb) this.once('listening', cb);
        return this;
    };

    Server.prototype.address = function() {
        if (!this._listening) return null;
        return {
            address: this._host,
            family: this._host.indexOf(':') >= 0 ? 'IPv6' : 'IPv4',
            port: this._port,
        };
    };

    Server.prototype.close = function(cb) {
        if (this._closed) {
            if (cb) Promise.resolve().then(function() { cb(); });
            return this;
        }
        this._closed = true;
        if (this._serverId) {
            globalThis.__host_net_close_server(this._serverId);
            delete globalThis.__ab_net_server_handlers[this._serverId];
        }
        var self = this;
        Promise.resolve().then(function() {
            self._listening = false;
            try { self.emit('close'); } catch (_) {}
            if (cb) cb();
        });
        return this;
    };

    Server.prototype.getConnections = function(cb) {
        var n = this._connections.size;
        Promise.resolve().then(function() { cb(null, n); });
        return this;
    };

    Server.prototype.ref = function() { return this; };
    Server.prototype.unref = function() { return this; };

    Server.prototype._dispatchListening = function(port) {
        this._listening = true;
        this._port = (port | 0) || this._port;
        try { this.emit('listening'); } catch (_) {}
    };

    Server.prototype._dispatchConnection = function(connId, local, remote) {
        var sock = new Socket();
        sock._attach(connId | 0);
        sock._connecting = false;
        sock.readyState = 'open';
        sock.localAddress = local && local.address;
        sock.localPort = local && local.port;
        sock.remoteAddress = remote && remote.address;
        sock.remotePort = remote && remote.port;
        sock.remoteFamily = remote && remote.family;
        var self = this;
        this._connections.add(sock);
        sock.once('close', function() { self._connections.delete(sock); });
        try { this.emit('connection', sock); } catch (_) {}
    };

    Server.prototype._dispatchServerError = function(message) {
        var err = new Error(message || 'net.Server error');
        err.code = 'EOTHER';
        try { this.emit('error', err); } catch (_) {}
    };

    Object.defineProperty(Server.prototype, 'listening', {
        get: function() { return this._listening; },
    });

    // ----- Top-level helpers -----------------------------------------

    function connect() {
        var s = new Socket();
        return s.connect.apply(s, arguments);
    }

    function createServer(opts, listener) {
        return new Server(opts, listener);
    }

    function isIPv4(s) {
        if (typeof s !== 'string') return false;
        var parts = s.split('.');
        if (parts.length !== 4) return false;
        for (var i = 0; i < 4; i++) {
            var p = parts[i];
            if (!/^\d+$/.test(p)) return false;
            var n = parseInt(p, 10);
            if (n < 0 || n > 255) return false;
            if (p.length > 1 && p[0] === '0') return false;
        }
        return true;
    }

    function isIPv6(s) {
        if (typeof s !== 'string' || s.length === 0) return false;
        // Reject obvious junk before letting the regex chew on it.
        if (s.indexOf(' ') >= 0) return false;
        // Permissive match — covers full, compressed (`::`), and
        // IPv4-mapped (`::ffff:1.2.3.4`) forms. Doesn't enforce the
        // single-`::` rule rigorously but that's good enough for the
        // standard library's `isIP` contract.
        var ipv4Tail = '(?:\\d{1,3}\\.){3}\\d{1,3}';
        var hex = '[0-9a-fA-F]{1,4}';
        var regex = new RegExp(
            '^(?:' +
                '(?:' + hex + ':){7}' + hex +                              // 8 groups
                '|(?:' + hex + ':){1,7}:' +                                // ::-prefix
                '|(?:' + hex + ':){1,6}:' + hex +
                '|(?:' + hex + ':){1,5}(?::' + hex + '){1,2}' +
                '|(?:' + hex + ':){1,4}(?::' + hex + '){1,3}' +
                '|(?:' + hex + ':){1,3}(?::' + hex + '){1,4}' +
                '|(?:' + hex + ':){1,2}(?::' + hex + '){1,5}' +
                '|' + hex + ':(?::' + hex + '){1,6}' +
                '|:(?::' + hex + '){1,7}' +
                '|::' +
                '|(?:' + hex + ':){6}' + ipv4Tail +
                '|::(?:' + hex + ':){0,5}' + ipv4Tail +
            ')$'
        );
        return regex.test(s);
    }

    function isIP(s) {
        if (isIPv4(s)) return 4;
        if (isIPv6(s)) return 6;
        return 0;
    }

    // ---- net.BlockList (Node 15+) -----------------------------
    //
    // A list of IP rules with `addAddress` / `addRange` / `addSubnet`
    // and a `check(addr)` that returns true if the address matches.
    // Pure-JS — used by Node apps to gate accepted connections.
    function _ipv4ToInt(s) {
        var p = s.split('.');
        if (p.length !== 4) return -1;
        var n = 0;
        for (var i = 0; i < 4; i++) {
            var b = parseInt(p[i], 10);
            if (!(b >= 0 && b <= 255)) return -1;
            n = (n * 256) + b;
        }
        return n;
    }
    function BlockList() {
        if (!(this instanceof BlockList)) return new BlockList();
        this._rules = [];
    }
    BlockList.prototype.addAddress = function(address, family) {
        family = family || 'ipv4';
        this._rules.push({ kind: 'address', address: String(address), family: family });
    };
    BlockList.prototype.addRange = function(start, end, family) {
        family = family || 'ipv4';
        this._rules.push({ kind: 'range', start: String(start), end: String(end), family: family });
    };
    BlockList.prototype.addSubnet = function(network, prefix, family) {
        family = family || 'ipv4';
        this._rules.push({ kind: 'subnet', network: String(network), prefix: prefix | 0, family: family });
    };
    BlockList.prototype.check = function(address, family) {
        family = family || (isIPv6(address) ? 'ipv6' : 'ipv4');
        var addrStr = String(address);
        for (var i = 0; i < this._rules.length; i++) {
            var r = this._rules[i];
            if (r.family !== family) continue;
            if (r.kind === 'address' && r.address === addrStr) return true;
            if (family === 'ipv4') {
                var n = _ipv4ToInt(addrStr);
                if (n < 0) continue;
                if (r.kind === 'range') {
                    var lo = _ipv4ToInt(r.start), hi = _ipv4ToInt(r.end);
                    if (lo >= 0 && hi >= 0 && n >= lo && n <= hi) return true;
                } else if (r.kind === 'subnet') {
                    var net = _ipv4ToInt(r.network);
                    if (net < 0 || r.prefix < 0 || r.prefix > 32) continue;
                    var mask = r.prefix === 0 ? 0 : (~0 << (32 - r.prefix)) >>> 0;
                    if ((n & mask) === (net & mask)) return true;
                }
            }
            // IPv6 subnet/range matching is string-prefix only here.
            // Real workloads rarely use BlockList for IPv6; expand
            // when a concrete need surfaces.
        }
        return false;
    };
    Object.defineProperty(BlockList.prototype, 'rules', {
        get: function() {
            return this._rules.map(function(r) {
                if (r.kind === 'address') return 'Address: ' + r.family.toUpperCase() + ' ' + r.address;
                if (r.kind === 'range') return 'Range: ' + r.family.toUpperCase() + ' ' + r.start + '-' + r.end;
                return 'Subnet: ' + r.family.toUpperCase() + ' ' + r.network + '/' + r.prefix;
            });
        },
    });

    // ---- net.SocketAddress (Node 15+) -------------------------
    //
    // Immutable address record. In Node it's a transferable across
    // workers; here it's a value-object with the same shape.
    function SocketAddress(options) {
        if (!(this instanceof SocketAddress)) return new SocketAddress(options);
        options = options || {};
        Object.defineProperty(this, 'address', { value: String(options.address || '127.0.0.1'), enumerable: true });
        Object.defineProperty(this, 'port', { value: (options.port | 0) || 0, enumerable: true });
        Object.defineProperty(this, 'family', { value: String(options.family || 'ipv4').toLowerCase(), enumerable: true });
        Object.defineProperty(this, 'flowlabel', { value: (options.flowlabel | 0) || 0, enumerable: true });
    }
    SocketAddress.parse = function(input) {
        if (typeof input !== 'string') return undefined;
        var s = input.trim();
        if (s[0] === '[') {
            var rb = s.indexOf(']');
            if (rb < 0) return undefined;
            var addr = s.slice(1, rb);
            var rest = s.slice(rb + 1);
            var port = rest[0] === ':' ? parseInt(rest.slice(1), 10) : 0;
            return new SocketAddress({ address: addr, port: port, family: 'ipv6' });
        }
        if (isIPv6(s)) return new SocketAddress({ address: s, family: 'ipv6' });
        var c = s.lastIndexOf(':');
        if (c >= 0) {
            return new SocketAddress({ address: s.slice(0, c), port: parseInt(s.slice(c + 1), 10) || 0 });
        }
        return new SocketAddress({ address: s });
    };

    exports.Socket = Socket;
    exports.Server = Server;
    exports.createConnection = connect;
    exports.connect = connect;
    exports.createServer = createServer;
    exports.isIP = isIP;
    exports.isIPv4 = isIPv4;
    exports.isIPv6 = isIPv6;
    exports.BlockList = BlockList;
    exports.SocketAddress = SocketAddress;
});

// ---- node_subpaths.js ----
// Node exposes several "X/promises" paths (and other sub-module
// shapes) as separate require targets. They're thin re-exports of a
// property on the parent module. Registering them here — in a file
// that lexically sorts after the parents — lets `require('node:fs/promises')`
// behave exactly like `require('fs').promises`, matching Node so
// drop-in scripts don't trip on the difference.

// fs/promises → re-export of fs.promises (set in fs.js).
__register_module('fs/promises', function(module, exports, require) {
    module.exports = require('fs').promises;
});

// dns/promises → re-export of dns.promises (set in dns.js).
__register_module('dns/promises', function(module, exports, require) {
    module.exports = require('dns').promises;
});

// stream/promises — Node exposes Promise-returning versions of
// `pipeline` and `finished`. The core `stream` module's sync-callback
// versions are in stream.js; we wrap them here.
__register_module('stream/promises', function(module, exports, require) {
    var stream = require('stream');
    module.exports = {
        pipeline: function() {
            var args = [].slice.call(arguments);
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { stream.pipeline.apply(null, args); } catch (e) { reject(e); }
            });
        },
        finished: function(s, opts) {
            return new Promise(function(resolve, reject) {
                stream.finished(s, opts || {}, function(err) {
                    err ? reject(err) : resolve();
                });
            });
        },
    };
});

// timers/promises — Node exposes Promise-returning delays.
// `setInterval` is documented as an async iterator; we stub it with a
// clear "not implemented" error until a consumer surfaces a need.
// util/types — Node 20's `is*` type-guard helpers. Most production
// code uses these for fast type checks (`util.types.isUint8Array`,
// `isPromise`, `isProxy`, etc.). The pure-JS implementations below
// don't need host-side support.
__register_module('util/types', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    function isPromise(v) {
        return !!v && (typeof v === 'object' || typeof v === 'function')
            && typeof v.then === 'function';
    }

    function isAnyArrayBuffer(v) {
        return v instanceof ArrayBuffer ||
            (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
    }

    function isTypedArray(v) {
        return ArrayBuffer.isView(v) && !(v instanceof DataView);
    }

    function makeTypedCheck(ctor) {
        return function(v) {
            return typeof ctor !== 'undefined' && v instanceof ctor;
        };
    }

    module.exports = {
        isPromise: isPromise,
        isAnyArrayBuffer: isAnyArrayBuffer,
        isArrayBuffer: function(v) { return v instanceof ArrayBuffer; },
        isSharedArrayBuffer: function(v) {
            return typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer;
        },
        isAsyncFunction: function(v) {
            // QuickJS's `AsyncFunction` constructor isn't a global;
            // fall back to the toString tag, which marks async fns
            // distinctively in any spec-compliant engine.
            return typeof v === 'function' &&
                Object.prototype.toString.call(v) === '[object AsyncFunction]';
        },
        isGeneratorFunction: function(v) {
            return typeof v === 'function' &&
                Object.prototype.toString.call(v) === '[object GeneratorFunction]';
        },
        isGeneratorObject: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Generator]';
        },
        isMap: function(v) { return v instanceof Map; },
        isSet: function(v) { return v instanceof Set; },
        isMapIterator: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Map Iterator]';
        },
        isSetIterator: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Set Iterator]';
        },
        isWeakMap: function(v) { return v instanceof WeakMap; },
        isWeakSet: function(v) { return v instanceof WeakSet; },
        isPromise: isPromise,
        isProxy: function() { return false; }, // Proxies are transparent — can't detect from JS
        isRegExp: function(v) { return v instanceof RegExp; },
        isDate: function(v) { return v instanceof Date; },
        isError: function(v) { return v instanceof Error; },
        isSymbol: function(v) { return typeof v === 'symbol'; },
        isStringObject: function(v) { return typeof v === 'object' && v instanceof String; },
        isNumberObject: function(v) { return typeof v === 'object' && v instanceof Number; },
        isBooleanObject: function(v) { return typeof v === 'object' && v instanceof Boolean; },
        isBigIntObject: function(v) {
            return typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object BigInt]';
        },
        isBoxedPrimitive: function(v) {
            return v instanceof String || v instanceof Number || v instanceof Boolean ||
                (typeof v === 'object' && Object.prototype.toString.call(v) === '[object BigInt]');
        },
        isModuleNamespaceObject: function() { return false; },
        isExternal: function() { return false; },
        isArgumentsObject: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Arguments]';
        },
        isArrayBufferView: function(v) { return ArrayBuffer.isView(v); },
        isDataView: function(v) { return v instanceof DataView; },
        isTypedArray: isTypedArray,
        isUint8Array: function(v) { return v instanceof Uint8Array; },
        isUint8ClampedArray: makeTypedCheck(typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : null),
        isUint16Array: function(v) { return v instanceof Uint16Array; },
        isUint32Array: function(v) { return v instanceof Uint32Array; },
        isInt8Array: function(v) { return v instanceof Int8Array; },
        isInt16Array: function(v) { return v instanceof Int16Array; },
        isInt32Array: function(v) { return v instanceof Int32Array; },
        isFloat32Array: function(v) { return v instanceof Float32Array; },
        isFloat64Array: function(v) { return v instanceof Float64Array; },
        isBigInt64Array: makeTypedCheck(typeof BigInt64Array !== 'undefined' ? BigInt64Array : null),
        isBigUint64Array: makeTypedCheck(typeof BigUint64Array !== 'undefined' ? BigUint64Array : null),
        isNativeError: function(v) { return v instanceof Error; },
        isKeyObject: function() { return false; },
        isCryptoKey: function() { return false; },
    };
});

// stream/web — Node 20's WHATWG streams (ReadableStream, WritableStream,
// TransformStream). QuickJS has the spec types as globals; we just
// re-export them under the Node module path so `import { ReadableStream }
// from 'stream/web'` works.
__register_module('stream/web', function(module, exports, require) {
    function notSupported(name) {
        return function() {
            throw new Error('stream/web.' + name + ' is not available in burn yet');
        };
    }
    module.exports = {
        ReadableStream: typeof ReadableStream !== 'undefined' ? ReadableStream : notSupported('ReadableStream'),
        ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader !== 'undefined' ? ReadableStreamDefaultReader : notSupported('ReadableStreamDefaultReader'),
        ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader !== 'undefined' ? ReadableStreamBYOBReader : notSupported('ReadableStreamBYOBReader'),
        WritableStream: typeof WritableStream !== 'undefined' ? WritableStream : notSupported('WritableStream'),
        WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter !== 'undefined' ? WritableStreamDefaultWriter : notSupported('WritableStreamDefaultWriter'),
        TransformStream: typeof TransformStream !== 'undefined' ? TransformStream : notSupported('TransformStream'),
        ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy !== 'undefined' ? ByteLengthQueuingStrategy : notSupported('ByteLengthQueuingStrategy'),
        CountQueuingStrategy: typeof CountQueuingStrategy !== 'undefined' ? CountQueuingStrategy : notSupported('CountQueuingStrategy'),
        TextEncoderStream: typeof TextEncoderStream !== 'undefined' ? TextEncoderStream : notSupported('TextEncoderStream'),
        TextDecoderStream: typeof TextDecoderStream !== 'undefined' ? TextDecoderStream : notSupported('TextDecoderStream'),
        CompressionStream: typeof CompressionStream !== 'undefined' ? CompressionStream : notSupported('CompressionStream'),
        DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : notSupported('DecompressionStream'),
    };
});

// constants — Node 20 exposes a flat namespace of POSIX-ish numeric
// constants (errno values, file modes, etc.) under `require('constants')`.
// Most callers grab a single value (`require('constants').O_RDONLY`),
// so a shallow flat object is enough.
__register_module('constants', function(module, exports, require) {
    var fs = require('fs');
    var os = require('os');
    var crypto = require('crypto');
    var c = {};
    if (fs && fs.constants) Object.assign(c, fs.constants);
    if (os && os.constants) {
        if (os.constants.errno) Object.assign(c, os.constants.errno);
        if (os.constants.signals) Object.assign(c, os.constants.signals);
    }
    if (crypto && crypto.constants) Object.assign(c, crypto.constants);
    module.exports = c;
});

// sys — historical alias for `util` (deprecated in Node 0.x but
// still imported by some older libraries that haven't been touched
// since). Identical surface to `util`.
__register_module('sys', function(module, exports, require) {
    module.exports = require('util');
});

// path/posix and path/win32 — Node exposes POSIX and Win32 path
// implementations as separate require targets in addition to
// `path.posix` / `path.win32`.
__register_module('path/posix', function(module, exports, require) {
    module.exports = require('path').posix || require('path');
});
__register_module('path/win32', function(module, exports, require) {
    module.exports = require('path').win32 || require('path');
});

// readline/promises — Promise-returning Readline. Node 17+. Wraps
// the callback Interface; we expose `question` returning a Promise.
__register_module('readline/promises', function(module, exports, require) {
    var rl = require('readline');
    function createInterface(opts) {
        var iface = rl.createInterface(opts);
        var origQuestion = iface.question.bind(iface);
        iface.question = function(prompt, options) {
            options = options || {};
            return new Promise(function(resolve, reject) {
                if (options.signal && options.signal.aborted) {
                    return reject(new Error('aborted'));
                }
                origQuestion(prompt, function(answer) { resolve(answer); });
                if (options.signal) {
                    options.signal.addEventListener('abort', function() {
                        reject(new Error('aborted'));
                    });
                }
            });
        };
        return iface;
    }
    module.exports = Object.assign({}, rl, {
        createInterface: createInterface,
        Interface: rl.Interface,
    });
});

// inspector/promises — Node 19+. The Session class with promise-style
// `post` / `connect`. We expose the same shape but every call rejects
// with ERR_NOT_SUPPORTED_IN_SANDBOX — V8's inspector requires direct
// engine access we cannot provide through wasm.
__register_module('inspector/promises', function(module, exports, require) {
    var inspector = require('inspector');
    function rej(name) {
        return Promise.reject(Object.assign(
            new Error('inspector.' + name + ' not available in sandbox'),
            { code: 'ERR_NOT_SUPPORTED_IN_SANDBOX' }
        ));
    }
    function Session() { inspector.Session.call(this); }
    Session.prototype = Object.create(inspector.Session.prototype || Object.prototype);
    Session.prototype.connect = function() { return rej('connect'); };
    Session.prototype.connectToMainThread = function() { return rej('connectToMainThread'); };
    Session.prototype.disconnect = function() { return Promise.resolve(); };
    Session.prototype.post = function() { return rej('post'); };
    module.exports = Object.assign({}, inspector, { Session: Session });
});

// stream/consumers — Node 16.7+. Async helpers that drain a readable
// stream and return its full contents. Implementation collects every
// chunk via async-iteration and concatenates Buffer/Uint8Array bytes
// or string segments.
__register_module('stream/consumers', function(module, exports, require) {
    function collect(stream) {
        return (async function() {
            var chunks = [];
            for await (var chunk of stream) chunks.push(chunk);
            if (chunks.length === 0) {
                var Buf0 = globalThis.Buffer;
                return Buf0 ? Buf0.alloc(0) : new Uint8Array(0);
            }
            var Buf = globalThis.Buffer;
            if (Buf && Buf.isBuffer && Buf.isBuffer(chunks[0])) return Buf.concat(chunks);
            if (chunks[0] instanceof Uint8Array) {
                var total = 0;
                for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
                var out = new Uint8Array(total);
                var off = 0;
                for (var j = 0; j < chunks.length; j++) {
                    out.set(chunks[j], off); off += chunks[j].length;
                }
                return out;
            }
            return chunks.map(String).join('');
        })();
    }
    module.exports = {
        text: function(stream) {
            return collect(stream).then(function(b) {
                if (typeof b === 'string') return b;
                if (globalThis.Buffer && globalThis.Buffer.isBuffer && globalThis.Buffer.isBuffer(b))
                    return b.toString('utf8');
                return new globalThis.TextDecoder().decode(b);
            });
        },
        json: function(stream) {
            return module.exports.text(stream).then(JSON.parse);
        },
        arrayBuffer: function(stream) {
            return collect(stream).then(function(b) {
                if (b instanceof Uint8Array)
                    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
                if (typeof b === 'string')
                    return new globalThis.TextEncoder().encode(b).buffer;
                return new ArrayBuffer(0);
            });
        },
        buffer: function(stream) {
            return collect(stream).then(function(b) {
                var Buf = globalThis.Buffer;
                if (Buf && Buf.isBuffer && Buf.isBuffer(b)) return b;
                if (b instanceof Uint8Array) return Buf ? Buf.from(b) : b;
                return Buf ? Buf.from(String(b), 'utf8')
                           : new globalThis.TextEncoder().encode(b);
            });
        },
        blob: function(stream) {
            return collect(stream).then(function(b) {
                return new globalThis.Blob([b]);
            });
        },
    };
});

// diagnostics_channel — Node 16+. Pub/sub for in-process tracing.
// Same-realm impl: channels keyed by name on a global registry,
// `publish` broadcasts to every subscriber synchronously (matches
// Node's contract — async work belongs in subscribers if needed).
__register_module('diagnostics_channel', function(module, exports, require) {
    if (!globalThis.__plenum_diag_channels) globalThis.__plenum_diag_channels = {};
    var registry = globalThis.__plenum_diag_channels;

    function Channel(name) {
        this.name = name;
        this._subs = [];
    }
    Channel.prototype.publish = function(message) {
        for (var i = 0; i < this._subs.length; i++) {
            try { this._subs[i](message, this.name); }
            catch (_) { /* spec: swallow per subscriber */ }
        }
    };
    Channel.prototype.subscribe = function(onMessage) {
        if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');
        this._subs.push(onMessage);
    };
    Channel.prototype.unsubscribe = function(onMessage) {
        var i = this._subs.indexOf(onMessage);
        if (i === -1) return false;
        this._subs.splice(i, 1);
        return true;
    };
    Object.defineProperty(Channel.prototype, 'hasSubscribers', {
        get: function() { return this._subs.length > 0; },
    });
    Channel.prototype.bindStore = function() {};
    Channel.prototype.runStores = function(_data, fn, ctx) { return fn.call(ctx); };

    function channel(name) {
        var n = String(name);
        if (!registry[n]) registry[n] = new Channel(n);
        return registry[n];
    }
    function subscribe(name, onMessage) { channel(name).subscribe(onMessage); }
    function unsubscribe(name, onMessage) { return channel(name).unsubscribe(onMessage); }
    function hasSubscribers(name) { return channel(name).hasSubscribers; }

    function tracingChannel(prefix) {
        var p = (typeof prefix === 'string') ? prefix : 'tracing';
        return {
            start: channel(p + ':start'),
            end: channel(p + ':end'),
            asyncStart: channel(p + ':asyncStart'),
            asyncEnd: channel(p + ':asyncEnd'),
            error: channel(p + ':error'),
            traceSync: function(fn, ctx, _store, _thisArg, args) {
                this.start.publish({ self: ctx, args: args });
                try {
                    var r = fn.apply(ctx, args || []);
                    this.end.publish({ self: ctx, result: r });
                    return r;
                } catch (e) {
                    this.error.publish({ self: ctx, error: e });
                    throw e;
                }
            },
        };
    }

    module.exports = {
        Channel: Channel,
        channel: channel,
        subscribe: subscribe,
        unsubscribe: unsubscribe,
        hasSubscribers: hasSubscribers,
        tracingChannel: tracingChannel,
    };
});

// node:test / node:test/reporters — Node 18+ built-in test runner.
// Sandbox can't host the runner's child-process worker pool; we
// expose the API surface so libraries that conditionally import
// `node:test` for in-source tests don't crash. Minimal recorder
// runs synchronously in-process.
__register_module('test', function(module, exports, require) {
    var current = null;
    function describe(name, fn) {
        var prev = current;
        current = { name: name, children: [] };
        try { if (typeof fn === 'function') fn(); } finally { current = prev; }
    }
    function it(name, fn) {
        if (current) current.children.push({ name: name, fn: fn });
    }
    function test() {
        var args = [].slice.call(arguments);
        var name = (typeof args[0] === 'string') ? args.shift() : '<anonymous>';
        if (args[0] && typeof args[0] === 'object') args.shift();
        var fn = args[0];
        return Promise.resolve().then(function() {
            if (typeof fn === 'function') return fn({ name: name });
        });
    }
    test.describe = describe;
    test.it = it;
    test.test = test;
    test.suite = describe;
    test.before = function() {};
    test.after = function() {};
    test.beforeEach = function() {};
    test.afterEach = function() {};
    test.skip = function() {};
    test.todo = function() {};
    test.run = function() {
        return { [Symbol.asyncIterator]: function() {
            return { next: function() { return Promise.resolve({ value: undefined, done: true }); } };
        } };
    };
    test.mock = {
        method: function() {}, getter: function() {}, setter: function() {},
        timers: { enable: function() {}, reset: function() {}, tick: function() {} },
    };
    module.exports = test;
});
__register_module('test/reporters', function(module, exports, require) {
    var stream = require('stream');
    function makeReporter() {
        return new stream.Transform({
            transform: function(chunk, _enc, cb) { cb(null, chunk); },
        });
    }
    module.exports = {
        spec: makeReporter, tap: makeReporter, dot: makeReporter,
        junit: makeReporter, lcov: makeReporter,
    };
});

// sea (Single Executable Applications) — Node 21+. The sandbox is a
// sealed runtime, so SEA assets aren't applicable. Surface the API
// but report `isSea() === false` so callers fall through to their
// non-SEA path.
__register_module('sea', function(module, exports, require) {
    function notInSea(name) {
        return function() {
            throw Object.assign(
                new Error('sea.' + name + ': not running as SEA'),
                { code: 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION' }
            );
        };
    }
    module.exports = {
        isSea: function() { return false; },
        getAsset: notInSea('getAsset'),
        getAssetAsBlob: notInSea('getAssetAsBlob'),
        getRawAsset: notInSea('getRawAsset'),
    };
});

__register_module('timers/promises', function(module, exports, require) {
    module.exports = {
        setTimeout: function(ms, value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                var t = setTimeout(function() { resolve(value); }, ms);
                if (signal) {
                    signal.addEventListener('abort', function() {
                        clearTimeout(t);
                        reject(new Error('The operation was aborted'));
                    });
                }
            });
        },
        setImmediate: function(value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                setImmediate(function() { resolve(value); });
            });
        },
        // AsyncIterator surface for `setInterval(ms)` lands with
        // a consumer. Throw until then so scripts that reach for
        // it see a clear error rather than silently hanging.
        setInterval: function() {
            throw new Error('timers/promises.setInterval (async iterator) is not implemented');
        },
    };
});

// ---- os.js ----
// os — trivially backed by host globals. No Manifold gating.

__register_module('os', function(module, exports, require) {

    function fallback(name, def) {
        var fn = globalThis['__host_os_' + name];
        return typeof fn === 'function' ? fn() : def;
    }

    exports.platform  = function() { return fallback('platform',  'linux'); };
    exports.arch      = function() { return fallback('arch',      'x64'); };
    exports.hostname  = function() { return fallback('hostname',  'afterburner'); };
    exports.tmpdir    = function() { return fallback('tmpdir',    '/tmp'); };
    exports.homedir   = function() { return fallback('home_dir',  '/'); };
    exports.cpus      = function() {
        var n = fallback('cpus', 1);
        var out = [];
        for (var i = 0; i < n; i++) out.push({ model: 'afterburner', speed: 0 });
        return out;
    };
    exports.totalmem  = function() { return 0; };
    exports.freemem   = function() { return 0; };
    exports.uptime    = function() { return 0; };
    exports.EOL       = '\n';
    exports.type      = function() { return 'Linux'; };
    exports.release   = function() { return '0.0.0-afterburner'; };
    exports.endianness = function() { return 'LE'; };

    // Node's `os.constants`. Packagers (npm @npmcli/fs, fs-extra, pacote)
    // destructure `os.constants.errno.{EEXIST,ENOENT,…}` at module-init
    // time. Missing the table makes the destructure throw `Cannot
    // convert undefined or null to object`, which surfaces as an
    // unrelated-looking failure deep in npm's polyfill chain. Linux x86_64
    // numeric values, matched against Node's own table — they're a
    // fixed kernel ABI on Linux and the constants are read by name in
    // every script we've seen, so the numeric mismatch on other
    // platforms is harmless.
    var ERRNO = {
        E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99,
        EAFNOSUPPORT: 97, EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74,
        EBUSY: 16, ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103,
        ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
        EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27,
        EHOSTUNREACH: 113, EIDRM: 43, EILSEQ: 84, EINPROGRESS: 115,
        EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21, ELOOP: 40,
        EMFILE: 24, EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
        ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23,
        ENOBUFS: 105, ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8,
        ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92,
        ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107,
        ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25,
        ENXIO: 6, EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32,
        EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34,
        EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62,
        ETIMEDOUT: 110, ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
    };
    var SIGNALS = {
        SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
        SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11,
        SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17,
        SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
        SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
        SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30,
        SIGSYS: 31, SIGUNUSED: 31,
    };
    var PRIORITY = {
        PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
    };
    exports.constants = {
        UV_UDP_REUSEADDR: 4,
        dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 },
        errno: ERRNO,
        signals: SIGNALS,
        priority: PRIORITY,
    };

    // os.networkInterfaces(): Node exposes a per-interface object map.
    // npm's `npm-pick-manifest` calls it during prefix detection. Empty
    // map is the right "no enumerable interfaces" answer when we don't
    // surface them through the host bridge.
    exports.networkInterfaces = function() { return {}; };
    exports.userInfo = function(opts) {
        var enc = (opts && opts.encoding) || 'utf8';
        return {
            username: 'afterburner',
            uid: -1,
            gid: -1,
            shell: null,
            homedir: exports.homedir(),
        };
    };
    exports.loadavg     = function() { return [0, 0, 0]; };
    exports.machine     = function() { return fallback('arch', 'x86_64'); };
    exports.version     = function() { return exports.release(); };
    exports.devNull     = '/dev/null';
});

// ---- path.js ----
// path — POSIX subset. Good enough for the overwhelming majority of
// server-side and ETL scripts; win32 path handling is out of scope.

__register_module('path', function(module, exports, require) {
    var SEP = '/';

    function assertString(x) {
        if (typeof x !== 'string') {
            throw new TypeError("Path must be a string. Received " + typeof x);
        }
    }

    // Collapse `.`, `..`, and redundant separators. Mirrors Node's
    // `normalizeString` helper without bothering to distinguish win32.
    function normalizeString(path, allowAboveRoot) {
        var res = '';
        var lastSegmentLength = 0;
        var lastSlash = -1;
        var dots = 0;
        var code;
        for (var i = 0; i <= path.length; ++i) {
            if (i < path.length) code = path.charCodeAt(i);
            else if (code === 47) break;
            else code = 47;

            if (code === 47) { // '/'
                if (lastSlash === i - 1 || dots === 1) {
                    // no-op
                } else if (lastSlash !== i - 1 && dots === 2) {
                    if (res.length < 2 || lastSegmentLength !== 2 ||
                        res.charCodeAt(res.length - 1) !== 46 ||
                        res.charCodeAt(res.length - 2) !== 46) {
                        if (res.length > 2) {
                            var lastSlashIndex = res.lastIndexOf('/');
                            if (lastSlashIndex === -1) {
                                res = '';
                                lastSegmentLength = 0;
                            } else {
                                res = res.slice(0, lastSlashIndex);
                                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        } else if (res.length === 2 || res.length === 1) {
                            res = '';
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot) {
                        if (res.length > 0) res += '/..';
                        else res = '..';
                        lastSegmentLength = 2;
                    }
                } else {
                    if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
                    else res = path.slice(lastSlash + 1, i);
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            } else if (code === 46 && dots !== -1) {
                ++dots;
            } else {
                dots = -1;
            }
        }
        return res;
    }

    exports.sep = SEP;
    exports.delimiter = ':';

    exports.normalize = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var isAbs = p.charCodeAt(0) === 47;
        var trailingSep = p.charCodeAt(p.length - 1) === 47;
        p = normalizeString(p, !isAbs);
        if (p.length === 0 && !isAbs) p = '.';
        if (p.length > 0 && trailingSep) p += '/';
        return isAbs ? '/' + p : p;
    };

    exports.isAbsolute = function(p) {
        assertString(p);
        return p.length > 0 && p.charCodeAt(0) === 47;
    };

    exports.join = function() {
        if (arguments.length === 0) return '.';
        var joined;
        for (var i = 0; i < arguments.length; ++i) {
            var arg = arguments[i];
            assertString(arg);
            if (arg.length > 0) {
                if (joined === undefined) joined = arg;
                else joined += '/' + arg;
            }
        }
        if (joined === undefined) return '.';
        return exports.normalize(joined);
    };

    exports.resolve = function() {
        var resolved = '';
        var resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var p = (i >= 0) ? arguments[i] : '/';
            assertString(p);
            if (p.length === 0) continue;
            resolved = p + '/' + resolved;
            resolvedAbsolute = p.charCodeAt(0) === 47;
        }
        resolved = normalizeString(resolved, !resolvedAbsolute);
        if (resolvedAbsolute) return '/' + resolved;
        return resolved.length > 0 ? resolved : '.';
    };

    exports.dirname = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var hasRoot = p.charCodeAt(0) === 47;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 1; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { end = i; break; }
            } else {
                matchedSlash = false;
            }
        }
        if (end === -1) return hasRoot ? '/' : '.';
        if (hasRoot && end === 1) return '//';
        return p.slice(0, end);
    };

    // path.relative(from, to) — express the relative path from one
    // absolute path to another. arborist's `relpath`, every workspace
    // resolver, every test runner, and most build tools depend on
    // this. Algorithm matches Node's implementation: resolve both
    // arguments, find the common prefix, walk back from `from` and
    // forward to `to`.
    exports.relative = function(from, to) {
        assertString(from);
        assertString(to);
        if (from === to) return '';
        from = exports.resolve(from);
        to = exports.resolve(to);
        if (from === to) return '';
        // Trim leading slashes for the segment scan; we know both are
        // absolute after `resolve`.
        var fromSegs = from.slice(1).split('/').filter(function(s) { return s.length; });
        var toSegs = to.slice(1).split('/').filter(function(s) { return s.length; });
        var common = 0;
        var max = Math.min(fromSegs.length, toSegs.length);
        while (common < max && fromSegs[common] === toSegs[common]) common++;
        var up = fromSegs.length - common;
        var rest = toSegs.slice(common);
        var out = [];
        for (var i = 0; i < up; i++) out.push('..');
        for (var j = 0; j < rest.length; j++) out.push(rest[j]);
        return out.join('/') || '.';
    };

    exports.basename = function(p, ext) {
        assertString(p);
        if (ext !== undefined) assertString(ext);
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 0; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { start = i + 1; break; }
            } else if (end === -1) {
                matchedSlash = false;
                end = i + 1;
            }
        }
        if (end === -1) return '';
        var base = p.slice(start, end);
        if (ext && base.length >= ext.length && base.slice(base.length - ext.length) === ext) {
            base = base.slice(0, base.length - ext.length);
        }
        return base;
    };

    exports.extname = function(p) {
        assertString(p);
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var preDotState = 0;
        for (var i = p.length - 1; i >= 0; --i) {
            var code = p.charCodeAt(i);
            if (code === 47) {
                if (!matchedSlash) { startPart = i + 1; break; }
                continue;
            }
            if (end === -1) { matchedSlash = false; end = i + 1; }
            if (code === 46) {
                if (startDot === -1) startDot = i;
                else if (preDotState !== 1) preDotState = 1;
            } else if (startDot !== -1) {
                preDotState = -1;
            }
        }
        if (startDot === -1 || end === -1 || preDotState === 0 ||
            (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
            return '';
        }
        return p.slice(startDot, end);
    };

    exports.parse = function(p) {
        assertString(p);
        var ret = { root: '', dir: '', base: '', ext: '', name: '' };
        if (p.length === 0) return ret;
        var isAbs = p.charCodeAt(0) === 47;
        if (isAbs) ret.root = '/';
        var base = exports.basename(p);
        var dir = exports.dirname(p);
        ret.dir = isAbs && dir === '/' ? '/' : dir === '.' && !isAbs ? '' : dir;
        ret.base = base;
        ret.ext = exports.extname(base);
        ret.name = ret.ext.length > 0 ? base.slice(0, base.length - ret.ext.length) : base;
        return ret;
    };

    exports.format = function(obj) {
        if (obj === null || typeof obj !== 'object') {
            throw new TypeError('path.format requires an object');
        }
        var dir = obj.dir || obj.root || '';
        var base = obj.base || ((obj.name || '') + (obj.ext || ''));
        if (!dir) return base;
        if (dir === obj.root) return dir + base;
        return dir + '/' + base;
    };

    exports.posix = exports;

    // path.win32 — Node always exposes both flavours; many libraries
    // (npm's `tar`, fs-extra, archive utilities) reach for
    // `require('path').win32.{isAbsolute,parse}` to normalise paths
    // even on Linux. We provide a Windows-shaped twin: backslash is
    // an additional separator, drive letters are recognised as
    // absolute (`c:/foo`, `\\?\drive\...`), and the rest of the
    // surface mirrors POSIX with `\\` separators.
    var win32 = {};
    win32.sep = '\\';
    win32.delimiter = ';';
    win32.posix = exports;
    win32.win32 = win32;
    function _winSplit(p) {
        return String(p).replace(/\//g, '\\').split('\\').filter(function(s) { return s.length > 0 || false; });
    }
    win32.isAbsolute = function(p) {
        var s = String(p);
        if (s.length === 0) return false;
        if (s.charAt(0) === '/' || s.charAt(0) === '\\') return true;
        // c:/foo or c:\foo
        if (s.length >= 3 && /^[a-z]:[\/\\]/i.test(s)) return true;
        // c:foo (drive-relative — not absolute, but Node treats some
        // shapes as absolute. Conservative: false here.)
        return false;
    };
    win32.normalize = function(p) {
        var s = String(p).replace(/\//g, '\\');
        // Drive letter detection.
        var rootMatch = /^([a-z]:)?[\\\\]?/i.exec(s);
        var drive = rootMatch && rootMatch[1] ? rootMatch[1] : '';
        var rooted = /^([a-z]:)?[\\]/i.test(s);
        var rest = s.slice((drive.length) + (rooted ? 1 : 0));
        var parts = rest.split('\\').filter(function(p) { return p && p !== '.'; });
        var stack = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '..') {
                if (stack.length && stack[stack.length-1] !== '..') stack.pop();
                else if (!rooted) stack.push('..');
            } else { stack.push(parts[i]); }
        }
        return drive + (rooted ? '\\' : '') + stack.join('\\');
    };
    win32.join = function() {
        var args = [].slice.call(arguments).filter(function(a) { return a && a.length; });
        if (args.length === 0) return '.';
        return win32.normalize(args.join('\\'));
    };
    win32.resolve = function() {
        var args = [].slice.call(arguments);
        var resolved = '';
        for (var i = args.length - 1; i >= -1; i--) {
            var p = (i >= 0) ? args[i] : '\\';
            if (!p || p.length === 0) continue;
            resolved = p + '\\' + resolved;
            if (win32.isAbsolute(p)) break;
        }
        return win32.normalize(resolved);
    };
    win32.dirname = function(p) {
        var s = String(p).replace(/\//g, '\\');
        var idx = s.lastIndexOf('\\');
        if (idx < 0) return '.';
        if (idx === 0) return '\\';
        return s.slice(0, idx);
    };
    win32.basename = function(p, ext) {
        var s = String(p).replace(/\//g, '\\');
        var idx = s.lastIndexOf('\\');
        var base = idx >= 0 ? s.slice(idx + 1) : s;
        if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
        return base;
    };
    win32.extname = function(p) {
        var b = win32.basename(p);
        var idx = b.lastIndexOf('.');
        if (idx <= 0) return '';
        return b.slice(idx);
    };
    win32.parse = function(p) {
        var s = String(p).replace(/\//g, '\\');
        var ret = { root: '', dir: '', base: '', ext: '', name: '' };
        // Detect drive root.
        var driveMatch = /^([a-z]:)([\\]?)/i.exec(s);
        if (driveMatch) {
            ret.root = driveMatch[1] + (driveMatch[2] || '');
        } else if (s.charAt(0) === '\\') {
            ret.root = '\\';
        }
        ret.base = win32.basename(p);
        ret.dir = win32.dirname(p);
        ret.ext = win32.extname(ret.base);
        ret.name = ret.ext ? ret.base.slice(0, ret.base.length - ret.ext.length) : ret.base;
        return ret;
    };
    win32.format = function(obj) {
        var dir = obj.dir || obj.root || '';
        var base = obj.base || ((obj.name || '') + (obj.ext || ''));
        if (!dir) return base;
        if (dir === obj.root) return dir + base;
        return dir + '\\' + base;
    };
    win32.toNamespacedPath = function(p) { return String(p); };
    win32.relative = function(from, to) {
        from = win32.resolve(String(from));
        to = win32.resolve(String(to));
        if (from === to) return '';
        var fromSegs = from.split('\\').filter(function(s) { return s.length; });
        var toSegs = to.split('\\').filter(function(s) { return s.length; });
        var common = 0;
        var max = Math.min(fromSegs.length, toSegs.length);
        while (common < max && fromSegs[common].toLowerCase() === toSegs[common].toLowerCase()) common++;
        var up = fromSegs.length - common;
        var rest = toSegs.slice(common);
        var out = [];
        for (var i = 0; i < up; i++) out.push('..');
        for (var j = 0; j < rest.length; j++) out.push(rest[j]);
        return out.join('\\') || '.';
    };
    win32.matchesGlob = function(p, pattern) {
        var re = new RegExp('^' + String(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$');
        return re.test(String(p));
    };
    exports.win32 = win32;

    // Posix-side `toNamespacedPath` and `matchesGlob` (Node 22+).
    exports.toNamespacedPath = function(p) { return String(p); };
    exports.matchesGlob = function(p, pattern) {
        var re = new RegExp('^' + String(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$');
        return re.test(String(p));
    };
});

// ---- perf_hooks.js ----
// perf_hooks — Node 20's performance-measurement API.
//
// Most callers use `performance.now()` (already a global) +
// `performance.mark` / `measure`. We provide a real implementation
// of those plus the supporting classes so production code drops in
// without modification.

__register_module('perf_hooks', function(module, exports, require) {

    // Global `performance` is installed by `web_compat.js`. Reuse it
    // so the two surfaces stay in lock-step (common pattern: scripts
    // import perf_hooks.performance but expect `globalThis.performance`
    // to point at the same object).
    var performance = globalThis.performance || {
        now: function() { return Date.now(); },
        timeOrigin: Date.now(),
    };

    // ---- PerformanceEntry ------------------------------------------

    function PerformanceEntry(name, entryType, startTime, duration) {
        this.name = name;
        this.entryType = entryType;
        this.startTime = startTime;
        this.duration = duration;
    }
    PerformanceEntry.prototype.toJSON = function() {
        return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
        };
    };

    // ---- in-memory entry buffer -----------------------------------

    var entries = [];
    var marks = Object.create(null);

    function addEntry(entry) {
        entries.push(entry);
    }

    // ---- Performance methods --------------------------------------
    //
    // We extend the bare `globalThis.performance` with the full
    // perf_hooks surface. Idempotent — re-installing doesn't reset
    // any pre-recorded marks.

    if (typeof performance.mark !== 'function') {
        performance.mark = function(name, options) {
            var detail = options && options.detail;
            var startTime = performance.now();
            var entry = new PerformanceEntry(String(name), 'mark', startTime, 0);
            entry.detail = detail || null;
            marks[String(name)] = entry;
            addEntry(entry);
            return entry;
        };
    }
    if (typeof performance.measure !== 'function') {
        performance.measure = function(name, startMarkOrOptions, endMark) {
            var startMark, endMarkName, detail;
            if (typeof startMarkOrOptions === 'object' && startMarkOrOptions !== null) {
                startMark = startMarkOrOptions.start;
                endMarkName = startMarkOrOptions.end;
                detail = startMarkOrOptions.detail;
            } else {
                startMark = startMarkOrOptions;
                endMarkName = endMark;
            }
            var startTime = startMark
                ? (marks[startMark] && marks[startMark].startTime) || 0
                : 0;
            var endTime = endMarkName
                ? (marks[endMarkName] && marks[endMarkName].startTime) || performance.now()
                : performance.now();
            var entry = new PerformanceEntry(
                String(name), 'measure', startTime, Math.max(0, endTime - startTime)
            );
            entry.detail = detail || null;
            addEntry(entry);
            return entry;
        };
    }
    if (typeof performance.clearMarks !== 'function') {
        performance.clearMarks = function(name) {
            if (name === undefined) {
                marks = Object.create(null);
                entries = entries.filter(function(e) { return e.entryType !== 'mark'; });
            } else {
                delete marks[String(name)];
                entries = entries.filter(function(e) {
                    return !(e.entryType === 'mark' && e.name === name);
                });
            }
        };
    }
    if (typeof performance.clearMeasures !== 'function') {
        performance.clearMeasures = function(name) {
            entries = entries.filter(function(e) {
                if (e.entryType !== 'measure') return true;
                return name !== undefined && e.name !== name;
            });
        };
    }
    if (typeof performance.getEntries !== 'function') {
        performance.getEntries = function() { return entries.slice(); };
    }
    if (typeof performance.getEntriesByName !== 'function') {
        performance.getEntriesByName = function(name, type) {
            return entries.filter(function(e) {
                if (e.name !== name) return false;
                return type === undefined || e.entryType === type;
            });
        };
    }
    if (typeof performance.getEntriesByType !== 'function') {
        performance.getEntriesByType = function(type) {
            return entries.filter(function(e) { return e.entryType === type; });
        };
    }

    // ---- PerformanceObserver --------------------------------------
    //
    // No event loop in the sandbox: observer callbacks fire
    // synchronously when `observe()` runs. Real Node defers them
    // to the next tick; the polyfill matches the API but folds the
    // dispatch into the immediate call so callers don't need to
    // tick the loop themselves.

    function PerformanceObserver(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('PerformanceObserver: callback must be a function');
        }
        this._callback = callback;
        this._observed = [];
        this._buffered = false;
    }
    PerformanceObserver.prototype.observe = function(opts) {
        opts = opts || {};
        var types = opts.entryTypes || (opts.type ? [opts.type] : []);
        this._observed = types.slice();
        this._buffered = !!opts.buffered;
        // Spec: when `buffered` is true, replay matching prior entries.
        if (this._buffered) {
            var matched = entries.filter(function(e) {
                return types.indexOf(e.entryType) !== -1;
            });
            if (matched.length) {
                this._callback(
                    { getEntries: function() { return matched.slice(); } },
                    this
                );
            }
        }
    };
    PerformanceObserver.prototype.disconnect = function() {
        this._observed = [];
    };
    PerformanceObserver.prototype.takeRecords = function() {
        var observed = this._observed;
        var taken = entries.filter(function(e) {
            return observed.indexOf(e.entryType) !== -1;
        });
        return taken;
    };
    PerformanceObserver.supportedEntryTypes = ['mark', 'measure'];

    function monitorEventLoopDelay() {
        // Sandbox has no event loop; return a stub that always
        // reports zero delay. Node's API is preserved so callers
        // can still .reset() / .disable() / .enable() without crashing.
        var hist = {
            min: 0, max: 0, mean: 0, stddev: 0, percentile: function() { return 0; },
            percentiles: new Map(), exceeds: 0, count: 0,
            enable: function() {}, disable: function() {}, reset: function() {},
        };
        return hist;
    }

    function createHistogram(opts) {
        var lowest = (opts && opts.lowest) || 1;
        var highest = (opts && opts.highest) || 9007199254740991; // 2^53 - 1
        var count = 0, sum = 0, min = highest, max = lowest;
        return {
            min: min, max: max, mean: 0, stddev: 0, count: count,
            record: function(v) {
                count++; sum += v;
                if (v < min) min = v;
                if (v > max) max = v;
            },
            recordDelta: function() {},
            reset: function() { count = 0; sum = 0; min = highest; max = lowest; },
            percentile: function() { return 0; },
            get percentiles() { return new Map(); },
        };
    }

    // ---- exports --------------------------------------------------

    exports.performance = performance;
    exports.PerformanceEntry = PerformanceEntry;
    exports.PerformanceObserver = PerformanceObserver;
    exports.PerformanceObserverEntryList = PerformanceObserver; // alias
    exports.PerformanceMeasure = PerformanceEntry;
    exports.PerformanceMark = PerformanceEntry;
    exports.PerformanceResourceTiming = PerformanceEntry;
    exports.constants = {
        NODE_PERFORMANCE_GC_MAJOR: 4,
        NODE_PERFORMANCE_GC_MINOR: 1,
        NODE_PERFORMANCE_GC_INCREMENTAL: 8,
        NODE_PERFORMANCE_GC_WEAKCB: 16,
    };
    exports.monitorEventLoopDelay = monitorEventLoopDelay;
    exports.createHistogram = createHistogram;

    // Default export — Node lets callers do `import perf from 'perf_hooks'`.
    module.exports = exports;
});

// ---- process.js ----
// process — eager-installed as `globalThis.process` and registered as
// the CommonJS `process` module. Acts as an EventEmitter so scripts
// using `process.on('exit', …)` etc. do not blow up.
//
// The IIFE runs at bundle-load time so `globalThis.process` is set
// regardless of whether the user script ever calls `require('process')`.

(function bootstrapProcess() {
    // EventEmitter is provided by events.js; we lookup directly from
    // the require resolver since this runs before user code.
    var EventEmitter = require('events');

    // `__host_env` / `__ab_argv` are installed per-thrust by script
    // mode (see plugin's modes/script.rs). Both globals are absent in
    // UDF mode, which is intentional — UDF scripts only see their
    // `data` input.
    var hostEnv = globalThis.__host_env || {};
    var argv    = globalThis.__ab_argv   || ['afterburner'];
    var proc = Object.create(EventEmitter.prototype);
    EventEmitter.call(proc);

    var fields = {
        platform: globalThis.__host_platform || 'linux',
        arch:     globalThis.__host_arch     || 'x64',
        // We claim Node 26 (latest stable, the project's target). Most
        // libraries gate features on numeric ranges (`>=18.17.0`,
        // `>=20.5.0`, `>=22.0.0`) — claiming the current major
        // version unblocks every reasonable engines check while
        // still surfacing the `-afterburner` suffix so version-aware
        // code paths (rare) can detect us.
        version:  'v26.0.0-afterburner',
        versions: { node: '26.0.0', v8: '13.0.0.0', afterburner: '0.1.0' },
        env:      hostEnv,
        argv:     argv,
        execPath: '/usr/bin/afterburner',
        pid:      1,
        title:    'afterburner',

        cwd:      function() { return globalThis.__host_cwd || '/'; },
        chdir:    function() { throw new Error('process.chdir is not supported'); },

        // `umask([mask])` — Node returns the previous mask; with an
        // arg, sets it. Sandbox doesn't surface umask through the
        // bridge; return a sensible default and accept (silent) the
        // setter call. Node reduced the deprecation noise around
        // calling umask() with no args; we mirror that.
        umask:    function(_mask) { return 0o022; },

        // `process.getuid` / `getgid` / `geteuid` / `getegid` — POSIX
        // identity functions. Sandbox returns 0 for everything; some
        // libraries (npm install, sqlite open) probe these to decide
        // whether to drop privileges.
        getuid:   function() { return 0; },
        getgid:   function() { return 0; },
        geteuid:  function() { return 0; },
        getegid:  function() { return 0; },
        getgroups: function() { return [0]; },
        // `setuid`/`setgid` — sandbox doesn't allow privilege change.
        // Throw a Node-style typed error so callers can fall through.
        setuid:   function() { var e = new Error('setuid not supported'); e.code = 'EPERM'; throw e; },
        setgid:   function() { var e = new Error('setgid not supported'); e.code = 'EPERM'; throw e; },
        seteuid:  function() { var e = new Error('seteuid not supported'); e.code = 'EPERM'; throw e; },
        setegid:  function() { var e = new Error('setegid not supported'); e.code = 'EPERM'; throw e; },
        setgroups: function() { var e = new Error('setgroups not supported'); e.code = 'EPERM'; throw e; },

        // Node 18+ `process.permission` / `process.constrainedMemory`
        // / `process.availableMemory` — light probe surface that
        // libraries (express's inspector, nodemon) check at module
        // init.
        constrainedMemory:  function() { return 0; },
        availableMemory:    function() { return 0; },
        memoryUsage:        Object.assign(function() {
            return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
        }, { rss: function() { return 0; } }),
        // Node 24+ `process.threadCpuUsage` — return a zeroed object.
        threadCpuUsage:     function() { return { user: 0, system: 0 }; },
        cpuUsage:           function(_prev) { return { user: 0, system: 0 }; },
        resourceUsage:      function() {
            return {
                userCPUTime: 0, systemCPUTime: 0, maxRSS: 0,
                sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
                minorPageFault: 0, majorPageFault: 0, swappedOut: 0,
                fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0,
                signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
            };
        },
        // process.loadEnvFile (Node 20.6+). The CLI's `--env-file`
        // already loads at startup; this in-process call parses
        // additional files at runtime and merges into `process.env`.
        loadEnvFile: function(path) {
            var p = path || '.env';
            try {
                var fs = require('fs');
                var text = fs.readFileSync(p, 'utf8');
                var lines = text.split(/\r?\n/);
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || line.charAt(0) === '#') continue;
                    var eq = line.indexOf('=');
                    if (eq < 0) continue;
                    var k = line.slice(0, eq).trim();
                    if (!k) continue;
                    var v = line.slice(eq + 1).trim();
                    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') ||
                                          (v[0] === "'" && v[v.length - 1] === "'"))) {
                        v = v.slice(1, -1);
                    }
                    if (globalThis.process && globalThis.process.env) {
                        globalThis.process.env[k] = v;
                    }
                }
            } catch (e) {
                var err = new Error('Cannot read environment file: ' + p);
                err.code = 'ENOENT';
                throw err;
            }
        },
        // process.permission — Node 20.x experimental. When the CLI
        // launched without `--permission` we keep the always-allow
        // posture (manifold layer is the real gate). With
        // `--permission` set, the host populates
        // `globalThis.__ab_permission_grants` with a map of granted
        // scopes; `has()` consults that, defaulting to false for
        // unmentioned scopes — matching Node's deny-by-default model.
        permission: {
            has: function(scope, ref) {
                var g = globalThis.__ab_permission_grants;
                if (!g) return true; // permission model not active → allow
                if (!Object.prototype.hasOwnProperty.call(g, scope)) return false;
                var v = g[scope];
                if (v === true) return true;
                if (typeof v === 'string') {
                    if (!ref) return true;
                    var allow = v.split(',').map(function(s) { return s.trim(); });
                    for (var i = 0; i < allow.length; i++) {
                        if (allow[i] === '*' || allow[i] === ref) return true;
                        // Glob-prefix support for fs paths and net
                        // host:port.
                        if (allow[i].indexOf('*') === 0 &&
                            ref.endsWith(allow[i].slice(1))) return true;
                        if (ref.indexOf(allow[i]) === 0) return true;
                    }
                    return false;
                }
                return false;
            },
            get: function() {
                var g = globalThis.__ab_permission_grants;
                if (!g) return { fs: { read: true, write: true }, net: true, env: true,
                                 child_process: true, worker: true };
                return {
                    fs: {
                        read: g['fs.read'] !== undefined,
                        write: g['fs.write'] !== undefined,
                    },
                    net: !!g['net'],
                    env: !!g['env'],
                    child_process: !!g['child_process'],
                    worker: !!g['worker'],
                };
            },
        },

        // Real Node drains the nextTick queue synchronously between
        // each macrotask but BEFORE the microtask queue. Express's
        // `finalhandler` (the 404/500 fallback) defers its response
        // with `process.nextTick`, expecting middleware that called
        // `next(err)` to run first. The pre-fix synchronous-call
        // implementation broke that ordering: a nextTick scheduled
        // from inside a Promise microtask ran INSIDE the microtask
        // instead of after it.
        //
        // We approximate Node's semantics by queueing nextTick
        // callbacks into `__ntQueue` and draining via a single
        // `queueMicrotask`. Microtask order is FIFO, so a nextTick
        // scheduled in current sync code runs before any user
        // `Promise.then` queued AFTER it. Exceptions in a nextTick
        // callback are caught + logged so a single failure doesn't
        // poison the rest of the queue (Node's behaviour: emit
        // `uncaughtException` and continue; we surface to console
        // until we wire a real uncaughtException emitter).
        //
        // Caveat: nested nextTicks (callback A queues callback B)
        // run on the *next* drain pass here, not the same one. Real
        // Node has an inner/outer queue that drains nested ticks
        // greedily before the microtask queue. Document the
        // divergence; revisit if a real workload hits it.
        nextTick: function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            var args = Array.prototype.slice.call(arguments, 1);
            if (!globalThis.__ntQueue) globalThis.__ntQueue = [];
            globalThis.__ntQueue.push({ fn: fn, args: args });
            if (!globalThis.__ntScheduled) {
                globalThis.__ntScheduled = true;
                queueMicrotask(function drainNT() {
                    var queue = globalThis.__ntQueue;
                    globalThis.__ntQueue = [];
                    globalThis.__ntScheduled = false;
                    for (var i = 0; i < queue.length; i++) {
                        var item = queue[i];
                        try {
                            item.fn.apply(null, item.args);
                        } catch (e) {
                            // Per Node convention, exceptions in
                            // nextTick callbacks emit
                            // `uncaughtException`. Until that's
                            // wired, log + continue so the rest of
                            // the queue still runs.
                            if (globalThis.console && globalThis.console.error) {
                                globalThis.console.error('Uncaught (in nextTick): ' + (e && e.stack || e));
                            }
                        }
                    }
                });
            }
        },

        exit: function(code) {
            try { proc.emit('exit', code || 0); } catch (_) {}
            if (globalThis.__host_process_exit) globalThis.__host_process_exit(code || 0);
            var err = new Error('process.exit(' + (code || 0) + ')');
            err.code = 'ERR_PROCESS_EXIT';
            err.exitCode = code || 0;
            throw err;
        },

        hrtime: function(prev) {
            var now = Date.now();
            var seconds = Math.floor(now / 1000);
            var nanos = (now % 1000) * 1e6;
            if (prev) {
                var ds = seconds - prev[0];
                var dn = nanos - prev[1];
                if (dn < 0) { ds -= 1; dn += 1e9; }
                return [ds, dn];
            }
            return [seconds, nanos];
        },

        stdout: { write: function(s) { if (globalThis.console) console.log(String(s)); return true; } },
        stderr: { write: function(s) { if (globalThis.console) console.error(String(s)); return true; } },
        stdin:  { on: function() {}, read: function() { return null; } },

        // `process.binding(name)` is Node's internal hook for native
        // bindings (e.g. `process.binding('uv')`, `'tcp_wrap'`,
        // `'fs_event_wrap'`). They expose libuv-side primitives
        // that have no analogue in the WASM sandbox. Surface a
        // clear error that names the requested binding so users
        // can identify which library is reaching for an
        // unsupported internal.
        binding: function(name) {
            var which = typeof name === 'string' ? name : String(name);
            // Return narrow stubs for the bindings real-world libraries
            // probe at module-init for limit/feature flags — eager
            // throws here break safer-buffer / fs-minipass / pacote at
            // module load, which is far enough from any actual native
            // primitive use that the user has no way to act on the
            // error. Keep the throw for everything else so honest
            // libuv consumers (rare in the sandbox) still surface a
            // typed error pointing at the missing binding.
            switch (which) {
                case 'buffer':
                    return {
                        kStringMaxLength: 0x3fffffe7,        // ~1 GiB - 8
                        kMaxLength:       0x7fffffff,        // INT32_MAX
                    };
                case 'fs':
                    // fs-minipass gates a libuv fallback on
                    // `!fs.writev`. We provide writev now, so the
                    // binding is dead code; an empty object lets the
                    // module-init `process.binding('fs')` complete
                    // without exposing any libuv methods.
                    return {};
                case 'constants':
                    // Return the merged fs+os+crypto constants so
                    // legacy `require('process').binding('constants')`
                    // gets a usable map (Node had this for years).
                    try {
                        var c = {};
                        var fs = require('fs');
                        var os = require('os');
                        if (fs && fs.constants) Object.assign(c, fs.constants);
                        if (os && os.constants) {
                            if (os.constants.errno) Object.assign(c, os.constants.errno);
                            if (os.constants.signals) Object.assign(c, os.constants.signals);
                        }
                        return c;
                    } catch (_) { return {}; }
            }
            var err = new Error(
                "process.binding('" + which + "') is not supported in the " +
                "Afterburner sandbox: native bindings (libuv internals and " +
                ".node addons) require executing native machine code, which " +
                "the WASM sandbox cannot do by design (different ISA from " +
                "the bytecode the runtime executes)."
            );
            err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
            err.bindingName = which;
            throw err;
        },

        // Same surface as `process.binding` but for the post-Node-16
        // internal-only API.
        _linkedBinding: function(name) {
            var err = new Error(
                "process._linkedBinding('" + String(name) + "') is not " +
                "supported in the Afterburner sandbox"
            );
            err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
            err.bindingName = String(name);
            throw err;
        }
    };

    fields.hrtime.bigint = function() {
        var t = fields.hrtime();
        return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
    };

    Object.keys(fields).forEach(function(k) { proc[k] = fields[k]; });

    globalThis.process = proc;
    __register_host_module('process', proc);
})();

// ---- punycode.js ----
// punycode — RFC 3492 implementation.
// Adapted from Mathias Bynens' `punycode.js` (MIT) — kept small and
// hand-audited rather than pulled in as a dependency.

__register_module('punycode', function(module, exports, require) {

    var maxInt = 2147483647;
    var base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    var initialBias = 72, initialN = 128;
    var delimiter = '-';

    function adapt(delta, numPoints, firstTime) {
        delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
        delta += Math.floor(delta / numPoints);
        var k = 0;
        while (delta > ((base - tMin) * tMax) >> 1) {
            delta = Math.floor(delta / (base - tMin));
            k += base;
        }
        return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
    }

    function digitToBasic(digit) {
        return digit + 22 + 75 * (digit < 26 ? 1 : 0);
    }

    function basicToDigit(codePoint) {
        if (codePoint - 48 < 10) return codePoint - 22;
        if (codePoint - 65 < 26) return codePoint - 65;
        if (codePoint - 97 < 26) return codePoint - 97;
        return base;
    }

    function ucs2decode(str) {
        var out = [];
        var i = 0;
        while (i < str.length) {
            var value = str.charCodeAt(i++);
            if (value >= 0xD800 && value <= 0xDBFF && i < str.length) {
                var extra = str.charCodeAt(i++);
                if ((extra & 0xFC00) === 0xDC00) {
                    out.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                    out.push(value);
                    i--;
                }
            } else {
                out.push(value);
            }
        }
        return out;
    }

    function ucs2encode(arr) {
        var out = '';
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v > 0xFFFF) {
                v -= 0x10000;
                out += String.fromCharCode((v >>> 10) & 0x3FF | 0xD800);
                v = 0xDC00 | (v & 0x3FF);
            }
            out += String.fromCharCode(v);
        }
        return out;
    }

    function encode(input) {
        var inputArr = ucs2decode(input);
        var n = initialN;
        var delta = 0;
        var bias = initialBias;
        var output = [];

        for (var i = 0; i < inputArr.length; i++) {
            if (inputArr[i] < 0x80) output.push(String.fromCharCode(inputArr[i]));
        }
        var basicLength = output.length;
        var handledCPCount = basicLength;

        if (basicLength) output.push(delimiter);

        while (handledCPCount < inputArr.length) {
            var m = maxInt;
            for (var j = 0; j < inputArr.length; j++) {
                if (inputArr[j] >= n && inputArr[j] < m) m = inputArr[j];
            }
            delta += (m - n) * (handledCPCount + 1);
            n = m;
            for (var k = 0; k < inputArr.length; k++) {
                var cp = inputArr[k];
                if (cp < n) delta++;
                if (cp === n) {
                    var q = delta;
                    for (var t, w = base; ; w += base) {
                        t = w <= bias ? tMin : (w >= bias + tMax ? tMax : w - bias);
                        if (q < t) break;
                        output.push(String.fromCharCode(digitToBasic(t + (q - t) % (base - t))));
                        q = Math.floor((q - t) / (base - t));
                    }
                    output.push(String.fromCharCode(digitToBasic(q)));
                    bias = adapt(delta, handledCPCount + 1, handledCPCount === basicLength);
                    delta = 0;
                    handledCPCount++;
                }
            }
            delta++;
            n++;
        }
        return output.join('');
    }

    function decode(input) {
        var output = [];
        var i = 0, n = initialN, bias = initialBias;
        var basic = input.lastIndexOf(delimiter);
        if (basic < 0) basic = 0;
        for (var j = 0; j < basic; j++) {
            var c = input.charCodeAt(j);
            if (c >= 0x80) throw new RangeError('Invalid input');
            output.push(c);
        }
        var idx = basic > 0 ? basic + 1 : 0;
        while (idx < input.length) {
            var oldi = i;
            for (var w = 1, k = base; ; k += base) {
                if (idx >= input.length) throw new RangeError('Invalid input');
                var digit = basicToDigit(input.charCodeAt(idx++));
                if (digit >= base || digit > Math.floor((maxInt - i) / w)) throw new RangeError('Overflow');
                i += digit * w;
                var t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                if (digit < t) break;
                w *= (base - t);
            }
            var outLen = output.length + 1;
            bias = adapt(i - oldi, outLen, oldi === 0);
            if (Math.floor(i / outLen) > maxInt - n) throw new RangeError('Overflow');
            n += Math.floor(i / outLen);
            i %= outLen;
            output.splice(i++, 0, n);
        }
        return ucs2encode(output);
    }

    function toASCII(input) {
        return input.replace(/[^\0-\x7E]/, function() { return 'xn--' + encode(input); });
    }
    function toUnicode(input) {
        if (input.indexOf('xn--') === 0) return decode(input.slice(4));
        return input;
    }

    exports.encode = encode;
    exports.decode = decode;
    exports.toASCII = toASCII;
    exports.toUnicode = toUnicode;
    exports.ucs2 = { encode: ucs2encode, decode: ucs2decode };
    exports.version = '2.1.1-polyfill';
});

// ---- querystring.js ----
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

// ---- readline.js ----
// readline — Node 20's line reader. The module is normally used to
// prompt for stdin input (`createInterface({input: process.stdin})`)
// and parse it into discrete lines. Burn's stdin is one-shot via
// the script invocation, but the surface is what library code
// expects to import. We provide a real EventEmitter that emits
// 'line' / 'close' synchronously when the user feeds chunks via
// the readable's `on('data')` events.

__register_module('readline', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function Interface(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.input = opts.input;
        this.output = opts.output;
        this._buffer = '';
        this._closed = false;

        if (this.input && typeof this.input.on === 'function') {
            var self = this;
            this.input.on('data', function(chunk) { self._consume(chunk); });
            this.input.on('end', function() { self.close(); });
            this.input.on('close', function() { self.close(); });
        }
    }
    Interface.prototype = Object.create(EventEmitter.prototype);
    Interface.prototype.constructor = Interface;

    Interface.prototype._consume = function(chunk) {
        if (this._closed) return;
        var text;
        if (typeof chunk === 'string') text = chunk;
        else if (chunk && chunk.toString) text = chunk.toString('utf8');
        else return;
        this._buffer += text;
        var nl;
        while ((nl = this._buffer.indexOf('\n')) !== -1) {
            var line = this._buffer.slice(0, nl);
            this._buffer = this._buffer.slice(nl + 1);
            // Strip trailing `\r` for Windows-style line endings.
            if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                line = line.slice(0, -1);
            }
            try { this.emit('line', line); } catch (_) {}
        }
    };

    Interface.prototype.close = function() {
        if (this._closed) return;
        this._closed = true;
        // Flush any trailing buffered content as a final line.
        if (this._buffer.length > 0) {
            var last = this._buffer;
            this._buffer = '';
            try { this.emit('line', last); } catch (_) {}
        }
        try { this.emit('close'); } catch (_) {}
    };

    Interface.prototype.question = function(query, callback) {
        // No interactive stdin in the sandbox: we can't actually
        // wait for the user. Surface a clear error rather than
        // hanging.
        var err = new Error(
            'readline.question: interactive prompts are not supported in the ' +
            'Afterburner sandbox (no TTY); pass scripted input via input streams.'
        );
        err.code = 'ERR_NO_TTY';
        if (typeof callback === 'function') Promise.resolve().then(function() { callback(query); });
        throw err;
    };

    Interface.prototype.pause = function() { return this; };
    Interface.prototype.resume = function() { return this; };
    Interface.prototype.write = function() { return this; };
    Interface.prototype.setPrompt = function() {};
    Interface.prototype.prompt = function() {};
    Interface.prototype.getPrompt = function() { return ''; };
    Interface.prototype.getCursorPos = function() { return { rows: 0, cols: 0 }; };

    function createInterface(opts) {
        return new Interface(opts);
    }

    function clearLine() { return true; }
    function clearScreenDown() { return true; }
    function cursorTo() { return true; }
    function moveCursor() { return true; }
    function emitKeypressEvents() {}

    exports.createInterface = createInterface;
    exports.Interface = Interface;
    exports.clearLine = clearLine;
    exports.clearScreenDown = clearScreenDown;
    exports.cursorTo = cursorTo;
    exports.moveCursor = moveCursor;
    exports.emitKeypressEvents = emitKeypressEvents;
});

// ---- repl.js ----
// repl — Node 20's read-eval-print-loop server.
//
// Burn doesn't have an interactive TTY in the sandboxed JS context,
// but `repl.start()` is sometimes called from server-introspection
// tools or in `--inspect-brk` flows. We expose a `REPLServer`
// class that accepts the configuration, lets callers wire `command`
// / `replServer.context.foo = ...` style globals, and ignores
// the read loop (no stdin available to read).

__register_module('repl', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var vm = require('vm');

    function REPLServer(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.useColors = !!opts.useColors;
        this.useGlobal = opts.useGlobal !== false;
        this.terminal = !!opts.terminal;
        this.input = opts.input || null;
        this.output = opts.output || null;
        this.commands = Object.create(null);
        // The REPL spec exposes the eval scope as `replServer.context`.
        // We back it with a fresh vm context so callers can attach
        // helpers (`replServer.context.x = 5`) without mutating the
        // surrounding globals.
        this.context = vm.createContext({});
    }
    REPLServer.prototype = Object.create(EventEmitter.prototype);
    REPLServer.prototype.constructor = REPLServer;

    REPLServer.prototype.defineCommand = function(name, descriptor) {
        if (typeof descriptor === 'function') descriptor = { action: descriptor };
        this.commands[name] = descriptor;
    };
    REPLServer.prototype.displayPrompt = function() {};
    REPLServer.prototype.setPrompt = function() {};
    REPLServer.prototype.close = function() { this.emit('exit'); };
    REPLServer.prototype.eval = function(code, _ctx, _filename, callback) {
        try {
            var result = vm.runInContext(code, this.context);
            if (typeof callback === 'function') callback(null, result);
        } catch (e) {
            if (typeof callback === 'function') callback(e);
        }
    };

    function start(opts) {
        if (typeof opts === 'string') opts = { prompt: opts };
        var server = new REPLServer(opts);
        return server;
    }

    exports.start = start;
    exports.REPLServer = REPLServer;
    exports.REPL_MODE_SLOPPY = Symbol('repl-sloppy');
    exports.REPL_MODE_STRICT = Symbol('repl-strict');
    exports.Recoverable = function Recoverable(err) {
        var e = err instanceof Error ? err : new Error(String(err));
        e.name = 'Recoverable';
        return e;
    };
    exports.builtinModules = []; // populated by `module.builtinModules` consumers
});

// ---- shadow_argon2.js ----
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

// ---- shadow_bcrypt.js ----
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

// ---- shadow_jsonwebtoken.js ----
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

// ---- shadow_sharp.js ----
// L3 shadow for the `sharp` npm package.
//
// require('sharp') resolves to this polyfill regardless of whether
// node_modules/sharp exists; the upstream package ships a libvips
// `.node` native addon that cannot load inside the WASM sandbox, so
// the shadow kicks in transparently.
//
// Backed by:
//   * `image` crate — codec layer (PNG, JPEG, WebP, GIF, BMP)
//   * `fast_image_resize` — SIMD-accelerated resizing
//
// The fluent builder pattern accumulates ops in JS without any host
// roundtrip; only the terminal call (toBuffer / toFile / metadata)
// crosses into Rust, with the entire pipeline as one JSON blob.
//
// API surface — covers the operations real `sharp` users actually
// reach for:
//
//   sharp(input)
//     .resize(width[, height][, options])     // {fit, kernel}
//     .rotate(degrees)                        // 0/90/180/270 only
//     .grayscale() / .greyscale()
//     .flip() / .flop()
//     .extract({left, top, width, height})    // crop
//     .blur(sigma)
//     .negate()
//     .jpeg({quality}) / .png({compressionLevel}) / .webp({quality, lossless})
//     .toBuffer()              -> Promise<Buffer>
//     .toFile(path)            -> Promise<{format, size, width, height}>
//     .metadata()              -> Promise<{width, height, format, channels, hasAlpha, ...}>
//
// Deferred (intentionally; throw a clear error if used):
//   * `.composite(...)` (overlays)
//   * Per-channel `.modulate(...)`, `.tint(...)`, `.recomb(...)`
//   * Streams (`.pipe()`, `Readable` / `Writable` interop)
//   * Raw / SVG / TIFF / AVIF / JP2 / HEIF inputs/outputs
//   * Color-space conversions beyond the codec defaults

__register_module('sharp', function(module, exports, require) {
    var fs = require('fs');
    var Buffer = require('buffer').Buffer;

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function hostErrToError(s) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var err = new Error('sharp: ' + msg);
        err.code = 'ERR_SHADOW_SHARP';
        return err;
    }

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('sharp not available: rebuild burn with `shadow-sharp`');
            err.code = 'ERR_SHADOW_SHARP';
            throw err;
        }
        return fn;
    }

    // --- source normalization --------------------------------------

    function makeSource(input) {
        if (Buffer.isBuffer(input)) {
            return { kind: 'buffer', data_b64: input.toString('base64') };
        }
        if (input instanceof Uint8Array) {
            return { kind: 'buffer', data_b64: Buffer.from(input).toString('base64') };
        }
        if (typeof input === 'string') {
            // Path. fs.readFileSync (Node-compat: returns Buffer when
            // no encoding is given) reads the file binary-safely.
            var bytes = fs.readFileSync(input);
            return {
                kind: 'buffer',
                data_b64: bytes.toString('base64'),
                _path: input,
            };
        }
        throw new TypeError(
            'sharp: input must be a Buffer, Uint8Array, or filesystem path string'
        );
    }

    // --- Sharp instance --------------------------------------------

    function Sharp(input) {
        if (!(this instanceof Sharp)) return new Sharp(input);
        this._source = makeSource(input);
        this._ops = [];
        this._format = null; // populated by toFormat / .jpeg / .png / .webp
        this._formatOpts = {};
    }

    function pushOp(self, op) {
        self._ops.push(op);
        return self;
    }

    Sharp.prototype.resize = function(width, height, options) {
        // Sharp accepts:
        //   resize(width)
        //   resize(width, height)
        //   resize({width, height, fit, kernel, ...})
        if (typeof width === 'object' && width !== null) {
            options = width;
            width = options.width;
            height = options.height;
        }
        var op = { op: 'resize' };
        if (typeof width === 'number') op.width = width | 0;
        if (typeof height === 'number') op.height = height | 0;
        if (options && typeof options.fit === 'string') op.fit = options.fit;
        if (options && typeof options.kernel === 'string') op.kernel = options.kernel;
        return pushOp(this, op);
    };

    Sharp.prototype.rotate = function(degrees) {
        var d = (degrees | 0);
        return pushOp(this, { op: 'rotate', degrees: d });
    };

    Sharp.prototype.grayscale = function() {
        return pushOp(this, { op: 'grayscale' });
    };
    Sharp.prototype.greyscale = Sharp.prototype.grayscale;

    Sharp.prototype.flip = function() {
        return pushOp(this, { op: 'flip' });
    };

    Sharp.prototype.flop = function() {
        return pushOp(this, { op: 'flop' });
    };

    Sharp.prototype.negate = function() {
        return pushOp(this, { op: 'negate' });
    };

    Sharp.prototype.extract = function(region) {
        if (!region || typeof region !== 'object') {
            throw new TypeError('sharp.extract: region object required');
        }
        return pushOp(this, {
            op: 'extract',
            left: (region.left | 0),
            top: (region.top | 0),
            width: (region.width | 0),
            height: (region.height | 0),
        });
    };

    Sharp.prototype.blur = function(sigma) {
        if (typeof sigma !== 'number' || !isFinite(sigma)) {
            throw new TypeError('sharp.blur: numeric sigma required');
        }
        return pushOp(this, { op: 'blur', sigma: sigma });
    };

    // --- format selection ------------------------------------------

    Sharp.prototype.jpeg = function(options) {
        this._format = 'jpeg';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.png = function(options) {
        this._format = 'png';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.webp = function(options) {
        this._format = 'webp';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.toFormat = function(format, options) {
        if (typeof format !== 'string') {
            throw new TypeError('sharp.toFormat: format string required');
        }
        switch (format.toLowerCase()) {
            case 'jpeg':
            case 'jpg':
                return this.jpeg(options);
            case 'png':
                return this.png(options);
            case 'webp':
                return this.webp(options);
            default:
                throw new Error('sharp.toFormat: unsupported format ' + format);
        }
    };

    // --- not-supported stubs (fluent so chains don't crash) -------

    function notImplemented(name) {
        throw new Error(
            'sharp.' + name + ' is not implemented in the burn shadow yet'
        );
    }
    Sharp.prototype.composite = function() { return notImplemented('composite'); };
    Sharp.prototype.modulate = function() { return notImplemented('modulate'); };
    Sharp.prototype.tint = function() { return notImplemented('tint'); };
    Sharp.prototype.sharpen = function() { return notImplemented('sharpen'); };
    Sharp.prototype.normalize = function() { return notImplemented('normalize'); };
    Sharp.prototype.threshold = function() { return notImplemented('threshold'); };

    // --- terminal ops ----------------------------------------------

    Sharp.prototype._buildPipeline = function() {
        // Default to PNG if the user never picked a format — matches
        // Sharp's behavior (preserves source format when possible,
        // but for the shadow we default to PNG since we don't track
        // source format separately).
        var format = this._format || inferDefaultFormat(this._source);
        var output = { format: format };
        var fo = this._formatOpts || {};
        if (format === 'jpeg' && typeof fo.quality === 'number') {
            output.quality = fo.quality | 0;
        }
        if (format === 'png' && typeof fo.compressionLevel === 'number') {
            output.compression = fo.compressionLevel | 0;
        }
        if (format === 'webp') {
            if (typeof fo.quality === 'number') output.quality = fo.quality | 0;
            if (fo.lossless) output.lossless = true;
        }
        // Drop the polyfill's private `_path` from the source object
        // before sending — host doesn't need it.
        var src = { kind: this._source.kind, data_b64: this._source.data_b64 };
        return { source: src, ops: this._ops, output: output };
    };

    function inferDefaultFormat(_source) {
        // Without re-decoding the source we can't know its format
        // here. PNG is the safe default since it round-trips through
        // any pipeline without quality loss.
        return 'png';
    }

    Sharp.prototype.toBuffer = function() {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                var fn = ensureHost('__host_shadow_sharp_run');
                var pipeline = self._buildPipeline();
                var raw = fn(JSON.stringify(pipeline));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                resolve(Buffer.from(raw, 'base64'));
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.toFile = function(path) {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                if (typeof path !== 'string') {
                    throw new TypeError('sharp.toFile: path must be a string');
                }
                var fn = ensureHost('__host_shadow_sharp_run');
                var pipeline = self._buildPipeline();
                var raw = fn(JSON.stringify(pipeline));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                var bytes = Buffer.from(raw, 'base64');
                // fs.writeFileSync is now binary-safe (accepts Buffer).
                fs.writeFileSync(path, bytes);
                // After write, look up actual dimensions via metadata
                // path so the resolved info matches what's on disk.
                var metaFn = ensureHost('__host_shadow_sharp_metadata');
                var metaRaw = metaFn(JSON.stringify({
                    kind: 'buffer',
                    data_b64: raw,
                }));
                var info = isHostErr(metaRaw) ? {} : JSON.parse(metaRaw);
                resolve({
                    format: pipeline.output.format,
                    size: bytes.length,
                    width: info.width || 0,
                    height: info.height || 0,
                    channels: info.channels || 0,
                });
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.metadata = function() {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                var fn = ensureHost('__host_shadow_sharp_metadata');
                var raw = fn(JSON.stringify({
                    kind: self._source.kind,
                    data_b64: self._source.data_b64,
                }));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                resolve(JSON.parse(raw));
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.stats = function() {
        // Sharp's `.stats()` returns per-channel min/max/sum/etc.
        // Defer until users ask — most pipelines don't need it.
        return Promise.reject(notImplementedAsError('stats'));
    };

    function notImplementedAsError(name) {
        var e = new Error('sharp.' + name + ' is not implemented in the burn shadow yet');
        e.code = 'ERR_SHADOW_SHARP_NOT_IMPL';
        return e;
    }

    // --- module exports --------------------------------------------

    function createSharp(input) {
        return new Sharp(input);
    }

    // Match upstream's `module.exports = sharp` shape — `sharp(input)`
    // is the entry point AND the namespace for constants.
    createSharp.cache = function() { return {}; };
    createSharp.concurrency = function() { return 1; };
    createSharp.simd = function() { return true; };
    createSharp.versions = { sharp: 'burn-shadow-1' };
    createSharp.format = {
        jpeg: { id: 'jpeg', input: { buffer: true, file: true } },
        png:  { id: 'png',  input: { buffer: true, file: true } },
        webp: { id: 'webp', input: { buffer: true, file: true } },
    };

    module.exports = createSharp;
});

// ---- shadow_sqlite3.js ----
// L3 shadow for the `sqlite3` npm package.
//
// require('sqlite3') resolves to this polyfill regardless of whether
// node_modules/sqlite3 exists; the upstream package ships a `.node`
// native addon that cannot load inside the WASM sandbox, so the
// shadow kicks in transparently and routes calls to a `rusqlite`-
// backed coordinator (see `afterburner-node-compat/src/shadows/sqlite3.rs`).
//
// API surface — matches sqlite3 v5 closely enough that real apps
// drop in without modification:
//
//   const sqlite3 = require('sqlite3');
//   const db = new sqlite3.Database(path[, mode][, cb]);
//   db.run(sql[, params][, cb]);     // INSERT/UPDATE/DELETE
//   db.get(sql[, params][, cb]);     // first row
//   db.all(sql[, params][, cb]);     // all rows
//   db.each(sql, params, rowCb, doneCb);
//   db.exec(sql[, cb]);              // multi-statement, no params
//   db.close([cb]);
//   db.serialize(fn);                // no-op (worker is already serialized)
//   db.parallelize(fn);              // no-op
//
// Parameter shapes: positional `?` and `?N`, an array, or `{':name': v}`
// (we lower the latter into a positional array for the bridge).
//
// Buffer round-trip: `Buffer` parameters are encoded as
// `{$blob_b64: '...'}`; result columns of type BLOB come back the
// same shape and are converted back to Buffer for the user.

__register_module('sqlite3', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    // ---- host-error → JS Error -------------------------------------

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }
    function hostErrToError(s, op) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var err = new Error('sqlite3.' + op + ': ' + msg);
        err.code = 'SQLITE_ERROR';
        return err;
    }
    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('sqlite3 not available: rebuild burn with `shadow-sqlite3`');
            err.code = 'SQLITE_NO_SHADOW';
            throw err;
        }
        return fn;
    }
    function lastError() {
        if (typeof globalThis.__host_last_error === 'function') {
            return globalThis.__host_last_error() || '';
        }
        return '';
    }

    // ---- parameter normalization -----------------------------------

    function isPlainObject(o) {
        return o && typeof o === 'object' &&
               Object.getPrototypeOf(o) === Object.prototype;
    }

    // Encode one JS value into the bridge's JSON shape.
    function encodeParam(v) {
        if (v === undefined || v === null) return null;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') {
            if (!isFinite(v)) {
                throw new TypeError('sqlite3: non-finite number');
            }
            return v;
        }
        if (typeof v === 'string') return v;
        if (Buffer.isBuffer(v)) {
            return { $blob_b64: v.toString('base64') };
        }
        if (v instanceof Uint8Array) {
            return { $blob_b64: Buffer.from(v).toString('base64') };
        }
        if (typeof v === 'bigint') {
            // SQLite's INTEGER column is 64-bit. We pass i64 through
            // the bridge, but JS Number can only safely represent up
            // to 2^53. For values beyond that, callers should use
            // string columns. Throw rather than silently lose precision.
            var n = Number(v);
            if (BigInt(n) !== v) {
                throw new RangeError(
                    'sqlite3: bigint ' + v + ' exceeds safe integer range; use TEXT column'
                );
            }
            return n;
        }
        throw new TypeError('sqlite3: unsupported param type ' + typeof v);
    }

    // Lower the user-supplied params (varargs / array / object) into
    // a plain array we can JSON-encode for the bridge.
    function normalizeParams(args) {
        if (args.length === 0) return [];
        if (args.length === 1) {
            var p = args[0];
            if (Array.isArray(p)) {
                return p.map(encodeParam);
            }
            if (isPlainObject(p)) {
                // Named-param bind — we don't translate placeholders in
                // SQL here (the host-side parser doesn't need to: SQLite
                // accepts both `?N` and `:name` in any order). Convert
                // to positional ordering by Object.values insertion order.
                return Object.values(p).map(encodeParam);
            }
            return [encodeParam(p)];
        }
        var out = [];
        for (var i = 0; i < args.length; i++) {
            out.push(encodeParam(args[i]));
        }
        return out;
    }

    // Decode a row that came back from the bridge — convert any blob
    // markers back to Buffer instances.
    function decodeRow(row) {
        if (!row || typeof row !== 'object') return row;
        var keys = Object.keys(row);
        for (var i = 0; i < keys.length; i++) {
            var v = row[keys[i]];
            if (v && typeof v === 'object' && typeof v.$blob_b64 === 'string') {
                row[keys[i]] = Buffer.from(v.$blob_b64, 'base64');
            }
        }
        return row;
    }

    // ---- callback-shape glue ---------------------------------------
    //
    // Real sqlite3 dispatches callbacks asynchronously via libuv. We
    // have no event loop, but the npm package's docs are explicit
    // that callbacks fire after the call returns — preserve that by
    // running them through `Promise.resolve().then(...)` (microtask).

    function defer(cb, err, val, thisCtx) {
        if (typeof cb !== 'function') return;
        Promise.resolve().then(function() {
            try {
                if (thisCtx !== undefined) cb.call(thisCtx, err, val);
                else cb(err, val);
            } catch (_) {
                // Swallow — Node's behavior is to report on
                // 'uncaughtException', which we don't surface here.
            }
        });
    }

    // ---- Database --------------------------------------------------

    var OPEN_READONLY = 0x00000001;
    var OPEN_READWRITE = 0x00000002;
    var OPEN_CREATE = 0x00000004;
    var OPEN_FULLMUTEX = 0x00010000;
    // We don't honor mode flags today — the host opens with
    // READWRITE | CREATE | URI by default and rusqlite's threading
    // mode is fully serialized. The constants are surfaced because
    // application code passes them and shouldn't crash.

    function Database(filename, mode, cb) {
        if (!(this instanceof Database)) return new Database(filename, mode, cb);
        if (typeof mode === 'function') { cb = mode; mode = undefined; }
        var path = String(filename || ':memory:');
        var open = ensureHost('__host_shadow_sqlite3_open');
        var id = open(path);
        // Numeric id; -1 on failure.
        this._id = id;
        this._closed = false;
        this.filename = path;
        this.open = id > 0;
        var self = this;
        if (id < 0) {
            var err = new Error('sqlite3.Database: ' + (lastError() || 'open failed'));
            err.code = 'SQLITE_CANTOPEN';
            this._openError = err;
            // Mirror npm sqlite3: emit 'error' on the next microtask
            // and call back with the error.
            defer(cb, err);
            return;
        }
        defer(cb, null);
    }

    function requireOpen(self, op) {
        if (self._openError) throw self._openError;
        if (self._closed || !(self._id > 0)) {
            var err = new Error('sqlite3.' + op + ': database is closed');
            err.code = 'SQLITE_MISUSE';
            throw err;
        }
    }

    // Pull a trailing callback off a varargs `arguments`-like array.
    function popCb(argsArray) {
        if (argsArray.length === 0) return null;
        var last = argsArray[argsArray.length - 1];
        if (typeof last === 'function') {
            argsArray.pop();
            return last;
        }
        return null;
    }

    Database.prototype.run = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        var ctx;
        try {
            requireOpen(self, 'run');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_run');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'run');
            var parsed = JSON.parse(raw);
            ctx = { lastID: parsed.lastID, changes: parsed.changes, sql: sql };
        } catch (e) {
            // sqlite3's run() callback signature is (err) and
            // `this` carries lastID/changes on success.
            defer(cb, e, undefined);
            return self;
        }
        defer(cb, null, undefined, ctx);
        return self;
    };

    Database.prototype.get = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        try {
            requireOpen(self, 'get');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_get');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'get');
            var row = JSON.parse(raw);
            if (row === null) {
                defer(cb, null, undefined);
            } else {
                defer(cb, null, decodeRow(row));
            }
        } catch (e) {
            defer(cb, e);
        }
        return self;
    };

    Database.prototype.all = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        try {
            requireOpen(self, 'all');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_all');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'all');
            var rows = JSON.parse(raw);
            for (var i = 0; i < rows.length; i++) decodeRow(rows[i]);
            defer(cb, null, rows);
        } catch (e) {
            defer(cb, e, []);
        }
        return self;
    };

    Database.prototype.each = function(sql /* ...params, rowCb, doneCb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        // rowCb is the second-to-last function; doneCb is the last
        // (if both are functions); otherwise the last function is rowCb.
        var doneCb = null;
        var rowCb = null;
        if (args.length && typeof args[args.length - 1] === 'function') {
            var maybeDone = args.pop();
            if (args.length && typeof args[args.length - 1] === 'function') {
                rowCb = args.pop();
                doneCb = maybeDone;
            } else {
                rowCb = maybeDone;
            }
        }
        var self = this;
        try {
            requireOpen(self, 'each');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_all');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'each');
            var rows = JSON.parse(raw);
            for (var i = 0; i < rows.length; i++) {
                var row = decodeRow(rows[i]);
                if (rowCb) {
                    Promise.resolve().then(function(r) {
                        return function() { try { rowCb(null, r); } catch (_) {} };
                    }(row));
                }
            }
            if (doneCb) defer(doneCb, null, rows.length);
        } catch (e) {
            if (rowCb) defer(rowCb, e);
            if (doneCb) defer(doneCb, e, 0);
        }
        return self;
    };

    Database.prototype.exec = function(sql, cb) {
        var self = this;
        try {
            requireOpen(self, 'exec');
            var fn = ensureHost('__host_shadow_sqlite3_exec');
            var rc = fn(self._id, String(sql));
            if (rc < 0) {
                var detail = lastError() || 'exec failed';
                var err = new Error('sqlite3.exec: ' + detail);
                err.code = 'SQLITE_ERROR';
                throw err;
            }
        } catch (e) {
            defer(cb, e);
            return self;
        }
        defer(cb, null);
        return self;
    };

    Database.prototype.close = function(cb) {
        var self = this;
        if (self._closed) {
            defer(cb, null);
            return self;
        }
        self._closed = true;
        self.open = false;
        if (self._id > 0) {
            try {
                var fn = ensureHost('__host_shadow_sqlite3_close');
                fn(self._id);
            } catch (e) {
                defer(cb, e);
                return self;
            }
        }
        defer(cb, null);
        return self;
    };

    // serialize/parallelize: real sqlite3 uses these to switch between
    // serialized + parallel queueing. The shadow already serializes
    // at the worker, so they're no-ops that just invoke the optional
    // function arg synchronously.
    Database.prototype.serialize = function(fn) {
        if (typeof fn === 'function') fn.call(this);
        return this;
    };
    Database.prototype.parallelize = function(fn) {
        if (typeof fn === 'function') fn.call(this);
        return this;
    };

    // configure(option, value) — sqlite3 supports `busyTimeout` and
    // `limit`. We accept and silently ignore (no rusqlite plumbing
    // for these knobs in the minimum subset).
    Database.prototype.configure = function() { return this; };

    // Trace / profile hooks aren't surfaced — install no-op event
    // emitter shape so user code that wires `db.on('trace', ...)`
    // doesn't crash.
    Database.prototype.on = function() { return this; };
    Database.prototype.once = function() { return this; };
    Database.prototype.removeListener = function() { return this; };
    Database.prototype.off = Database.prototype.removeListener;

    // Statement-handle API (db.prepare(sql)) is intentionally not
    // implemented in the minimum subset — most call sites use the
    // inline `db.run(sql, params)` form. Surface a clear error so
    // users know to refactor (rather than getting a confusing crash).
    Database.prototype.prepare = function() {
        throw new Error(
            'sqlite3.Database.prepare is not implemented in the burn shadow yet — ' +
            'use db.run/get/all/each with inline parameters instead'
        );
    };

    // ---- Module exports --------------------------------------------

    exports.Database = Database;
    // npm sqlite3 also exposes a verbose() factory; we just return the
    // module itself since burn doesn't have separate trace levels.
    exports.verbose = function() { return exports; };

    exports.OPEN_READONLY = OPEN_READONLY;
    exports.OPEN_READWRITE = OPEN_READWRITE;
    exports.OPEN_CREATE = OPEN_CREATE;
    exports.OPEN_FULLMUTEX = OPEN_FULLMUTEX;

    // sqlite3.cached.Database mirrors upstream's connection cache.
    // We don't cache — every `new Database` opens a fresh connection.
    exports.cached = { Database: Database };
});

// ---- state.js ----
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

    // Numeric helper for counters. Uses an atomic host-side
    // compare-and-add so concurrent thrusts can't lose updates.
    exports.increment = function(key, delta) {
        var d = (delta === undefined ? 1 : delta);
        var fn = globalThis.__host_state_increment;
        if (typeof fn === 'function') {
            return fn(String(key), d);
        }
        // Backend without atomic increment — fall back to non-atomic
        // RMW and warn the caller via a property on the returned value.
        var n = exports.getJSON(key);
        if (typeof n !== 'number') n = 0;
        n += d;
        exports.setJSON(key, n);
        return n;
    };
});

// ---- stream.js ----
// stream — Node 20 LTS streams (Readable, Writable, Duplex,
// Transform, PassThrough, pipeline, finished, compose, addAbortSignal).
// Pure JS — no host calls. Backpressure modeled with a highWaterMark
// + pending-byte counter; the actual wire-level pause/resume is
// observable through `.write()` returning false and a `'drain'` event
// firing after the pending count crosses back below HWM.

__register_module('stream', function(module, exports, require) {

    var EventEmitter = require('events');

    var DEFAULT_HWM = 16 * 1024;

    // --- Readable ---------------------------------------------------------
    //
    // Two consumption modes:
    //   * Flowing: listening for 'data' (and 'end') gets the chunks pushed
    //     synchronously as `.push(chunk)` runs.
    //   * Paused: `.read()` (no listener) buffers internally; pull when
    //     the consumer asks. We start paused; transition to flowing on
    //     the first 'data' listener.

    function Readable(opts) {
        if (!(this instanceof Readable)) return new Readable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        opts = opts || {};
        this._readable = true;
        this._ended = false;
        this._destroyed = false;
        this._buffer = [];
        this._highWaterMark = opts.highWaterMark || DEFAULT_HWM;
        this._read = (opts.read || function() {}).bind(this);
        this._flowing = null; // null = unset, true = flowing, false = paused
        var self = this;
        // Auto-flow on first data listener.
        this.on('newListener', function(name) {
            if (name === 'data' && self._flowing === null) self._flowing = true;
        });
    }
    Readable.prototype = Object.create(EventEmitter.prototype);
    Readable.prototype.constructor = Readable;

    Readable.prototype.push = function(chunk) {
        if (chunk === null) {
            this._ended = true;
            // Flush buffered chunks before 'end'.
            this._drainBuffer();
            this.emit('end');
            this.emit('close');
            return false;
        }
        if (this._destroyed) return false;
        if (this._flowing) {
            this.emit('data', chunk);
        } else {
            this._buffer.push(chunk);
            this.emit('readable');
        }
        return true;
    };
    Readable.prototype._drainBuffer = function() {
        while (this._buffer.length && this._flowing !== false) {
            this.emit('data', this._buffer.shift());
        }
    };
    Readable.prototype.read = function() {
        if (this._buffer.length === 0) return null;
        return this._buffer.shift();
    };
    Readable.prototype.pause = function() {
        this._flowing = false;
        return this;
    };
    Readable.prototype.resume = function() {
        this._flowing = true;
        this._drainBuffer();
        return this;
    };
    Readable.prototype.pipe = function(dest, opts) {
        opts = opts || {};
        var self = this;
        var ended = false;
        var endDest = opts.end !== false;
        this.on('data', function(chunk) {
            var ok = dest.write(chunk);
            if (!ok) self.pause();
        });
        dest.on && dest.on('drain', function() { self.resume(); });
        this.on('end', function() {
            if (ended) return;
            ended = true;
            if (endDest && typeof dest.end === 'function') dest.end();
        });
        this.on('error', function(err) {
            if (typeof dest.destroy === 'function') dest.destroy(err);
        });
        return dest;
    };
    Readable.prototype.unpipe = function(_dest) {
        // We don't track multiple pipe targets — pause() effectively
        // halts the pipe. Fine for the common single-pipe case.
        this.pause();
        return this;
    };
    Readable.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._readable = false;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
        return this;
    };
    Object.defineProperty(Readable.prototype, 'readable', {
        get: function() { return this._readable && !this._ended && !this._destroyed; },
    });
    Object.defineProperty(Readable.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(Readable.prototype, 'readableEnded', {
        get: function() { return this._ended; },
    });

    // Async-iterator interop. Node makes Readable async-iterable.
    Readable.prototype[Symbol.asyncIterator] = function() {
        var self = this;
        var pending = [];
        var resolvers = [];
        var ended = false;
        var error = null;

        self.on('data', function(chunk) {
            if (resolvers.length) {
                var r = resolvers.shift();
                r({ value: chunk, done: false });
            } else {
                pending.push(chunk);
            }
        });
        self.on('end', function() {
            ended = true;
            while (resolvers.length) {
                resolvers.shift()({ value: undefined, done: true });
            }
        });
        self.on('error', function(e) {
            error = e;
            while (resolvers.length) {
                var r = resolvers.shift();
                r(Promise.reject(e));
            }
        });

        return {
            next: function() {
                if (error) return Promise.reject(error);
                if (pending.length) {
                    return Promise.resolve({ value: pending.shift(), done: false });
                }
                if (ended) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise(function(resolve) { resolvers.push(resolve); });
            },
            return: function() {
                self.destroy();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    };

    Readable.from = function(iterable, opts) {
        var r = new Readable(opts);
        // Sync iterable (Array, generator) — feed synchronously after a
        // microtask tick so listeners can attach.
        if (iterable && typeof iterable[Symbol.iterator] === 'function'
            && typeof iterable[Symbol.asyncIterator] !== 'function') {
            Promise.resolve().then(function() {
                try {
                    for (var v of iterable) r.push(v);
                    r.push(null);
                } catch (e) { r.destroy(e); }
            });
            return r;
        }
        // Async iterable.
        if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
            (async function() {
                try {
                    for await (var v of iterable) r.push(v);
                    r.push(null);
                } catch (e) { r.destroy(e); }
            })();
            return r;
        }
        // Single value fallback — wrap in a one-element array.
        Promise.resolve().then(function() {
            r.push(iterable);
            r.push(null);
        });
        return r;
    };

    // --- Writable ---------------------------------------------------------
    function Writable(opts) {
        if (!(this instanceof Writable)) return new Writable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        opts = opts || {};
        this._writable = true;
        this._destroyed = false;
        this._ended = false;
        this._finished = false;
        this._highWaterMark = opts.highWaterMark || DEFAULT_HWM;
        this._pending = 0;
        this._writeFn = (opts.write || function(_c, _e, cb) { cb && cb(); }).bind(this);
        this._writevFn = opts.writev ? opts.writev.bind(this) : null;
        this._finalFn = opts.final ? opts.final.bind(this) : null;
    }
    Writable.prototype = Object.create(EventEmitter.prototype);
    Writable.prototype.constructor = Writable;

    Writable.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed || this._ended) {
            var err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            if (cb) Promise.resolve().then(function() { cb(err); });
            this.emit('error', err);
            return false;
        }
        var self = this;
        var size = chunkSize(chunk);
        this._pending += size;
        var underWater = this._pending < this._highWaterMark;
        this._writeFn(chunk, encoding, function(err) {
            self._pending -= size;
            if (err) {
                self.emit('error', err);
            } else if (self._pending < self._highWaterMark
                       && self._pending + size >= self._highWaterMark) {
                // Crossed back below HWM — fire 'drain'.
                self.emit('drain');
            }
            if (cb) cb(err);
        });
        return underWater;
    };
    Writable.prototype.end = function(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        if (this._ended) { if (cb) Promise.resolve().then(cb); return this; }
        this._ended = true;
        var self = this;
        var finish = function(err) {
            if (err) { self.emit('error', err); if (cb) cb(err); return; }
            self._finished = true;
            self.emit('finish');
            self.emit('close');
            if (cb) cb();
        };
        if (this._finalFn) this._finalFn(finish); else finish();
        return this;
    };
    Writable.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._writable = false;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
        return this;
    };
    Writable.prototype.cork = function() {};
    Writable.prototype.uncork = function() {};
    Writable.prototype.setDefaultEncoding = function() { return this; };
    Object.defineProperty(Writable.prototype, 'writable', {
        get: function() {
            return this._writable && !this._destroyed && !this._ended;
        },
    });
    Object.defineProperty(Writable.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(Writable.prototype, 'writableEnded', {
        get: function() { return this._ended; },
    });
    Object.defineProperty(Writable.prototype, 'writableFinished', {
        get: function() { return this._finished; },
    });
    Object.defineProperty(Writable.prototype, 'writableLength', {
        get: function() { return this._pending; },
    });

    function chunkSize(chunk) {
        if (chunk == null) return 0;
        if (typeof chunk === 'string') return chunk.length;
        if (chunk.length !== undefined) return chunk.length;
        return 1;
    }

    // --- Duplex (separate read + write halves) ----------------------------
    //
    // Real Duplex: read() and write() track distinct buffers + states.
    // Different from Transform, which couples them via the user
    // _transform fn.
    function Duplex(opts) {
        if (!(this instanceof Duplex)) return new Duplex(opts);
        Readable.call(this, opts);
        // Re-init Writable's state without overwriting the Readable
        // properties we just set.
        opts = opts || {};
        this._writable = true;
        this._writableEnded = false;
        this._finished = false;
        this._pending = 0;
        this._writeFn = (opts.write || function(_c, _e, cb) { cb && cb(); }).bind(this);
        this._finalFn = opts.final ? opts.final.bind(this) : null;
    }
    Duplex.prototype = Object.create(Readable.prototype);
    Duplex.prototype.constructor = Duplex;

    Duplex.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed || this._writableEnded) {
            var err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            if (cb) Promise.resolve().then(function() { cb(err); });
            return false;
        }
        var self = this;
        var size = chunkSize(chunk);
        this._pending += size;
        var underWater = this._pending < this._highWaterMark;
        this._writeFn(chunk, encoding, function(err) {
            self._pending -= size;
            if (err) self.emit('error', err);
            else if (self._pending < self._highWaterMark
                     && self._pending + size >= self._highWaterMark) {
                self.emit('drain');
            }
            if (cb) cb(err);
        });
        return underWater;
    };
    Duplex.prototype.end = Writable.prototype.end;

    // --- Transform (write transforms into push) ---------------------------
    function Transform(opts) {
        if (!(this instanceof Transform)) return new Transform(opts);
        Readable.call(this, opts);
        opts = opts || {};
        this._writable = true;
        this._writableEnded = false;
        this._transform = (opts.transform || function(c, e, cb) { cb(null, c); }).bind(this);
        this._flush = opts.flush ? opts.flush.bind(this) : null;
    }
    Transform.prototype = Object.create(Readable.prototype);
    Transform.prototype.constructor = Transform;
    Transform.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed) {
            if (cb) cb(new Error('Transform destroyed'));
            return false;
        }
        var self = this;
        this._transform(chunk, encoding, function(err, out) {
            if (err) { self.emit('error', err); if (cb) cb(err); return; }
            if (out !== undefined && out !== null) self.push(out);
            if (cb) cb();
        });
        return true;
    };
    Transform.prototype.end = function(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        var self = this;
        var doFlush = function() {
            if (self._flush) {
                self._flush(function(err, out) {
                    if (err) { self.emit('error', err); if (cb) cb(err); return; }
                    if (out !== undefined && out !== null) self.push(out);
                    self.push(null);
                    if (cb) cb();
                });
            } else {
                self.push(null);
                if (cb) cb();
            }
        };
        if (chunk !== undefined && chunk !== null) {
            this.write(chunk, encoding, function() { doFlush(); });
        } else {
            doFlush();
        }
        return this;
    };

    // --- PassThrough ------------------------------------------------------
    function PassThrough(opts) {
        if (!(this instanceof PassThrough)) return new PassThrough(opts);
        Transform.call(this, Object.assign({}, opts, {
            transform: function(c, e, cb) { cb(null, c); },
        }));
    }
    PassThrough.prototype = Object.create(Transform.prototype);
    PassThrough.prototype.constructor = PassThrough;

    // --- pipeline ---------------------------------------------------------
    //
    // Node 20 supports several stage shapes:
    //   * stream object (Readable / Writable / Duplex / Transform)
    //   * iterable / async iterable (becomes a Readable)
    //   * async generator function `(prev) => ...` (becomes a Transform)
    //
    // This polyfill handles streams + iterables; generator-fn stages
    // get wrapped with a Readable.from(asyncFn(prev)) bridge.
    function pipeline() {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        if (args.length < 2) {
            var err = new Error('pipeline needs at least 2 streams');
            if (cb) cb(err);
            else throw err;
            return null;
        }
        var stages = args.map(function(s, i) {
            if (s && typeof s.pipe === 'function') return s;
            // Iterable / async iterable / generator fn.
            if (typeof s === 'function') {
                // Generator function — call with previous stream.
                return s; // resolved in the loop below with prev
            }
            if (s && (typeof s[Symbol.iterator] === 'function'
                || typeof s[Symbol.asyncIterator] === 'function')) {
                return Readable.from(s);
            }
            throw new Error('pipeline: stage ' + i + ' is not a stream / iterable / function');
        });

        var prev = stages[0];
        if (typeof prev === 'function') {
            // First stage can't be a function (no upstream).
            var e = new Error('pipeline: first stage cannot be a function');
            if (cb) cb(e); else throw e;
            return null;
        }
        for (var i = 1; i < stages.length; i++) {
            var stage = stages[i];
            if (typeof stage === 'function') {
                // Wrap as Readable.from(stage(prev))
                stage = Readable.from(stage(prev));
            }
            prev = prev.pipe(stage);
        }
        var settled = false;
        prev.on('finish', function() {
            if (settled) return;
            settled = true;
            if (cb) cb(null);
        });
        prev.on('end', function() {
            if (settled) return;
            settled = true;
            if (cb) cb(null);
        });
        prev.on('error', function(err) {
            if (settled) return;
            settled = true;
            if (cb) cb(err);
        });
        return prev;
    }

    // --- finished ---------------------------------------------------------
    function finished(stream, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        var settled = false;
        var done = function(err) {
            if (settled) return;
            settled = true;
            if (cb) cb(err || null);
        };
        if (stream.on) {
            stream.on('end', function() { done(); });
            stream.on('finish', function() { done(); });
            stream.on('close', function() { done(); });
            stream.on('error', function(e) { done(e); });
        }
    }

    // --- compose (Node 20+) -----------------------------------------------
    //
    // Returns a Duplex whose readable side is the last stage's output
    // and whose writable side feeds the first stage. Implemented by
    // running the pipeline and exposing a façade.
    function compose() {
        var args = Array.prototype.slice.call(arguments);
        if (args.length === 0) {
            throw new Error('compose: need at least one stream');
        }
        var first = args[0];
        for (var i = 1; i < args.length; i++) first = first.pipe(args[i]);
        // The composed object proxies write to the first arg, end to
        // the first arg, and forwards 'data'/'end' from the last.
        var head = args[0];
        var tail = args[args.length - 1];
        var d = new Duplex({
            write: function(chunk, encoding, cb) {
                head.write(chunk, encoding);
                if (cb) cb();
            },
            final: function(cb) { head.end(); cb(); },
        });
        tail.on('data', function(c) { d.push(c); });
        tail.on('end', function() { d.push(null); });
        tail.on('error', function(e) { d.emit('error', e); });
        return d;
    }

    // --- addAbortSignal ---------------------------------------------------
    //
    // When the signal aborts, destroy the stream with an AbortError.
    function addAbortSignal(signal, stream) {
        if (!signal) return stream;
        if (signal.aborted) {
            stream.destroy(new Error('AbortError'));
            return stream;
        }
        var listener = function() {
            stream.destroy(new Error('AbortError'));
        };
        signal.addEventListener && signal.addEventListener('abort', listener);
        return stream;
    }

    // Legacy `Stream` base class — Node's `require('stream')` returns
    // a *callable* function (the legacy `Stream` constructor) with the
    // modern subclasses + helpers attached as own properties. Real npm
    // packages depend on the dual shape: `send/index.js` does
    // `util.inherits(SendStream, Stream)`, which fails our explicit
    // `superCtor must be a function` guard if `Stream` is a plain
    // object. Keep the existing `exports` namespace populated for
    // call-sites that use `require('stream').Readable` etc.; swap
    // `module.exports` to the constructor.
    function Stream() {
        EventEmitter.call(this);
    }
    Stream.prototype = Object.create(EventEmitter.prototype);
    Stream.prototype.constructor = Stream;
    Stream.prototype.pipe = Readable.prototype.pipe;

    exports.Readable       = Readable;
    exports.Writable       = Writable;
    exports.Duplex         = Duplex;
    exports.Transform      = Transform;
    exports.PassThrough    = PassThrough;
    exports.pipeline       = pipeline;
    exports.finished       = finished;
    exports.compose        = compose;
    exports.addAbortSignal = addAbortSignal;
    exports.Stream         = Stream;

    Stream.Readable        = Readable;
    Stream.Writable        = Writable;
    Stream.Duplex          = Duplex;
    Stream.Transform       = Transform;
    Stream.PassThrough     = PassThrough;
    Stream.pipeline        = pipeline;
    Stream.finished        = finished;
    Stream.compose         = compose;
    Stream.addAbortSignal  = addAbortSignal;
    Stream.Stream          = Stream;

    module.exports = Stream;
});

// ---- string_decoder.js ----
// string_decoder — minimal StringDecoder with incremental UTF-8 support.
// Falls back to TextDecoder's streaming mode when available; otherwise a
// tiny hand-rolled continuation-byte buffer.

__register_module('string_decoder', function(module, exports, require) {

    function StringDecoder(encoding) {
        this.encoding = (encoding || 'utf8').toLowerCase();
        if (this.encoding !== 'utf8' && this.encoding !== 'utf-8') {
            throw new Error('StringDecoder: only utf8 is supported');
        }
        if (typeof TextDecoder === 'function') {
            this._decoder = new TextDecoder('utf-8', { fatal: false });
            this._native = true;
        } else {
            this._buffered = new Uint8Array(0);
        }
    }

    StringDecoder.prototype.write = function(chunk) {
        if (this._native) return this._decoder.decode(chunk, { stream: true });

        // Fallback: concat any leftover continuation bytes + new chunk,
        // decode complete sequences, stash the remainder.
        var full = new Uint8Array(this._buffered.length + chunk.length);
        full.set(this._buffered);
        full.set(chunk, this._buffered.length);

        // Find the largest prefix that ends on a complete code point.
        var i = full.length;
        while (i > 0) {
            var b = full[i - 1];
            if ((b & 0x80) === 0) break;                          // ASCII
            if ((b & 0xC0) === 0xC0) { i--; break; }              // start byte
            i--;                                                  // continuation
            if (full.length - i >= 4) { i = full.length; break; } // clamp
        }
        this._buffered = full.subarray(i);

        var out = '';
        for (var j = 0; j < i; j++) out += String.fromCharCode(full[j] & 0x7F);
        return out;
    };

    StringDecoder.prototype.end = function(chunk) {
        if (this._native) return this._decoder.decode(chunk || new Uint8Array(), { stream: false });
        var tail = chunk ? this.write(chunk) : '';
        return tail;
    };

    exports.StringDecoder = StringDecoder;
});

// ---- stubs.js ----
// Stubs were the parking spot for Node modules we hadn't yet
// polyfilled. Every entry that lived here used to register a Proxy
// that threw on first property access, naming the module so users
// got a clear "not supported" signal.
//
// As of the round-2 Node 20 coverage pass, every Node 20 LTS
// built-in has a real polyfill (see the matching `polyfills/<name>.js`
// file). This file is intentionally empty so the bundle order
// (alphabetical concat) doesn't clobber any real polyfill that
// sorts before `stubs.js`. Keeping the file around — instead of
// deleting it — preserves a stable hook for any future
// "intentionally not supported" module without re-introducing the
// alphabetical-clobber footgun.

// ---- timers.js ----
// timers — microtask-based scheduling + host-managed daemon timers.
//
// Phase E enabled the Javy event loop (and matching rquickjs microtask
// pump on the native side), so we can now defer work via
// `Promise.resolve().then(cb)`. That gives us proper
// `queueMicrotask`, a non-synchronous `setTimeout(fn, 0)`, and a
// working `setImmediate` — all without a wall-clock timer heap.
//
// B3 adds host-managed timers for daemon mode. When the daemon event
// loop is active, `__host_timer_set` returns a positive timer_id and
// the host fires the callback at the right time. In sandbox / library /
// UDF mode the host returns -1, and the polyfill throws — matching the
// pre-B3 contract. Detection is at call time (not at bundle-load time)
// so the Wizer snapshot stays mode-agnostic.

// Eagerly install globals at bundle load time. Scripts that never
// `require('timers')` still see `setTimeout` / `queueMicrotask` /
// friends as Web globals (both Node and browsers expose them without
// an import).
(function installTimerGlobals() {
    function _defer(fn, args) {
        Promise.resolve().then(function() { fn.apply(null, args); });
    }

    // Timer handler table — daemon mode stores callbacks here keyed by
    // host timer_id. The daemon_event dispatcher looks them up on fire.
    if (!globalThis.__ab_timer_handlers) {
        globalThis.__ab_timer_handlers = {};
    }

    function _makeHandle(id) {
        var h = { __ab_timer: true, id: id };
        h.ref = function() {
            if (id > 0 && globalThis.__host_timer_ref) globalThis.__host_timer_ref(id);
            return h;
        };
        h.unref = function() {
            if (id > 0 && globalThis.__host_timer_unref) globalThis.__host_timer_unref(id);
            return h;
        };
        return h;
    }

    // Try to register a host timer. Returns a positive id in daemon
    // mode; throws in UDF / script / sandbox mode (host returns -1).
    function _tryHostTimer(delay, repeat) {
        if (typeof globalThis.__host_timer_set !== 'function') {
            return -1;
        }
        return globalThis.__host_timer_set(delay, repeat);
    }

    function _setTimeout(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 2);
        if (!delay || delay <= 0) {
            _defer(fn, args);
            return _makeHandle(0);
        }
        // Non-zero delay: needs host timer (daemon mode only).
        var id = _tryHostTimer(delay, 0);
        if (id <= 0) {
            throw new Error('setTimeout with a non-zero delay is not supported in this sandbox');
        }
        globalThis.__ab_timer_handlers[id] = function() {
            delete globalThis.__ab_timer_handlers[id];
            fn.apply(null, args);
        };
        return _makeHandle(id);
    }

    function _setImmediate(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        _defer(fn, args);
        return _makeHandle(0);
    }

    function _setInterval(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 2);
        // Node treats delay <= 0 as 1.
        if (!delay || delay <= 0) delay = 1;
        var id = _tryHostTimer(delay, 1);
        if (id <= 0) {
            throw new Error('setInterval with a non-zero delay is not supported in this sandbox');
        }
        globalThis.__ab_timer_handlers[id] = function() {
            fn.apply(null, args);
        };
        return _makeHandle(id);
    }

    function _clearTimer(handle) {
        if (handle && handle.__ab_timer && handle.id > 0) {
            if (globalThis.__host_timer_clear) globalThis.__host_timer_clear(handle.id);
            if (globalThis.__ab_timer_handlers) delete globalThis.__ab_timer_handlers[handle.id];
        }
    }
    function _noop() {}

    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = _setTimeout;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = _setImmediate;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = _setInterval;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = _clearTimer;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = _noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = _clearTimer;
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            Promise.resolve().then(fn);
        };
    }
})();

__register_module('timers', function(module, exports, require) {

    function asyncNotSupported(api) {
        return new Error(api + ' with a non-zero delay is not supported in this sandbox');
    }

    function defer(fn, args) {
        Promise.resolve().then(function() { fn.apply(null, args); });
    }

    function makeHandle(id) {
        var h = { __ab_timer: true, id: id };
        h.ref = function() {
            if (id > 0 && globalThis.__host_timer_ref) globalThis.__host_timer_ref(id);
            return h;
        };
        h.unref = function() {
            if (id > 0 && globalThis.__host_timer_unref) globalThis.__host_timer_unref(id);
            return h;
        };
        return h;
    }

    function tryHostTimer(delay, repeat) {
        if (typeof globalThis.__host_timer_set !== 'function') return -1;
        return globalThis.__host_timer_set(delay, repeat);
    }

    function queueMicrotaskImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        defer(fn, []);
    }

    function setTimeoutImpl(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 2);
        if (!delay || delay <= 0) {
            defer(fn, args);
            return makeHandle(0);
        }
        var id = tryHostTimer(delay, 0);
        if (id <= 0) throw asyncNotSupported('setTimeout');
        globalThis.__ab_timer_handlers[id] = function() {
            delete globalThis.__ab_timer_handlers[id];
            fn.apply(null, args);
        };
        return makeHandle(id);
    }

    function setImmediateImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        defer(fn, args);
        return makeHandle(0);
    }

    function setIntervalImpl(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 2);
        if (!delay || delay <= 0) delay = 1;
        var id = tryHostTimer(delay, 1);
        if (id <= 0) throw asyncNotSupported('setInterval');
        globalThis.__ab_timer_handlers[id] = function() {
            fn.apply(null, args);
        };
        return makeHandle(id);
    }

    function clearTimerImpl(handle) {
        if (handle && handle.__ab_timer && handle.id > 0) {
            if (globalThis.__host_timer_clear) globalThis.__host_timer_clear(handle.id);
            if (globalThis.__ab_timer_handlers) delete globalThis.__ab_timer_handlers[handle.id];
        }
    }

    function noop() { /* nothing to clear — microtasks can't be cancelled */ }

    exports.setTimeout = setTimeoutImpl;
    exports.setImmediate = setImmediateImpl;
    exports.setInterval = setIntervalImpl;
    exports.clearTimeout = clearTimerImpl;
    exports.clearImmediate = noop;
    exports.clearInterval = clearTimerImpl;
    exports.queueMicrotask = queueMicrotaskImpl;

    // Install as globals so scripts that don't `require('timers')` still
    // see the same behavior.
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = setTimeoutImpl;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = setImmediateImpl;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = setIntervalImpl;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = clearTimerImpl;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = clearTimerImpl;
    if (typeof globalThis.queueMicrotask !== 'function') globalThis.queueMicrotask = queueMicrotaskImpl;
});

// ---- tls.js ----
// tls — raw TLS polyfill (B7).
//
// Layered on top of the same daemon-event plumbing as `net.js`: a JS
// `TLSSocket` is the façade, the host owns the `tokio_rustls`
// `TlsStream`, and lifecycle events arrive as `{kind: "tls-..."}`
// envelopes routed through `__ab_tls_handlers` and
// `__ab_tls_server_handlers`.
//
// API coverage (minimum-viable for real DB / API drivers):
//
//   tls.connect(opts[, listener])
//     opts: {host, port, servername?, rejectUnauthorized?, ca?,
//            ALPNProtocols?}
//   tls.connect(port, host[, opts][, listener])
//   socket.{write, end, destroy, on('secureConnect'|'data'|'end'|
//           'close'|'error'|'drain'), authorized, authorizationError,
//           getProtocol, alpnProtocol, encrypted}
//   tls.createServer(opts[, connectionListener])
//     opts: {cert, key} — PEM strings
//   server.{listen, close, address, on('listening'|'secureConnection'|
//           'close'|'error')}
//
// Deferred (will throw a clear error if used):
//   - PSK / client certificate auth
//   - tls.checkServerIdentity hook (rustls handles standard hostname
//     verification automatically when rejectUnauthorized is true)
//   - DTLS / OpenSSL-specific knobs (secureProtocol, ciphers list,
//     ECDH curve picks)
//
// SNI multi-cert routing is supported via tls.createSecureContext
// + Server#addContext / { serverContexts: { '*.example.com': ctx } }.

(function bootstrapTlsGlobals() {
    if (!globalThis.__ab_tls_handlers) globalThis.__ab_tls_handlers = {};
    if (!globalThis.__ab_tls_server_handlers) globalThis.__ab_tls_server_handlers = {};
})();

__register_module('tls', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;
    var net = require('net');

    // ----- error mapping --------------------------------------------

    function mapHostErrorCode(rc) {
        switch (rc) {
            case -1: return 'ENO_DAEMON';
            case -2: return 'EACCES';
            case -3: return 'ENOTFOUND';
            case -4: return 'EINVAL';
            case -5: return 'EINVAL';
            case -6: return 'EINVAL';
            case -7: return 'ERR_TLS_INVALID_CERT';
            default: return 'EOTHER';
        }
    }

    function makeError(rc, prefix) {
        var detail = '';
        if (typeof globalThis.__host_last_error === 'function') {
            detail = globalThis.__host_last_error();
        }
        var code = mapHostErrorCode(rc);
        var e = new Error(prefix + ': ' + (detail || ('rc=' + rc)));
        e.code = code;
        return e;
    }

    // ----- TLSSocket -------------------------------------------------
    //
    // Shaped like `net.Socket` but the connection it stands in for
    // is a TLS stream. We don't extend `net.Socket` — the polyfill
    // owns a dedicated host id space (__host_tls_*), so re-using
    // net.Socket would risk crossed wires on the registry side.

    function TLSSocket(opts) {
        if (!(this instanceof TLSSocket)) return new TLSSocket(opts);
        EventEmitter.call(this);
        opts = opts || {};

        this._connId = 0;
        this._connecting = false;
        this._destroyed = false;
        this._closeEmitted = false;
        this._readable = true;
        this._writable = true;
        this._wantsDrain = false;
        this._pendingHWM = 64 * 1024;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.encrypted = true;
        this.authorized = false;
        this.authorizationError = null;
        this.alpnProtocol = null;
        this._protocol = null;
        this.remoteAddress = undefined;
        this.remotePort = undefined;
        this.remoteFamily = undefined;
        this.localAddress = undefined;
        this.localPort = undefined;
        this.readyState = 'opening';
    }
    TLSSocket.prototype = Object.create(EventEmitter.prototype);
    TLSSocket.prototype.constructor = TLSSocket;

    TLSSocket.prototype._attach = function(connId) {
        if (this._connId) {
            throw new Error('tls.TLSSocket already attached to conn ' + this._connId);
        }
        this._connId = connId | 0;
        globalThis.__ab_tls_handlers[this._connId] = this;
    };

    TLSSocket.prototype._dispatchSecureConnect = function(
        local, remote, alpn, protocol, authorized, cipher, certChainB64
    ) {
        this._connecting = false;
        this.readyState = 'open';
        this.localAddress = local && local.address;
        this.localPort = local && local.port;
        this.remoteAddress = remote && remote.address;
        this.remotePort = remote && remote.port;
        this.remoteFamily = remote && remote.family;
        this.alpnProtocol = alpn || null;
        this._protocol = protocol || null;
        this._cipher = cipher || null;
        this._peerCertChainB64 = Array.isArray(certChainB64) ? certChainB64 : [];
        this.authorized = !!authorized;
        if (!this.authorized) {
            this.authorizationError = new Error(
                'TLS verification skipped (rejectUnauthorized: false)'
            );
            this.authorizationError.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        }
        try { this.emit('secureConnect'); } catch (_) {}
        // Node fires 'connect' before 'secureConnect' for the legacy
        // path; we collapse them into one and emit both for callers
        // that listen only to 'connect'.
        try { this.emit('connect'); } catch (_) {}
        try { this.emit('ready'); } catch (_) {}
    };

    TLSSocket.prototype._dispatchData = function(payloadB64) {
        if (this._destroyed || !this._readable) return;
        var bytes;
        try { bytes = Buffer.from(payloadB64, 'base64'); }
        catch (_) { return; }
        this.bytesRead += bytes.length;
        try { this.emit('data', bytes); } catch (_) {}
    };

    TLSSocket.prototype._dispatchEnd = function() {
        if (!this._readable) return;
        this._readable = false;
        this.readyState = this._writable ? 'writeOnly' : 'closed';
        try { this.emit('end'); } catch (_) {}
    };

    TLSSocket.prototype._dispatchDrain = function() {
        if (!this._wantsDrain) return;
        this._wantsDrain = false;
        try { this.emit('drain'); } catch (_) {}
    };

    TLSSocket.prototype._dispatchError = function(message, code) {
        var e = new Error(message || 'tls error');
        e.code = code || 'EOTHER';
        try { this.emit('error', e); } catch (_) {}
    };

    TLSSocket.prototype._dispatchClose = function(hadError) {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this._destroyed = true;
        this._readable = false;
        this._writable = false;
        this.readyState = 'closed';
        try { this.emit('close', !!hadError); } catch (_) {}
        if (this._connId) {
            delete globalThis.__ab_tls_handlers[this._connId];
        }
    };

    TLSSocket.prototype.connect = function(opts) {
        var port = opts.port | 0;
        var host = opts.host || '127.0.0.1';
        if (!port || port < 1 || port > 65535) {
            throw new RangeError('tls.connect: port out of range: ' + opts.port);
        }
        // `rejectUnauthorized` defaults to true (Node-compat). Only an
        // explicit `false` opts out.
        var hostOpts = {
            rejectUnauthorized: opts.rejectUnauthorized === false ? false : true,
            servername: typeof opts.servername === 'string' ? opts.servername : '',
            alpn: Array.isArray(opts.ALPNProtocols)
                ? opts.ALPNProtocols.map(function(p) { return String(p); })
                : [],
            ca: typeof opts.ca === 'string' ? opts.ca :
                Buffer.isBuffer(opts.ca) ? opts.ca.toString('utf8') : ''
        };
        this._connecting = true;
        this.readyState = 'opening';
        var rc = globalThis.__host_tls_connect(
            String(host),
            port,
            JSON.stringify(hostOpts)
        );
        if (rc < 0) {
            var err = makeError(rc, 'tls.connect');
            var self = this;
            Promise.resolve().then(function() {
                self._connecting = false;
                self._destroyed = true;
                self.readyState = 'closed';
                try { self.emit('error', err); } catch (_) {}
                try { self.emit('close', true); } catch (_) {}
            });
            return this;
        }
        this._attach(rc);
        return this;
    };

    TLSSocket.prototype.write = function(data, encoding, cb) {
        if (this._destroyed || !this._writable) {
            if (cb) Promise.resolve().then(function() { cb(new Error('not writable')); });
            return false;
        }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

        var b64;
        if (Buffer.isBuffer(data)) {
            b64 = data.toString('base64');
        } else if (typeof data === 'string') {
            b64 = Buffer.from(data, encoding || 'utf8').toString('base64');
        } else if (data instanceof Uint8Array) {
            b64 = Buffer.from(data).toString('base64');
        } else {
            throw new TypeError('tls.TLSSocket.write: unsupported chunk type ' + typeof data);
        }

        var rc = globalThis.__host_tls_write(this._connId, b64);
        if (rc < 0) {
            var err = makeError(rc, 'tls.write');
            if (cb) cb(err);
            try { this.emit('error', err); } catch (_) {}
            return false;
        }
        var n = Buffer.isBuffer(data) ? data.length :
                (typeof data === 'string' ? Buffer.byteLength(data, encoding || 'utf8') :
                 (data && data.length) || 0);
        this.bytesWritten += n;
        if (cb) Promise.resolve().then(cb);

        var pending = globalThis.__host_tls_pending(this._connId) | 0;
        if (pending >= this._pendingHWM) {
            this._wantsDrain = true;
            return false;
        }
        return true;
    };

    TLSSocket.prototype.end = function(data, encoding, cb) {
        if (typeof data === 'function') { cb = data; data = undefined; encoding = undefined; }
        else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (data !== undefined && data !== null) {
            this.write(data, encoding);
        }
        this._writable = false;
        if (this._connId && !this._destroyed) {
            globalThis.__host_tls_end(this._connId);
        }
        if (cb) this.once('close', cb);
        return this;
    };

    TLSSocket.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._readable = false;
        this._writable = false;
        if (this._connId) {
            globalThis.__host_tls_destroy(this._connId);
        }
        if (err) {
            try { this.emit('error', err); } catch (_) {}
        }
        return this;
    };

    // setNoDelay / setKeepAlive aren't surfaced — tls owns the
    // underlying TcpStream and applying them after the handshake is
    // a niche use case. Accept-and-no-op stubs to match Node's lax
    // duck-typing.
    TLSSocket.prototype.setNoDelay = function() { return this; };
    TLSSocket.prototype.setKeepAlive = function() { return this; };
    TLSSocket.prototype.setTimeout = function() { return this; };
    TLSSocket.prototype.pause = function() { return this; };
    TLSSocket.prototype.resume = function() { return this; };
    TLSSocket.prototype.ref = function() { return this; };
    TLSSocket.prototype.unref = function() { return this; };
    TLSSocket.prototype.setEncoding = function() {
        throw new Error('tls.TLSSocket.setEncoding is not supported in burn yet (decode bytes manually)');
    };

    TLSSocket.prototype.address = function() {
        if (!this.localAddress) return {};
        return {
            address: this.localAddress,
            family: this.remoteFamily ||
                    (String(this.localAddress || '').indexOf(':') >= 0 ? 'IPv6' : 'IPv4'),
            port: this.localPort,
        };
    };

    TLSSocket.prototype.getProtocol = function() {
        return this._protocol;
    };

    TLSSocket.prototype.getCipher = function() {
        // The IANA cipher-suite name comes from rustls'
        // `negotiated_cipher_suite()` and is the same string Node's
        // `getCipher()` returns for `name` / `standardName`.
        var name = this._cipher || 'unknown';
        return {
            name: name,
            standardName: name,
            version: this._protocol || '',
        };
    };

    /// Return the leaf peer certificate, shaped close enough to Node
    /// for the common assertions:
    ///   { raw: Buffer, fingerprint256: '...' }
    /// Subject/issuer parsing requires full ASN.1 — out of scope for
    /// the minimum subset; callers needing those fields can parse
    /// `raw` themselves.
    TLSSocket.prototype.getPeerCertificate = function(detailed) {
        var chain = this._peerCertChainB64 || [];
        if (chain.length === 0) return {};
        var raw = Buffer.from(chain[0], 'base64');
        var cert = {
            raw: raw,
            fingerprint256: sha256Fingerprint(raw),
            subject: {},
            issuer: {},
            valid_from: '',
            valid_to: '',
        };
        if (detailed && chain.length > 1) {
            cert.issuerCertificate = (function makeIssuer(rest) {
                if (rest.length === 0) return undefined;
                var rawIssuer = Buffer.from(rest[0], 'base64');
                return {
                    raw: rawIssuer,
                    fingerprint256: sha256Fingerprint(rawIssuer),
                    subject: {},
                    issuer: {},
                    issuerCertificate: makeIssuer(rest.slice(1)),
                };
            })(chain.slice(1));
        }
        return cert;
    };

    /// Return the entire leaf-first peer certificate chain as an
    /// array of `{raw, fingerprint256}` objects. Convenient when
    /// callers need to walk every cert; mirrors Node's `getPeerX509Certificate()`
    /// shape.
    TLSSocket.prototype.getPeerCertChain = function() {
        var chain = this._peerCertChainB64 || [];
        return chain.map(function(b64) {
            var raw = Buffer.from(b64, 'base64');
            return { raw: raw, fingerprint256: sha256Fingerprint(raw) };
        });
    };

    function sha256Fingerprint(buf) {
        // Node returns colon-separated uppercase hex (`AA:BB:...`).
        // We prefer this format because real-world certificate
        // pinning code matches it byte-for-byte.
        try {
            var crypto = require('crypto');
            var hash = crypto.createHash('sha256').update(buf).digest('hex');
            var out = [];
            for (var i = 0; i < hash.length; i += 2) {
                out.push(hash.slice(i, i + 2).toUpperCase());
            }
            return out.join(':');
        } catch (_) {
            return '';
        }
    }

    Object.defineProperty(TLSSocket.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(TLSSocket.prototype, 'connecting', {
        get: function() { return this._connecting; },
    });
    Object.defineProperty(TLSSocket.prototype, 'readable', {
        get: function() { return this._readable; },
    });
    Object.defineProperty(TLSSocket.prototype, 'writable', {
        get: function() { return this._writable; },
    });
    Object.defineProperty(TLSSocket.prototype, 'pending', {
        get: function() {
            if (!this._connId) return 0;
            return globalThis.__host_tls_pending(this._connId) | 0;
        },
    });

    // ----- Server ----------------------------------------------------

    function _pemFromOpt(v) {
        if (typeof v === 'string') return v;
        if (Buffer.isBuffer(v)) return v.toString('utf8');
        if (Array.isArray(v) && v.length && (typeof v[0] === 'string' || Buffer.isBuffer(v[0]))) {
            return _pemFromOpt(v[0]);
        }
        return '';
    }

    function createSecureContext(opts) {
        opts = opts || {};
        var cert = _pemFromOpt(opts.cert);
        var key = _pemFromOpt(opts.key);
        if (!cert || !key) {
            throw new Error('tls.createSecureContext: `cert` and `key` (PEM) are required');
        }
        return { context: { __isSecureContext: true, cert: cert, key: key } };
    }

    function Server(opts, secureConnectionListener) {
        if (!(this instanceof Server)) return new Server(opts, secureConnectionListener);
        EventEmitter.call(this);
        if (typeof opts === 'function') {
            secureConnectionListener = opts;
            opts = {};
        }
        opts = opts || {};
        this._cert = _pemFromOpt(opts.cert);
        this._key = _pemFromOpt(opts.key);
        if (!this._cert || !this._key) {
            throw new Error('tls.createServer: `cert` and `key` (PEM) are required');
        }
        this._sniContexts = Object.create(null);
        if (opts.serverContexts && typeof opts.serverContexts === 'object') {
            for (var sn in opts.serverContexts) {
                if (Object.prototype.hasOwnProperty.call(opts.serverContexts, sn)) {
                    var sc = opts.serverContexts[sn];
                    var c, k;
                    if (sc && sc.context && sc.context.__isSecureContext) {
                        c = sc.context.cert; k = sc.context.key;
                    } else if (sc && typeof sc === 'object') {
                        c = _pemFromOpt(sc.cert); k = _pemFromOpt(sc.key);
                    }
                    if (c && k) this._sniContexts[String(sn)] = { cert: c, key: k };
                }
            }
        }
        this._serverId = 0;
        this._listening = false;
        this._closed = false;
        this._port = 0;
        this._host = '';
        this._connections = new Set();
        if (secureConnectionListener) this.on('secureConnection', secureConnectionListener);
    }
    Server.prototype = Object.create(EventEmitter.prototype);
    Server.prototype.constructor = Server;

    Server.prototype.addContext = function(servername, context) {
        if (typeof servername !== 'string' || !servername) {
            throw new TypeError('tls.Server#addContext: servername must be a non-empty string');
        }
        var c, k;
        if (context && context.context && context.context.__isSecureContext) {
            c = context.context.cert; k = context.context.key;
        } else if (context && typeof context === 'object') {
            c = _pemFromOpt(context.cert); k = _pemFromOpt(context.key);
        }
        if (!c || !k) {
            throw new Error('tls.Server#addContext: context must include cert and key');
        }
        this._sniContexts[servername] = { cert: c, key: k };
        return this;
    };

    Server.prototype.listen = function() {
        var args = Array.prototype.slice.call(arguments);
        var cb;
        if (args.length && typeof args[args.length - 1] === 'function') {
            cb = args.pop();
        }
        var opts;
        if (args.length === 1 && typeof args[0] === 'object' && args[0]) {
            opts = args[0];
        } else if (args.length === 0) {
            opts = { port: 0 };
        } else {
            opts = { port: args[0], host: args[1] };
        }
        var port = opts.port | 0;
        var host = opts.host || '0.0.0.0';
        if (port < 0 || port > 65535) {
            throw new RangeError('tls.listen: port out of range: ' + opts.port);
        }
        var sniArr = [];
        for (var sn in this._sniContexts) {
            if (Object.prototype.hasOwnProperty.call(this._sniContexts, sn)) {
                sniArr.push({
                    servername: sn,
                    cert: this._sniContexts[sn].cert,
                    key: this._sniContexts[sn].key,
                });
            }
        }
        var sniJson = sniArr.length ? JSON.stringify(sniArr) : '';
        var rc = globalThis.__host_tls_listen(
            String(host), port, this._cert, this._key, sniJson
        );
        if (rc < 0) {
            var err = makeError(rc, 'tls.listen');
            var self = this;
            Promise.resolve().then(function() {
                try { self.emit('error', err); } catch (_) {}
            });
            return this;
        }
        this._serverId = rc | 0;
        this._port = port;
        this._host = host;
        globalThis.__ab_tls_server_handlers[this._serverId] = this;
        if (cb) this.once('listening', cb);
        return this;
    };

    Server.prototype.address = function() {
        if (!this._listening) return null;
        return {
            address: this._host,
            family: this._host.indexOf(':') >= 0 ? 'IPv6' : 'IPv4',
            port: this._port,
        };
    };

    Server.prototype.close = function(cb) {
        if (this._closed) {
            if (cb) Promise.resolve().then(function() { cb(); });
            return this;
        }
        this._closed = true;
        if (this._serverId) {
            globalThis.__host_tls_close_server(this._serverId);
            delete globalThis.__ab_tls_server_handlers[this._serverId];
        }
        var self = this;
        Promise.resolve().then(function() {
            self._listening = false;
            try { self.emit('close'); } catch (_) {}
            if (cb) cb();
        });
        return this;
    };

    Server.prototype.getConnections = function(cb) {
        var n = this._connections.size;
        Promise.resolve().then(function() { cb(null, n); });
        return this;
    };

    Server.prototype.ref = function() { return this; };
    Server.prototype.unref = function() { return this; };

    Server.prototype._dispatchListening = function(port) {
        this._listening = true;
        this._port = (port | 0) || this._port;
        try { this.emit('listening'); } catch (_) {}
    };

    Server.prototype._dispatchConnection = function(
        connId, local, remote, alpn, protocol, cipher, certChainB64
    ) {
        var sock = new TLSSocket();
        sock._attach(connId | 0);
        sock._connecting = false;
        sock.readyState = 'open';
        sock.localAddress = local && local.address;
        sock.localPort = local && local.port;
        sock.remoteAddress = remote && remote.address;
        sock.remotePort = remote && remote.port;
        sock.remoteFamily = remote && remote.family;
        sock.alpnProtocol = alpn || null;
        sock._protocol = protocol || null;
        sock._cipher = cipher || null;
        sock._peerCertChainB64 = Array.isArray(certChainB64) ? certChainB64 : [];
        sock.authorized = false; // server side never verifies client by default
        var self = this;
        this._connections.add(sock);
        sock.once('close', function() { self._connections.delete(sock); });
        try { this.emit('secureConnection', sock); } catch (_) {}
        // Node also emits 'connection' (the legacy raw-TCP-layer event)
        // — keep that for callers that just listen to 'connection'.
        try { this.emit('connection', sock); } catch (_) {}
    };

    Server.prototype._dispatchServerError = function(message) {
        var err = new Error(message || 'tls.Server error');
        err.code = 'EOTHER';
        try { this.emit('error', err); } catch (_) {}
    };

    Object.defineProperty(Server.prototype, 'listening', {
        get: function() { return this._listening; },
    });

    // ----- Top-level helpers -----------------------------------------

    function connect() {
        var args = Array.prototype.slice.call(arguments);
        var cb;
        if (args.length && typeof args[args.length - 1] === 'function') {
            cb = args.pop();
        }
        var opts;
        if (args.length === 1 && typeof args[0] === 'object' && args[0]) {
            opts = args[0];
        } else if (args.length >= 2 && typeof args[1] === 'string') {
            // (port, host[, opts])
            opts = Object.assign({}, args[2] || {}, { port: args[0], host: args[1] });
        } else {
            opts = { port: args[0] };
        }
        var s = new TLSSocket();
        if (cb) s.once('secureConnect', cb);
        return s.connect(opts);
    }

    function createServer(opts, listener) {
        return new Server(opts, listener);
    }

    exports.TLSSocket = TLSSocket;
    exports.Server = Server;
    exports.connect = connect;
    exports.createServer = createServer;
    exports.createSecureContext = createSecureContext;
    exports.SecureContext = function SecureContext() {};
    // Re-export net's IP helpers so callers can do `tls.isIP`.
    exports.isIP = net.isIP;
    exports.isIPv4 = net.isIPv4;
    exports.isIPv6 = net.isIPv6;
    // Stable defaults — Node exposes these but burn doesn't gate on them.
    exports.DEFAULT_MIN_VERSION = 'TLSv1.2';
    exports.DEFAULT_MAX_VERSION = 'TLSv1.3';

    // ---- tls.rootCertificates / getCACertificates (Node 12 / 24) ----
    //
    // The host TLS layer (rustls / webpki-roots) owns the actual root
    // store; we don't surface PEM strings out of it (that crosses the
    // sandbox boundary for what's effectively read-only metadata).
    // The arrays are populated lazily on first access and cached.
    var _rootCerts = null;
    Object.defineProperty(exports, 'rootCertificates', {
        configurable: true,
        enumerable: true,
        get: function() {
            if (_rootCerts === null) {
                if (typeof globalThis.__host_tls_root_certificates === 'function') {
                    var raw = globalThis.__host_tls_root_certificates();
                    _rootCerts = (typeof raw === 'string' && raw.length) ? raw.split('\n--CERT--\n') : [];
                } else {
                    _rootCerts = [];
                }
            }
            return _rootCerts.slice();
        },
    });
    exports.getCACertificates = function getCACertificates(type) {
        // type: 'default' | 'system' | 'bundled' | 'extra'.
        // We only have the bundled webpki roots; surface them under
        // every requested type for compatibility.
        type = type || 'default';
        return exports.rootCertificates;
    };
});

// ---- trace_events.js ----
// trace_events — Node 20's V8 / Node trace categories. The sandbox
// has no trace pipeline; we accept the API surface so callers don't
// crash, log enable/disable to stderr (best-effort visibility), and
// no-op the rest.

__register_module('trace_events', function(module, exports, require) {

    function Tracing(categories) {
        this._categories = (categories || []).slice();
        this._enabled = false;
    }
    Tracing.prototype.enable = function() { this._enabled = true; };
    Tracing.prototype.disable = function() { this._enabled = false; };
    Object.defineProperty(Tracing.prototype, 'enabled', {
        get: function() { return this._enabled; },
    });
    Object.defineProperty(Tracing.prototype, 'categories', {
        get: function() { return this._categories.join(','); },
    });

    function createTracing(opts) {
        opts = opts || {};
        var cats = opts.categories;
        if (!Array.isArray(cats) || cats.length === 0) {
            throw new TypeError(
                'trace_events.createTracing: `categories` must be a non-empty array'
            );
        }
        return new Tracing(cats);
    }

    function getEnabledCategories() {
        // Sandbox has no globally-enabled categories. Node returns
        // a comma-separated string or `undefined`.
        return undefined;
    }

    exports.createTracing = createTracing;
    exports.getEnabledCategories = getEnabledCategories;
});

// ---- tty.js ----
// tty — Node 20's TTY stream classes. process.stdout / process.stderr
// inherit from these in real Node when attached to a terminal. In
// burn's sandbox there's no TTY, but utility code calls
// `tty.isatty(fd)` and `process.stdout.isTTY` defensively — we keep
// those returning sane non-TTY answers so the conditional pretty-
// print paths in chalk / signale / supports-color don't crash.

__register_module('tty', function(module, exports, require) {
    var stream = require('stream');

    function ReadStream(fd, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(fd, options);
        // We delegate to Readable for the API shape; no actual
        // bytes flow because there's no TTY behind it.
        if (typeof stream.Readable === 'function') {
            stream.Readable.call(this, options);
        }
        this.fd = (fd | 0) || 0;
        this.isRaw = false;
        this.isTTY = false; // sandbox is never a TTY
        this.columns = 80;
        this.rows = 24;
    }
    if (typeof stream.Readable === 'function') {
        ReadStream.prototype = Object.create(stream.Readable.prototype);
        ReadStream.prototype.constructor = ReadStream;
    }
    ReadStream.prototype.setRawMode = function(mode) {
        this.isRaw = !!mode;
        return this;
    };

    function WriteStream(fd, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(fd, options);
        if (typeof stream.Writable === 'function') {
            stream.Writable.call(this, options);
        }
        this.fd = (fd | 0) || 1;
        this.isTTY = false;
        this.columns = 80;
        this.rows = 24;
    }
    if (typeof stream.Writable === 'function') {
        WriteStream.prototype = Object.create(stream.Writable.prototype);
        WriteStream.prototype.constructor = WriteStream;
    }
    WriteStream.prototype.clearLine = function() { return true; };
    WriteStream.prototype.clearScreenDown = function() { return true; };
    WriteStream.prototype.cursorTo = function() { return true; };
    WriteStream.prototype.moveCursor = function() { return true; };
    WriteStream.prototype.getColorDepth = function() { return 1; };
    WriteStream.prototype.hasColors = function() { return false; };
    WriteStream.prototype.getWindowSize = function() {
        return [this.columns, this.rows];
    };

    function isatty(fd) {
        var _ = fd;
        return false; // sandbox has no TTY
    }

    exports.ReadStream = ReadStream;
    exports.WriteStream = WriteStream;
    exports.isatty = isatty;
});

// ---- url.js ----
// url — legacy API (url.parse / url.format / url.resolve) plus a
// passthrough to the WHATWG `URL` / `URLSearchParams` globals.

__register_module('url', function(module, exports, require) {

    function parse(str, parseQueryString) {
        if (typeof str !== 'string') throw new TypeError('url.parse requires a string');
        var out = {
            protocol: null, slashes: null, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: str
        };

        var rest = str;

        var hashIdx = rest.indexOf('#');
        if (hashIdx >= 0) { out.hash = rest.slice(hashIdx); rest = rest.slice(0, hashIdx); }

        var queryIdx = rest.indexOf('?');
        if (queryIdx >= 0) {
            out.search = rest.slice(queryIdx);
            var q = rest.slice(queryIdx + 1);
            out.query = parseQueryString ? require('querystring').parse(q) : q;
            rest = rest.slice(0, queryIdx);
        }

        var protoMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rest);
        if (protoMatch) {
            out.protocol = protoMatch[0];
            rest = rest.slice(protoMatch[0].length);
        }

        if (rest.slice(0, 2) === '//') {
            out.slashes = true;
            rest = rest.slice(2);
            var slash = rest.indexOf('/');
            var authority = slash < 0 ? rest : rest.slice(0, slash);
            rest = slash < 0 ? '' : rest.slice(slash);
            var at = authority.indexOf('@');
            if (at >= 0) { out.auth = authority.slice(0, at); authority = authority.slice(at + 1); }
            out.host = authority || null;
            var colon = authority.indexOf(':');
            if (colon >= 0) { out.hostname = authority.slice(0, colon); out.port = authority.slice(colon + 1); }
            else { out.hostname = authority || null; }
        }

        out.pathname = rest || null;
        out.path = (out.pathname || '') + (out.search || '') || null;
        return out;
    }

    function format(obj) {
        if (typeof obj === 'string') return obj;
        var out = '';
        if (obj.protocol) {
            out += obj.protocol;
            if (obj.protocol.charAt(obj.protocol.length - 1) !== ':') out += ':';
        }
        if (obj.slashes || obj.host || obj.hostname) {
            out += '//';
            if (obj.auth) out += obj.auth + '@';
            out += obj.host || (obj.hostname + (obj.port ? ':' + obj.port : ''));
        }
        out += obj.pathname || '';
        if (obj.search) out += obj.search;
        else if (obj.query) {
            out += '?' + (typeof obj.query === 'string' ? obj.query : require('querystring').stringify(obj.query));
        }
        if (obj.hash) out += obj.hash;
        return out;
    }

    function resolve(from, to) {
        try {
            return new URL(to, from).href;
        } catch (_) {
            // Degenerate resolve for relative-without-base callers.
            if (to.charAt(0) === '/') {
                var p = parse(from);
                return (p.protocol || '') + (p.slashes ? '//' : '') + (p.host || '') + to;
            }
            return to;
        }
    }

    exports.parse = parse;
    exports.format = format;
    exports.resolve = resolve;

    // Lazy-bind to the runtime's URL / URLSearchParams. Direct
    // assignment at module-init snapshots the global, which on Javy /
    // QuickJS isn't always installed when the bundle loads — a
    // direct `exports.URL = URL` would then cache `undefined` and
    // every downstream `require('url').URL` (npm's nerf-dart, every
    // proxy-agent variant) breaks with `not a function`. Getters
    // resolve at call-site so the URL constructor binds the moment
    // it becomes available.
    Object.defineProperty(exports, 'URL', {
        configurable: true,
        enumerable: true,
        get: function() { return globalThis.URL; },
    });
    Object.defineProperty(exports, 'URLSearchParams', {
        configurable: true,
        enumerable: true,
        get: function() { return globalThis.URLSearchParams; },
    });
    exports.fileURLToPath = function(u) {
        var s = typeof u === 'string' ? u : (u && u.href) ? u.href : String(u);
        // file:// → /; file:///foo/bar → /foo/bar; file://host/path → /path
        var m = /^file:\/\/([^/]*)?(\/[^?#]*)?/i.exec(s);
        return m ? (m[2] || '/') : s;
    };
    exports.pathToFileURL = function(p) {
        var s = String(p);
        var path = s.charAt(0) === '/' ? s : '/' + s;
        var encoded = path.replace(/[#?]/g, function(ch) { return encodeURIComponent(ch); });
        // Return a URL-shaped object so callers that read .href / .pathname work.
        var URLCtor = globalThis.URL;
        if (typeof URLCtor === 'function') {
            try { return new URLCtor('file://' + encoded); } catch (_) {}
        }
        return { href: 'file://' + encoded, pathname: path, protocol: 'file:' };
    };
    exports.urlToHttpOptions = function(u) {
        if (!u || typeof u !== 'object') return null;
        return {
            protocol: u.protocol,
            hostname: u.hostname && u.hostname.replace(/^\[|\]$/g, ''),
            hash: u.hash,
            search: u.search,
            pathname: u.pathname,
            path: (u.pathname || '') + (u.search || ''),
            href: u.href,
            port: u.port ? Number(u.port) : undefined,
            auth: (u.username || u.password) ? (decodeURIComponent(u.username || '') + (u.password ? ':' + decodeURIComponent(u.password) : '')) : undefined,
        };
    };
    exports.domainToASCII = function(s) { return String(s).toLowerCase(); };
    exports.domainToUnicode = function(s) { return String(s); };
});

// ---- util.js ----
// util — small subset. `format` and `inspect` cover the >95% case
// (template strings with %s, %d, %j; object -> JSON-like stringification).

__register_module('util', function(module, exports, require) {

    // Matches Node's util.format: string args at the top level are
    // emitted verbatim; non-string args go through util.inspect. That
    // keeps `console.log("a", "b")` producing `"a b"` (no quotes) and
    // `console.log("a", ["b"])` producing `"a [ 'b' ]"` (quotes on the
    // ARRAY element via inspect, not on the top-level "a").
    function renderArg(arg) {
        return typeof arg === 'string' ? arg : exports.inspect(arg);
    }

    exports.format = function(fmt) {
        if (typeof fmt !== 'string') {
            var parts = [];
            for (var i = 0; i < arguments.length; i++) parts.push(renderArg(arguments[i]));
            return parts.join(' ');
        }
        var args = arguments;
        var argIdx = 1;
        var out = '';
        var i = 0;
        while (i < fmt.length) {
            var ch = fmt.charAt(i);
            if (ch !== '%' || i + 1 >= fmt.length) { out += ch; i++; continue; }
            var spec = fmt.charAt(i + 1);
            var val = args[argIdx++];
            if      (spec === 's') out += String(val);
            else if (spec === 'd' || spec === 'i') out += Number(val).toFixed(0);
            else if (spec === 'f') out += Number(val);
            else if (spec === 'j') { try { out += JSON.stringify(val); } catch (_) { out += '[Circular]'; } }
            else if (spec === 'o' || spec === 'O') out += exports.inspect(val);
            else if (spec === '%') { out += '%'; argIdx--; }
            else { out += ch; argIdx--; i++; continue; }
            i += 2;
        }
        while (argIdx < args.length) out += ' ' + renderArg(args[argIdx++]);
        return out;
    };

    exports.inspect = function(value, opts) {
        var seen = [];
        function go(v, depth) {
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            var t = typeof v;
            if (t === 'string') return JSON.stringify(v);
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
            if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
            if (t === 'symbol') return v.toString();
            if (seen.indexOf(v) !== -1) return '[Circular]';
            if (depth > 4) return '[Object]';
            seen.push(v);
            try {
                if (Array.isArray(v)) {
                    var items = v.map(function(x) { return go(x, depth + 1); });
                    return '[ ' + items.join(', ') + ' ]';
                }
                if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
                var keys = Object.keys(v);
                var kv = keys.map(function(k) { return k + ': ' + go(v[k], depth + 1); });
                return '{ ' + kv.join(', ') + ' }';
            } finally {
                seen.pop();
            }
        }
        return go(value, 0);
    };

    exports.inherits = function(ctor, superCtor) {
        if (typeof superCtor !== 'function') throw new TypeError('superCtor must be a function');
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
            constructor: { value: ctor, enumerable: false, writable: true, configurable: true }
        });
    };

    exports.promisify = function(fn) {
        return function() {
            var args = Array.prototype.slice.call(arguments);
            var self = this;
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { fn.apply(self, args); } catch (e) { reject(e); }
            });
        };
    };

    exports.callbackify = function(fn) {
        return function() {
            var cb = arguments[arguments.length - 1];
            var rest = Array.prototype.slice.call(arguments, 0, -1);
            Promise.resolve(fn.apply(this, rest))
                .then(function(v) { cb(null, v); })
                .catch(function(e) { cb(e); });
        };
    };

    exports.deprecate = function(fn, _msg) { return fn; };

    // util.types — deferred to the full `util/types` module so the
    // surface stays in one place and `require('util').types` returns
    // the same object as `require('util/types')`. The ALL ~40
    // type-test methods (`isFloat64Array`, `isAnyArrayBuffer`, etc.)
    // are a hard dependency for many libraries that probe object
    // shapes (oxc / acorn-walkers / koa-context, etc.).
    Object.defineProperty(exports, 'types', {
        configurable: true,
        enumerable: true,
        get: function() { return require('util/types'); },
    });

    exports.TextEncoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
    exports.TextDecoder = typeof TextDecoder === 'function' ? TextDecoder : undefined;

    // ---- util.styleText (Node 21/22) -----------------------------
    //
    // Wraps text in ANSI escape sequences when stdout is a TTY (we
    // approximate "is TTY" via env). The list of supported style
    // names matches Node's `util.styleText` accepted set; unknown
    // styles throw `ERR_INVALID_ARG_VALUE` like Node.
    var ANSI = {
        reset:     [0,  0],
        bold:      [1,  22],
        dim:       [2,  22],
        italic:    [3,  23],
        underline: [4,  24],
        blink:     [5,  25],
        inverse:   [7,  27],
        hidden:    [8,  28],
        strikethrough: [9, 29],
        black:     [30, 39],
        red:       [31, 39],
        green:     [32, 39],
        yellow:    [33, 39],
        blue:      [34, 39],
        magenta:   [35, 39],
        cyan:      [36, 39],
        white:     [37, 39],
        gray:      [90, 39],
        grey:      [90, 39],
        bgBlack:   [40, 49],
        bgRed:     [41, 49],
        bgGreen:   [42, 49],
        bgYellow:  [43, 49],
        bgBlue:    [44, 49],
        bgMagenta: [45, 49],
        bgCyan:    [46, 49],
        bgWhite:   [47, 49],
    };
    exports.styleText = function styleText(format, text, options) {
        var styles = Array.isArray(format) ? format : [format];
        for (var i = 0; i < styles.length; i++) {
            if (typeof styles[i] !== 'string' || !ANSI[styles[i]]) {
                var err = new TypeError("The argument 'format' must be a valid style. Received '" + styles[i] + "'");
                err.code = 'ERR_INVALID_ARG_VALUE';
                throw err;
            }
        }
        // `validateStream: false` in opts skips the TTY check —
        // Node's intent is "always emit colors when explicitly opted
        // in". Default behavior approximates the TTY check via
        // NO_COLOR / FORCE_COLOR env vars.
        var stream = options && options.stream;
        var validate = !options || options.validateStream !== false;
        if (validate) {
            if (typeof process !== 'undefined' && process.env) {
                if (process.env.NO_COLOR) return text;
            }
            // We assume TTY when the caller didn't pass a stream;
            // most CLI tools want colors. Pass `{ stream: ... }` to
            // pipe-aware contexts where that should be checked.
            if (stream && stream.isTTY === false) return text;
        }
        var prefix = '', suffix = '';
        for (var j = 0; j < styles.length; j++) {
            var pair = ANSI[styles[j]];
            prefix += '[' + pair[0] + 'm';
            suffix = '[' + pair[1] + 'm' + suffix;
        }
        return prefix + String(text) + suffix;
    };

    // ---- util.MIMEType / util.MIMEParams (Node 19/22) -------------
    function _parseMIME(input) {
        var s = String(input).trim();
        var slash = s.indexOf('/');
        if (slash < 0) {
            var e = new TypeError('Invalid MIME type: missing "/"');
            e.code = 'ERR_INVALID_MIME_SYNTAX';
            throw e;
        }
        var type = s.slice(0, slash).toLowerCase();
        var rest = s.slice(slash + 1);
        var semi = rest.indexOf(';');
        var sub = (semi < 0 ? rest : rest.slice(0, semi)).trim().toLowerCase();
        var params = [];
        if (semi >= 0) {
            var paramStr = rest.slice(semi + 1);
            var parts = paramStr.split(';');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].trim();
                if (!p) continue;
                var eq = p.indexOf('=');
                if (eq < 0) continue;
                var k = p.slice(0, eq).trim().toLowerCase();
                var v = p.slice(eq + 1).trim();
                if (v.length >= 2 && v.charCodeAt(0) === 34 && v.charCodeAt(v.length - 1) === 34) {
                    v = v.slice(1, -1).replace(/\\(.)/g, '$1');
                }
                params.push([k, v]);
            }
        }
        return { type: type, subtype: sub, params: params };
    }
    function MIMEParams(pairs) { this._pairs = pairs.slice(); }
    MIMEParams.prototype.get = function(name) {
        var k = String(name).toLowerCase();
        for (var i = 0; i < this._pairs.length; i++) {
            if (this._pairs[i][0] === k) return this._pairs[i][1];
        }
        return null;
    };
    MIMEParams.prototype.has = function(name) { return this.get(name) !== null; };
    MIMEParams.prototype.set = function(name, value) {
        var k = String(name).toLowerCase();
        for (var i = 0; i < this._pairs.length; i++) {
            if (this._pairs[i][0] === k) { this._pairs[i][1] = String(value); return; }
        }
        this._pairs.push([k, String(value)]);
    };
    MIMEParams.prototype.delete = function(name) {
        var k = String(name).toLowerCase();
        this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
    };
    MIMEParams.prototype.entries = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i].slice(); };
    MIMEParams.prototype.keys    = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i][0]; };
    MIMEParams.prototype.values  = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i][1]; };
    MIMEParams.prototype[Symbol.iterator] = MIMEParams.prototype.entries;
    MIMEParams.prototype.toString = function() {
        return this._pairs.map(function(p) {
            var v = p[1];
            return p[0] + '=' + (/[^A-Za-z0-9_\-.+]/.test(v) ? '"' + v.replace(/(["\\])/g, '\\$1') + '"' : v);
        }).join(';');
    };

    function MIMEType(input) {
        var parsed = _parseMIME(input);
        this._type = parsed.type;
        this._sub = parsed.subtype;
        this.params = new MIMEParams(parsed.params);
    }
    Object.defineProperty(MIMEType.prototype, 'type', {
        get: function() { return this._type; },
        set: function(v) { this._type = String(v).toLowerCase(); },
    });
    Object.defineProperty(MIMEType.prototype, 'subtype', {
        get: function() { return this._sub; },
        set: function(v) { this._sub = String(v).toLowerCase(); },
    });
    Object.defineProperty(MIMEType.prototype, 'essence', {
        get: function() { return this._type + '/' + this._sub; },
    });
    MIMEType.prototype.toString = function() {
        var p = this.params.toString();
        return this._type + '/' + this._sub + (p ? ';' + p : '');
    };
    MIMEType.prototype.toJSON = MIMEType.prototype.toString;
    exports.MIMEType = MIMEType;
    exports.MIMEParams = MIMEParams;

    // ---- util.parseArgs (Node 18.3+ stable, v2 surface in 22) ----
    //
    // Parses argv per a small `options` schema:
    //   { foo: { type: 'string', short: 'f', multiple: true,
    //            default: 'x' } }
    // Returns `{ values, positionals, tokens? }`.
    //
    // Supported v2 surface: `tokens: true` returns the full token
    // stream (per arg, with `kind`: option / positional / option-
    // terminator). Strict mode rejects unknown options like Node.
    exports.parseArgs = function parseArgs(config) {
        var cfg = config || {};
        var args = cfg.args || (typeof process !== 'undefined' && process.argv ? process.argv.slice(2) : []);
        var options = cfg.options || {};
        var strict = cfg.strict !== false;
        var allowPositionals = cfg.allowPositionals === true;
        var allowNegative = cfg.allowNegative === true;
        var wantTokens = cfg.tokens === true;

        // Build short-flag → long-name map.
        var shortMap = {};
        var longNames = Object.keys(options);
        for (var li = 0; li < longNames.length; li++) {
            var n = longNames[li];
            var spec = options[n];
            if (!spec || typeof spec !== 'object') continue;
            if (typeof spec.short === 'string' && spec.short.length > 0) {
                shortMap[spec.short] = n;
            }
        }

        function specOf(name) {
            var s = options[name];
            return s && typeof s === 'object' ? s : null;
        }
        function setValue(values, name, value) {
            var s = specOf(name);
            if (s && s.multiple) {
                if (!values[name]) values[name] = [];
                values[name].push(value);
            } else {
                values[name] = value;
            }
        }
        function consumeBoolean(values, name, raw) {
            setValue(values, name, raw);
            if (wantTokens) {
                tokens.push({ kind: 'option', name: name, rawName: raw === false ? '--no-' + name : null,
                              value: undefined, inlineValue: undefined });
            }
        }

        var values = {};
        var positionals = [];
        var tokens = [];

        // Apply defaults.
        for (var di = 0; di < longNames.length; di++) {
            var dn = longNames[di];
            var ds = specOf(dn);
            if (ds && Object.prototype.hasOwnProperty.call(ds, 'default')) {
                values[dn] = ds.default;
            }
        }

        var i = 0;
        var sawTerminator = false;
        while (i < args.length) {
            var a = args[i];
            if (sawTerminator) {
                positionals.push(a);
                if (wantTokens) tokens.push({ kind: 'positional', index: i, value: a });
                i++;
                continue;
            }
            if (a === '--') {
                sawTerminator = true;
                if (wantTokens) tokens.push({ kind: 'option-terminator', index: i });
                i++;
                continue;
            }
            // Long form: `--name`, `--name=value`, `--no-name`.
            if (a.length > 2 && a[0] === '-' && a[1] === '-') {
                var body = a.slice(2);
                var eq = body.indexOf('=');
                var name = eq >= 0 ? body.slice(0, eq) : body;
                var inline = eq >= 0 ? body.slice(eq + 1) : undefined;
                if (allowNegative && name.indexOf('no-') === 0 && options[name.slice(3)]) {
                    setValue(values, name.slice(3), false);
                    if (wantTokens) tokens.push({ kind: 'option', name: name.slice(3),
                                                  rawName: a, value: false, inlineValue: undefined });
                    i++;
                    continue;
                }
                var s = specOf(name);
                if (!s) {
                    if (strict) {
                        var e = new TypeError("Unknown option '--" + name + "'");
                        e.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
                        throw e;
                    }
                    if (allowPositionals) positionals.push(a);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: inline, inlineValue: inline });
                    i++;
                    continue;
                }
                if (s.type === 'boolean') {
                    setValue(values, name, true);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: true, inlineValue: undefined });
                    i++;
                } else {
                    var val = inline !== undefined ? inline : args[++i];
                    setValue(values, name, val);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: val, inlineValue: inline });
                    i++;
                }
                continue;
            }
            // Short form: `-f`, `-fvalue`, `-fxyz` (cluster of bools).
            if (a.length >= 2 && a[0] === '-' && a[1] !== '-') {
                var rest = a.slice(1);
                var consumed = false;
                for (var ri = 0; ri < rest.length; ri++) {
                    var c = rest[ri];
                    var longName = shortMap[c];
                    if (!longName) {
                        if (strict) {
                            var e2 = new TypeError("Unknown option '-" + c + "'");
                            e2.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
                            throw e2;
                        }
                        break;
                    }
                    var sp = specOf(longName);
                    if (sp && sp.type === 'string') {
                        var rem = rest.slice(ri + 1);
                        var sval = rem.length ? rem : args[++i];
                        setValue(values, longName, sval);
                        if (wantTokens) tokens.push({ kind: 'option', name: longName, rawName: a,
                                                      value: sval, inlineValue: rem.length ? rem : undefined });
                        consumed = true;
                        break;
                    }
                    setValue(values, longName, true);
                    if (wantTokens) tokens.push({ kind: 'option', name: longName, rawName: a,
                                                  value: true, inlineValue: undefined });
                }
                if (!consumed) i++;
                else i++;
                continue;
            }
            // Bare positional.
            if (!allowPositionals && strict) {
                var e3 = new TypeError("Unexpected positional argument '" + a + "'");
                e3.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
                throw e3;
            }
            positionals.push(a);
            if (wantTokens) tokens.push({ kind: 'positional', index: i, value: a });
            i++;
        }
        var out = { values: values, positionals: positionals };
        if (wantTokens) out.tokens = tokens;
        return out;
    };

    // ---- util.transferableAbortSignal / util.aborted (Node 22) ----
    //
    // `transferableAbortSignal(s)` returns a signal usable across
    // worker postMessage boundaries; in our model AbortSignal is
    // already a plain object so the transfer is a no-op identity.
    // `aborted(signal, resource)` returns a Promise that rejects
    // with the abort reason (matches the Node 18.3+ contract).
    exports.transferableAbortSignal = function transferableAbortSignal(signal) {
        return signal;
    };
    exports.aborted = function aborted(signal, _resource) {
        if (!signal || typeof signal.addEventListener !== 'function') {
            return Promise.reject(new TypeError('aborted: argument must be an AbortSignal'));
        }
        if (signal.aborted) {
            return Promise.reject(signal.reason || new Error('aborted'));
        }
        return new Promise(function(_resolve, reject) {
            signal.addEventListener('abort', function() {
                reject(signal.reason || new Error('aborted'));
            }, { once: true });
        });
    };
});

// ---- v8.js ----
// v8 — Node 20's V8 introspection API. We don't run V8 (we run
// QuickJS-in-WASM), but the surface is what real apps reach for —
// returning sane stub data keeps the integration layer working.

__register_module('v8', function(module, exports, require) {

    var Buffer = require('buffer').Buffer;

    function getHeapStatistics() {
        // Sandbox: no V8 heap. Report a memory snapshot bounded by
        // the WASM memory limit (configured via the FuelGauge but
        // not introspectable from JS today). Numbers are intentionally
        // round so callers parsing them as informational don't see
        // bogus precision.
        return {
            total_heap_size: 32 * 1024 * 1024,
            total_heap_size_executable: 0,
            total_physical_size: 32 * 1024 * 1024,
            total_available_size: 256 * 1024 * 1024,
            used_heap_size: 16 * 1024 * 1024,
            heap_size_limit: 256 * 1024 * 1024,
            malloced_memory: 0,
            peak_malloced_memory: 0,
            does_zap_garbage: 0,
            number_of_native_contexts: 1,
            number_of_detached_contexts: 0,
            total_global_handles_size: 0,
            used_global_handles_size: 0,
            external_memory: 0,
        };
    }

    function getHeapSpaceStatistics() {
        return [
            {
                space_name: 'new_space',
                space_size: 8 * 1024 * 1024,
                space_used_size: 1 * 1024 * 1024,
                space_available_size: 7 * 1024 * 1024,
                physical_space_size: 8 * 1024 * 1024,
            },
            {
                space_name: 'old_space',
                space_size: 24 * 1024 * 1024,
                space_used_size: 15 * 1024 * 1024,
                space_available_size: 9 * 1024 * 1024,
                physical_space_size: 24 * 1024 * 1024,
            },
        ];
    }

    function getHeapCodeStatistics() {
        return {
            code_and_metadata_size: 0,
            bytecode_and_metadata_size: 0,
            external_script_source_size: 0,
        };
    }

    function getHeapSnapshot() {
        // Real Node returns a Readable stream of a JSON heap dump.
        // We give callers an empty one shaped like Node's so they
        // can pipe it without crashing.
        var EventEmitter = require('events').EventEmitter;
        var stream = new EventEmitter();
        var emptyDump = '{"snapshot":{"meta":{},"node_count":0,"edge_count":0},"nodes":[],"edges":[],"strings":[]}';
        stream.read = function() { return Buffer.from(emptyDump); };
        stream.pipe = function(dest) { dest.end(emptyDump); return dest; };
        Promise.resolve().then(function() {
            stream.emit('data', Buffer.from(emptyDump));
            stream.emit('end');
        });
        return stream;
    }

    function writeHeapSnapshot(filename) {
        var fs = require('fs');
        var emptyDump = '{"snapshot":{"meta":{},"node_count":0,"edge_count":0},"nodes":[],"edges":[],"strings":[]}';
        var path = filename || ('Heap.' + Date.now() + '.heapsnapshot');
        fs.writeFileSync(path, emptyDump);
        return path;
    }

    // ---- Serialization (v8.serialize / deserialize) ---------------
    //
    // Node uses V8's structured-clone format. We don't have access
    // to it from QuickJS; serialize → JSON-encoded Buffer is a
    // reasonable replacement that round-trips for plain values.
    // Functions and class instances aren't preserved, matching
    // Node's behaviour for non-cloneable values.

    function serialize(value) {
        var json = JSON.stringify(value);
        return Buffer.from(json || 'null', 'utf8');
    }

    function deserialize(buf) {
        var s;
        if (Buffer.isBuffer(buf)) s = buf.toString('utf8');
        else if (buf instanceof Uint8Array) s = Buffer.from(buf).toString('utf8');
        else throw new TypeError('v8.deserialize: argument must be a Buffer or Uint8Array');
        return JSON.parse(s);
    }

    function Serializer() {
        this._values = [];
    }
    Serializer.prototype.writeHeader = function() {};
    Serializer.prototype.writeValue = function(v) { this._values.push(v); };
    Serializer.prototype.releaseBuffer = function() {
        return serialize(this._values.length === 1 ? this._values[0] : this._values);
    };
    Serializer.prototype.transferArrayBuffer = function() {};

    function Deserializer(buf) {
        this._cursor = 0;
        this._values = [];
        try {
            var v = deserialize(buf);
            this._values = Array.isArray(v) ? v : [v];
        } catch (_) { /* invalid input → empty values */ }
    }
    Deserializer.prototype.readHeader = function() { return true; };
    Deserializer.prototype.readValue = function() {
        return this._values[this._cursor++];
    };
    Deserializer.prototype.transferArrayBuffer = function() {};

    function setFlagsFromString(_flags) {
        // V8 flag tweaks are V8-specific; ignored.
    }
    function getStringEnvironment() {
        return [];
    }

    exports.cachedDataVersionTag = function() { return 0; };
    exports.getHeapStatistics = getHeapStatistics;
    exports.getHeapSpaceStatistics = getHeapSpaceStatistics;
    exports.getHeapCodeStatistics = getHeapCodeStatistics;
    exports.getHeapSnapshot = getHeapSnapshot;
    exports.writeHeapSnapshot = writeHeapSnapshot;
    exports.setFlagsFromString = setFlagsFromString;
    exports.getStringEnvironment = getStringEnvironment;
    exports.serialize = serialize;
    exports.deserialize = deserialize;
    exports.Serializer = Serializer;
    exports.Deserializer = Deserializer;
    exports.DefaultSerializer = Serializer;
    exports.DefaultDeserializer = Deserializer;
    exports.startupSnapshot = {
        addDeserializeCallback: function() {},
        addSerializeCallback: function() {},
        setDeserializeMainFunction: function() {},
        isBuildingSnapshot: function() { return false; },
    };
    exports.promiseHooks = {
        onInit: function() { return function() {}; },
        onSettled: function() { return function() {}; },
        onBefore: function() { return function() {}; },
        onAfter: function() { return function() {}; },
        createHook: function() { return { disable: function() {} }; },
    };
});

// ---- vm.js ----
// vm — Node 20's "VM" (Virtual Machine) module.
//
// Real Node uses V8's vm.runInContext / runInNewContext to run JS
// in a separate context. Burn IS a JS sandbox already (everything
// runs inside one) — there's no nested-context boundary to cross.
// We give callers a Node-compatible surface that uses `eval` /
// fresh evaluation contexts where possible.
//
// Trade-offs vs Node:
//   * `runInThisContext(code)` does what `eval(code)` would, in the
//     current global. Same scope as Node's variant.
//   * `runInNewContext(code, sandbox)` evaluates `code` in a
//     standalone object so writes don't leak to the caller's globals.
//     QuickJS doesn't expose first-class context creation from JS,
//     so we approximate by wrapping the code in `(function() { ... }).call(sandbox)`
//     — `this` becomes the sandbox object, top-level `var` ends up
//     on the sandbox via `with()`-like rebinding.
//   * `Script` class supports `runInThisContext` / `runInNewContext`.
//   * `compileFunction(...)` is implemented via Function constructor.

__register_module('vm', function(module, exports, require) {

    function isContext(obj) {
        // A "vm context" in Node is a sandbox object. We mark
        // objects as contexts via a Symbol so `isContext` is stable.
        return !!(obj && obj.__ab_vm_context === true);
    }

    function createContext(sandbox, options) {
        sandbox = sandbox || {};
        // Mark as a vm context so isContext() recognizes it.
        Object.defineProperty(sandbox, '__ab_vm_context', {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        var _ = options;
        return sandbox;
    }

    function runInThisContext(code, options) {
        var _ = options;
        // No isolation — same context as the caller. Spec-compatible.
        return (0, eval)(String(code));
    }

    /// `runInNewContext` evaluates `code` against a fresh object so
    /// writes to top-level identifiers land on `sandbox`, not on
    /// `globalThis`. QuickJS lacks first-class contexts, so we
    /// approximate via an IIFE bound to the sandbox + `with()` for
    /// transparent identifier resolution.
    function runInNewContext(code, sandbox, options) {
        sandbox = sandbox || {};
        if (!isContext(sandbox)) {
            // Auto-context the sandbox the first time.
            createContext(sandbox);
        }
        var _ = options;
        // Use `eval` inside `with(sandbox)` so the completion value
        // of the script comes back to the caller — matches Node's
        // V8-eval semantics where `runInNewContext('1+2', {})` is
        // `3`. `with` is the only construct that makes top-level
        // identifier lookups resolve against `sandbox` first; eval's
        // completion value is the final-expression value, same as
        // Node.
        var wrapper = new Function(
            '__ab_sandbox__', '__ab_code__',
            'with (__ab_sandbox__) { return eval(__ab_code__); }'
        );
        return wrapper(sandbox, String(code));
    }

    function runInContext(code, ctx, options) {
        if (!isContext(ctx)) {
            throw new TypeError(
                'vm.runInContext: contextifiedObject must be a context (call vm.createContext first)'
            );
        }
        return runInNewContext(code, ctx, options);
    }

    function compileFunction(code, params, options) {
        var args = (params || []).slice();
        args.push(String(code));
        return new (Function.prototype.bind.apply(Function, [null].concat(args)));
    }

    // ---- Script class --------------------------------------------

    function Script(code, options) {
        if (!(this instanceof Script)) return new Script(code, options);
        this.code = String(code);
        this._options = options || {};
        // Pre-compile at construction time so syntax errors throw
        // immediately, matching Node's spec.
        try {
            new Function(this.code);
        } catch (e) {
            throw e;
        }
    }
    Script.prototype.runInThisContext = function(options) {
        return runInThisContext(this.code, options);
    };
    Script.prototype.runInContext = function(ctx, options) {
        return runInContext(this.code, ctx, options);
    };
    Script.prototype.runInNewContext = function(sandbox, options) {
        return runInNewContext(this.code, sandbox, options);
    };
    Script.prototype.createCachedData = function() {
        // No bytecode caching surface from QuickJS to JS.
        return Buffer ? Buffer.alloc(0) : new Uint8Array(0);
    };

    // `Module` / `SourceTextModule` / `SyntheticModule` — Node has
    // these as experimental ES module support inside vm. We don't
    // expose them; callers who hit them will see the stub class
    // throw a useful error.

    function unsupportedModule(name) {
        return function() {
            throw new Error(
                'vm.' + name + ' (ES Module support) is not implemented in burn yet — ' +
                'use Script + runInContext for evaluating CJS-shaped code.'
            );
        };
    }

    exports.createContext = createContext;
    exports.isContext = isContext;
    exports.runInThisContext = runInThisContext;
    exports.runInNewContext = runInNewContext;
    exports.runInContext = runInContext;
    exports.compileFunction = compileFunction;
    exports.Script = Script;
    exports.SourceTextModule = unsupportedModule('SourceTextModule');
    exports.SyntheticModule = unsupportedModule('SyntheticModule');
    exports.Module = unsupportedModule('Module');
    exports.constants = {
        DONT_CONTEXTIFY: 0,
        USE_MAIN_CONTEXT_DEFAULT_LOADER: 1,
    };
});

// ---- wasi.js ----
// wasi — Node 20's WASI host. The plain `WebAssembly` polyfill
// already loads modules; this module gives callers the Node-shaped
// `WASI` class so `new WASI({...}).getImportObject()` works against
// our `WebAssembly.instantiate`.
//
// v1 supplies an empty import object — the WASM loader doesn't bridge
// user-defined imports yet, so a module that imports
// `wasi_snapshot_preview1` won't actually get satisfied. The class
// exists to keep `import { WASI } from 'wasi'` from breaking; runtime
// instantiation will surface a LinkError naming the missing import,
// which is the right place to learn what's still pending.

__register_module('wasi', function(module, exports, require) {

    function WASI(opts) {
        opts = opts || {};
        this.args = (opts.args || []).slice();
        this.env = Object.assign({}, opts.env || {});
        this.preopens = Object.assign({}, opts.preopens || {});
        this.returnOnExit = opts.returnOnExit !== false;
        this.version = opts.version || 'preview1';
        this._started = false;
    }

    WASI.prototype.getImportObject = function() {
        // v1 returns an empty import map. WASM modules that import
        // `wasi_snapshot_preview1.<func>` will fail at instantiate
        // with `LinkError: import not satisfied: wasi_snapshot_preview1.<func>`,
        // which tells the caller which entry is still pending.
        return {};
    };

    WASI.prototype.start = function(instance) {
        if (this._started) {
            throw new Error('WASI.start: instance already started');
        }
        this._started = true;
        var fn = instance && instance.exports && instance.exports._start;
        if (typeof fn !== 'function') {
            throw new TypeError(
                'WASI.start: instance must export `_start` (compile module ' +
                'with `wasm32-wasi` / `wasi-libc` to get the standard entry)'
            );
        }
        try {
            fn();
        } catch (e) {
            // WASI exits via a special trap; surface the exit code
            // when present.
            if (e && typeof e.code === 'number') {
                if (this.returnOnExit) return e.code;
                throw e;
            }
            throw e;
        }
        return 0;
    };

    WASI.prototype.initialize = function(instance) {
        var fn = instance && instance.exports && instance.exports._initialize;
        if (typeof fn !== 'function') return;
        fn();
    };

    exports.WASI = WASI;
});

// ---- web_compat.js ----
// Small Web-API polyfills that most Node.js scripts now assume. Wired
// as globals, not modules, to match the browser/Node semantics.

(function installWebCompat() {
    // structuredClone — ES2022. QuickJS-NG typically has it; fall back
    // to a JSON deep-copy so scripts don't blow up if this runtime
    // doesn't.
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = function(value) {
            if (value === undefined) return undefined;
            return JSON.parse(JSON.stringify(value));
        };
    }

    // performance.now — no monotonic clock inside the sandbox, but
    // Date.now gives us something non-decreasing for most practical
    // purposes. Hrtime-style scripts won't crash.
    if (typeof globalThis.performance !== 'object' || typeof globalThis.performance.now !== 'function') {
        globalThis.performance = globalThis.performance || {};
        globalThis.performance.now = function() { return Date.now(); };
    }

    // `queueMicrotask` — schedule a microtask. QuickJS supports
    // Promise.then which gives us the microtask queue for free.
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            Promise.resolve().then(fn);
        };
    }

    // `TextEncoder` / `TextDecoder` — Web globals. Javy ships them when
    // built with `text_encoding(true)` (our WASM plugin does); native
    // rquickjs doesn't. Real npm packages (Express deps, undici, etc.)
    // probe these at module-load time and crash with `ReferenceError`
    // without them.
    //
    // Implementation note: do NOT route through `Buffer.toString` /
    // `Buffer.from(str, 'utf8')` here. Buffer's UTF-8 codec routes
    // back through these globals in some plenum paths, producing an
    // infinite recursion. The pure-JS encoder/decoder below is
    // self-contained and handles BMP + surrogate-paired astral
    // codepoints. Replacement char (`�`) for malformed sequences
    // when not in `fatal` mode (matches WHATWG spec).
    if (typeof globalThis.TextEncoder !== 'function') {
        globalThis.TextEncoder = function TextEncoder() {
            this.encoding = 'utf-8';
        };
        globalThis.TextEncoder.prototype.encode = function(input) {
            var s = input === undefined ? '' : String(input);
            // Worst case: 4 bytes per code unit (surrogate pair → 4-byte UTF-8).
            var out = new Uint8Array(s.length * 4);
            var n = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
                    var c2 = s.charCodeAt(i + 1);
                    if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
                        out[n++] = 0xF0 | (cp >> 18);
                        out[n++] = 0x80 | ((cp >> 12) & 0x3F);
                        out[n++] = 0x80 | ((cp >> 6) & 0x3F);
                        out[n++] = 0x80 | (cp & 0x3F);
                        i++;
                        continue;
                    }
                }
                if (c < 0x80) {
                    out[n++] = c;
                } else if (c < 0x800) {
                    out[n++] = 0xC0 | (c >> 6);
                    out[n++] = 0x80 | (c & 0x3F);
                } else {
                    out[n++] = 0xE0 | (c >> 12);
                    out[n++] = 0x80 | ((c >> 6) & 0x3F);
                    out[n++] = 0x80 | (c & 0x3F);
                }
            }
            return out.slice(0, n);
        };
        globalThis.TextEncoder.prototype.encodeInto = function(source, dest) {
            var encoded = this.encode(source);
            var n = Math.min(encoded.length, dest.length);
            for (var i = 0; i < n; i++) dest[i] = encoded[i];
            return { read: source.length, written: n };
        };
    }
    if (typeof globalThis.TextDecoder !== 'function') {
        globalThis.TextDecoder = function TextDecoder(label, options) {
            var enc = (label || 'utf-8').toLowerCase();
            if (enc === 'utf8') enc = 'utf-8';
            this.encoding = enc;
            this.fatal = !!(options && options.fatal);
            this.ignoreBOM = !!(options && options.ignoreBOM);
        };
        globalThis.TextDecoder.prototype.decode = function(input, _options) {
            if (input === undefined) return '';
            var bytes;
            if (input instanceof Uint8Array) {
                bytes = input;
            } else if (input instanceof ArrayBuffer) {
                bytes = new Uint8Array(input);
            } else if (input && typeof input.byteLength === 'number') {
                bytes = new Uint8Array(
                    input.buffer || input,
                    input.byteOffset || 0,
                    input.byteLength
                );
            } else {
                return '';
            }
            // Pure-JS UTF-8 decode. Doesn't route through Buffer to
            // avoid recursion when Buffer's own codec calls back here.
            var s = '';
            var i = 0;
            while (i < bytes.length) {
                var b1 = bytes[i++];
                if (b1 < 0x80) {
                    s += String.fromCharCode(b1);
                } else if (b1 < 0xC0) {
                    s += '�';
                } else if (b1 < 0xE0) {
                    var b2 = bytes[i++] || 0;
                    s += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
                } else if (b1 < 0xF0) {
                    var b2c = bytes[i++] || 0;
                    var b3 = bytes[i++] || 0;
                    s += String.fromCharCode(
                        ((b1 & 0x0F) << 12) | ((b2c & 0x3F) << 6) | (b3 & 0x3F)
                    );
                } else {
                    var b2d = bytes[i++] || 0;
                    var b3d = bytes[i++] || 0;
                    var b4 = bytes[i++] || 0;
                    var cp =
                        ((b1 & 0x07) << 18) |
                        ((b2d & 0x3F) << 12) |
                        ((b3d & 0x3F) << 6) |
                        (b4 & 0x3F);
                    cp -= 0x10000;
                    s += String.fromCharCode(
                        0xD800 + (cp >> 10),
                        0xDC00 + (cp & 0x3FF)
                    );
                }
            }
            return s;
        };
    }

    // `btoa` / `atob` — base64 encoders. QuickJS doesn't ship these.
    if (typeof globalThis.btoa !== 'function') {
        globalThis.btoa = function(str) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(str), 'binary').toString('base64');
        };
    }
    if (typeof globalThis.atob !== 'function') {
        globalThis.atob = function(b64) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(b64), 'base64').toString('binary');
        };
    }

    // Node 20 LTS globals exposed without `require`:
    //   * `Buffer`           — global since v0.x.
    //   * `global`           — alias to globalThis since v12.
    //   * `URL` / `URLSearchParams` — global since v10.
    if (typeof globalThis.Buffer !== 'function') {
        globalThis.Buffer = require('buffer').Buffer;
    }
    if (typeof globalThis.global !== 'object') {
        globalThis.global = globalThis;
    }

    // ----- EventTarget / Event / CustomEvent ------------------------
    // Node 15 made these globals; nearly every modern web-API
    // building block (AbortSignal, MessagePort, the streams family)
    // either extends EventTarget or fires Events through it. Anything
    // that does `class X extends EventTarget {}` falls over without
    // a real constructor, even when the extending code never actually
    // dispatches an event.
    if (typeof globalThis.Event !== 'function') {
        var Event = function Event(type, init) {
            init = init || {};
            this.type = String(type);
            this.bubbles = !!init.bubbles;
            this.cancelable = !!init.cancelable;
            this.composed = !!init.composed;
            this.defaultPrevented = false;
            this.timeStamp = Date.now();
            this.target = null;
            this.currentTarget = null;
            this.eventPhase = 0;
            this.isTrusted = false;
            this._propagationStopped = false;
            this._immediatePropagationStopped = false;
        };
        Event.prototype.preventDefault = function() {
            if (this.cancelable) this.defaultPrevented = true;
        };
        Event.prototype.stopPropagation = function() { this._propagationStopped = true; };
        Event.prototype.stopImmediatePropagation = function() {
            this._propagationStopped = true;
            this._immediatePropagationStopped = true;
        };
        Event.prototype.composedPath = function() { return []; };
        Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
        globalThis.Event = Event;
    }
    if (typeof globalThis.CustomEvent !== 'function') {
        globalThis.CustomEvent = function CustomEvent(type, init) {
            globalThis.Event.call(this, type, init);
            this.detail = init && 'detail' in init ? init.detail : null;
        };
        globalThis.CustomEvent.prototype = Object.create(globalThis.Event.prototype);
        globalThis.CustomEvent.prototype.constructor = globalThis.CustomEvent;
    }
    if (typeof globalThis.EventTarget !== 'function') {
        var EventTarget = function EventTarget() { this._listeners = {}; };
        EventTarget.prototype.addEventListener = function(type, listener, _options) {
            if (!this._listeners) this._listeners = {};
            (this._listeners[type] = this._listeners[type] || []).push(listener);
        };
        EventTarget.prototype.removeEventListener = function(type, listener) {
            if (!this._listeners || !this._listeners[type]) return;
            var arr = this._listeners[type];
            for (var i = arr.length - 1; i >= 0; i--) {
                if (arr[i] === listener) arr.splice(i, 1);
            }
        };
        EventTarget.prototype.dispatchEvent = function(event) {
            if (!event || typeof event.type !== 'string') {
                throw new TypeError('dispatchEvent: argument must be an Event');
            }
            event.target = this;
            event.currentTarget = this;
            event.eventPhase = 2; // AT_TARGET
            var arr = (this._listeners && this._listeners[event.type]) || [];
            for (var i = 0; i < arr.length; i++) {
                if (event._immediatePropagationStopped) break;
                try {
                    var fn = arr[i];
                    if (typeof fn === 'function') fn.call(this, event);
                    else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(event);
                } catch (e) {
                    // Swallow per Web spec — an exceptional handler
                    // shouldn't prevent siblings from firing. Surface
                    // via the runtime's error reporting path.
                    if (typeof globalThis.queueMicrotask === 'function') {
                        globalThis.queueMicrotask(function() { throw e; });
                    }
                }
            }
            event.eventPhase = 0;
            return !event.defaultPrevented;
        };
        globalThis.EventTarget = EventTarget;
    }

    // ----- DOMException ---------------------------------------------
    // Used by AbortController.abort() (DOMException 'AbortError'),
    // various Streams APIs, and Cache/IndexedDB shims. Most callers
    // construct it as `new DOMException(message, name)` and read
    // `.name` to discriminate error types.
    if (typeof globalThis.DOMException !== 'function') {
        var DOMException = function DOMException(message, name) {
            this.message = message === undefined ? '' : String(message);
            this.name = name === undefined ? 'Error' : String(name);
            // .code: legacy numeric. 0 if name doesn't map.
            var legacy = {
                IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
                InvalidCharacterError: 5, NoModificationAllowedError: 7,
                NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
                InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
                NamespaceError: 14, InvalidAccessError: 15, SecurityError: 18,
                NetworkError: 19, AbortError: 20, URLMismatchError: 21,
                QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24,
                DataCloneError: 25,
            };
            this.code = legacy[this.name] || 0;
            // Stack trace via Error to make it inspectable.
            try { Error.captureStackTrace(this, DOMException); }
            catch (_) { this.stack = (new Error(this.message)).stack; }
        };
        DOMException.prototype = Object.create(Error.prototype);
        DOMException.prototype.constructor = DOMException;
        DOMException.prototype.toString = function() { return this.name + ': ' + this.message; };
        // Static legacy code constants on the constructor.
        var codes = ['INDEX_SIZE_ERR','DOMSTRING_SIZE_ERR','HIERARCHY_REQUEST_ERR','WRONG_DOCUMENT_ERR','INVALID_CHARACTER_ERR','NO_DATA_ALLOWED_ERR','NO_MODIFICATION_ALLOWED_ERR','NOT_FOUND_ERR','NOT_SUPPORTED_ERR','INUSE_ATTRIBUTE_ERR','INVALID_STATE_ERR','SYNTAX_ERR','INVALID_MODIFICATION_ERR','NAMESPACE_ERR','INVALID_ACCESS_ERR','VALIDATION_ERR','TYPE_MISMATCH_ERR','SECURITY_ERR','NETWORK_ERR','ABORT_ERR','URL_MISMATCH_ERR','QUOTA_EXCEEDED_ERR','TIMEOUT_ERR','INVALID_NODE_TYPE_ERR','DATA_CLONE_ERR'];
        for (var ci = 0; ci < codes.length; ci++) DOMException[codes[ci]] = ci + 1;
        globalThis.DOMException = DOMException;
    }

    // ----- Blob / File / FormData -----------------------------------
    // Node 18+ globals. node-fetch / undici-style clients construct
    // Blobs to wrap response bodies; multer / form-data libraries
    // build FormData. Buffer-backed implementations — covers the API
    // shape; binary streaming is best-effort sync.
    if (typeof globalThis.Blob !== 'function') {
        var Blob = function Blob(parts, options) {
            options = options || {};
            this.type = options.type ? String(options.type).toLowerCase() : '';
            var arr = parts || [];
            // Coerce each part to bytes.
            var Buf = (typeof globalThis.Buffer === 'function') ? globalThis.Buffer : null;
            var pieces = [];
            for (var i = 0; i < arr.length; i++) {
                var p = arr[i];
                if (Buf && Buf.isBuffer && Buf.isBuffer(p)) pieces.push(p);
                else if (p instanceof Uint8Array) pieces.push(Buf ? Buf.from(p) : p);
                else if (p instanceof ArrayBuffer) pieces.push(Buf ? Buf.from(new Uint8Array(p)) : new Uint8Array(p));
                else if (typeof p === 'string') pieces.push(Buf ? Buf.from(p, 'utf8') : new globalThis.TextEncoder().encode(p));
                else if (p && typeof p.arrayBuffer === 'function') {
                    // Nested Blob — sync access to its internal bytes.
                    pieces.push(Buf ? Buf.from(p._bytes || []) : (p._bytes || new Uint8Array(0)));
                } else {
                    var s = String(p);
                    pieces.push(Buf ? Buf.from(s, 'utf8') : new globalThis.TextEncoder().encode(s));
                }
            }
            // Concatenate.
            var total = 0;
            for (var j = 0; j < pieces.length; j++) total += pieces[j].length;
            var out = Buf ? Buf.alloc(total) : new Uint8Array(total);
            var off = 0;
            for (var k = 0; k < pieces.length; k++) {
                if (Buf) pieces[k].copy(out, off);
                else out.set(pieces[k], off);
                off += pieces[k].length;
            }
            this._bytes = out;
            this.size = total;
        };
        Blob.prototype.arrayBuffer = function() {
            var b = this._bytes;
            return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        };
        Blob.prototype.text = function() {
            return Promise.resolve(new globalThis.TextDecoder().decode(this._bytes));
        };
        Blob.prototype.bytes = function() {
            return Promise.resolve(new Uint8Array(this._bytes.buffer, this._bytes.byteOffset, this._bytes.byteLength));
        };
        Blob.prototype.slice = function(start, end, type) {
            var s = (start === undefined) ? 0 : (start | 0);
            var e = (end === undefined) ? this.size : (end | 0);
            if (s < 0) s = Math.max(this.size + s, 0);
            if (e < 0) e = Math.max(this.size + e, 0);
            s = Math.min(s, this.size); e = Math.min(e, this.size);
            var sub = this._bytes.slice(s, e);
            var out = Object.create(Blob.prototype);
            out._bytes = sub; out.size = sub.length;
            out.type = type ? String(type).toLowerCase() : '';
            return out;
        };
        Blob.prototype.stream = function() {
            // Best-effort: a stream-shaped object with one chunk.
            var bytes = this._bytes;
            var done = false;
            return {
                getReader: function() {
                    return {
                        read: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            return Promise.resolve({ value: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), done: false });
                        },
                        cancel: function() { done = true; return Promise.resolve(); },
                        releaseLock: function() {},
                    };
                },
                [Symbol.asyncIterator]: function() {
                    return {
                        next: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            return Promise.resolve({ value: bytes, done: false });
                        },
                    };
                },
            };
        };
        globalThis.Blob = Blob;
    }
    if (typeof globalThis.File !== 'function') {
        globalThis.File = function File(parts, name, options) {
            globalThis.Blob.call(this, parts, options);
            this.name = String(name);
            this.lastModified = (options && typeof options.lastModified === 'number') ? options.lastModified : Date.now();
            this.webkitRelativePath = '';
        };
        globalThis.File.prototype = Object.create(globalThis.Blob.prototype);
        globalThis.File.prototype.constructor = globalThis.File;
    }
    if (typeof globalThis.FormData !== 'function') {
        globalThis.FormData = function FormData() {
            this._entries = [];
        };
        var FP = globalThis.FormData.prototype;
        FP.append = function(key, value, filename) {
            this._entries.push([String(key), value, filename]);
        };
        FP.set = function(key, value, filename) {
            this._entries = this._entries.filter(function(e) { return e[0] !== String(key); });
            this._entries.push([String(key), value, filename]);
        };
        FP.delete = function(key) {
            this._entries = this._entries.filter(function(e) { return e[0] !== String(key); });
        };
        FP.has = function(key) {
            return this._entries.some(function(e) { return e[0] === String(key); });
        };
        FP.get = function(key) {
            for (var i = 0; i < this._entries.length; i++)
                if (this._entries[i][0] === String(key)) return this._entries[i][1];
            return null;
        };
        FP.getAll = function(key) {
            return this._entries.filter(function(e) { return e[0] === String(key); }).map(function(e) { return e[1]; });
        };
        FP.entries = function() {
            var arr = this._entries.map(function(e) { return [e[0], e[1]]; });
            var idx = 0;
            return {
                next: function() {
                    if (idx >= arr.length) return { value: undefined, done: true };
                    return { value: arr[idx++], done: false };
                },
                [Symbol.iterator]: function() { return this; },
            };
        };
        FP.keys = function() {
            var arr = this._entries.map(function(e) { return e[0]; });
            var idx = 0;
            return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } };
        };
        FP.values = function() {
            var arr = this._entries.map(function(e) { return e[1]; });
            var idx = 0;
            return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } };
        };
        FP.forEach = function(cb, thisArg) {
            for (var i = 0; i < this._entries.length; i++) cb.call(thisArg, this._entries[i][1], this._entries[i][0], this);
        };
        FP[Symbol.iterator] = FP.entries;
    }

    // ----- MessageChannel / MessagePort / MessageEvent ---------------
    // Same-realm message passing. Worker code uses the API surface
    // even when the actual cross-thread mechanism is provided by the
    // worker_threads polyfill — we expose a same-realm impl so user
    // code that does `new MessageChannel()` doesn't crash.
    if (typeof globalThis.MessageEvent !== 'function') {
        globalThis.MessageEvent = function MessageEvent(type, init) {
            globalThis.Event.call(this, type, init);
            init = init || {};
            this.data = init.data === undefined ? null : init.data;
            this.origin = init.origin || '';
            this.lastEventId = init.lastEventId || '';
            this.source = init.source || null;
            this.ports = init.ports || [];
        };
        globalThis.MessageEvent.prototype = Object.create(globalThis.Event.prototype);
        globalThis.MessageEvent.prototype.constructor = globalThis.MessageEvent;
    }
    if (typeof globalThis.MessagePort !== 'function') {
        var MessagePort = function MessagePort() {
            globalThis.EventTarget.call(this);
            this._other = null;
            this._started = false;
            this._queued = [];
            this._onmessage = null;
        };
        MessagePort.prototype = Object.create(globalThis.EventTarget.prototype);
        MessagePort.prototype.constructor = MessagePort;
        Object.defineProperty(MessagePort.prototype, 'onmessage', {
            get: function() { return this._onmessage; },
            set: function(fn) {
                this._onmessage = fn;
                this.start();
            },
        });
        MessagePort.prototype.postMessage = function(data, transferList) {
            var other = this._other;
            if (!other) return;
            var ev = new globalThis.MessageEvent('message', { data: data, ports: transferList || [] });
            if (other._started || other._onmessage) {
                if (typeof globalThis.queueMicrotask === 'function') {
                    globalThis.queueMicrotask(function() {
                        if (typeof other._onmessage === 'function') other._onmessage(ev);
                        other.dispatchEvent(ev);
                    });
                } else {
                    Promise.resolve().then(function() {
                        if (typeof other._onmessage === 'function') other._onmessage(ev);
                        other.dispatchEvent(ev);
                    });
                }
            } else {
                other._queued.push(ev);
            }
        };
        MessagePort.prototype.start = function() {
            if (this._started) return;
            this._started = true;
            var self = this;
            for (var i = 0; i < this._queued.length; i++) {
                (function(ev) {
                    Promise.resolve().then(function() {
                        if (typeof self._onmessage === 'function') self._onmessage(ev);
                        self.dispatchEvent(ev);
                    });
                })(this._queued[i]);
            }
            this._queued.length = 0;
        };
        MessagePort.prototype.close = function() {
            this._other = null;
            this._onmessage = null;
        };
        globalThis.MessagePort = MessagePort;
    }
    if (typeof globalThis.MessageChannel !== 'function') {
        globalThis.MessageChannel = function MessageChannel() {
            this.port1 = new globalThis.MessagePort();
            this.port2 = new globalThis.MessagePort();
            this.port1._other = this.port2;
            this.port2._other = this.port1;
        };
    }
    if (typeof globalThis.BroadcastChannel !== 'function') {
        // Sandbox is single-realm, so a BroadcastChannel just delivers
        // messages to other channels with the same name in this same
        // process. Useful for in-process module-coordination patterns.
        if (!globalThis.__ab_bc_registry) globalThis.__ab_bc_registry = {};
        var BroadcastChannel = function BroadcastChannel(name) {
            globalThis.EventTarget.call(this);
            this.name = String(name);
            this._closed = false;
            this._onmessage = null;
            var reg = globalThis.__ab_bc_registry;
            (reg[this.name] = reg[this.name] || []).push(this);
        };
        BroadcastChannel.prototype = Object.create(globalThis.EventTarget.prototype);
        BroadcastChannel.prototype.constructor = BroadcastChannel;
        Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
            get: function() { return this._onmessage; },
            set: function(v) { this._onmessage = v; },
        });
        BroadcastChannel.prototype.postMessage = function(data) {
            if (this._closed) return;
            var ev = new globalThis.MessageEvent('message', { data: data });
            var peers = (globalThis.__ab_bc_registry[this.name] || []).filter(function(c) { return c !== this; }, this);
            var self = this;
            peers.forEach(function(peer) {
                if (peer._closed) return;
                Promise.resolve().then(function() {
                    if (typeof peer._onmessage === 'function') peer._onmessage(ev);
                    peer.dispatchEvent(ev);
                });
            });
        };
        BroadcastChannel.prototype.close = function() {
            this._closed = true;
            var reg = globalThis.__ab_bc_registry;
            if (reg[this.name]) {
                reg[this.name] = reg[this.name].filter(function(c) { return c !== this; }, this);
            }
        };
        globalThis.BroadcastChannel = BroadcastChannel;
    }

    // ----- Web Crypto (globalThis.crypto) ---------------------------
    // Modern crypto is via the SubtleCrypto WebCrypto API. Most uses
    // we see in Node code are `crypto.randomUUID()`,
    // `crypto.getRandomValues()`, `crypto.subtle.digest()`. Lazy-load
    // node:crypto on first call so module-init time doesn't reach
    // into the host bridge before host imports are wired (Wizer
    // pre-init runs the bundle without our custom wasm imports
    // bound; eager require here trips the linker).
    if (typeof globalThis.crypto !== 'object' || !globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
        var webCrypto = globalThis.crypto || {};
        function _hexToBytes(hex) {
            var out = new Uint8Array(hex.length / 2);
            for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
            return out;
        }
        webCrypto.randomUUID = function() {
            try {
                var nc = require('crypto');
                if (typeof nc.randomUUID === 'function') return nc.randomUUID();
            } catch (_) {}
            var r = '';
            for (var i = 0; i < 32; i++) {
                if (i === 8 || i === 12 || i === 16 || i === 20) r += '-';
                r += Math.floor(Math.random() * 16).toString(16);
            }
            return r;
        };
        webCrypto.getRandomValues = function(typed) {
            if (!typed || typeof typed.length !== 'number') {
                throw new TypeError('getRandomValues: typed-array required');
            }
            var n = typed.byteLength || typed.length;
            try {
                var nc = require('crypto');
                if (nc && nc.randomBytes) {
                    var hex = nc.randomBytes(n);
                    var bytes = (typeof hex === 'string') ? _hexToBytes(hex) : hex;
                    var view = new Uint8Array(typed.buffer || typed, typed.byteOffset || 0, n);
                    for (var i = 0; i < n; i++) view[i] = bytes[i];
                    return typed;
                }
            } catch (_) {}
            var view2 = new Uint8Array(typed.buffer || typed, typed.byteOffset || 0, n);
            for (var j = 0; j < n; j++) view2[j] = Math.floor(Math.random() * 256);
            return typed;
        };
        webCrypto.subtle = webCrypto.subtle || {
            digest: function(algo, data) {
                var algorithm = (typeof algo === 'string') ? algo : (algo && algo.name) || '';
                var nodeAlgo = algorithm.toLowerCase().replace('-', '');
                try {
                    var nc = require('crypto');
                    var hash = nc.createHash(nodeAlgo);
                    var bytes = (data instanceof ArrayBuffer) ? new Uint8Array(data)
                              : (data && data.buffer) ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
                              : data;
                    hash.update(bytes);
                    var hex = hash.digest('hex');
                    return Promise.resolve(_hexToBytes(hex).buffer);
                } catch (e) { return Promise.reject(e); }
            },
        };
        globalThis.crypto = webCrypto;
    }

    // ----- navigator (Node 22+) -------------------------------------
    if (typeof globalThis.navigator !== 'object' || !globalThis.navigator) {
        globalThis.navigator = {
            userAgent: 'Node.js/26.0.0 (Afterburner)',
            language: 'en-US',
            languages: ['en-US'],
            hardwareConcurrency: 1,
            platform: globalThis.process && globalThis.process.platform || 'linux',
            onLine: true,
        };
    }

    // ----- Streams Web globals --------------------------------------
    // The polyfill bundle registers `stream/web` as a require target
    // but Node 18+ also exposes the constructors as globals. Bring
    // them onto globalThis so undici / web-streams-polyfill probes
    // see them.
    try {
        var sw = require('stream/web');
        ['ReadableStream','WritableStream','TransformStream',
         'ByteLengthQueuingStrategy','CountQueuingStrategy',
         'ReadableStreamDefaultReader','ReadableStreamBYOBReader',
         'WritableStreamDefaultWriter','TransformStreamDefaultController'
        ].forEach(function(name) {
            if (sw[name] && !globalThis[name]) globalThis[name] = sw[name];
        });
    } catch (_) {}

    // ----- TextEncoderStream / TextDecoderStream --------------------
    // TransformStream subclasses that pump chunks through encode/decode.
    // Defer until ReadableStream is available so we can compose.
    if (typeof globalThis.TextEncoderStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var TES = function TextEncoderStream() {
            var enc = new globalThis.TextEncoder();
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    controller.enqueue(enc.encode(String(chunk)));
                },
            });
            this.encoding = enc.encoding;
        };
        TES.prototype = Object.create(globalThis.TransformStream && globalThis.TransformStream.prototype || Object.prototype);
        globalThis.TextEncoderStream = TES;
    }
    if (typeof globalThis.TextDecoderStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var TDS = function TextDecoderStream(label, options) {
            var dec = new globalThis.TextDecoder(label, options);
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    controller.enqueue(dec.decode(chunk));
                },
            });
            this.encoding = dec.encoding;
        };
        TDS.prototype = Object.create(globalThis.TransformStream && globalThis.TransformStream.prototype || Object.prototype);
        globalThis.TextDecoderStream = TDS;
    }

    // ----- CompressionStream / DecompressionStream ------------------
    // Node 17+. Wrap zlib for the underlying codec; defer the
    // require to first call so Wizer pre-init doesn't reach the
    // host bridge.
    if (typeof globalThis.CompressionStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var CS = function CompressionStream(format) {
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    try {
                        var nz = require('zlib');
                        var Buf = globalThis.Buffer;
                        var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                        var syncFn = (format === 'gzip') ? nz.gzipSync :
                                     (format === 'deflate') ? nz.deflateSync :
                                     (format === 'deflate-raw') ? nz.deflateRawSync : null;
                        if (syncFn) controller.enqueue(syncFn(buf));
                        else controller.enqueue(chunk);
                    } catch (e) { controller.error(e); }
                },
            });
        };
        globalThis.CompressionStream = CS;
    }
    if (typeof globalThis.DecompressionStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var DS = function DecompressionStream(format) {
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    try {
                        var nz = require('zlib');
                        var Buf = globalThis.Buffer;
                        var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                        var syncFn = (format === 'gzip') ? nz.gunzipSync :
                                     (format === 'deflate') ? nz.inflateSync :
                                     (format === 'deflate-raw') ? nz.inflateRawSync : null;
                        if (syncFn) controller.enqueue(syncFn(buf));
                        else controller.enqueue(chunk);
                    } catch (e) { controller.error(e); }
                },
            });
        };
        globalThis.DecompressionStream = DS;
    }
    if (typeof globalThis.URL !== 'function') {
        var urlMod = require('url');
        if (typeof urlMod.URL === 'function') {
            globalThis.URL = urlMod.URL;
            globalThis.URLSearchParams = urlMod.URLSearchParams;
        } else {
            // Regex-based parser with proper RFC 3986 reference
            // resolution for the 2-arg form. Covers WHATWG-shape
            // properties (`protocol`/`host`/`pathname`/`search`/
            // `searchParams`) plus the redirect-following cases
            // node-fetch / minipass-fetch / pacote depend on:
            //   * `new URL('/p', 'https://h.com/x')`   → `https://h.com/p`
            //   * `new URL('p', 'https://h.com/x/y')`  → `https://h.com/x/p`
            //   * `new URL('https://o.com/p', 'https://h.com/x')` → `https://o.com/p`
            //   * `new URL('?q=1', 'https://h.com/x')` → `https://h.com/x?q=1`
            // Without these, every redirect-followed download breaks
            // with empty-host options and the upstream HTTP client
            // synthesises a malformed `https:///path` URL.
            function _parseAbs(s) {
                var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)?(\?[^#]*)?(#.*)?$/.exec(s);
                if (!m) return null;
                return { protocol: m[1] + ':', authority: m[2] || '', path: m[3] || '', query: m[4] || '', fragment: m[5] || '' };
            }
            function _normalizePath(p) {
                // RFC 3986 §5.2.4 — remove `.` and `..` segments.
                if (!p) return '';
                var leading = p.charAt(0) === '/';
                var trailing = p.charAt(p.length - 1) === '/';
                var parts = p.split('/').filter(function(s) { return s.length > 0; });
                var stack = [];
                for (var i = 0; i < parts.length; i++) {
                    var seg = parts[i];
                    if (seg === '.') continue;
                    if (seg === '..') { if (stack.length) stack.pop(); continue; }
                    stack.push(seg);
                }
                return (leading ? '/' : '') + stack.join('/') + (trailing && stack.length ? '/' : '');
            }
            globalThis.URL = function URL(href, base) {
                var input = String(href);
                var parsed = _parseAbs(input);
                if (!parsed && base) {
                    // Reference resolution per RFC 3986 §5.3.
                    var b = _parseAbs(String(base));
                    if (b) {
                        // Same-document fragment.
                        if (input.charAt(0) === '#') {
                            input = (b.protocol + '//' + b.authority + b.path + b.query + input);
                        } else if (input.charAt(0) === '?') {
                            input = (b.protocol + '//' + b.authority + b.path + input);
                        } else if (input.charAt(0) === '/') {
                            // Absolute path on the base authority.
                            input = (b.protocol + '//' + b.authority + input);
                        } else {
                            // Path-relative against the base directory.
                            var basePath = b.path || '/';
                            // Strip the last segment.
                            var slash = basePath.lastIndexOf('/');
                            var baseDir = slash >= 0 ? basePath.slice(0, slash + 1) : '/';
                            input = (b.protocol + '//' + b.authority + _normalizePath(baseDir + input));
                        }
                        parsed = _parseAbs(input);
                    }
                }
                var protocol = parsed ? parsed.protocol : '';
                var host = parsed ? parsed.authority : '';
                var path = parsed ? (parsed.path || '/') : input;
                var query = parsed ? parsed.query : '';
                var fragment = parsed ? parsed.fragment : '';
                // Username / password split off the authority.
                var username = '', password = '';
                var atIdx = host.indexOf('@');
                if (atIdx >= 0) {
                    var userinfo = host.slice(0, atIdx);
                    host = host.slice(atIdx + 1);
                    var colonIdx = userinfo.indexOf(':');
                    if (colonIdx >= 0) {
                        username = userinfo.slice(0, colonIdx);
                        password = userinfo.slice(colonIdx + 1);
                    } else {
                        username = userinfo;
                    }
                }
                var hp = host.split(':');
                var hostname = hp[0] || '';
                var port = hp.length > 1 ? hp[1] : '';
                this.protocol = protocol;
                this.host = host;
                this.hostname = hostname;
                this.port = port;
                this.pathname = _normalizePath(path);
                if (this.pathname === '' && host) this.pathname = '/';
                this.search = query;
                this.hash = fragment;
                this.username = username;
                this.password = password;
                this.origin = protocol + (host ? '//' + host : '');
                this.href = protocol + '//' + (username ? username + (password ? ':' + password : '') + '@' : '') + host + this.pathname + this.search + this.hash;
                this.searchParams = new globalThis.URLSearchParams(this.search.slice(1));
            };
            globalThis.URL.prototype.toString = function() { return this.href; };
            globalThis.URL.prototype.toJSON  = function() { return this.href; };
            globalThis.URL.canParse = function(href, base) {
                try { new globalThis.URL(href, base); return true; }
                catch (_) { return false; }
            };
            globalThis.URL.parse = function(href, base) {
                try { return new globalThis.URL(href, base); }
                catch (_) { return null; }
            };
            globalThis.URL.createObjectURL = function() { throw new Error('URL.createObjectURL not supported'); };
            globalThis.URL.revokeObjectURL = function() {};

            globalThis.URLSearchParams = function URLSearchParams(init) {
                this._pairs = [];
                var self = this;
                if (typeof init === 'string') {
                    var s = init.replace(/^\?/, '');
                    if (s) s.split('&').forEach(function(p) {
                        var eq = p.indexOf('=');
                        var k = eq < 0 ? p : p.slice(0, eq);
                        var v = eq < 0 ? '' : p.slice(eq + 1);
                        self._pairs.push([decodeURIComponent(k), decodeURIComponent(v)]);
                    });
                } else if (init && typeof init === 'object') {
                    Object.keys(init).forEach(function(k) {
                        self._pairs.push([k, String(init[k])]);
                    });
                }
            };
            var P = globalThis.URLSearchParams.prototype;
            P.get = function(k) {
                for (var i = 0; i < this._pairs.length; i++)
                    if (this._pairs[i][0] === k) return this._pairs[i][1];
                return null;
            };
            P.getAll = function(k) {
                return this._pairs.filter(function(p) { return p[0] === k; })
                                  .map(function(p) { return p[1]; });
            };
            P.has = function(k) {
                return this._pairs.some(function(p) { return p[0] === k; });
            };
            P.set = function(k, v) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
                this._pairs.push([k, String(v)]);
            };
            P.append = function(k, v) { this._pairs.push([k, String(v)]); };
            P.delete = function(k) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
            };
            P.toString = function() {
                return this._pairs.map(function(p) {
                    return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
                }).join('&');
            };
        }
    }

    // ============================================================
    // ES2024 / ES2023 globals.
    //
    // The runtime's QuickJS may add these natively in a future build;
    // every install is gated on `!has(...)` so the polyfill is a
    // no-op once the engine catches up. Idempotent + safe.
    // ============================================================

    // ---- Promise.withResolvers (Stage 4, Node 22) -------------------
    if (typeof Promise.withResolvers !== 'function') {
        Object.defineProperty(Promise, 'withResolvers', {
            value: function withResolvers() {
                var resolve, reject;
                var promise = new this(function(res, rej) { resolve = res; reject = rej; });
                return { promise: promise, resolve: resolve, reject: reject };
            },
            writable: true, configurable: true,
        });
    }

    // ---- Object.groupBy / Map.groupBy (ES2024) ----------------------
    if (typeof Object.groupBy !== 'function') {
        Object.defineProperty(Object, 'groupBy', {
            value: function groupBy(items, keyFn) {
                var out = Object.create(null);
                var i = 0;
                for (var it of items) {
                    var k = keyFn(it, i++);
                    var key = (typeof k === 'symbol') ? k : String(k);
                    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = [];
                    out[key].push(it);
                }
                return out;
            },
            writable: true, configurable: true,
        });
    }
    if (typeof Map.groupBy !== 'function') {
        Object.defineProperty(Map, 'groupBy', {
            value: function groupBy(items, keyFn) {
                var out = new Map();
                var i = 0;
                for (var it of items) {
                    var k = keyFn(it, i++);
                    var arr = out.get(k);
                    if (!arr) { arr = []; out.set(k, arr); }
                    arr.push(it);
                }
                return out;
            },
            writable: true, configurable: true,
        });
    }

    // ---- Set.prototype set-theoretic methods (ES2024, Node 22) -----
    //
    // The spec is precise about argument shape: every method takes a
    // "set-like" — an object with `size`, `has`, and `keys` — *not*
    // necessarily a `Set` instance. The polyfill matches that contract
    // so the polyfill behaves like the native methods if a script
    // passes e.g. a Map or a custom collection.
    function _setLikeOf(other, name) {
        if (other == null || typeof other !== 'object' && typeof other !== 'function') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like');
        }
        var size = other.size;
        if (typeof size !== 'number') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like (size)');
        }
        if (typeof other.has !== 'function' || typeof other.keys !== 'function') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like (has/keys)');
        }
        return { size: size, has: other.has.bind(other), keys: other.keys.bind(other) };
    }
    function _installSetMethod(name, impl) {
        if (typeof Set.prototype[name] === 'function') return;
        Object.defineProperty(Set.prototype, name, {
            value: impl, writable: true, configurable: true,
        });
    }
    _installSetMethod('intersection', function intersection(other) {
        var s = _setLikeOf(other, 'intersection');
        var result = new Set();
        // Iterate the smaller of (this, other) for O(min(n, m)).
        if (this.size <= s.size) {
            for (var v of this) if (s.has(v)) result.add(v);
        } else {
            var it = s.keys();
            for (var step = it.next(); !step.done; step = it.next()) {
                if (this.has(step.value)) result.add(step.value);
            }
        }
        return result;
    });
    _installSetMethod('union', function union(other) {
        var s = _setLikeOf(other, 'union');
        var result = new Set(this);
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            result.add(step.value);
        }
        return result;
    });
    _installSetMethod('difference', function difference(other) {
        var s = _setLikeOf(other, 'difference');
        var result = new Set();
        for (var v of this) if (!s.has(v)) result.add(v);
        return result;
    });
    _installSetMethod('symmetricDifference', function symmetricDifference(other) {
        var s = _setLikeOf(other, 'symmetricDifference');
        var result = new Set();
        for (var v of this) if (!s.has(v)) result.add(v);
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            if (!this.has(step.value)) result.add(step.value);
        }
        return result;
    });
    _installSetMethod('isSubsetOf', function isSubsetOf(other) {
        var s = _setLikeOf(other, 'isSubsetOf');
        if (this.size > s.size) return false;
        for (var v of this) if (!s.has(v)) return false;
        return true;
    });
    _installSetMethod('isSupersetOf', function isSupersetOf(other) {
        var s = _setLikeOf(other, 'isSupersetOf');
        if (this.size < s.size) return false;
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            if (!this.has(step.value)) return false;
        }
        return true;
    });
    _installSetMethod('isDisjointFrom', function isDisjointFrom(other) {
        var s = _setLikeOf(other, 'isDisjointFrom');
        if (this.size <= s.size) {
            for (var v of this) if (s.has(v)) return false;
        } else {
            var it = s.keys();
            for (var step = it.next(); !step.done; step = it.next()) {
                if (this.has(step.value)) return false;
            }
        }
        return true;
    });

    // ============================================================
    // URLPattern — WHATWG URL Pattern Standard.
    //
    // Supports the canonical shape used by routing libraries:
    //   new URLPattern({ pathname: '/users/:id' })
    //   new URLPattern('https://*.example.com/:path*')
    //   pattern.test(input) / pattern.exec(input)
    //
    // The matcher converts each component pattern into a RegExp with
    // named groups and a small wildcard grammar:
    //
    //   :name        capture (one segment, no `/`)
    //   :name(re)    capture with custom inline regex
    //   *            wildcard (zero-or-more anything)
    //   {x}          group
    //   {x}?         optional group
    //
    // Not implemented: pattern modifiers `?`/`+` after capture
    // groups (rare in practice). Real URL Pattern Standard supports
    // them — extend if a real workload surfaces.
    // ============================================================
    if (typeof globalThis.URLPattern !== 'function') {
        var COMPONENTS = ['protocol', 'username', 'password', 'hostname', 'port',
                          'pathname', 'search', 'hash'];

        function compileURLPattern(pat, isPath) {
            // Empty pattern → match anything.
            if (pat === undefined || pat === null || pat === '') {
                return { regex: /^.*$/, names: [] };
            }
            var src = String(pat);
            var out = '^';
            var names = [];
            var i = 0;
            while (i < src.length) {
                var c = src[i];
                if (c === '\\') {
                    // Escape: copy the next char raw.
                    if (i + 1 < src.length) {
                        out += '\\' + src[i + 1];
                        i += 2;
                    } else {
                        out += '\\\\';
                        i += 1;
                    }
                    continue;
                }
                if (c === ':' && /[A-Za-z_$]/.test(src[i + 1] || '')) {
                    // Capture group `:name` or `:name(regex)`.
                    var j = i + 1;
                    while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
                    var name = src.slice(i + 1, j);
                    var re;
                    if (src[j] === '(') {
                        var depth = 1, k = j + 1;
                        while (k < src.length && depth > 0) {
                            if (src[k] === '\\') { k += 2; continue; }
                            if (src[k] === '(') depth++;
                            else if (src[k] === ')') depth--;
                            if (depth > 0) k++;
                        }
                        re = src.slice(j + 1, k);
                        j = k + 1; // past `)`
                    } else {
                        re = isPath ? '[^/]+' : '[^/]+';
                    }
                    names.push(name);
                    out += '(' + re + ')';
                    i = j;
                    continue;
                }
                if (c === '*') {
                    out += '.*';
                    i += 1;
                    continue;
                }
                // Regex metacharacters get escaped so the literal text
                // matches itself, not as a metacharacter.
                if ('.^$+?()[]{}|'.indexOf(c) !== -1) {
                    out += '\\' + c;
                } else {
                    out += c;
                }
                i += 1;
            }
            out += '$';
            return { regex: new RegExp(out), names: names };
        }

        function URLPattern(input, baseURL) {
            if (!(this instanceof URLPattern)) {
                throw new TypeError('URLPattern is a constructor');
            }
            var spec = {};
            if (typeof input === 'string') {
                // Parse as URL pattern string. Use the first absolute
                // separator to split off scheme + host + path; we
                // rely on the URL parser for the easy split, then
                // assign each piece's pattern.
                try {
                    // The URL parser doesn't accept `:name` syntax in
                    // the path — temporarily encode `:` so URL parses,
                    // then decode.
                    var encoded = input.replace(/:([A-Za-z_$][A-Za-z0-9_$]*)/g, '__AB_URLP_$1__');
                    var u = new URL(encoded, baseURL || 'http://x.invalid/');
                    var dec = function(s) { return s.replace(/__AB_URLP_([A-Za-z0-9_$]+)__/g, ':$1'); };
                    spec.protocol = dec(u.protocol.replace(/:$/, ''));
                    spec.hostname = dec(u.hostname);
                    spec.port = dec(u.port);
                    spec.pathname = dec(u.pathname);
                    spec.search = dec(u.search.replace(/^\?/, ''));
                    spec.hash = dec(u.hash.replace(/^#/, ''));
                } catch (_) {
                    spec.pathname = input;
                }
            } else if (input && typeof input === 'object') {
                for (var k = 0; k < COMPONENTS.length; k++) {
                    if (input[COMPONENTS[k]] !== undefined) {
                        spec[COMPONENTS[k]] = String(input[COMPONENTS[k]]);
                    }
                }
            } else {
                throw new TypeError('URLPattern: input must be a string or object');
            }
            this._compiled = {};
            for (var n = 0; n < COMPONENTS.length; n++) {
                var name = COMPONENTS[n];
                this._compiled[name] = compileURLPattern(spec[name], name === 'pathname');
            }
        }

        function _exec(self, input) {
            var u;
            try {
                if (typeof input === 'string') u = new URL(input);
                else if (input && typeof input === 'object') {
                    // input shape: { pathname, search, ... } or full URL
                    u = {
                        protocol: (input.protocol || '').replace(/:$/, ''),
                        username: input.username || '',
                        password: input.password || '',
                        hostname: input.hostname || '',
                        port: input.port || '',
                        pathname: input.pathname || '',
                        search: (input.search || '').replace(/^\?/, ''),
                        hash: (input.hash || '').replace(/^#/, ''),
                    };
                } else {
                    return null;
                }
            } catch (_) { return null; }

            var inputs = {
                protocol: (u.protocol || '').replace(/:$/, ''),
                username: u.username || '',
                password: u.password || '',
                hostname: u.hostname || '',
                port: u.port || '',
                pathname: u.pathname || '',
                search: (u.search || '').replace(/^\?/, ''),
                hash: (u.hash || '').replace(/^#/, ''),
            };
            var result = { inputs: [input] };
            for (var i = 0; i < COMPONENTS.length; i++) {
                var name = COMPONENTS[i];
                var c = self._compiled[name];
                var m = c.regex.exec(inputs[name]);
                if (!m) return null;
                var groups = {};
                for (var g = 0; g < c.names.length; g++) {
                    groups[c.names[g]] = m[g + 1];
                }
                result[name] = { input: inputs[name], groups: groups };
            }
            return result;
        }

        URLPattern.prototype.test = function(input) { return _exec(this, input) !== null; };
        URLPattern.prototype.exec = function(input) { return _exec(this, input); };
        // Spec accessors (return the source pattern strings). Best-
        // effort: we don't reconstruct the original `:name` form, just
        // return a compiled regex source so `console.log(p.pathname)`
        // is at least informative.
        for (var ci = 0; ci < COMPONENTS.length; ci++) {
            (function(name) {
                Object.defineProperty(URLPattern.prototype, name, {
                    get: function() { return this._compiled[name].regex.source; },
                    configurable: true,
                });
            })(COMPONENTS[ci]);
        }

        globalThis.URLPattern = URLPattern;
    }
})();

// ---- webassembly.js ----
// `WebAssembly.*` — Node 20 / browser-spec API on top of burn's
// host-side wasmtime sub-runner.
//
// Burn already runs inside wasmtime (the QuickJS plugin); the host
// gives us a parallel wasmtime instance to load **additional**
// WebAssembly modules at runtime. With this in place, every WASM-
// shipped npm package (sql.js, @jsquash/*, libheif-js, etc.) becomes
// loadable through the standard `WebAssembly.compile` /
// `WebAssembly.instantiate` calls — no per-package shadow code.
//
// Coverage (matches the Node + browser spec where it matters):
//
//   WebAssembly.compile(bufferSource)              -> Promise<Module>
//   WebAssembly.instantiate(bufferSource, imports) -> Promise<{module, instance}>
//   WebAssembly.instantiate(module, imports)       -> Promise<Instance>
//   WebAssembly.validate(bufferSource)             -> boolean
//   WebAssembly.Module(bytes)                      // sync
//   WebAssembly.Module.exports(module)             // [{name, kind, ...}]
//   WebAssembly.Module.imports(module)             // [{module, name, kind}]
//   WebAssembly.Instance(module, imports)          // sync
//   WebAssembly.Memory({initial, maximum?, shared?})  // backed when an
//      instance imports/exports a memory; standalone Memory creation
//      surfaces a clear "not supported" error in v1.
//   WebAssembly.{Compile,Link,Runtime}Error
//
// Out of scope for v1 (each will throw with a clear message):
//   * User-defined function imports — modules importing arbitrary
//     `env.*` callbacks won't instantiate yet. The error names the
//     missing import so callers can identify what's needed.
//   * `compileStreaming` / `instantiateStreaming` — no Response in
//     burn (no DOM); fetch the bytes manually first.
//   * Standalone `new WebAssembly.Memory(...)` / `Table` / `Global`.
//   * `Module.customSections(module, name)`.

(function installWebAssembly() {
    var Buffer = require('buffer').Buffer;

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            throw new Error('WebAssembly host import unavailable: ' + name);
        }
        return fn;
    }

    /// Coerce a JS value to bytes: ArrayBuffer / Uint8Array / Buffer.
    function bufferSourceToBytes(src) {
        if (Buffer.isBuffer(src)) return src;
        if (src instanceof Uint8Array) return Buffer.from(src);
        if (src && src.byteLength !== undefined && src instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(src));
        }
        if (src && src.buffer instanceof ArrayBuffer && typeof src.byteLength === 'number') {
            // TypedArray view (Int32Array, etc.).
            return Buffer.from(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
        }
        throw new TypeError(
            'WebAssembly: argument must be a BufferSource (ArrayBuffer, Uint8Array, Buffer)'
        );
    }

    // ---- typed errors (matches the spec) ---------------------------

    function CompileError(message) {
        var e = new Error(message);
        e.name = 'CompileError';
        return e;
    }
    function LinkError(message) {
        var e = new Error(message);
        e.name = 'LinkError';
        return e;
    }
    function RuntimeError(message) {
        var e = new Error(message);
        e.name = 'RuntimeError';
        return e;
    }

    // ---- Module ----------------------------------------------------

    function Module(bytesSource) {
        if (!(this instanceof Module)) return new Module(bytesSource);
        var bytes = bufferSourceToBytes(bytesSource);
        var fn = ensureHost('__host_wasm_compile');
        var id = fn(bytes.toString('base64'));
        if (id < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'compile failed';
            throw CompileError('WebAssembly.Module: ' + detail);
        }
        this._id = id;
    }

    /// Spec-static: WebAssembly.Module.exports(module) →
    /// [{name, kind}, ...] where `kind` is one of 'function', 'table',
    /// 'memory', 'global'.
    Module.exports = function(mod) {
        var fn = ensureHost('__host_wasm_module_exports');
        var raw = fn(mod._id);
        if (isHostErr(raw)) throw new Error(raw.slice('__HOST_ERR__:'.length));
        var arr = JSON.parse(raw);
        return arr.map(function(e) { return { name: e.name, kind: e.kind }; });
    };
    Module.imports = function(mod) {
        var fn = ensureHost('__host_wasm_module_imports');
        var raw = fn(mod._id);
        if (isHostErr(raw)) throw new Error(raw.slice('__HOST_ERR__:'.length));
        var arr = JSON.parse(raw);
        return arr.map(function(e) { return { module: e.module, name: e.name, kind: e.kind }; });
    };
    Module.customSections = function() {
        // Spec: returns ArrayBuffer[]. We don't surface custom
        // sections in v1 — return an empty list rather than
        // throwing so feature-detection code (which iterates the
        // result) keeps working.
        return [];
    };

    // ---- Memory ---------------------------------------------------

    /// `WebAssembly.Memory` is normally a free-standing class users
    /// can construct (`new WebAssembly.Memory({initial: 1})`). v1
    /// supports it only as a *view* over an instance's exported
    /// memory — that's the shape every npm package actually uses.
    /// Constructing a standalone Memory throws a clear error.
    function Memory(descriptor) {
        // Internal-construction marker. Real callers always pass a
        // descriptor; instance-export wrap-ups pass `{ _instanceId }`.
        if (descriptor && descriptor._instanceId !== undefined) {
            this._instanceId = descriptor._instanceId;
            return;
        }
        throw new Error(
            'WebAssembly.Memory(descriptor) standalone construction is not supported in burn yet — ' +
            'access memory via instance.exports.memory after instantiating a module that exports one.'
        );
    }

    Object.defineProperty(Memory.prototype, 'buffer', {
        get: function() {
            // Spec: returns ArrayBuffer view. We snapshot the host
            // memory into a fresh Uint8Array each call. Mutating the
            // snapshot does NOT affect the WASM memory — callers that
            // want to write must use `memory._write(offset, buf)` (a
            // burn extension, since the spec's ArrayBuffer would
            // require shared-buffer semantics we don't have).
            var sizeFn = ensureHost('__host_wasm_memory_size');
            var size = sizeFn(this._instanceId) | 0;
            if (size < 0) {
                throw new Error('WebAssembly.Memory: instance closed or no memory');
            }
            var readFn = ensureHost('__host_wasm_memory_read');
            var b64 = readFn(this._instanceId, 0, size);
            if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
            return Buffer.from(b64, 'base64').buffer;
        },
    });

    /// Burn extension: read raw bytes at `offset` for `len` bytes.
    /// More efficient than `.buffer` for slicing.
    Memory.prototype.read = function(offset, len) {
        var fn = ensureHost('__host_wasm_memory_read');
        var b64 = fn(this._instanceId, offset | 0, len | 0);
        if (isHostErr(b64)) throw new Error(b64.slice('__HOST_ERR__:'.length));
        return Buffer.from(b64, 'base64');
    };

    /// Burn extension: write a Buffer / Uint8Array into the WASM
    /// memory at `offset`. The spec's `memory.buffer.set(...)` would
    /// require shared-buffer semantics with the host, which we don't
    /// have — `write()` is the explicit replacement.
    Memory.prototype.write = function(offset, data) {
        var bytes;
        if (Buffer.isBuffer(data)) bytes = data;
        else if (data instanceof Uint8Array) bytes = Buffer.from(data);
        else if (data instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(data));
        else throw new TypeError('WebAssembly.Memory.write: data must be Buffer/Uint8Array/ArrayBuffer');
        var fn = ensureHost('__host_wasm_memory_write');
        var rc = fn(this._instanceId, offset | 0, bytes.toString('base64'));
        if (rc < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'memory write failed';
            throw new Error('WebAssembly.Memory.write: ' + detail);
        }
        return bytes.length;
    };

    Memory.prototype.grow = function() {
        // grow() returns the previous size in pages. Not exposed in
        // v1; callers usually let WASM grow itself.
        throw new Error('WebAssembly.Memory.grow is not supported in burn yet');
    };

    // ---- Instance -------------------------------------------------

    function Instance(mod, importsObject) {
        if (!(this instanceof Instance)) return new Instance(mod, importsObject);
        var instFn = ensureHost('__host_wasm_instantiate');
        var iid = instFn(mod._id);
        if (iid < 0) {
            var detail = (typeof globalThis.__host_last_error === 'function')
                ? globalThis.__host_last_error()
                : 'instantiate failed';
            throw LinkError('WebAssembly.Instance: ' + detail);
        }
        this._id = iid;
        this._module = mod;
        this.exports = buildExportsProxy(iid, mod);
        // `importsObject` is accepted but ignored in v1 — burn's
        // loader doesn't bridge JS callbacks back into wasmtime yet.
        // Modules that need imports fail at the host-side
        // instantiate step above.
        var _ = importsObject;
    }

    function buildExportsProxy(instanceId, mod) {
        var exportsList = Module.exports(mod);
        var out = {};
        // Track exported memory so memory.read/write/buffer work.
        var memoryExportName = null;
        var rawExports = JSON.parse(
            ensureHost('__host_wasm_module_exports')(mod._id)
        );
        for (var i = 0; i < rawExports.length; i++) {
            var exp = rawExports[i];
            (function bind(exp) {
                if (exp.kind === 'function') {
                    out[exp.name] = function() {
                        var args = Array.prototype.slice.call(arguments);
                        var encoded = args.map(encodeArg);
                        var callFn = ensureHost('__host_wasm_call_export');
                        var raw = callFn(
                            instanceId, exp.name, JSON.stringify(encoded)
                        );
                        if (isHostErr(raw)) {
                            throw RuntimeError(raw.slice('__HOST_ERR__:'.length));
                        }
                        var results = JSON.parse(raw);
                        if (results.length === 0) return undefined;
                        if (results.length === 1) return decodeResult(results[0]);
                        return results.map(decodeResult);
                    };
                } else if (exp.kind === 'memory') {
                    if (memoryExportName === null) memoryExportName = exp.name;
                    out[exp.name] = new Memory({ _instanceId: instanceId });
                } else if (exp.kind === 'table') {
                    out[exp.name] = {
                        // v1: opaque table object — methods stub.
                        _kind: 'table',
                        get: function() { throw new Error('WebAssembly.Table.get not supported in burn yet'); },
                        set: function() { throw new Error('WebAssembly.Table.set not supported in burn yet'); },
                        grow: function() { throw new Error('WebAssembly.Table.grow not supported in burn yet'); },
                    };
                } else if (exp.kind === 'global') {
                    out[exp.name] = {
                        _kind: 'global',
                        get value() { throw new Error('WebAssembly.Global.value not supported in burn yet'); },
                        set value(_) { throw new Error('WebAssembly.Global.value not supported in burn yet'); },
                    };
                }
            })(exp);
        }
        var _ = exportsList;
        var __ = memoryExportName;
        return out;
    }

    /// Convert a JS arg to the bridge's tagged-union shape.
    /// Defaults to i32 for finite integers, f64 for non-integers,
    /// i64 (string) for BigInt.
    function encodeArg(v) {
        if (typeof v === 'number') {
            if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
                return { type: 'i32', value: v | 0 };
            }
            return { type: 'f64', value: v };
        }
        if (typeof v === 'bigint') {
            return { type: 'i64', value: v.toString() };
        }
        if (typeof v === 'boolean') {
            return { type: 'i32', value: v ? 1 : 0 };
        }
        throw new TypeError('WebAssembly: unsupported argument type ' + typeof v);
    }

    /// Convert the bridge's tagged result back to a JS value.
    /// i64 returns a BigInt to preserve precision for values > 2^53.
    function decodeResult(r) {
        switch (r.type) {
            case 'i32': return r.value;
            case 'f32': return r.value;
            case 'f64': return r.value;
            case 'i64': return BigInt(r.value);
            default: return r.value;
        }
    }

    // ---- module-level static API ----------------------------------

    function compile(bufferSource) {
        return new Promise(function(resolve, reject) {
            try { resolve(new Module(bufferSource)); }
            catch (e) { reject(e); }
        });
    }

    function instantiate(bufferSourceOrModule, imports) {
        return new Promise(function(resolve, reject) {
            try {
                if (bufferSourceOrModule instanceof Module) {
                    resolve(new Instance(bufferSourceOrModule, imports));
                } else {
                    var mod = new Module(bufferSourceOrModule);
                    var inst = new Instance(mod, imports);
                    resolve({ module: mod, instance: inst });
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    function validate(bufferSource) {
        try {
            new Module(bufferSource);
            return true;
        } catch (_) {
            return false;
        }
    }

    function compileStreaming() {
        return Promise.reject(new Error(
            'WebAssembly.compileStreaming is not supported in burn — ' +
            'fetch bytes first via fs / fetch and pass them to WebAssembly.compile'
        ));
    }
    function instantiateStreaming() {
        return Promise.reject(new Error(
            'WebAssembly.instantiateStreaming is not supported in burn — ' +
            'fetch bytes first via fs / fetch and pass them to WebAssembly.instantiate'
        ));
    }

    var WebAssembly = {
        compile: compile,
        instantiate: instantiate,
        validate: validate,
        compileStreaming: compileStreaming,
        instantiateStreaming: instantiateStreaming,
        Module: Module,
        Instance: Instance,
        Memory: Memory,
        Table: function() {
            throw new Error('WebAssembly.Table standalone construction is not supported in burn yet');
        },
        Global: function() {
            throw new Error('WebAssembly.Global standalone construction is not supported in burn yet');
        },
        CompileError: function(msg) { return CompileError(msg); },
        LinkError: function(msg) { return LinkError(msg); },
        RuntimeError: function(msg) { return RuntimeError(msg); },
    };

    globalThis.WebAssembly = WebAssembly;
})();

// ---- worker_threads.js ----
// worker_threads — process-per-worker polyfill (B10).
//
// Each `new Worker(path, opts)` in the parent JS spawns a child
// `burn run --internal-worker <path>` subprocess via the host import
// __host_worker_spawn. IPC is JSON over length-prefixed pipes; the
// host's daemon-event dispatcher delivers worker→parent frames here
// as `{kind:"worker-message"|"worker-online"|"worker-error"|"worker-exit"}`
// envelopes.
//
// Inside a worker child the same module surfaces a `parentPort` whose
// postMessage routes to __host_worker_post_to_parent. Parent → child
// frames arrive via daemon-event as `{kind:"worker-parent-message"}`
// or `{kind:"worker-terminate-requested"}`.
//
// **Not supported in the minimal subset:**
// - `new Worker(code, { eval: true })` — explicit error
// - MessageChannel / MessagePort standalone (only Worker / parentPort)
// - transferList / SharedArrayBuffer
// - worker.stdout / worker.stderr as readable streams (forwarded to
//   parent stderr instead — see daemon_workers.rs)
// - resourceLimits
// - argv / env / execArgv overrides

(function bootstrapWorkerThreadsGlobals() {
    if (!globalThis.__ab_worker_handlers) {
        globalThis.__ab_worker_handlers = {};
    }
    if (!globalThis.__ab_worker_parent_port_handlers) {
        globalThis.__ab_worker_parent_port_handlers = null;
    }
})();

__register_module('worker_threads', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function isMainThreadFn() {
        if (typeof globalThis.__host_worker_is_main_thread !== 'function') return true;
        return globalThis.__host_worker_is_main_thread() !== 0;
    }

    function threadIdFn() {
        if (typeof globalThis.__host_worker_thread_id !== 'function') return 0;
        return globalThis.__host_worker_thread_id() | 0;
    }

    function workerDataValue() {
        if (typeof globalThis.__host_worker_data !== 'function') return undefined;
        var s = globalThis.__host_worker_data();
        if (!s) return undefined;
        try { return JSON.parse(s); } catch (_) { return undefined; }
    }

    var IS_MAIN = isMainThreadFn();
    var THREAD_ID = threadIdFn();
    var WORKER_DATA = IS_MAIN ? undefined : workerDataValue();

    // ----------------------------------------------------------------
    // Worker (parent-side handle to a child process)
    // ----------------------------------------------------------------

    function Worker(scriptPath, opts) {
        if (!(this instanceof Worker)) return new Worker(scriptPath, opts);
        EventEmitter.call(this);

        opts = opts || {};
        if (opts.eval) {
            throw new Error(
                "worker_threads: `new Worker(code, { eval: true })` is not supported in burn"
            );
        }
        if (typeof scriptPath !== 'string') {
            // Node accepts a URL object. We stringify; Node's URL polyfill
            // (if loaded) will provide .toString() compatible output.
            scriptPath = String(scriptPath);
        }
        if (scriptPath.indexOf('file:') === 0) {
            // Strip a `file://` prefix produced by URL.toString() — the
            // host validator wants a regular FS path.
            scriptPath = scriptPath.replace(/^file:\/\//, '');
        }

        if (typeof globalThis.__host_worker_spawn !== 'function') {
            throw new Error(
                "worker_threads requires daemon mode; run via `burn foo.js` CLI"
            );
        }

        var dataJson = '';
        if (typeof opts.workerData !== 'undefined') {
            try { dataJson = JSON.stringify(opts.workerData); }
            catch (e) {
                throw new TypeError(
                    'workerData must be JSON-serializable: ' + e.message
                );
            }
        }

        var rc = globalThis.__host_worker_spawn(scriptPath, dataJson);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw mapSpawnError(rc, detail);
        }

        this.threadId = rc | 0;
        this._terminated = false;
        // Register self in the dispatch table so daemon-event can route
        // 'message' / 'online' / 'error' / 'exit' to this instance.
        globalThis.__ab_worker_handlers[this.threadId] = this;
    }

    Worker.prototype = Object.create(EventEmitter.prototype);
    Worker.prototype.constructor = Worker;

    Worker.prototype.postMessage = function(value) {
        if (this._terminated) {
            // Match Node's silent drop on already-exited workers; the
            // host returns E_BAD_ID anyway.
            return;
        }
        var json;
        try { json = JSON.stringify(value); }
        catch (e) {
            throw new TypeError(
                'postMessage value must be JSON-serializable: ' + e.message
            );
        }
        var rc = globalThis.__host_worker_post_message(this.threadId, json);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw new Error('worker.postMessage: ' + (detail || ('rc=' + rc)));
        }
    };

    Worker.prototype.terminate = function() {
        var self = this;
        if (self._terminated) return Promise.resolve(0);
        self._terminated = true;
        var rc = globalThis.__host_worker_terminate(self.threadId, 1);
        return new Promise(function(resolve) {
            // Resolve once the daemon-event pump fires `exit` for us.
            // If the worker was already gone, the exit may have been
            // emitted before terminate() was called; resolve quickly
            // in that case via a microtask.
            self.once('exit', function(code) { resolve(code | 0); });
            // Best-effort: if the host already returned an error code
            // (worker not found), cancel the wait.
            if (rc === -9) {
                self._dispatchExit(0);
            }
        });
    };

    // Internal: called by the daemon-event dispatcher when an
    // online/message/error/exit envelope arrives for this thread id.
    Worker.prototype._dispatchOnline = function() {
        try { this.emit('online'); } catch (_) {}
    };
    Worker.prototype._dispatchMessage = function(payloadJson) {
        var value;
        try { value = JSON.parse(payloadJson); } catch (_) { return; }
        try { this.emit('message', value); } catch (_) {}
    };
    Worker.prototype._dispatchError = function(message, stack) {
        var err = new Error(message || 'worker error');
        if (stack) err.stack = stack;
        try { this.emit('error', err); } catch (_) {}
    };
    Worker.prototype._dispatchExit = function(code) {
        if (this._terminated) {
            // Already removed from the table — re-entering from a
            // late exit notification.
        }
        this._terminated = true;
        try { this.emit('exit', code | 0); } catch (_) {}
        delete globalThis.__ab_worker_handlers[this.threadId];
    };

    function mapSpawnError(rc, detail) {
        var msg = detail || '';
        switch (rc) {
            case -1: return new Error(
                'worker_threads requires daemon mode; run via `burn foo.js`' +
                (msg ? (' (' + msg + ')') : '')
            );
            case -2: return new Error('worker_threads: permission denied' +
                (msg ? (': ' + msg) : ''));
            case -3: return new Error(msg ||
                'worker_threads: depth limit reached (BURN_WORKER_DEPTH)');
            case -4: return new Error(msg ||
                'worker_threads: concurrency cap reached');
            case -5: return new Error(msg ||
                'worker_threads: worker script path is outside fs allow-list');
            case -6: return new Error(msg ||
                'worker_threads: failed to spawn child process');
            case -7: return new Error(msg ||
                'worker_threads: payload exceeds frame size cap');
            case -11: return new Error(
                'worker_threads: { eval: true } is not supported in burn');
            default: return new Error('worker_threads: error rc=' + rc +
                (msg ? (': ' + msg) : ''));
        }
    }

    // ----------------------------------------------------------------
    // parentPort (child-side handle back to the parent)
    // ----------------------------------------------------------------

    function ParentPort() {
        EventEmitter.call(this);
        this._closed = false;
    }
    ParentPort.prototype = Object.create(EventEmitter.prototype);
    ParentPort.prototype.constructor = ParentPort;

    ParentPort.prototype.postMessage = function(value) {
        if (this._closed) return;
        var json;
        try { json = JSON.stringify(value); }
        catch (e) {
            throw new TypeError(
                'parentPort.postMessage value must be JSON-serializable: ' + e.message
            );
        }
        var rc = globalThis.__host_worker_post_to_parent(json);
        if (rc < 0) {
            var detail = '';
            if (typeof globalThis.__host_last_error === 'function') {
                detail = globalThis.__host_last_error();
            }
            throw new Error('parentPort.postMessage: ' + (detail || ('rc=' + rc)));
        }
    };

    ParentPort.prototype.close = function() {
        this._closed = true;
    };

    ParentPort.prototype._dispatchMessage = function(payloadJson) {
        var value;
        try { value = JSON.parse(payloadJson); } catch (_) { return; }
        try { this.emit('message', value); } catch (_) {}
    };

    ParentPort.prototype._dispatchTerminate = function() {
        try { this.emit('close'); } catch (_) {}
        this._closed = true;
    };

    var parentPort = null;
    if (!IS_MAIN) {
        parentPort = new ParentPort();
        globalThis.__ab_worker_parent_port_handlers = parentPort;

        // Fire `online` exactly once after the worker module finishes
        // its top-level evaluation. We use a microtask so any
        // `parentPort.on('message', cb)` the user installed during
        // top-level eval is registered before we signal readiness.
        Promise.resolve().then(function() {
            try { globalThis.__host_worker_post_online_to_parent(); } catch (_) {}
        });
    }

    // ----------------------------------------------------------------
    // Module exports
    // ----------------------------------------------------------------

    exports.Worker = Worker;
    exports.parentPort = parentPort;
    exports.workerData = WORKER_DATA;
    exports.isMainThread = IS_MAIN;
    exports.threadId = THREAD_ID;

    // Stubs for the deferred APIs — throw clearly rather than silently
    // returning undefined.
    exports.MessageChannel = function() {
        throw new Error(
            'worker_threads: MessageChannel is not implemented in burn yet'
        );
    };
    exports.MessagePort = function() {
        throw new Error(
            'worker_threads: standalone MessagePort is not implemented in burn yet'
        );
    };
    exports.markAsUntransferable = function() {};
    exports.moveMessagePortToContext = function() {
        throw new Error(
            'worker_threads: moveMessagePortToContext is not implemented in burn'
        );
    };
    exports.receiveMessageOnPort = function() {
        return undefined;
    };
    exports.SHARE_ENV = Symbol('SHARE_ENV');

    // ---- Environment-data slot (Node 14.5+) -----------------
    //
    // `setEnvironmentData(key, value)` / `getEnvironmentData(key)`
    // exchanges plain values across the parent → spawned-worker
    // boundary. We keep a single in-process map; spawned workers
    // see whatever was set in the parent before `new Worker(...)`.
    // The values flow through workerData on spawn.
    if (!globalThis.__ab_worker_env_data) {
        globalThis.__ab_worker_env_data = new Map();
    }
    var _envData = globalThis.__ab_worker_env_data;
    exports.setEnvironmentData = function setEnvironmentData(key, value) {
        if (value === undefined) _envData.delete(key);
        else _envData.set(key, value);
    };
    exports.getEnvironmentData = function getEnvironmentData(key) {
        return _envData.get(key);
    };

    // ---- BroadcastChannel re-export ------------------------
    // Node exports BroadcastChannel from worker_threads in addition
    // to the global. Keep the surfaces in sync.
    if (typeof globalThis.BroadcastChannel === 'function') {
        exports.BroadcastChannel = globalThis.BroadcastChannel;
    }
});

// ---- zlib.js ----
// zlib — synchronous deflate/inflate/gzip/gunzip backed by Rust
// (flate2). The wire format between JS and host is base64 strings so we
// don't need a binary-safe calling convention.

__register_module('zlib', function(module, exports, require) {

    var Buffer = require('buffer').Buffer;

    function needHost(name) {
        var fn = globalThis['__host_zlib_' + name];
        if (typeof fn !== 'function') {
            throw new Error('zlib.' + name + ' is not available');
        }
        return fn;
    }

    function toBase64(input) {
        if (Buffer.isBuffer(input)) return input.toString('base64');
        if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('base64');
        if (input instanceof Uint8Array) return Buffer.from(input).toString('base64');
        throw new TypeError('zlib: input must be Buffer, Uint8Array, or string');
    }

    function checkAndFromBase64(raw, op) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            throw new Error('zlib.' + op + ': ' + raw.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(raw, 'base64');
    }

    function call(op, input) {
        var raw = needHost(op)(toBase64(input));
        return checkAndFromBase64(raw, op);
    }

    exports.deflateSync  = function(input) { return call('deflate_sync', input);  };
    exports.inflateSync  = function(input) { return call('inflate_sync', input);  };
    exports.gzipSync     = function(input) { return call('gzip_sync',    input);  };
    exports.gunzipSync   = function(input) { return call('gunzip_sync',  input);  };

    // Promise wrappers — handy, free, no actual async under the hood.
    function asPromise(fn) {
        return function(input) {
            return new Promise(function(resolve, reject) {
                try { resolve(fn(input)); } catch (e) { reject(e); }
            });
        };
    }
    exports.deflate = asPromise(exports.deflateSync);
    exports.inflate = asPromise(exports.inflateSync);
    exports.gzip    = asPromise(exports.gzipSync);
    exports.gunzip  = asPromise(exports.gunzipSync);

    // Aliases for the *-raw flavours (no zlib header). flate2 doesn't
    // expose the raw codec through our current host bridge, so we
    // route them to the regular deflate/inflate. Most callers (npm,
    // pacote, tar) only use gzip / inflate / deflate; the raw forms
    // matter for HTTP `Content-Encoding: deflate` decoding which is
    // rare in practice.
    exports.deflateRawSync = exports.deflateSync;
    exports.inflateRawSync = exports.inflateSync;
    exports.deflateRaw     = exports.deflate;
    exports.inflateRaw     = exports.inflate;
    exports.unzip          = exports.gunzip;
    exports.unzipSync      = exports.gunzipSync;

    // ---- streaming class API ---------------------------------------
    //
    // `new zlib.Gzip()` / `Gunzip()` / `Inflate()` / `Deflate()` —
    // EventEmitter-shaped Transform handles. `write(chunk)` queues
    // input; `end()` runs the codec and emits `data` then `end`.
    // minizlib (and therefore tar / pacote / npm install's tarball
    // extraction path) wraps these with its own Minipass shim and
    // calls `_processChunk(chunk, flushFlag)` directly — that path
    // is the hot one and uses one big chunk per call (the full
    // body comes through our async HTTP as a single chunk).
    var EventEmitter = require('events');

    function makeStreamingClass(syncFn, opName) {
        return function Codec(opts) {
            EventEmitter.call(this);
            this._opts = opts || {};
            this._chunks = [];
            this._closed = false;
            // `_handle` is the native handle stand-in. minizlib reads
            // and writes it through several layers — keep it a
            // truthy object with a no-op `close` to avoid breaking
            // its bookkeeping. minizlib's `_handle.close` is hijacked
            // at call-time anyway.
            this._handle = { close: function() {} };
        };
    }

    function attachCodecPrototype(Cls, syncFn, opName) {
        Cls.prototype = Object.create(EventEmitter.prototype);
        Cls.prototype.constructor = Cls;
        Cls.prototype.write = function(chunk, _enc, cb) {
            if (this._closed) {
                if (typeof cb === 'function') cb(new Error('zlib: write after close'));
                return false;
            }
            var b = Buffer.isBuffer(chunk) ? chunk
                  : (typeof chunk === 'string') ? Buffer.from(chunk, _enc || 'utf8')
                  : (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                  : null;
            if (!b) {
                var e = new TypeError('zlib: chunk must be Buffer, Uint8Array, or string');
                if (typeof cb === 'function') cb(e);
                else this.emit('error', e);
                return false;
            }
            this._chunks.push(b);
            if (typeof cb === 'function') cb(null);
            return true;
        };
        Cls.prototype.end = function(chunk, _enc, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof _enc === 'function')  { cb = _enc;  _enc  = undefined; }
            if (chunk !== undefined) this.write(chunk, _enc);
            var self = this;
            // Run the codec on the next microtask so listeners
            // (`on('data', …)` / `on('end', …)`) attached after `end()`
            // — the canonical Node pattern in stream pipes — still
            // observe the output.
            Promise.resolve().then(function() {
                if (self._closed) return;
                self._closed = true;
                try {
                    var combined = Buffer.concat(self._chunks);
                    var out = syncFn(combined);
                    self.emit('data', out);
                    self.emit('end');
                    self.emit('close');
                    if (typeof cb === 'function') cb(null);
                } catch (e) {
                    self.emit('error', e);
                    if (typeof cb === 'function') cb(e);
                }
            });
            return self;
        };
        Cls.prototype.close = function(cb) {
            this._closed = true;
            this._chunks.length = 0;
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(); });
        };
        Cls.prototype.reset = function() {
            this._chunks.length = 0;
            this._closed = false;
        };
        Cls.prototype.flush = function(_kind, cb) {
            if (typeof _kind === 'function') { cb = _kind; }
            // Flush is meaningful only for streaming codecs that
            // support partial output. Sync wrapper has nothing to do.
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(); });
        };
        // `_processChunk(chunk, flushFlag)` — minizlib's internal hot
        // path. Synchronously decode/encode the chunk and return the
        // Buffer result. Every chunk through minizlib's flow is fed
        // here; for our async-HTTP body which arrives as one chunk,
        // this is called once with the full payload.
        //
        // minizlib follows the data chunk with an empty-buffer
        // "finalize" call (`Z_FINISH` flush flag). Node's native
        // codec returns empty bytes; our sync host gunzip would
        // throw "unexpected end of file" on the empty input. Short-
        // circuit: empty input → empty output, no host call.
        Cls.prototype._processChunk = function(chunk, _flushFlag) {
            var b = Buffer.isBuffer(chunk) ? chunk
                  : (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                  : Buffer.from(String(chunk));
            if (b.length === 0) return Buffer.alloc(0);
            return syncFn(b);
        };
        return Cls;
    }

    exports.Gzip    = attachCodecPrototype(makeStreamingClass(exports.gzipSync,    'gzip'),    exports.gzipSync,    'gzip');
    exports.Gunzip  = attachCodecPrototype(makeStreamingClass(exports.gunzipSync,  'gunzip'),  exports.gunzipSync,  'gunzip');
    exports.Deflate = attachCodecPrototype(makeStreamingClass(exports.deflateSync, 'deflate'), exports.deflateSync, 'deflate');
    exports.Inflate = attachCodecPrototype(makeStreamingClass(exports.inflateSync, 'inflate'), exports.inflateSync, 'inflate');
    exports.DeflateRaw    = exports.Deflate;
    exports.InflateRaw    = exports.Inflate;
    exports.Unzip         = exports.Gunzip;
    // Brotli — flate2 doesn't ship a brotli codec by default and the
    // host bridge lacks the entry. Constructable so `class X extends
    // zlib.BrotliCompress` doesn't trip QuickJS's "parent class must
    // be constructor" guard, but throws on actual use.
    function BrotliNotSupported() {
        throw Object.assign(new Error('zlib brotli codec not available'), { code: 'ERR_BROTLI_INVALID_PARAM' });
    }
    var BrotliClass = function() { BrotliNotSupported(); };
    BrotliClass.prototype = Object.create(EventEmitter.prototype);
    exports.BrotliCompress    = BrotliClass;
    exports.BrotliDecompress  = BrotliClass;

    // Factory functions that return a fresh codec instance. Mirrors
    // `http.createServer` / `net.createConnection` — Node sprinkles
    // these as the canonical entry point alongside the class form.
    exports.createGzip       = function(opts) { return new exports.Gzip(opts); };
    exports.createGunzip     = function(opts) { return new exports.Gunzip(opts); };
    exports.createDeflate    = function(opts) { return new exports.Deflate(opts); };
    exports.createInflate    = function(opts) { return new exports.Inflate(opts); };
    exports.createDeflateRaw = function(opts) { return new exports.DeflateRaw(opts); };
    exports.createInflateRaw = function(opts) { return new exports.InflateRaw(opts); };
    exports.createUnzip      = function(opts) { return new exports.Unzip(opts); };
    exports.createBrotliCompress    = function() { BrotliNotSupported(); };
    exports.createBrotliDecompress  = function() { BrotliNotSupported(); };

    // Constants block — every Z_* flush flag, error code, and
    // strategy. minizlib reads these by name (`Z_NO_FLUSH`,
    // `Z_FINISH`, etc.). Numeric values match upstream zlib.
    exports.constants = {
        Z_NO_FLUSH:      0, Z_PARTIAL_FLUSH:   1, Z_SYNC_FLUSH:     2,
        Z_FULL_FLUSH:    3, Z_FINISH:          4, Z_BLOCK:          5,
        Z_TREES:         6,
        Z_OK:            0, Z_STREAM_END:      1, Z_NEED_DICT:      2,
        Z_ERRNO:        -1, Z_STREAM_ERROR:   -2, Z_DATA_ERROR:    -3,
        Z_MEM_ERROR:    -4, Z_BUF_ERROR:      -5, Z_VERSION_ERROR: -6,
        Z_NO_COMPRESSION:    0, Z_BEST_SPEED:        1,
        Z_BEST_COMPRESSION:  9, Z_DEFAULT_COMPRESSION: -1,
        Z_FILTERED:          1, Z_HUFFMAN_ONLY:      2,
        Z_RLE:               3, Z_FIXED:             4,
        Z_DEFAULT_STRATEGY:  0,
        ZLIB_VERNUM:    0x12b0,
        DEFLATE:        1,    INFLATE:    2, GZIP: 3, GUNZIP: 4,
        DEFLATERAW:     5, INFLATERAW: 6, UNZIP: 7,
        BROTLI_DECODE:  8, BROTLI_ENCODE: 9,
        Z_MIN_WINDOWBITS:    8, Z_MAX_WINDOWBITS:   15, Z_DEFAULT_WINDOWBITS: 15,
        Z_MIN_CHUNK:      64, Z_MAX_CHUNK:        Infinity, Z_DEFAULT_CHUNK: 16384,
        Z_MIN_MEMLEVEL:    1, Z_MAX_MEMLEVEL:      9, Z_DEFAULT_MEMLEVEL: 8,
        Z_MIN_LEVEL:      -1, Z_MAX_LEVEL:         9, Z_DEFAULT_LEVEL: -1,
    };

    // Constants spread on the module too — Node exposes both
    // `zlib.Z_OK` and `zlib.constants.Z_OK`. Keep parity.
    Object.keys(exports.constants).forEach(function(k) {
        if (typeof exports[k] === 'undefined') exports[k] = exports.constants[k];
    });
});


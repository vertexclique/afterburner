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

    /// `module.register(specifier, parent, opts)` — Node 20+
    /// customization hooks. Loads the specifier in the current realm,
    /// reads its `resolve` / `load` named exports, and appends them
    /// to a global hook chain (`globalThis.__ab_module_hooks`) that
    /// the require resolver consults in registration order before
    /// falling back to its built-in resolution. Burn doesn't isolate
    /// hooks in a worker thread (Node uses a worker for isolation);
    /// the hook runs in the same realm. Pass `data` via `opts.data`
    /// — it's threaded through to the hook on first init.
    function register(specifier, parentURL, opts) {
        if (typeof specifier !== 'string') {
            throw Object.assign(
                new TypeError('module.register: specifier must be a string'),
                { code: 'ERR_INVALID_ARG_TYPE' }
            );
        }
        // Resolve relative to the current require's module context
        // when parentURL is provided as a string URL or path.
        var loaded;
        try {
            loaded = require(specifier);
        } catch (e) {
            throw Object.assign(
                new Error("module.register: failed to load '" + specifier + "': " + (e && e.message)),
                { code: 'ERR_MODULE_REGISTER_FAILED' }
            );
        }
        if (!globalThis.__ab_module_hooks) {
            globalThis.__ab_module_hooks = { hooks: [], data: [] };
        }
        var data = (opts && opts.data) ? opts.data : undefined;
        globalThis.__ab_module_hooks.hooks.push({
            specifier: specifier,
            parentURL: parentURL,
            resolve: typeof loaded.resolve === 'function' ? loaded.resolve : null,
            load: typeof loaded.load === 'function' ? loaded.load : null,
            initialize: typeof loaded.initialize === 'function' ? loaded.initialize : null,
            data: data,
        });
        // Run the hook's `initialize(data)` once at register time, per
        // Node's contract.
        if (typeof loaded.initialize === 'function') {
            try { loaded.initialize(data); } catch (_) {}
        }
        return undefined;
    }
    function getSourceMapsSupport() {
        return {
            enabled: !!globalThis.__ab_source_maps_enabled,
            nodeModules: false,
            generatedCode: !!globalThis.__ab_source_maps_enabled,
        };
    }
    function setSourceMapsSupport(enabled, _opts) {
        globalThis.__ab_source_maps_enabled = !!enabled;
    }
    function findSourceMap(filepath) {
        // Best-effort lookup of an inline source map embedded in the
        // file as `//# sourceMappingURL=data:application/json;base64,...`.
        try {
            var fs = require('fs');
            var src = fs.readFileSync(filepath, 'utf8');
            var idx = src.lastIndexOf('//# sourceMappingURL=data:application/json');
            if (idx < 0) return undefined;
            var line = src.slice(idx);
            var b64 = line.match(/base64,([A-Za-z0-9+/=]+)/);
            if (!b64) return undefined;
            var json = Buffer.from(b64[1], 'base64').toString('utf8');
            return { payload: JSON.parse(json), file: filepath };
        } catch (_) { return undefined; }
    }

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
    Module.prototype.load = function(filename) {
        // Run the file as a module — corepack's `loadMainModule` does
        // `module.load(modulePath)` to run the entry script. We
        // delegate to the require resolver and copy the resulting
        // exports onto this Module instance so callers that read
        // `module.exports` after `load()` see the right shape.
        if (filename) {
            this.filename = filename;
            this.id = filename;
        }
        try {
            var loaded = require(this.filename || this.id);
            if (loaded !== undefined) this.exports = loaded;
        } finally {
            this.loaded = true;
        }
    };
    Module._cache = (globalThis.require && globalThis.require.cache) || {};
    Module._pathCache = {};
    Module._extensions = {
        '.js': function() {},
        '.json': function() {},
    };
    // `module._resolveFilename(spec, parent, isMain, options)` — burn's
    // resolver doesn't expose a separate resolve step; we approximate
    // by best-effort: absolute paths return as-is, relative paths
    // resolve against the parent's filename, bare names go through
    // `require.resolve` (which exists when the entry-script wrapper
    // is in scope).
    Module._resolveFilename = function(spec, parent, _isMain, _options) {
        if (typeof spec !== 'string') return String(spec);
        if (spec.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(spec)) return spec;
        if (typeof require !== 'undefined' && typeof require.resolve === 'function') {
            try { return require.resolve(spec); } catch (_) {}
        }
        if (parent && parent.filename) {
            var base = parent.filename.replace(/\/[^/]*$/, '');
            return base + '/' + spec;
        }
        return spec;
    };
    // `module._nodeModulePaths(dir)` — list of `node_modules` candidate
    // directories from `dir` up to the filesystem root. Matches
    // Node's behavior; npm / pnpm / corepack use this to walk up.
    Module._nodeModulePaths = function(from) {
        var paths = [];
        var d = String(from || '/');
        while (true) {
            paths.push(d.replace(/\/$/, '') + '/node_modules');
            if (d === '/' || d === '' || /^[A-Za-z]:[\\/]?$/.test(d)) break;
            var parent = d.replace(/\/[^/]*$/, '');
            if (parent === d) break;
            d = parent || '/';
        }
        return paths;
    };
    Module.wrap = function(script) {
        return '(function (exports, require, module, __filename, __dirname) { ' +
               script + '\n});';
    };
    Module.wrapper = [
        '(function (exports, require, module, __filename, __dirname) { ',
        '\n});',
    ];
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

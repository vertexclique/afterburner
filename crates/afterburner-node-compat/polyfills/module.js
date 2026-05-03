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

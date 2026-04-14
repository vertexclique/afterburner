// The plenum.js require() resolver.
//
// Installs a tiny CommonJS-style loader onto `globalThis`:
//   * `require(name)` resolves by stripping a `node:` prefix, consulting
//     the factory map, instantiating the module on first hit, and caching
//     the resulting `exports` object for subsequent calls.
//   * `__register_module(name, factory)` registers a lazy module whose
//     body runs only on first `require`.
//   * `__register_host_module(name, obj)` lets the Rust side inject a
//     ready-made module object bypassing the factory step — used when a
//     polyfill has no JS body and is fully backed by host globals.
//
// `require()` throws an Error for unknown modules, matching Node's
// `Cannot find module '…'` string so scripts that depend on the exact
// error text keep working.

(function plenumRequire() {
    var factories = Object.create(null);
    var cache = Object.create(null);

    function stripNodePrefix(name) {
        return typeof name === 'string' && name.indexOf('node:') === 0
            ? name.slice(5)
            : name;
    }

    function loadModule(mod) {
        var cached = cache[mod];
        if (cached !== undefined) return cached;

        var factory = factories[mod];
        if (typeof factory === 'function') {
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

        throw new Error("Cannot find module '" + mod + "'");
    }

    globalThis.require = function(name) {
        return loadModule(stripNodePrefix(name));
    };

    globalThis.__register_module = function(name, factory) {
        factories[stripNodePrefix(name)] = factory;
    };

    globalThis.__register_host_module = function(name, obj) {
        cache[stripNodePrefix(name)] = obj;
    };

    globalThis.__plenum_modules_installed = function() {
        return Object.keys(factories).concat(Object.keys(cache));
    };
})();

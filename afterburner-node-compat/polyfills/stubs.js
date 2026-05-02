// Stub modules that throw a helpful NotSupportedInSandbox error on any
// property access. Registering them means `require('tls')` returns an
// object instead of `Cannot find module 'tls'` — scripts get a clear
// signal about what's unsupported and why.
//
// Only list modules that have NO real polyfill. Bundle concat order is
// alphabetical, so anything listed here would clobber a real polyfill
// whose filename sorts before `stubs.js` (e.g. `net.js`). `net` and
// `worker_threads` ship real polyfills and are intentionally absent.

(function installStubs() {
    var reasons = {
        tls: 'raw TLS sockets',
        dgram: 'UDP sockets',
        http2: 'HTTP/2 (plain http/https works for outbound requests)',
        cluster: 'multi-process clustering',
        inspector: 'Node inspector protocol',
        vm: 'nested VM contexts',
        v8: 'V8-specific APIs',
        readline: 'stdin line reader',
        repl: 'interactive REPL',
        wasi: 'guest WASI access (already inside the sandbox)',
        domain: 'deprecated domain API',
        trace_events: 'trace events',
        async_hooks: 'async hooks (no event loop)',
        perf_hooks: 'perf hooks (see globalThis.performance)',
    };

    Object.keys(reasons).forEach(function(name) {
        var reason = reasons[name];
        __register_module(name, function(module, exports, require) {
            var why = 'Module "' + name + '" is not supported in the Afterburner sandbox: '
                + reason;
            var trap = new Proxy({}, {
                get: function(_t, prop) {
                    if (prop === 'then') return undefined; // don't claim to be a thenable
                    var err = new Error(why + ' (accessed: ' + String(prop) + ')');
                    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
                    throw err;
                }
            });
            module.exports = trap;
        });
    });
})();

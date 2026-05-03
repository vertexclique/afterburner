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
    if (globalThis.console) {
        // Runtime already has a console (Javy on wasm, etc.) — leave it.
        return;
    }

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

    var c = {
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
        group:   function() {},
        groupEnd:function() {},
        time:    function() {},
        timeEnd: function() {},
        table:   function(t) { logAt('info')(JSON.stringify(t, null, 2)); }
    };

    globalThis.console = c;
})();

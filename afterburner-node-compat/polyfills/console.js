// console — routes messages through the host log hook when available,
// falling back to a noop-buffer if no host is wired. `util.format` is
// used for message rendering so `%s`, `%d`, `%j` behave as expected.

__register_module('console', function(module, exports, require) {

    function resolveHost() {
        return typeof globalThis.__host_log === 'function' ? globalThis.__host_log : null;
    }

    function render() {
        var util = require('util');
        return util.format.apply(null, arguments);
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
            var util = require('util');
            logAt('info')(util.inspect(obj));
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

    module.exports = c;
    if (!globalThis.console) globalThis.console = c;
});

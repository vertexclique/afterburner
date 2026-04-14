// timers — Phase 1 behavior is deliberately conservative.
//
// Afterburner scripts run synchronously: there is no event loop, no
// runtime that can resume the script after a wall-clock delay. We
// therefore:
//   * invoke the callback immediately on `setTimeout(fn, 0)` and
//     `setImmediate(fn)` — the common "defer one tick" idiom keeps
//     working,
//   * throw on non-zero delays and on `setInterval` — scripts relying
//     on actual timing are broken by design in this sandbox and should
//     fail loudly rather than silently hang or produce wrong output.
//
// `clear*` are no-ops (there are no pending timers to clear).

__register_module('timers', function(module, exports, require) {

    function asyncNotSupported(api) {
        return new Error(api + ' with a non-zero delay is not supported in this sandbox');
    }

    function setTimeoutImpl(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        if (!delay || delay <= 0) {
            var args = Array.prototype.slice.call(arguments, 2);
            fn.apply(null, args);
            return { __ab_timer: true, id: 0 };
        }
        throw asyncNotSupported('setTimeout');
    }

    function setImmediateImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        fn.apply(null, args);
        return { __ab_timer: true, id: 0 };
    }

    function setIntervalImpl() {
        throw asyncNotSupported('setInterval');
    }

    function noop() { /* nothing to clear */ }

    exports.setTimeout = setTimeoutImpl;
    exports.setImmediate = setImmediateImpl;
    exports.setInterval = setIntervalImpl;
    exports.clearTimeout = noop;
    exports.clearImmediate = noop;
    exports.clearInterval = noop;

    // Install as globals so scripts that don't `require('timers')` still
    // see the same behavior.
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = setTimeoutImpl;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = setImmediateImpl;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = setIntervalImpl;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = noop;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = noop;
});

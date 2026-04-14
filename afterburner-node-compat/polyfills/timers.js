// timers — microtask-based scheduling.
//
// Phase E enabled the Javy event loop (and matching rquickjs microtask
// pump on the native side), so we can now defer work via
// `Promise.resolve().then(cb)`. That gives us proper
// `queueMicrotask`, a non-synchronous `setTimeout(fn, 0)`, and a
// working `setImmediate` — all without a wall-clock timer heap.
//
// Non-zero `setTimeout` delays and `setInterval` still throw: the
// sandbox has no wall-clock loop that can resume a script after N ms,
// and the existing behavior of failing loudly is better than silently
// hanging or silently firing at "0ms".

// Eagerly install globals at bundle load time. Scripts that never
// `require('timers')` still see `setTimeout` / `queueMicrotask` /
// friends as Web globals (both Node and browsers expose them without
// an import).
(function installTimerGlobals() {
    function _defer(fn, args) {
        Promise.resolve().then(function() { fn.apply(null, args); });
    }
    function _setTimeout(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        if (!delay || delay <= 0) {
            var args = Array.prototype.slice.call(arguments, 2);
            _defer(fn, args);
            return { __ab_timer: true, id: 0 };
        }
        throw new Error('setTimeout with a non-zero delay is not supported in this sandbox');
    }
    function _setImmediate(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        _defer(fn, args);
        return { __ab_timer: true, id: 0 };
    }
    function _setInterval() {
        throw new Error('setInterval with a non-zero delay is not supported in this sandbox');
    }
    function _noop() {}
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = _setTimeout;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = _setImmediate;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = _setInterval;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = _noop;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = _noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = _noop;
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

    // Defer `fn` to run as a microtask. On Javy/rquickjs this runs
    // after the current synchronous frame completes but before the
    // engine returns to the host. Supports variable args the way
    // Node's setTimeout does.
    function defer(fn, args) {
        Promise.resolve().then(function() { fn.apply(null, args); });
    }

    function queueMicrotaskImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        defer(fn, []);
    }

    function setTimeoutImpl(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        if (!delay || delay <= 0) {
            var args = Array.prototype.slice.call(arguments, 2);
            defer(fn, args);
            return { __ab_timer: true, id: 0 };
        }
        throw asyncNotSupported('setTimeout');
    }

    function setImmediateImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        defer(fn, args);
        return { __ab_timer: true, id: 0 };
    }

    function setIntervalImpl() {
        throw asyncNotSupported('setInterval');
    }

    function noop() { /* nothing to clear — microtasks can't be cancelled */ }

    exports.setTimeout = setTimeoutImpl;
    exports.setImmediate = setImmediateImpl;
    exports.setInterval = setIntervalImpl;
    exports.clearTimeout = noop;
    exports.clearImmediate = noop;
    exports.clearInterval = noop;
    exports.queueMicrotask = queueMicrotaskImpl;

    // Install as globals so scripts that don't `require('timers')` still
    // see the same behavior.
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = setTimeoutImpl;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = setImmediateImpl;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = setIntervalImpl;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = noop;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = noop;
    if (typeof globalThis.queueMicrotask !== 'function') globalThis.queueMicrotask = queueMicrotaskImpl;
});

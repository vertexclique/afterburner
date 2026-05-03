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

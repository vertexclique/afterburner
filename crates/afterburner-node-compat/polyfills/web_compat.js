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
})();

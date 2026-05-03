// AbortController + AbortSignal — standard Web API, not built into
// QuickJS. Supports the listener-based cancellation protocol used by
// `fetch`, timers, and most async libraries.

(function installAbort() {
    if (typeof globalThis.AbortController === 'function') return;

    function AbortSignal() {
        this.aborted = false;
        this.reason = undefined;
        this._listeners = [];
    }
    AbortSignal.prototype.addEventListener = function(event, fn) {
        if (event !== 'abort' || typeof fn !== 'function') return;
        this._listeners.push(fn);
    };
    AbortSignal.prototype.removeEventListener = function(event, fn) {
        if (event !== 'abort') return;
        var i = this._listeners.indexOf(fn);
        if (i >= 0) this._listeners.splice(i, 1);
    };
    AbortSignal.prototype.throwIfAborted = function() {
        if (this.aborted) throw this.reason;
    };
    Object.defineProperty(AbortSignal.prototype, 'onabort', {
        get: function() { return this._onabort || null; },
        set: function(fn) {
            if (this._onabort) this.removeEventListener('abort', this._onabort);
            this._onabort = fn;
            if (typeof fn === 'function') this.addEventListener('abort', fn);
        }
    });
    AbortSignal.abort = function(reason) {
        var s = new AbortSignal();
        s.aborted = true;
        s.reason = reason !== undefined ? reason : new Error('Aborted');
        return s;
    };
    AbortSignal.timeout = function(_ms) {
        // No event loop: a timeout-based abort would never fire. Produce
        // a signal that's already aborted so scripts fail loudly rather
        // than silently hang.
        return AbortSignal.abort(new Error('AbortSignal.timeout: no event loop'));
    };

    function AbortController() {
        this.signal = new AbortSignal();
    }
    AbortController.prototype.abort = function(reason) {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.reason = reason !== undefined ? reason : new Error('Aborted');
        var listeners = this.signal._listeners.slice();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i]({ type: 'abort' }); } catch (_) {}
        }
    };

    globalThis.AbortController = AbortController;
    globalThis.AbortSignal = AbortSignal;
})();

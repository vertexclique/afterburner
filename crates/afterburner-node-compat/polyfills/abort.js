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
    AbortSignal.timeout = function(ms) {
        ms = (ms | 0);
        // Daemon mode (host timers available) — schedule a real fire-
        // later abort so callers get the canonical pattern:
        //   fetch(url, { signal: AbortSignal.timeout(5000) })
        // works as expected. setTimeout itself routes through the same
        // host import, so this stays consistent with the rest of the
        // event-loop polyfill.
        if (typeof globalThis.setTimeout === 'function'
            && typeof globalThis.__host_timer_set === 'function') {
            var s = new AbortSignal();
            globalThis.setTimeout(function() {
                if (s.aborted) return;
                s.aborted = true;
                s.reason = new Error('signal timed out (' + ms + 'ms)');
                var listeners = s._listeners.slice();
                for (var i = 0; i < listeners.length; i++) {
                    try { listeners[i]({ type: 'abort' }); } catch (_) {}
                }
            }, ms);
            return s;
        }
        // Library mode (no host timers): a timeout-based abort would
        // never fire. Produce a signal that's already aborted so
        // scripts fail loudly rather than silently hang.
        return AbortSignal.abort(new Error('AbortSignal.timeout: no event loop'));
    };

    // AbortSignal.any (Node 20+) — return a fresh signal that aborts
    // as soon as ANY of the input signals aborts. If any input signal
    // is already aborted at construction time the returned signal
    // is born aborted with that reason.
    AbortSignal.any = function(signals) {
        var arr = Array.from(signals || []);
        var s = new AbortSignal();
        for (var i = 0; i < arr.length; i++) {
            var sig = arr[i];
            if (sig && sig.aborted) {
                s.aborted = true;
                s.reason = sig.reason !== undefined ? sig.reason : new Error('Aborted');
                return s;
            }
        }
        var fired = false;
        function fire(reason) {
            if (fired || s.aborted) return;
            fired = true;
            s.aborted = true;
            s.reason = reason !== undefined ? reason : new Error('Aborted');
            var listeners = s._listeners.slice();
            for (var j = 0; j < listeners.length; j++) {
                try { listeners[j]({ type: 'abort' }); } catch (_) {}
            }
        }
        for (var k = 0; k < arr.length; k++) {
            (function(child) {
                if (!child || typeof child.addEventListener !== 'function') return;
                child.addEventListener('abort', function() { fire(child.reason); }, { once: true });
            })(arr[k]);
        }
        return s;
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

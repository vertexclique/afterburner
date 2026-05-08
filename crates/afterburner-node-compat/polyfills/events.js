// events — a minimal EventEmitter with the APIs scripts actually use.

__register_module('events', function(module, exports, require) {

    function EventEmitter() {
        if (!(this instanceof EventEmitter)) return new EventEmitter();
        ensureEvents(this);
        this._maxListeners = undefined;
    }

    // Lazy-init for the `_events` bag. Real Node's EventEmitter does
    // the same thing: `init()` runs at constructor-call time, but
    // every accessor method also bails out cleanly when `_events`
    // wasn't yet allocated (treats absence as empty). The npm
    // pattern of `mixin(target, EventEmitter.prototype, false)` —
    // used by Express's `merge-descriptors` to graft EventEmitter
    // methods onto a plain `app` object without running the
    // constructor — depends on this. Without it, `app.on('mount',
    // cb)` throws `cannot read property 'mount' of undefined`
    // because `this._events` was never set.
    function ensureEvents(self) {
        if (!self._events) self._events = Object.create(null);
        return self._events;
    }

    EventEmitter.prototype.setMaxListeners = function(n) {
        this._maxListeners = n;
        return this;
    };
    EventEmitter.prototype.getMaxListeners = function() {
        return this._maxListeners === undefined ? 10 : this._maxListeners;
    };

    EventEmitter.prototype.on = function(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('listener must be a function');
        var events = ensureEvents(this);
        var list = events[name];
        if (!list) events[name] = [fn];
        else list.push(fn);
        return this;
    };
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;

    EventEmitter.prototype.once = function(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('listener must be a function');
        var self = this;
        function wrapper() {
            self.removeListener(name, wrapper);
            fn.apply(self, arguments);
        }
        wrapper.listener = fn;
        return this.on(name, wrapper);
    };

    EventEmitter.prototype.removeListener = function(name, fn) {
        if (!this._events) return this;
        var list = this._events[name];
        if (!list) return this;
        for (var i = list.length - 1; i >= 0; i--) {
            if (list[i] === fn || list[i].listener === fn) {
                list.splice(i, 1);
                break;
            }
        }
        if (list.length === 0) delete this._events[name];
        return this;
    };
    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

    EventEmitter.prototype.removeAllListeners = function(name) {
        if (name === undefined) this._events = Object.create(null);
        else if (this._events) delete this._events[name];
        return this;
    };

    EventEmitter.prototype.emit = function(name) {
        if (!this._events) return name === 'error' ? false : false;
        var list = this._events[name];
        if (!list) return name === 'error';
        // Copy before iterating — listeners may mutate the list.
        var copy = list.slice();
        var args = new Array(arguments.length - 1);
        for (var i = 1; i < arguments.length; i++) args[i - 1] = arguments[i];
        for (var j = 0; j < copy.length; j++) copy[j].apply(this, args);
        return true;
    };

    EventEmitter.prototype.listeners = function(name) {
        if (!this._events) return [];
        var list = this._events[name];
        return list ? list.slice() : [];
    };

    EventEmitter.prototype.listenerCount = function(name) {
        if (!this._events) return 0;
        var list = this._events[name];
        return list ? list.length : 0;
    };

    EventEmitter.prototype.eventNames = function() {
        return this._events ? Object.keys(this._events) : [];
    };

    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.defaultMaxListeners = 10;
    EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
    EventEmitter.errorMonitor = Symbol.for('events.errorMonitor');
    EventEmitter.captureRejections = false;

    /// events.once(emitter, name, opts?) — resolves with the args of
    /// the first emitted event of the given name. Rejects on 'error'
    /// (unless `name === 'error'`) or signal abort.
    EventEmitter.once = function(emitter, name, options) {
        return new Promise(function(resolve, reject) {
            var signal = options && options.signal;
            if (signal && signal.aborted) {
                return reject(signal.reason || new Error('Aborted'));
            }
            function onEvent() {
                cleanup();
                resolve(Array.prototype.slice.call(arguments));
            }
            function onError(err) { cleanup(); reject(err); }
            function onAbort() {
                cleanup();
                reject(signal.reason || new Error('Aborted'));
            }
            function cleanup() {
                emitter.removeListener(name, onEvent);
                if (name !== 'error') emitter.removeListener('error', onError);
                if (signal && signal.removeEventListener) {
                    signal.removeEventListener('abort', onAbort);
                }
            }
            emitter.once(name, onEvent);
            if (name !== 'error') emitter.once('error', onError);
            if (signal && signal.addEventListener) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    };

    /// events.on(emitter, name, opts?) — async iterator yielding the
    /// args of every emitted `name` event until abort or 'error'.
    EventEmitter.on = function(emitter, name, options) {
        var signal = options && options.signal;
        var queue = [];
        var waiters = [];
        var done = false;
        var err = null;
        function push(args) {
            if (done) return;
            if (waiters.length) waiters.shift()({ value: args, done: false });
            else queue.push(args);
        }
        function flushDone() {
            done = true;
            while (waiters.length) {
                var w = waiters.shift();
                if (err) w(Promise.reject(err));
                else w({ value: undefined, done: true });
            }
        }
        function onEvent() { push(Array.prototype.slice.call(arguments)); }
        function onError(e) { err = e; flushDone(); cleanup(); }
        function onAbort() { err = signal.reason || new Error('Aborted'); flushDone(); cleanup(); }
        function cleanup() {
            emitter.removeListener(name, onEvent);
            if (name !== 'error') emitter.removeListener('error', onError);
            if (signal && signal.removeEventListener) {
                signal.removeEventListener('abort', onAbort);
            }
        }
        emitter.on(name, onEvent);
        if (name !== 'error') emitter.on('error', onError);
        if (signal) {
            if (signal.aborted) onAbort();
            else if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
        }
        return {
            [Symbol.asyncIterator]: function() { return this; },
            next: function() {
                if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
                if (done) return err ? Promise.reject(err) : Promise.resolve({ value: undefined, done: true });
                return new Promise(function(resolve) { waiters.push(resolve); });
            },
            return: function(v) {
                done = true; cleanup();
                return Promise.resolve({ value: v, done: true });
            },
        };
    };

    EventEmitter.getEventListeners = function(target, name) {
        if (target && typeof target.listeners === 'function') return target.listeners(name);
        if (target && target._events && Array.isArray(target._events[name])) {
            return target._events[name].slice();
        }
        return [];
    };

    EventEmitter.setMaxListeners = function(n) {
        var args = Array.prototype.slice.call(arguments, 1);
        if (args.length === 0) {
            EventEmitter.defaultMaxListeners = n | 0;
            return;
        }
        for (var i = 0; i < args.length; i++) {
            if (args[i] && typeof args[i].setMaxListeners === 'function') {
                args[i].setMaxListeners(n);
            }
        }
    };
    EventEmitter.getMaxListeners = function(emitter) {
        return (emitter && typeof emitter.getMaxListeners === 'function')
            ? emitter.getMaxListeners()
            : EventEmitter.defaultMaxListeners;
    };
    EventEmitter.listenerCount = function(emitter, name) {
        return (emitter && typeof emitter.listenerCount === 'function')
            ? emitter.listenerCount(name)
            : 0;
    };

    /// `events.addAbortListener(signal, listener)` — Node 20+. Adds an
    /// abort listener and returns a disposable handle (with
    /// `Symbol.dispose`) that removes it. If the signal is already
    /// aborted, the listener fires synchronously on a microtask.
    EventEmitter.addAbortListener = function(signal, listener) {
        if (!signal || typeof listener !== 'function') {
            var e = new TypeError('events.addAbortListener: invalid arguments');
            e.code = 'ERR_INVALID_ARG_TYPE';
            throw e;
        }
        function fire(ev) { try { listener(ev); } catch (_) {} }
        if (signal.aborted) {
            Promise.resolve().then(function() { fire({ type: 'abort' }); });
        } else if (typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', fire, { once: true });
        } else if (typeof signal.once === 'function') {
            signal.once('abort', fire);
        }
        var disposer = {
            [Symbol.dispose || Symbol.for('Symbol.dispose')]: function() {
                if (typeof signal.removeEventListener === 'function') {
                    signal.removeEventListener('abort', fire);
                } else if (typeof signal.off === 'function') {
                    signal.off('abort', fire);
                }
            },
        };
        return disposer;
    };

    // Re-export the static helpers on the module object too — Node
    // exposes them as both `EventEmitter.once` and
    // `require('events').once`.
    module.exports = EventEmitter;
    module.exports.once = EventEmitter.once;
    module.exports.on = EventEmitter.on;
    module.exports.getEventListeners = EventEmitter.getEventListeners;
    module.exports.setMaxListeners = EventEmitter.setMaxListeners;
    module.exports.getMaxListeners = EventEmitter.getMaxListeners;
    module.exports.listenerCount = EventEmitter.listenerCount;
    module.exports.addAbortListener = EventEmitter.addAbortListener;
    module.exports.captureRejectionSymbol = EventEmitter.captureRejectionSymbol;
    module.exports.errorMonitor = EventEmitter.errorMonitor;
    module.exports.captureRejections = EventEmitter.captureRejections;
    module.exports.defaultMaxListeners = EventEmitter.defaultMaxListeners;
});

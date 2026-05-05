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

    module.exports = EventEmitter;
});

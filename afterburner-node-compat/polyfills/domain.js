// domain — deprecated since Node 4 but still imported by older
// libraries (winston < 3, some Express middleware). Real Node's
// `domain` is an error-handling boundary tied to the async stack;
// without an async stack we provide a synchronous shim that runs
// the callback inline and re-throws errors with a `domain`-like
// `'error'` event.

__register_module('domain', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function Domain() {
        EventEmitter.call(this);
        this.members = [];
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Domain.prototype.constructor = Domain;

    Domain.prototype.run = function(fn) {
        try {
            return fn();
        } catch (e) {
            try { this.emit('error', e); } catch (_) {}
            throw e;
        }
    };
    Domain.prototype.add = function(emitter) { this.members.push(emitter); return this; };
    Domain.prototype.remove = function(emitter) {
        var i = this.members.indexOf(emitter);
        if (i !== -1) this.members.splice(i, 1);
        return this;
    };
    Domain.prototype.bind = function(callback) {
        var self = this;
        return function() {
            try { return callback.apply(this, arguments); }
            catch (e) { try { self.emit('error', e); } catch (_) {} throw e; }
        };
    };
    Domain.prototype.intercept = function(callback) {
        var self = this;
        return function(err) {
            if (err) {
                try { self.emit('error', err); } catch (_) {}
                return;
            }
            try {
                return callback.apply(this, Array.prototype.slice.call(arguments, 1));
            } catch (e) {
                try { self.emit('error', e); } catch (_) {}
                throw e;
            }
        };
    };
    Domain.prototype.enter = function() {};
    Domain.prototype.exit = function() {};
    Domain.prototype.dispose = function() {};

    function create() { return new Domain(); }

    exports.create = create;
    exports.createDomain = create;
    exports.Domain = Domain;
    exports.active = null;
});

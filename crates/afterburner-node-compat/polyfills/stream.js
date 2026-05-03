// stream — minimal shim. Phase 1 does NOT implement backpressure,
// highWaterMark, or object-mode semantics. It provides just enough of
// `Readable`/`Writable`/`Transform`/`PassThrough` for scripts that
// construct small in-memory pipelines.

__register_module('stream', function(module, exports, require) {

    var EventEmitter = require('events');

    // --- Readable ----------------------------------------------------------
    function Readable(opts) {
        if (!(this instanceof Readable)) return new Readable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        this._readable = true;
        this._ended = false;
    }
    Readable.prototype = Object.create(EventEmitter.prototype);
    Readable.prototype.constructor = Readable;

    Readable.prototype.push = function(chunk) {
        if (chunk === null) {
            this._ended = true;
            this.emit('end');
            return false;
        }
        this.emit('data', chunk);
        return true;
    };
    Readable.prototype.pipe = function(dest) {
        var self = this;
        this.on('data', function(chunk) { dest.write(chunk); });
        this.on('end', function() { if (typeof dest.end === 'function') dest.end(); });
        return dest;
    };
    Readable.from = function(iterable) {
        var r = new Readable();
        // Deferred push so listeners can attach first.
        Promise.resolve().then(function() {
            for (var i = 0; i < iterable.length; i++) r.push(iterable[i]);
            r.push(null);
        });
        return r;
    };

    // --- Writable ----------------------------------------------------------
    function Writable(opts) {
        if (!(this instanceof Writable)) return new Writable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        this._writable = true;
        this._write = (opts && opts.write) || function(_c, _e, cb) { cb && cb(); };
        this._ended = false;
    }
    Writable.prototype = Object.create(EventEmitter.prototype);
    Writable.prototype.constructor = Writable;

    Writable.prototype.write = function(chunk, encoding, cb) {
        var self = this;
        this._write(chunk, encoding, function(err) {
            if (err) self.emit('error', err);
            if (cb) cb(err);
        });
        return true;
    };
    Writable.prototype.end = function(chunk) {
        if (chunk) this.write(chunk);
        this._ended = true;
        this.emit('finish');
    };

    // --- Transform ---------------------------------------------------------
    function Transform(opts) {
        if (!(this instanceof Transform)) return new Transform(opts);
        Readable.call(this);
        this._transform = (opts && opts.transform) || function(c, e, cb) { cb(null, c); };
        this._writable = true;
    }
    Transform.prototype = Object.create(Readable.prototype);
    Transform.prototype.constructor = Transform;
    Transform.prototype.write = function(chunk, encoding, cb) {
        var self = this;
        this._transform(chunk, encoding, function(err, out) {
            if (err) { self.emit('error', err); if (cb) cb(err); return; }
            if (out !== undefined && out !== null) self.push(out);
            if (cb) cb();
        });
        return true;
    };
    Transform.prototype.end = function(chunk) {
        var self = this;
        var finish = function() { self.push(null); };
        if (chunk !== undefined) this.write(chunk, null, finish);
        else finish();
    };

    // --- PassThrough -------------------------------------------------------
    function PassThrough(opts) {
        if (!(this instanceof PassThrough)) return new PassThrough(opts);
        Transform.call(this, { transform: function(c, e, cb) { cb(null, c); } });
    }
    PassThrough.prototype = Object.create(Transform.prototype);
    PassThrough.prototype.constructor = PassThrough;

    // --- Duplex (aliased to Transform for our purposes) -------------------
    var Duplex = Transform;

    // --- pipeline / finished helpers --------------------------------------
    function pipeline() {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        var first = args[0];
        for (var i = 1; i < args.length; i++) first = first.pipe(args[i]);
        first.on('finish', function() { if (cb) cb(null); });
        first.on('error',  function(err) { if (cb) cb(err); });
        return first;
    }
    function finished(stream, cb) {
        stream.on('end',    function() { cb && cb(null); });
        stream.on('finish', function() { cb && cb(null); });
        stream.on('error',  function(e) { cb && cb(e); });
    }

    exports.Readable    = Readable;
    exports.Writable    = Writable;
    exports.Transform   = Transform;
    exports.Duplex      = Duplex;
    exports.PassThrough = PassThrough;
    exports.pipeline    = pipeline;
    exports.finished    = finished;
});

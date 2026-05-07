// stream — Node 20 LTS streams (Readable, Writable, Duplex,
// Transform, PassThrough, pipeline, finished, compose, addAbortSignal).
// Pure JS — no host calls. Backpressure modeled with a highWaterMark
// + pending-byte counter; the actual wire-level pause/resume is
// observable through `.write()` returning false and a `'drain'` event
// firing after the pending count crosses back below HWM.

__register_module('stream', function(module, exports, require) {

    var EventEmitter = require('events');

    var DEFAULT_HWM = 16 * 1024;

    // --- Readable ---------------------------------------------------------
    //
    // Two consumption modes:
    //   * Flowing: listening for 'data' (and 'end') gets the chunks pushed
    //     synchronously as `.push(chunk)` runs.
    //   * Paused: `.read()` (no listener) buffers internally; pull when
    //     the consumer asks. We start paused; transition to flowing on
    //     the first 'data' listener.

    function Readable(opts) {
        if (!(this instanceof Readable)) return new Readable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        opts = opts || {};
        this._readable = true;
        this._ended = false;
        this._destroyed = false;
        this._buffer = [];
        this._highWaterMark = opts.highWaterMark || DEFAULT_HWM;
        this._read = (opts.read || function() {}).bind(this);
        this._flowing = null; // null = unset, true = flowing, false = paused
        var self = this;
        // Auto-flow on first data listener.
        this.on('newListener', function(name) {
            if (name === 'data' && self._flowing === null) self._flowing = true;
        });
    }
    Readable.prototype = Object.create(EventEmitter.prototype);
    Readable.prototype.constructor = Readable;

    Readable.prototype.push = function(chunk) {
        if (chunk === null) {
            this._ended = true;
            // Flush buffered chunks before 'end'.
            this._drainBuffer();
            this.emit('end');
            this.emit('close');
            return false;
        }
        if (this._destroyed) return false;
        if (this._flowing) {
            this.emit('data', chunk);
        } else {
            this._buffer.push(chunk);
            this.emit('readable');
        }
        return true;
    };
    Readable.prototype._drainBuffer = function() {
        while (this._buffer.length && this._flowing !== false) {
            this.emit('data', this._buffer.shift());
        }
    };
    Readable.prototype.read = function() {
        if (this._buffer.length === 0) return null;
        return this._buffer.shift();
    };
    Readable.prototype.pause = function() {
        this._flowing = false;
        return this;
    };
    Readable.prototype.resume = function() {
        this._flowing = true;
        this._drainBuffer();
        return this;
    };
    Readable.prototype.pipe = function(dest, opts) {
        opts = opts || {};
        var self = this;
        var ended = false;
        var endDest = opts.end !== false;
        this.on('data', function(chunk) {
            var ok = dest.write(chunk);
            if (!ok) self.pause();
        });
        dest.on && dest.on('drain', function() { self.resume(); });
        this.on('end', function() {
            if (ended) return;
            ended = true;
            if (endDest && typeof dest.end === 'function') dest.end();
        });
        this.on('error', function(err) {
            if (typeof dest.destroy === 'function') dest.destroy(err);
        });
        return dest;
    };
    Readable.prototype.unpipe = function(_dest) {
        // We don't track multiple pipe targets — pause() effectively
        // halts the pipe. Fine for the common single-pipe case.
        this.pause();
        return this;
    };
    Readable.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._readable = false;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
        return this;
    };
    Object.defineProperty(Readable.prototype, 'readable', {
        get: function() { return this._readable && !this._ended && !this._destroyed; },
    });
    Object.defineProperty(Readable.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(Readable.prototype, 'readableEnded', {
        get: function() { return this._ended; },
    });

    // Async-iterator interop. Node makes Readable async-iterable.
    Readable.prototype[Symbol.asyncIterator] = function() {
        var self = this;
        var pending = [];
        var resolvers = [];
        var ended = false;
        var error = null;

        self.on('data', function(chunk) {
            if (resolvers.length) {
                var r = resolvers.shift();
                r({ value: chunk, done: false });
            } else {
                pending.push(chunk);
            }
        });
        self.on('end', function() {
            ended = true;
            while (resolvers.length) {
                resolvers.shift()({ value: undefined, done: true });
            }
        });
        self.on('error', function(e) {
            error = e;
            while (resolvers.length) {
                var r = resolvers.shift();
                r(Promise.reject(e));
            }
        });

        return {
            next: function() {
                if (error) return Promise.reject(error);
                if (pending.length) {
                    return Promise.resolve({ value: pending.shift(), done: false });
                }
                if (ended) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise(function(resolve) { resolvers.push(resolve); });
            },
            return: function() {
                self.destroy();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    };

    Readable.from = function(iterable, opts) {
        var r = new Readable(opts);
        // Sync iterable (Array, generator) — feed synchronously after a
        // microtask tick so listeners can attach.
        if (iterable && typeof iterable[Symbol.iterator] === 'function'
            && typeof iterable[Symbol.asyncIterator] !== 'function') {
            Promise.resolve().then(function() {
                try {
                    for (var v of iterable) r.push(v);
                    r.push(null);
                } catch (e) { r.destroy(e); }
            });
            return r;
        }
        // Async iterable.
        if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
            (async function() {
                try {
                    for await (var v of iterable) r.push(v);
                    r.push(null);
                } catch (e) { r.destroy(e); }
            })();
            return r;
        }
        // Single value fallback — wrap in a one-element array.
        Promise.resolve().then(function() {
            r.push(iterable);
            r.push(null);
        });
        return r;
    };

    // --- Writable ---------------------------------------------------------
    function Writable(opts) {
        if (!(this instanceof Writable)) return new Writable(opts);
        EventEmitter.call(this);
        this._events = this._events || Object.create(null);
        opts = opts || {};
        this._writable = true;
        this._destroyed = false;
        this._ended = false;
        this._finished = false;
        this._highWaterMark = opts.highWaterMark || DEFAULT_HWM;
        this._pending = 0;
        this._writeFn = (opts.write || function(_c, _e, cb) { cb && cb(); }).bind(this);
        this._writevFn = opts.writev ? opts.writev.bind(this) : null;
        this._finalFn = opts.final ? opts.final.bind(this) : null;
    }
    Writable.prototype = Object.create(EventEmitter.prototype);
    Writable.prototype.constructor = Writable;

    Writable.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed || this._ended) {
            var err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            if (cb) Promise.resolve().then(function() { cb(err); });
            this.emit('error', err);
            return false;
        }
        var self = this;
        var size = chunkSize(chunk);
        this._pending += size;
        var underWater = this._pending < this._highWaterMark;
        this._writeFn(chunk, encoding, function(err) {
            self._pending -= size;
            if (err) {
                self.emit('error', err);
            } else if (self._pending < self._highWaterMark
                       && self._pending + size >= self._highWaterMark) {
                // Crossed back below HWM — fire 'drain'.
                self.emit('drain');
            }
            if (cb) cb(err);
        });
        return underWater;
    };
    Writable.prototype.end = function(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        if (this._ended) { if (cb) Promise.resolve().then(cb); return this; }
        this._ended = true;
        var self = this;
        var finish = function(err) {
            if (err) { self.emit('error', err); if (cb) cb(err); return; }
            self._finished = true;
            self.emit('finish');
            self.emit('close');
            if (cb) cb();
        };
        if (this._finalFn) this._finalFn(finish); else finish();
        return this;
    };
    Writable.prototype.destroy = function(err) {
        if (this._destroyed) return this;
        this._destroyed = true;
        this._writable = false;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
        return this;
    };
    Writable.prototype.cork = function() {};
    Writable.prototype.uncork = function() {};
    Writable.prototype.setDefaultEncoding = function() { return this; };
    Object.defineProperty(Writable.prototype, 'writable', {
        get: function() {
            return this._writable && !this._destroyed && !this._ended;
        },
    });
    Object.defineProperty(Writable.prototype, 'destroyed', {
        get: function() { return this._destroyed; },
    });
    Object.defineProperty(Writable.prototype, 'writableEnded', {
        get: function() { return this._ended; },
    });
    Object.defineProperty(Writable.prototype, 'writableFinished', {
        get: function() { return this._finished; },
    });
    Object.defineProperty(Writable.prototype, 'writableLength', {
        get: function() { return this._pending; },
    });

    function chunkSize(chunk) {
        if (chunk == null) return 0;
        if (typeof chunk === 'string') return chunk.length;
        if (chunk.length !== undefined) return chunk.length;
        return 1;
    }

    // --- Duplex (separate read + write halves) ----------------------------
    //
    // Real Duplex: read() and write() track distinct buffers + states.
    // Different from Transform, which couples them via the user
    // _transform fn.
    function Duplex(opts) {
        if (!(this instanceof Duplex)) return new Duplex(opts);
        Readable.call(this, opts);
        // Re-init Writable's state without overwriting the Readable
        // properties we just set.
        opts = opts || {};
        this._writable = true;
        this._writableEnded = false;
        this._finished = false;
        this._pending = 0;
        this._writeFn = (opts.write || function(_c, _e, cb) { cb && cb(); }).bind(this);
        this._finalFn = opts.final ? opts.final.bind(this) : null;
    }
    Duplex.prototype = Object.create(Readable.prototype);
    Duplex.prototype.constructor = Duplex;

    Duplex.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed || this._writableEnded) {
            var err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            if (cb) Promise.resolve().then(function() { cb(err); });
            return false;
        }
        var self = this;
        var size = chunkSize(chunk);
        this._pending += size;
        var underWater = this._pending < this._highWaterMark;
        this._writeFn(chunk, encoding, function(err) {
            self._pending -= size;
            if (err) self.emit('error', err);
            else if (self._pending < self._highWaterMark
                     && self._pending + size >= self._highWaterMark) {
                self.emit('drain');
            }
            if (cb) cb(err);
        });
        return underWater;
    };
    Duplex.prototype.end = Writable.prototype.end;

    // --- Transform (write transforms into push) ---------------------------
    function Transform(opts) {
        if (!(this instanceof Transform)) return new Transform(opts);
        Readable.call(this, opts);
        opts = opts || {};
        this._writable = true;
        this._writableEnded = false;
        this._transform = (opts.transform || function(c, e, cb) { cb(null, c); }).bind(this);
        this._flush = opts.flush ? opts.flush.bind(this) : null;
    }
    Transform.prototype = Object.create(Readable.prototype);
    Transform.prototype.constructor = Transform;
    Transform.prototype.write = function(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (this._destroyed) {
            if (cb) cb(new Error('Transform destroyed'));
            return false;
        }
        var self = this;
        this._transform(chunk, encoding, function(err, out) {
            if (err) { self.emit('error', err); if (cb) cb(err); return; }
            if (out !== undefined && out !== null) self.push(out);
            if (cb) cb();
        });
        return true;
    };
    Transform.prototype.end = function(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        var self = this;
        var doFlush = function() {
            if (self._flush) {
                self._flush(function(err, out) {
                    if (err) { self.emit('error', err); if (cb) cb(err); return; }
                    if (out !== undefined && out !== null) self.push(out);
                    self.push(null);
                    if (cb) cb();
                });
            } else {
                self.push(null);
                if (cb) cb();
            }
        };
        if (chunk !== undefined && chunk !== null) {
            this.write(chunk, encoding, function() { doFlush(); });
        } else {
            doFlush();
        }
        return this;
    };

    // --- PassThrough ------------------------------------------------------
    function PassThrough(opts) {
        if (!(this instanceof PassThrough)) return new PassThrough(opts);
        Transform.call(this, Object.assign({}, opts, {
            transform: function(c, e, cb) { cb(null, c); },
        }));
    }
    PassThrough.prototype = Object.create(Transform.prototype);
    PassThrough.prototype.constructor = PassThrough;

    // --- pipeline ---------------------------------------------------------
    //
    // Node 20 supports several stage shapes:
    //   * stream object (Readable / Writable / Duplex / Transform)
    //   * iterable / async iterable (becomes a Readable)
    //   * async generator function `(prev) => ...` (becomes a Transform)
    //
    // This polyfill handles streams + iterables; generator-fn stages
    // get wrapped with a Readable.from(asyncFn(prev)) bridge.
    function pipeline() {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        if (args.length < 2) {
            var err = new Error('pipeline needs at least 2 streams');
            if (cb) cb(err);
            else throw err;
            return null;
        }
        var stages = args.map(function(s, i) {
            if (s && typeof s.pipe === 'function') return s;
            // Iterable / async iterable / generator fn.
            if (typeof s === 'function') {
                // Generator function — call with previous stream.
                return s; // resolved in the loop below with prev
            }
            if (s && (typeof s[Symbol.iterator] === 'function'
                || typeof s[Symbol.asyncIterator] === 'function')) {
                return Readable.from(s);
            }
            throw new Error('pipeline: stage ' + i + ' is not a stream / iterable / function');
        });

        var prev = stages[0];
        if (typeof prev === 'function') {
            // First stage can't be a function (no upstream).
            var e = new Error('pipeline: first stage cannot be a function');
            if (cb) cb(e); else throw e;
            return null;
        }
        for (var i = 1; i < stages.length; i++) {
            var stage = stages[i];
            if (typeof stage === 'function') {
                // Wrap as Readable.from(stage(prev))
                stage = Readable.from(stage(prev));
            }
            prev = prev.pipe(stage);
        }
        var settled = false;
        prev.on('finish', function() {
            if (settled) return;
            settled = true;
            if (cb) cb(null);
        });
        prev.on('end', function() {
            if (settled) return;
            settled = true;
            if (cb) cb(null);
        });
        prev.on('error', function(err) {
            if (settled) return;
            settled = true;
            if (cb) cb(err);
        });
        return prev;
    }

    // --- finished ---------------------------------------------------------
    function finished(stream, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        var settled = false;
        var done = function(err) {
            if (settled) return;
            settled = true;
            if (cb) cb(err || null);
        };
        if (stream.on) {
            stream.on('end', function() { done(); });
            stream.on('finish', function() { done(); });
            stream.on('close', function() { done(); });
            stream.on('error', function(e) { done(e); });
        }
    }

    // --- compose (Node 20+) -----------------------------------------------
    //
    // Returns a Duplex whose readable side is the last stage's output
    // and whose writable side feeds the first stage. Implemented by
    // running the pipeline and exposing a façade.
    function compose() {
        var args = Array.prototype.slice.call(arguments);
        if (args.length === 0) {
            throw new Error('compose: need at least one stream');
        }
        var first = args[0];
        for (var i = 1; i < args.length; i++) first = first.pipe(args[i]);
        // The composed object proxies write to the first arg, end to
        // the first arg, and forwards 'data'/'end' from the last.
        var head = args[0];
        var tail = args[args.length - 1];
        var d = new Duplex({
            write: function(chunk, encoding, cb) {
                head.write(chunk, encoding);
                if (cb) cb();
            },
            final: function(cb) { head.end(); cb(); },
        });
        tail.on('data', function(c) { d.push(c); });
        tail.on('end', function() { d.push(null); });
        tail.on('error', function(e) { d.emit('error', e); });
        return d;
    }

    // --- addAbortSignal ---------------------------------------------------
    //
    // When the signal aborts, destroy the stream with an AbortError.
    function addAbortSignal(signal, stream) {
        if (!signal) return stream;
        if (signal.aborted) {
            stream.destroy(new Error('AbortError'));
            return stream;
        }
        var listener = function() {
            stream.destroy(new Error('AbortError'));
        };
        signal.addEventListener && signal.addEventListener('abort', listener);
        return stream;
    }

    // Legacy `Stream` base class — Node's `require('stream')` returns
    // a *callable* function (the legacy `Stream` constructor) with the
    // modern subclasses + helpers attached as own properties. Real npm
    // packages depend on the dual shape: `send/index.js` does
    // `util.inherits(SendStream, Stream)`, which fails our explicit
    // `superCtor must be a function` guard if `Stream` is a plain
    // object. Keep the existing `exports` namespace populated for
    // call-sites that use `require('stream').Readable` etc.; swap
    // `module.exports` to the constructor.
    function Stream() {
        EventEmitter.call(this);
    }
    Stream.prototype = Object.create(EventEmitter.prototype);
    Stream.prototype.constructor = Stream;
    Stream.prototype.pipe = Readable.prototype.pipe;

    // ---- Node ↔ Web Streams bridge (Node 17+) ---------------------
    // `Readable.toWeb(node)` / `Readable.fromWeb(web)` etc. real
    // libs (undici, node-fetch shims, web-streams-polyfill consumers)
    // depend on these even when only one side is in active use.
    Readable.toWeb = function(nodeReadable, _opts) {
        if (typeof globalThis.ReadableStream !== 'function') {
            throw new Error('Readable.toWeb: ReadableStream unavailable');
        }
        return new globalThis.ReadableStream({
            start: function(controller) {
                nodeReadable.on('data', function(chunk) {
                    controller.enqueue(chunk);
                });
                nodeReadable.on('end', function() {
                    try { controller.close(); } catch (_) {}
                });
                nodeReadable.on('error', function(err) {
                    try { controller.error(err); } catch (_) {}
                });
            },
            cancel: function() {
                if (typeof nodeReadable.destroy === 'function') {
                    try { nodeReadable.destroy(); } catch (_) {}
                }
            },
        });
    };
    Readable.fromWeb = function(webReadable, _opts) {
        // Wrap a Web ReadableStream as a Node Readable. We pull
        // chunks via `.getReader()` and emit them as `data` events;
        // EOF closes the reader and fires `end`.
        var reader = webReadable.getReader();
        var node = Readable.from((async function* () {
            while (true) {
                var step = await reader.read();
                if (step.done) return;
                yield step.value;
            }
        })());
        return node;
    };
    Writable.toWeb = function(_nodeWritable) {
        throw new Error('Writable.toWeb: not implemented');
    };
    Writable.fromWeb = function(_webWritable) {
        throw new Error('Writable.fromWeb: not implemented');
    };

    exports.Readable       = Readable;
    exports.Writable       = Writable;
    exports.Duplex         = Duplex;
    exports.Transform      = Transform;
    exports.PassThrough    = PassThrough;
    exports.pipeline       = pipeline;
    exports.finished       = finished;
    exports.compose        = compose;
    exports.addAbortSignal = addAbortSignal;
    exports.Stream         = Stream;

    Stream.Readable        = Readable;
    Stream.Writable        = Writable;
    Stream.Duplex          = Duplex;
    Stream.Transform       = Transform;
    Stream.PassThrough     = PassThrough;
    Stream.pipeline        = pipeline;
    Stream.finished        = finished;
    Stream.compose         = compose;
    Stream.addAbortSignal  = addAbortSignal;
    Stream.Stream          = Stream;

    module.exports = Stream;
});

// zlib — synchronous deflate/inflate/gzip/gunzip backed by Rust
// (flate2). The wire format between JS and host is base64 strings so we
// don't need a binary-safe calling convention.

__register_module('zlib', function(module, exports, require) {

    var Buffer = require('buffer').Buffer;

    function needHost(name) {
        var fn = globalThis['__host_zlib_' + name];
        if (typeof fn !== 'function') {
            throw new Error('zlib.' + name + ' is not available');
        }
        return fn;
    }

    function toBase64(input) {
        if (Buffer.isBuffer(input)) return input.toString('base64');
        if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('base64');
        if (input instanceof Uint8Array) return Buffer.from(input).toString('base64');
        throw new TypeError('zlib: input must be Buffer, Uint8Array, or string');
    }

    function checkAndFromBase64(raw, op) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            throw new Error('zlib.' + op + ': ' + raw.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(raw, 'base64');
    }

    function call(op, input) {
        var raw = needHost(op)(toBase64(input));
        return checkAndFromBase64(raw, op);
    }

    exports.deflateSync       = function(input) { return call('deflate_sync', input);  };
    exports.inflateSync       = function(input) { return call('inflate_sync', input);  };
    exports.gzipSync          = function(input) { return call('gzip_sync',    input);  };
    exports.gunzipSync        = function(input) { return call('gunzip_sync',  input);  };
    exports.zstdCompressSync  = function(input) { return call('zstd_compress_sync',   input); };
    exports.zstdDecompressSync = function(input) { return call('zstd_decompress_sync', input); };

    // Promise wrappers — handy, free, no actual async under the hood.
    function asPromise(fn) {
        return function(input) {
            return new Promise(function(resolve, reject) {
                try { resolve(fn(input)); } catch (e) { reject(e); }
            });
        };
    }
    exports.deflate       = asPromise(exports.deflateSync);
    exports.inflate       = asPromise(exports.inflateSync);
    exports.gzip          = asPromise(exports.gzipSync);
    exports.gunzip        = asPromise(exports.gunzipSync);
    exports.zstdCompress  = asPromise(exports.zstdCompressSync);
    exports.zstdDecompress = asPromise(exports.zstdDecompressSync);

    // Aliases for the *-raw flavours (no zlib header). flate2 doesn't
    // expose the raw codec through our current host bridge, so we
    // route them to the regular deflate/inflate. Most callers (npm,
    // pacote, tar) only use gzip / inflate / deflate; the raw forms
    // matter for HTTP `Content-Encoding: deflate` decoding which is
    // rare in practice.
    exports.deflateRawSync = exports.deflateSync;
    exports.inflateRawSync = exports.inflateSync;
    exports.deflateRaw     = exports.deflate;
    exports.inflateRaw     = exports.inflate;
    exports.unzip          = exports.gunzip;
    exports.unzipSync      = exports.gunzipSync;

    // ---- streaming class API ---------------------------------------
    //
    // `new zlib.Gzip()` / `Gunzip()` / `Inflate()` / `Deflate()` —
    // EventEmitter-shaped Transform handles. `write(chunk)` queues
    // input; `end()` runs the codec and emits `data` then `end`.
    // minizlib (and therefore tar / pacote / npm install's tarball
    // extraction path) wraps these with its own Minipass shim and
    // calls `_processChunk(chunk, flushFlag)` directly — that path
    // is the hot one and uses one big chunk per call (the full
    // body comes through our async HTTP as a single chunk).
    var EventEmitter = require('events');

    function makeStreamingClass(syncFn, opName) {
        return function Codec(opts) {
            EventEmitter.call(this);
            this._opts = opts || {};
            this._chunks = [];
            this._closed = false;
            // `_handle` is the native handle stand-in. minizlib reads
            // and writes it through several layers — keep it a
            // truthy object with a no-op `close` to avoid breaking
            // its bookkeeping. minizlib's `_handle.close` is hijacked
            // at call-time anyway.
            this._handle = { close: function() {} };
        };
    }

    function attachCodecPrototype(Cls, syncFn, opName) {
        Cls.prototype = Object.create(EventEmitter.prototype);
        Cls.prototype.constructor = Cls;
        Cls.prototype.write = function(chunk, _enc, cb) {
            if (this._closed) {
                if (typeof cb === 'function') cb(new Error('zlib: write after close'));
                return false;
            }
            var b = Buffer.isBuffer(chunk) ? chunk
                  : (typeof chunk === 'string') ? Buffer.from(chunk, _enc || 'utf8')
                  : (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                  : null;
            if (!b) {
                var e = new TypeError('zlib: chunk must be Buffer, Uint8Array, or string');
                if (typeof cb === 'function') cb(e);
                else this.emit('error', e);
                return false;
            }
            this._chunks.push(b);
            if (typeof cb === 'function') cb(null);
            return true;
        };
        Cls.prototype.end = function(chunk, _enc, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof _enc === 'function')  { cb = _enc;  _enc  = undefined; }
            if (chunk !== undefined) this.write(chunk, _enc);
            var self = this;
            // Run the codec on the next microtask so listeners
            // (`on('data', …)` / `on('end', …)`) attached after `end()`
            // — the canonical Node pattern in stream pipes — still
            // observe the output.
            Promise.resolve().then(function() {
                if (self._closed) return;
                self._closed = true;
                try {
                    var combined = Buffer.concat(self._chunks);
                    var out = syncFn(combined);
                    self.emit('data', out);
                    self.emit('end');
                    self.emit('close');
                    if (typeof cb === 'function') cb(null);
                } catch (e) {
                    self.emit('error', e);
                    if (typeof cb === 'function') cb(e);
                }
            });
            return self;
        };
        Cls.prototype.close = function(cb) {
            this._closed = true;
            this._chunks.length = 0;
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(); });
        };
        Cls.prototype.reset = function() {
            this._chunks.length = 0;
            this._closed = false;
        };
        Cls.prototype.flush = function(_kind, cb) {
            if (typeof _kind === 'function') { cb = _kind; }
            // Flush is meaningful only for streaming codecs that
            // support partial output. Sync wrapper has nothing to do.
            if (typeof cb === 'function') Promise.resolve().then(function() { cb(); });
        };
        // `_processChunk(chunk, flushFlag)` — minizlib's internal hot
        // path. Synchronously decode/encode the chunk and return the
        // Buffer result. Every chunk through minizlib's flow is fed
        // here; for our async-HTTP body which arrives as one chunk,
        // this is called once with the full payload.
        //
        // minizlib follows the data chunk with an empty-buffer
        // "finalize" call (`Z_FINISH` flush flag). Node's native
        // codec returns empty bytes; our sync host gunzip would
        // throw "unexpected end of file" on the empty input. Short-
        // circuit: empty input → empty output, no host call.
        Cls.prototype._processChunk = function(chunk, _flushFlag) {
            var b = Buffer.isBuffer(chunk) ? chunk
                  : (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                  : Buffer.from(String(chunk));
            if (b.length === 0) return Buffer.alloc(0);
            return syncFn(b);
        };
        return Cls;
    }

    exports.Gzip    = attachCodecPrototype(makeStreamingClass(exports.gzipSync,    'gzip'),    exports.gzipSync,    'gzip');
    exports.Gunzip  = attachCodecPrototype(makeStreamingClass(exports.gunzipSync,  'gunzip'),  exports.gunzipSync,  'gunzip');
    exports.Deflate = attachCodecPrototype(makeStreamingClass(exports.deflateSync, 'deflate'), exports.deflateSync, 'deflate');
    exports.Inflate = attachCodecPrototype(makeStreamingClass(exports.inflateSync, 'inflate'), exports.inflateSync, 'inflate');
    exports.DeflateRaw    = exports.Deflate;
    exports.InflateRaw    = exports.Inflate;
    exports.Unzip         = exports.Gunzip;
    // Brotli — flate2 doesn't ship a brotli codec by default and the
    // host bridge lacks the entry. Constructable so `class X extends
    // zlib.BrotliCompress` doesn't trip QuickJS's "parent class must
    // be constructor" guard, but throws on actual use.
    function BrotliNotSupported() {
        throw Object.assign(new Error('zlib brotli codec not available'), { code: 'ERR_BROTLI_INVALID_PARAM' });
    }
    var BrotliClass = function() { BrotliNotSupported(); };
    BrotliClass.prototype = Object.create(EventEmitter.prototype);
    exports.BrotliCompress    = BrotliClass;
    exports.BrotliDecompress  = BrotliClass;

    // Factory functions that return a fresh codec instance. Mirrors
    // `http.createServer` / `net.createConnection` — Node sprinkles
    // these as the canonical entry point alongside the class form.
    exports.createGzip       = function(opts) { return new exports.Gzip(opts); };
    exports.createGunzip     = function(opts) { return new exports.Gunzip(opts); };
    exports.createDeflate    = function(opts) { return new exports.Deflate(opts); };
    exports.createInflate    = function(opts) { return new exports.Inflate(opts); };
    exports.createDeflateRaw = function(opts) { return new exports.DeflateRaw(opts); };
    exports.createInflateRaw = function(opts) { return new exports.InflateRaw(opts); };
    exports.createUnzip      = function(opts) { return new exports.Unzip(opts); };
    exports.createBrotliCompress    = function() { BrotliNotSupported(); };
    exports.createBrotliDecompress  = function() { BrotliNotSupported(); };

    // Constants block — every Z_* flush flag, error code, and
    // strategy. minizlib reads these by name (`Z_NO_FLUSH`,
    // `Z_FINISH`, etc.). Numeric values match upstream zlib.
    exports.constants = {
        Z_NO_FLUSH:      0, Z_PARTIAL_FLUSH:   1, Z_SYNC_FLUSH:     2,
        Z_FULL_FLUSH:    3, Z_FINISH:          4, Z_BLOCK:          5,
        Z_TREES:         6,
        Z_OK:            0, Z_STREAM_END:      1, Z_NEED_DICT:      2,
        Z_ERRNO:        -1, Z_STREAM_ERROR:   -2, Z_DATA_ERROR:    -3,
        Z_MEM_ERROR:    -4, Z_BUF_ERROR:      -5, Z_VERSION_ERROR: -6,
        Z_NO_COMPRESSION:    0, Z_BEST_SPEED:        1,
        Z_BEST_COMPRESSION:  9, Z_DEFAULT_COMPRESSION: -1,
        Z_FILTERED:          1, Z_HUFFMAN_ONLY:      2,
        Z_RLE:               3, Z_FIXED:             4,
        Z_DEFAULT_STRATEGY:  0,
        ZLIB_VERNUM:    0x12b0,
        DEFLATE:        1,    INFLATE:    2, GZIP: 3, GUNZIP: 4,
        DEFLATERAW:     5, INFLATERAW: 6, UNZIP: 7,
        BROTLI_DECODE:  8, BROTLI_ENCODE: 9,
        Z_MIN_WINDOWBITS:    8, Z_MAX_WINDOWBITS:   15, Z_DEFAULT_WINDOWBITS: 15,
        Z_MIN_CHUNK:      64, Z_MAX_CHUNK:        Infinity, Z_DEFAULT_CHUNK: 16384,
        Z_MIN_MEMLEVEL:    1, Z_MAX_MEMLEVEL:      9, Z_DEFAULT_MEMLEVEL: 8,
        Z_MIN_LEVEL:      -1, Z_MAX_LEVEL:         9, Z_DEFAULT_LEVEL: -1,
    };

    // Constants spread on the module too — Node exposes both
    // `zlib.Z_OK` and `zlib.constants.Z_OK`. Keep parity.
    Object.keys(exports.constants).forEach(function(k) {
        if (typeof exports[k] === 'undefined') exports[k] = exports.constants[k];
    });
});

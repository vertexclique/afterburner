// fs — thin glue over the __host_fs_* globals installed by the engine.
// Every method throws if the host global isn't present (meaning the
// engine didn't wire fs, usually because Manifold::fs == None).
//
// The WASM plugin signals host-side errors by returning a string that
// starts with "__HOST_ERR__:" — we check for that prefix and rethrow.

__register_module('fs', function(module, exports, require) {

    function requireHost(name) {
        var fn = globalThis['__host_fs_' + name];
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: fs." + name + " is not available");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function checkHostError(result, op) {
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("fs." + op + ": " + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) {
                err.code = 'EACCES';
            } else if (msg.toLowerCase().indexOf('not found') !== -1) {
                err.code = 'ENOENT';
            }
            throw err;
        }
        return result;
    }

    // Match Node.js exactly: the host bridge always sends bytes as
    // base64 (binary-safe wire format). The polyfill decodes and
    // converts based on the caller's encoding choice.
    //
    //   fs.readFileSync(path)              → Buffer        (Node default)
    //   fs.readFileSync(path, 'utf8')      → string
    //   fs.readFileSync(path, {encoding})  → string
    //   fs.readFileSync(path, {encoding: null}) → Buffer
    var BufferLazy;
    function bufferModule() {
        if (!BufferLazy) BufferLazy = require('buffer').Buffer;
        return BufferLazy;
    }

    function pickEncoding(options) {
        if (typeof options === 'string') return options;
        if (options && typeof options === 'object') {
            // Node treats `encoding: null` as "give me a Buffer".
            return options.encoding === undefined ? undefined : options.encoding;
        }
        return undefined;
    }

    exports.readFileSync = function(path, options) {
        var encoding = pickEncoding(options);
        // The encoding hint goes to the host so native (rquickjs)
        // bindings can short-circuit if they want; the WASM path
        // ignores it and always returns base64. Either way the
        // decode below is the source of truth.
        var b64 = requireHost('read_file_sync')(String(path), 'base64');
        b64 = checkHostError(b64, 'readFileSync');
        var Buffer = bufferModule();
        var buf = Buffer.from(b64, 'base64');
        if (encoding == null) return buf;
        return buf.toString(encoding);
    };

    exports.writeFileSync = function(path, data, options) {
        var encoding = pickEncoding(options);
        var Buffer = bufferModule();
        var bytes;
        if (Buffer.isBuffer(data)) {
            bytes = data;
        } else if (data instanceof Uint8Array) {
            bytes = Buffer.from(data);
        } else if (typeof data === 'string') {
            bytes = Buffer.from(data, encoding || 'utf8');
        } else {
            throw new TypeError('fs.writeFileSync: data must be Buffer, Uint8Array, or string');
        }
        var b64 = bytes.toString('base64');
        // Pass 'base64' through as the encoding hint (the WASM bridge
        // reads bytes from memory either way; this just keeps the
        // 3-arg shape stable for the native binding).
        var out = requireHost('write_file_sync')(String(path), b64, 'base64');
        checkHostError(out, 'writeFileSync');
    };

    exports.existsSync = function(path) {
        var fn = globalThis.__host_fs_exists_sync;
        return typeof fn === 'function' ? fn(String(path)) : false;
    };

    exports.statSync = function(path) {
        var raw = checkHostError(requireHost('stat_sync')(String(path)), 'statSync');
        var parsed = JSON.parse(raw);
        parsed.isFile = (function(v) { return function() { return v; }; })(parsed.isFile);
        parsed.isDirectory = (function(v) { return function() { return v; }; })(parsed.isDirectory);
        return parsed;
    };

    exports.readdirSync = function(path) {
        return requireHost('readdir_sync')(String(path));
    };

    exports.mkdirSync = function(path, options) {
        var recursive = !!(options && options.recursive);
        requireHost('mkdir_sync')(String(path), recursive);
    };

    exports.unlinkSync = function(path) {
        requireHost('unlink_sync')(String(path));
    };

    exports.renameSync = function(from, to) {
        requireHost('rename_sync')(String(from), String(to));
    };

    // ---- streaming -----------------------------------------------------
    var EventEmitter = require('events');
    var Buffer = require('buffer').Buffer;

    // No event loop in the sandbox: stream emission has to be triggered
    // synchronously by something. We adopt the convention that emission
    // fires when the first `data` listener is added (or when the user
    // calls `.resume()` explicitly). Attach `end` / `error` listeners
    // *before* attaching `data`.
    function createReadStream(path, options) {
        options = options || {};
        var chunkSize = options.highWaterMark || 64 * 1024;
        var startOffset = options.start || 0;
        var endOffset = options.end;  // inclusive per Node semantics
        var encoding = options.encoding || null;

        var ee = new EventEmitter();
        var pumped = false;

        function pump() {
            if (pumped) return;
            pumped = true;
            try {
                var sizeFn = globalThis.__host_fs_size;
                if (typeof sizeFn !== 'function') throw new Error('fs.createReadStream: not available');
                var sizeRaw = sizeFn(String(path));
                if (typeof sizeRaw === 'string' && sizeRaw.indexOf('__HOST_ERR__:') === 0) {
                    throw new Error('fs: ' + sizeRaw.slice('__HOST_ERR__:'.length));
                }
                var total = parseInt(sizeRaw, 10);
                var endIdx = (endOffset === undefined || endOffset >= total) ? total - 1 : endOffset;

                var off = startOffset;
                var readFn = globalThis.__host_fs_read_chunk;
                if (typeof readFn !== 'function') throw new Error('fs.createReadStream: chunk reader not available');
                while (off <= endIdx) {
                    var want = Math.min(chunkSize, endIdx - off + 1);
                    var raw = readFn(String(path), off, want);
                    if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                        throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
                    }
                    var buf = Buffer.from(raw, 'base64');
                    if (buf.length === 0) break;
                    var emitted = encoding ? buf.toString(encoding) : buf;
                    ee.emit('data', emitted);
                    off += buf.length;
                }
                ee.emit('end');
                ee.emit('close');
            } catch (e) {
                ee.emit('error', e);
            }
        }

        var origOn = ee.on.bind(ee);
        ee.on = function(name, fn) {
            origOn(name, fn);
            if (name === 'data') pump();
            return ee;
        };
        ee.addListener = ee.on;
        ee.resume = pump;
        ee.pipe = function(dest) {
            ee.on('end',  function() { if (dest.end) dest.end(); });
            ee.on('data', function(chunk) { dest.write(chunk); });
            return dest;
        };
        return ee;
    }

    function createWriteStream(path, options) {
        options = options || {};
        var off = options.start || 0;
        // Default flags='w' → overwrite, matching Node. Delete first so
        // existing file contents past the written region don't linger.
        var truncateFirst = (options.flags === undefined) || options.flags === 'w';
        var ee = new EventEmitter();
        var writeFn = globalThis.__host_fs_write_chunk;
        if (typeof writeFn !== 'function') {
            throw new Error('fs.createWriteStream: not available');
        }
        if (truncateFirst && typeof globalThis.__host_fs_unlink_sync === 'function') {
            // Ignore errors — file may not exist.
            try { globalThis.__host_fs_unlink_sync(String(path)); } catch (_) {}
        }
        ee.write = function(chunk) {
            try {
                var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
                var raw = writeFn(String(path), off, buf.toString('base64'));
                if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
                    throw new Error('fs: ' + raw.slice('__HOST_ERR__:'.length));
                }
                off += buf.length;
                return true;
            } catch (e) { ee.emit('error', e); return false; }
        };
        ee.end = function(chunk) {
            if (chunk) ee.write(chunk);
            ee.emit('finish');
            ee.emit('close');
        };
        return ee;
    }

    exports.createReadStream  = createReadStream;
    exports.createWriteStream = createWriteStream;

    // ----- realpath ---------------------------------------------------

    exports.realpathSync = function(path) {
        var fn = requireHost('realpath_sync');
        return checkHostError(fn(String(path)), 'realpath');
    };
    exports.realpath = function(path, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        var self = exports;
        Promise.resolve().then(function() {
            try { cb(null, self.realpathSync(path)); }
            catch (e) { cb(e); }
        });
    };
    exports.realpath.native = exports.realpath;

    // ----- cp (recursive copy) ----------------------------------------

    exports.cpSync = function(src, dst, options) {
        var fn = requireHost('cp');
        var force = !!(options && options.force);
        // Node's default is force: true; match that.
        if (options === undefined || (options && options.force === undefined)) {
            force = true;
        }
        checkHostError(fn(String(src), String(dst), force), 'cp');
    };
    exports.cp = function(src, dst, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { exports.cpSync(src, dst, options); cb(null); }
            catch (e) { cb(e); }
        });
    };

    // ----- opendir / Dir / Dirent -------------------------------------

    function Dirent(entry, parentPath) {
        this.name = entry.name;
        this.parentPath = parentPath;
        this.path = parentPath; // legacy alias
        this._isFile = !!entry.isFile;
        this._isDir = !!entry.isDir;
        this._isSymlink = !!entry.isSymlink;
    }
    Dirent.prototype.isFile = function() { return this._isFile; };
    Dirent.prototype.isDirectory = function() { return this._isDir; };
    Dirent.prototype.isSymbolicLink = function() { return this._isSymlink; };
    Dirent.prototype.isBlockDevice = function() { return false; };
    Dirent.prototype.isCharacterDevice = function() { return false; };
    Dirent.prototype.isFIFO = function() { return false; };
    Dirent.prototype.isSocket = function() { return false; };

    function rawDirEntries(path) {
        var fn = requireHost('opendir_sync');
        var json = checkHostError(fn(String(path)), 'opendir');
        try {
            var arr = JSON.parse(json);
            if (!Array.isArray(arr)) throw new Error('non-array');
            return arr;
        } catch (e) {
            var err = new Error('fs.opendir: malformed host response: ' + e.message);
            err.code = 'EOTHER';
            throw err;
        }
    }

    function Dir(path, entries) {
        this.path = path;
        this._entries = entries;
        this._idx = 0;
        this._closed = false;
    }
    Dir.prototype.read = function(cb) {
        var self = this;
        if (cb) {
            Promise.resolve().then(function() {
                try {
                    var ent = self._readNextSync();
                    cb(null, ent);
                } catch (e) { cb(e); }
            });
            return;
        }
        return new Promise(function(resolve, reject) {
            try { resolve(self._readNextSync()); }
            catch (e) { reject(e); }
        });
    };
    Dir.prototype.readSync = function() { return this._readNextSync(); };
    Dir.prototype._readNextSync = function() {
        if (this._closed) {
            var err = new Error('fs.Dir: read after close');
            err.code = 'ERR_DIR_CLOSED';
            throw err;
        }
        if (this._idx >= this._entries.length) return null;
        return new Dirent(this._entries[this._idx++], this.path);
    };
    Dir.prototype.close = function(cb) {
        this._closed = true;
        if (cb) { Promise.resolve().then(function() { cb(null); }); return; }
        return Promise.resolve();
    };
    Dir.prototype.closeSync = function() { this._closed = true; };
    // async iterator
    Dir.prototype[Symbol.asyncIterator] = function() {
        var self = this;
        return {
            next: function() {
                return self.read().then(function(ent) {
                    if (!ent) { self.close(); return { value: undefined, done: true }; }
                    return { value: ent, done: false };
                });
            },
            return: function() { return self.close().then(function() { return { value: undefined, done: true }; }); },
        };
    };

    exports.opendirSync = function(path, _options) {
        return new Dir(String(path), rawDirEntries(path));
    };
    exports.opendir = function(path, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        Promise.resolve().then(function() {
            try { cb(null, exports.opendirSync(path)); }
            catch (e) { cb(e); }
        });
    };
    exports.Dir = Dir;
    exports.Dirent = Dirent;

    // Augment readdirSync with `withFileTypes` support — the existing
    // overload returns a plain string array; opendir_sync gives us
    // typed entries.
    var _readdirSyncBasic = exports.readdirSync;
    exports.readdirSync = function(path, options) {
        if (options && options.withFileTypes) {
            var entries = rawDirEntries(path);
            var pp = String(path);
            return entries.map(function(e) { return new Dirent(e, pp); });
        }
        return _readdirSyncBasic(path);
    };

    // ----- watch (polling-based FSWatcher) ----------------------------

    var EventEmitter = require('events').EventEmitter;

    function FSWatcher(path, options) {
        EventEmitter.call(this);
        this._path = String(path);
        this._interval = (options && options.interval) || 250;
        this._closed = false;
        this._tick = this._tick.bind(this);
        this._scheduleNext();
    }
    FSWatcher.prototype = Object.create(EventEmitter.prototype);
    FSWatcher.prototype.constructor = FSWatcher;

    FSWatcher.prototype._scheduleNext = function() {
        if (this._closed) return;
        // Use setTimeout(0) so the first poll happens off the current
        // tick — matches Node's behavior of registering the watcher
        // synchronously and emitting events asynchronously.
        if (typeof setTimeout === 'function') {
            setTimeout(this._tick, 0);
        } else {
            // Fallback: microtask. Won't actually deliver host-watched
            // changes (host_fs_watch_poll blocks for `interval`ms), but
            // at least the watcher API surface works in environments
            // without a timer host (`burn` library mode).
            Promise.resolve().then(this._tick);
        }
    };

    FSWatcher.prototype._tick = function() {
        if (this._closed) return;
        var self = this;
        var fn;
        try { fn = requireHost('watch_poll'); }
        catch (e) {
            this.emit('error', e);
            this._closed = true;
            return;
        }
        var raw;
        try {
            raw = fn(self._path, self._interval);
        } catch (e) {
            this.emit('error', e);
            return this._scheduleNext();
        }
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var msg = raw.slice('__HOST_ERR__:'.length);
            var err = new Error('fs.watch: ' + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
            this.emit('error', err);
            this._closed = true;
            return;
        }
        try {
            var events = JSON.parse(raw);
            if (Array.isArray(events)) {
                for (var i = 0; i < events.length; i++) {
                    var ev = events[i];
                    self.emit('change', ev.kind, ev.filename);
                }
            }
        } catch (_) {}
        this._scheduleNext();
    };

    FSWatcher.prototype.close = function() {
        this._closed = true;
        try { this.emit('close'); } catch (_) {}
    };
    FSWatcher.prototype.ref = function() { return this; };
    FSWatcher.prototype.unref = function() { return this; };

    exports.FSWatcher = FSWatcher;
    exports.watch = function(path, options, listener) {
        if (typeof options === 'function') { listener = options; options = undefined; }
        var w = new FSWatcher(path, options);
        if (typeof listener === 'function') w.on('change', listener);
        return w;
    };

    // ----- FileHandle (fs.promises.open) ------------------------------

    function FileHandle(path, flags) {
        this._path = String(path);
        this._flags = flags || 'r';
        this._closed = false;
    }
    Object.defineProperty(FileHandle.prototype, 'fd', {
        // Node's fd is a small integer; we don't expose a real fd from
        // the WASM sandbox. Surface the path-keyed pseudo-fd so caller
        // code that just uses `.fd` for logging won't crash.
        get: function() { return -1; },
    });

    function _checkOpen(fh) {
        if (fh._closed) {
            var e = new Error('FileHandle: already closed');
            e.code = 'EBADF';
            throw e;
        }
    }

    FileHandle.prototype.read = function(buffer, offset, length, position) {
        _checkOpen(this);
        var Buffer = bufferModule();
        var path = this._path;
        // node-style positional or options-object call
        if (buffer && typeof buffer === 'object' && !Buffer.isBuffer(buffer)
            && !(buffer instanceof Uint8Array)) {
            var opts = buffer;
            buffer = opts.buffer;
            offset = opts.offset;
            length = opts.length;
            position = opts.position;
        }
        offset = offset | 0;
        length = (length === undefined || length === null) ? buffer.length - offset : length | 0;
        position = (position === undefined || position === null) ? 0 : position;
        return new Promise(function(resolve, reject) {
            try {
                var fn = requireHost('read_chunk');
                // host returns base64 encoded bytes
                var b64 = checkHostError(fn(path, position, length), 'FileHandle.read');
                var chunk = Buffer.from(b64, 'base64');
                var n = Math.min(chunk.length, length);
                for (var i = 0; i < n; i++) buffer[offset + i] = chunk[i];
                resolve({ bytesRead: n, buffer: buffer });
            } catch (e) { reject(e); }
        });
    };

    FileHandle.prototype.write = function(data, positionOrOffset, lengthOrEncoding, position) {
        _checkOpen(this);
        var Buffer = bufferModule();
        var path = this._path;
        var bytes;
        var pos;
        if (typeof data === 'string') {
            // (string, position, encoding)
            bytes = Buffer.from(data, lengthOrEncoding || 'utf8');
            pos = (positionOrOffset === undefined || positionOrOffset === null) ? 0 : positionOrOffset;
        } else {
            // (buffer, offset, length, position)
            var offset = positionOrOffset | 0;
            var length = (lengthOrEncoding === undefined || lengthOrEncoding === null)
                ? data.length - offset : lengthOrEncoding | 0;
            bytes = Buffer.from(data.slice(offset, offset + length));
            pos = (position === undefined || position === null) ? 0 : position;
        }
        return new Promise(function(resolve, reject) {
            try {
                var fn = requireHost('write_chunk');
                checkHostError(fn(path, pos, bytes.toString('base64')), 'FileHandle.write');
                resolve({ bytesWritten: bytes.length, buffer: data });
            } catch (e) { reject(e); }
        });
    };

    FileHandle.prototype.readFile = function(options) {
        _checkOpen(this);
        return Promise.resolve(exports.readFileSync(this._path, options));
    };

    FileHandle.prototype.writeFile = function(data, options) {
        _checkOpen(this);
        return Promise.resolve(exports.writeFileSync(this._path, data, options));
    };

    FileHandle.prototype.stat = function() {
        _checkOpen(this);
        return Promise.resolve(exports.statSync(this._path));
    };

    FileHandle.prototype.truncate = function(len) {
        _checkOpen(this);
        len = len | 0;
        var Buffer = bufferModule();
        var existing;
        try { existing = exports.readFileSync(this._path); }
        catch (e) { return Promise.reject(e); }
        var truncated = Buffer.alloc(len);
        existing.copy(truncated, 0, 0, Math.min(existing.length, len));
        try { exports.writeFileSync(this._path, truncated); return Promise.resolve(); }
        catch (e) { return Promise.reject(e); }
    };

    FileHandle.prototype.close = function() {
        this._closed = true;
        return Promise.resolve();
    };

    FileHandle.prototype[Symbol.asyncDispose] = function() { return this.close(); };

    // ----- fs.promises ------------------------------------------------

    exports.promises = {};
    ['readFile','writeFile','stat','readdir','mkdir','unlink','rename'].forEach(function(name) {
        exports.promises[name] = function() {
            var args = [].slice.call(arguments);
            var syncName = name + 'Sync';
            return new Promise(function(resolve, reject) {
                try { resolve(exports[syncName].apply(null, args)); }
                catch (e) { reject(e); }
            });
        };
    });
    // Common aliases.
    exports.promises.rm = exports.promises.unlink;

    // New promise-only entries.
    exports.promises.realpath = function(path) {
        return new Promise(function(resolve, reject) {
            try { resolve(exports.realpathSync(path)); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.cp = function(src, dst, options) {
        return new Promise(function(resolve, reject) {
            try { exports.cpSync(src, dst, options); resolve(); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.opendir = function(path, options) {
        return new Promise(function(resolve, reject) {
            try { resolve(exports.opendirSync(path, options)); }
            catch (e) { reject(e); }
        });
    };
    exports.promises.watch = function(path, options) {
        // Async-iterable wrapper around FSWatcher.
        var w = new FSWatcher(path, options);
        var queue = [];
        var pending = null;
        w.on('change', function(eventType, filename) {
            if (pending) {
                var p = pending; pending = null;
                p({ value: { eventType: eventType, filename: filename }, done: false });
            } else {
                queue.push({ eventType: eventType, filename: filename });
            }
        });
        w.on('error', function(err) {
            if (pending) { var p = pending; pending = null; p(Promise.reject(err)); }
        });
        return {
            [Symbol.asyncIterator]: function() { return this; },
            next: function() {
                if (queue.length) {
                    return Promise.resolve({ value: queue.shift(), done: false });
                }
                return new Promise(function(resolve) { pending = resolve; });
            },
            return: function() {
                w.close();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    };
    exports.promises.open = function(path, flags, _mode) {
        return new Promise(function(resolve, reject) {
            try {
                // Validate path is reachable; statSync will throw ENOENT
                // for read-only opens and give us a clean error path.
                if (typeof flags === 'string' && flags.indexOf('r') === 0) {
                    exports.statSync(path);
                }
                resolve(new FileHandle(path, flags));
            } catch (e) { reject(e); }
        });
    };
    exports.FileHandle = FileHandle;
});

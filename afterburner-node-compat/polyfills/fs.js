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

    exports.readFileSync = function(path, options) {
        var encoding = typeof options === 'string' ? options
            : (options && options.encoding) || 'utf8';
        var out = requireHost('read_file_sync')(String(path), encoding);
        return checkHostError(out, 'readFileSync');
    };

    exports.writeFileSync = function(path, data, options) {
        var encoding = typeof options === 'string' ? options
            : (options && options.encoding) || 'utf8';
        var out = requireHost('write_file_sync')(String(path), String(data), encoding);
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

    // fs.promises — thin Promise wrappers around the sync variants.
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
});

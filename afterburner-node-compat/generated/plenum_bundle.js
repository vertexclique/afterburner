// GENERATED — do not edit. Source: afterburner-node-compat/polyfills/
// Rebuild with: AFTERBURNER_REBUILD_PLENUM=1 cargo build -p afterburner-node-compat

// ---- require.js ----
// The plenum.js require() resolver.
//
// Installs a tiny CommonJS-style loader onto `globalThis`:
//   * `require(name)` resolves by stripping a `node:` prefix, consulting
//     the factory map, instantiating the module on first hit, and caching
//     the resulting `exports` object for subsequent calls.
//   * `__register_module(name, factory)` registers a lazy module whose
//     body runs only on first `require`.
//   * `__register_host_module(name, obj)` lets the Rust side inject a
//     ready-made module object bypassing the factory step — used when a
//     polyfill has no JS body and is fully backed by host globals.
//
// `require()` throws an Error for unknown modules, matching Node's
// `Cannot find module '…'` string so scripts that depend on the exact
// error text keep working.

(function plenumRequire() {
    var factories = Object.create(null);
    var cache = Object.create(null);

    function stripNodePrefix(name) {
        return typeof name === 'string' && name.indexOf('node:') === 0
            ? name.slice(5)
            : name;
    }

    function loadModule(mod) {
        var cached = cache[mod];
        if (cached !== undefined) return cached;

        var factory = factories[mod];
        if (typeof factory === 'function') {
            var m = { exports: {} };
            // Install before invoking so cyclic requires see a partial
            // exports object rather than triggering an infinite loop.
            cache[mod] = m.exports;
            factory(m, m.exports, globalThis.require);
            // Factories may replace `module.exports` wholesale
            // (e.g. `module.exports = EventEmitter`). Pick up the final
            // binding before handing it out.
            cache[mod] = m.exports;
            return m.exports;
        }

        throw new Error("Cannot find module '" + mod + "'");
    }

    globalThis.require = function(name) {
        return loadModule(stripNodePrefix(name));
    };

    globalThis.__register_module = function(name, factory) {
        factories[stripNodePrefix(name)] = factory;
    };

    globalThis.__register_host_module = function(name, obj) {
        cache[stripNodePrefix(name)] = obj;
    };

    globalThis.__plenum_modules_installed = function() {
        return Object.keys(factories).concat(Object.keys(cache));
    };
})();

// ---- abort.js ----
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

// ---- assert.js ----
// assert — subset. Deep-equality is structural; follows the Node.js
// "strict" semantics (=== for primitives, shape-recursive for objects).

__register_module('assert', function(module, exports, require) {

    function AssertionError(opts) {
        var message = opts && opts.message;
        if (!message) {
            var act = safeStringify(opts && opts.actual);
            var exp = safeStringify(opts && opts.expected);
            var op  = (opts && opts.operator) || 'fail';
            message = act + ' ' + op + ' ' + exp;
        }
        var err = new Error(message);
        err.name = 'AssertionError';
        err.actual = opts && opts.actual;
        err.expected = opts && opts.expected;
        err.operator = opts && opts.operator;
        err.generatedMessage = !(opts && opts.message);
        err.code = 'ERR_ASSERTION';
        return err;
    }

    function safeStringify(v) {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function deepEqual(a, b, strict) {
        if (strict ? a === b : a == b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
            return false;
        }
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        var ka = Object.keys(a);
        var kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            var k = ka[i];
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k], strict)) return false;
        }
        return true;
    }

    function assertFn(value, message) {
        if (!value) throw AssertionError({ actual: value, expected: true, operator: '==', message: message });
    }

    assertFn.ok = assertFn;
    assertFn.fail = function(message) {
        throw AssertionError({ message: message || 'Failed' });
    };
    assertFn.equal = function(a, e, m) {
        if (a != e) throw AssertionError({ actual: a, expected: e, operator: '==', message: m });
    };
    assertFn.notEqual = function(a, e, m) {
        if (a == e) throw AssertionError({ actual: a, expected: e, operator: '!=', message: m });
    };
    assertFn.strictEqual = function(a, e, m) {
        if (a !== e) throw AssertionError({ actual: a, expected: e, operator: '===', message: m });
    };
    assertFn.notStrictEqual = function(a, e, m) {
        if (a === e) throw AssertionError({ actual: a, expected: e, operator: '!==', message: m });
    };
    assertFn.deepEqual = function(a, e, m) {
        if (!deepEqual(a, e, false)) throw AssertionError({ actual: a, expected: e, operator: 'deepEqual', message: m });
    };
    assertFn.deepStrictEqual = function(a, e, m) {
        if (!deepEqual(a, e, true)) throw AssertionError({ actual: a, expected: e, operator: 'deepStrictEqual', message: m });
    };
    assertFn.throws = function(fn, expected, message) {
        var threw = false;
        var err;
        try { fn(); } catch (e) { threw = true; err = e; }
        if (!threw) throw AssertionError({ message: message || 'Expected function to throw' });
        if (expected instanceof RegExp && !expected.test(String(err))) {
            throw AssertionError({ actual: err, expected: expected, operator: 'throws', message: message });
        }
    };
    assertFn.doesNotThrow = function(fn, message) {
        try { fn(); } catch (e) {
            throw AssertionError({ actual: e, operator: 'doesNotThrow', message: message || 'Unexpected throw' });
        }
    };
    assertFn.AssertionError = AssertionError;
    assertFn.strict = assertFn;

    module.exports = assertFn;
});

// ---- buffer.js ----
// buffer — a `Buffer` class backed by `Uint8Array`, covering the
// slice of the API that scripts normally touch. UCS-2 / UTF-16 are
// intentionally omitted — callers who need them can fall back to
// TextDecoder directly.

__register_module('buffer', function(module, exports, require) {

    // ---- encoding helpers -------------------------------------------------

    var HEX = '0123456789abcdef';

    function utf8Encode(str) {
        // QuickJS exposes TextEncoder globally; prefer it when available.
        if (typeof TextEncoder === 'function') {
            return new TextEncoder().encode(str);
        }
        // Fallback — correct for BMP, good enough for ASCII-heavy payloads.
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80)       out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            else                out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        return new Uint8Array(out);
    }

    function utf8Decode(bytes) {
        if (typeof TextDecoder === 'function') {
            return new TextDecoder('utf-8').decode(bytes);
        }
        var out = '';
        for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function hexEncode(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i];
            out += HEX[(b >> 4) & 0x0F] + HEX[b & 0x0F];
        }
        return out;
    }

    function hexDecode(str) {
        str = String(str);
        if (str.length % 2) str = str.slice(0, str.length - 1);
        var bytes = new Uint8Array(str.length / 2);
        for (var i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(str.substr(i * 2, 2), 16) & 0xFF;
        }
        return bytes;
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64_INV = (function() {
        var a = new Int8Array(256).fill(-1);
        for (var i = 0; i < 64; i++) a[B64.charCodeAt(i)] = i;
        a['='.charCodeAt(0)] = 0;
        return a;
    })();

    function b64Encode(bytes) {
        var out = '';
        var i = 0;
        for (; i + 3 <= bytes.length; i += 3) {
            var n = (bytes[i] << 16) | (bytes[i+1] << 8) | bytes[i+2];
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
        }
        var rem = bytes.length - i;
        if (rem === 1) {
            var n1 = bytes[i] << 16;
            out += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '==';
        } else if (rem === 2) {
            var n2 = (bytes[i] << 16) | (bytes[i+1] << 8);
            out += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '=';
        }
        return out;
    }

    function b64Decode(str) {
        str = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
        var pad = 0;
        if (str.charAt(str.length - 1) === '=') pad++;
        if (str.charAt(str.length - 2) === '=') pad++;
        var out = new Uint8Array(Math.floor(str.length * 3 / 4) - pad);
        var o = 0;
        for (var i = 0; i < str.length; i += 4) {
            var n = (B64_INV[str.charCodeAt(i)]   << 18) |
                    (B64_INV[str.charCodeAt(i+1)] << 12) |
                    (B64_INV[str.charCodeAt(i+2)] << 6)  |
                    (B64_INV[str.charCodeAt(i+3)]);
            if (o < out.length) out[o++] = (n >> 16) & 0xFF;
            if (o < out.length) out[o++] = (n >> 8) & 0xFF;
            if (o < out.length) out[o++] = n & 0xFF;
        }
        return out;
    }

    // ---- Buffer class -----------------------------------------------------

    function Buffer(arg, encodingOrLength) {
        if (typeof arg === 'number') {
            var u = new Uint8Array(arg);
            makeBuffer(u);
            return u;
        }
        if (typeof arg === 'string') return Buffer.from(arg, encodingOrLength);
        if (arg instanceof Uint8Array) {
            makeBuffer(arg);
            return arg;
        }
        if (Array.isArray(arg)) return Buffer.from(arg);
        throw new TypeError('unsupported Buffer argument');
    }

    function makeBuffer(u8) {
        u8.__isBuffer = true;
        u8.toString = function(encoding, start, end) {
            encoding = (encoding || 'utf8').toLowerCase();
            var slice = (start !== undefined || end !== undefined) ? u8.subarray(start || 0, end) : u8;
            if (encoding === 'utf8' || encoding === 'utf-8') return utf8Decode(slice);
            if (encoding === 'hex')                          return hexEncode(slice);
            if (encoding === 'base64')                       return b64Encode(slice);
            if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') {
                var s = '';
                for (var i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
                return s;
            }
            throw new Error('Unknown encoding: ' + encoding);
        };
        u8.slice = function(start, end) {
            var s = Uint8Array.prototype.subarray.call(u8, start, end);
            makeBuffer(s);
            return s;
        };
        u8.equals = function(other) {
            if (!other || other.length !== u8.length) return false;
            for (var i = 0; i < u8.length; i++) if (u8[i] !== other[i]) return false;
            return true;
        };
        u8.compare = function(other, targetStart, targetEnd, sourceStart, sourceEnd) {
            var a = u8.subarray(sourceStart || 0, sourceEnd !== undefined ? sourceEnd : u8.length);
            var b = other.subarray(targetStart || 0, targetEnd !== undefined ? targetEnd : other.length);
            var len = Math.min(a.length, b.length);
            for (var i = 0; i < len; i++) {
                if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
            }
            return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
        };
        u8.indexOf = function(value, byteOffset, encoding) {
            var needle;
            if (typeof value === 'number') {
                for (var i = byteOffset || 0; i < u8.length; i++) if (u8[i] === (value & 0xff)) return i;
                return -1;
            }
            if (typeof value === 'string') needle = Buffer.from(value, encoding || 'utf8');
            else if (value instanceof Uint8Array) needle = value;
            else throw new TypeError('Buffer.indexOf: unsupported value');
            outer: for (var j = byteOffset || 0; j <= u8.length - needle.length; j++) {
                for (var k = 0; k < needle.length; k++) if (u8[j + k] !== needle[k]) continue outer;
                return j;
            }
            return -1;
        };
        u8.includes = function(value, byteOffset, encoding) {
            return u8.indexOf(value, byteOffset, encoding) !== -1;
        };
        u8.copy = function(target, targetStart, sourceStart, sourceEnd) {
            targetStart = targetStart || 0;
            sourceStart = sourceStart || 0;
            sourceEnd = sourceEnd !== undefined ? sourceEnd : u8.length;
            var n = Math.min(sourceEnd - sourceStart, target.length - targetStart);
            for (var i = 0; i < n; i++) target[targetStart + i] = u8[sourceStart + i];
            return n;
        };
        u8.write = function(str, offset, length, encoding) {
            offset = offset || 0;
            if (typeof length === 'string') { encoding = length; length = undefined; }
            var bytes = Buffer.from(str, encoding || 'utf8');
            var n = Math.min(length !== undefined ? length : bytes.length, u8.length - offset);
            for (var i = 0; i < n; i++) u8[offset + i] = bytes[i];
            return n;
        };
        // Numeric readers (little-endian + big-endian, unsigned + signed).
        u8.readUInt8 = function(o) { return u8[o || 0]; };
        u8.readInt8  = function(o) { var v = u8[o || 0]; return v > 127 ? v - 256 : v; };
        u8.readUInt16LE = function(o) { o = o || 0; return u8[o] | (u8[o + 1] << 8); };
        u8.readUInt16BE = function(o) { o = o || 0; return (u8[o] << 8) | u8[o + 1]; };
        u8.readInt16LE  = function(o) { var v = u8.readUInt16LE(o); return v > 32767 ? v - 65536 : v; };
        u8.readInt16BE  = function(o) { var v = u8.readUInt16BE(o); return v > 32767 ? v - 65536 : v; };
        u8.readUInt32LE = function(o) { o = o || 0;
            return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) + (u8[o + 3] * 0x1000000); };
        u8.readUInt32BE = function(o) { o = o || 0;
            return (u8[o] * 0x1000000) + ((u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]); };
        u8.readInt32LE  = function(o) { o = o || 0;
            return u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24); };
        u8.readInt32BE  = function(o) { o = o || 0;
            return (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]; };

        u8.writeUInt8 = function(v, o) { u8[o || 0] = v & 0xff; return (o || 0) + 1; };
        u8.writeInt8  = u8.writeUInt8;
        u8.writeUInt16LE = function(v, o) { o = o || 0; u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff; return o + 2; };
        u8.writeUInt16BE = function(v, o) { o = o || 0; u8[o] = (v >>> 8) & 0xff; u8[o + 1] = v & 0xff; return o + 2; };
        u8.writeInt16LE  = u8.writeUInt16LE;
        u8.writeInt16BE  = u8.writeUInt16BE;
        u8.writeUInt32LE = function(v, o) { o = o || 0;
            u8[o] = v & 0xff; u8[o + 1] = (v >>> 8) & 0xff;
            u8[o + 2] = (v >>> 16) & 0xff; u8[o + 3] = (v >>> 24) & 0xff;
            return o + 4;
        };
        u8.writeUInt32BE = function(v, o) { o = o || 0;
            u8[o] = (v >>> 24) & 0xff; u8[o + 1] = (v >>> 16) & 0xff;
            u8[o + 2] = (v >>> 8) & 0xff; u8[o + 3] = v & 0xff;
            return o + 4;
        };
        u8.writeInt32LE = u8.writeUInt32LE;
        u8.writeInt32BE = u8.writeUInt32BE;
        return u8;
    }

    Buffer.from = function(source, encoding) {
        if (typeof source === 'string') {
            encoding = (encoding || 'utf8').toLowerCase();
            if (encoding === 'utf8' || encoding === 'utf-8') return makeBuffer(utf8Encode(source));
            if (encoding === 'hex')                          return makeBuffer(hexDecode(source));
            if (encoding === 'base64')                       return makeBuffer(b64Decode(source));
            if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') {
                var u = new Uint8Array(source.length);
                for (var i = 0; i < source.length; i++) u[i] = source.charCodeAt(i) & 0xFF;
                return makeBuffer(u);
            }
            throw new Error('Unknown encoding: ' + encoding);
        }
        if (source instanceof ArrayBuffer) return makeBuffer(new Uint8Array(source));
        if (source instanceof Uint8Array || Array.isArray(source)) {
            var copy = new Uint8Array(source.length);
            copy.set(source);
            return makeBuffer(copy);
        }
        throw new TypeError('Buffer.from: unsupported source');
    };

    Buffer.alloc = function(size, fill) {
        var u = new Uint8Array(size);
        if (fill !== undefined && fill !== 0) {
            var byteFill = typeof fill === 'number' ? fill : fill.charCodeAt ? fill.charCodeAt(0) : 0;
            u.fill(byteFill & 0xFF);
        }
        return makeBuffer(u);
    };

    Buffer.allocUnsafe = Buffer.alloc;

    Buffer.concat = function(list, totalLength) {
        if (!Array.isArray(list)) throw new TypeError('list argument must be an Array');
        if (list.length === 0) return Buffer.alloc(0);
        if (totalLength === undefined) {
            totalLength = 0;
            for (var i = 0; i < list.length; i++) totalLength += list[i].length;
        }
        var out = new Uint8Array(totalLength);
        var offset = 0;
        for (var j = 0; j < list.length; j++) {
            var buf = list[j];
            var take = Math.min(buf.length, totalLength - offset);
            out.set(buf.subarray(0, take), offset);
            offset += take;
        }
        return makeBuffer(out);
    };

    Buffer.isBuffer = function(x) {
        return !!(x && x.__isBuffer === true);
    };

    Buffer.byteLength = function(str, encoding) {
        if (typeof str !== 'string') return str.length || 0;
        encoding = (encoding || 'utf8').toLowerCase();
        if (encoding === 'hex')    return Math.floor(str.length / 2);
        if (encoding === 'base64') return Math.floor(str.replace(/=/g, '').length * 3 / 4);
        return utf8Encode(str).length;
    };

    exports.Buffer = Buffer;
    exports.kMaxLength = 0x7fffffff;
    exports.INSPECT_MAX_BYTES = 50;
});

// ---- child_process.js ----
// child_process — native-only. The WASM plugin does not expose this
// surface, so `require('child_process').execSync(...)` throws on WASM.
//
// Sync methods only: Afterburner has no event loop to drive async
// callbacks.

__register_module('child_process', function(module, exports, require) {

    function ensureHost() {
        var fn = globalThis.__host_child_process_exec_sync;
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: child_process is not available in this sandbox");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function parseResult(raw) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            var err = new Error("child_process: " + raw.slice('__HOST_ERR__:'.length));
            err.code = 'EACCES';
            throw err;
        }
        return JSON.parse(raw);
    }

    exports.execSync = function(command, options) {
        // Node's `execSync` takes a whole command string; we split on
        // whitespace for the simple shim.
        var parts = String(command).split(/\s+/).filter(Boolean);
        if (parts.length === 0) throw new Error("child_process.execSync: empty command");
        var argv = parts.slice(1);
        var raw = ensureHost()(parts[0], argv);
        var result = parseResult(raw);
        if (result.status !== 0) {
            var err = new Error("Command failed: " + command + "\n" + result.stderr);
            err.status = result.status;
            err.stdout = result.stdout;
            err.stderr = result.stderr;
            throw err;
        }
        return result.stdout;
    };

    exports.spawnSync = function(command, args, options) {
        args = args || [];
        var raw = ensureHost()(String(command), args.map(String));
        return parseResult(raw);
    };
});

// ---- console.js ----
// console — routes messages through the host log hook when available,
// falling back to a noop-buffer if no host is wired. `util.format` is
// used for message rendering so `%s`, `%d`, `%j` behave as expected.

__register_module('console', function(module, exports, require) {

    function resolveHost() {
        return typeof globalThis.__host_log === 'function' ? globalThis.__host_log : null;
    }

    function render() {
        var util = require('util');
        return util.format.apply(null, arguments);
    }

    function logAt(level) {
        return function() {
            var host = resolveHost();
            var msg = render.apply(null, arguments);
            if (host) host(level, msg);
            // No fallback sink in the sandbox — msg is dropped if host
            // isn't wired. Users who want host-less output should call
            // `globalThis.__host_log = function(lvl, m) { ... }`.
        };
    }

    var c = {
        log:     logAt('info'),
        info:    logAt('info'),
        warn:    logAt('warn'),
        error:   logAt('error'),
        debug:   logAt('debug'),
        trace:   logAt('debug'),
        dir:     function(obj) {
            var util = require('util');
            logAt('info')(util.inspect(obj));
        },
        assert:  function(cond) {
            if (!cond) {
                var args = Array.prototype.slice.call(arguments, 1);
                logAt('error').apply(null, ['Assertion failed:'].concat(args));
            }
        },
        group:   function() {},
        groupEnd:function() {},
        time:    function() {},
        timeEnd: function() {},
        table:   function(t) { logAt('info')(JSON.stringify(t, null, 2)); }
    };

    module.exports = c;
    if (!globalThis.console) globalThis.console = c;
});

// ---- crypto.js ----
// crypto — Node-style hash/hmac/randomBytes/randomUUID, all backed by
// the engine's `__host_crypto_*` globals. A Hash/Hmac object accumulates
// data and returns the final digest on `.digest(encoding)`.

__register_module('crypto', function(module, exports, require) {

    function ensureHost(name) {
        var fn = globalThis['__host_crypto_' + name];
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: crypto." + name);
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function Hash(algorithm) {
        this._algo = String(algorithm).toLowerCase();
        this._chunks = [];
    }
    Hash.prototype.update = function(data) {
        this._chunks.push(typeof data === 'string' ? data : String(data));
        return this;
    };
    function checkErr(result, op) {
        if (typeof result === 'string' && result.indexOf('__HOST_ERR__:') === 0) {
            var msg = result.slice('__HOST_ERR__:'.length);
            var err = new Error("crypto." + op + ": " + msg);
            if (msg.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
            throw err;
        }
        return result;
    }

    Hash.prototype.digest = function(encoding) {
        return checkErr(
            ensureHost('hash')(this._algo, this._chunks.join(''), encoding || 'hex'),
            'hash'
        );
    };

    function Hmac(algorithm, key) {
        this._algo = String(algorithm).toLowerCase();
        this._key  = typeof key === 'string' ? key : String(key);
        this._chunks = [];
    }
    Hmac.prototype.update = function(data) {
        this._chunks.push(typeof data === 'string' ? data : String(data));
        return this;
    };
    Hmac.prototype.digest = function(encoding) {
        return checkErr(
            ensureHost('hmac')(this._algo, this._key, this._chunks.join(''), encoding || 'hex'),
            'hmac'
        );
    };

    exports.createHash = function(algorithm) { return new Hash(algorithm); };
    exports.createHmac = function(algorithm, key) { return new Hmac(algorithm, key); };

    exports.randomBytes = function(len, encoding) {
        var enc = typeof encoding === 'string' ? encoding : 'hex';
        return checkErr(ensureHost('random_bytes')(len, enc), 'randomBytes');
    };

    exports.randomUUID = function() {
        return checkErr(ensureHost('random_uuid')(), 'randomUUID');
    };

    exports.timingSafeEqual = function(a, b) {
        var fn = globalThis.__host_crypto_timing_safe_equal;
        if (typeof fn !== 'function') return false;
        return fn(typeof a === 'string' ? a : String(a),
                  typeof b === 'string' ? b : String(b));
    };

    // `randomFillSync` — filled for completeness; returns a string too.
    exports.randomFillSync = function(buffer) {
        var len = buffer && buffer.length ? buffer.length : 16;
        return ensureHost('random_bytes')(len, 'hex');
    };

    // ---- ciphers (AES-GCM / AES-CBC) --------------------------------
    var Buffer = require('buffer').Buffer;

    function toB64(x) {
        if (typeof x === 'string') return Buffer.from(x, 'utf8').toString('base64');
        if (Buffer.isBuffer(x))    return x.toString('base64');
        if (x instanceof Uint8Array) return Buffer.from(x).toString('base64');
        throw new TypeError('expected string/Buffer/Uint8Array');
    }
    function fromB64(s, tag) {
        if (typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(tag + ': ' + s.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(s, 'base64');
    }

    function makeGcmCipher(algo, key, iv, opts) {
        var aad = null;
        var finalized = false;
        var queued = [];
        var mode = opts && opts.mode; // 'encrypt' | 'decrypt'
        var authTag = null;
        return {
            setAAD: function(buf) { aad = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); return this; },
            setAutoPadding: function() { return this; },
            update: function(data) {
                if (finalized) throw new Error('cipher finalized');
                queued.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                return Buffer.alloc(0);
            },
            setAuthTag: function(tag) { authTag = tag; return this; },
            getAuthTag: function() {
                if (mode !== 'encrypt' || !finalized) {
                    throw new Error('getAuthTag available only after encrypt final');
                }
                return authTag;
            },
            final: function() {
                if (finalized) throw new Error('cipher finalized');
                finalized = true;
                var data = Buffer.concat(queued);
                var fn = mode === 'encrypt' ? '__host_crypto_aes_gcm_encrypt' : '__host_crypto_aes_gcm_decrypt';
                var rawIn = mode === 'encrypt' ? data
                    : Buffer.concat([data, authTag || Buffer.alloc(16)]);
                var raw = globalThis[fn](
                    algo,
                    toB64(key),
                    toB64(iv),
                    toB64(rawIn),
                    aad ? toB64(aad) : null
                );
                var out = fromB64(raw, 'cipher');
                if (mode === 'encrypt') {
                    authTag = out.slice(out.length - 16);
                    return out.slice(0, out.length - 16);
                } else {
                    return out;
                }
            }
        };
    }

    function makeCbcCipher(algo, key, iv, mode) {
        var finalized = false;
        var queued = [];
        return {
            setAutoPadding: function() { return this; },
            update: function(data) {
                if (finalized) throw new Error('cipher finalized');
                queued.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                return Buffer.alloc(0);
            },
            final: function() {
                if (finalized) throw new Error('cipher finalized');
                finalized = true;
                var data = Buffer.concat(queued);
                var fn = mode === 'encrypt' ? '__host_crypto_aes_cbc_encrypt' : '__host_crypto_aes_cbc_decrypt';
                var raw = globalThis[fn](algo, toB64(key), toB64(iv), toB64(data));
                return fromB64(raw, 'cipher');
            }
        };
    }

    function makeCipher(algo, key, iv, mode) {
        var a = String(algo).toLowerCase();
        if (a.indexOf('-gcm') > 0) return makeGcmCipher(a, key, iv, { mode: mode });
        if (a.indexOf('-cbc') > 0) return makeCbcCipher(a, key, iv, mode);
        throw new Error('Unsupported cipher: ' + algo);
    }

    exports.createCipheriv = function(algo, key, iv) { return makeCipher(algo, key, iv, 'encrypt'); };
    exports.createDecipheriv = function(algo, key, iv) { return makeCipher(algo, key, iv, 'decrypt'); };

    // ---- KDFs --------------------------------------------------------
    exports.pbkdf2Sync = function(password, salt, iterations, keylen, digest) {
        var fn = globalThis.__host_crypto_pbkdf2_sync;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.pbkdf2Sync');
        }
        var pwd = typeof password === 'string' ? password
            : Buffer.isBuffer(password) ? password.toString('binary')
            : String(password);
        var saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt));
        var raw = fn(String(digest || 'sha256'), pwd, saltBuf.toString('base64'), iterations >>> 0, keylen >>> 0);
        return fromB64(raw, 'pbkdf2Sync');
    };

    // ---- sign / verify (RSA + ECDSA) ----------------------------------
    function signImpl(algorithm, keyPem, data) {
        var fn = globalThis.__host_crypto_sign;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.sign');
        }
        var dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        var raw = fn(String(algorithm), String(keyPem), dataBuf.toString('base64'));
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            throw new Error('crypto.sign: ' + raw.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(raw, 'base64');
    }

    function verifyImpl(algorithm, keyPem, data, signature) {
        var fn = globalThis.__host_crypto_verify;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.verify');
        }
        var dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        var sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature));
        var code = fn(
            String(algorithm),
            String(keyPem),
            dataBuf.toString('base64'),
            sigBuf.toString('base64')
        );
        // Native path returns bool; WASM path returns i32 (1/0/negative).
        if (code === true || code === 1) return true;
        if (code === false || code === 0) return false;
        throw new Error('crypto.verify: host error (code ' + code + ')');
    }

    exports.sign = signImpl;
    exports.verify = verifyImpl;

    // Node's stream-style createSign / createVerify aliases.
    function makeSigner(algo) {
        var algoToHash = { 'RSA-SHA256': 'RS256', 'RSA-SHA384': 'RS384', 'RSA-SHA512': 'RS512',
                           'sha256WithRSAEncryption': 'RS256', 'sha384WithRSAEncryption': 'RS384',
                           'sha512WithRSAEncryption': 'RS512' };
        var canonical = algoToHash[algo] || algo;
        var chunks = [];
        return {
            update: function(d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return this; },
            sign:   function(key) { return signImpl(canonical, key, Buffer.concat(chunks)); }
        };
    }
    function makeVerifier(algo) {
        var algoToHash = { 'RSA-SHA256': 'RS256', 'RSA-SHA384': 'RS384', 'RSA-SHA512': 'RS512',
                           'sha256WithRSAEncryption': 'RS256', 'sha384WithRSAEncryption': 'RS384',
                           'sha512WithRSAEncryption': 'RS512' };
        var canonical = algoToHash[algo] || algo;
        var chunks = [];
        return {
            update: function(d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return this; },
            verify: function(key, sig) { return verifyImpl(canonical, key, Buffer.concat(chunks), sig); }
        };
    }
    exports.createSign = makeSigner;
    exports.createVerify = makeVerifier;

    exports.scryptSync = function(password, salt, keylen, options) {
        var fn = globalThis.__host_crypto_scrypt_sync;
        if (typeof fn !== 'function') {
            throw new Error('Permission denied: crypto.scryptSync');
        }
        options = options || {};
        var N = options.N || options.cost || 16384;
        var r = options.r || options.blockSize || 8;
        var p = options.p || options.parallelization || 1;
        var pwd = typeof password === 'string' ? password
            : Buffer.isBuffer(password) ? password.toString('binary')
            : String(password);
        var saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt));
        var raw = fn(pwd, saltBuf.toString('base64'), N >>> 0, r >>> 0, p >>> 0, keylen >>> 0);
        return fromB64(raw, 'scryptSync');
    };
});

// ---- dns.js ----
// dns — synchronous `lookup` only. Callback-style calls work by
// immediately invoking the callback with the resolved address (no
// actual async, matching Afterburner's no-event-loop model).

__register_module('dns', function(module, exports, require) {

    function ensureHost() {
        var fn = globalThis.__host_dns_lookup;
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: dns.lookup is not available");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function doLookup(hostname) {
        try {
            return { address: ensureHost()(String(hostname)), family: 4 };
        } catch (e) {
            throw e;
        }
    }

    exports.lookup = function(hostname, options, cb) {
        // Support both (host, cb) and (host, options, cb) forms.
        if (typeof options === 'function') { cb = options; options = undefined; }
        if (typeof cb === 'function') {
            try {
                var r = doLookup(hostname);
                cb(null, r.address, r.family);
            } catch (e) { cb(e); }
            return;
        }
        return doLookup(hostname);
    };

    exports.promises = {
        lookup: function(hostname) {
            return new Promise(function(resolve, reject) {
                try { resolve(doLookup(hostname)); } catch (e) { reject(e); }
            });
        }
    };
});

// ---- events.js ----
// events — a minimal EventEmitter with the APIs scripts actually use.

__register_module('events', function(module, exports, require) {

    function EventEmitter() {
        if (!(this instanceof EventEmitter)) return new EventEmitter();
        this._events = Object.create(null);
        this._maxListeners = undefined;
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
        var list = this._events[name];
        if (!list) this._events[name] = [fn];
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
        else delete this._events[name];
        return this;
    };

    EventEmitter.prototype.emit = function(name) {
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
        var list = this._events[name];
        return list ? list.slice() : [];
    };

    EventEmitter.prototype.listenerCount = function(name) {
        var list = this._events[name];
        return list ? list.length : 0;
    };

    EventEmitter.prototype.eventNames = function() {
        return Object.keys(this._events);
    };

    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.defaultMaxListeners = 10;

    module.exports = EventEmitter;
});

// ---- fetch.js ----
// fetch / Request / Response / Headers — Web API, synchronous under
// the hood (our http host is sync) but Promise-wrapped to match the
// standard interface.

(function installFetch() {
    if (typeof globalThis.fetch === 'function') return;

    function Headers(init) {
        this._m = Object.create(null);
        if (!init) return;
        if (init instanceof Headers) {
            for (var k in init._m) this._m[k] = init._m[k];
            return;
        }
        if (Array.isArray(init)) {
            for (var i = 0; i < init.length; i++) this.set(init[i][0], init[i][1]);
            return;
        }
        var keys = Object.keys(init);
        for (var j = 0; j < keys.length; j++) this.set(keys[j], init[keys[j]]);
    }
    Headers.prototype.get = function(k)       { return this._m[String(k).toLowerCase()] || null; };
    Headers.prototype.has = function(k)       { return String(k).toLowerCase() in this._m; };
    Headers.prototype.set = function(k, v)    { this._m[String(k).toLowerCase()] = String(v); };
    Headers.prototype.append = function(k, v) {
        var key = String(k).toLowerCase();
        this._m[key] = (this._m[key] ? this._m[key] + ', ' : '') + String(v);
    };
    Headers.prototype['delete'] = function(k) { delete this._m[String(k).toLowerCase()]; };
    Headers.prototype.forEach = function(cb)  {
        var keys = Object.keys(this._m);
        for (var i = 0; i < keys.length; i++) cb(this._m[keys[i]], keys[i], this);
    };
    Headers.prototype.entries = function() {
        var keys = Object.keys(this._m);
        var self = this;
        var i = 0;
        return { next: function() {
            if (i >= keys.length) return { done: true };
            var k = keys[i++];
            return { value: [k, self._m[k]], done: false };
        } };
    };

    function Request(url, init) {
        init = init || {};
        this.url = String(url);
        this.method = (init.method || 'GET').toUpperCase();
        this.headers = new Headers(init.headers);
        this.body = init.body != null ? String(init.body) : null;
        this.signal = init.signal || null;
    }

    function Response(body, init) {
        init = init || {};
        this._body = body != null ? String(body) : '';
        this.status = init.status !== undefined ? init.status : 200;
        this.statusText = init.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(init.headers);
        this.url = init.url || '';
        this.bodyUsed = false;
    }
    Response.prototype.text = function() {
        if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
        this.bodyUsed = true;
        return Promise.resolve(this._body);
    };
    Response.prototype.json = function() {
        return this.text().then(function(s) { return JSON.parse(s); });
    };
    Response.prototype.arrayBuffer = function() {
        var Buffer = require('buffer').Buffer;
        return this.text().then(function(s) {
            return Buffer.from(s, 'utf8').buffer;
        });
    };
    Response.prototype.clone = function() {
        var r = new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
        return r;
    };

    function fetch(input, init) {
        var req = input instanceof Request ? input : new Request(input, init);
        if (req.signal && req.signal.aborted) {
            return Promise.reject(req.signal.reason || new Error('Aborted'));
        }
        if (typeof globalThis.__host_http_request !== 'function') {
            return Promise.reject(new Error('fetch: net capability not granted'));
        }
        var raw = globalThis.__host_http_request(req.method, req.url, req.body);
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { return Promise.reject(new Error('fetch: malformed host response: ' + e.message)); }
        if (typeof parsed.body === 'string' && parsed.body.indexOf('__HOST_ERR__:') === 0) {
            return Promise.reject(new Error('fetch: ' + parsed.body.slice('__HOST_ERR__:'.length)));
        }
        var resp = new Response(parsed.body, { status: parsed.status, url: req.url });
        return Promise.resolve(resp);
    }

    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
})();

// ---- fs.js ----
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
        var truncateFirst = (options.flags === undefined) || options.flags === 'w';
        var ee = new EventEmitter();
        var writeFn = globalThis.__host_fs_write_chunk;
        if (typeof writeFn !== 'function') {
            // Defer emission so callers can attach 'error' first.
            Promise.resolve().then(function() {
                ee.emit('error', new Error('fs.createWriteStream: not available'));
            });
        }
        if (truncateFirst) {
            // Best-effort truncate: write zero bytes at offset 0.
            try { writeFn(String(path), 0, ''); } catch (_) {}
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

// ---- http.js ----
// http / https — synchronous `request`/`get` wrappers around
// `__host_http_request`. No streaming, no keep-alive — scripts that need
// those features should move to a pipeline host.

function __plenum_install_http(moduleName) {
    __register_module(moduleName, function(module, exports, require) {

        function requestImpl(opts, cb) {
            if (typeof globalThis.__host_http_request !== 'function') {
                throw new Error("Permission denied: http.request is not available");
            }
            var url = typeof opts === 'string' ? opts
                : (opts.protocol || 'http:') + '//' + (opts.host || opts.hostname)
                  + (opts.port ? ':' + opts.port : '') + (opts.path || '/');
            var method = (opts && opts.method) || 'GET';
            var body = opts && opts.body;

            var resultRaw = globalThis.__host_http_request(method, url, body || null);
            var result = JSON.parse(resultRaw);
            if (typeof result.body === 'string' && result.body.indexOf('__HOST_ERR__:') === 0) {
                var err = new Error("http: " + result.body.slice('__HOST_ERR__:'.length));
                if (err.message.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
                throw err;
            }

            // Shape the response like a minimal IncomingMessage.
            var resp = {
                statusCode: result.status,
                headers: {},
                body: result.body,
                _bodyRead: false,
                on: function(event, handler) {
                    if (event === 'data') { handler(result.body); return this; }
                    if (event === 'end')  { handler(); return this; }
                    return this;
                },
                setEncoding: function() {},
                text: function() { return Promise.resolve(result.body); },
                json: function() { return Promise.resolve(JSON.parse(result.body)); }
            };
            if (cb) cb(resp);
            return {
                end:   function() {},
                write: function() {},
                on:    function() { return this; }
            };
        }

        exports.request = requestImpl;
        exports.get     = function(opts, cb) { return requestImpl(opts, cb); };
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

// ---- os.js ----
// os — trivially backed by host globals. No Manifold gating.

__register_module('os', function(module, exports, require) {

    function fallback(name, def) {
        var fn = globalThis['__host_os_' + name];
        return typeof fn === 'function' ? fn() : def;
    }

    exports.platform  = function() { return fallback('platform',  'linux'); };
    exports.arch      = function() { return fallback('arch',      'x64'); };
    exports.hostname  = function() { return fallback('hostname',  'afterburner'); };
    exports.tmpdir    = function() { return fallback('tmpdir',    '/tmp'); };
    exports.homedir   = function() { return fallback('home_dir',  '/'); };
    exports.cpus      = function() {
        var n = fallback('cpus', 1);
        var out = [];
        for (var i = 0; i < n; i++) out.push({ model: 'afterburner', speed: 0 });
        return out;
    };
    exports.totalmem  = function() { return 0; };
    exports.freemem   = function() { return 0; };
    exports.uptime    = function() { return 0; };
    exports.EOL       = '\n';
    exports.type      = function() { return 'Linux'; };
    exports.release   = function() { return '0.0.0-afterburner'; };
    exports.endianness = function() { return 'LE'; };
});

// ---- path.js ----
// path — POSIX subset. Good enough for the overwhelming majority of
// server-side and ETL scripts; win32 path handling is out of scope.

__register_module('path', function(module, exports, require) {
    var SEP = '/';

    function assertString(x) {
        if (typeof x !== 'string') {
            throw new TypeError("Path must be a string. Received " + typeof x);
        }
    }

    // Collapse `.`, `..`, and redundant separators. Mirrors Node's
    // `normalizeString` helper without bothering to distinguish win32.
    function normalizeString(path, allowAboveRoot) {
        var res = '';
        var lastSegmentLength = 0;
        var lastSlash = -1;
        var dots = 0;
        var code;
        for (var i = 0; i <= path.length; ++i) {
            if (i < path.length) code = path.charCodeAt(i);
            else if (code === 47) break;
            else code = 47;

            if (code === 47) { // '/'
                if (lastSlash === i - 1 || dots === 1) {
                    // no-op
                } else if (lastSlash !== i - 1 && dots === 2) {
                    if (res.length < 2 || lastSegmentLength !== 2 ||
                        res.charCodeAt(res.length - 1) !== 46 ||
                        res.charCodeAt(res.length - 2) !== 46) {
                        if (res.length > 2) {
                            var lastSlashIndex = res.lastIndexOf('/');
                            if (lastSlashIndex === -1) {
                                res = '';
                                lastSegmentLength = 0;
                            } else {
                                res = res.slice(0, lastSlashIndex);
                                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        } else if (res.length === 2 || res.length === 1) {
                            res = '';
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot) {
                        if (res.length > 0) res += '/..';
                        else res = '..';
                        lastSegmentLength = 2;
                    }
                } else {
                    if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
                    else res = path.slice(lastSlash + 1, i);
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            } else if (code === 46 && dots !== -1) {
                ++dots;
            } else {
                dots = -1;
            }
        }
        return res;
    }

    exports.sep = SEP;
    exports.delimiter = ':';

    exports.normalize = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var isAbs = p.charCodeAt(0) === 47;
        var trailingSep = p.charCodeAt(p.length - 1) === 47;
        p = normalizeString(p, !isAbs);
        if (p.length === 0 && !isAbs) p = '.';
        if (p.length > 0 && trailingSep) p += '/';
        return isAbs ? '/' + p : p;
    };

    exports.isAbsolute = function(p) {
        assertString(p);
        return p.length > 0 && p.charCodeAt(0) === 47;
    };

    exports.join = function() {
        if (arguments.length === 0) return '.';
        var joined;
        for (var i = 0; i < arguments.length; ++i) {
            var arg = arguments[i];
            assertString(arg);
            if (arg.length > 0) {
                if (joined === undefined) joined = arg;
                else joined += '/' + arg;
            }
        }
        if (joined === undefined) return '.';
        return exports.normalize(joined);
    };

    exports.resolve = function() {
        var resolved = '';
        var resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var p = (i >= 0) ? arguments[i] : '/';
            assertString(p);
            if (p.length === 0) continue;
            resolved = p + '/' + resolved;
            resolvedAbsolute = p.charCodeAt(0) === 47;
        }
        resolved = normalizeString(resolved, !resolvedAbsolute);
        if (resolvedAbsolute) return '/' + resolved;
        return resolved.length > 0 ? resolved : '.';
    };

    exports.dirname = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var hasRoot = p.charCodeAt(0) === 47;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 1; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { end = i; break; }
            } else {
                matchedSlash = false;
            }
        }
        if (end === -1) return hasRoot ? '/' : '.';
        if (hasRoot && end === 1) return '//';
        return p.slice(0, end);
    };

    exports.basename = function(p, ext) {
        assertString(p);
        if (ext !== undefined) assertString(ext);
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 0; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { start = i + 1; break; }
            } else if (end === -1) {
                matchedSlash = false;
                end = i + 1;
            }
        }
        if (end === -1) return '';
        var base = p.slice(start, end);
        if (ext && base.length >= ext.length && base.slice(base.length - ext.length) === ext) {
            base = base.slice(0, base.length - ext.length);
        }
        return base;
    };

    exports.extname = function(p) {
        assertString(p);
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var preDotState = 0;
        for (var i = p.length - 1; i >= 0; --i) {
            var code = p.charCodeAt(i);
            if (code === 47) {
                if (!matchedSlash) { startPart = i + 1; break; }
                continue;
            }
            if (end === -1) { matchedSlash = false; end = i + 1; }
            if (code === 46) {
                if (startDot === -1) startDot = i;
                else if (preDotState !== 1) preDotState = 1;
            } else if (startDot !== -1) {
                preDotState = -1;
            }
        }
        if (startDot === -1 || end === -1 || preDotState === 0 ||
            (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
            return '';
        }
        return p.slice(startDot, end);
    };

    exports.parse = function(p) {
        assertString(p);
        var ret = { root: '', dir: '', base: '', ext: '', name: '' };
        if (p.length === 0) return ret;
        var isAbs = p.charCodeAt(0) === 47;
        if (isAbs) ret.root = '/';
        var base = exports.basename(p);
        var dir = exports.dirname(p);
        ret.dir = isAbs && dir === '/' ? '/' : dir === '.' && !isAbs ? '' : dir;
        ret.base = base;
        ret.ext = exports.extname(base);
        ret.name = ret.ext.length > 0 ? base.slice(0, base.length - ret.ext.length) : base;
        return ret;
    };

    exports.format = function(obj) {
        if (obj === null || typeof obj !== 'object') {
            throw new TypeError('path.format requires an object');
        }
        var dir = obj.dir || obj.root || '';
        var base = obj.base || ((obj.name || '') + (obj.ext || ''));
        if (!dir) return base;
        if (dir === obj.root) return dir + base;
        return dir + '/' + base;
    };

    exports.posix = exports;
});

// ---- process.js ----
// process — eager-installed as `globalThis.process` and registered as
// the CommonJS `process` module. Acts as an EventEmitter so scripts
// using `process.on('exit', …)` etc. do not blow up.
//
// The IIFE runs at bundle-load time so `globalThis.process` is set
// regardless of whether the user script ever calls `require('process')`.

(function bootstrapProcess() {
    // EventEmitter is provided by events.js; we lookup directly from
    // the require resolver since this runs before user code.
    var EventEmitter = require('events');

    var hostEnv = globalThis.__host_env || {};
    var proc = Object.create(EventEmitter.prototype);
    EventEmitter.call(proc);

    var fields = {
        platform: globalThis.__host_platform || 'linux',
        arch:     globalThis.__host_arch     || 'x64',
        version:  'v20.0.0-afterburner',
        versions: { node: '20.0.0', afterburner: '0.1.0' },
        env:      hostEnv,
        argv:     ['afterburner'],
        execPath: '/usr/bin/afterburner',
        pid:      1,
        title:    'afterburner',

        cwd:      function() { return globalThis.__host_cwd || '/'; },
        chdir:    function() { throw new Error('process.chdir is not supported'); },

        nextTick: function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args);
        },

        exit: function(code) {
            try { proc.emit('exit', code || 0); } catch (_) {}
            if (globalThis.__host_process_exit) globalThis.__host_process_exit(code || 0);
            var err = new Error('process.exit(' + (code || 0) + ')');
            err.code = 'ERR_PROCESS_EXIT';
            err.exitCode = code || 0;
            throw err;
        },

        hrtime: function(prev) {
            var now = Date.now();
            var seconds = Math.floor(now / 1000);
            var nanos = (now % 1000) * 1e6;
            if (prev) {
                var ds = seconds - prev[0];
                var dn = nanos - prev[1];
                if (dn < 0) { ds -= 1; dn += 1e9; }
                return [ds, dn];
            }
            return [seconds, nanos];
        },

        stdout: { write: function(s) { if (globalThis.console) console.log(String(s)); return true; } },
        stderr: { write: function(s) { if (globalThis.console) console.error(String(s)); return true; } },
        stdin:  { on: function() {}, read: function() { return null; } }
    };

    fields.hrtime.bigint = function() {
        var t = fields.hrtime();
        return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
    };

    Object.keys(fields).forEach(function(k) { proc[k] = fields[k]; });

    globalThis.process = proc;
    __register_host_module('process', proc);
})();

// ---- punycode.js ----
// punycode — RFC 3492 implementation.
// Adapted from Mathias Bynens' `punycode.js` (MIT) — kept small and
// hand-audited rather than pulled in as a dependency.

__register_module('punycode', function(module, exports, require) {

    var maxInt = 2147483647;
    var base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    var initialBias = 72, initialN = 128;
    var delimiter = '-';

    function adapt(delta, numPoints, firstTime) {
        delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
        delta += Math.floor(delta / numPoints);
        var k = 0;
        while (delta > ((base - tMin) * tMax) >> 1) {
            delta = Math.floor(delta / (base - tMin));
            k += base;
        }
        return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
    }

    function digitToBasic(digit) {
        return digit + 22 + 75 * (digit < 26 ? 1 : 0);
    }

    function basicToDigit(codePoint) {
        if (codePoint - 48 < 10) return codePoint - 22;
        if (codePoint - 65 < 26) return codePoint - 65;
        if (codePoint - 97 < 26) return codePoint - 97;
        return base;
    }

    function ucs2decode(str) {
        var out = [];
        var i = 0;
        while (i < str.length) {
            var value = str.charCodeAt(i++);
            if (value >= 0xD800 && value <= 0xDBFF && i < str.length) {
                var extra = str.charCodeAt(i++);
                if ((extra & 0xFC00) === 0xDC00) {
                    out.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                    out.push(value);
                    i--;
                }
            } else {
                out.push(value);
            }
        }
        return out;
    }

    function ucs2encode(arr) {
        var out = '';
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v > 0xFFFF) {
                v -= 0x10000;
                out += String.fromCharCode((v >>> 10) & 0x3FF | 0xD800);
                v = 0xDC00 | (v & 0x3FF);
            }
            out += String.fromCharCode(v);
        }
        return out;
    }

    function encode(input) {
        var inputArr = ucs2decode(input);
        var n = initialN;
        var delta = 0;
        var bias = initialBias;
        var output = [];

        for (var i = 0; i < inputArr.length; i++) {
            if (inputArr[i] < 0x80) output.push(String.fromCharCode(inputArr[i]));
        }
        var basicLength = output.length;
        var handledCPCount = basicLength;

        if (basicLength) output.push(delimiter);

        while (handledCPCount < inputArr.length) {
            var m = maxInt;
            for (var j = 0; j < inputArr.length; j++) {
                if (inputArr[j] >= n && inputArr[j] < m) m = inputArr[j];
            }
            delta += (m - n) * (handledCPCount + 1);
            n = m;
            for (var k = 0; k < inputArr.length; k++) {
                var cp = inputArr[k];
                if (cp < n) delta++;
                if (cp === n) {
                    var q = delta;
                    for (var t, w = base; ; w += base) {
                        t = w <= bias ? tMin : (w >= bias + tMax ? tMax : w - bias);
                        if (q < t) break;
                        output.push(String.fromCharCode(digitToBasic(t + (q - t) % (base - t))));
                        q = Math.floor((q - t) / (base - t));
                    }
                    output.push(String.fromCharCode(digitToBasic(q)));
                    bias = adapt(delta, handledCPCount + 1, handledCPCount === basicLength);
                    delta = 0;
                    handledCPCount++;
                }
            }
            delta++;
            n++;
        }
        return output.join('');
    }

    function decode(input) {
        var output = [];
        var i = 0, n = initialN, bias = initialBias;
        var basic = input.lastIndexOf(delimiter);
        if (basic < 0) basic = 0;
        for (var j = 0; j < basic; j++) {
            var c = input.charCodeAt(j);
            if (c >= 0x80) throw new RangeError('Invalid input');
            output.push(c);
        }
        var idx = basic > 0 ? basic + 1 : 0;
        while (idx < input.length) {
            var oldi = i;
            for (var w = 1, k = base; ; k += base) {
                if (idx >= input.length) throw new RangeError('Invalid input');
                var digit = basicToDigit(input.charCodeAt(idx++));
                if (digit >= base || digit > Math.floor((maxInt - i) / w)) throw new RangeError('Overflow');
                i += digit * w;
                var t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                if (digit < t) break;
                w *= (base - t);
            }
            var outLen = output.length + 1;
            bias = adapt(i - oldi, outLen, oldi === 0);
            if (Math.floor(i / outLen) > maxInt - n) throw new RangeError('Overflow');
            n += Math.floor(i / outLen);
            i %= outLen;
            output.splice(i++, 0, n);
        }
        return ucs2encode(output);
    }

    function toASCII(input) {
        return input.replace(/[^\0-\x7E]/, function() { return 'xn--' + encode(input); });
    }
    function toUnicode(input) {
        if (input.indexOf('xn--') === 0) return decode(input.slice(4));
        return input;
    }

    exports.encode = encode;
    exports.decode = decode;
    exports.toASCII = toASCII;
    exports.toUnicode = toUnicode;
    exports.ucs2 = { encode: ucs2encode, decode: ucs2decode };
    exports.version = '2.1.1-polyfill';
});

// ---- querystring.js ----
// querystring — the legacy Node module. For new code `URLSearchParams`
// (a QuickJS built-in) is a better fit; this module exists for parity
// with code that still imports it.

__register_module('querystring', function(module, exports, require) {

    function enc(s) { return encodeURIComponent(String(s)); }
    function dec(s) {
        try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }
        catch (_) { return String(s); }
    }

    exports.escape = enc;
    exports.unescape = dec;

    exports.stringify = function(obj, sep, eq, options) {
        sep = sep || '&';
        eq = eq || '=';
        if (obj === null || typeof obj !== 'object') return '';
        var keys = Object.keys(obj);
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = obj[k];
            var ek = enc(k);
            if (Array.isArray(v)) {
                for (var j = 0; j < v.length; j++) {
                    parts.push(ek + eq + enc(v[j]));
                }
            } else if (v === null || v === undefined) {
                parts.push(ek + eq);
            } else {
                parts.push(ek + eq + enc(v));
            }
        }
        return parts.join(sep);
    };

    exports.parse = function(str, sep, eq, options) {
        var obj = Object.create(null);
        if (typeof str !== 'string' || str.length === 0) return obj;
        sep = sep || '&';
        eq = eq || '=';
        var maxKeys = (options && options.maxKeys) || 1000;
        var pairs = str.split(sep);
        var limit = pairs.length;
        if (maxKeys > 0 && limit > maxKeys) limit = maxKeys;
        for (var i = 0; i < limit; i++) {
            var pair = pairs[i];
            var idx = pair.indexOf(eq);
            var k, v;
            if (idx >= 0) { k = dec(pair.slice(0, idx)); v = dec(pair.slice(idx + eq.length)); }
            else          { k = dec(pair); v = ''; }
            if (!Object.prototype.hasOwnProperty.call(obj, k)) obj[k] = v;
            else if (Array.isArray(obj[k])) obj[k].push(v);
            else obj[k] = [obj[k], v];
        }
        return obj;
    };

    exports.encode = exports.stringify;
    exports.decode = exports.parse;
});

// ---- state.js ----
// afterburner:state — cross-invocation key/value store. Not part of
// Node's standard surface; lives under the `afterburner:` package
// namespace so it can never collide with a real Node module.
//
// Values are stored as opaque bytes by the host. JS exposes:
//   * get(key)   -> Buffer | null
//   * set(key, value)  (string | Buffer | Uint8Array)
//   * delete(key)
//   * getJSON / setJSON convenience wrappers

__register_module('afterburner:state', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    function ensure(name) {
        var fn = globalThis['__host_state_' + name];
        if (typeof fn !== 'function') {
            throw new Error('afterburner:state.' + name + ' is not available');
        }
        return fn;
    }

    function toBytesB64(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
        if (Buffer.isBuffer(value))    return value.toString('base64');
        if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
        throw new TypeError('state.set: value must be string/Buffer/Uint8Array');
    }

    exports.get = function(key) {
        var raw = ensure('get')(String(key));
        if (raw === null || raw === undefined) return null;
        return Buffer.from(raw, 'base64');
    };

    exports.set = function(key, value) {
        ensure('set')(String(key), toBytesB64(value));
    };

    exports['delete'] = function(key) {
        ensure('delete')(String(key));
    };

    exports.has = function(key) {
        return exports.get(key) !== null;
    };

    // JSON helpers — the most common usage.
    exports.getJSON = function(key) {
        var b = exports.get(key);
        if (b === null) return undefined;
        try { return JSON.parse(b.toString('utf8')); } catch (e) { return undefined; }
    };
    exports.setJSON = function(key, value) {
        exports.set(key, JSON.stringify(value));
    };

    // Numeric helper for counters.
    exports.increment = function(key, delta) {
        var n = exports.getJSON(key);
        if (typeof n !== 'number') n = 0;
        n += (delta === undefined ? 1 : delta);
        exports.setJSON(key, n);
        return n;
    };
});

// ---- stream.js ----
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

// ---- string_decoder.js ----
// string_decoder — minimal StringDecoder with incremental UTF-8 support.
// Falls back to TextDecoder's streaming mode when available; otherwise a
// tiny hand-rolled continuation-byte buffer.

__register_module('string_decoder', function(module, exports, require) {

    function StringDecoder(encoding) {
        this.encoding = (encoding || 'utf8').toLowerCase();
        if (this.encoding !== 'utf8' && this.encoding !== 'utf-8') {
            throw new Error('StringDecoder: only utf8 is supported');
        }
        if (typeof TextDecoder === 'function') {
            this._decoder = new TextDecoder('utf-8', { fatal: false });
            this._native = true;
        } else {
            this._buffered = new Uint8Array(0);
        }
    }

    StringDecoder.prototype.write = function(chunk) {
        if (this._native) return this._decoder.decode(chunk, { stream: true });

        // Fallback: concat any leftover continuation bytes + new chunk,
        // decode complete sequences, stash the remainder.
        var full = new Uint8Array(this._buffered.length + chunk.length);
        full.set(this._buffered);
        full.set(chunk, this._buffered.length);

        // Find the largest prefix that ends on a complete code point.
        var i = full.length;
        while (i > 0) {
            var b = full[i - 1];
            if ((b & 0x80) === 0) break;                          // ASCII
            if ((b & 0xC0) === 0xC0) { i--; break; }              // start byte
            i--;                                                  // continuation
            if (full.length - i >= 4) { i = full.length; break; } // clamp
        }
        this._buffered = full.subarray(i);

        var out = '';
        for (var j = 0; j < i; j++) out += String.fromCharCode(full[j] & 0x7F);
        return out;
    };

    StringDecoder.prototype.end = function(chunk) {
        if (this._native) return this._decoder.decode(chunk || new Uint8Array(), { stream: false });
        var tail = chunk ? this.write(chunk) : '';
        return tail;
    };

    exports.StringDecoder = StringDecoder;
});

// ---- stubs.js ----
// Stub modules that throw a helpful NotSupportedInSandbox error on any
// property access. Registering them means `require('net')` returns an
// object instead of `Cannot find module 'net'` — scripts get a clear
// signal about what's unsupported and why.

(function installStubs() {
    var reasons = {
        net: 'raw TCP sockets',
        tls: 'raw TLS sockets',
        dgram: 'UDP sockets',
        http2: 'HTTP/2 (plain http/https works for outbound requests)',
        cluster: 'multi-process clustering',
        worker_threads: 'additional JavaScript threads',
        inspector: 'Node inspector protocol',
        vm: 'nested VM contexts',
        v8: 'V8-specific APIs',
        readline: 'stdin line reader',
        repl: 'interactive REPL',
        wasi: 'guest WASI access (already inside the sandbox)',
        domain: 'deprecated domain API',
        trace_events: 'trace events',
        async_hooks: 'async hooks (no event loop)',
        perf_hooks: 'perf hooks (see globalThis.performance)',
    };

    Object.keys(reasons).forEach(function(name) {
        var reason = reasons[name];
        __register_module(name, function(module, exports, require) {
            var why = 'Module "' + name + '" is not supported in the Afterburner sandbox: '
                + reason;
            var trap = new Proxy({}, {
                get: function(_t, prop) {
                    if (prop === 'then') return undefined; // don't claim to be a thenable
                    var err = new Error(why + ' (accessed: ' + String(prop) + ')');
                    err.code = 'ERR_NOT_SUPPORTED_IN_SANDBOX';
                    throw err;
                }
            });
            module.exports = trap;
        });
    });
})();

// ---- timers.js ----
// timers — Phase 1 behavior is deliberately conservative.
//
// Afterburner scripts run synchronously: there is no event loop, no
// runtime that can resume the script after a wall-clock delay. We
// therefore:
//   * invoke the callback immediately on `setTimeout(fn, 0)` and
//     `setImmediate(fn)` — the common "defer one tick" idiom keeps
//     working,
//   * throw on non-zero delays and on `setInterval` — scripts relying
//     on actual timing are broken by design in this sandbox and should
//     fail loudly rather than silently hang or produce wrong output.
//
// `clear*` are no-ops (there are no pending timers to clear).

__register_module('timers', function(module, exports, require) {

    function asyncNotSupported(api) {
        return new Error(api + ' with a non-zero delay is not supported in this sandbox');
    }

    function setTimeoutImpl(fn, delay) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        if (!delay || delay <= 0) {
            var args = Array.prototype.slice.call(arguments, 2);
            fn.apply(null, args);
            return { __ab_timer: true, id: 0 };
        }
        throw asyncNotSupported('setTimeout');
    }

    function setImmediateImpl(fn) {
        if (typeof fn !== 'function') throw new TypeError('callback must be a function');
        var args = Array.prototype.slice.call(arguments, 1);
        fn.apply(null, args);
        return { __ab_timer: true, id: 0 };
    }

    function setIntervalImpl() {
        throw asyncNotSupported('setInterval');
    }

    function noop() { /* nothing to clear */ }

    exports.setTimeout = setTimeoutImpl;
    exports.setImmediate = setImmediateImpl;
    exports.setInterval = setIntervalImpl;
    exports.clearTimeout = noop;
    exports.clearImmediate = noop;
    exports.clearInterval = noop;

    // Install as globals so scripts that don't `require('timers')` still
    // see the same behavior.
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = setTimeoutImpl;
    if (typeof globalThis.setImmediate !== 'function') globalThis.setImmediate = setImmediateImpl;
    if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = setIntervalImpl;
    if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = noop;
    if (typeof globalThis.clearImmediate !== 'function') globalThis.clearImmediate = noop;
    if (typeof globalThis.clearInterval !== 'function') globalThis.clearInterval = noop;
});

// ---- url.js ----
// url — legacy API (url.parse / url.format / url.resolve) plus a
// passthrough to the WHATWG `URL` / `URLSearchParams` globals.

__register_module('url', function(module, exports, require) {

    function parse(str, parseQueryString) {
        if (typeof str !== 'string') throw new TypeError('url.parse requires a string');
        var out = {
            protocol: null, slashes: null, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: str
        };

        var rest = str;

        var hashIdx = rest.indexOf('#');
        if (hashIdx >= 0) { out.hash = rest.slice(hashIdx); rest = rest.slice(0, hashIdx); }

        var queryIdx = rest.indexOf('?');
        if (queryIdx >= 0) {
            out.search = rest.slice(queryIdx);
            var q = rest.slice(queryIdx + 1);
            out.query = parseQueryString ? require('querystring').parse(q) : q;
            rest = rest.slice(0, queryIdx);
        }

        var protoMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rest);
        if (protoMatch) {
            out.protocol = protoMatch[0];
            rest = rest.slice(protoMatch[0].length);
        }

        if (rest.slice(0, 2) === '//') {
            out.slashes = true;
            rest = rest.slice(2);
            var slash = rest.indexOf('/');
            var authority = slash < 0 ? rest : rest.slice(0, slash);
            rest = slash < 0 ? '' : rest.slice(slash);
            var at = authority.indexOf('@');
            if (at >= 0) { out.auth = authority.slice(0, at); authority = authority.slice(at + 1); }
            out.host = authority || null;
            var colon = authority.indexOf(':');
            if (colon >= 0) { out.hostname = authority.slice(0, colon); out.port = authority.slice(colon + 1); }
            else { out.hostname = authority || null; }
        }

        out.pathname = rest || null;
        out.path = (out.pathname || '') + (out.search || '') || null;
        return out;
    }

    function format(obj) {
        if (typeof obj === 'string') return obj;
        var out = '';
        if (obj.protocol) {
            out += obj.protocol;
            if (obj.protocol.charAt(obj.protocol.length - 1) !== ':') out += ':';
        }
        if (obj.slashes || obj.host || obj.hostname) {
            out += '//';
            if (obj.auth) out += obj.auth + '@';
            out += obj.host || (obj.hostname + (obj.port ? ':' + obj.port : ''));
        }
        out += obj.pathname || '';
        if (obj.search) out += obj.search;
        else if (obj.query) {
            out += '?' + (typeof obj.query === 'string' ? obj.query : require('querystring').stringify(obj.query));
        }
        if (obj.hash) out += obj.hash;
        return out;
    }

    function resolve(from, to) {
        try {
            return new URL(to, from).href;
        } catch (_) {
            // Degenerate resolve for relative-without-base callers.
            if (to.charAt(0) === '/') {
                var p = parse(from);
                return (p.protocol || '') + (p.slashes ? '//' : '') + (p.host || '') + to;
            }
            return to;
        }
    }

    exports.parse = parse;
    exports.format = format;
    exports.resolve = resolve;

    exports.URL = typeof URL === 'function' ? URL : undefined;
    exports.URLSearchParams = typeof URLSearchParams === 'function' ? URLSearchParams : undefined;
    exports.fileURLToPath = function(u) {
        var s = typeof u === 'string' ? u : String(u);
        return s.replace(/^file:\/\//, '');
    };
    exports.pathToFileURL = function(p) {
        return { href: 'file://' + p };
    };
});

// ---- util.js ----
// util — small subset. `format` and `inspect` cover the >95% case
// (template strings with %s, %d, %j; object -> JSON-like stringification).

__register_module('util', function(module, exports, require) {

    exports.format = function(fmt) {
        if (typeof fmt !== 'string') {
            var parts = [];
            for (var i = 0; i < arguments.length; i++) parts.push(exports.inspect(arguments[i]));
            return parts.join(' ');
        }
        var args = arguments;
        var argIdx = 1;
        var out = '';
        var i = 0;
        while (i < fmt.length) {
            var ch = fmt.charAt(i);
            if (ch !== '%' || i + 1 >= fmt.length) { out += ch; i++; continue; }
            var spec = fmt.charAt(i + 1);
            var val = args[argIdx++];
            if      (spec === 's') out += String(val);
            else if (spec === 'd' || spec === 'i') out += Number(val).toFixed(0);
            else if (spec === 'f') out += Number(val);
            else if (spec === 'j') { try { out += JSON.stringify(val); } catch (_) { out += '[Circular]'; } }
            else if (spec === 'o' || spec === 'O') out += exports.inspect(val);
            else if (spec === '%') { out += '%'; argIdx--; }
            else { out += ch; argIdx--; i++; continue; }
            i += 2;
        }
        while (argIdx < args.length) out += ' ' + exports.inspect(args[argIdx++]);
        return out;
    };

    exports.inspect = function(value, opts) {
        var seen = [];
        function go(v, depth) {
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            var t = typeof v;
            if (t === 'string') return JSON.stringify(v);
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
            if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
            if (t === 'symbol') return v.toString();
            if (seen.indexOf(v) !== -1) return '[Circular]';
            if (depth > 4) return '[Object]';
            seen.push(v);
            try {
                if (Array.isArray(v)) {
                    var items = v.map(function(x) { return go(x, depth + 1); });
                    return '[ ' + items.join(', ') + ' ]';
                }
                if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
                var keys = Object.keys(v);
                var kv = keys.map(function(k) { return k + ': ' + go(v[k], depth + 1); });
                return '{ ' + kv.join(', ') + ' }';
            } finally {
                seen.pop();
            }
        }
        return go(value, 0);
    };

    exports.inherits = function(ctor, superCtor) {
        if (typeof superCtor !== 'function') throw new TypeError('superCtor must be a function');
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
            constructor: { value: ctor, enumerable: false, writable: true, configurable: true }
        });
    };

    exports.promisify = function(fn) {
        return function() {
            var args = Array.prototype.slice.call(arguments);
            var self = this;
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { fn.apply(self, args); } catch (e) { reject(e); }
            });
        };
    };

    exports.callbackify = function(fn) {
        return function() {
            var cb = arguments[arguments.length - 1];
            var rest = Array.prototype.slice.call(arguments, 0, -1);
            Promise.resolve(fn.apply(this, rest))
                .then(function(v) { cb(null, v); })
                .catch(function(e) { cb(e); });
        };
    };

    exports.deprecate = function(fn, _msg) { return fn; };

    exports.types = {
        isDate: function(v)      { return Object.prototype.toString.call(v) === '[object Date]'; },
        isRegExp: function(v)    { return v instanceof RegExp; },
        isPromise: function(v)   { return v && typeof v.then === 'function'; },
        isMap: function(v)       { return v instanceof Map; },
        isSet: function(v)       { return v instanceof Set; },
        isTypedArray: function(v){ return ArrayBuffer.isView(v) && !(v instanceof DataView); },
        isUint8Array: function(v){ return v instanceof Uint8Array; }
    };

    exports.TextEncoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
    exports.TextDecoder = typeof TextDecoder === 'function' ? TextDecoder : undefined;
});

// ---- web_compat.js ----
// Small Web-API polyfills that most Node.js scripts now assume. Wired
// as globals, not modules, to match the browser/Node semantics.

(function installWebCompat() {
    // structuredClone — ES2022. QuickJS-NG typically has it; fall back
    // to a JSON deep-copy so scripts don't blow up if this runtime
    // doesn't.
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = function(value) {
            if (value === undefined) return undefined;
            return JSON.parse(JSON.stringify(value));
        };
    }

    // performance.now — no monotonic clock inside the sandbox, but
    // Date.now gives us something non-decreasing for most practical
    // purposes. Hrtime-style scripts won't crash.
    if (typeof globalThis.performance !== 'object' || typeof globalThis.performance.now !== 'function') {
        globalThis.performance = globalThis.performance || {};
        globalThis.performance.now = function() { return Date.now(); };
    }

    // `queueMicrotask` — schedule a microtask. QuickJS supports
    // Promise.then which gives us the microtask queue for free.
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            Promise.resolve().then(fn);
        };
    }

    // `btoa` / `atob` — base64 encoders. QuickJS doesn't ship these.
    if (typeof globalThis.btoa !== 'function') {
        globalThis.btoa = function(str) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(str), 'binary').toString('base64');
        };
    }
    if (typeof globalThis.atob !== 'function') {
        globalThis.atob = function(b64) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(b64), 'base64').toString('binary');
        };
    }
})();

// ---- zlib.js ----
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

    exports.deflateSync  = function(input) { return call('deflate_sync', input);  };
    exports.inflateSync  = function(input) { return call('inflate_sync', input);  };
    exports.gzipSync     = function(input) { return call('gzip_sync',    input);  };
    exports.gunzipSync   = function(input) { return call('gunzip_sync',  input);  };

    // Promise wrappers — handy, free, no actual async under the hood.
    function asPromise(fn) {
        return function(input) {
            return new Promise(function(resolve, reject) {
                try { resolve(fn(input)); } catch (e) { reject(e); }
            });
        };
    }
    exports.deflate = asPromise(exports.deflateSync);
    exports.inflate = asPromise(exports.inflateSync);
    exports.gzip    = asPromise(exports.gzipSync);
    exports.gunzip  = asPromise(exports.gunzipSync);
});


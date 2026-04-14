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

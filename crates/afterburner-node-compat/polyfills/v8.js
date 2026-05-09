// v8 — Node 20's V8 introspection API. We don't run V8 (we run
// QuickJS-in-WASM), but the surface is what real apps reach for —
// returning sane stub data keeps the integration layer working.

__register_module('v8', function(module, exports, require) {

    var Buffer = require('buffer').Buffer;

    function getHeapStatistics() {
        // Sandbox: no V8 heap. Report a memory snapshot bounded by
        // the WASM memory limit (configured via the FuelGauge but
        // not introspectable from JS today). Numbers are intentionally
        // round so callers parsing them as informational don't see
        // bogus precision.
        return {
            total_heap_size: 32 * 1024 * 1024,
            total_heap_size_executable: 0,
            total_physical_size: 32 * 1024 * 1024,
            total_available_size: 256 * 1024 * 1024,
            used_heap_size: 16 * 1024 * 1024,
            heap_size_limit: 256 * 1024 * 1024,
            malloced_memory: 0,
            peak_malloced_memory: 0,
            does_zap_garbage: 0,
            number_of_native_contexts: 1,
            number_of_detached_contexts: 0,
            total_global_handles_size: 0,
            used_global_handles_size: 0,
            external_memory: 0,
        };
    }

    function getHeapSpaceStatistics() {
        return [
            {
                space_name: 'new_space',
                space_size: 8 * 1024 * 1024,
                space_used_size: 1 * 1024 * 1024,
                space_available_size: 7 * 1024 * 1024,
                physical_space_size: 8 * 1024 * 1024,
            },
            {
                space_name: 'old_space',
                space_size: 24 * 1024 * 1024,
                space_used_size: 15 * 1024 * 1024,
                space_available_size: 9 * 1024 * 1024,
                physical_space_size: 24 * 1024 * 1024,
            },
        ];
    }

    function getHeapCodeStatistics() {
        return {
            code_and_metadata_size: 0,
            bytecode_and_metadata_size: 0,
            external_script_source_size: 0,
        };
    }

    function getHeapSnapshot() {
        // Real Node returns a Readable stream of a JSON heap dump.
        // We give callers an empty one shaped like Node's so they
        // can pipe it without crashing.
        var EventEmitter = require('events').EventEmitter;
        var stream = new EventEmitter();
        var emptyDump = '{"snapshot":{"meta":{},"node_count":0,"edge_count":0},"nodes":[],"edges":[],"strings":[]}';
        stream.read = function() { return Buffer.from(emptyDump); };
        stream.pipe = function(dest) { dest.end(emptyDump); return dest; };
        Promise.resolve().then(function() {
            stream.emit('data', Buffer.from(emptyDump));
            stream.emit('end');
        });
        return stream;
    }

    function writeHeapSnapshot(filename) {
        var fs = require('fs');
        var emptyDump = '{"snapshot":{"meta":{},"node_count":0,"edge_count":0},"nodes":[],"edges":[],"strings":[]}';
        var path = filename || ('Heap.' + Date.now() + '.heapsnapshot');
        fs.writeFileSync(path, emptyDump);
        return path;
    }

    // ---- Serialization (v8.serialize / deserialize) ---------------
    //
    // Real V8 wire format — Node's `v8.serialize` output is byte-
    // compatible with what `value-serializer.cc` produces. The host
    // implements the encoder/decoder; the JS side walks JS values into
    // a typed JSON tree (the same `V8Value` enum on both sides) and
    // base64-encodes binary chunks.

    // ABV (ArrayBufferView) sub-tags from V8 source.
    var ABV = {
        Int8Array: 0x62, Uint8Array: 0x42, Uint8ClampedArray: 0x43,
        Int16Array: 0x77, Uint16Array: 0x57,
        Int32Array: 0x64, Uint32Array: 0x44,
        Float32Array: 0x66, Float64Array: 0x46,
        BigInt64Array: 0x71, BigUint64Array: 0x51,
        DataView: 0x3F,
    };

    function _bytesToBase64(u8) {
        return Buffer.from(u8).toString('base64');
    }
    function _base64ToBytes(b64) {
        return new Uint8Array(Buffer.from(b64, 'base64'));
    }

    /// Convert a JS value into the typed tree the host expects.
    /// Cycles aren't fully spec'd here — we detect and reject; real
    /// Node's structured-clone supports cycles via the reference
    /// table, which is forthcoming.
    function _jsToTree(v, seen) {
        if (v === undefined) return { t: 'u' };
        if (v === null) return { t: 'n' };
        var ty = typeof v;
        if (ty === 'boolean') return { t: 'b', v: v };
        if (ty === 'number') {
            if (Number.isFinite(v) && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
                return { t: 'i', v: v };
            }
            if (!Number.isFinite(v)) {
                if (Number.isNaN(v)) return { t: 'd', v: 'NaN' };
                return { t: 'd', v: v > 0 ? 'Infinity' : '-Infinity' };
            }
            return { t: 'd', v: v };
        }
        if (ty === 'string') return { t: 's', v: v };
        if (ty === 'bigint') {
            // 8-byte little-endian digit chunks per V8. Encode as hex.
            var neg = v < 0n;
            var abs = neg ? -v : v;
            var hex = abs.toString(16);
            if (hex.length % 2 !== 0) hex = '0' + hex;
            // V8 stores LE; reverse byte order from BE hex.
            var bytes = [];
            for (var i = 0; i < hex.length; i += 2) {
                bytes.unshift(hex.substr(i, 2));
            }
            return { t: 'Z', n: neg, d: bytes.join('') };
        }
        if (seen.has(v)) {
            throw new Error('v8.serialize: cyclic reference (object-table not yet wired)');
        }
        seen.add(v);
        if (v instanceof Date) return { t: 'D', v: v.getTime() };
        if (v instanceof RegExp) {
            var f = 0;
            if (v.global) f |= 1;
            if (v.ignoreCase) f |= 2;
            if (v.multiline) f |= 4;
            if (v.sticky) f |= 8;
            if (v.unicode) f |= 16;
            if (v.dotAll) f |= 32;
            return { t: 'R', p: v.source, f: f };
        }
        if (v instanceof Map) {
            var ents = [];
            v.forEach(function(val, key) {
                ents.push([_jsToTree(key, seen), _jsToTree(val, seen)]);
            });
            return { t: 'm', e: ents };
        }
        if (v instanceof Set) {
            var items = [];
            v.forEach(function(item) { items.push(_jsToTree(item, seen)); });
            return { t: 'e', v: items };
        }
        if (v instanceof Error) {
            var kind = 0x45; // generic Error 'E'
            if (v instanceof TypeError) kind = 0x54;
            else if (v instanceof RangeError) kind = 0x52;
            else if (v instanceof ReferenceError) kind = 0x46;
            else if (v instanceof SyntaxError) kind = 0x53;
            else if (v instanceof URIError) kind = 0x55;
            else if (v instanceof EvalError) kind = 0x56;
            var out = { t: 'E', k: kind };
            if (typeof v.message === 'string') out.m = v.message;
            if (typeof v.stack === 'string') out.s = v.stack;
            return out;
        }
        if (v instanceof ArrayBuffer) {
            return { t: 'B', v: _bytesToBase64(new Uint8Array(v)) };
        }
        if (ArrayBuffer.isView(v)) {
            var ctorName = v.constructor && v.constructor.name;
            var k = ABV[ctorName];
            if (k == null) throw new Error('v8.serialize: unknown TypedArray ' + ctorName);
            return {
                t: 'V', k: k,
                b: _bytesToBase64(new Uint8Array(v.buffer)),
                o: v.byteOffset,
                l: v.byteLength,
            };
        }
        if (Array.isArray(v)) {
            // Detect sparse arrays (length larger than enumerable keys).
            var keys = Object.keys(v);
            if (keys.length === v.length && keys.every(function(k, i) { return Number(k) === i; })) {
                return { t: 'a', v: v.map(function(x) { return _jsToTree(x, seen); }) };
            }
            // Sparse path.
            var ent = [];
            for (var i = 0; i < keys.length; i++) {
                var idx = Number(keys[i]);
                ent.push([idx, _jsToTree(v[idx], seen)]);
            }
            return { t: 'S', l: v.length, e: ent };
        }
        // Plain object.
        var props = Object.keys(v);
        var oent = [];
        for (var i = 0; i < props.length; i++) {
            oent.push([String(props[i]), _jsToTree(v[props[i]], seen)]);
        }
        return { t: 'o', e: oent };
    }

    /// Reverse: turn the host's JSON tree back into JS values.
    function _treeToJs(node) {
        if (!node || typeof node !== 'object') return node;
        switch (node.t) {
            case 'u': return undefined;
            case 'n': return null;
            case 'b': return !!node.v;
            case 'i': case 'U': return node.v | 0;
            case 'd':
                if (typeof node.v === 'string') {
                    if (node.v === 'Infinity') return Infinity;
                    if (node.v === '-Infinity') return -Infinity;
                    if (node.v === 'NaN') return NaN;
                    return Number(node.v);
                }
                return node.v;
            case 's': return String(node.v);
            case 'D': return new Date(node.v);
            case 'R': {
                var f = node.f | 0;
                var s = '';
                if (f & 1) s += 'g';
                if (f & 2) s += 'i';
                if (f & 4) s += 'm';
                if (f & 8) s += 'y';
                if (f & 16) s += 'u';
                if (f & 32) s += 's';
                return new RegExp(node.p, s);
            }
            case 'o': {
                var o = {};
                var e = node.e || [];
                for (var i = 0; i < e.length; i++) o[e[i][0]] = _treeToJs(e[i][1]);
                return o;
            }
            case 'a': return (node.v || []).map(_treeToJs);
            case 'S': {
                var arr = new Array(node.l | 0);
                var ent = node.e || [];
                for (var i = 0; i < ent.length; i++) arr[ent[i][0]] = _treeToJs(ent[i][1]);
                return arr;
            }
            case 'm': {
                var m = new Map();
                var es = node.e || [];
                for (var i = 0; i < es.length; i++) m.set(_treeToJs(es[i][0]), _treeToJs(es[i][1]));
                return m;
            }
            case 'e': {
                var st = new Set();
                var v = node.v || [];
                for (var i = 0; i < v.length; i++) st.add(_treeToJs(v[i]));
                return st;
            }
            case 'B': return _base64ToBytes(node.v).buffer;
            case 'V': {
                var buf = _base64ToBytes(node.b).buffer;
                var Ctor = _abvCtor(node.k);
                var elementSize = Ctor.BYTES_PER_ELEMENT || 1;
                return new Ctor(buf, node.o | 0, (node.l | 0) / elementSize);
            }
            case 'E': {
                var ErrCtor = Error;
                if (node.k === 0x54) ErrCtor = TypeError;
                else if (node.k === 0x52) ErrCtor = RangeError;
                else if (node.k === 0x46) ErrCtor = ReferenceError;
                else if (node.k === 0x53) ErrCtor = SyntaxError;
                else if (node.k === 0x55) ErrCtor = URIError;
                else if (node.k === 0x56) ErrCtor = EvalError;
                var err = new ErrCtor(node.m || '');
                if (node.s) try { err.stack = node.s; } catch (_) {}
                return err;
            }
            case 'Z': {
                // Reverse hex bytes (LE in V8) into a BE BigInt.
                var d = String(node.d || '');
                if (!d) return 0n;
                var rev = '';
                for (var i = d.length - 2; i >= 0; i -= 2) rev += d.substr(i, 2);
                var n = BigInt('0x' + rev);
                return node.n ? -n : n;
            }
            default:
                throw new Error('v8.deserialize: unknown tree tag ' + node.t);
        }
    }
    function _abvCtor(kind) {
        switch (kind) {
            case 0x62: return Int8Array;
            case 0x42: return Uint8Array;
            case 0x43: return Uint8ClampedArray;
            case 0x77: return Int16Array;
            case 0x57: return Uint16Array;
            case 0x64: return Int32Array;
            case 0x44: return Uint32Array;
            case 0x66: return Float32Array;
            case 0x46: return Float64Array;
            case 0x71: return BigInt64Array;
            case 0x51: return BigUint64Array;
            case 0x3F: return DataView;
            default: throw new Error('v8.deserialize: unknown ABV kind ' + kind);
        }
    }

    function serialize(value) {
        if (typeof globalThis.__host_v8_serialize !== 'function') {
            throw new Error('v8.serialize: host fn missing');
        }
        var tree = _jsToTree(value, new Set());
        var b64 = globalThis.__host_v8_serialize(JSON.stringify(tree));
        if (typeof b64 === 'string' && b64.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(b64.slice('__HOST_ERR__:'.length));
        }
        return Buffer.from(b64, 'base64');
    }

    function deserialize(buf) {
        if (typeof globalThis.__host_v8_deserialize !== 'function') {
            throw new Error('v8.deserialize: host fn missing');
        }
        var bytes;
        if (Buffer.isBuffer(buf)) bytes = buf;
        else if (buf instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(buf));
        else if (buf instanceof Uint8Array) bytes = Buffer.from(buf);
        else throw new TypeError('v8.deserialize: argument must be a Buffer / Uint8Array / ArrayBuffer');
        var b64 = bytes.toString('base64');
        var json = globalThis.__host_v8_deserialize(b64);
        if (typeof json === 'string' && json.indexOf('__HOST_ERR__:') === 0) {
            throw new Error(json.slice('__HOST_ERR__:'.length));
        }
        return _treeToJs(JSON.parse(json));
    }

    function Serializer() {
        this._values = [];
    }
    Serializer.prototype.writeHeader = function() {};
    Serializer.prototype.writeValue = function(v) { this._values.push(v); };
    Serializer.prototype.releaseBuffer = function() {
        return serialize(this._values.length === 1 ? this._values[0] : this._values);
    };
    Serializer.prototype.transferArrayBuffer = function() {};

    function Deserializer(buf) {
        this._cursor = 0;
        this._values = [];
        try {
            var v = deserialize(buf);
            this._values = Array.isArray(v) ? v : [v];
        } catch (_) { /* invalid input → empty values */ }
    }
    Deserializer.prototype.readHeader = function() { return true; };
    Deserializer.prototype.readValue = function() {
        return this._values[this._cursor++];
    };
    Deserializer.prototype.transferArrayBuffer = function() {};

    function setFlagsFromString(_flags) {
        // V8 flag tweaks are V8-specific; ignored.
    }
    function getStringEnvironment() {
        return [];
    }

    exports.cachedDataVersionTag = function() { return 0; };
    exports.getHeapStatistics = getHeapStatistics;
    exports.getHeapSpaceStatistics = getHeapSpaceStatistics;
    exports.getHeapCodeStatistics = getHeapCodeStatistics;
    exports.getHeapSnapshot = getHeapSnapshot;
    exports.writeHeapSnapshot = writeHeapSnapshot;
    exports.setFlagsFromString = setFlagsFromString;
    exports.getStringEnvironment = getStringEnvironment;
    exports.serialize = serialize;
    exports.deserialize = deserialize;
    exports.Serializer = Serializer;
    exports.Deserializer = Deserializer;
    exports.DefaultSerializer = Serializer;
    exports.DefaultDeserializer = Deserializer;
    exports.startupSnapshot = {
        addDeserializeCallback: function() {},
        addSerializeCallback: function() {},
        setDeserializeMainFunction: function() {},
        isBuildingSnapshot: function() { return false; },
    };
    exports.promiseHooks = {
        onInit: function() { return function() {}; },
        onSettled: function() { return function() {}; },
        onBefore: function() { return function() {}; },
        onAfter: function() { return function() {}; },
        createHook: function() { return { disable: function() {} }; },
    };
});

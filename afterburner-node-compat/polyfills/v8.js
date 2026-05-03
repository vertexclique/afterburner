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
    // Node uses V8's structured-clone format. We don't have access
    // to it from QuickJS; serialize → JSON-encoded Buffer is a
    // reasonable replacement that round-trips for plain values.
    // Functions and class instances aren't preserved, matching
    // Node's behaviour for non-cloneable values.

    function serialize(value) {
        var json = JSON.stringify(value);
        return Buffer.from(json || 'null', 'utf8');
    }

    function deserialize(buf) {
        var s;
        if (Buffer.isBuffer(buf)) s = buf.toString('utf8');
        else if (buf instanceof Uint8Array) s = Buffer.from(buf).toString('utf8');
        else throw new TypeError('v8.deserialize: argument must be a Buffer or Uint8Array');
        return JSON.parse(s);
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

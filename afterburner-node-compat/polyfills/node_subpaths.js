// Node exposes several "X/promises" paths (and other sub-module
// shapes) as separate require targets. They're thin re-exports of a
// property on the parent module. Registering them here — in a file
// that lexically sorts after the parents — lets `require('node:fs/promises')`
// behave exactly like `require('fs').promises`, matching Node so
// drop-in scripts don't trip on the difference.

// fs/promises → re-export of fs.promises (set in fs.js).
__register_module('fs/promises', function(module, exports, require) {
    module.exports = require('fs').promises;
});

// dns/promises → re-export of dns.promises (set in dns.js).
__register_module('dns/promises', function(module, exports, require) {
    module.exports = require('dns').promises;
});

// stream/promises — Node exposes Promise-returning versions of
// `pipeline` and `finished`. The core `stream` module's sync-callback
// versions are in stream.js; we wrap them here.
__register_module('stream/promises', function(module, exports, require) {
    var stream = require('stream');
    module.exports = {
        pipeline: function() {
            var args = [].slice.call(arguments);
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { stream.pipeline.apply(null, args); } catch (e) { reject(e); }
            });
        },
        finished: function(s, opts) {
            return new Promise(function(resolve, reject) {
                stream.finished(s, opts || {}, function(err) {
                    err ? reject(err) : resolve();
                });
            });
        },
    };
});

// timers/promises — Node exposes Promise-returning delays.
// `setInterval` is documented as an async iterator; we stub it with a
// clear "not implemented" error until a consumer surfaces a need.
// util/types — Node 20's `is*` type-guard helpers. Most production
// code uses these for fast type checks (`util.types.isUint8Array`,
// `isPromise`, `isProxy`, etc.). The pure-JS implementations below
// don't need host-side support.
__register_module('util/types', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    function isPromise(v) {
        return !!v && (typeof v === 'object' || typeof v === 'function')
            && typeof v.then === 'function';
    }

    function isAnyArrayBuffer(v) {
        return v instanceof ArrayBuffer ||
            (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
    }

    function isTypedArray(v) {
        return ArrayBuffer.isView(v) && !(v instanceof DataView);
    }

    function makeTypedCheck(ctor) {
        return function(v) {
            return typeof ctor !== 'undefined' && v instanceof ctor;
        };
    }

    module.exports = {
        isPromise: isPromise,
        isAnyArrayBuffer: isAnyArrayBuffer,
        isArrayBuffer: function(v) { return v instanceof ArrayBuffer; },
        isSharedArrayBuffer: function(v) {
            return typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer;
        },
        isAsyncFunction: function(v) {
            // QuickJS's `AsyncFunction` constructor isn't a global;
            // fall back to the toString tag, which marks async fns
            // distinctively in any spec-compliant engine.
            return typeof v === 'function' &&
                Object.prototype.toString.call(v) === '[object AsyncFunction]';
        },
        isGeneratorFunction: function(v) {
            return typeof v === 'function' &&
                Object.prototype.toString.call(v) === '[object GeneratorFunction]';
        },
        isGeneratorObject: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Generator]';
        },
        isMap: function(v) { return v instanceof Map; },
        isSet: function(v) { return v instanceof Set; },
        isMapIterator: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Map Iterator]';
        },
        isSetIterator: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Set Iterator]';
        },
        isWeakMap: function(v) { return v instanceof WeakMap; },
        isWeakSet: function(v) { return v instanceof WeakSet; },
        isPromise: isPromise,
        isProxy: function() { return false; }, // Proxies are transparent — can't detect from JS
        isRegExp: function(v) { return v instanceof RegExp; },
        isDate: function(v) { return v instanceof Date; },
        isError: function(v) { return v instanceof Error; },
        isSymbol: function(v) { return typeof v === 'symbol'; },
        isStringObject: function(v) { return typeof v === 'object' && v instanceof String; },
        isNumberObject: function(v) { return typeof v === 'object' && v instanceof Number; },
        isBooleanObject: function(v) { return typeof v === 'object' && v instanceof Boolean; },
        isBigIntObject: function(v) {
            return typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object BigInt]';
        },
        isBoxedPrimitive: function(v) {
            return v instanceof String || v instanceof Number || v instanceof Boolean ||
                (typeof v === 'object' && Object.prototype.toString.call(v) === '[object BigInt]');
        },
        isModuleNamespaceObject: function() { return false; },
        isExternal: function() { return false; },
        isArgumentsObject: function(v) {
            return !!v && Object.prototype.toString.call(v) === '[object Arguments]';
        },
        isArrayBufferView: function(v) { return ArrayBuffer.isView(v); },
        isDataView: function(v) { return v instanceof DataView; },
        isTypedArray: isTypedArray,
        isUint8Array: function(v) { return v instanceof Uint8Array; },
        isUint8ClampedArray: makeTypedCheck(typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : null),
        isUint16Array: function(v) { return v instanceof Uint16Array; },
        isUint32Array: function(v) { return v instanceof Uint32Array; },
        isInt8Array: function(v) { return v instanceof Int8Array; },
        isInt16Array: function(v) { return v instanceof Int16Array; },
        isInt32Array: function(v) { return v instanceof Int32Array; },
        isFloat32Array: function(v) { return v instanceof Float32Array; },
        isFloat64Array: function(v) { return v instanceof Float64Array; },
        isBigInt64Array: makeTypedCheck(typeof BigInt64Array !== 'undefined' ? BigInt64Array : null),
        isBigUint64Array: makeTypedCheck(typeof BigUint64Array !== 'undefined' ? BigUint64Array : null),
        isNativeError: function(v) { return v instanceof Error; },
        isKeyObject: function() { return false; },
        isCryptoKey: function() { return false; },
    };
});

// stream/web — Node 20's WHATWG streams (ReadableStream, WritableStream,
// TransformStream). QuickJS has the spec types as globals; we just
// re-export them under the Node module path so `import { ReadableStream }
// from 'stream/web'` works.
__register_module('stream/web', function(module, exports, require) {
    function notSupported(name) {
        return function() {
            throw new Error('stream/web.' + name + ' is not available in burn yet');
        };
    }
    module.exports = {
        ReadableStream: typeof ReadableStream !== 'undefined' ? ReadableStream : notSupported('ReadableStream'),
        ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader !== 'undefined' ? ReadableStreamDefaultReader : notSupported('ReadableStreamDefaultReader'),
        ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader !== 'undefined' ? ReadableStreamBYOBReader : notSupported('ReadableStreamBYOBReader'),
        WritableStream: typeof WritableStream !== 'undefined' ? WritableStream : notSupported('WritableStream'),
        WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter !== 'undefined' ? WritableStreamDefaultWriter : notSupported('WritableStreamDefaultWriter'),
        TransformStream: typeof TransformStream !== 'undefined' ? TransformStream : notSupported('TransformStream'),
        ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy !== 'undefined' ? ByteLengthQueuingStrategy : notSupported('ByteLengthQueuingStrategy'),
        CountQueuingStrategy: typeof CountQueuingStrategy !== 'undefined' ? CountQueuingStrategy : notSupported('CountQueuingStrategy'),
        TextEncoderStream: typeof TextEncoderStream !== 'undefined' ? TextEncoderStream : notSupported('TextEncoderStream'),
        TextDecoderStream: typeof TextDecoderStream !== 'undefined' ? TextDecoderStream : notSupported('TextDecoderStream'),
        CompressionStream: typeof CompressionStream !== 'undefined' ? CompressionStream : notSupported('CompressionStream'),
        DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : notSupported('DecompressionStream'),
    };
});

// constants — Node 20 exposes a flat namespace of POSIX-ish numeric
// constants (errno values, file modes, etc.) under `require('constants')`.
// Most callers grab a single value (`require('constants').O_RDONLY`),
// so a shallow flat object is enough.
__register_module('constants', function(module, exports, require) {
    var fs = require('fs');
    var os = require('os');
    var crypto = require('crypto');
    var c = {};
    if (fs && fs.constants) Object.assign(c, fs.constants);
    if (os && os.constants) {
        if (os.constants.errno) Object.assign(c, os.constants.errno);
        if (os.constants.signals) Object.assign(c, os.constants.signals);
    }
    if (crypto && crypto.constants) Object.assign(c, crypto.constants);
    module.exports = c;
});

// sys — historical alias for `util` (deprecated in Node 0.x but
// still imported by some older libraries that haven't been touched
// since). Identical surface to `util`.
__register_module('sys', function(module, exports, require) {
    module.exports = require('util');
});

// path/posix and path/win32 — Node exposes POSIX and Win32 path
// implementations as separate require targets in addition to
// `path.posix` / `path.win32`.
__register_module('path/posix', function(module, exports, require) {
    module.exports = require('path').posix || require('path');
});
__register_module('path/win32', function(module, exports, require) {
    module.exports = require('path').win32 || require('path');
});

__register_module('timers/promises', function(module, exports, require) {
    module.exports = {
        setTimeout: function(ms, value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                var t = setTimeout(function() { resolve(value); }, ms);
                if (signal) {
                    signal.addEventListener('abort', function() {
                        clearTimeout(t);
                        reject(new Error('The operation was aborted'));
                    });
                }
            });
        },
        setImmediate: function(value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                setImmediate(function() { resolve(value); });
            });
        },
        // AsyncIterator surface for `setInterval(ms)` lands with
        // a consumer. Throw until then so scripts that reach for
        // it see a clear error rather than silently hanging.
        setInterval: function() {
            throw new Error('timers/promises.setInterval (async iterator) is not implemented');
        },
    };
});

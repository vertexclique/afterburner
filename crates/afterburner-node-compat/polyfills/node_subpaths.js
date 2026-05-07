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

// readline/promises — Promise-returning Readline. Node 17+. Wraps
// the callback Interface; we expose `question` returning a Promise.
__register_module('readline/promises', function(module, exports, require) {
    var rl = require('readline');
    function createInterface(opts) {
        var iface = rl.createInterface(opts);
        var origQuestion = iface.question.bind(iface);
        iface.question = function(prompt, options) {
            options = options || {};
            return new Promise(function(resolve, reject) {
                if (options.signal && options.signal.aborted) {
                    return reject(new Error('aborted'));
                }
                origQuestion(prompt, function(answer) { resolve(answer); });
                if (options.signal) {
                    options.signal.addEventListener('abort', function() {
                        reject(new Error('aborted'));
                    });
                }
            });
        };
        return iface;
    }
    module.exports = Object.assign({}, rl, {
        createInterface: createInterface,
        Interface: rl.Interface,
    });
});

// inspector/promises — Node 19+. The Session class with promise-style
// `post` / `connect`. We expose the same shape but every call rejects
// with ERR_NOT_SUPPORTED_IN_SANDBOX — V8's inspector requires direct
// engine access we cannot provide through wasm.
__register_module('inspector/promises', function(module, exports, require) {
    var inspector = require('inspector');
    function rej(name) {
        return Promise.reject(Object.assign(
            new Error('inspector.' + name + ' not available in sandbox'),
            { code: 'ERR_NOT_SUPPORTED_IN_SANDBOX' }
        ));
    }
    function Session() { inspector.Session.call(this); }
    Session.prototype = Object.create(inspector.Session.prototype || Object.prototype);
    Session.prototype.connect = function() { return rej('connect'); };
    Session.prototype.connectToMainThread = function() { return rej('connectToMainThread'); };
    Session.prototype.disconnect = function() { return Promise.resolve(); };
    Session.prototype.post = function() { return rej('post'); };
    module.exports = Object.assign({}, inspector, { Session: Session });
});

// stream/consumers — Node 16.7+. Async helpers that drain a readable
// stream and return its full contents. Implementation collects every
// chunk via async-iteration and concatenates Buffer/Uint8Array bytes
// or string segments.
__register_module('stream/consumers', function(module, exports, require) {
    function collect(stream) {
        return (async function() {
            var chunks = [];
            for await (var chunk of stream) chunks.push(chunk);
            if (chunks.length === 0) {
                var Buf0 = globalThis.Buffer;
                return Buf0 ? Buf0.alloc(0) : new Uint8Array(0);
            }
            var Buf = globalThis.Buffer;
            if (Buf && Buf.isBuffer && Buf.isBuffer(chunks[0])) return Buf.concat(chunks);
            if (chunks[0] instanceof Uint8Array) {
                var total = 0;
                for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
                var out = new Uint8Array(total);
                var off = 0;
                for (var j = 0; j < chunks.length; j++) {
                    out.set(chunks[j], off); off += chunks[j].length;
                }
                return out;
            }
            return chunks.map(String).join('');
        })();
    }
    module.exports = {
        text: function(stream) {
            return collect(stream).then(function(b) {
                if (typeof b === 'string') return b;
                if (globalThis.Buffer && globalThis.Buffer.isBuffer && globalThis.Buffer.isBuffer(b))
                    return b.toString('utf8');
                return new globalThis.TextDecoder().decode(b);
            });
        },
        json: function(stream) {
            return module.exports.text(stream).then(JSON.parse);
        },
        arrayBuffer: function(stream) {
            return collect(stream).then(function(b) {
                if (b instanceof Uint8Array)
                    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
                if (typeof b === 'string')
                    return new globalThis.TextEncoder().encode(b).buffer;
                return new ArrayBuffer(0);
            });
        },
        buffer: function(stream) {
            return collect(stream).then(function(b) {
                var Buf = globalThis.Buffer;
                if (Buf && Buf.isBuffer && Buf.isBuffer(b)) return b;
                if (b instanceof Uint8Array) return Buf ? Buf.from(b) : b;
                return Buf ? Buf.from(String(b), 'utf8')
                           : new globalThis.TextEncoder().encode(b);
            });
        },
        blob: function(stream) {
            return collect(stream).then(function(b) {
                return new globalThis.Blob([b]);
            });
        },
    };
});

// diagnostics_channel — Node 16+. Pub/sub for in-process tracing.
// Same-realm impl: channels keyed by name on a global registry,
// `publish` broadcasts to every subscriber synchronously (matches
// Node's contract — async work belongs in subscribers if needed).
__register_module('diagnostics_channel', function(module, exports, require) {
    if (!globalThis.__plenum_diag_channels) globalThis.__plenum_diag_channels = {};
    var registry = globalThis.__plenum_diag_channels;

    function Channel(name) {
        this.name = name;
        this._subs = [];
    }
    Channel.prototype.publish = function(message) {
        for (var i = 0; i < this._subs.length; i++) {
            try { this._subs[i](message, this.name); }
            catch (_) { /* spec: swallow per subscriber */ }
        }
    };
    Channel.prototype.subscribe = function(onMessage) {
        if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');
        this._subs.push(onMessage);
    };
    Channel.prototype.unsubscribe = function(onMessage) {
        var i = this._subs.indexOf(onMessage);
        if (i === -1) return false;
        this._subs.splice(i, 1);
        return true;
    };
    Object.defineProperty(Channel.prototype, 'hasSubscribers', {
        get: function() { return this._subs.length > 0; },
    });
    Channel.prototype.bindStore = function() {};
    Channel.prototype.runStores = function(_data, fn, ctx) { return fn.call(ctx); };

    function channel(name) {
        var n = String(name);
        if (!registry[n]) registry[n] = new Channel(n);
        return registry[n];
    }
    function subscribe(name, onMessage) { channel(name).subscribe(onMessage); }
    function unsubscribe(name, onMessage) { return channel(name).unsubscribe(onMessage); }
    function hasSubscribers(name) { return channel(name).hasSubscribers; }

    function tracingChannel(prefix) {
        var p = (typeof prefix === 'string') ? prefix : 'tracing';
        return {
            start: channel(p + ':start'),
            end: channel(p + ':end'),
            asyncStart: channel(p + ':asyncStart'),
            asyncEnd: channel(p + ':asyncEnd'),
            error: channel(p + ':error'),
            traceSync: function(fn, ctx, _store, _thisArg, args) {
                this.start.publish({ self: ctx, args: args });
                try {
                    var r = fn.apply(ctx, args || []);
                    this.end.publish({ self: ctx, result: r });
                    return r;
                } catch (e) {
                    this.error.publish({ self: ctx, error: e });
                    throw e;
                }
            },
        };
    }

    module.exports = {
        Channel: Channel,
        channel: channel,
        subscribe: subscribe,
        unsubscribe: unsubscribe,
        hasSubscribers: hasSubscribers,
        tracingChannel: tracingChannel,
    };
});

// node:test / node:test/reporters — Node 18+ built-in test runner.
// Sandbox can't host the runner's child-process worker pool; we
// expose the API surface so libraries that conditionally import
// `node:test` for in-source tests don't crash. Minimal recorder
// runs synchronously in-process.
__register_module('test', function(module, exports, require) {
    var current = null;
    function describe(name, fn) {
        var prev = current;
        current = { name: name, children: [] };
        try { if (typeof fn === 'function') fn(); } finally { current = prev; }
    }
    function it(name, fn) {
        if (current) current.children.push({ name: name, fn: fn });
    }
    function test() {
        var args = [].slice.call(arguments);
        var name = (typeof args[0] === 'string') ? args.shift() : '<anonymous>';
        if (args[0] && typeof args[0] === 'object') args.shift();
        var fn = args[0];
        return Promise.resolve().then(function() {
            if (typeof fn === 'function') return fn({ name: name });
        });
    }
    test.describe = describe;
    test.it = it;
    test.test = test;
    test.suite = describe;
    test.before = function() {};
    test.after = function() {};
    test.beforeEach = function() {};
    test.afterEach = function() {};
    test.skip = function() {};
    test.todo = function() {};
    test.run = function() {
        return { [Symbol.asyncIterator]: function() {
            return { next: function() { return Promise.resolve({ value: undefined, done: true }); } };
        } };
    };
    test.mock = {
        method: function() {}, getter: function() {}, setter: function() {},
        timers: { enable: function() {}, reset: function() {}, tick: function() {} },
    };
    module.exports = test;
});
__register_module('test/reporters', function(module, exports, require) {
    var stream = require('stream');
    function makeReporter() {
        return new stream.Transform({
            transform: function(chunk, _enc, cb) { cb(null, chunk); },
        });
    }
    module.exports = {
        spec: makeReporter, tap: makeReporter, dot: makeReporter,
        junit: makeReporter, lcov: makeReporter,
    };
});

// sea (Single Executable Applications) — Node 21+. The sandbox is a
// sealed runtime, so SEA assets aren't applicable. Surface the API
// but report `isSea() === false` so callers fall through to their
// non-SEA path.
__register_module('sea', function(module, exports, require) {
    function notInSea(name) {
        return function() {
            throw Object.assign(
                new Error('sea.' + name + ': not running as SEA'),
                { code: 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION' }
            );
        };
    }
    module.exports = {
        isSea: function() { return false; },
        getAsset: notInSea('getAsset'),
        getAssetAsBlob: notInSea('getAssetAsBlob'),
        getRawAsset: notInSea('getRawAsset'),
    };
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

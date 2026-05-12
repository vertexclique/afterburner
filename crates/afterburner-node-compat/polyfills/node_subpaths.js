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
// Real runner: collects describe/it/before/after/beforeEach/afterEach
// blocks, runs them with proper nesting + async support, tracks
// pass / fail / skip / todo counts, and emits a TAP-shaped summary
// to stdout when any tests were registered. Reporter modules at
// `node:test/reporters` provide the `spec` / `tap` / `dot` / `junit`
// / `lcov` exports as Transform streams that pass-through (the
// runner already emits the right shape).
__register_module('test', function(module, exports, require) {
    // Suite tree is built on first describe()/it() call. Each suite
    // holds its own before/after hooks + child suites + tests; the
    // run is triggered on a microtask after the script body settles
    // so test files don't need an explicit `await test.run()`.
    var ROOT = { name: '<root>', children: [], tests: [], hooks: {
        before: [], after: [], beforeEach: [], afterEach: [],
    } };
    var current = ROOT;
    var runScheduled = false;

    function newSuite(name) {
        return { name: name, children: [], tests: [],
                 hooks: { before: [], after: [], beforeEach: [], afterEach: [] } };
    }
    function scheduleRun() {
        if (runScheduled) return;
        runScheduled = true;
        Promise.resolve().then(function() {
            // Avoid running when imported but no tests registered
            // (libraries that conditionally `require('node:test')`
            // for in-source tests).
            if (ROOT.tests.length === 0 && ROOT.children.length === 0) return;
            runSuite(ROOT, '').then(function(stats) {
                if (typeof process !== 'undefined' && typeof process.stdout !== 'undefined') {
                    var line = '\n# tests: ' + stats.total + '\n# pass: ' + stats.pass +
                               '\n# fail: ' + stats.fail + '\n# skip: ' + stats.skip + '\n';
                    if (typeof process.stdout.write === 'function') process.stdout.write(line);
                    else console.log(line);
                }
                if (stats.fail > 0 && typeof process !== 'undefined' && typeof process.exit === 'function') {
                    process.exit(1);
                }
            });
        });
    }

    function describe(name, _opts, fn) {
        if (typeof _opts === 'function') { fn = _opts; _opts = undefined; }
        var suite = newSuite(typeof name === 'string' ? name : '<suite>');
        current.children.push(suite);
        var prev = current;
        current = suite;
        try { if (typeof fn === 'function') fn(); } finally { current = prev; }
        scheduleRun();
    }
    function it(name, _opts, fn) {
        if (typeof _opts === 'function') { fn = _opts; _opts = undefined; }
        var skip = !!(_opts && _opts.skip);
        var todo = !!(_opts && _opts.todo);
        current.tests.push({
            name: typeof name === 'string' ? name : '<test>',
            fn: fn, skip: skip, todo: todo,
        });
        scheduleRun();
    }
    function before(fn)     { current.hooks.before.push(fn); }
    function after(fn)      { current.hooks.after.push(fn); }
    function beforeEach(fn) { current.hooks.beforeEach.push(fn); }
    function afterEach(fn)  { current.hooks.afterEach.push(fn); }

    // The default export `test()` is both the function form AND the
    // namespace. Calling it adds a leaf test at the current scope.
    function test(name, _opts, fn) {
        if (typeof name === 'function') { fn = name; name = '<anonymous>'; }
        if (typeof _opts === 'function') { fn = _opts; _opts = undefined; }
        var skip = !!(_opts && _opts.skip);
        var todo = !!(_opts && _opts.todo);
        current.tests.push({
            name: typeof name === 'string' ? name : '<test>',
            fn: fn, skip: skip, todo: todo,
        });
        scheduleRun();
        // Return a settled Promise so `await test(...)` is well-formed.
        return Promise.resolve();
    }

    async function callHooks(hooks) {
        for (var i = 0; i < hooks.length; i++) {
            try { await hooks[i](); } catch (_) {}
        }
    }
    async function runSuite(suite, indent) {
        var stats = { total: 0, pass: 0, fail: 0, skip: 0 };
        if (suite !== ROOT && suite.name !== '<root>' && typeof process !== 'undefined') {
            console.log(indent + '# Subtest: ' + suite.name);
        }
        await callHooks(suite.hooks.before);
        for (var ti = 0; ti < suite.tests.length; ti++) {
            var t = suite.tests[ti];
            stats.total++;
            if (t.skip) {
                stats.skip++;
                console.log(indent + 'ok ' + stats.total + ' - ' + t.name + ' # SKIP');
                continue;
            }
            if (t.todo) {
                console.log(indent + 'ok ' + stats.total + ' - ' + t.name + ' # TODO');
                continue;
            }
            await callHooks(suite.hooks.beforeEach);
            var ok = true;
            var errMsg = null;
            try { if (typeof t.fn === 'function') await t.fn({ name: t.name }); }
            catch (e) { ok = false; errMsg = (e && e.message) || String(e); }
            await callHooks(suite.hooks.afterEach);
            if (ok) {
                stats.pass++;
                console.log(indent + 'ok ' + stats.total + ' - ' + t.name);
            } else {
                stats.fail++;
                console.log(indent + 'not ok ' + stats.total + ' - ' + t.name);
                if (errMsg) {
                    console.log(indent + '  ---');
                    console.log(indent + '  message: "' + errMsg.replace(/"/g, '\\"') + '"');
                    console.log(indent + '  ...');
                }
            }
        }
        for (var ci = 0; ci < suite.children.length; ci++) {
            var sub = await runSuite(suite.children[ci], indent + '    ');
            stats.total += sub.total;
            stats.pass  += sub.pass;
            stats.fail  += sub.fail;
            stats.skip  += sub.skip;
        }
        await callHooks(suite.hooks.after);
        return stats;
    }

    test.describe = describe;
    test.it = it;
    test.suite = describe;
    test.test = test;
    test.before = before;
    test.after = after;
    test.beforeEach = beforeEach;
    test.afterEach = afterEach;
    test.skip = function(name, fn) { return it(name, { skip: true }, fn); };
    test.todo = function(name, fn) { return it(name, { todo: true }, fn); };
    test.only = function(name, fn) { return it(name, fn); };
    test.run = function() {
        // Async iterator over a snapshot of the current suite tree.
        // Most consumers only check `Symbol.asyncIterator`; we yield
        // one event per test as it runs.
        var done = false;
        return { [Symbol.asyncIterator]: function() {
            return { next: function() {
                if (done) return Promise.resolve({ value: undefined, done: true });
                done = true;
                return runSuite(ROOT, '').then(function(stats) {
                    return { value: { type: 'test:summary', data: stats }, done: false };
                });
            } };
        } };
    };
    /// MockFunctionContext (Node 19.1+) — the per-call record that
    /// `mock.fn` gives back. We track calls in an array so libraries
    /// that probe for `ctx.calls.length`, `ctx.callCount()`, or
    /// `ctx.resetCalls()` work even if the actual mock invocation is
    /// a no-op.
    function MockFunctionContext() {
        this.calls = [];
    }
    MockFunctionContext.prototype.callCount = function() {
        return this.calls.length;
    };
    MockFunctionContext.prototype.resetCalls = function() {
        this.calls = [];
    };
    MockFunctionContext.prototype.restore = function() {};
    MockFunctionContext.prototype.mockImplementation = function() {};
    MockFunctionContext.prototype.mockImplementationOnce = function() {};

    /// MockTracker (Node 19.1+) — the registry returned as `test.mock`.
    /// Real Node tracks every mock created so `restoreAll` can undo
    /// them. Our mocks are no-ops, but we keep the same shape so
    /// `mockTracker.fn().mock.calls` works.
    function MockTracker() {}
    MockTracker.prototype.fn = function(impl) {
        var fn = function() {
            fn.mock.calls.push({
                arguments: Array.prototype.slice.call(arguments),
                this: this, result: undefined, error: undefined,
            });
            return typeof impl === 'function' ? impl.apply(this, arguments) : undefined;
        };
        fn.mock = new MockFunctionContext();
        return fn;
    };
    MockTracker.prototype.method = function() { return function() {}; };
    MockTracker.prototype.getter = function() {};
    MockTracker.prototype.setter = function() {};
    MockTracker.prototype.module = function() {};
    MockTracker.prototype.restoreAll = function() {};
    MockTracker.prototype.reset = function() {};
    Object.defineProperty(MockTracker.prototype, 'timers', {
        get: function() {
            return {
                enable: function() {}, reset: function() {}, tick: function() {},
                runAll: function() {}, setTime: function() {},
            };
        },
    });

    test.mock = new MockTracker();
    test.MockFunctionContext = MockFunctionContext;
    test.MockTracker = MockTracker;

    /// `test.snapshot` (Node 22.3+) — namespace for snapshot config.
    /// We expose `setResolveSnapshotPath` / `setDefaultSnapshotSerializers`
    /// as no-op setters so snapshot-using suites can register their
    /// preferences without crashing.
    test.snapshot = {
        setResolveSnapshotPath: function() {},
        setDefaultSnapshotSerializers: function() {},
    };

    // Dual surface: `import test from 'node:test'` / `require('node:test')`
    // both yield the function-with-namespace shape. Named exports also
    // exposed for `import { describe, it, ... } from 'node:test'`.
    module.exports = test;
    module.exports.default = test;
    Object.assign(module.exports, {
        describe: describe, it: it, suite: describe, test: test,
        before: before, after: after, beforeEach: beforeEach, afterEach: afterEach,
        skip: test.skip, todo: test.todo, only: test.only,
        run: test.run, mock: test.mock,
        MockFunctionContext: MockFunctionContext, MockTracker: MockTracker,
        snapshot: test.snapshot,
    });
});

// node:sqlite — Node 22+ built-in SQLite. Distinct module from the
// `shadow-sqlite3` L3 shadow (which mimics the `sqlite3` npm
// package's callback API). Shares the same `__host_shadow_sqlite3_*`
// host fns underneath.
__register_module('sqlite', function(module, exports, require) {
    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            throw Object.assign(
                new Error('node:sqlite not available: rebuild burn with `shadow-sqlite3`'),
                { code: 'ERR_FEATURE_UNAVAILABLE' }
            );
        }
        return fn;
    }
    function lastError() {
        var fn = globalThis.__host_last_error;
        return typeof fn === 'function' ? fn() : '';
    }
    function checkErrPrefix(raw, op) {
        if (typeof raw === 'string' && raw.indexOf('__HOST_ERR__:') === 0) {
            throw Object.assign(
                new Error('sqlite.' + op + ': ' + raw.slice('__HOST_ERR__:'.length)),
                { code: 'SQLITE_ERROR' }
            );
        }
        return raw;
    }

    function StatementSync(db, sql) {
        this._db = db;
        this._sql = sql;
        this._returnsExpected = /^\s*(select|with|pragma|values)\b/i.test(sql);
    }
    StatementSync.prototype.run = function() {
        if (this._db._closed) throw new Error('database is closed');
        var args = JSON.stringify([].slice.call(arguments));
        var fn = ensureHost('__host_shadow_sqlite3_run');
        var raw = fn(this._db._id, this._sql, args);
        var resp = checkErrPrefix(raw, 'run');
        var parsed = (typeof resp === 'string' && resp.length) ? JSON.parse(resp) : {};
        return {
            changes: parsed.changes || 0,
            lastInsertRowid: parsed.lastInsertRowid || parsed.lastID || 0,
        };
    };
    StatementSync.prototype.get = function() {
        if (this._db._closed) throw new Error('database is closed');
        var args = JSON.stringify([].slice.call(arguments));
        var fn = ensureHost('__host_shadow_sqlite3_get');
        var raw = checkErrPrefix(fn(this._db._id, this._sql, args), 'get');
        return (typeof raw === 'string' && raw.length) ? JSON.parse(raw) : undefined;
    };
    StatementSync.prototype.all = function() {
        if (this._db._closed) throw new Error('database is closed');
        var args = JSON.stringify([].slice.call(arguments));
        var fn = ensureHost('__host_shadow_sqlite3_all');
        var raw = checkErrPrefix(fn(this._db._id, this._sql, args), 'all');
        return (typeof raw === 'string' && raw.length) ? JSON.parse(raw) : [];
    };
    StatementSync.prototype.iterate = function() {
        return this.all.apply(this, arguments)[Symbol.iterator]();
    };
    StatementSync.prototype.finalize = function() { /* no-op */ };
    StatementSync.prototype.expandedSQL = function() { return this._sql; };
    StatementSync.prototype.sourceSQL = function() { return this._sql; };
    StatementSync.prototype.setReadBigInts = function() { return this; };
    StatementSync.prototype.setAllowBareNamedParameters = function() { return this; };

    function DatabaseSync(filename, options) {
        if (!(this instanceof DatabaseSync)) return new DatabaseSync(filename, options);
        var open = ensureHost('__host_shadow_sqlite3_open');
        var path = String(filename || ':memory:');
        var id = open(path);
        if (id < 0) {
            throw Object.assign(
                new Error('sqlite.DatabaseSync: ' + (lastError() || 'open failed')),
                { code: 'SQLITE_CANTOPEN' }
            );
        }
        this._id = id;
        this._closed = false;
        this.location = path;
        if (options && options.open === false) {
            // Spec: caller calls .open() later. For simplicity we keep
            // the connection open; .open() is then a no-op.
        }
    }
    DatabaseSync.prototype.exec = function(sql) {
        if (this._closed) throw new Error('database is closed');
        var fn = ensureHost('__host_shadow_sqlite3_exec');
        var raw = checkErrPrefix(fn(this._id, String(sql)), 'exec');
        var _ = raw; // discard
    };
    DatabaseSync.prototype.prepare = function(sql) {
        return new StatementSync(this, String(sql));
    };
    DatabaseSync.prototype.close = function() {
        if (this._closed) return;
        var fn = ensureHost('__host_shadow_sqlite3_close');
        try { fn(this._id); } catch (_) {}
        this._closed = true;
        this._id = -1;
    };
    DatabaseSync.prototype.open = function() { /* idempotent in our model */ };
    DatabaseSync.prototype.isOpen = function() { return !this._closed; };
    DatabaseSync.prototype.isTransaction = function() { return false; };
    DatabaseSync.prototype[Symbol.dispose] = DatabaseSync.prototype.close;

    var SQLITE_CONSTANTS = {
        SQLITE_CHANGESET_OMIT: 0,
        SQLITE_CHANGESET_REPLACE: 1,
        SQLITE_CHANGESET_ABORT: 2,
        SQLITE_CHANGESET_DATA: 1,
        SQLITE_CHANGESET_NOTFOUND: 2,
        SQLITE_CHANGESET_CONFLICT: 3,
        SQLITE_CHANGESET_CONSTRAINT: 4,
        SQLITE_CHANGESET_FOREIGN_KEY: 5,
    };

    module.exports = {
        DatabaseSync: DatabaseSync,
        StatementSync: StatementSync,
        constants: SQLITE_CONSTANTS,
        // The Node 22 surface puts changeset constants directly on the
        // module — many libraries import them as named exports.
        SQLITE_CHANGESET_OMIT: SQLITE_CONSTANTS.SQLITE_CHANGESET_OMIT,
        SQLITE_CHANGESET_REPLACE: SQLITE_CONSTANTS.SQLITE_CHANGESET_REPLACE,
        SQLITE_CHANGESET_ABORT: SQLITE_CONSTANTS.SQLITE_CHANGESET_ABORT,
        SQLITE_CHANGESET_DATA: SQLITE_CONSTANTS.SQLITE_CHANGESET_DATA,
        SQLITE_CHANGESET_NOTFOUND: SQLITE_CONSTANTS.SQLITE_CHANGESET_NOTFOUND,
        SQLITE_CHANGESET_CONFLICT: SQLITE_CONSTANTS.SQLITE_CHANGESET_CONFLICT,
        SQLITE_CHANGESET_CONSTRAINT: SQLITE_CONSTANTS.SQLITE_CHANGESET_CONSTRAINT,
        SQLITE_CHANGESET_FOREIGN_KEY: SQLITE_CONSTANTS.SQLITE_CHANGESET_FOREIGN_KEY,
        /// `sqlite.backup(sourceDb, destPath, options?)` — Node 22+
        /// online backup. We implement it via a sequence of SQL
        /// statements that drive SQLite's `VACUUM INTO` semantics
        /// (atomic snapshot to a file path). For an in-memory source
        /// DB this writes the snapshot to disk; for a file source it
        /// produces a consistent copy at `destPath`. Returns a
        /// Promise that resolves to the number of pages copied.
        backup: function(sourceDb, destPath, options) {
            options = options || {};
            return new Promise(function(resolve, reject) {
                try {
                    if (!sourceDb || typeof sourceDb.exec !== 'function') {
                        throw new TypeError('sqlite.backup: source must be a DatabaseSync');
                    }
                    var quoted = "'" + String(destPath).replace(/'/g, "''") + "'";
                    sourceDb.exec('VACUUM INTO ' + quoted);
                    // Page count from the source so callers can assert
                    // a non-zero copy occurred. Fallback to 1 if the
                    // pragma isn't reachable.
                    var pages = 1;
                    try {
                        var stmt = sourceDb.prepare('PRAGMA page_count');
                        var row = stmt.get();
                        pages = (row && (row.page_count | 0)) || 1;
                        if (typeof stmt.finalize === 'function') stmt.finalize();
                    } catch (_) {}
                    if (typeof options.progress === 'function') {
                        try { options.progress({ totalPages: pages, remainingPages: 0 }); }
                        catch (_) {}
                    }
                    resolve(pages);
                } catch (e) { reject(e); }
            });
        },
    };
});

__register_module('test/reporters', function(module, exports, require) {
    var stream = require('stream');
    function passthrough() {
        return new stream.Transform({
            transform: function(chunk, _enc, cb) { cb(null, chunk); },
        });
    }
    // Each reporter is a Transform stream that node:test pipes its
    // event stream into. The runner already emits TAP-shaped lines
    // to stdout; these objects are pass-throughs so user pipelines
    // (`node --test --test-reporter=spec` etc.) compose without
    // crashing. Format-conversion lands when a real consumer needs it.
    module.exports = {
        spec: passthrough,
        tap: passthrough,
        dot: passthrough,
        junit: passthrough,
        lcov: passthrough,
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
        // AsyncIterator surface for `setInterval(ms)` — yields one
        // value per interval until the abort signal fires (or
        // forever, if no signal).
        setInterval: function(ms, value, opts) {
            var signal = opts && opts.signal;
            return {
                [Symbol.asyncIterator]: function() {
                    var done = false;
                    if (signal) {
                        signal.addEventListener('abort', function() { done = true; }, { once: true });
                    }
                    return {
                        next: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            return new Promise(function(resolve) {
                                setTimeout(function() {
                                    if (done) resolve({ value: undefined, done: true });
                                    else resolve({ value: value, done: false });
                                }, ms);
                            });
                        },
                        return: function() {
                            done = true;
                            return Promise.resolve({ value: undefined, done: true });
                        },
                    };
                },
            };
        },
        // timers/promises.scheduler — Node 18+. wait(ms[, opts])
        // promises a delay-then-resolve; yield() collapses to a
        // microtask so cooperative scheduling works.
        scheduler: {
            wait: function(ms, opts) {
                var signal = opts && opts.signal;
                return new Promise(function(resolve, reject) {
                    if (signal && signal.aborted) {
                        return reject(signal.reason || new Error('Aborted'));
                    }
                    var t = setTimeout(function() { resolve(); }, ms | 0);
                    if (signal) {
                        signal.addEventListener('abort', function() {
                            clearTimeout(t);
                            reject(signal.reason || new Error('Aborted'));
                        }, { once: true });
                    }
                });
            },
            yield: function() { return new Promise(function(r) { queueMicrotask(r); }); },
        },
    };
});

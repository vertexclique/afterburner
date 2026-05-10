// inspector — Chrome DevTools Protocol bridge.
//
// Two surfaces: an in-process `Session` (`session.post(method, params)`)
// that routes CDP commands through a local dispatcher with no external
// debugger required, and `inspector.open(port)` which boots a real
// HTTP+WebSocket listener on the host (axum-backed) so external tools
// like Chrome DevTools / VS Code can connect over `ws://`. Both share
// the same dispatcher table — a method handled by the in-process
// session is also reachable from a WebSocket client.
//
// CDP coverage in this build:
//
// | Domain     | Methods                                           |
// |------------|---------------------------------------------------|
// | Runtime    | enable, disable, evaluate, runScript,             |
// |            | compileScript, releaseObject, getProperties,      |
// |            | runIfWaitingForDebugger                           |
// | Debugger   | enable, disable, scriptSource, setBreakpointsActive,|
// |            | resume, getScriptSource                           |
// | HeapProfiler | enable, disable, takeHeapSnapshot,             |
// |            | collectGarbage                                    |
// | Profiler   | enable, disable, start, stop, setSamplingInterval |
// | Inspector  | enable                                            |
// | Page       | enable                                            |
//
// Engine-ceiling: full breakpoint stepping requires a QuickJS debug
// hook the upstream engine doesn't expose. `Debugger.setBreakpointByUrl`
// returns `ERR_INSPECTOR_NOT_SUPPORTED_ON_BURN` so callers fail fast
// rather than silently never hitting a breakpoint.

__register_module('inspector', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    var _opened = false;
    var _port = 9229;
    var _host = '127.0.0.1';
    var _wsPath = null;
    var _scriptIdCounter = 1;
    var _scriptsById = Object.create(null);
    var _scriptsByUrl = Object.create(null);
    var _executionContextId = 1;
    var _profilerActive = false;
    var _profilerSamples = null;
    var _profilerStartedAt = 0;
    var _profilerSamplingIntervalUs = 1000;

    // ---- Real CDP method table ----------------------------------

    var methods = Object.create(null);

    function registerMethod(name, handler) {
        methods[name] = handler;
    }

    // ---- Runtime ------------------------------------------------

    registerMethod('Runtime.enable', function(_params, _ctx) {
        _ctx.notify('Runtime.executionContextCreated', {
            context: {
                id: _executionContextId,
                origin: '',
                name: 'burn',
                uniqueId: 'burn-' + _executionContextId,
                auxData: {
                    isDefault: true,
                    type: 'default',
                    frameId: 'burn-frame',
                },
            },
        });
        return {};
    });

    registerMethod('Runtime.disable', function() { return {}; });

    registerMethod('Runtime.runIfWaitingForDebugger', function() { return {}; });

    registerMethod('Runtime.evaluate', function(params, _ctx) {
        var expr = (params && params.expression) || '';
        return _evalAndPackage(expr, params || {});
    });

    registerMethod('Runtime.runScript', function(params, _ctx) {
        var src = '';
        if (params && params.scriptId && _scriptsById[params.scriptId]) {
            src = _scriptsById[params.scriptId].source;
        }
        return _evalAndPackage(src, params || {});
    });

    registerMethod('Runtime.compileScript', function(params, _ctx) {
        var src = (params && params.expression) || '';
        var url = (params && params.sourceURL) || '';
        var sid = String(_scriptIdCounter++);
        var entry = { source: src, url: url };
        _scriptsById[sid] = entry;
        if (url) _scriptsByUrl[url] = sid;
        // Pre-flight: try parse via Function() so we surface compile
        // errors right here rather than later at runScript time.
        try {
            new Function(src);
        } catch (e) {
            return {
                exceptionDetails: _wrapException(e),
            };
        }
        return { scriptId: sid };
    });

    registerMethod('Runtime.releaseObject', function() { return {}; });
    registerMethod('Runtime.releaseObjectGroup', function() { return {}; });

    registerMethod('Runtime.getProperties', function(params, _ctx) {
        var oid = (params && params.objectId) || '';
        var ref = _objectTable[oid];
        if (!ref) return { result: [] };
        var props = [];
        try {
            var keys = Object.getOwnPropertyNames(ref);
            for (var i = 0; i < keys.length && i < 256; i++) {
                var k = keys[i];
                var d = Object.getOwnPropertyDescriptor(ref, k) || {};
                props.push({
                    name: k,
                    configurable: !!d.configurable,
                    enumerable: !!d.enumerable,
                    writable: !!d.writable,
                    value: d.value === undefined ? undefined : _packValue(d.value),
                });
            }
        } catch (_) {}
        return { result: props };
    });

    // ---- Debugger -----------------------------------------------

    registerMethod('Debugger.enable', function(_params, _ctx) {
        // Replay scriptParsed for everything compiled so far so the
        // attaching client sees the existing world.
        var ids = Object.keys(_scriptsById);
        for (var i = 0; i < ids.length; i++) {
            var s = _scriptsById[ids[i]];
            _ctx.notify('Debugger.scriptParsed', {
                scriptId: ids[i],
                url: s.url || '',
                startLine: 0,
                startColumn: 0,
                endLine: 0,
                endColumn: s.source ? s.source.length : 0,
                executionContextId: _executionContextId,
                hash: '',
                isLiveEdit: false,
                sourceMapURL: '',
                hasSourceURL: !!s.url,
                isModule: false,
                length: s.source ? s.source.length : 0,
            });
        }
        return { debuggerId: 'burn-debugger' };
    });
    registerMethod('Debugger.disable', function() { return {}; });
    registerMethod('Debugger.setBreakpointsActive', function() { return {}; });
    registerMethod('Debugger.setSkipAllPauses', function() { return {}; });
    registerMethod('Debugger.setPauseOnExceptions', function() { return {}; });
    registerMethod('Debugger.resume', function() { return {}; });
    registerMethod('Debugger.getScriptSource', function(params) {
        var sid = (params && params.scriptId) || '';
        var entry = _scriptsById[sid];
        if (!entry) {
            var err = new Error('Debugger.getScriptSource: unknown scriptId ' + sid);
            err.code = 'ERR_INSPECTOR_COMMAND_FAILED';
            throw err;
        }
        return { scriptSource: entry.source || '' };
    });
    /// Real breakpoint registration backed by source-level statement
    /// instrumentation in the transpiler (`BURN_DEBUGGER_INSTRUMENT=1`).
    /// Each registered breakpoint goes into `_breakpoints` keyed by
    /// `urlPattern + ':' + lineNumber`. The transpiler-injected
    /// `__ab_brk(file, line, col)` check consults this table on every
    /// statement; when a hit is detected, it calls
    /// `__host_inspector_pause` which blocks the JS shard until the
    /// connected DevTools client sends Debugger.resume.
    registerMethod('Debugger.setBreakpointByUrl', function(params, _ctx) {
        var url = (params && params.url) || (params && params.urlRegex) || '';
        var line = (params && params.lineNumber) | 0;
        var col = (params && params.columnNumber) | 0;
        var id = 'burn-bp-' + (++_bpIdCounter);
        _breakpoints[id] = { url: url, line: line, col: col };
        return {
            breakpointId: id,
            locations: [{
                scriptId: '0',
                lineNumber: line,
                columnNumber: col,
            }],
        };
    });
    registerMethod('Debugger.removeBreakpoint', function(params) {
        var id = (params && params.breakpointId) || '';
        delete _breakpoints[id];
        return {};
    });
    var _breakpoints = Object.create(null);
    var _bpIdCounter = 0;
    /// Called from the transpiler-injected `__ab_brk` checks. Looks
    /// up the source location in the active breakpoint table and, if
    /// a match exists, fires the `Debugger.paused` notification then
    /// blocks via `__host_inspector_pause`. Returns the step-kind
    /// code the WS client sent back (0=resume, 1=stepOver, etc.).
    function _checkBreakpoint(file, line, col) {
        var keys = Object.keys(_breakpoints);
        for (var i = 0; i < keys.length; i++) {
            var bp = _breakpoints[keys[i]];
            if (bp.line !== line) continue;
            // URL match — substring or regex. Most DevTools clients
            // pass a fully-qualified `file://...` URL; we match on
            // the trailing path because our file refs are bare paths.
            if (bp.url && bp.url.length > 0 && file.indexOf(bp.url) < 0
                && bp.url.indexOf(file) < 0) {
                continue;
            }
            // Hit.
            var stack;
            try { throw new Error('__brk_stack__'); }
            catch (e) { stack = e.stack || ''; }
            // Notify all sessions.
            if (typeof globalThis.__host_inspector_send === 'function') {
                var note = JSON.stringify({
                    method: 'Debugger.paused',
                    params: {
                        callFrames: [{
                            callFrameId: '0',
                            functionName: '<anonymous>',
                            location: { scriptId: '0', lineNumber: line, columnNumber: col },
                            url: file,
                            scopeChain: [],
                            this: { type: 'object', subtype: 'null' },
                        }],
                        reason: 'other',
                        hitBreakpoints: [keys[i]],
                    },
                });
                try { globalThis.__host_inspector_send(0, note); } catch (_) {}
            }
            if (typeof globalThis.__host_inspector_pause === 'function') {
                return globalThis.__host_inspector_pause() | 0;
            }
            return 0;
        }
        return -1;
    }
    // Global the transpiler-injected probes call.
    globalThis.__ab_brk = function(file, line, col) {
        // Fast path: skip the per-statement work when no breakpoints
        // are registered. Hot loops in non-debugger runs cost one
        // property read + one Object.keys length check.
        if (Object.keys(_breakpoints).length === 0) return;
        _checkBreakpoint(String(file), line | 0, col | 0);
    };

    registerMethod('Debugger.resume', function() { return {}; });
    registerMethod('Debugger.stepOver', function() { return {}; });
    registerMethod('Debugger.stepInto', function() { return {}; });
    registerMethod('Debugger.stepOut', function() { return {}; });

    // ---- HeapProfiler -------------------------------------------

    registerMethod('HeapProfiler.enable', function() { return {}; });
    registerMethod('HeapProfiler.disable', function() { return {}; });
    registerMethod('HeapProfiler.collectGarbage', function() {
        // QuickJS GC is automatic; expose what we can.
        if (typeof globalThis.gc === 'function') {
            try { globalThis.gc(); } catch (_) {}
        }
        return {};
    });

    registerMethod('HeapProfiler.takeHeapSnapshot', function(_params, _ctx) {
        var v8 = require('v8');
        var stream = v8.getHeapSnapshot();
        var chunks = [];
        // The current getHeapSnapshot impl emits one big chunk
        // synchronously via setImmediate. Drain into a buffer; the
        // `addHeapSnapshotChunk` event is the CDP-wire shape.
        return new Promise(function(resolve) {
            stream.on('data', function(buf) {
                chunks.push(buf.toString('utf8'));
            });
            stream.on('end', function() {
                var full = chunks.join('');
                // CDP clients expect the snapshot in fixed-size chunks
                // delivered as `HeapProfiler.addHeapSnapshotChunk`
                // notifications, with the final return value being
                // `{}`. We use 64 KiB pages — small enough that
                // DevTools' progress UI updates smoothly, large
                // enough to keep the count of frames bounded.
                var pageSize = 64 * 1024;
                for (var i = 0; i < full.length; i += pageSize) {
                    _ctx.notify('HeapProfiler.addHeapSnapshotChunk', {
                        chunk: full.slice(i, Math.min(full.length, i + pageSize)),
                    });
                }
                _ctx.notify('HeapProfiler.reportHeapSnapshotProgress', {
                    done: full.length,
                    total: full.length,
                    finished: true,
                });
                resolve({});
            });
        });
    });

    // ---- Profiler -----------------------------------------------

    registerMethod('Profiler.enable', function() { return {}; });
    registerMethod('Profiler.disable', function() { return {}; });

    registerMethod('Profiler.setSamplingInterval', function(params) {
        var us = (params && params.interval) || 1000;
        _profilerSamplingIntervalUs = us;
        return {};
    });

    registerMethod('Profiler.start', function() {
        _profilerActive = true;
        _profilerSamples = [];
        _profilerStartedAt = (Date.now() * 1000) | 0;
        // Sample the call stack on each Promise microtask drain. We
        // can't pre-empt sync code from JS, so on a busy synchronous
        // loop the sample count stays low — that's intrinsic to a
        // userland-hosted profiler. The frames recovered from
        // `Error.stack` are the CDP-wire `CallFrame` payload.
        _profilerSampleScheduler();
        return {};
    });

    registerMethod('Profiler.stop', function() {
        _profilerActive = false;
        var endedAt = (Date.now() * 1000) | 0;
        var samples = _profilerSamples || [];
        _profilerSamples = null;
        // Build a CDP `Profile` value. Nodes are the unique frames
        // observed; samples is the index per tick; timeDeltas is
        // microseconds since the previous sample. Root node id 1.
        var nodes = [{
            id: 1,
            callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
            hitCount: 0,
            children: [],
        }];
        var nodeIndex = Object.create(null);
        nodeIndex['(root)|0'] = 1;
        var nextNodeId = 2;
        var sampleIds = [];
        var timeDeltas = [];
        var prevTs = _profilerStartedAt;
        for (var i = 0; i < samples.length; i++) {
            var frame = samples[i].frame || '(anonymous)';
            var key = frame + '|' + i;
            var id = nodeIndex[frame] || (nodeIndex[frame] = nextNodeId++);
            if (!nodes[id - 1]) {
                nodes.push({
                    id: id,
                    callFrame: { functionName: frame, scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
                    hitCount: 0,
                    children: [],
                });
            }
            nodes[id - 1].hitCount++;
            sampleIds.push(id);
            var ts = samples[i].ts;
            timeDeltas.push(Math.max(0, ts - prevTs));
            prevTs = ts;
        }
        return {
            profile: {
                nodes: nodes,
                samples: sampleIds,
                timeDeltas: timeDeltas,
                startTime: _profilerStartedAt,
                endTime: endedAt,
            },
        };
    });

    function _profilerSampleScheduler() {
        if (!_profilerActive) return;
        Promise.resolve().then(function() {
            if (!_profilerActive) return;
            var stack;
            try {
                throw new Error('__profile_sample__');
            } catch (e) {
                stack = e.stack || '';
            }
            // First non-internal frame name.
            var frame = '(anonymous)';
            var lines = (stack || '').split('\n');
            for (var i = 1; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line && line.indexOf('__profile_sample__') < 0
                    && line.indexOf('_profilerSampleScheduler') < 0) {
                    var m = line.match(/at\s+([^\s(]+)/);
                    if (m && m[1] && m[1] !== 'Promise.then') {
                        frame = m[1];
                        break;
                    }
                }
            }
            _profilerSamples.push({ frame: frame, ts: (Date.now() * 1000) | 0 });
            // Re-arm. The scheduler runs at microtask cadence; tighter
            // than `setInterval` and bounded only by the loop's pulse.
            _profilerSampleScheduler();
        });
    }

    // ---- Inspector / Page ---------------------------------------

    registerMethod('Inspector.enable', function() { return {}; });
    registerMethod('Page.enable', function() { return {}; });
    registerMethod('Network.enable', function() { return {}; });

    // ---- Object table -------------------------------------------
    //
    // Eval results that aren't primitives get a synthetic ID so a
    // subsequent `Runtime.getProperties({objectId})` can introspect
    // them. Bounded to 1024 live entries — older ones recycle.

    var _objectTable = Object.create(null);
    var _objectTableIds = [];
    var _objectIdCounter = 1;
    var _OBJECT_TABLE_CAP = 1024;

    function _registerObject(value) {
        var id = '{"injectedScriptId":1,"id":' + (_objectIdCounter++) + '}';
        _objectTable[id] = value;
        _objectTableIds.push(id);
        if (_objectTableIds.length > _OBJECT_TABLE_CAP) {
            var stale = _objectTableIds.shift();
            delete _objectTable[stale];
        }
        return id;
    }

    function _typeOf(v) {
        if (v === null) return 'object';
        if (Array.isArray(v)) return 'object';
        return typeof v;
    }

    function _subtypeOf(v) {
        if (v === null) return 'null';
        if (Array.isArray(v)) return 'array';
        if (v instanceof Error) return 'error';
        if (v instanceof RegExp) return 'regexp';
        if (v instanceof Date) return 'date';
        if (v instanceof Map) return 'map';
        if (v instanceof Set) return 'set';
        if (v instanceof Promise) return 'promise';
        return undefined;
    }

    function _packValue(v) {
        var ty = _typeOf(v);
        var sub = _subtypeOf(v);
        if (ty === 'undefined') return { type: 'undefined' };
        if (v === null) return { type: 'object', subtype: 'null', value: null };
        if (ty === 'boolean' || ty === 'number' || ty === 'string') {
            return { type: ty, value: v };
        }
        if (ty === 'bigint') return { type: 'bigint', unserializableValue: String(v) + 'n' };
        if (ty === 'symbol') return { type: 'symbol', description: String(v) };
        if (ty === 'function') {
            return {
                type: 'function',
                className: 'Function',
                description: (function() {
                    try { return v.toString().slice(0, 200); } catch (_) { return 'function'; }
                })(),
                objectId: _registerObject(v),
            };
        }
        // Object / array / error / etc.
        var desc = '';
        try { desc = String(v); } catch (_) { desc = 'Object'; }
        return {
            type: 'object',
            subtype: sub,
            className: (v && v.constructor && v.constructor.name) || 'Object',
            description: desc,
            objectId: _registerObject(v),
        };
    }

    function _wrapException(e) {
        return {
            exceptionId: 0,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            scriptId: '0',
            exception: _packValue(e && e.message ? new Error(e.message) : e),
        };
    }

    function _evalAndPackage(expr, params) {
        var result;
        var exception = null;
        try {
            // (0, eval) is the canonical idiom for indirect global eval.
            result = (0, eval)(expr);
            // If returnByValue is requested, send the literal value.
            if (params && params.returnByValue) {
                try {
                    JSON.stringify(result);
                    return { result: { type: _typeOf(result), value: result } };
                } catch (_) { /* fall through to packed form */ }
            }
        } catch (e) {
            exception = _wrapException(e);
        }
        if (exception) return { exceptionDetails: exception, result: { type: 'object', subtype: 'error' } };
        return { result: _packValue(result) };
    }

    // ---- Session class ------------------------------------------

    function Session() {
        EventEmitter.call(this);
        this._connected = false;
        this._pendingId = 1;
    }
    Session.prototype = Object.create(EventEmitter.prototype);
    Session.prototype.constructor = Session;

    Session.prototype.connect = function() {
        this._connected = true;
        return this;
    };
    Session.prototype.connectToMainThread = function() { return this.connect(); };
    Session.prototype.disconnect = function() {
        this._connected = false;
        return this;
    };

    Session.prototype.post = function(method, params, callback) {
        if (typeof params === 'function') { callback = params; params = undefined; }
        if (!this._connected) {
            var err = new Error("Session is not connected (call .connect() first)");
            err.code = 'ERR_INSPECTOR_NOT_CONNECTED';
            if (typeof callback === 'function') {
                Promise.resolve().then(function() { callback(err); });
                return;
            }
            throw err;
        }
        var self = this;
        var ctx = {
            notify: function(notifMethod, notifParams) {
                try { self.emit(notifMethod, { method: notifMethod, params: notifParams }); }
                catch (_) {}
                try { self.emit('inspectorNotification', { method: notifMethod, params: notifParams }); }
                catch (_) {}
            },
        };
        var handler = methods[method];
        if (!handler) {
            var nerr = new Error("Inspector method '" + method + "' is not implemented");
            nerr.code = 'ERR_INSPECTOR_COMMAND_UNKNOWN';
            if (typeof callback === 'function') {
                Promise.resolve().then(function() { callback(nerr); });
                return;
            }
            throw nerr;
        }
        var rv;
        try {
            rv = handler(params || {}, ctx);
        } catch (e) {
            if (typeof callback === 'function') {
                Promise.resolve().then(function() { callback(e); });
                return;
            }
            throw e;
        }
        // Handler may return a Promise; resolve before invoking cb.
        if (rv && typeof rv.then === 'function') {
            rv.then(
                function(value) { if (typeof callback === 'function') callback(null, value); },
                function(err) { if (typeof callback === 'function') callback(err); }
            );
        } else if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(null, rv); });
        }
    };

    // ---- WebSocket-side dispatch (host integration) -------------
    //
    // The host pumps `{kind:"inspector-cmd"}` daemon-event envelopes
    // here when an external CDP client sends a frame. We dispatch
    // through the same `methods` table and reply via __host_inspector_send.

    function _dispatchExternal(sessionKey, id, method, params) {
        var ctx = {
            notify: function(notifMethod, notifParams) {
                _hostSend(sessionKey, {
                    method: notifMethod,
                    params: notifParams,
                });
            },
        };
        var handler = methods[method];
        if (!handler) {
            _hostSend(sessionKey, {
                id: id,
                error: { code: -32601, message: "Method not found: " + method },
            });
            return;
        }
        var rv;
        try { rv = handler(params || {}, ctx); }
        catch (e) {
            _hostSend(sessionKey, {
                id: id,
                error: {
                    code: -32000,
                    message: (e && e.message) || String(e),
                },
            });
            return;
        }
        var send = function(result) {
            _hostSend(sessionKey, { id: id, result: result || {} });
        };
        if (rv && typeof rv.then === 'function') {
            rv.then(send, function(e) {
                _hostSend(sessionKey, {
                    id: id,
                    error: {
                        code: -32000,
                        message: (e && e.message) || String(e),
                    },
                });
            });
        } else {
            send(rv);
        }
    }

    function _hostSend(sessionKey, msg) {
        if (typeof globalThis.__host_inspector_send !== 'function') return;
        try {
            globalThis.__host_inspector_send(sessionKey, JSON.stringify(msg));
        } catch (_) {}
    }

    // Surface the dispatcher so the daemon-event handler can call us.
    globalThis.__ab_inspector_dispatch = _dispatchExternal;

    // ---- inspector.open / close / url ---------------------------

    function open(port, host /*, wait */) {
        if (typeof port === 'number') _port = port;
        if (typeof host === 'string') _host = host;
        if (typeof globalThis.__host_inspector_open !== 'function') {
            // No daemon — keep the surface working but mark closed.
            // Calls to Session.post still work in-process.
            _opened = false;
            _wsPath = null;
            return;
        }
        var rc = globalThis.__host_inspector_open(_port);
        if (rc < 0) {
            var err = new Error('inspector.open: failed (rc=' + rc + ')');
            err.code = 'ERR_INSPECTOR_NOT_AVAILABLE';
            throw err;
        }
        _opened = true;
        // The host returns the actual bound port (rc > 0). Use it
        // — port=0 is a valid request to bind ephemeral.
        if (rc > 0 && rc < 65536) _port = rc;
        _wsPath = '/devtools/page/burn-' + _port;
    }

    function close() {
        if (typeof globalThis.__host_inspector_close === 'function') {
            try { globalThis.__host_inspector_close(); } catch (_) {}
        }
        _opened = false;
        _wsPath = null;
    }

    function url() {
        if (!_opened) return undefined;
        return 'ws://' + _host + ':' + _port + _wsPath;
    }

    function waitForDebugger() {
        // Real Node blocks until Debugger.enable + runIfWaitingForDebugger
        // arrives. The sandboxed model never receives one in offline
        // mode; we surface this as a no-op so callers don't deadlock.
        // External CDP clients that connect via inspector.open() can
        // call Runtime.runIfWaitingForDebugger via the WebSocket which
        // will resolve any pending session.
    }

    exports.open = open;
    exports.close = close;
    exports.url = url;
    exports.waitForDebugger = waitForDebugger;
    exports.console = globalThis.console || { log: function() {} };
    exports.Session = Session;
    exports.Network = {
        requestWillBeSent: function() {},
        responseReceived: function() {},
        loadingFinished: function() {},
        loadingFailed: function() {},
    };
});

// inspector — Node 20's V8 inspector protocol bridge.
//
// The DevTools / Chrome Inspector protocol requires a long-lived
// channel that responds to a JSON-RPC stream of CDP messages. Burn
// has no live inspector and no debugger UI. We expose the API so
// instrumentation code that calls `inspector.open()` /
// `inspector.url()` doesn't crash on import; methods that would
// genuinely require a debugger session (the `Session` class's
// `post()` actually doing something) accept commands but reply with
// "no debugger attached" errors.

__register_module('inspector', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    var _opened = false;
    var _port = 9229;
    var _host = '127.0.0.1';

    function open(port, host /*, wait */) {
        _opened = true;
        if (typeof port === 'number') _port = port;
        if (typeof host === 'string') _host = host;
    }
    function close() { _opened = false; }
    function url() {
        if (!_opened) return undefined;
        return 'ws://' + _host + ':' + _port + '/burn-noop';
    }
    function waitForDebugger() {
        // Real Node blocks until a debugger attaches. We never get
        // a debugger; return immediately so callers don't deadlock.
    }

    // ---- Session class --------------------------------------------

    function Session() {
        EventEmitter.call(this);
        this._connected = false;
    }
    Session.prototype = Object.create(EventEmitter.prototype);
    Session.prototype.constructor = Session;

    Session.prototype.connect = function() {
        this._connected = true;
        return this;
    };
    Session.prototype.connectToMainThread = function() {
        return this.connect();
    };
    Session.prototype.disconnect = function() {
        this._connected = false;
        return this;
    };
    Session.prototype.post = function(method, params, callback) {
        if (typeof params === 'function') { callback = params; params = undefined; }
        var err = new Error(
            "inspector.Session.post('" + method + "'): no debugger attached " +
            'in the burn sandbox; use the host-side wasmtime debugger if you ' +
            'need stepping.'
        );
        err.code = 'ERR_INSPECTOR_NOT_CONNECTED';
        if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(err); });
            return;
        }
        throw err;
    };

    exports.open = open;
    exports.close = close;
    exports.url = url;
    exports.waitForDebugger = waitForDebugger;
    exports.console = globalThis.console || { log: function() {} };
    exports.Session = Session;
    exports.Network = {
        // Node 20 added a `Network` namespace on inspector for
        // request tracing. Stub the surface so callers don't crash.
        requestWillBeSent: function() {},
        responseReceived: function() {},
        loadingFinished: function() {},
        loadingFailed: function() {},
    };
});

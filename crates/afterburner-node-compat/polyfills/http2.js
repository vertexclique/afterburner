// http2 — Node 20's HTTP/2 module. We wire the client-side API
// (`connect` → `session.request` → stream events) against the host's
// async HTTP outbound (the same path fetch / http.request use).
// Real HTTP/2 frame negotiation happens at the host layer when the
// server supports h2 ALPN; from JS the multiplexing-vs-h1 distinction
// is invisible — the same `:method` / `:path` / `:scheme` /
// `:authority` pseudo-headers translate to a normal HTTP request.
// Server-side http2 (`createSecureServer().listen()`) still surfaces
// `ERR_HTTP2_NOT_IMPLEMENTED` until the host gains an h2 listener;
// most workloads call http2 as a CLIENT, so the surface most code
// hits is now real.

__register_module('http2', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;

    function notImpl(name) {
        var e = new Error(
            'http2.' + name + ' (server-side) is not yet implemented in burn — '
            + 'createSecureServer + listen requires an h2-capable host listener. '
            + 'http2.connect (client) IS implemented; use the existing http / https '
            + 'modules for HTTP/1.1 server work.'
        );
        e.code = 'ERR_HTTP2_NOT_IMPLEMENTED';
        return e;
    }

    function _parseAuthority(authority) {
        try {
            var u = new URL(String(authority));
            return { scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port };
        } catch (_) {
            var s = String(authority || '');
            var c = s.lastIndexOf(':');
            if (c >= 0 && s.indexOf('://') < 0) {
                return { scheme: 'https', host: s.slice(0, c), port: s.slice(c + 1) };
            }
            return { scheme: 'https', host: s, port: '' };
        }
    }

    // ---- ClientHttp2Stream — bidirectional stream-like ------------
    //
    // Real h2 streams support flow-control and trailers; for the
    // common "send headers + body, read response" pattern we model
    // each as an EventEmitter with `write` / `end` (request body)
    // and emit `response` (with headers) → `data` chunks → `end`.
    function ClientHttp2Stream(session, headers, options) {
        EventEmitter.call(this);
        this._session = session;
        this._headers = headers;
        this._options = options || {};
        this._reqBody = [];
        this._ended = false;
        this._destroyed = false;
        this.id = session._nextStreamId();
        this.session = session;
        this.aborted = false;
        this.closed = false;
        this.pending = true;
        var self = this;
        Promise.resolve().then(function() { self._dispatch(); });
    }
    ClientHttp2Stream.prototype = Object.create(EventEmitter.prototype);
    ClientHttp2Stream.prototype.constructor = ClientHttp2Stream;
    ClientHttp2Stream.prototype.write = function(chunk, _enc, cb) {
        if (this._destroyed) {
            if (typeof cb === 'function') cb(new Error('stream destroyed'));
            return false;
        }
        if (chunk != null) {
            this._reqBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        if (typeof cb === 'function') Promise.resolve().then(cb);
        return true;
    };
    ClientHttp2Stream.prototype.end = function(chunk, _enc, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (chunk !== undefined) this.write(chunk);
        this._ended = true;
        if (typeof cb === 'function') Promise.resolve().then(cb);
        return this;
    };
    ClientHttp2Stream.prototype.close = function(_code, cb) {
        this.closed = true;
        this._destroyed = true;
        if (typeof cb === 'function') Promise.resolve().then(cb);
    };
    ClientHttp2Stream.prototype.destroy = function(err) {
        if (this._destroyed) return;
        this._destroyed = true;
        this.aborted = !!err;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
    };
    ClientHttp2Stream.prototype.setTimeout = function() { return this; };
    ClientHttp2Stream.prototype.priority = function() {};
    ClientHttp2Stream.prototype.sendTrailers = function() {};

    ClientHttp2Stream.prototype._dispatch = function() {
        var self = this;
        var auth = this._session._parsedAuthority;
        var path = this._headers[':path'] || '/';
        var method = (this._headers[':method'] || 'GET').toUpperCase();
        var scheme = this._headers[':scheme'] || auth.scheme || 'https';
        var url = scheme + '://' + auth.host + (auth.port ? ':' + auth.port : '') + path;

        // Strip pseudo-headers; keep the rest as request headers.
        var reqHeaders = {};
        var keys = Object.keys(this._headers);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.charAt(0) !== ':') reqHeaders[k] = this._headers[k];
        }
        var body = this._reqBody.length ? Buffer.concat(this._reqBody).toString('utf8') : null;

        var asyncFn = globalThis.__host_http_request_async;
        var syncFn = globalThis.__host_http_request;
        if (typeof asyncFn !== 'function' && typeof syncFn !== 'function') {
            self.emit('error', new Error('http2: net capability not granted'));
            return;
        }

        function dispatchResponse(result) {
            self.pending = false;
            var responseHeaders = Object.assign({}, result.headers || {});
            responseHeaders[':status'] = result.status;
            self.emit('response', responseHeaders, 0);
            self.emit('headers', responseHeaders, 0);
            var bytes = null;
            if (typeof result.body_b64 === 'string' && result.body_b64.length) {
                bytes = Buffer.from(result.body_b64, 'base64');
            } else if (typeof result.body === 'string') {
                bytes = Buffer.from(result.body, 'utf8');
            } else {
                bytes = Buffer.alloc(0);
            }
            if (bytes.length) self.emit('data', bytes);
            self.emit('end');
            self.emit('close');
        }

        if (typeof asyncFn === 'function') {
            try {
                var rid = asyncFn(method, url, body || null);
                if (typeof rid === 'bigint') rid = Number(rid);
                if (typeof rid === 'number' && rid > 0) {
                    if (!globalThis.__ab_http_pending) globalThis.__ab_http_pending = {};
                    globalThis.__ab_http_pending[rid] = {
                        resolve: function(result) { dispatchResponse(result); },
                    };
                    return;
                }
            } catch (_) {}
        }
        try {
            var rawSync = syncFn(method, url, body || null);
            var resultSync = JSON.parse(rawSync);
            if (typeof resultSync.body === 'string' && resultSync.body.indexOf('__HOST_ERR__:') === 0) {
                self.emit('error', new Error('http2: ' + resultSync.body.slice('__HOST_ERR__:'.length)));
                return;
            }
            dispatchResponse(resultSync);
        } catch (e) {
            self.emit('error', e);
        }
    };

    // ---- ClientHttp2Session ---------------------------------------

    function ClientHttp2Session(authority, _options) {
        EventEmitter.call(this);
        this.closed = false;
        this.destroyed = false;
        this.alpnProtocol = 'h2';
        this.connecting = false;
        this._streamIdCounter = 0;
        this.authority = authority;
        this._parsedAuthority = _parseAuthority(authority);
        var self = this;
        Promise.resolve().then(function() {
            if (!self.destroyed) self.emit('connect', self, /* socket */ null);
        });
    }
    ClientHttp2Session.prototype = Object.create(EventEmitter.prototype);
    ClientHttp2Session.prototype.constructor = ClientHttp2Session;
    ClientHttp2Session.prototype._nextStreamId = function() {
        this._streamIdCounter += 2; // h2 client uses odd ids
        return this._streamIdCounter - 1;
    };
    ClientHttp2Session.prototype.request = function(headers, options) {
        if (this.destroyed) throw new Error('http2: session destroyed');
        return new ClientHttp2Stream(this, headers || {}, options);
    };
    ClientHttp2Session.prototype.close = function(cb) {
        this.closed = true;
        if (typeof cb === 'function') Promise.resolve().then(cb);
    };
    ClientHttp2Session.prototype.destroy = function(err) {
        this.destroyed = true;
        var self = this;
        Promise.resolve().then(function() {
            if (err) self.emit('error', err);
            self.emit('close');
        });
    };
    ClientHttp2Session.prototype.ping = function(payload, callback) {
        if (typeof payload === 'function') { callback = payload; payload = undefined; }
        if (typeof callback === 'function') {
            Promise.resolve().then(function() {
                callback(null, 0, payload || Buffer.alloc(8));
            });
        }
        return true;
    };
    ClientHttp2Session.prototype.settings = function(_settings, cb) {
        if (typeof cb === 'function') Promise.resolve().then(cb);
    };
    ClientHttp2Session.prototype.setTimeout = function() { return this; };
    ClientHttp2Session.prototype.unref = function() { return this; };
    ClientHttp2Session.prototype.ref = function() { return this; };
    Object.defineProperty(ClientHttp2Session.prototype, 'state', {
        get: function() { return { effectiveLocalWindowSize: 65535 }; },
    });

    function connect(authority, options, listener) {
        if (typeof options === 'function') { listener = options; options = undefined; }
        var session = new ClientHttp2Session(authority, options);
        if (typeof listener === 'function') session.on('connect', listener);
        return session;
    }

    // ---- Server side ----------------------------------------------

    function Http2Server() {
        EventEmitter.call(this);
    }
    Http2Server.prototype = Object.create(EventEmitter.prototype);
    Http2Server.prototype.constructor = Http2Server;
    Http2Server.prototype.listen = function() { throw notImpl('Server.listen'); };
    Http2Server.prototype.close = function(cb) {
        if (typeof cb === 'function') Promise.resolve().then(cb);
    };
    Http2Server.prototype.address = function() { return null; };
    Http2Server.prototype.setTimeout = function() { return this; };
    Http2Server.prototype.ref = function() { return this; };
    Http2Server.prototype.unref = function() { return this; };

    function createServer() { return new Http2Server(); }
    function createSecureServer() { return new Http2Server(); }

    // ---- constants ------------------------------------------------

    var constants = {
        NGHTTP2_NO_ERROR: 0,
        NGHTTP2_PROTOCOL_ERROR: 1,
        NGHTTP2_INTERNAL_ERROR: 2,
        NGHTTP2_FLOW_CONTROL_ERROR: 3,
        NGHTTP2_SETTINGS_TIMEOUT: 4,
        NGHTTP2_STREAM_CLOSED: 5,
        NGHTTP2_FRAME_SIZE_ERROR: 6,
        NGHTTP2_REFUSED_STREAM: 7,
        NGHTTP2_CANCEL: 8,
        NGHTTP2_COMPRESSION_ERROR: 9,
        NGHTTP2_CONNECT_ERROR: 10,
        NGHTTP2_ENHANCE_YOUR_CALM: 11,
        NGHTTP2_INADEQUATE_SECURITY: 12,
        NGHTTP2_HTTP_1_1_REQUIRED: 13,
        HTTP2_HEADER_AUTHORITY: ':authority',
        HTTP2_HEADER_METHOD: ':method',
        HTTP2_HEADER_PATH: ':path',
        HTTP2_HEADER_SCHEME: ':scheme',
        HTTP2_HEADER_STATUS: ':status',
        HTTP2_HEADER_PROTOCOL: ':protocol',
        HTTP2_METHOD_GET: 'GET',
        HTTP2_METHOD_POST: 'POST',
        HTTP2_METHOD_DELETE: 'DELETE',
        HTTP2_METHOD_PUT: 'PUT',
        HTTP2_METHOD_HEAD: 'HEAD',
        HTTP2_METHOD_OPTIONS: 'OPTIONS',
        HTTP2_METHOD_PATCH: 'PATCH',
    };

    function getDefaultSettings() {
        return {
            headerTableSize: 4096,
            enablePush: true,
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            maxConcurrentStreams: 4294967295,
            maxHeaderListSize: 65535,
            maxHeaderSize: 65535,
        };
    }
    function getPackedSettings() { return Buffer.alloc(0); }
    function getUnpackedSettings() { return getDefaultSettings(); }
    function performServerHandshake() { return new Http2Server(); }
    var SENSITIVE_HEADERS = Symbol.for('http2.sensitiveHeaders');

    exports.connect = connect;
    exports.createServer = createServer;
    exports.createSecureServer = createSecureServer;
    exports.constants = constants;
    exports.Http2Session = ClientHttp2Session;
    exports.ClientHttp2Session = ClientHttp2Session;
    exports.ServerHttp2Session = ClientHttp2Session;
    exports.Http2Stream = ClientHttp2Stream;
    exports.ClientHttp2Stream = ClientHttp2Stream;
    exports.Http2ServerRequest = function() { throw notImpl('ServerRequest'); };
    exports.Http2ServerResponse = function() { throw notImpl('ServerResponse'); };
    exports.Http2Server = Http2Server;
    exports.getDefaultSettings = getDefaultSettings;
    exports.getPackedSettings = getPackedSettings;
    exports.getUnpackedSettings = getUnpackedSettings;
    exports.performServerHandshake = performServerHandshake;
    exports.sensitiveHeaders = SENSITIVE_HEADERS;
});

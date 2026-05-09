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
    // The HTTP daemon's auto-protocol listener serves both H1 and H2
    // over the same socket — hyper's auto Builder inspects the H2
    // connection preface and routes accordingly. Server-side http2
    // therefore reuses the http.createServer pipeline; the JS API
    // exposes both `'request'` (Node compat) and `'stream'` (h2-shape)
    // events for the same incoming request.
    var http = require('http');

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
    //
    // Each Http2Server wraps a real http.Server. Node distinguishes
    // `'request'` (h1-shape `(req, res)`) from `'stream'` (h2-shape
    // `(stream, headers, flags)`). We emit both: the user can attach
    // listeners to either and get the right shape. Callbacks passed
    // to createServer / createSecureServer are wired to `'request'`
    // (Node's default).

    function ServerHttp2Stream(req, res) {
        EventEmitter.call(this);
        this._req = req;
        this._res = res;
        this.id = (ServerHttp2Stream._nextId = (ServerHttp2Stream._nextId || 1) + 2);
        this.aborted = false;
        this.closed = false;
        this.session = null;
        this.pending = false;
        var self = this;
        // Pipe the incoming body into the stream's data/end emitter
        // so user code that consumes the stream as an EventEmitter
        // sees the same bytes the http req would.
        req.on('data', function(chunk) { self.emit('data', chunk); });
        req.on('end', function() { self.emit('end'); });
        req.on('error', function(err) { self.emit('error', err); });
    }
    ServerHttp2Stream.prototype = Object.create(EventEmitter.prototype);
    ServerHttp2Stream.prototype.constructor = ServerHttp2Stream;
    ServerHttp2Stream.prototype.respond = function(headers, _options) {
        var status = headers && headers[':status'] ? headers[':status'] : 200;
        var sendHeaders = {};
        if (headers) {
            var keys = Object.keys(headers);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (k.charAt(0) !== ':') sendHeaders[k] = headers[k];
            }
        }
        this._res.writeHead(status, sendHeaders);
    };
    ServerHttp2Stream.prototype.write = function(chunk, enc, cb) {
        return this._res.write(chunk, enc, cb);
    };
    ServerHttp2Stream.prototype.end = function(chunk, enc, cb) {
        return this._res.end(chunk, enc, cb);
    };
    ServerHttp2Stream.prototype.close = function(_code, cb) {
        this.closed = true;
        try { this._res.end(); } catch (_) {}
        if (typeof cb === 'function') Promise.resolve().then(cb);
    };
    ServerHttp2Stream.prototype.setTimeout = function(ms, cb) {
        if (this._res && typeof this._res.setTimeout === 'function') {
            this._res.setTimeout(ms, cb);
        }
        return this;
    };
    ServerHttp2Stream.prototype.priority = function(_options) {
        // RFC 9218 (Extensible Prioritization Scheme for HTTP) — h3
        // expresses priorities via the `priority` header. We forward
        // the urgency/incremental signals as that header so Node code
        // setting priorities still produces wire-visible output.
        var opts = _options || {};
        var urgency = (opts.weight != null) ? opts.weight | 0 : 16;
        var incremental = !!opts.exclusive ? '?1' : '?0';
        try {
            this._res.setHeader('priority',
                'u=' + urgency + ', i=' + incremental);
        } catch (_) {}
    };
    ServerHttp2Stream.prototype.sendTrailers = function(headers) {
        // Trailers are headers sent after the body. Node exposes
        // `res.addTrailers(headers)` on the underlying ServerResponse;
        // route through that so they actually land on the wire.
        if (!headers) return;
        if (typeof this._res.addTrailers === 'function') {
            this._res.addTrailers(headers);
            return;
        }
        // Last-resort: write them as a final chunk in
        // `key: value\r\n` form before end. Spec-incorrect but
        // produces visible bytes rather than dropping them.
        var keys = Object.keys(headers);
        var lines = '';
        for (var i = 0; i < keys.length; i++) {
            lines += keys[i] + ': ' + headers[keys[i]] + '\r\n';
        }
        if (lines) this._res.write(lines);
    };
    ServerHttp2Stream.prototype.respondWithFile = function(path, headers, options) {
        var self = this;
        var fs = require('fs');
        options = options || {};
        var stat;
        try {
            stat = fs.statSync(path);
        } catch (e) {
            // Run the optional `onError` per Node spec, then close
            // the stream with a 404.
            if (typeof options.onError === 'function') {
                try { options.onError(e); } catch (_) {}
            }
            self.respond({ ':status': 404 });
            self.end();
            return;
        }
        // Node disallows directories for respondWithFile per docs.
        if (stat.isDirectory && stat.isDirectory()) {
            var err = new Error('http2: respondWithFile path is a directory');
            err.code = 'ERR_HTTP2_SEND_FILE';
            if (typeof options.onError === 'function') options.onError(err);
            else self.emit('error', err);
            return;
        }

        var send = headers ? Object.assign({}, headers) : {};
        // Avoid colon-prefixed pseudo-headers leaking into a normal
        // response — strip them defensively.
        Object.keys(send).forEach(function(k) {
            if (k.charAt(0) === ':') delete send[k];
        });
        // Honour Node's offset/length window if the caller asked for
        // a partial-body send.
        var offset = (options.offset | 0) || 0;
        var length = options.length != null
            ? Math.min(options.length | 0, Math.max(0, stat.size - offset))
            : Math.max(0, stat.size - offset);
        if (send['content-length'] == null && send['Content-Length'] == null) {
            send['content-length'] = String(length);
        }
        if (send['last-modified'] == null && send['Last-Modified'] == null
            && stat.mtime instanceof Date) {
            send['last-modified'] = stat.mtime.toUTCString();
        }
        var status = (headers && (headers[':status'] || headers.status)) || 200;
        self.respond(Object.assign({ ':status': status }, send));

        if (length === 0) {
            self.end();
            return;
        }
        // Stream the file in 64 KiB chunks so we don't fault on
        // large bodies. fs.createReadStream supports start/end
        // (inclusive) which maps to offset/length here.
        var stream = fs.createReadStream(path, {
            start: offset,
            end: offset + length - 1,
            highWaterMark: 64 * 1024,
        });
        stream.on('data', function(chunk) { self.write(chunk); });
        stream.on('end', function() { self.end(); });
        stream.on('error', function(e) {
            if (typeof options.onError === 'function') options.onError(e);
            else self.emit('error', e);
            try { self.end(); } catch (_) {}
        });
    };

    function _h1ReqToH2Headers(req) {
        var h = {};
        h[':method'] = req.method;
        h[':path']   = req.url;
        h[':scheme'] = (req.socket && req.socket.encrypted) ? 'https' : 'http';
        h[':authority'] = req.headers && req.headers.host
            ? req.headers.host
            : ((req.connection && req.connection.localAddress) || 'localhost');
        if (req.headers) {
            var keys = Object.keys(req.headers);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i].toLowerCase();
                if (k === 'host') continue; // already in :authority
                h[k] = req.headers[keys[i]];
            }
        }
        return h;
    }

    function Http2Server(options) {
        EventEmitter.call(this);
        this._options = options || {};
        var self = this;
        // Underlying h1-shape server — daemon serves H2 transparently
        // when the client speaks h2 over the auto-builder listener.
        this._inner = http.createServer(function(req, res) {
            // Always emit 'request' (h1 shape) for compat. If anyone
            // listens to 'stream', also build the h2 shape.
            self.emit('request', req, res);
            if (self.listenerCount('stream') > 0) {
                var headers = _h1ReqToH2Headers(req);
                var stream = new ServerHttp2Stream(req, res);
                self.emit('stream', stream, headers, 0);
            }
        });
        // Re-emit underlying lifecycle events so callers that wait
        // for `'listening'` etc. don't miss them.
        this._inner.on('listening', function() { self.emit('listening'); });
        this._inner.on('close', function() { self.emit('close'); });
        this._inner.on('error', function(e) { self.emit('error', e); });
    }
    Http2Server.prototype = Object.create(EventEmitter.prototype);
    Http2Server.prototype.constructor = Http2Server;
    Http2Server.prototype.listen = function() {
        // Forward the same arguments — `(port[, host[, backlog]][, cb])`.
        this._inner.listen.apply(this._inner, arguments);
        return this;
    };
    Http2Server.prototype.close = function(cb) {
        return this._inner.close(cb);
    };
    Http2Server.prototype.address = function() {
        return this._inner.address ? this._inner.address() : null;
    };
    Http2Server.prototype.setTimeout = function(ms, cb) {
        if (this._inner.setTimeout) this._inner.setTimeout(ms, cb);
        return this;
    };
    Http2Server.prototype.ref = function() {
        if (this._inner.ref) this._inner.ref();
        return this;
    };
    Http2Server.prototype.unref = function() {
        if (this._inner.unref) this._inner.unref();
        return this;
    };

    function createServer(options, onRequest) {
        if (typeof options === 'function') { onRequest = options; options = undefined; }
        var srv = new Http2Server(options);
        if (typeof onRequest === 'function') srv.on('request', onRequest);
        return srv;
    }
    function createSecureServer(options, onRequest) {
        // Burn's daemon does TLS termination separately; the same
        // h2-or-h1 auto-negotiation runs on the cleartext socket.
        // Real TLS H2 will plumb through daemon_tls's ALPN once the
        // tls server adopts hyper-util's Builder.
        return createServer(options, onRequest);
    }

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
    function performServerHandshake() { return createServer(); }
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
    // Http2ServerRequest / Http2ServerResponse — Node exposes these
    // class shapes; we route through the underlying http req/res
    // instances which already have the right surface.
    exports.Http2ServerRequest = http.IncomingMessage || function() {};
    exports.Http2ServerResponse = http.ServerResponse || function() {};
    exports.ServerHttp2Stream = ServerHttp2Stream;
    exports.Http2Server = Http2Server;
    exports.getDefaultSettings = getDefaultSettings;
    exports.getPackedSettings = getPackedSettings;
    exports.getUnpackedSettings = getUnpackedSettings;
    exports.performServerHandshake = performServerHandshake;
    exports.sensitiveHeaders = SENSITIVE_HEADERS;
});

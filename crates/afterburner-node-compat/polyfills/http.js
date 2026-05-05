// http / https — outbound `request`/`get` + server-side
// `createServer` + IncomingMessage / ServerResponse.
//
// Outbound is a synchronous wrapper around `__host_http_request`.
// Server-side threads through the host's daemon-mode HTTP
// coordinator (`__host_http_listen` + `__host_http_reply`) — when
// user code calls `http.createServer(cb).listen(port)`, we register
// `cb` on `globalThis.__ab_http_handlers[server_id]`, and the
// plugin's `daemon_event` mode dispatches matching incoming
// requests back through it.

function __plenum_install_http(moduleName) {
    __register_module(moduleName, function(module, exports, require) {
        var EventEmitter = require('events');

        // -------- outbound request / get --------------------------------

        function requestImpl(opts, cb) {
            if (typeof globalThis.__host_http_request !== 'function') {
                throw new Error("Permission denied: http.request is not available");
            }
            var url = typeof opts === 'string' ? opts
                : (opts.protocol || 'http:') + '//' + (opts.host || opts.hostname)
                  + (opts.port ? ':' + opts.port : '') + (opts.path || '/');
            var method = (opts && opts.method) || 'GET';
            var body = opts && opts.body;

            var resultRaw = globalThis.__host_http_request(method, url, body || null);
            var result = JSON.parse(resultRaw);
            if (typeof result.body === 'string' && result.body.indexOf('__HOST_ERR__:') === 0) {
                var err = new Error("http: " + result.body.slice('__HOST_ERR__:'.length));
                if (err.message.toLowerCase().indexOf('permission denied') !== -1) err.code = 'EACCES';
                throw err;
            }

            // Shape the response like a minimal IncomingMessage.
            var resp = {
                statusCode: result.status,
                headers: {},
                body: result.body,
                _bodyRead: false,
                on: function(event, handler) {
                    if (event === 'data') { handler(result.body); return this; }
                    if (event === 'end')  { handler(); return this; }
                    return this;
                },
                setEncoding: function() {},
                text: function() { return Promise.resolve(result.body); },
                json: function() { return Promise.resolve(JSON.parse(result.body)); }
            };
            if (cb) cb(resp);
            return {
                end:   function() {},
                write: function() {},
                on:    function() { return this; }
            };
        }

        exports.request = requestImpl;
        exports.get     = function(opts, cb) { return requestImpl(opts, cb); };

        // -------- server-side createServer ------------------------------

        function createServer(requestListener) {
            var server = Object.create(EventEmitter.prototype);
            EventEmitter.call(server);

            if (typeof requestListener === 'function') {
                server.on('request', requestListener);
            }

            server.listen = function(portOrOpts, hostOrBacklogOrCb, backlogOrCb, cbArg) {
                // `.listen(port, [host], [backlog], [cb])` and
                // `.listen({port, host, backlog}, [cb])` — both shapes.
                var port;
                var cb;
                if (portOrOpts && typeof portOrOpts === 'object') {
                    port = portOrOpts.port;
                    cb = hostOrBacklogOrCb;
                } else {
                    port = portOrOpts;
                    if (typeof hostOrBacklogOrCb === 'function') cb = hostOrBacklogOrCb;
                    else if (typeof backlogOrCb === 'function') cb = backlogOrCb;
                    else if (typeof cbArg === 'function')       cb = cbArg;
                }
                if (typeof port !== 'number') {
                    throw new TypeError('http.listen: port must be a number');
                }
                if (typeof globalThis.__host_http_listen !== 'function') {
                    // Library one-shot / no daemon — surface as an
                    // async error event rather than a synchronous
                    // throw so `server.on('error', …)` catches it,
                    // matching Node's listen-failure contract.
                    queueMicrotask(function() {
                        var e = new Error('http.listen requires daemon mode (run via `burn` CLI)');
                        e.code = 'EACCES';
                        server.emit('error', e);
                    });
                    return server;
                }
                var id = globalThis.__host_http_listen(port);
                if (id <= 0) {
                    // B2b: -1 = no daemon (EACCES), -2 = EADDRINUSE,
                    // -3 = other IO. Node emits 'error' async — we
                    // match so `server.on('error', …)` handlers run.
                    queueMicrotask(function() {
                        var err = new Error('http.listen failed (code ' + id + ')');
                        if (id === -1) err.code = 'EACCES';
                        else if (id === -2) err.code = 'EADDRINUSE';
                        else err.code = 'EIO';
                        err.port = port;
                        server.emit('error', err);
                    });
                    return server;
                }
                server._serverId = id;
                server._port = port;

                if (!globalThis.__ab_http_handlers) globalThis.__ab_http_handlers = {};
                globalThis.__ab_http_handlers[id] = function(req, res) {
                    server.emit('request', req, res);
                };

                if (cb) {
                    // Node fires the listen callback async — we match
                    // with queueMicrotask so userland observing order
                    // doesn't diverge.
                    queueMicrotask(function() { cb(); });
                }
                server.emit('listening');
                return server;
            };

            server.close = function(cb) {
                var id = server._serverId;
                if (id && globalThis.__ab_http_handlers) {
                    delete globalThis.__ab_http_handlers[id];
                }
                // B2b: release the port so a subsequent `.listen(port)`
                // on the same port succeeds. No-op if the host import
                // isn't installed (library/no-daemon path).
                if (id && typeof globalThis.__host_http_close === 'function') {
                    globalThis.__host_http_close(id);
                }
                server._serverId = undefined;
                if (cb) queueMicrotask(function() { cb(); });
                server.emit('close');
                return server;
            };

            // Address info stub — Node exposes server.address() returning
            // `{port, family, address}` post-listen.
            server.address = function() {
                if (!server._serverId) return null;
                return { port: server._port, family: 'IPv4', address: '0.0.0.0' };
            };

            return server;
        }

        exports.createServer = createServer;

        // Install the daemon-event dispatcher's `req`/`res` builder on
        // globalThis so the plugin's JS dispatcher (see
        // `afterburner-plugin/src/modes/daemon_event.rs`) can find it
        // regardless of module-load order within user code.
        globalThis.__ab_build_reqres = function(ev) {
            return {
                req: __ab_make_incoming_message(ev.req || {}),
                res: __ab_make_server_response(ev.req_id || 0)
            };
        };

        function __ab_make_incoming_message(reqData) {
            var msg = Object.create(EventEmitter.prototype);
            EventEmitter.call(msg);
            msg.method = reqData.method || 'GET';
            msg.url = reqData.url || '/';
            msg.headers = reqData.headers || {};
            msg.httpVersion = reqData.httpVersion || '1.1';
            // Stream-ish: body arrives as one chunk then 'end'. Deliver in
            // a microtask so listeners attached synchronously after the
            // handler starts still see the data event.
            //
            // Chunk type matters: real Node `IncomingMessage` emits
            // `Buffer`s unless `setEncoding` was called. body-parser /
            // multer / busboy all collect chunks then call
            // `Buffer.concat(chunks)` at `'end'`, which throws if any
            // chunk is a string. Wrap string bodies as Buffer; pass
            // through already-binary inputs.
            var body = reqData.body;
            var delivered = false;
            function deliver() {
                if (delivered) return;
                delivered = true;
                if (body !== undefined && body !== null && body !== '') {
                    var Buf = require('buffer').Buffer;
                    var chunk;
                    if (typeof body === 'string') {
                        chunk = Buf.from(body, 'utf8');
                    } else if (Buf.isBuffer && Buf.isBuffer(body)) {
                        chunk = body;
                    } else if (body && typeof body.byteLength === 'number') {
                        // ArrayBuffer / TypedArray — wrap as Buffer
                        // (zero-copy in real Node; copy here for
                        // simplicity since we're already in user-mode
                        // QuickJS).
                        chunk = Buf.from(body);
                    } else {
                        chunk = Buf.from(String(body), 'utf8');
                    }
                    msg.emit('data', chunk);
                }
                msg.emit('end');
            }
            msg._deliver = deliver;
            queueMicrotask(deliver);

            // Convenience: req.text() / req.json() so handlers that want
            // the body in one shot don't need to wire data/end manually.
            msg.text = function() { return Promise.resolve(body); };
            msg.json = function() {
                return new Promise(function(resolve, reject) {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            };
            return msg;
        }

        function __ab_make_server_response(reqId) {
            var res = Object.create(EventEmitter.prototype);
            EventEmitter.call(res);
            res.statusCode = 200;
            res.statusMessage = undefined;
            res._headers = {};
            res._buffered = '';
            res.writableEnded = false;
            res.headersSent = false;

            res.setHeader = function(name, value) {
                res._headers[String(name).toLowerCase()] = String(value);
                return res;
            };
            res.getHeader = function(name) {
                return res._headers[String(name).toLowerCase()];
            };
            res.hasHeader = function(name) {
                return Object.prototype.hasOwnProperty.call(
                    res._headers, String(name).toLowerCase()
                );
            };
            res.removeHeader = function(name) {
                delete res._headers[String(name).toLowerCase()];
            };
            res.writeHead = function(status, messageOrHeaders, maybeHeaders) {
                res.statusCode = status;
                var headers;
                if (typeof messageOrHeaders === 'string') {
                    res.statusMessage = messageOrHeaders;
                    headers = maybeHeaders;
                } else {
                    headers = messageOrHeaders;
                }
                if (headers) {
                    Object.keys(headers).forEach(function(k) {
                        res.setHeader(k, headers[k]);
                    });
                }
                return res;
            };
            res.write = function(chunk) {
                if (res.writableEnded) throw new Error('write after end');
                res._buffered += chunk != null ? String(chunk) : '';
                return true;
            };
            res.end = function(chunk) {
                if (res.writableEnded) return;
                if (chunk != null) res._buffered += String(chunk);
                res.writableEnded = true;
                var payload = {
                    status: res.statusCode,
                    headers: res._headers,
                    body: res._buffered
                };
                if (typeof globalThis.__host_http_reply === 'function') {
                    globalThis.__host_http_reply(Number(reqId), JSON.stringify(payload));
                }
                res.emit('finish');
                res.emit('close');
            };

            return res;
        }

        // Expose the helpers on the http module too so tests and
        // advanced consumers can build req/res directly if they need
        // to.
        exports._makeIncomingMessage = __ab_make_incoming_message;
        exports._makeServerResponse  = __ab_make_server_response;

        // `http.METHODS` — sorted, frozen array of every HTTP method
        // Node recognises. Express 5's `lib/utils.js` does
        // `const { METHODS } = require('node:http')` at module load
        // and crashes with `cannot read property 'map' of undefined`
        // when the export is missing. The set below matches Node 22's
        // exposed list.
        exports.METHODS = Object.freeze([
            'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET',
            'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY',
            'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH',
            'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'REBIND',
            'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND',
            'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
        ]);

        // `http.STATUS_CODES` — { numeric-status: reason-phrase } map.
        // Used by `finalhandler`, body-parser error responses, and any
        // npm package that maps status numbers to default text. Node's
        // own list is the IANA-registered set; we ship the same.
        exports.STATUS_CODES = {
            100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
            103: 'Early Hints',
            200: 'OK', 201: 'Created', 202: 'Accepted',
            203: 'Non-Authoritative Information', 204: 'No Content',
            205: 'Reset Content', 206: 'Partial Content',
            207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used',
            300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
            303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy',
            307: 'Temporary Redirect', 308: 'Permanent Redirect',
            400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
            403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
            406: 'Not Acceptable', 407: 'Proxy Authentication Required',
            408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
            411: 'Length Required', 412: 'Precondition Failed',
            413: 'Payload Too Large', 414: 'URI Too Long',
            415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
            417: 'Expectation Failed', 418: "I'm a Teapot",
            421: 'Misdirected Request', 422: 'Unprocessable Entity',
            423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early',
            426: 'Upgrade Required', 428: 'Precondition Required',
            429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
            451: 'Unavailable For Legal Reasons',
            500: 'Internal Server Error', 501: 'Not Implemented',
            502: 'Bad Gateway', 503: 'Service Unavailable',
            504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
            506: 'Variant Also Negotiates', 507: 'Insufficient Storage',
            508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded',
            510: 'Not Extended', 511: 'Network Authentication Required',
        };

        // Minimal Server/IncomingMessage/ServerResponse constructors.
        // The prototypes inherit from `EventEmitter.prototype` so npm
        // packages that walk `Object.getPrototypeOf(req)` (Express's
        // `setPrototypeOf(req, app.request)` lands the prototype on
        // top of `http.IncomingMessage.prototype`) still find the
        // EventEmitter methods (`on`, `emit`, `once`, `removeListener`).
        // Without the inheritance, Express's request loses `.on` after
        // its init middleware re-roots the prototype chain, and
        // `body-parser`'s `raw-body` throws "argument stream must be
        // a stream".
        //
        // The constructors themselves are not callable — instances
        // come from the `_make*` factories. The classes exist for
        // `instanceof` checks and for npm consumers that read
        // `http.IncomingMessage.prototype`.
        exports.Server = function Server() {
            throw new Error('new http.Server() is not implemented; use http.createServer()');
        };
        exports.IncomingMessage = function IncomingMessage() {
            throw new Error('new http.IncomingMessage() is not implemented');
        };
        exports.IncomingMessage.prototype = Object.create(EventEmitter.prototype);
        exports.IncomingMessage.prototype.constructor = exports.IncomingMessage;
        exports.ServerResponse = function ServerResponse() {
            throw new Error('new http.ServerResponse() is not implemented');
        };
        exports.ServerResponse.prototype = Object.create(EventEmitter.prototype);
        exports.ServerResponse.prototype.constructor = exports.ServerResponse;
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

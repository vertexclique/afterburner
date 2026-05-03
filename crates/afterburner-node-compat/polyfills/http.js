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
            var body = reqData.body || '';
            var delivered = false;
            function deliver() {
                if (delivered) return;
                delivered = true;
                if (body) msg.emit('data', body);
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

        // Minimal Server/IncomingMessage/ServerResponse constructors
        // for `instanceof` checks. The real prototypes are event-
        // emitter instances; these are forward-compatible placeholders.
        exports.Server = function Server() {
            throw new Error('new http.Server() is not implemented; use http.createServer()');
        };
        exports.IncomingMessage = function IncomingMessage() {
            throw new Error('new http.IncomingMessage() is not implemented');
        };
        exports.ServerResponse = function ServerResponse() {
            throw new Error('new http.ServerResponse() is not implemented');
        };
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

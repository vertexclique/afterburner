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
            if (typeof globalThis.__host_http_request !== 'function'
                && typeof globalThis.__host_http_request_async !== 'function') {
                throw new Error("Permission denied: http.request is not available");
            }
            var url;
            if (typeof opts === 'string') {
                url = opts;
            } else if (opts && typeof opts.url === 'string') {
                url = opts.url;
            } else {
                url = (opts.protocol || 'http:') + '//' + (opts.host || opts.hostname)
                    + (opts.port ? ':' + opts.port : '') + (opts.path || '/');
            }
            var method = (opts && opts.method) || 'GET';
            var body = opts && opts.body;

            // Prefer the async path when a daemon is attached. The
            // sync function still runs the request inline on the wasm
            // thread; the async one dispatches onto Tokio and the
            // shard event loop fans the response back through a
            // `daemon-event`. Real Node-style: caller awaits a Promise
            // that resolves when the host signals completion, instead
            // of blocking the wasm thread for the full round-trip.
            var asyncFn = globalThis.__host_http_request_async;
            var asyncReqId = -1;
            var resultPromise = null;
            if (typeof asyncFn === 'function') {
                try {
                    var rid = asyncFn(method, url, body || null);
                    if (typeof rid === 'bigint') rid = Number(rid);
                    if (typeof rid === 'number' && rid > 0) {
                        asyncReqId = rid;
                        resultPromise = new Promise(function(resolve) {
                            if (!globalThis.__ab_http_pending) globalThis.__ab_http_pending = {};
                            globalThis.__ab_http_pending[asyncReqId] = { resolve: resolve };
                        });
                    }
                } catch (_) {
                    // fall through to sync path
                }
            }

            // The whole `result → resp → emit` pipeline is wrapped in
            // `buildAndDispatch` so the same code path covers both
            // the sync and async flavours. Sync calls it immediately
            // with the just-fetched result; async chains it onto the
            // Promise the daemon resolves when the response arrives.
            var Buffer = require('buffer').Buffer;
            var EventEmitter = require('events');
            var req = Object.create(EventEmitter.prototype);
            EventEmitter.call(req);
            req.end          = function() { return req; };
            req.write        = function() { return true; };
            req.setHeader    = function() { return req; };
            req.getHeader    = function() {};
            req.removeHeader = function() {};
            req.setTimeout   = function() { return req; };
            req.destroy      = function() { return req; };
            req.abort        = function() { return req; };
            req.flushHeaders = function() { return req; };
            req.socket = { setKeepAlive: function() {}, setTimeout: function() {}, unref: function() {}, ref: function() {} };
            req.connection = req.socket;

            function buildAndDispatch(result) {
                if (typeof result.body === 'string' && result.body.indexOf('__HOST_ERR__:') === 0) {
                    var hostErr = new Error("http: " + result.body.slice('__HOST_ERR__:'.length));
                    if (hostErr.message.toLowerCase().indexOf('permission denied') !== -1) hostErr.code = 'EACCES';
                    Promise.resolve().then(function() {
                        try { req.emit('socket', req.socket); } catch (_) {}
                        req.emit('error', hostErr);
                    });
                    return req;
                }
                if (typeof result.error === 'string' && result.error.length > 0) {
                    var hostErr2 = new Error("http: " + result.error);
                    Promise.resolve().then(function() {
                        try { req.emit('socket', req.socket); } catch (_) {}
                        req.emit('error', hostErr2);
                    });
                    return req;
                }
                var resp = makeResp(result, method, url);
                Promise.resolve().then(function() {
                    try { req.emit('socket', req.socket); } catch (_) {}
                    if (cb) {
                        try { cb(resp); } catch (e) { req.emit('error', e); return; }
                    }
                    req.emit('response', resp);
                });
                return req;
            }

            if (asyncReqId > 0) {
                resultPromise.then(buildAndDispatch);
                return req;
            }
            return buildAndDispatch(result);
        }

        // makeResp / IncomingMessage factory — extracted so both the
        // sync and async dispatch paths share one shape. `result` is
        // the host envelope: `{status, headers, body, body_b64,
        // error?}`. Returns a Node-shaped IncomingMessage with the
        // full readable-stream surface our consumers (npm, undici,
        // node-fetch / minipass-fetch) require.
        function makeResp(result, method, url) {
            // Shape the response like a Node IncomingMessage with a
            // working EventEmitter contract plus the readable-stream
            // pieces user code commonly touches: `.resume()`,
            // `.pause()`, `.pipe(dest)`, `.read()`, async iteration.
            // The body is materialised eagerly by the host bridge — we
            // just have to stage it through the listener queue so user
            // code that registers handlers AFTER the cb fires (the
            // normal Node pattern) still sees `data` + `end`. We
            // prefer the host's base64 body when it is sent (binary-
            // safe, what npm tar / pacote requires) and fall back to
            // the lossy UTF-8 body for legacy callers that read text.
            var bodyBytes = null;
            if (typeof result.body_b64 === 'string') {
                try { bodyBytes = Buffer.from(result.body_b64, 'base64'); }
                catch (_) { bodyBytes = null; }
            }
            if (!bodyBytes && typeof result.body === 'string') {
                bodyBytes = Buffer.from(result.body, 'utf8');
            }
            if (!bodyBytes) bodyBytes = Buffer.alloc(0);

            var resp = Object.create(EventEmitter.prototype);
            EventEmitter.call(resp);
            resp.statusCode    = result.status;
            resp.statusMessage = '';
            resp.httpVersion   = '1.1';
            resp.headers       = result.headers && typeof result.headers === 'object' ? result.headers : {};
            resp.rawHeaders    = [];
            for (var hk in resp.headers) {
                resp.rawHeaders.push(hk, resp.headers[hk]);
            }
            resp.trailers      = {};
            resp.method        = method;
            resp.url           = url;
            resp.complete      = false;
            resp.readable      = true;
            resp.readableEnded = false;
            resp.body          = result.body;
            resp._bodyBytes    = bodyBytes;
            var _paused = true; // start paused — drain on first listener / resume()
            var _flushed = false;
            // Encoding switch — `setEncoding('utf8')` etc. tells Node
            // to deliver string chunks instead of Buffers. We honor
            // this so libraries that probe via `setEncoding` then
            // collect string output keep their post-conditions.
            var _encoding = null;
            function flushBody() {
                if (_flushed) return;
                _flushed = true;
                resp.complete      = true;
                resp.readableEnded = true;
                if (bodyBytes && bodyBytes.length > 0) {
                    var chunk = _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
                    resp.emit('data', chunk);
                }
                resp.emit('end');
                resp.emit('close');
            }
            // Schedule the flush as a microtask so user code has a
            // chance to register `data` / `end` / `close` listeners
            // *after* calling `resume()` — the canonical Node pattern.
            // Microtasks fire after the current synchronous turn but
            // before any timer callback, so the outer envelope's
            // `await` reliably drains them even for one-shot scripts.
            function maybeFlush() {
                if (_paused || _flushed) return;
                Promise.resolve().then(flushBody);
            }
            resp.resume      = function() { _paused = false; maybeFlush(); return resp; };
            resp.pause       = function() { _paused = true; return resp; };
            resp.setEncoding = function(enc) {
                if (typeof enc === 'string') _encoding = enc.toLowerCase() === 'utf8' ? 'utf8' : enc;
                return resp;
            };
            resp.read        = function() {
                if (_flushed) return null;
                _flushed = true;
                resp.complete = true;
                resp.readableEnded = true;
                return _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
            };
            resp.destroy     = function(err) {
                if (err) resp.emit('error', err);
                resp.emit('close');
                return resp;
            };
            resp.unpipe      = function() { return resp; };
            // Convenience body-shaping helpers (Undici `.text()`/`.json()`
            // shape) — handy for fetch-flavoured callers.
            resp.text        = function() {
                return Promise.resolve(bodyBytes.toString('utf8'));
            };
            resp.json        = function() {
                try { return Promise.resolve(JSON.parse(bodyBytes.toString('utf8'))); }
                catch (e) { return Promise.reject(e); }
            };
            // Auto-resume when a `data` listener attaches (Node's
            // backwards-compat path: registering a `data` listener
            // implicitly switches the stream to flowing mode).
            var origOn = resp.on.bind(resp);
            resp.on = resp.addListener = function(event, handler) {
                origOn(event, handler);
                if (event === 'data' || event === 'readable') {
                    _paused = false;
                    maybeFlush();
                }
                return resp;
            };
            resp.pipe = function(dest) {
                resp.on('data', function(chunk) { if (dest && dest.write) dest.write(chunk); });
                resp.on('end',  function()      { if (dest && dest.end)   dest.end(); });
                _paused = false;
                maybeFlush();
                return dest;
            };
            // Async-iterator support so `for await (const chunk of res)`
            // works. Single-chunk: yield the body once and end. Yield
            // a Buffer (or encoded string when setEncoding was set)
            // so binary callers (npm tar, image decoders) get bytes.
            if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
                resp[Symbol.asyncIterator] = function() {
                    var done = false;
                    return {
                        next: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            _flushed = true;
                            resp.complete = true;
                            resp.readableEnded = true;
                            var v = _encoding ? bodyBytes.toString(_encoding) : bodyBytes;
                            return Promise.resolve({ value: v, done: false });
                        },
                        return: function() { done = true; return Promise.resolve({ value: undefined, done: true }); },
                    };
                };
            }
            return resp;
        }

        // Node accepts both `(url[, options][, cb])` and
        // `(options[, cb])`. Coalesce the URL+options form into a
        // single opts object before handing off — corepack /
        // node-fetch / pacote all reach for the 3-arg shape.
        function normaliseRequestArgs(args) {
            var arr = Array.prototype.slice.call(args);
            var cb = (arr.length && typeof arr[arr.length - 1] === 'function') ? arr.pop() : undefined;
            var first = arr[0];
            var second = arr[1];
            var opts;
            if (typeof first === 'string') {
                opts = (second && typeof second === 'object') ? Object.assign({}, second) : {};
                // Stash the URL string for requestImpl's url-or-opts branch.
                opts.url = first;
                // Decompose the URL the cheap way so opts.hostname/port
                // are usable when callers downstream introspect.
                var m = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?/i.exec(first);
                if (m) {
                    if (!opts.protocol) opts.protocol = m[1] + ':';
                    if (!opts.hostname) opts.hostname = m[2];
                    if (!opts.port && m[3]) opts.port = parseInt(m[3], 10);
                    if (!opts.path) opts.path = (m[4] || '/') + (m[5] || '');
                }
            } else {
                opts = first || {};
            }
            return { opts: opts, cb: cb };
        }
        exports.request = function() {
            var n = normaliseRequestArgs(arguments);
            return requestImpl(n.opts, n.cb);
        };
        exports.get = function() {
            var n = normaliseRequestArgs(arguments);
            // Node's `get` auto-ends the request and forces GET.
            if (n.opts && typeof n.opts === 'object') n.opts.method = n.opts.method || 'GET';
            return requestImpl(n.opts, n.cb);
        };

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

        // `http.Agent` / `https.Agent` — minimal constructable stand-ins.
        // npm's @npmcli/agent and many keep-alive helpers do
        // `class MyAgent extends http.Agent { ... }` at module-init time.
        // Without a real constructor here that fails QuickJS's
        // "parent class must be constructor" guard before any user
        // logic runs. We don't pool sockets (host bridge owns
        // connections); the class exists so subclasses can
        // instantiate.
        function Agent(opts) {
            EventEmitter.call(this);
            this.options    = opts || {};
            this.keepAlive  = !!(this.options.keepAlive);
            this.maxSockets = this.options.maxSockets || Infinity;
            this.maxFreeSockets = this.options.maxFreeSockets || 256;
            this.requests   = {};
            this.sockets    = {};
            this.freeSockets = {};
            this.protocol   = (moduleName === 'https') ? 'https:' : 'http:';
        }
        Agent.prototype = Object.create(EventEmitter.prototype);
        Agent.prototype.constructor = Agent;
        Agent.prototype.addRequest    = function() {};
        Agent.prototype.createConnection = function() { return null; };
        Agent.prototype.keepSocketAlive  = function() { return false; };
        Agent.prototype.reuseSocket      = function() {};
        Agent.prototype.destroy          = function() {};
        Agent.prototype.getName          = function() { return 'afterburner-agent'; };
        exports.Agent = Agent;
        // The default global agent (Node exposes it; libraries pass it
        // around). Single instance, idempotent across requires.
        if (!globalThis.__plenum_default_agents) globalThis.__plenum_default_agents = {};
        if (!globalThis.__plenum_default_agents[moduleName]) {
            globalThis.__plenum_default_agents[moduleName] = new Agent({ keepAlive: false });
        }
        exports.globalAgent = globalThis.__plenum_default_agents[moduleName];

        // ClientRequest — same posture as Server / IncomingMessage:
        // exists for `instanceof` plus prototype reads, not callable.
        function ClientRequest() {
            throw new Error('new http.ClientRequest() is not implemented; use http.request()');
        }
        ClientRequest.prototype = Object.create(EventEmitter.prototype);
        ClientRequest.prototype.constructor = ClientRequest;
        exports.ClientRequest = ClientRequest;

        // OutgoingMessage — base class some libs subclass.
        function OutgoingMessage() { EventEmitter.call(this); }
        OutgoingMessage.prototype = Object.create(EventEmitter.prototype);
        OutgoingMessage.prototype.constructor = OutgoingMessage;
        OutgoingMessage.prototype.setHeader = function() {};
        OutgoingMessage.prototype.getHeader = function() {};
        OutgoingMessage.prototype.removeHeader = function() {};
        OutgoingMessage.prototype.write = function() { return true; };
        OutgoingMessage.prototype.end = function() {};
        exports.OutgoingMessage = OutgoingMessage;

        // Maximum number of sockets allowed per host — Node default is
        // Infinity, but some libraries read it. Match Node.
        exports.maxHeaderSize = 16384;
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

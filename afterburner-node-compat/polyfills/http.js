// http / https — synchronous `request`/`get` wrappers around
// `__host_http_request`. No streaming, no keep-alive — scripts that need
// those features should move to a pipeline host.

function __plenum_install_http(moduleName) {
    __register_module(moduleName, function(module, exports, require) {

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
    });
}
__plenum_install_http('http');
__plenum_install_http('https');

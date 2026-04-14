// fetch / Request / Response / Headers — Web API, synchronous under
// the hood (our http host is sync) but Promise-wrapped to match the
// standard interface.

(function installFetch() {
    if (typeof globalThis.fetch === 'function') return;

    function Headers(init) {
        this._m = Object.create(null);
        if (!init) return;
        if (init instanceof Headers) {
            for (var k in init._m) this._m[k] = init._m[k];
            return;
        }
        if (Array.isArray(init)) {
            for (var i = 0; i < init.length; i++) this.set(init[i][0], init[i][1]);
            return;
        }
        var keys = Object.keys(init);
        for (var j = 0; j < keys.length; j++) this.set(keys[j], init[keys[j]]);
    }
    Headers.prototype.get = function(k)       { return this._m[String(k).toLowerCase()] || null; };
    Headers.prototype.has = function(k)       { return String(k).toLowerCase() in this._m; };
    Headers.prototype.set = function(k, v)    { this._m[String(k).toLowerCase()] = String(v); };
    Headers.prototype.append = function(k, v) {
        var key = String(k).toLowerCase();
        this._m[key] = (this._m[key] ? this._m[key] + ', ' : '') + String(v);
    };
    Headers.prototype['delete'] = function(k) { delete this._m[String(k).toLowerCase()]; };
    Headers.prototype.forEach = function(cb)  {
        var keys = Object.keys(this._m);
        for (var i = 0; i < keys.length; i++) cb(this._m[keys[i]], keys[i], this);
    };
    Headers.prototype.entries = function() {
        var keys = Object.keys(this._m);
        var self = this;
        var i = 0;
        return { next: function() {
            if (i >= keys.length) return { done: true };
            var k = keys[i++];
            return { value: [k, self._m[k]], done: false };
        } };
    };

    function Request(url, init) {
        init = init || {};
        this.url = String(url);
        this.method = (init.method || 'GET').toUpperCase();
        this.headers = new Headers(init.headers);
        this.body = init.body != null ? String(init.body) : null;
        this.signal = init.signal || null;
    }

    function Response(body, init) {
        init = init || {};
        this._body = body != null ? String(body) : '';
        this.status = init.status !== undefined ? init.status : 200;
        this.statusText = init.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(init.headers);
        this.url = init.url || '';
        this.bodyUsed = false;
    }
    Response.prototype.text = function() {
        if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
        this.bodyUsed = true;
        return Promise.resolve(this._body);
    };
    Response.prototype.json = function() {
        return this.text().then(function(s) { return JSON.parse(s); });
    };
    Response.prototype.arrayBuffer = function() {
        var Buffer = require('buffer').Buffer;
        return this.text().then(function(s) {
            return Buffer.from(s, 'utf8').buffer;
        });
    };
    Response.prototype.clone = function() {
        var r = new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
        return r;
    };

    function fetch(input, init) {
        var req = input instanceof Request ? input : new Request(input, init);
        if (req.signal && req.signal.aborted) {
            return Promise.reject(req.signal.reason || new Error('Aborted'));
        }
        if (typeof globalThis.__host_http_request !== 'function') {
            return Promise.reject(new Error('fetch: net capability not granted'));
        }
        var raw = globalThis.__host_http_request(req.method, req.url, req.body);
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { return Promise.reject(new Error('fetch: malformed host response: ' + e.message)); }
        if (typeof parsed.body === 'string' && parsed.body.indexOf('__HOST_ERR__:') === 0) {
            return Promise.reject(new Error('fetch: ' + parsed.body.slice('__HOST_ERR__:'.length)));
        }
        var resp = new Response(parsed.body, { status: parsed.status, url: req.url });
        return Promise.resolve(resp);
    }

    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
})();

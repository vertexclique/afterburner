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
    Headers.prototype.keys = function() {
        var keys = Object.keys(this._m);
        var i = 0;
        return { next: function() {
            if (i >= keys.length) return { done: true };
            return { value: keys[i++], done: false };
        } };
    };
    Headers.prototype.values = function() {
        var keys = Object.keys(this._m);
        var self = this;
        var i = 0;
        return { next: function() {
            if (i >= keys.length) return { done: true };
            return { value: self._m[keys[i++]], done: false };
        } };
    };
    Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
    /// Headers.prototype.getSetCookie — Node 19+. Returns each
    /// Set-Cookie header as a separate array entry. Our internal
    /// storage joins same-name headers with `, `; Set-Cookie is
    /// the one header where that join is wrong per spec, but we
    /// recover by splitting on the canonical separator.
    Headers.prototype.getSetCookie = function() {
        var raw = this._m['set-cookie'];
        if (!raw) return [];
        // Split on `, ` only when the next chunk looks like a new
        // cookie name (matches `[A-Za-z0-9!#$%&'*+\-.^_`|~]+=`).
        // Single-cookie value may contain `, ` inside `Expires=...`
        // weekday names — naive split would corrupt those.
        var parts = [];
        var cur = '';
        var i = 0;
        while (i < raw.length) {
            if (raw[i] === ',' && raw[i + 1] === ' ') {
                // Lookahead: does what's next look like NAME= ?
                var j = i + 2;
                var k = j;
                while (k < raw.length && /[A-Za-z0-9!#$%&'*+\-.^_`|~]/.test(raw[k])) k++;
                if (k > j && raw[k] === '=') {
                    parts.push(cur);
                    cur = '';
                    i = j;
                    continue;
                }
            }
            cur += raw[i++];
        }
        if (cur) parts.push(cur);
        return parts;
    };

    function Request(url, init) {
        init = init || {};
        // If a Request instance is passed in, copy its fields then
        // overlay the init (matching the spec's `new Request(req,
        // {...})` cloning shape).
        if (url && typeof url === 'object' && url instanceof Request) {
            this.url = url.url;
            this.method = url.method;
            this.headers = new Headers(url.headers);
            this.body = url.body;
            this.signal = url.signal;
            this.redirect = url.redirect;
            this.cache = url.cache;
            this.credentials = url.credentials;
            this.mode = url.mode;
            this.referrer = url.referrer;
            this.referrerPolicy = url.referrerPolicy;
            this.integrity = url.integrity;
            this.keepalive = url.keepalive;
        } else {
            this.url = String(url);
            this.method = 'GET';
            this.headers = new Headers();
            this.body = null;
            this.signal = null;
            this.redirect = 'follow';
            this.cache = 'default';
            this.credentials = 'same-origin';
            this.mode = 'cors';
            this.referrer = '';
            this.referrerPolicy = '';
            this.integrity = '';
            this.keepalive = false;
        }
        // Apply init overlays on top.
        if (init.method) this.method = String(init.method).toUpperCase();
        if (init.headers) this.headers = new Headers(init.headers);
        if (init.body != null) this.body = String(init.body);
        if (init.signal !== undefined) this.signal = init.signal;
        if (init.redirect) this.redirect = init.redirect;
        if (init.cache) this.cache = init.cache;
        if (init.credentials) this.credentials = init.credentials;
        if (init.mode) this.mode = init.mode;
        if (init.referrer != null) this.referrer = String(init.referrer);
        if (init.referrerPolicy) this.referrerPolicy = init.referrerPolicy;
        if (init.integrity) this.integrity = init.integrity;
        if (init.keepalive !== undefined) this.keepalive = !!init.keepalive;
    }
    Request.prototype.clone = function() { return new Request(this); };

    function Response(body, init) {
        init = init || {};
        // Body storage: prefer `bodyB64` (authoritative bytes) if
        // provided, fall back to `body` string (lossy-utf8 text view).
        this._bodyText = body != null ? String(body) : '';
        this._bodyB64 = init.bodyB64 || null;
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
        // Decode base64 → utf8 when binary bytes are authoritative so
        // text() sees proper decoded characters rather than the lossy
        // roundtrip.
        if (this._bodyB64 !== null) {
            var Buffer = require('buffer').Buffer;
            return Promise.resolve(Buffer.from(this._bodyB64, 'base64').toString('utf8'));
        }
        return Promise.resolve(this._bodyText);
    };
    Response.prototype.json = function() {
        return this.text().then(function(s) { return JSON.parse(s); });
    };
    Response.prototype.arrayBuffer = function() {
        if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
        this.bodyUsed = true;
        var Buffer = require('buffer').Buffer;
        // `bodyB64` roundtrips binary losslessly; fall back to utf8
        // encode of the text view when the host didn't provide it.
        if (this._bodyB64 !== null) {
            var buf = Buffer.from(this._bodyB64, 'base64');
            return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
        }
        return Promise.resolve(Buffer.from(this._bodyText, 'utf8').buffer);
    };
    Response.prototype.clone = function() {
        var r = new Response(this._bodyText, {
            status: this.status,
            statusText: this.statusText,
            headers: this.headers,
            url: this.url,
            bodyB64: this._bodyB64,
        });
        return r;
    };
    /// Response.json(data, init) — Node 18.0+. Serialises `data` and
    /// returns a Response with `Content-Type: application/json`.
    Response.json = function(data, init) {
        init = init || {};
        var headers = new Headers(init.headers || {});
        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
        return new Response(JSON.stringify(data), {
            status: init.status,
            statusText: init.statusText,
            headers: headers,
            url: init.url,
        });
    };
    /// Response.error() — Node 18.0+. Synthesises a network-error
    /// response: status 0, empty body, type 'error'.
    Response.error = function() {
        var r = new Response('', { status: 0, statusText: '' });
        r.type = 'error';
        return r;
    };
    /// Response.redirect(url, status) — Node 18.0+. Returns a Response
    /// with the URL in `Location:` and the given redirect status.
    Response.redirect = function(url, status) {
        status = status || 302;
        if (status < 300 || status >= 400) {
            throw new RangeError('Response.redirect: invalid status ' + status);
        }
        return new Response('', {
            status: status,
            headers: { Location: String(url) },
        });
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
        var resp = new Response(parsed.body, {
            status: parsed.status,
            url: req.url,
            bodyB64: parsed.body_b64 || null,
        });
        return Promise.resolve(resp);
    }

    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
})();

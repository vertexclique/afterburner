// Small Web-API polyfills that most Node.js scripts now assume. Wired
// as globals, not modules, to match the browser/Node semantics.

(function installWebCompat() {
    // structuredClone — ES2022. QuickJS-NG typically has it; fall back
    // to a JSON deep-copy so scripts don't blow up if this runtime
    // doesn't.
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = function(value) {
            if (value === undefined) return undefined;
            return JSON.parse(JSON.stringify(value));
        };
    }

    // performance.now — no monotonic clock inside the sandbox, but
    // Date.now gives us something non-decreasing for most practical
    // purposes. Hrtime-style scripts won't crash.
    if (typeof globalThis.performance !== 'object' || typeof globalThis.performance.now !== 'function') {
        globalThis.performance = globalThis.performance || {};
        globalThis.performance.now = function() { return Date.now(); };
    }

    // `queueMicrotask` — schedule a microtask. QuickJS supports
    // Promise.then which gives us the microtask queue for free.
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            Promise.resolve().then(fn);
        };
    }

    // `btoa` / `atob` — base64 encoders. QuickJS doesn't ship these.
    if (typeof globalThis.btoa !== 'function') {
        globalThis.btoa = function(str) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(str), 'binary').toString('base64');
        };
    }
    if (typeof globalThis.atob !== 'function') {
        globalThis.atob = function(b64) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(b64), 'base64').toString('binary');
        };
    }

    // Node 20 LTS globals exposed without `require`:
    //   * `Buffer`           — global since v0.x.
    //   * `global`           — alias to globalThis since v12.
    //   * `URL` / `URLSearchParams` — global since v10.
    if (typeof globalThis.Buffer !== 'function') {
        globalThis.Buffer = require('buffer').Buffer;
    }
    if (typeof globalThis.global !== 'object') {
        globalThis.global = globalThis;
    }
    if (typeof globalThis.URL !== 'function') {
        var urlMod = require('url');
        if (typeof urlMod.URL === 'function') {
            globalThis.URL = urlMod.URL;
            globalThis.URLSearchParams = urlMod.URLSearchParams;
        } else {
            // Minimal regex-based parser when neither host nor url
            // module exposes a URL constructor. Doesn't claim WHATWG
            // conformance — covers `new URL(href).{protocol,host,
            // pathname,search,searchParams}` which is what most Node
            // code actually uses.
            globalThis.URL = function URL(href, base) {
                if (base) href = String(base).replace(/[^/]*$/, '') + href;
                var s = String(href);
                var m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
                this.href = s;
                this.protocol = m && m[1] ? m[1] + ':' : '';
                this.host = (m && m[2]) || '';
                var hp = this.host.split(':');
                this.hostname = hp[0] || '';
                this.port = hp[1] || '';
                this.pathname = (m && m[3]) || '';
                this.search = (m && m[4]) || '';
                this.hash = (m && m[5]) || '';
                this.origin = this.protocol + (this.host ? '//' + this.host : '');
                this.searchParams = new globalThis.URLSearchParams(this.search.slice(1));
            };
            globalThis.URL.prototype.toString = function() { return this.href; };

            globalThis.URLSearchParams = function URLSearchParams(init) {
                this._pairs = [];
                var self = this;
                if (typeof init === 'string') {
                    var s = init.replace(/^\?/, '');
                    if (s) s.split('&').forEach(function(p) {
                        var eq = p.indexOf('=');
                        var k = eq < 0 ? p : p.slice(0, eq);
                        var v = eq < 0 ? '' : p.slice(eq + 1);
                        self._pairs.push([decodeURIComponent(k), decodeURIComponent(v)]);
                    });
                } else if (init && typeof init === 'object') {
                    Object.keys(init).forEach(function(k) {
                        self._pairs.push([k, String(init[k])]);
                    });
                }
            };
            var P = globalThis.URLSearchParams.prototype;
            P.get = function(k) {
                for (var i = 0; i < this._pairs.length; i++)
                    if (this._pairs[i][0] === k) return this._pairs[i][1];
                return null;
            };
            P.getAll = function(k) {
                return this._pairs.filter(function(p) { return p[0] === k; })
                                  .map(function(p) { return p[1]; });
            };
            P.has = function(k) {
                return this._pairs.some(function(p) { return p[0] === k; });
            };
            P.set = function(k, v) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
                this._pairs.push([k, String(v)]);
            };
            P.append = function(k, v) { this._pairs.push([k, String(v)]); };
            P.delete = function(k) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
            };
            P.toString = function() {
                return this._pairs.map(function(p) {
                    return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
                }).join('&');
            };
        }
    }
})();

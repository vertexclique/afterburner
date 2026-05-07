// url — legacy API (url.parse / url.format / url.resolve) plus a
// passthrough to the WHATWG `URL` / `URLSearchParams` globals.

__register_module('url', function(module, exports, require) {

    function parse(str, parseQueryString) {
        if (typeof str !== 'string') throw new TypeError('url.parse requires a string');
        var out = {
            protocol: null, slashes: null, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: str
        };

        var rest = str;

        var hashIdx = rest.indexOf('#');
        if (hashIdx >= 0) { out.hash = rest.slice(hashIdx); rest = rest.slice(0, hashIdx); }

        var queryIdx = rest.indexOf('?');
        if (queryIdx >= 0) {
            out.search = rest.slice(queryIdx);
            var q = rest.slice(queryIdx + 1);
            out.query = parseQueryString ? require('querystring').parse(q) : q;
            rest = rest.slice(0, queryIdx);
        }

        var protoMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rest);
        if (protoMatch) {
            out.protocol = protoMatch[0];
            rest = rest.slice(protoMatch[0].length);
        }

        if (rest.slice(0, 2) === '//') {
            out.slashes = true;
            rest = rest.slice(2);
            var slash = rest.indexOf('/');
            var authority = slash < 0 ? rest : rest.slice(0, slash);
            rest = slash < 0 ? '' : rest.slice(slash);
            var at = authority.indexOf('@');
            if (at >= 0) { out.auth = authority.slice(0, at); authority = authority.slice(at + 1); }
            out.host = authority || null;
            var colon = authority.indexOf(':');
            if (colon >= 0) { out.hostname = authority.slice(0, colon); out.port = authority.slice(colon + 1); }
            else { out.hostname = authority || null; }
        }

        out.pathname = rest || null;
        out.path = (out.pathname || '') + (out.search || '') || null;
        return out;
    }

    function format(obj) {
        if (typeof obj === 'string') return obj;
        var out = '';
        if (obj.protocol) {
            out += obj.protocol;
            if (obj.protocol.charAt(obj.protocol.length - 1) !== ':') out += ':';
        }
        if (obj.slashes || obj.host || obj.hostname) {
            out += '//';
            if (obj.auth) out += obj.auth + '@';
            out += obj.host || (obj.hostname + (obj.port ? ':' + obj.port : ''));
        }
        out += obj.pathname || '';
        if (obj.search) out += obj.search;
        else if (obj.query) {
            out += '?' + (typeof obj.query === 'string' ? obj.query : require('querystring').stringify(obj.query));
        }
        if (obj.hash) out += obj.hash;
        return out;
    }

    function resolve(from, to) {
        try {
            return new URL(to, from).href;
        } catch (_) {
            // Degenerate resolve for relative-without-base callers.
            if (to.charAt(0) === '/') {
                var p = parse(from);
                return (p.protocol || '') + (p.slashes ? '//' : '') + (p.host || '') + to;
            }
            return to;
        }
    }

    exports.parse = parse;
    exports.format = format;
    exports.resolve = resolve;

    // Lazy-bind to the runtime's URL / URLSearchParams. Direct
    // assignment at module-init snapshots the global, which on Javy /
    // QuickJS isn't always installed when the bundle loads — a
    // direct `exports.URL = URL` would then cache `undefined` and
    // every downstream `require('url').URL` (npm's nerf-dart, every
    // proxy-agent variant) breaks with `not a function`. Getters
    // resolve at call-site so the URL constructor binds the moment
    // it becomes available.
    Object.defineProperty(exports, 'URL', {
        configurable: true,
        enumerable: true,
        get: function() { return globalThis.URL; },
    });
    Object.defineProperty(exports, 'URLSearchParams', {
        configurable: true,
        enumerable: true,
        get: function() { return globalThis.URLSearchParams; },
    });
    exports.fileURLToPath = function(u) {
        var s = typeof u === 'string' ? u : (u && u.href) ? u.href : String(u);
        // file:// → /; file:///foo/bar → /foo/bar; file://host/path → /path
        var m = /^file:\/\/([^/]*)?(\/[^?#]*)?/i.exec(s);
        return m ? (m[2] || '/') : s;
    };
    exports.pathToFileURL = function(p) {
        var s = String(p);
        var path = s.charAt(0) === '/' ? s : '/' + s;
        var encoded = path.replace(/[#?]/g, function(ch) { return encodeURIComponent(ch); });
        // Return a URL-shaped object so callers that read .href / .pathname work.
        var URLCtor = globalThis.URL;
        if (typeof URLCtor === 'function') {
            try { return new URLCtor('file://' + encoded); } catch (_) {}
        }
        return { href: 'file://' + encoded, pathname: path, protocol: 'file:' };
    };
    exports.urlToHttpOptions = function(u) {
        if (!u || typeof u !== 'object') return null;
        return {
            protocol: u.protocol,
            hostname: u.hostname && u.hostname.replace(/^\[|\]$/g, ''),
            hash: u.hash,
            search: u.search,
            pathname: u.pathname,
            path: (u.pathname || '') + (u.search || ''),
            href: u.href,
            port: u.port ? Number(u.port) : undefined,
            auth: (u.username || u.password) ? (decodeURIComponent(u.username || '') + (u.password ? ':' + decodeURIComponent(u.password) : '')) : undefined,
        };
    };
    exports.domainToASCII = function(s) { return String(s).toLowerCase(); };
    exports.domainToUnicode = function(s) { return String(s); };
});

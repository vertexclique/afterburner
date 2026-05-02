// dns — synchronous host-backed lookups, presented through Node's
// dual callback / promise API.
//
// API coverage:
//
//   dns.lookup(host[, opts], cb)        — A/AAAA via system resolver
//   dns.resolve(host[, rrtype], cb)     — dispatcher for record types
//   dns.resolve4 / resolve6             — A / AAAA arrays
//   dns.resolveMx                       — [{exchange, priority}]
//   dns.resolveTxt                      — [["fragment", ...], ...]
//   dns.resolveCname / resolveNs        — [hostname, ...]
//   dns.reverse(ip, cb)                 — PTR records
//   dns.promises.{lookup,resolve*,reverse}  — Promise-returning twins
//
// We have no event loop, so callbacks fire synchronously inside the
// resolver call; the Promise versions wrap the same result. The host
// applies a per-call timeout (`Manifold.http_timeout_ms`) so a hung
// resolver can never wedge the runtime.
//
// Error shape matches Node where it matters: `e.code` carries
// 'ENODATA' / 'ENOTFOUND' / 'EACCES' depending on what went wrong.
// The host-side `__HOST_ERR__:` prefix is unwrapped here so user
// callbacks see plain `Error` instances.

__register_module('dns', function(module, exports, require) {

    // ---- error wrapping --------------------------------------------

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function hostErrToError(s, hostname) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var code;
        // Heuristic mapping — the host returns kind-tagged strings in
        // most paths. PermissionDenied → EACCES; everything else
        // (timeouts, NXDOMAIN, garbage records) → ENODATA.
        if (/PermissionDenied/i.test(msg) || /Permission denied/i.test(msg)) {
            code = 'EACCES';
        } else if (/timed out/i.test(msg)) {
            code = 'ETIMEOUT';
        } else if (/no result|no record/i.test(msg)) {
            code = 'ENODATA';
        } else {
            code = 'ENODATA';
        }
        var err = new Error('dns: ' + msg);
        err.code = code;
        err.hostname = hostname;
        return err;
    }

    // ---- core call helper ------------------------------------------

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('Permission denied: ' + name + ' is not available');
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function callJsonResolver(hostFnName, hostname) {
        var fn = ensureHost(hostFnName);
        var raw = fn(String(hostname));
        if (isHostErr(raw)) {
            throw hostErrToError(raw, hostname);
        }
        try {
            return JSON.parse(raw);
        } catch (e) {
            var err = new Error('dns: malformed host response: ' + e.message);
            err.code = 'EBADRESP';
            throw err;
        }
    }

    function callStringResolver(hostFnName, hostname) {
        var fn = ensureHost(hostFnName);
        var raw = fn(String(hostname));
        if (isHostErr(raw)) {
            throw hostErrToError(raw, hostname);
        }
        return raw;
    }

    // ---- callback / promise dual-shape glue ------------------------

    function dual(producer) {
        // Returns a function that accepts an optional trailing
        // callback. Without a callback it returns the value (sync —
        // matches the way Node's tests of the sync path run, since we
        // have no event loop). With a callback it invokes synchronously
        // with `(null, value)` or `(err)`.
        return function() {
            var args = Array.prototype.slice.call(arguments);
            var cb;
            if (args.length && typeof args[args.length - 1] === 'function') {
                cb = args.pop();
            }
            try {
                var v = producer.apply(null, args);
                if (cb) { cb(null, v); return; }
                return v;
            } catch (e) {
                if (cb) { cb(e); return; }
                throw e;
            }
        };
    }

    function promiseOf(producer) {
        return function() {
            var args = arguments;
            return new Promise(function(resolve, reject) {
                try { resolve(producer.apply(null, args)); }
                catch (e) { reject(e); }
            });
        };
    }

    // ---- lookup (A/AAAA dispatcher) --------------------------------

    function _lookupOne(hostname) {
        return {
            address: callStringResolver('__host_dns_lookup', hostname),
            family: 4, // host returns first IP; family detection lives in resolve4/6
        };
    }

    exports.lookup = function(hostname, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        if (typeof cb === 'function') {
            try {
                var r = _lookupOne(hostname);
                cb(null, r.address, r.family);
            } catch (e) { cb(e); }
            return;
        }
        return _lookupOne(hostname);
    };

    // ---- record-type-aware resolvers -------------------------------

    function makeArrayResolver(hostFnName) {
        return function(hostname) {
            var v = callJsonResolver(hostFnName, hostname);
            if (!Array.isArray(v)) {
                var err = new Error('dns: expected array from host');
                err.code = 'EBADRESP';
                throw err;
            }
            return v;
        };
    }

    var _resolve4 = makeArrayResolver('__host_dns_resolve4');
    var _resolve6 = makeArrayResolver('__host_dns_resolve6');
    var _resolveMx = makeArrayResolver('__host_dns_resolve_mx');
    var _resolveTxt = makeArrayResolver('__host_dns_resolve_txt');
    var _resolveCname = makeArrayResolver('__host_dns_resolve_cname');
    var _resolveNs = makeArrayResolver('__host_dns_resolve_ns');
    var _reverse = function(ip) {
        return makeArrayResolver('__host_dns_reverse')(ip);
    };

    exports.resolve4 = dual(_resolve4);
    exports.resolve6 = dual(_resolve6);
    exports.resolveMx = dual(_resolveMx);
    exports.resolveTxt = dual(_resolveTxt);
    exports.resolveCname = dual(_resolveCname);
    exports.resolveNs = dual(_resolveNs);
    exports.reverse = dual(_reverse);

    // resolve(hostname, [rrtype], cb) — Node's umbrella entry. Default
    // rrtype is 'A'. We dispatch into the typed resolvers.
    exports.resolve = function(hostname, rrtype, cb) {
        if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
        rrtype = String(rrtype || 'A').toUpperCase();
        var fn;
        switch (rrtype) {
            case 'A':     fn = _resolve4; break;
            case 'AAAA':  fn = _resolve6; break;
            case 'MX':    fn = _resolveMx; break;
            case 'TXT':   fn = _resolveTxt; break;
            case 'CNAME': fn = _resolveCname; break;
            case 'NS':    fn = _resolveNs; break;
            default:
                var err = new Error('dns.resolve: unsupported rrtype ' + rrtype);
                err.code = 'ENOTIMP';
                if (cb) { cb(err); return; }
                throw err;
        }
        if (typeof cb === 'function') {
            try { cb(null, fn(hostname)); }
            catch (e) { cb(e); }
            return;
        }
        return fn(hostname);
    };

    // Resolver — Node exposes a class so callers can carry per-instance
    // options (timeouts, server lists). We stub the shape: every method
    // delegates to the module-level resolvers. `setServers` /
    // `getServers` are no-ops with a stable return shape; the host
    // resolver always uses /etc/resolv.conf (with a Cloudflare fallback).
    function Resolver() {
        this._servers = [];
    }
    Resolver.prototype.setServers = function(servers) {
        this._servers = Array.isArray(servers) ? servers.slice() : [];
        // No-op: the host resolver doesn't honor a custom server list
        // in this minimum-viable subset. A future pass can plumb the
        // overrides through to hickory's ResolverConfig.
    };
    Resolver.prototype.getServers = function() {
        return this._servers.slice();
    };
    Resolver.prototype.cancel = function() { /* no-op — calls are sync */ };
    Resolver.prototype.resolve = exports.resolve;
    Resolver.prototype.resolve4 = exports.resolve4;
    Resolver.prototype.resolve6 = exports.resolve6;
    Resolver.prototype.resolveMx = exports.resolveMx;
    Resolver.prototype.resolveTxt = exports.resolveTxt;
    Resolver.prototype.resolveCname = exports.resolveCname;
    Resolver.prototype.resolveNs = exports.resolveNs;
    Resolver.prototype.reverse = exports.reverse;
    exports.Resolver = Resolver;

    // RR-type constants — surface so callers can do `dns.A`, etc.
    exports.A = 'A';
    exports.AAAA = 'AAAA';
    exports.MX = 'MX';
    exports.TXT = 'TXT';
    exports.CNAME = 'CNAME';
    exports.NS = 'NS';
    exports.PTR = 'PTR';

    // ---- Promises mirror -------------------------------------------

    exports.promises = {
        lookup: promiseOf(_lookupOne),
        resolve4: promiseOf(_resolve4),
        resolve6: promiseOf(_resolve6),
        resolveMx: promiseOf(_resolveMx),
        resolveTxt: promiseOf(_resolveTxt),
        resolveCname: promiseOf(_resolveCname),
        resolveNs: promiseOf(_resolveNs),
        reverse: promiseOf(_reverse),
        resolve: function(hostname, rrtype) {
            return new Promise(function(resolve, reject) {
                try {
                    exports.resolve(hostname, rrtype, function(err, v) {
                        if (err) reject(err); else resolve(v);
                    });
                } catch (e) { reject(e); }
            });
        },
        Resolver: Resolver,
    };
});

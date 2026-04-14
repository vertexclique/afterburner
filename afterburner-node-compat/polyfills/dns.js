// dns — synchronous `lookup` only. Callback-style calls work by
// immediately invoking the callback with the resolved address (no
// actual async, matching Afterburner's no-event-loop model).

__register_module('dns', function(module, exports, require) {

    function ensureHost() {
        var fn = globalThis.__host_dns_lookup;
        if (typeof fn !== 'function') {
            var err = new Error("Permission denied: dns.lookup is not available");
            err.code = 'EACCES';
            throw err;
        }
        return fn;
    }

    function doLookup(hostname) {
        try {
            return { address: ensureHost()(String(hostname)), family: 4 };
        } catch (e) {
            throw e;
        }
    }

    exports.lookup = function(hostname, options, cb) {
        // Support both (host, cb) and (host, options, cb) forms.
        if (typeof options === 'function') { cb = options; options = undefined; }
        if (typeof cb === 'function') {
            try {
                var r = doLookup(hostname);
                cb(null, r.address, r.family);
            } catch (e) { cb(e); }
            return;
        }
        return doLookup(hostname);
    };

    exports.promises = {
        lookup: function(hostname) {
            return new Promise(function(resolve, reject) {
                try { resolve(doLookup(hostname)); } catch (e) { reject(e); }
            });
        }
    };
});

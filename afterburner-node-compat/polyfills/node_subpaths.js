// Node exposes several "X/promises" paths (and other sub-module
// shapes) as separate require targets. They're thin re-exports of a
// property on the parent module. Registering them here — in a file
// that lexically sorts after the parents — lets `require('node:fs/promises')`
// behave exactly like `require('fs').promises`, matching Node so
// drop-in scripts don't trip on the difference.

// fs/promises → re-export of fs.promises (set in fs.js).
__register_module('fs/promises', function(module, exports, require) {
    module.exports = require('fs').promises;
});

// dns/promises → re-export of dns.promises (set in dns.js).
__register_module('dns/promises', function(module, exports, require) {
    module.exports = require('dns').promises;
});

// stream/promises — Node exposes Promise-returning versions of
// `pipeline` and `finished`. The core `stream` module's sync-callback
// versions are in stream.js; we wrap them here.
__register_module('stream/promises', function(module, exports, require) {
    var stream = require('stream');
    module.exports = {
        pipeline: function() {
            var args = [].slice.call(arguments);
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { stream.pipeline.apply(null, args); } catch (e) { reject(e); }
            });
        },
        finished: function(s, opts) {
            return new Promise(function(resolve, reject) {
                stream.finished(s, opts || {}, function(err) {
                    err ? reject(err) : resolve();
                });
            });
        },
    };
});

// timers/promises — Node exposes Promise-returning delays.
// `setInterval` is documented as an async iterator; we stub it with a
// clear "not implemented" error until a consumer surfaces a need.
__register_module('timers/promises', function(module, exports, require) {
    module.exports = {
        setTimeout: function(ms, value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                var t = setTimeout(function() { resolve(value); }, ms);
                if (signal) {
                    signal.addEventListener('abort', function() {
                        clearTimeout(t);
                        reject(new Error('The operation was aborted'));
                    });
                }
            });
        },
        setImmediate: function(value, opts) {
            var signal = opts && opts.signal;
            return new Promise(function(resolve, reject) {
                if (signal && signal.aborted) {
                    return reject(new Error('The operation was aborted'));
                }
                setImmediate(function() { resolve(value); });
            });
        },
        // AsyncIterator surface for `setInterval(ms)` lands with
        // a consumer. Throw until then so scripts that reach for
        // it see a clear error rather than silently hanging.
        setInterval: function() {
            throw new Error('timers/promises.setInterval (async iterator) is not implemented');
        },
    };
});

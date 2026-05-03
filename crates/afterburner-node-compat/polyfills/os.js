// os — trivially backed by host globals. No Manifold gating.

__register_module('os', function(module, exports, require) {

    function fallback(name, def) {
        var fn = globalThis['__host_os_' + name];
        return typeof fn === 'function' ? fn() : def;
    }

    exports.platform  = function() { return fallback('platform',  'linux'); };
    exports.arch      = function() { return fallback('arch',      'x64'); };
    exports.hostname  = function() { return fallback('hostname',  'afterburner'); };
    exports.tmpdir    = function() { return fallback('tmpdir',    '/tmp'); };
    exports.homedir   = function() { return fallback('home_dir',  '/'); };
    exports.cpus      = function() {
        var n = fallback('cpus', 1);
        var out = [];
        for (var i = 0; i < n; i++) out.push({ model: 'afterburner', speed: 0 });
        return out;
    };
    exports.totalmem  = function() { return 0; };
    exports.freemem   = function() { return 0; };
    exports.uptime    = function() { return 0; };
    exports.EOL       = '\n';
    exports.type      = function() { return 'Linux'; };
    exports.release   = function() { return '0.0.0-afterburner'; };
    exports.endianness = function() { return 'LE'; };
});

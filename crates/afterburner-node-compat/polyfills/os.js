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
    /// os.availableParallelism (Node 19+) — number of logical CPUs
    /// the process can use for parallel work. Same value as cpus().length.
    exports.availableParallelism = function() {
        return fallback('cpus', 1);
    };
    exports.totalmem  = function() { return 0; };
    exports.freemem   = function() { return 0; };
    exports.uptime    = function() { return 0; };
    exports.EOL       = '\n';
    exports.type      = function() { return 'Linux'; };
    exports.release   = function() { return '0.0.0-afterburner'; };
    exports.endianness = function() { return 'LE'; };

    // Node's `os.constants`. Packagers (npm @npmcli/fs, fs-extra, pacote)
    // destructure `os.constants.errno.{EEXIST,ENOENT,…}` at module-init
    // time. Missing the table makes the destructure throw `Cannot
    // convert undefined or null to object`, which surfaces as an
    // unrelated-looking failure deep in npm's polyfill chain. Linux x86_64
    // numeric values, matched against Node's own table — they're a
    // fixed kernel ABI on Linux and the constants are read by name in
    // every script we've seen, so the numeric mismatch on other
    // platforms is harmless.
    var ERRNO = {
        E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99,
        EAFNOSUPPORT: 97, EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74,
        EBUSY: 16, ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103,
        ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
        EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27,
        EHOSTUNREACH: 113, EIDRM: 43, EILSEQ: 84, EINPROGRESS: 115,
        EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21, ELOOP: 40,
        EMFILE: 24, EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
        ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23,
        ENOBUFS: 105, ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8,
        ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92,
        ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107,
        ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25,
        ENXIO: 6, EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32,
        EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34,
        EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62,
        ETIMEDOUT: 110, ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
    };
    var SIGNALS = {
        SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
        SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11,
        SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17,
        SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
        SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
        SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30,
        SIGSYS: 31, SIGUNUSED: 31,
    };
    var PRIORITY = {
        PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
    };
    exports.constants = {
        UV_UDP_REUSEADDR: 4,
        dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 },
        errno: ERRNO,
        signals: SIGNALS,
        priority: PRIORITY,
    };

    // os.networkInterfaces(): Node exposes a per-interface object map.
    // npm's `npm-pick-manifest` calls it during prefix detection. Empty
    // map is the right "no enumerable interfaces" answer when we don't
    // surface them through the host bridge.
    exports.networkInterfaces = function() { return {}; };
    exports.userInfo = function(opts) {
        var enc = (opts && opts.encoding) || 'utf8';
        return {
            username: 'afterburner',
            uid: -1,
            gid: -1,
            shell: null,
            homedir: exports.homedir(),
        };
    };
    exports.loadavg     = function() { return [0, 0, 0]; };
    exports.machine     = function() { return fallback('arch', 'x86_64'); };
    exports.version     = function() { return exports.release(); };
    exports.devNull     = '/dev/null';
});

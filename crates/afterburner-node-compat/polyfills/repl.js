// repl — Node 20's read-eval-print-loop server.
//
// Burn doesn't have an interactive TTY in the sandboxed JS context,
// but `repl.start()` is sometimes called from server-introspection
// tools or in `--inspect-brk` flows. We expose a `REPLServer`
// class that accepts the configuration, lets callers wire `command`
// / `replServer.context.foo = ...` style globals, and ignores
// the read loop (no stdin available to read).

__register_module('repl', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var vm = require('vm');

    function REPLServer(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.useColors = !!opts.useColors;
        this.useGlobal = opts.useGlobal !== false;
        this.terminal = !!opts.terminal;
        this.input = opts.input || null;
        this.output = opts.output || null;
        this.commands = Object.create(null);
        // The REPL spec exposes the eval scope as `replServer.context`.
        // We back it with a fresh vm context so callers can attach
        // helpers (`replServer.context.x = 5`) without mutating the
        // surrounding globals.
        this.context = vm.createContext({});
    }
    REPLServer.prototype = Object.create(EventEmitter.prototype);
    REPLServer.prototype.constructor = REPLServer;

    REPLServer.prototype.defineCommand = function(name, descriptor) {
        if (typeof descriptor === 'function') descriptor = { action: descriptor };
        this.commands[name] = descriptor;
    };
    REPLServer.prototype.displayPrompt = function() {};
    REPLServer.prototype.setPrompt = function() {};
    REPLServer.prototype.close = function() { this.emit('exit'); };
    REPLServer.prototype.eval = function(code, _ctx, _filename, callback) {
        try {
            var result = vm.runInContext(code, this.context);
            if (typeof callback === 'function') callback(null, result);
        } catch (e) {
            if (typeof callback === 'function') callback(e);
        }
    };

    function start(opts) {
        if (typeof opts === 'string') opts = { prompt: opts };
        var server = new REPLServer(opts);
        return server;
    }

    exports.start = start;
    exports.REPLServer = REPLServer;
    exports.REPL_MODE_SLOPPY = Symbol('repl-sloppy');
    exports.REPL_MODE_STRICT = Symbol('repl-strict');
    exports.Recoverable = function Recoverable(err) {
        var e = err instanceof Error ? err : new Error(String(err));
        e.name = 'Recoverable';
        return e;
    };
    exports.builtinModules = []; // populated by `module.builtinModules` consumers
});

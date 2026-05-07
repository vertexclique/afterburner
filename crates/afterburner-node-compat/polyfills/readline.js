// readline — Node 20's line reader. The module is normally used to
// prompt for stdin input (`createInterface({input: process.stdin})`)
// and parse it into discrete lines. Burn's stdin is one-shot via
// the script invocation, but the surface is what library code
// expects to import. We provide a real EventEmitter that emits
// 'line' / 'close' synchronously when the user feeds chunks via
// the readable's `on('data')` events.

__register_module('readline', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function Interface(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.input = opts.input;
        this.output = opts.output;
        this._buffer = '';
        this._closed = false;

        if (this.input && typeof this.input.on === 'function') {
            var self = this;
            this.input.on('data', function(chunk) { self._consume(chunk); });
            this.input.on('end', function() { self.close(); });
            this.input.on('close', function() { self.close(); });
        }
    }
    Interface.prototype = Object.create(EventEmitter.prototype);
    Interface.prototype.constructor = Interface;

    Interface.prototype._consume = function(chunk) {
        if (this._closed) return;
        var text;
        if (typeof chunk === 'string') text = chunk;
        else if (chunk && chunk.toString) text = chunk.toString('utf8');
        else return;
        this._buffer += text;
        var nl;
        while ((nl = this._buffer.indexOf('\n')) !== -1) {
            var line = this._buffer.slice(0, nl);
            this._buffer = this._buffer.slice(nl + 1);
            // Strip trailing `\r` for Windows-style line endings.
            if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                line = line.slice(0, -1);
            }
            try { this.emit('line', line); } catch (_) {}
        }
    };

    Interface.prototype.close = function() {
        if (this._closed) return;
        this._closed = true;
        // Flush any trailing buffered content as a final line.
        if (this._buffer.length > 0) {
            var last = this._buffer;
            this._buffer = '';
            try { this.emit('line', last); } catch (_) {}
        }
        try { this.emit('close'); } catch (_) {}
    };

    Interface.prototype.question = function(query, callback) {
        // No interactive stdin in the sandbox: we can't actually
        // wait for the user. Surface a clear error rather than
        // hanging.
        var err = new Error(
            'readline.question: interactive prompts are not supported in the ' +
            'Afterburner sandbox (no TTY); pass scripted input via input streams.'
        );
        err.code = 'ERR_NO_TTY';
        if (typeof callback === 'function') Promise.resolve().then(function() { callback(query); });
        throw err;
    };

    Interface.prototype.pause = function() { return this; };
    Interface.prototype.resume = function() { return this; };
    Interface.prototype.write = function() { return this; };
    Interface.prototype.setPrompt = function() {};
    Interface.prototype.prompt = function() {};
    Interface.prototype.getPrompt = function() { return ''; };
    Interface.prototype.getCursorPos = function() { return { rows: 0, cols: 0 }; };

    function createInterface(opts) {
        return new Interface(opts);
    }

    function clearLine() { return true; }
    function clearScreenDown() { return true; }
    function cursorTo() { return true; }
    function moveCursor() { return true; }
    function emitKeypressEvents() {}

    exports.createInterface = createInterface;
    exports.Interface = Interface;
    exports.clearLine = clearLine;
    exports.clearScreenDown = clearScreenDown;
    exports.cursorTo = cursorTo;
    exports.moveCursor = moveCursor;
    exports.emitKeypressEvents = emitKeypressEvents;

    /// readline.promises — Node 17+ Promise-shaped wrappers. The
    /// readline-side `question`/`Interface` aren't usable in our
    /// current daemon (we don't have a stdin pump), but exposing the
    /// surface keeps libraries that probe at module-init from
    /// crashing.
    exports.promises = {
        createInterface: createInterface,
        Interface: Interface,
    };
});

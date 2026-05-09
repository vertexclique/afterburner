// tty — Node 20's TTY stream classes. process.stdout / process.stderr
// inherit from these in real Node when attached to a terminal. In
// burn's sandbox there's no kernel TTY, but the API answers should
// match what library code expects: `getColorDepth` and `hasColors`
// honour `NO_COLOR` / `FORCE_COLOR` / `TERM` so chalk / signale /
// supports-color produce the right output for the user's intent.

__register_module('tty', function(module, exports, require) {
    var stream = require('stream');

    // ---- color depth resolver (NO_COLOR / FORCE_COLOR / TERM) ------
    //
    // Resolves to the depth in *bits* (matches Node's `getColorDepth`):
    //   1 → 1-bit / no color
    //   4 → 16-color terminal
    //   8 → 256-color (xterm-256, screen-256color, etc.)
    //  24 → 16-million / TrueColor (modern terminals, COLORTERM=truecolor)
    //
    // Precedence: NO_COLOR (any value) wins, FORCE_COLOR=1..3 next,
    // then TERM/COLORTERM heuristics, then the default-off baseline.
    function _envColorDepth() {
        var env = (typeof process !== 'undefined' && process.env) || {};
        if (env.NO_COLOR != null && env.NO_COLOR !== '') return 1;
        if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '') {
            var fc = String(env.FORCE_COLOR).trim().toLowerCase();
            if (fc === 'true' || fc === '1') return 4;
            if (fc === '2') return 8;
            if (fc === '3') return 24;
            if (fc === 'false' || fc === '0') return 1;
            // FORCE_COLOR= (empty handled above) — non-numeric truthy.
            return 4;
        }
        var colorterm = String(env.COLORTERM || '').toLowerCase();
        if (colorterm === 'truecolor' || colorterm === '24bit') return 24;
        var term = String(env.TERM || '').toLowerCase();
        if (term === 'dumb') return 1;
        if (term.indexOf('256color') !== -1) return 8;
        if (term.indexOf('color') !== -1) return 4;
        if (term && term !== 'dumb') return 4;
        return 1;
    }

    /// Node's `count` mapping — `hasColors([count[, env]])` returns
    /// true when the stream supports ≥ `count` distinct colors.
    /// Defaults: 16 if no count given.
    function _hasColorsForDepth(depth, count) {
        var n = count == null ? 16 : (count | 0);
        if (n <= 2) return depth >= 1;
        if (n <= 16) return depth >= 4;
        if (n <= 256) return depth >= 8;
        return depth >= 24;
    }

    function ReadStream(fd, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(fd, options);
        if (typeof stream.Readable === 'function') {
            stream.Readable.call(this, options);
        }
        this.fd = (fd | 0) || 0;
        this.isRaw = false;
        this.isTTY = false;
        this.columns = 80;
        this.rows = 24;
    }
    if (typeof stream.Readable === 'function') {
        ReadStream.prototype = Object.create(stream.Readable.prototype);
        ReadStream.prototype.constructor = ReadStream;
    }
    ReadStream.prototype.setRawMode = function(mode) {
        this.isRaw = !!mode;
        return this;
    };

    function WriteStream(fd, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(fd, options);
        if (typeof stream.Writable === 'function') {
            stream.Writable.call(this, options);
        }
        this.fd = (fd | 0) || 1;
        this.isTTY = false;
        this.columns = 80;
        this.rows = 24;
    }
    if (typeof stream.Writable === 'function') {
        WriteStream.prototype = Object.create(stream.Writable.prototype);
        WriteStream.prototype.constructor = WriteStream;
    }
    WriteStream.prototype.clearLine = function() { return true; };
    WriteStream.prototype.clearScreenDown = function() { return true; };
    WriteStream.prototype.cursorTo = function() { return true; };
    WriteStream.prototype.moveCursor = function() { return true; };
    WriteStream.prototype.getColorDepth = function(_envOverride) {
        // Node accepts an env override for testability — caller-supplied
        // env is read by `_envColorDepth` if we wired that through, but
        // we keep it simple and read the live process.env.
        return _envColorDepth();
    };
    WriteStream.prototype.hasColors = function(count, _env) {
        return _hasColorsForDepth(_envColorDepth(), count);
    };
    WriteStream.prototype.getWindowSize = function() {
        return [this.columns, this.rows];
    };

    function isatty(fd) {
        var _ = fd;
        return false; // sandbox has no real TTY
    }

    exports.ReadStream = ReadStream;
    exports.WriteStream = WriteStream;
    exports.isatty = isatty;
});

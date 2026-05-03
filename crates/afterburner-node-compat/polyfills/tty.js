// tty — Node 20's TTY stream classes. process.stdout / process.stderr
// inherit from these in real Node when attached to a terminal. In
// burn's sandbox there's no TTY, but utility code calls
// `tty.isatty(fd)` and `process.stdout.isTTY` defensively — we keep
// those returning sane non-TTY answers so the conditional pretty-
// print paths in chalk / signale / supports-color don't crash.

__register_module('tty', function(module, exports, require) {
    var stream = require('stream');

    function ReadStream(fd, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(fd, options);
        // We delegate to Readable for the API shape; no actual
        // bytes flow because there's no TTY behind it.
        if (typeof stream.Readable === 'function') {
            stream.Readable.call(this, options);
        }
        this.fd = (fd | 0) || 0;
        this.isRaw = false;
        this.isTTY = false; // sandbox is never a TTY
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
    WriteStream.prototype.getColorDepth = function() { return 1; };
    WriteStream.prototype.hasColors = function() { return false; };
    WriteStream.prototype.getWindowSize = function() {
        return [this.columns, this.rows];
    };

    function isatty(fd) {
        var _ = fd;
        return false; // sandbox has no TTY
    }

    exports.ReadStream = ReadStream;
    exports.WriteStream = WriteStream;
    exports.isatty = isatty;
});

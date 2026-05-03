// string_decoder — minimal StringDecoder with incremental UTF-8 support.
// Falls back to TextDecoder's streaming mode when available; otherwise a
// tiny hand-rolled continuation-byte buffer.

__register_module('string_decoder', function(module, exports, require) {

    function StringDecoder(encoding) {
        this.encoding = (encoding || 'utf8').toLowerCase();
        if (this.encoding !== 'utf8' && this.encoding !== 'utf-8') {
            throw new Error('StringDecoder: only utf8 is supported');
        }
        if (typeof TextDecoder === 'function') {
            this._decoder = new TextDecoder('utf-8', { fatal: false });
            this._native = true;
        } else {
            this._buffered = new Uint8Array(0);
        }
    }

    StringDecoder.prototype.write = function(chunk) {
        if (this._native) return this._decoder.decode(chunk, { stream: true });

        // Fallback: concat any leftover continuation bytes + new chunk,
        // decode complete sequences, stash the remainder.
        var full = new Uint8Array(this._buffered.length + chunk.length);
        full.set(this._buffered);
        full.set(chunk, this._buffered.length);

        // Find the largest prefix that ends on a complete code point.
        var i = full.length;
        while (i > 0) {
            var b = full[i - 1];
            if ((b & 0x80) === 0) break;                          // ASCII
            if ((b & 0xC0) === 0xC0) { i--; break; }              // start byte
            i--;                                                  // continuation
            if (full.length - i >= 4) { i = full.length; break; } // clamp
        }
        this._buffered = full.subarray(i);

        var out = '';
        for (var j = 0; j < i; j++) out += String.fromCharCode(full[j] & 0x7F);
        return out;
    };

    StringDecoder.prototype.end = function(chunk) {
        if (this._native) return this._decoder.decode(chunk || new Uint8Array(), { stream: false });
        var tail = chunk ? this.write(chunk) : '';
        return tail;
    };

    exports.StringDecoder = StringDecoder;
});

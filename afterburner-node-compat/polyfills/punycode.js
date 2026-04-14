// punycode — RFC 3492 implementation.
// Adapted from Mathias Bynens' `punycode.js` (MIT) — kept small and
// hand-audited rather than pulled in as a dependency.

__register_module('punycode', function(module, exports, require) {

    var maxInt = 2147483647;
    var base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    var initialBias = 72, initialN = 128;
    var delimiter = '-';

    function adapt(delta, numPoints, firstTime) {
        delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
        delta += Math.floor(delta / numPoints);
        var k = 0;
        while (delta > ((base - tMin) * tMax) >> 1) {
            delta = Math.floor(delta / (base - tMin));
            k += base;
        }
        return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
    }

    function digitToBasic(digit) {
        return digit + 22 + 75 * (digit < 26 ? 1 : 0);
    }

    function basicToDigit(codePoint) {
        if (codePoint - 48 < 10) return codePoint - 22;
        if (codePoint - 65 < 26) return codePoint - 65;
        if (codePoint - 97 < 26) return codePoint - 97;
        return base;
    }

    function ucs2decode(str) {
        var out = [];
        var i = 0;
        while (i < str.length) {
            var value = str.charCodeAt(i++);
            if (value >= 0xD800 && value <= 0xDBFF && i < str.length) {
                var extra = str.charCodeAt(i++);
                if ((extra & 0xFC00) === 0xDC00) {
                    out.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                    out.push(value);
                    i--;
                }
            } else {
                out.push(value);
            }
        }
        return out;
    }

    function ucs2encode(arr) {
        var out = '';
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v > 0xFFFF) {
                v -= 0x10000;
                out += String.fromCharCode((v >>> 10) & 0x3FF | 0xD800);
                v = 0xDC00 | (v & 0x3FF);
            }
            out += String.fromCharCode(v);
        }
        return out;
    }

    function encode(input) {
        var inputArr = ucs2decode(input);
        var n = initialN;
        var delta = 0;
        var bias = initialBias;
        var output = [];

        for (var i = 0; i < inputArr.length; i++) {
            if (inputArr[i] < 0x80) output.push(String.fromCharCode(inputArr[i]));
        }
        var basicLength = output.length;
        var handledCPCount = basicLength;

        if (basicLength) output.push(delimiter);

        while (handledCPCount < inputArr.length) {
            var m = maxInt;
            for (var j = 0; j < inputArr.length; j++) {
                if (inputArr[j] >= n && inputArr[j] < m) m = inputArr[j];
            }
            delta += (m - n) * (handledCPCount + 1);
            n = m;
            for (var k = 0; k < inputArr.length; k++) {
                var cp = inputArr[k];
                if (cp < n) delta++;
                if (cp === n) {
                    var q = delta;
                    for (var t, w = base; ; w += base) {
                        t = w <= bias ? tMin : (w >= bias + tMax ? tMax : w - bias);
                        if (q < t) break;
                        output.push(String.fromCharCode(digitToBasic(t + (q - t) % (base - t))));
                        q = Math.floor((q - t) / (base - t));
                    }
                    output.push(String.fromCharCode(digitToBasic(q)));
                    bias = adapt(delta, handledCPCount + 1, handledCPCount === basicLength);
                    delta = 0;
                    handledCPCount++;
                }
            }
            delta++;
            n++;
        }
        return output.join('');
    }

    function decode(input) {
        var output = [];
        var i = 0, n = initialN, bias = initialBias;
        var basic = input.lastIndexOf(delimiter);
        if (basic < 0) basic = 0;
        for (var j = 0; j < basic; j++) {
            var c = input.charCodeAt(j);
            if (c >= 0x80) throw new RangeError('Invalid input');
            output.push(c);
        }
        var idx = basic > 0 ? basic + 1 : 0;
        while (idx < input.length) {
            var oldi = i;
            for (var w = 1, k = base; ; k += base) {
                if (idx >= input.length) throw new RangeError('Invalid input');
                var digit = basicToDigit(input.charCodeAt(idx++));
                if (digit >= base || digit > Math.floor((maxInt - i) / w)) throw new RangeError('Overflow');
                i += digit * w;
                var t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                if (digit < t) break;
                w *= (base - t);
            }
            var outLen = output.length + 1;
            bias = adapt(i - oldi, outLen, oldi === 0);
            if (Math.floor(i / outLen) > maxInt - n) throw new RangeError('Overflow');
            n += Math.floor(i / outLen);
            i %= outLen;
            output.splice(i++, 0, n);
        }
        return ucs2encode(output);
    }

    function toASCII(input) {
        return input.replace(/[^\0-\x7E]/, function() { return 'xn--' + encode(input); });
    }
    function toUnicode(input) {
        if (input.indexOf('xn--') === 0) return decode(input.slice(4));
        return input;
    }

    exports.encode = encode;
    exports.decode = decode;
    exports.toASCII = toASCII;
    exports.toUnicode = toUnicode;
    exports.ucs2 = { encode: ucs2encode, decode: ucs2decode };
    exports.version = '2.1.1-polyfill';
});

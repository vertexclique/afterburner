// util — small subset. `format` and `inspect` cover the >95% case
// (template strings with %s, %d, %j; object -> JSON-like stringification).

__register_module('util', function(module, exports, require) {

    // Matches Node's util.format: string args at the top level are
    // emitted verbatim; non-string args go through util.inspect. That
    // keeps `console.log("a", "b")` producing `"a b"` (no quotes) and
    // `console.log("a", ["b"])` producing `"a [ 'b' ]"` (quotes on the
    // ARRAY element via inspect, not on the top-level "a").
    function renderArg(arg) {
        return typeof arg === 'string' ? arg : exports.inspect(arg);
    }

    exports.format = function(fmt) {
        if (typeof fmt !== 'string') {
            var parts = [];
            for (var i = 0; i < arguments.length; i++) parts.push(renderArg(arguments[i]));
            return parts.join(' ');
        }
        var args = arguments;
        var argIdx = 1;
        var out = '';
        var i = 0;
        while (i < fmt.length) {
            var ch = fmt.charAt(i);
            if (ch !== '%' || i + 1 >= fmt.length) { out += ch; i++; continue; }
            var spec = fmt.charAt(i + 1);
            var val = args[argIdx++];
            if      (spec === 's') out += String(val);
            else if (spec === 'd' || spec === 'i') out += Number(val).toFixed(0);
            else if (spec === 'f') out += Number(val);
            else if (spec === 'j') { try { out += JSON.stringify(val); } catch (_) { out += '[Circular]'; } }
            else if (spec === 'o' || spec === 'O') out += exports.inspect(val);
            else if (spec === '%') { out += '%'; argIdx--; }
            else { out += ch; argIdx--; i++; continue; }
            i += 2;
        }
        while (argIdx < args.length) out += ' ' + renderArg(args[argIdx++]);
        return out;
    };

    exports.inspect = function(value, opts) {
        var seen = [];
        function go(v, depth) {
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            var t = typeof v;
            if (t === 'string') return JSON.stringify(v);
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
            if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
            if (t === 'symbol') return v.toString();
            if (seen.indexOf(v) !== -1) return '[Circular]';
            if (depth > 4) return '[Object]';
            seen.push(v);
            try {
                if (Array.isArray(v)) {
                    var items = v.map(function(x) { return go(x, depth + 1); });
                    return '[ ' + items.join(', ') + ' ]';
                }
                if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
                var keys = Object.keys(v);
                var kv = keys.map(function(k) { return k + ': ' + go(v[k], depth + 1); });
                return '{ ' + kv.join(', ') + ' }';
            } finally {
                seen.pop();
            }
        }
        return go(value, 0);
    };

    exports.inherits = function(ctor, superCtor) {
        if (typeof superCtor !== 'function') throw new TypeError('superCtor must be a function');
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
            constructor: { value: ctor, enumerable: false, writable: true, configurable: true }
        });
    };

    exports.promisify = function(fn) {
        return function() {
            var args = Array.prototype.slice.call(arguments);
            var self = this;
            return new Promise(function(resolve, reject) {
                args.push(function(err, val) { err ? reject(err) : resolve(val); });
                try { fn.apply(self, args); } catch (e) { reject(e); }
            });
        };
    };

    exports.callbackify = function(fn) {
        return function() {
            var cb = arguments[arguments.length - 1];
            var rest = Array.prototype.slice.call(arguments, 0, -1);
            Promise.resolve(fn.apply(this, rest))
                .then(function(v) { cb(null, v); })
                .catch(function(e) { cb(e); });
        };
    };

    exports.deprecate = function(fn, _msg) { return fn; };

    // util.types — deferred to the full `util/types` module so the
    // surface stays in one place and `require('util').types` returns
    // the same object as `require('util/types')`. The ALL ~40
    // type-test methods (`isFloat64Array`, `isAnyArrayBuffer`, etc.)
    // are a hard dependency for many libraries that probe object
    // shapes (oxc / acorn-walkers / koa-context, etc.).
    Object.defineProperty(exports, 'types', {
        configurable: true,
        enumerable: true,
        get: function() { return require('util/types'); },
    });

    exports.TextEncoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
    exports.TextDecoder = typeof TextDecoder === 'function' ? TextDecoder : undefined;

    // ---- util.styleText (Node 21/22) -----------------------------
    //
    // Wraps text in ANSI escape sequences when stdout is a TTY (we
    // approximate "is TTY" via env). The list of supported style
    // names matches Node's `util.styleText` accepted set; unknown
    // styles throw `ERR_INVALID_ARG_VALUE` like Node.
    var ANSI = {
        reset:     [0,  0],
        bold:      [1,  22],
        dim:       [2,  22],
        italic:    [3,  23],
        underline: [4,  24],
        blink:     [5,  25],
        inverse:   [7,  27],
        hidden:    [8,  28],
        strikethrough: [9, 29],
        black:     [30, 39],
        red:       [31, 39],
        green:     [32, 39],
        yellow:    [33, 39],
        blue:      [34, 39],
        magenta:   [35, 39],
        cyan:      [36, 39],
        white:     [37, 39],
        gray:      [90, 39],
        grey:      [90, 39],
        bgBlack:   [40, 49],
        bgRed:     [41, 49],
        bgGreen:   [42, 49],
        bgYellow:  [43, 49],
        bgBlue:    [44, 49],
        bgMagenta: [45, 49],
        bgCyan:    [46, 49],
        bgWhite:   [47, 49],
    };
    exports.styleText = function styleText(format, text, options) {
        var styles = Array.isArray(format) ? format : [format];
        for (var i = 0; i < styles.length; i++) {
            if (typeof styles[i] !== 'string' || !ANSI[styles[i]]) {
                var err = new TypeError("The argument 'format' must be a valid style. Received '" + styles[i] + "'");
                err.code = 'ERR_INVALID_ARG_VALUE';
                throw err;
            }
        }
        // `validateStream: false` in opts skips the TTY check —
        // Node's intent is "always emit colors when explicitly opted
        // in". Default behavior approximates the TTY check via
        // NO_COLOR / FORCE_COLOR env vars.
        var stream = options && options.stream;
        var validate = !options || options.validateStream !== false;
        if (validate) {
            if (typeof process !== 'undefined' && process.env) {
                if (process.env.NO_COLOR) return text;
            }
            // We assume TTY when the caller didn't pass a stream;
            // most CLI tools want colors. Pass `{ stream: ... }` to
            // pipe-aware contexts where that should be checked.
            if (stream && stream.isTTY === false) return text;
        }
        var prefix = '', suffix = '';
        for (var j = 0; j < styles.length; j++) {
            var pair = ANSI[styles[j]];
            prefix += '[' + pair[0] + 'm';
            suffix = '[' + pair[1] + 'm' + suffix;
        }
        return prefix + String(text) + suffix;
    };

    // ---- util.MIMEType / util.MIMEParams (Node 19/22) -------------
    function _parseMIME(input) {
        var s = String(input).trim();
        var slash = s.indexOf('/');
        if (slash < 0) {
            var e = new TypeError('Invalid MIME type: missing "/"');
            e.code = 'ERR_INVALID_MIME_SYNTAX';
            throw e;
        }
        var type = s.slice(0, slash).toLowerCase();
        var rest = s.slice(slash + 1);
        var semi = rest.indexOf(';');
        var sub = (semi < 0 ? rest : rest.slice(0, semi)).trim().toLowerCase();
        var params = [];
        if (semi >= 0) {
            var paramStr = rest.slice(semi + 1);
            var parts = paramStr.split(';');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].trim();
                if (!p) continue;
                var eq = p.indexOf('=');
                if (eq < 0) continue;
                var k = p.slice(0, eq).trim().toLowerCase();
                var v = p.slice(eq + 1).trim();
                if (v.length >= 2 && v.charCodeAt(0) === 34 && v.charCodeAt(v.length - 1) === 34) {
                    v = v.slice(1, -1).replace(/\\(.)/g, '$1');
                }
                params.push([k, v]);
            }
        }
        return { type: type, subtype: sub, params: params };
    }
    function MIMEParams(pairs) { this._pairs = pairs.slice(); }
    MIMEParams.prototype.get = function(name) {
        var k = String(name).toLowerCase();
        for (var i = 0; i < this._pairs.length; i++) {
            if (this._pairs[i][0] === k) return this._pairs[i][1];
        }
        return null;
    };
    MIMEParams.prototype.has = function(name) { return this.get(name) !== null; };
    MIMEParams.prototype.set = function(name, value) {
        var k = String(name).toLowerCase();
        for (var i = 0; i < this._pairs.length; i++) {
            if (this._pairs[i][0] === k) { this._pairs[i][1] = String(value); return; }
        }
        this._pairs.push([k, String(value)]);
    };
    MIMEParams.prototype.delete = function(name) {
        var k = String(name).toLowerCase();
        this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
    };
    MIMEParams.prototype.entries = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i].slice(); };
    MIMEParams.prototype.keys    = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i][0]; };
    MIMEParams.prototype.values  = function*() { for (var i = 0; i < this._pairs.length; i++) yield this._pairs[i][1]; };
    MIMEParams.prototype[Symbol.iterator] = MIMEParams.prototype.entries;
    MIMEParams.prototype.toString = function() {
        return this._pairs.map(function(p) {
            var v = p[1];
            return p[0] + '=' + (/[^A-Za-z0-9_\-.+]/.test(v) ? '"' + v.replace(/(["\\])/g, '\\$1') + '"' : v);
        }).join(';');
    };

    function MIMEType(input) {
        var parsed = _parseMIME(input);
        this._type = parsed.type;
        this._sub = parsed.subtype;
        this.params = new MIMEParams(parsed.params);
    }
    Object.defineProperty(MIMEType.prototype, 'type', {
        get: function() { return this._type; },
        set: function(v) { this._type = String(v).toLowerCase(); },
    });
    Object.defineProperty(MIMEType.prototype, 'subtype', {
        get: function() { return this._sub; },
        set: function(v) { this._sub = String(v).toLowerCase(); },
    });
    Object.defineProperty(MIMEType.prototype, 'essence', {
        get: function() { return this._type + '/' + this._sub; },
    });
    MIMEType.prototype.toString = function() {
        var p = this.params.toString();
        return this._type + '/' + this._sub + (p ? ';' + p : '');
    };
    MIMEType.prototype.toJSON = MIMEType.prototype.toString;
    exports.MIMEType = MIMEType;
    exports.MIMEParams = MIMEParams;

    // ---- util.parseArgs (Node 18.3+ stable, v2 surface in 22) ----
    //
    // Parses argv per a small `options` schema:
    //   { foo: { type: 'string', short: 'f', multiple: true,
    //            default: 'x' } }
    // Returns `{ values, positionals, tokens? }`.
    //
    // Supported v2 surface: `tokens: true` returns the full token
    // stream (per arg, with `kind`: option / positional / option-
    // terminator). Strict mode rejects unknown options like Node.
    exports.parseArgs = function parseArgs(config) {
        var cfg = config || {};
        var args = cfg.args || (typeof process !== 'undefined' && process.argv ? process.argv.slice(2) : []);
        var options = cfg.options || {};
        var strict = cfg.strict !== false;
        var allowPositionals = cfg.allowPositionals === true;
        var allowNegative = cfg.allowNegative === true;
        var wantTokens = cfg.tokens === true;

        // Build short-flag → long-name map.
        var shortMap = {};
        var longNames = Object.keys(options);
        for (var li = 0; li < longNames.length; li++) {
            var n = longNames[li];
            var spec = options[n];
            if (!spec || typeof spec !== 'object') continue;
            if (typeof spec.short === 'string' && spec.short.length > 0) {
                shortMap[spec.short] = n;
            }
        }

        function specOf(name) {
            var s = options[name];
            return s && typeof s === 'object' ? s : null;
        }
        function setValue(values, name, value) {
            var s = specOf(name);
            if (s && s.multiple) {
                if (!values[name]) values[name] = [];
                values[name].push(value);
            } else {
                values[name] = value;
            }
        }
        function consumeBoolean(values, name, raw) {
            setValue(values, name, raw);
            if (wantTokens) {
                tokens.push({ kind: 'option', name: name, rawName: raw === false ? '--no-' + name : null,
                              value: undefined, inlineValue: undefined });
            }
        }

        var values = {};
        var positionals = [];
        var tokens = [];

        // Apply defaults.
        for (var di = 0; di < longNames.length; di++) {
            var dn = longNames[di];
            var ds = specOf(dn);
            if (ds && Object.prototype.hasOwnProperty.call(ds, 'default')) {
                values[dn] = ds.default;
            }
        }

        var i = 0;
        var sawTerminator = false;
        while (i < args.length) {
            var a = args[i];
            if (sawTerminator) {
                positionals.push(a);
                if (wantTokens) tokens.push({ kind: 'positional', index: i, value: a });
                i++;
                continue;
            }
            if (a === '--') {
                sawTerminator = true;
                if (wantTokens) tokens.push({ kind: 'option-terminator', index: i });
                i++;
                continue;
            }
            // Long form: `--name`, `--name=value`, `--no-name`.
            if (a.length > 2 && a[0] === '-' && a[1] === '-') {
                var body = a.slice(2);
                var eq = body.indexOf('=');
                var name = eq >= 0 ? body.slice(0, eq) : body;
                var inline = eq >= 0 ? body.slice(eq + 1) : undefined;
                if (allowNegative && name.indexOf('no-') === 0 && options[name.slice(3)]) {
                    setValue(values, name.slice(3), false);
                    if (wantTokens) tokens.push({ kind: 'option', name: name.slice(3),
                                                  rawName: a, value: false, inlineValue: undefined });
                    i++;
                    continue;
                }
                var s = specOf(name);
                if (!s) {
                    if (strict) {
                        var e = new TypeError("Unknown option '--" + name + "'");
                        e.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
                        throw e;
                    }
                    if (allowPositionals) positionals.push(a);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: inline, inlineValue: inline });
                    i++;
                    continue;
                }
                if (s.type === 'boolean') {
                    setValue(values, name, true);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: true, inlineValue: undefined });
                    i++;
                } else {
                    var val = inline !== undefined ? inline : args[++i];
                    setValue(values, name, val);
                    if (wantTokens) tokens.push({ kind: 'option', name: name, rawName: a,
                                                  value: val, inlineValue: inline });
                    i++;
                }
                continue;
            }
            // Short form: `-f`, `-fvalue`, `-fxyz` (cluster of bools).
            if (a.length >= 2 && a[0] === '-' && a[1] !== '-') {
                var rest = a.slice(1);
                var consumed = false;
                for (var ri = 0; ri < rest.length; ri++) {
                    var c = rest[ri];
                    var longName = shortMap[c];
                    if (!longName) {
                        if (strict) {
                            var e2 = new TypeError("Unknown option '-" + c + "'");
                            e2.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
                            throw e2;
                        }
                        break;
                    }
                    var sp = specOf(longName);
                    if (sp && sp.type === 'string') {
                        var rem = rest.slice(ri + 1);
                        var sval = rem.length ? rem : args[++i];
                        setValue(values, longName, sval);
                        if (wantTokens) tokens.push({ kind: 'option', name: longName, rawName: a,
                                                      value: sval, inlineValue: rem.length ? rem : undefined });
                        consumed = true;
                        break;
                    }
                    setValue(values, longName, true);
                    if (wantTokens) tokens.push({ kind: 'option', name: longName, rawName: a,
                                                  value: true, inlineValue: undefined });
                }
                if (!consumed) i++;
                else i++;
                continue;
            }
            // Bare positional.
            if (!allowPositionals && strict) {
                var e3 = new TypeError("Unexpected positional argument '" + a + "'");
                e3.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
                throw e3;
            }
            positionals.push(a);
            if (wantTokens) tokens.push({ kind: 'positional', index: i, value: a });
            i++;
        }
        var out = { values: values, positionals: positionals };
        if (wantTokens) out.tokens = tokens;
        return out;
    };

    // ---- util.transferableAbortSignal / util.aborted (Node 22) ----
    //
    // `transferableAbortSignal(s)` returns a signal usable across
    // worker postMessage boundaries; in our model AbortSignal is
    // already a plain object so the transfer is a no-op identity.
    // `aborted(signal, resource)` returns a Promise that rejects
    // with the abort reason (matches the Node 18.3+ contract).
    exports.transferableAbortSignal = function transferableAbortSignal(signal) {
        return signal;
    };
    exports.aborted = function aborted(signal, _resource) {
        if (!signal || typeof signal.addEventListener !== 'function') {
            return Promise.reject(new TypeError('aborted: argument must be an AbortSignal'));
        }
        if (signal.aborted) {
            return Promise.reject(signal.reason || new Error('aborted'));
        }
        return new Promise(function(_resolve, reject) {
            signal.addEventListener('abort', function() {
                reject(signal.reason || new Error('aborted'));
            }, { once: true });
        });
    };
});

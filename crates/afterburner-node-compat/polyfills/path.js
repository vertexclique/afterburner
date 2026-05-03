// path — POSIX subset. Good enough for the overwhelming majority of
// server-side and ETL scripts; win32 path handling is out of scope.

__register_module('path', function(module, exports, require) {
    var SEP = '/';

    function assertString(x) {
        if (typeof x !== 'string') {
            throw new TypeError("Path must be a string. Received " + typeof x);
        }
    }

    // Collapse `.`, `..`, and redundant separators. Mirrors Node's
    // `normalizeString` helper without bothering to distinguish win32.
    function normalizeString(path, allowAboveRoot) {
        var res = '';
        var lastSegmentLength = 0;
        var lastSlash = -1;
        var dots = 0;
        var code;
        for (var i = 0; i <= path.length; ++i) {
            if (i < path.length) code = path.charCodeAt(i);
            else if (code === 47) break;
            else code = 47;

            if (code === 47) { // '/'
                if (lastSlash === i - 1 || dots === 1) {
                    // no-op
                } else if (lastSlash !== i - 1 && dots === 2) {
                    if (res.length < 2 || lastSegmentLength !== 2 ||
                        res.charCodeAt(res.length - 1) !== 46 ||
                        res.charCodeAt(res.length - 2) !== 46) {
                        if (res.length > 2) {
                            var lastSlashIndex = res.lastIndexOf('/');
                            if (lastSlashIndex === -1) {
                                res = '';
                                lastSegmentLength = 0;
                            } else {
                                res = res.slice(0, lastSlashIndex);
                                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        } else if (res.length === 2 || res.length === 1) {
                            res = '';
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot) {
                        if (res.length > 0) res += '/..';
                        else res = '..';
                        lastSegmentLength = 2;
                    }
                } else {
                    if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
                    else res = path.slice(lastSlash + 1, i);
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            } else if (code === 46 && dots !== -1) {
                ++dots;
            } else {
                dots = -1;
            }
        }
        return res;
    }

    exports.sep = SEP;
    exports.delimiter = ':';

    exports.normalize = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var isAbs = p.charCodeAt(0) === 47;
        var trailingSep = p.charCodeAt(p.length - 1) === 47;
        p = normalizeString(p, !isAbs);
        if (p.length === 0 && !isAbs) p = '.';
        if (p.length > 0 && trailingSep) p += '/';
        return isAbs ? '/' + p : p;
    };

    exports.isAbsolute = function(p) {
        assertString(p);
        return p.length > 0 && p.charCodeAt(0) === 47;
    };

    exports.join = function() {
        if (arguments.length === 0) return '.';
        var joined;
        for (var i = 0; i < arguments.length; ++i) {
            var arg = arguments[i];
            assertString(arg);
            if (arg.length > 0) {
                if (joined === undefined) joined = arg;
                else joined += '/' + arg;
            }
        }
        if (joined === undefined) return '.';
        return exports.normalize(joined);
    };

    exports.resolve = function() {
        var resolved = '';
        var resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var p = (i >= 0) ? arguments[i] : '/';
            assertString(p);
            if (p.length === 0) continue;
            resolved = p + '/' + resolved;
            resolvedAbsolute = p.charCodeAt(0) === 47;
        }
        resolved = normalizeString(resolved, !resolvedAbsolute);
        if (resolvedAbsolute) return '/' + resolved;
        return resolved.length > 0 ? resolved : '.';
    };

    exports.dirname = function(p) {
        assertString(p);
        if (p.length === 0) return '.';
        var hasRoot = p.charCodeAt(0) === 47;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 1; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { end = i; break; }
            } else {
                matchedSlash = false;
            }
        }
        if (end === -1) return hasRoot ? '/' : '.';
        if (hasRoot && end === 1) return '//';
        return p.slice(0, end);
    };

    exports.basename = function(p, ext) {
        assertString(p);
        if (ext !== undefined) assertString(ext);
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        for (var i = p.length - 1; i >= 0; --i) {
            if (p.charCodeAt(i) === 47) {
                if (!matchedSlash) { start = i + 1; break; }
            } else if (end === -1) {
                matchedSlash = false;
                end = i + 1;
            }
        }
        if (end === -1) return '';
        var base = p.slice(start, end);
        if (ext && base.length >= ext.length && base.slice(base.length - ext.length) === ext) {
            base = base.slice(0, base.length - ext.length);
        }
        return base;
    };

    exports.extname = function(p) {
        assertString(p);
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var preDotState = 0;
        for (var i = p.length - 1; i >= 0; --i) {
            var code = p.charCodeAt(i);
            if (code === 47) {
                if (!matchedSlash) { startPart = i + 1; break; }
                continue;
            }
            if (end === -1) { matchedSlash = false; end = i + 1; }
            if (code === 46) {
                if (startDot === -1) startDot = i;
                else if (preDotState !== 1) preDotState = 1;
            } else if (startDot !== -1) {
                preDotState = -1;
            }
        }
        if (startDot === -1 || end === -1 || preDotState === 0 ||
            (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
            return '';
        }
        return p.slice(startDot, end);
    };

    exports.parse = function(p) {
        assertString(p);
        var ret = { root: '', dir: '', base: '', ext: '', name: '' };
        if (p.length === 0) return ret;
        var isAbs = p.charCodeAt(0) === 47;
        if (isAbs) ret.root = '/';
        var base = exports.basename(p);
        var dir = exports.dirname(p);
        ret.dir = isAbs && dir === '/' ? '/' : dir === '.' && !isAbs ? '' : dir;
        ret.base = base;
        ret.ext = exports.extname(base);
        ret.name = ret.ext.length > 0 ? base.slice(0, base.length - ret.ext.length) : base;
        return ret;
    };

    exports.format = function(obj) {
        if (obj === null || typeof obj !== 'object') {
            throw new TypeError('path.format requires an object');
        }
        var dir = obj.dir || obj.root || '';
        var base = obj.base || ((obj.name || '') + (obj.ext || ''));
        if (!dir) return base;
        if (dir === obj.root) return dir + base;
        return dir + '/' + base;
    };

    exports.posix = exports;
});

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

    // path.relative(from, to) — express the relative path from one
    // absolute path to another. arborist's `relpath`, every workspace
    // resolver, every test runner, and most build tools depend on
    // this. Algorithm matches Node's implementation: resolve both
    // arguments, find the common prefix, walk back from `from` and
    // forward to `to`.
    exports.relative = function(from, to) {
        assertString(from);
        assertString(to);
        if (from === to) return '';
        from = exports.resolve(from);
        to = exports.resolve(to);
        if (from === to) return '';
        // Trim leading slashes for the segment scan; we know both are
        // absolute after `resolve`.
        var fromSegs = from.slice(1).split('/').filter(function(s) { return s.length; });
        var toSegs = to.slice(1).split('/').filter(function(s) { return s.length; });
        var common = 0;
        var max = Math.min(fromSegs.length, toSegs.length);
        while (common < max && fromSegs[common] === toSegs[common]) common++;
        var up = fromSegs.length - common;
        var rest = toSegs.slice(common);
        var out = [];
        for (var i = 0; i < up; i++) out.push('..');
        for (var j = 0; j < rest.length; j++) out.push(rest[j]);
        return out.join('/') || '.';
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

    // path.win32 — Node always exposes both flavours; many libraries
    // (npm's `tar`, fs-extra, archive utilities) reach for
    // `require('path').win32.{isAbsolute,parse}` to normalise paths
    // even on Linux. We provide a Windows-shaped twin: backslash is
    // an additional separator, drive letters are recognised as
    // absolute (`c:/foo`, `\\?\drive\...`), and the rest of the
    // surface mirrors POSIX with `\\` separators.
    var win32 = {};
    win32.sep = '\\';
    win32.delimiter = ';';
    win32.posix = exports;
    win32.win32 = win32;
    function _winSplit(p) {
        return String(p).replace(/\//g, '\\').split('\\').filter(function(s) { return s.length > 0 || false; });
    }
    win32.isAbsolute = function(p) {
        var s = String(p);
        if (s.length === 0) return false;
        if (s.charAt(0) === '/' || s.charAt(0) === '\\') return true;
        // c:/foo or c:\foo
        if (s.length >= 3 && /^[a-z]:[\/\\]/i.test(s)) return true;
        // c:foo (drive-relative — not absolute, but Node treats some
        // shapes as absolute. Conservative: false here.)
        return false;
    };
    win32.normalize = function(p) {
        var s = String(p).replace(/\//g, '\\');
        // Drive letter detection.
        var rootMatch = /^([a-z]:)?[\\\\]?/i.exec(s);
        var drive = rootMatch && rootMatch[1] ? rootMatch[1] : '';
        var rooted = /^([a-z]:)?[\\]/i.test(s);
        var rest = s.slice((drive.length) + (rooted ? 1 : 0));
        var parts = rest.split('\\').filter(function(p) { return p && p !== '.'; });
        var stack = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '..') {
                if (stack.length && stack[stack.length-1] !== '..') stack.pop();
                else if (!rooted) stack.push('..');
            } else { stack.push(parts[i]); }
        }
        return drive + (rooted ? '\\' : '') + stack.join('\\');
    };
    win32.join = function() {
        var args = [].slice.call(arguments).filter(function(a) { return a && a.length; });
        if (args.length === 0) return '.';
        return win32.normalize(args.join('\\'));
    };
    win32.resolve = function() {
        var args = [].slice.call(arguments);
        var resolved = '';
        for (var i = args.length - 1; i >= -1; i--) {
            var p = (i >= 0) ? args[i] : '\\';
            if (!p || p.length === 0) continue;
            resolved = p + '\\' + resolved;
            if (win32.isAbsolute(p)) break;
        }
        return win32.normalize(resolved);
    };
    win32.dirname = function(p) {
        var s = String(p).replace(/\//g, '\\');
        var idx = s.lastIndexOf('\\');
        if (idx < 0) return '.';
        if (idx === 0) return '\\';
        return s.slice(0, idx);
    };
    win32.basename = function(p, ext) {
        var s = String(p).replace(/\//g, '\\');
        var idx = s.lastIndexOf('\\');
        var base = idx >= 0 ? s.slice(idx + 1) : s;
        if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
        return base;
    };
    win32.extname = function(p) {
        var b = win32.basename(p);
        var idx = b.lastIndexOf('.');
        if (idx <= 0) return '';
        return b.slice(idx);
    };
    win32.parse = function(p) {
        var s = String(p).replace(/\//g, '\\');
        var ret = { root: '', dir: '', base: '', ext: '', name: '' };
        // Detect drive root.
        var driveMatch = /^([a-z]:)([\\]?)/i.exec(s);
        if (driveMatch) {
            ret.root = driveMatch[1] + (driveMatch[2] || '');
        } else if (s.charAt(0) === '\\') {
            ret.root = '\\';
        }
        ret.base = win32.basename(p);
        ret.dir = win32.dirname(p);
        ret.ext = win32.extname(ret.base);
        ret.name = ret.ext ? ret.base.slice(0, ret.base.length - ret.ext.length) : ret.base;
        return ret;
    };
    win32.format = function(obj) {
        var dir = obj.dir || obj.root || '';
        var base = obj.base || ((obj.name || '') + (obj.ext || ''));
        if (!dir) return base;
        if (dir === obj.root) return dir + base;
        return dir + '\\' + base;
    };
    win32.toNamespacedPath = function(p) { return String(p); };
    win32.relative = function(from, to) {
        from = win32.resolve(String(from));
        to = win32.resolve(String(to));
        if (from === to) return '';
        var fromSegs = from.split('\\').filter(function(s) { return s.length; });
        var toSegs = to.split('\\').filter(function(s) { return s.length; });
        var common = 0;
        var max = Math.min(fromSegs.length, toSegs.length);
        while (common < max && fromSegs[common].toLowerCase() === toSegs[common].toLowerCase()) common++;
        var up = fromSegs.length - common;
        var rest = toSegs.slice(common);
        var out = [];
        for (var i = 0; i < up; i++) out.push('..');
        for (var j = 0; j < rest.length; j++) out.push(rest[j]);
        return out.join('\\') || '.';
    };
    win32.matchesGlob = function(p, pattern) {
        var re = new RegExp('^' + String(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$');
        return re.test(String(p));
    };
    exports.win32 = win32;

    // Posix-side `toNamespacedPath` and `matchesGlob` (Node 22+).
    exports.toNamespacedPath = function(p) { return String(p); };
    exports.matchesGlob = function(p, pattern) {
        var re = new RegExp('^' + String(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$');
        return re.test(String(p));
    };
});

// vm — Node 20's "VM" (Virtual Machine) module.
//
// Real Node uses V8's vm.runInContext / runInNewContext to run JS
// in a separate context. Burn IS a JS sandbox already (everything
// runs inside one) — there's no nested-context boundary to cross.
// We give callers a Node-compatible surface that uses `eval` /
// fresh evaluation contexts where possible.
//
// Trade-offs vs Node:
//   * `runInThisContext(code)` does what `eval(code)` would, in the
//     current global. Same scope as Node's variant.
//   * `runInNewContext(code, sandbox)` evaluates `code` in a
//     standalone object so writes don't leak to the caller's globals.
//     QuickJS doesn't expose first-class context creation from JS,
//     so we approximate by wrapping the code in `(function() { ... }).call(sandbox)`
//     — `this` becomes the sandbox object, top-level `var` ends up
//     on the sandbox via `with()`-like rebinding.
//   * `Script` class supports `runInThisContext` / `runInNewContext`.
//   * `compileFunction(...)` is implemented via Function constructor.

__register_module('vm', function(module, exports, require) {

    function isContext(obj) {
        // A "vm context" in Node is a sandbox object. We mark
        // objects as contexts via a Symbol so `isContext` is stable.
        return !!(obj && obj.__ab_vm_context === true);
    }

    function createContext(sandbox, options) {
        sandbox = sandbox || {};
        // Mark as a vm context so isContext() recognizes it.
        Object.defineProperty(sandbox, '__ab_vm_context', {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        var _ = options;
        return sandbox;
    }

    function runInThisContext(code, options) {
        var _ = options;
        // No isolation — same context as the caller. Spec-compatible.
        return (0, eval)(String(code));
    }

    /// `runInNewContext` evaluates `code` against a fresh object so
    /// writes to top-level identifiers land on `sandbox`, not on
    /// `globalThis`. QuickJS lacks first-class contexts, so we
    /// approximate via an IIFE bound to the sandbox + `with()` for
    /// transparent identifier resolution.
    function runInNewContext(code, sandbox, options) {
        sandbox = sandbox || {};
        if (!isContext(sandbox)) {
            // Auto-context the sandbox the first time.
            createContext(sandbox);
        }
        var _ = options;
        // Use `eval` inside `with(sandbox)` so the completion value
        // of the script comes back to the caller — matches Node's
        // V8-eval semantics where `runInNewContext('1+2', {})` is
        // `3`. `with` is the only construct that makes top-level
        // identifier lookups resolve against `sandbox` first; eval's
        // completion value is the final-expression value, same as
        // Node.
        var wrapper = new Function(
            '__ab_sandbox__', '__ab_code__',
            'with (__ab_sandbox__) { return eval(__ab_code__); }'
        );
        return wrapper(sandbox, String(code));
    }

    function runInContext(code, ctx, options) {
        if (!isContext(ctx)) {
            throw new TypeError(
                'vm.runInContext: contextifiedObject must be a context (call vm.createContext first)'
            );
        }
        return runInNewContext(code, ctx, options);
    }

    function compileFunction(code, params, options) {
        var args = (params || []).slice();
        args.push(String(code));
        return new (Function.prototype.bind.apply(Function, [null].concat(args)));
    }

    // ---- Script class --------------------------------------------

    function Script(code, options) {
        if (!(this instanceof Script)) return new Script(code, options);
        this.code = String(code);
        this._options = options || {};
        // Pre-compile at construction time so syntax errors throw
        // immediately, matching Node's spec.
        try {
            new Function(this.code);
        } catch (e) {
            throw e;
        }
    }
    Script.prototype.runInThisContext = function(options) {
        return runInThisContext(this.code, options);
    };
    Script.prototype.runInContext = function(ctx, options) {
        return runInContext(this.code, ctx, options);
    };
    Script.prototype.runInNewContext = function(sandbox, options) {
        return runInNewContext(this.code, sandbox, options);
    };
    Script.prototype.createCachedData = function() {
        // No bytecode caching surface from QuickJS to JS.
        return Buffer ? Buffer.alloc(0) : new Uint8Array(0);
    };

    // ---- Module / SourceTextModule / SyntheticModule -------------
    //
    // ES module records inside vm. Lifecycle: unlinked → linking →
    // linked → evaluating → evaluated (or errored). Lowered to CJS
    // shape via the host TS / ESM transpile hook so the body can run
    // through `new Function` with a custom dependency map.

    var ABSTRACT_MODULE_BASE = function() {};

    function _lowerEsm(source, identifier) {
        var hook = globalThis.__host_ts_transpile;
        if (typeof hook !== 'function') {
            throw new Error('vm.SourceTextModule: ESM lowering requires the '
                + '`ts` cargo feature (or any build that enables '
                + '__host_ts_transpile)');
        }
        var path = '/__vm_module__/' + identifier + '.mjs';
        var lowered = hook(source, path);
        if (typeof lowered === 'string' && lowered.indexOf('__HOST_ERR__:') === 0) {
            throw new SyntaxError(lowered.slice('__HOST_ERR__:'.length));
        }
        return String(lowered);
    }

    /// Top-level `require('xxx')` calls in the lowered body become
    /// dep-map lookups. We swap them out at evaluate-time so the body
    /// can be re-evaluated against different linker resolutions
    /// (matches Node's vm.SourceTextModule semantics where each link
    /// → evaluate cycle binds fresh imports).
    var _REQUIRE_RX = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    function _scanSpecifiers(body) {
        var seen = Object.create(null);
        var out = [];
        var m;
        _REQUIRE_RX.lastIndex = 0;
        while ((m = _REQUIRE_RX.exec(body)) !== null) {
            if (!seen[m[1]]) {
                seen[m[1]] = true;
                out.push(m[1]);
            }
        }
        return out;
    }
    function _rewriteRequiresToDepMap(body) {
        return body.replace(_REQUIRE_RX, function(_, spec) {
            return '__ab_stm_dep[' + JSON.stringify(spec) + ']';
        });
    }

    function SourceTextModule(source, options) {
        if (!(this instanceof SourceTextModule)) {
            throw new TypeError('Class constructor SourceTextModule cannot be invoked without new');
        }
        options = options || {};
        this._source = String(source);
        this.identifier = options.identifier || 'vm:source-text-module-' + (++_modCounter);
        this.context = options.context;
        this._status = 'unlinked';
        this._error = null;
        this._namespace = null;
        this._deps = Object.create(null);
        this._depNamespaces = Object.create(null);

        // Lower ESM body once at construction.
        this._cjsBody = _lowerEsm(this._source, this.identifier);
        this._dependencySpecifiers = _scanSpecifiers(this._cjsBody);
    }
    var _modCounter = 0;

    SourceTextModule.prototype = Object.create(ABSTRACT_MODULE_BASE.prototype);
    SourceTextModule.prototype.constructor = SourceTextModule;

    Object.defineProperty(SourceTextModule.prototype, 'status', {
        get: function() { return this._status; },
    });
    Object.defineProperty(SourceTextModule.prototype, 'error', {
        get: function() {
            if (this._status !== 'errored') {
                throw new Error('Module status is ' + this._status + ', not errored');
            }
            return this._error;
        },
    });
    Object.defineProperty(SourceTextModule.prototype, 'namespace', {
        get: function() {
            if (this._status !== 'linked' && this._status !== 'evaluating'
                && this._status !== 'evaluated') {
                throw new Error('Module namespace requested before link()');
            }
            return this._namespace;
        },
    });
    Object.defineProperty(SourceTextModule.prototype, 'dependencySpecifiers', {
        get: function() { return this._dependencySpecifiers.slice(); },
    });

    /// Build a live-binding namespace proxy whose property reads
    /// forward to `dep._namespace` at access time. With cyclic graphs
    /// the dep's namespace fills in as evaluation walks the SCC, so
    /// late-bound reads (inside function bodies that fire after the
    /// cycle finishes evaluating) see the post-evaluate values.
    /// Plain (non-Module) deps fall back to snapshot semantics —
    /// nothing to track over time.
    function _liveNamespace(dep) {
        if (!(dep instanceof ABSTRACT_MODULE_BASE)) {
            return dep;
        }
        return new Proxy(Object.create(null), {
            get: function(_target, key) {
                var ns = dep._namespace;
                if (ns == null) return undefined;
                return ns[key];
            },
            has: function(_target, key) {
                var ns = dep._namespace;
                return !!ns && (key in ns);
            },
            ownKeys: function() {
                var ns = dep._namespace;
                return ns ? Object.keys(ns) : [];
            },
            getOwnPropertyDescriptor: function(_t, key) {
                var ns = dep._namespace;
                if (!ns || !(key in ns)) return undefined;
                return {
                    enumerable: true,
                    configurable: true,
                    writable: false,
                    value: ns[key],
                };
            },
        });
    }

    SourceTextModule.prototype.link = function(linker) {
        var self = this;
        if (typeof linker !== 'function') {
            return Promise.reject(new TypeError('linker must be a function'));
        }
        if (self._status !== 'unlinked') {
            return Promise.reject(new Error(
                'Module status is ' + self._status + ', expected unlinked'));
        }
        return self._linkInternal(linker, /*visited=*/ Object.create(null));
    };

    /// Worker that walks the dependency graph with cycle detection.
    /// `visited` is a per-link-call identity map — keyed by module
    /// identifier — that records every module we've already entered.
    /// When the linker resolves a spec to a module already in
    /// `visited`, we skip the recursive `link()` call (the back-edge
    /// is satisfied) and stash a live-binding namespace proxy so
    /// post-evaluate reads still see the populated exports.
    SourceTextModule.prototype._linkInternal = function(linker, visited) {
        var self = this;
        if (visited[self.identifier]) {
            // Already entered through another path — the caller's
            // ancestor will finish linking us.
            return Promise.resolve();
        }
        visited[self.identifier] = true;
        self._status = 'linking';
        // Pre-allocate the namespace placeholder so live-binding
        // proxies built for back-edges have a stable target. The
        // exports populate during evaluate().
        if (self._namespace == null) self._namespace = Object.create(null);

        var specs = self._dependencySpecifiers.slice();
        var i = 0;
        function next() {
            if (i >= specs.length) {
                self._status = 'linked';
                return undefined;
            }
            var spec = specs[i++];
            return Promise.resolve(linker(spec, self, { assert: {} }))
                .then(function(dep) {
                    if (dep == null) {
                        throw new Error('linker returned null for ' + spec);
                    }
                    self._deps[spec] = dep;
                    self._depNamespaces[spec] = _liveNamespace(dep);
                    if (dep instanceof ABSTRACT_MODULE_BASE
                        && dep._status === 'unlinked'
                        && !visited[dep.identifier]) {
                        return Promise.resolve(dep._linkInternal(linker, visited))
                            .then(next);
                    }
                    return next();
                });
        }
        return Promise.resolve().then(next);
    };

    SourceTextModule.prototype.evaluate = function(_options) {
        return this._evaluateInternal(/*visited=*/ Object.create(null));
    };

    /// Cycle-aware evaluator. `visited` is shared across recursive
    /// `evaluate` walks so a back-edge (B depends on A while A is
    /// `'evaluating'`) doesn't re-enter A's body. Cyclic deps see
    /// each other through the live-binding proxy installed at link
    /// time: their namespace property reads forward to whichever
    /// module finishes its body first.
    SourceTextModule.prototype._evaluateInternal = function(visited) {
        var self = this;
        if (self._status === 'evaluated') return Promise.resolve(undefined);
        if (self._status === 'evaluating') {
            // Back-edge in a cycle. The ancestor's evaluate() will
            // complete our population once its own body returns.
            return Promise.resolve(undefined);
        }
        if (self._status !== 'linked') {
            return Promise.reject(new Error(
                'Module status is ' + self._status + ', expected linked'));
        }
        if (visited[self.identifier]) {
            // Already in the recursion frame — same condition as the
            // 'evaluating' check above but re-stated for graphs that
            // mix link/evaluate calls non-monotonically.
            return Promise.resolve(undefined);
        }
        visited[self.identifier] = true;
        self._status = 'evaluating';
        return new Promise(function(resolve, reject) {
            try {
                var depKeys = Object.keys(self._deps);
                var i = 0;
                function evalNext() {
                    if (i >= depKeys.length) return runBody();
                    var dep = self._deps[depKeys[i++]];
                    if (dep instanceof ABSTRACT_MODULE_BASE
                        && dep._status === 'linked') {
                        return dep._evaluateInternal(visited).then(evalNext);
                    }
                    return evalNext();
                }
                function runBody() {
                    var body = _rewriteRequiresToDepMap(self._cjsBody);
                    var moduleObj = { exports: self._namespace || Object.create(null) };
                    var fn = new Function(
                        '__ab_stm_dep', 'module', 'exports', '__filename', '__dirname',
                        body
                    );
                    fn(self._depNamespaces, moduleObj, moduleObj.exports,
                       '/__vm_module__/' + self.identifier + '.mjs',
                       '/__vm_module__');
                    var actualExports = moduleObj.exports;
                    // Reuse the namespace placeholder allocated at
                    // link time so any live-binding Proxy already
                    // pointing at it continues to resolve. The
                    // namespace isn't frozen — cyclic deps may finish
                    // populating their own exports after this body
                    // returns.
                    var ns = self._namespace;
                    if (actualExports && typeof actualExports === 'object') {
                        var keys = Object.keys(actualExports);
                        for (var j = 0; j < keys.length; j++) {
                            ns[keys[j]] = actualExports[keys[j]];
                        }
                        if ('default' in actualExports && !('default' in ns)) {
                            ns['default'] = actualExports['default'];
                        }
                    } else if (actualExports !== undefined) {
                        ns['default'] = actualExports;
                    }
                    self._status = 'evaluated';
                    resolve(undefined);
                }
                Promise.resolve().then(evalNext).catch(function(e) {
                    self._status = 'errored';
                    self._error = e;
                    reject(e);
                });
            } catch (e) {
                self._status = 'errored';
                self._error = e;
                reject(e);
            }
        });
    };

    SourceTextModule.prototype.createCachedData = function() {
        // No bytecode caching surface exposed from QuickJS to JS.
        return Buffer.alloc(0);
    };

    /// `vm.SyntheticModule(exportNames, evaluateCallback, options)` —
    /// a module whose body is a JS callback that calls
    /// `setExport(name, value)` for each named export. Used by hosts
    /// embedding non-JS data as ESM (CSS imports, JSON modules).
    function SyntheticModule(exportNames, evaluateCallback, options) {
        if (!(this instanceof SyntheticModule)) {
            throw new TypeError('Class constructor SyntheticModule cannot be invoked without new');
        }
        options = options || {};
        if (!Array.isArray(exportNames)) {
            throw new TypeError('exportNames must be an array of strings');
        }
        if (typeof evaluateCallback !== 'function') {
            throw new TypeError('evaluateCallback must be a function');
        }
        this.identifier = options.identifier || 'vm:synthetic-module-' + (++_modCounter);
        this.context = options.context;
        this._status = 'unlinked';
        this._error = null;
        this._exportNames = exportNames.slice();
        this._evaluateCallback = evaluateCallback;
        this._exports = Object.create(null);
        this._namespace = null;
        this._dependencySpecifiers = [];
    }
    SyntheticModule.prototype = Object.create(ABSTRACT_MODULE_BASE.prototype);
    SyntheticModule.prototype.constructor = SyntheticModule;

    Object.defineProperty(SyntheticModule.prototype, 'status', {
        get: function() { return this._status; },
    });
    Object.defineProperty(SyntheticModule.prototype, 'error', {
        get: function() {
            if (this._status !== 'errored') {
                throw new Error('Module status is ' + this._status + ', not errored');
            }
            return this._error;
        },
    });
    Object.defineProperty(SyntheticModule.prototype, 'namespace', {
        get: function() {
            if (this._status !== 'linked' && this._status !== 'evaluating'
                && this._status !== 'evaluated') {
                throw new Error('Module namespace requested before link()');
            }
            return this._namespace;
        },
    });
    Object.defineProperty(SyntheticModule.prototype, 'dependencySpecifiers', {
        get: function() { return []; },
    });

    SyntheticModule.prototype.link = function(_linker) {
        if (this._status !== 'unlinked') {
            return Promise.reject(new Error(
                'Module status is ' + this._status + ', expected unlinked'));
        }
        this._status = 'linked';
        // Pre-allocate the namespace bag with `undefined` for each name
        // so callers can probe `module.namespace.foo` without throwing.
        this._namespace = Object.create(null);
        for (var i = 0; i < this._exportNames.length; i++) {
            this._namespace[this._exportNames[i]] = undefined;
        }
        return Promise.resolve();
    };

    SyntheticModule.prototype.setExport = function(name, value) {
        if (this._exportNames.indexOf(name) < 0) {
            throw new Error('SyntheticModule.setExport: unknown export name ' + name);
        }
        this._exports[name] = value;
        if (this._namespace && Object.isExtensible(this._namespace)) {
            this._namespace[name] = value;
        }
    };

    SyntheticModule.prototype.evaluate = function() {
        if (this._status === 'evaluated') return Promise.resolve(undefined);
        if (this._status !== 'linked') {
            return Promise.reject(new Error(
                'Module status is ' + this._status + ', expected linked'));
        }
        this._status = 'evaluating';
        var self = this;
        try {
            var maybe = self._evaluateCallback.call(self);
            return Promise.resolve(maybe).then(function() {
                Object.freeze(self._namespace);
                self._status = 'evaluated';
            }, function(e) {
                self._status = 'errored';
                self._error = e;
                throw e;
            });
        } catch (e) {
            self._status = 'errored';
            self._error = e;
            return Promise.reject(e);
        }
    };

    exports.createContext = createContext;
    exports.isContext = isContext;
    exports.runInThisContext = runInThisContext;
    exports.runInNewContext = runInNewContext;
    exports.runInContext = runInContext;
    exports.compileFunction = compileFunction;
    exports.Script = Script;
    /// `vm.measureMemory` (Node 13.9+) returns a Promise resolving to
    /// V8's heap-stats snapshot. We don't have a real V8 measurement
    /// API, but we expose the canonical shape so probe-shaped libs
    /// (clinic, 0x) don't crash on init. The numbers come from
    /// `process.memoryUsage()` so they reflect real WASM heap pressure.
    exports.measureMemory = function(options) {
        var mode = (options && options.mode) || 'summary';
        var u = process.memoryUsage();
        return Promise.resolve({
            total: { jsMemoryEstimate: u.heapUsed, jsMemoryRange: [u.heapUsed, u.heapTotal] },
            current: mode === 'detailed'
                ? { jsMemoryEstimate: u.heapUsed, jsMemoryRange: [u.heapUsed, u.heapTotal] }
                : undefined,
            other: mode === 'detailed' ? [] : undefined,
        });
    };
    exports.SourceTextModule = SourceTextModule;
    exports.SyntheticModule = SyntheticModule;
    exports.Module = ABSTRACT_MODULE_BASE;
    exports.constants = {
        DONT_CONTEXTIFY: 0,
        USE_MAIN_CONTEXT_DEFAULT_LOADER: 1,
    };
});

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

    // `Module` / `SourceTextModule` / `SyntheticModule` — Node has
    // these as experimental ES module support inside vm. We don't
    // expose them; callers who hit them will see the stub class
    // throw a useful error.

    function unsupportedModule(name) {
        return function() {
            throw new Error(
                'vm.' + name + ' (ES Module support) is not implemented in burn yet — ' +
                'use Script + runInContext for evaluating CJS-shaped code.'
            );
        };
    }

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
    exports.SourceTextModule = unsupportedModule('SourceTextModule');
    exports.SyntheticModule = unsupportedModule('SyntheticModule');
    exports.Module = unsupportedModule('Module');
    exports.constants = {
        DONT_CONTEXTIFY: 0,
        USE_MAIN_CONTEXT_DEFAULT_LOADER: 1,
    };
});

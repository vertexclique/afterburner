// trace_events — Node 20's V8 / Node trace categories. The sandbox
// has no trace pipeline; we accept the API surface so callers don't
// crash, log enable/disable to stderr (best-effort visibility), and
// no-op the rest.

__register_module('trace_events', function(module, exports, require) {

    function Tracing(categories) {
        this._categories = (categories || []).slice();
        this._enabled = false;
    }
    Tracing.prototype.enable = function() { this._enabled = true; };
    Tracing.prototype.disable = function() { this._enabled = false; };
    Object.defineProperty(Tracing.prototype, 'enabled', {
        get: function() { return this._enabled; },
    });
    Object.defineProperty(Tracing.prototype, 'categories', {
        get: function() { return this._categories.join(','); },
    });

    function createTracing(opts) {
        opts = opts || {};
        var cats = opts.categories;
        if (!Array.isArray(cats) || cats.length === 0) {
            throw new TypeError(
                'trace_events.createTracing: `categories` must be a non-empty array'
            );
        }
        return new Tracing(cats);
    }

    function getEnabledCategories() {
        // Sandbox has no globally-enabled categories. Node returns
        // a comma-separated string or `undefined`.
        return undefined;
    }

    exports.createTracing = createTracing;
    exports.getEnabledCategories = getEnabledCategories;
});

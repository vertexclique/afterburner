// perf_hooks — Node 20's performance-measurement API.
//
// Most callers use `performance.now()` (already a global) +
// `performance.mark` / `measure`. We provide a real implementation
// of those plus the supporting classes so production code drops in
// without modification.

__register_module('perf_hooks', function(module, exports, require) {

    // Global `performance` is installed by `web_compat.js`. Reuse it
    // so the two surfaces stay in lock-step (common pattern: scripts
    // import perf_hooks.performance but expect `globalThis.performance`
    // to point at the same object).
    var performance = globalThis.performance || {
        now: function() { return Date.now(); },
        timeOrigin: Date.now(),
    };

    // ---- PerformanceEntry ------------------------------------------

    function PerformanceEntry(name, entryType, startTime, duration) {
        this.name = name;
        this.entryType = entryType;
        this.startTime = startTime;
        this.duration = duration;
    }
    PerformanceEntry.prototype.toJSON = function() {
        return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
        };
    };

    // ---- in-memory entry buffer -----------------------------------

    var entries = [];
    var marks = Object.create(null);

    function addEntry(entry) {
        entries.push(entry);
    }

    // ---- Performance methods --------------------------------------
    //
    // We extend the bare `globalThis.performance` with the full
    // perf_hooks surface. Idempotent — re-installing doesn't reset
    // any pre-recorded marks.

    if (typeof performance.mark !== 'function') {
        performance.mark = function(name, options) {
            var detail = options && options.detail;
            var startTime = performance.now();
            var entry = new PerformanceEntry(String(name), 'mark', startTime, 0);
            entry.detail = detail || null;
            marks[String(name)] = entry;
            addEntry(entry);
            return entry;
        };
    }
    if (typeof performance.measure !== 'function') {
        performance.measure = function(name, startMarkOrOptions, endMark) {
            var startMark, endMarkName, detail;
            if (typeof startMarkOrOptions === 'object' && startMarkOrOptions !== null) {
                startMark = startMarkOrOptions.start;
                endMarkName = startMarkOrOptions.end;
                detail = startMarkOrOptions.detail;
            } else {
                startMark = startMarkOrOptions;
                endMarkName = endMark;
            }
            var startTime = startMark
                ? (marks[startMark] && marks[startMark].startTime) || 0
                : 0;
            var endTime = endMarkName
                ? (marks[endMarkName] && marks[endMarkName].startTime) || performance.now()
                : performance.now();
            var entry = new PerformanceEntry(
                String(name), 'measure', startTime, Math.max(0, endTime - startTime)
            );
            entry.detail = detail || null;
            addEntry(entry);
            return entry;
        };
    }
    if (typeof performance.clearMarks !== 'function') {
        performance.clearMarks = function(name) {
            if (name === undefined) {
                marks = Object.create(null);
                entries = entries.filter(function(e) { return e.entryType !== 'mark'; });
            } else {
                delete marks[String(name)];
                entries = entries.filter(function(e) {
                    return !(e.entryType === 'mark' && e.name === name);
                });
            }
        };
    }
    if (typeof performance.clearMeasures !== 'function') {
        performance.clearMeasures = function(name) {
            entries = entries.filter(function(e) {
                if (e.entryType !== 'measure') return true;
                return name !== undefined && e.name !== name;
            });
        };
    }
    if (typeof performance.getEntries !== 'function') {
        performance.getEntries = function() { return entries.slice(); };
    }
    if (typeof performance.getEntriesByName !== 'function') {
        performance.getEntriesByName = function(name, type) {
            return entries.filter(function(e) {
                if (e.name !== name) return false;
                return type === undefined || e.entryType === type;
            });
        };
    }
    if (typeof performance.getEntriesByType !== 'function') {
        performance.getEntriesByType = function(type) {
            return entries.filter(function(e) { return e.entryType === type; });
        };
    }

    // ---- PerformanceObserver --------------------------------------
    //
    // No event loop in the sandbox: observer callbacks fire
    // synchronously when `observe()` runs. Real Node defers them
    // to the next tick; the polyfill matches the API but folds the
    // dispatch into the immediate call so callers don't need to
    // tick the loop themselves.

    function PerformanceObserver(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('PerformanceObserver: callback must be a function');
        }
        this._callback = callback;
        this._observed = [];
        this._buffered = false;
    }
    PerformanceObserver.prototype.observe = function(opts) {
        opts = opts || {};
        var types = opts.entryTypes || (opts.type ? [opts.type] : []);
        this._observed = types.slice();
        this._buffered = !!opts.buffered;
        // Spec: when `buffered` is true, replay matching prior entries.
        // Read from BOTH this module's `entries` buffer AND the global
        // `performance._entries` buffer that `web_compat.js` populates
        // via `globalThis.performance.mark()`. Either side may have
        // pre-existing entries depending on which API the user code
        // reached for first.
        if (this._buffered) {
            var globalEntries = (globalThis.performance && globalThis.performance._entries)
                || [];
            var pool = entries.concat(globalEntries);
            var matched = pool.filter(function(e) {
                return types.indexOf(e.entryType) !== -1;
            });
            if (matched.length) {
                this._callback(
                    { getEntries: function() { return matched.slice(); } },
                    this
                );
            }
        }
    };
    PerformanceObserver.prototype.disconnect = function() {
        this._observed = [];
    };
    PerformanceObserver.prototype.takeRecords = function() {
        var observed = this._observed;
        var taken = entries.filter(function(e) {
            return observed.indexOf(e.entryType) !== -1;
        });
        return taken;
    };
    PerformanceObserver.supportedEntryTypes = ['mark', 'measure'];

    function monitorEventLoopDelay() {
        // Sandbox has no event loop; return a stub that always
        // reports zero delay. Node's API is preserved so callers
        // can still .reset() / .disable() / .enable() without crashing.
        var hist = {
            min: 0, max: 0, mean: 0, stddev: 0, percentile: function() { return 0; },
            percentiles: new Map(), exceeds: 0, count: 0,
            enable: function() {}, disable: function() {}, reset: function() {},
        };
        return hist;
    }

    function createHistogram(opts) {
        var lowest = (opts && opts.lowest) || 1;
        var highest = (opts && opts.highest) || 9007199254740991; // 2^53 - 1
        var count = 0, sum = 0, min = highest, max = lowest;
        return {
            min: min, max: max, mean: 0, stddev: 0, count: count,
            record: function(v) {
                count++; sum += v;
                if (v < min) min = v;
                if (v > max) max = v;
            },
            recordDelta: function() {},
            reset: function() { count = 0; sum = 0; min = highest; max = lowest; },
            percentile: function() { return 0; },
            get percentiles() { return new Map(); },
        };
    }

    // ---- exports --------------------------------------------------

    exports.performance = performance;
    exports.PerformanceEntry = PerformanceEntry;
    exports.PerformanceObserver = PerformanceObserver;
    exports.PerformanceObserverEntryList = PerformanceObserver; // alias
    exports.PerformanceMeasure = PerformanceEntry;
    exports.PerformanceMark = PerformanceEntry;
    exports.PerformanceResourceTiming = PerformanceEntry;
    exports.constants = {
        NODE_PERFORMANCE_GC_MAJOR: 4,
        NODE_PERFORMANCE_GC_MINOR: 1,
        NODE_PERFORMANCE_GC_INCREMENTAL: 8,
        NODE_PERFORMANCE_GC_WEAKCB: 16,
    };
    exports.monitorEventLoopDelay = monitorEventLoopDelay;
    exports.createHistogram = createHistogram;

    // Default export — Node lets callers do `import perf from 'perf_hooks'`.
    module.exports = exports;
});

// L3 shadow for the `sqlite3` npm package.
//
// require('sqlite3') resolves to this polyfill regardless of whether
// node_modules/sqlite3 exists; the upstream package ships a `.node`
// native addon that cannot load inside the WASM sandbox, so the
// shadow kicks in transparently and routes calls to a `rusqlite`-
// backed coordinator (see `afterburner-node-compat/src/shadows/sqlite3.rs`).
//
// API surface — matches sqlite3 v5 closely enough that real apps
// drop in without modification:
//
//   const sqlite3 = require('sqlite3');
//   const db = new sqlite3.Database(path[, mode][, cb]);
//   db.run(sql[, params][, cb]);     // INSERT/UPDATE/DELETE
//   db.get(sql[, params][, cb]);     // first row
//   db.all(sql[, params][, cb]);     // all rows
//   db.each(sql, params, rowCb, doneCb);
//   db.exec(sql[, cb]);              // multi-statement, no params
//   db.close([cb]);
//   db.serialize(fn);                // no-op (worker is already serialized)
//   db.parallelize(fn);              // no-op
//
// Parameter shapes: positional `?` and `?N`, an array, or `{':name': v}`
// (we lower the latter into a positional array for the bridge).
//
// Buffer round-trip: `Buffer` parameters are encoded as
// `{$blob_b64: '...'}`; result columns of type BLOB come back the
// same shape and are converted back to Buffer for the user.

__register_module('sqlite3', function(module, exports, require) {
    var Buffer = require('buffer').Buffer;

    // ---- host-error → JS Error -------------------------------------

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }
    function hostErrToError(s, op) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var err = new Error('sqlite3.' + op + ': ' + msg);
        err.code = 'SQLITE_ERROR';
        return err;
    }
    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('sqlite3 not available: rebuild burn with `shadow-sqlite3`');
            err.code = 'SQLITE_NO_SHADOW';
            throw err;
        }
        return fn;
    }
    function lastError() {
        if (typeof globalThis.__host_last_error === 'function') {
            return globalThis.__host_last_error() || '';
        }
        return '';
    }

    // ---- parameter normalization -----------------------------------

    function isPlainObject(o) {
        return o && typeof o === 'object' &&
               Object.getPrototypeOf(o) === Object.prototype;
    }

    // Encode one JS value into the bridge's JSON shape.
    function encodeParam(v) {
        if (v === undefined || v === null) return null;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') {
            if (!isFinite(v)) {
                throw new TypeError('sqlite3: non-finite number');
            }
            return v;
        }
        if (typeof v === 'string') return v;
        if (Buffer.isBuffer(v)) {
            return { $blob_b64: v.toString('base64') };
        }
        if (v instanceof Uint8Array) {
            return { $blob_b64: Buffer.from(v).toString('base64') };
        }
        if (typeof v === 'bigint') {
            // SQLite's INTEGER column is 64-bit. We pass i64 through
            // the bridge, but JS Number can only safely represent up
            // to 2^53. For values beyond that, callers should use
            // string columns. Throw rather than silently lose precision.
            var n = Number(v);
            if (BigInt(n) !== v) {
                throw new RangeError(
                    'sqlite3: bigint ' + v + ' exceeds safe integer range; use TEXT column'
                );
            }
            return n;
        }
        throw new TypeError('sqlite3: unsupported param type ' + typeof v);
    }

    // Lower the user-supplied params (varargs / array / object) into
    // a plain array we can JSON-encode for the bridge.
    function normalizeParams(args) {
        if (args.length === 0) return [];
        if (args.length === 1) {
            var p = args[0];
            if (Array.isArray(p)) {
                return p.map(encodeParam);
            }
            if (isPlainObject(p)) {
                // Named-param bind — we don't translate placeholders in
                // SQL here (the host-side parser doesn't need to: SQLite
                // accepts both `?N` and `:name` in any order). Convert
                // to positional ordering by Object.values insertion order.
                return Object.values(p).map(encodeParam);
            }
            return [encodeParam(p)];
        }
        var out = [];
        for (var i = 0; i < args.length; i++) {
            out.push(encodeParam(args[i]));
        }
        return out;
    }

    // Decode a row that came back from the bridge — convert any blob
    // markers back to Buffer instances.
    function decodeRow(row) {
        if (!row || typeof row !== 'object') return row;
        var keys = Object.keys(row);
        for (var i = 0; i < keys.length; i++) {
            var v = row[keys[i]];
            if (v && typeof v === 'object' && typeof v.$blob_b64 === 'string') {
                row[keys[i]] = Buffer.from(v.$blob_b64, 'base64');
            }
        }
        return row;
    }

    // ---- callback-shape glue ---------------------------------------
    //
    // Real sqlite3 dispatches callbacks asynchronously via libuv. We
    // have no event loop, but the npm package's docs are explicit
    // that callbacks fire after the call returns — preserve that by
    // running them through `Promise.resolve().then(...)` (microtask).

    function defer(cb, err, val, thisCtx) {
        if (typeof cb !== 'function') return;
        Promise.resolve().then(function() {
            try {
                if (thisCtx !== undefined) cb.call(thisCtx, err, val);
                else cb(err, val);
            } catch (_) {
                // Swallow — Node's behavior is to report on
                // 'uncaughtException', which we don't surface here.
            }
        });
    }

    // ---- Database --------------------------------------------------

    var OPEN_READONLY = 0x00000001;
    var OPEN_READWRITE = 0x00000002;
    var OPEN_CREATE = 0x00000004;
    var OPEN_FULLMUTEX = 0x00010000;
    // We don't honor mode flags today — the host opens with
    // READWRITE | CREATE | URI by default and rusqlite's threading
    // mode is fully serialized. The constants are surfaced because
    // application code passes them and shouldn't crash.

    function Database(filename, mode, cb) {
        if (!(this instanceof Database)) return new Database(filename, mode, cb);
        if (typeof mode === 'function') { cb = mode; mode = undefined; }
        var path = String(filename || ':memory:');
        var open = ensureHost('__host_shadow_sqlite3_open');
        var id = open(path);
        // Numeric id; -1 on failure.
        this._id = id;
        this._closed = false;
        this.filename = path;
        this.open = id > 0;
        var self = this;
        if (id < 0) {
            var err = new Error('sqlite3.Database: ' + (lastError() || 'open failed'));
            err.code = 'SQLITE_CANTOPEN';
            this._openError = err;
            // Mirror npm sqlite3: emit 'error' on the next microtask
            // and call back with the error.
            defer(cb, err);
            return;
        }
        defer(cb, null);
    }

    function requireOpen(self, op) {
        if (self._openError) throw self._openError;
        if (self._closed || !(self._id > 0)) {
            var err = new Error('sqlite3.' + op + ': database is closed');
            err.code = 'SQLITE_MISUSE';
            throw err;
        }
    }

    // Pull a trailing callback off a varargs `arguments`-like array.
    function popCb(argsArray) {
        if (argsArray.length === 0) return null;
        var last = argsArray[argsArray.length - 1];
        if (typeof last === 'function') {
            argsArray.pop();
            return last;
        }
        return null;
    }

    Database.prototype.run = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        var ctx;
        try {
            requireOpen(self, 'run');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_run');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'run');
            var parsed = JSON.parse(raw);
            ctx = { lastID: parsed.lastID, changes: parsed.changes, sql: sql };
        } catch (e) {
            // sqlite3's run() callback signature is (err) and
            // `this` carries lastID/changes on success.
            defer(cb, e, undefined);
            return self;
        }
        defer(cb, null, undefined, ctx);
        return self;
    };

    Database.prototype.get = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        try {
            requireOpen(self, 'get');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_get');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'get');
            var row = JSON.parse(raw);
            if (row === null) {
                defer(cb, null, undefined);
            } else {
                defer(cb, null, decodeRow(row));
            }
        } catch (e) {
            defer(cb, e);
        }
        return self;
    };

    Database.prototype.all = function(sql /* ...params, cb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = popCb(args);
        var self = this;
        try {
            requireOpen(self, 'all');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_all');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'all');
            var rows = JSON.parse(raw);
            for (var i = 0; i < rows.length; i++) decodeRow(rows[i]);
            defer(cb, null, rows);
        } catch (e) {
            defer(cb, e, []);
        }
        return self;
    };

    Database.prototype.each = function(sql /* ...params, rowCb, doneCb? */) {
        var args = Array.prototype.slice.call(arguments, 1);
        // rowCb is the second-to-last function; doneCb is the last
        // (if both are functions); otherwise the last function is rowCb.
        var doneCb = null;
        var rowCb = null;
        if (args.length && typeof args[args.length - 1] === 'function') {
            var maybeDone = args.pop();
            if (args.length && typeof args[args.length - 1] === 'function') {
                rowCb = args.pop();
                doneCb = maybeDone;
            } else {
                rowCb = maybeDone;
            }
        }
        var self = this;
        try {
            requireOpen(self, 'each');
            var params = normalizeParams(args);
            var fn = ensureHost('__host_shadow_sqlite3_all');
            var raw = fn(self._id, String(sql), JSON.stringify(params));
            if (isHostErr(raw)) throw hostErrToError(raw, 'each');
            var rows = JSON.parse(raw);
            for (var i = 0; i < rows.length; i++) {
                var row = decodeRow(rows[i]);
                if (rowCb) {
                    Promise.resolve().then(function(r) {
                        return function() { try { rowCb(null, r); } catch (_) {} };
                    }(row));
                }
            }
            if (doneCb) defer(doneCb, null, rows.length);
        } catch (e) {
            if (rowCb) defer(rowCb, e);
            if (doneCb) defer(doneCb, e, 0);
        }
        return self;
    };

    Database.prototype.exec = function(sql, cb) {
        var self = this;
        try {
            requireOpen(self, 'exec');
            var fn = ensureHost('__host_shadow_sqlite3_exec');
            var rc = fn(self._id, String(sql));
            if (rc < 0) {
                var detail = lastError() || 'exec failed';
                var err = new Error('sqlite3.exec: ' + detail);
                err.code = 'SQLITE_ERROR';
                throw err;
            }
        } catch (e) {
            defer(cb, e);
            return self;
        }
        defer(cb, null);
        return self;
    };

    Database.prototype.close = function(cb) {
        var self = this;
        if (self._closed) {
            defer(cb, null);
            return self;
        }
        self._closed = true;
        self.open = false;
        if (self._id > 0) {
            try {
                var fn = ensureHost('__host_shadow_sqlite3_close');
                fn(self._id);
            } catch (e) {
                defer(cb, e);
                return self;
            }
        }
        defer(cb, null);
        return self;
    };

    // serialize/parallelize: real sqlite3 uses these to switch between
    // serialized + parallel queueing. The shadow already serializes
    // at the worker, so they're no-ops that just invoke the optional
    // function arg synchronously.
    Database.prototype.serialize = function(fn) {
        if (typeof fn === 'function') fn.call(this);
        return this;
    };
    Database.prototype.parallelize = function(fn) {
        if (typeof fn === 'function') fn.call(this);
        return this;
    };

    // configure(option, value) — sqlite3 supports `busyTimeout` and
    // `limit`. We accept and silently ignore (no rusqlite plumbing
    // for these knobs in the minimum subset).
    Database.prototype.configure = function() { return this; };

    // Trace / profile hooks aren't surfaced — install no-op event
    // emitter shape so user code that wires `db.on('trace', ...)`
    // doesn't crash.
    Database.prototype.on = function() { return this; };
    Database.prototype.once = function() { return this; };
    Database.prototype.removeListener = function() { return this; };
    Database.prototype.off = Database.prototype.removeListener;

    // Statement-handle API (db.prepare(sql)) is intentionally not
    // implemented in the minimum subset — most call sites use the
    // inline `db.run(sql, params)` form. Surface a clear error so
    // users know to refactor (rather than getting a confusing crash).
    /// `Database.prepare(sql[, ...params][, callback])` — npm sqlite3
    /// Statement. Returns a Statement that wraps the SQL string;
    /// each invocation re-binds via the same host fns the inline
    /// `db.run / get / all / each` use. The host's rusqlite caches
    /// prepared plans by SQL text, so repeated `stmt.run(...)` calls
    /// are still cheap.
    function Statement(db, sql, initialParams) {
        if (!(this instanceof Statement)) return new Statement(db, sql, initialParams);
        this._db = db;
        this._sql = String(sql);
        this._params = (initialParams && initialParams.length) ? initialParams.slice() : [];
        this._finalized = false;
    }
    Statement.prototype.bind = function() {
        var args = _splitParamsCallback(arguments);
        this._params = args.params;
        var self = this;
        if (args.callback) Promise.resolve().then(function() { args.callback.call(self, null); });
        return this;
    };
    Statement.prototype.reset = function(cb) {
        // Host plans are cached; nothing per-statement to reset. The
        // method exists so npm sqlite3 callers don't trip.
        if (typeof cb === 'function') Promise.resolve().then(cb);
        return this;
    };
    Statement.prototype.finalize = function(cb) {
        this._finalized = true;
        if (typeof cb === 'function') Promise.resolve().then(cb);
        return this._db;
    };
    Statement.prototype.run = function() {
        if (this._finalized) throw new Error('Statement: finalized');
        var args = _splitParamsCallback(arguments);
        var params = this._params.length
            ? this._params.concat(args.params) : args.params;
        return this._db.run.apply(this._db, [this._sql].concat(params, [args.callback]));
    };
    Statement.prototype.get = function() {
        if (this._finalized) throw new Error('Statement: finalized');
        var args = _splitParamsCallback(arguments);
        var params = this._params.length
            ? this._params.concat(args.params) : args.params;
        return this._db.get.apply(this._db, [this._sql].concat(params, [args.callback]));
    };
    Statement.prototype.all = function() {
        if (this._finalized) throw new Error('Statement: finalized');
        var args = _splitParamsCallback(arguments);
        var params = this._params.length
            ? this._params.concat(args.params) : args.params;
        return this._db.all.apply(this._db, [this._sql].concat(params, [args.callback]));
    };
    Statement.prototype.each = function() {
        if (this._finalized) throw new Error('Statement: finalized');
        var args = _splitParamsCallback(arguments);
        var params = this._params.length
            ? this._params.concat(args.params) : args.params;
        return this._db.each.apply(this._db, [this._sql].concat(params, [args.callback]));
    };

    /// Split a variadic args list into `{params, callback}` matching
    /// npm sqlite3's overload shape: trailing function is the
    /// completion callback; everything else is positional or named
    /// params. Used by the Statement methods which forward to the
    /// underlying inline-form db methods.
    function _splitParamsCallback(args) {
        var arr = Array.prototype.slice.call(args);
        var cb;
        if (arr.length && typeof arr[arr.length - 1] === 'function') {
            cb = arr.pop();
        }
        // npm sqlite3 also accepts a single array: db.run(sql, [a, b])
        if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
        return { params: arr, callback: cb };
    }

    Database.prototype.prepare = function(sql) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var args = _splitParamsCallback(rest);
        var stmt = new Statement(this, sql, args.params);
        if (args.callback) Promise.resolve().then(function() { args.callback.call(stmt, null); });
        return stmt;
    };

    // ---- Module exports --------------------------------------------

    exports.Database = Database;
    // npm sqlite3 also exposes a verbose() factory; we just return the
    // module itself since burn doesn't have separate trace levels.
    exports.verbose = function() { return exports; };

    exports.OPEN_READONLY = OPEN_READONLY;
    exports.OPEN_READWRITE = OPEN_READWRITE;
    exports.OPEN_CREATE = OPEN_CREATE;
    exports.OPEN_FULLMUTEX = OPEN_FULLMUTEX;

    // sqlite3.cached.Database mirrors upstream's connection cache.
    // We don't cache — every `new Database` opens a fresh connection.
    exports.cached = { Database: Database };
});

// Small Web-API polyfills that most Node.js scripts now assume. Wired
// as globals, not modules, to match the browser/Node semantics.

(function installWebCompat() {
    // structuredClone — ES2022. QuickJS-NG typically has it; fall back
    // to a JSON deep-copy so scripts don't blow up if this runtime
    // doesn't.
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = function(value) {
            if (value === undefined) return undefined;
            return JSON.parse(JSON.stringify(value));
        };
    }

    // performance.now — no monotonic clock inside the sandbox, but
    // Date.now gives us something non-decreasing for most practical
    // purposes. Hrtime-style scripts won't crash.
    if (typeof globalThis.performance !== 'object' || typeof globalThis.performance.now !== 'function') {
        globalThis.performance = globalThis.performance || {};
        globalThis.performance.now = function() { return Date.now(); };
    }

    // `queueMicrotask` — schedule a microtask. QuickJS supports
    // Promise.then which gives us the microtask queue for free.
    if (typeof globalThis.queueMicrotask !== 'function') {
        globalThis.queueMicrotask = function(fn) {
            if (typeof fn !== 'function') throw new TypeError('callback must be a function');
            Promise.resolve().then(fn);
        };
    }

    // `TextEncoder` / `TextDecoder` — Web globals. Javy ships them when
    // built with `text_encoding(true)` (our WASM plugin does); native
    // rquickjs doesn't. Real npm packages (Express deps, undici, etc.)
    // probe these at module-load time and crash with `ReferenceError`
    // without them.
    //
    // Implementation note: do NOT route through `Buffer.toString` /
    // `Buffer.from(str, 'utf8')` here. Buffer's UTF-8 codec routes
    // back through these globals in some plenum paths, producing an
    // infinite recursion. The pure-JS encoder/decoder below is
    // self-contained and handles BMP + surrogate-paired astral
    // codepoints. Replacement char (`�`) for malformed sequences
    // when not in `fatal` mode (matches WHATWG spec).
    if (typeof globalThis.TextEncoder !== 'function') {
        globalThis.TextEncoder = function TextEncoder() {
            this.encoding = 'utf-8';
        };
        globalThis.TextEncoder.prototype.encode = function(input) {
            var s = input === undefined ? '' : String(input);
            // Worst case: 4 bytes per code unit (surrogate pair → 4-byte UTF-8).
            var out = new Uint8Array(s.length * 4);
            var n = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
                    var c2 = s.charCodeAt(i + 1);
                    if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
                        out[n++] = 0xF0 | (cp >> 18);
                        out[n++] = 0x80 | ((cp >> 12) & 0x3F);
                        out[n++] = 0x80 | ((cp >> 6) & 0x3F);
                        out[n++] = 0x80 | (cp & 0x3F);
                        i++;
                        continue;
                    }
                }
                if (c < 0x80) {
                    out[n++] = c;
                } else if (c < 0x800) {
                    out[n++] = 0xC0 | (c >> 6);
                    out[n++] = 0x80 | (c & 0x3F);
                } else {
                    out[n++] = 0xE0 | (c >> 12);
                    out[n++] = 0x80 | ((c >> 6) & 0x3F);
                    out[n++] = 0x80 | (c & 0x3F);
                }
            }
            return out.slice(0, n);
        };
        globalThis.TextEncoder.prototype.encodeInto = function(source, dest) {
            var encoded = this.encode(source);
            var n = Math.min(encoded.length, dest.length);
            for (var i = 0; i < n; i++) dest[i] = encoded[i];
            return { read: source.length, written: n };
        };
    }
    if (typeof globalThis.TextDecoder !== 'function') {
        globalThis.TextDecoder = function TextDecoder(label, options) {
            var enc = (label || 'utf-8').toLowerCase();
            if (enc === 'utf8') enc = 'utf-8';
            this.encoding = enc;
            this.fatal = !!(options && options.fatal);
            this.ignoreBOM = !!(options && options.ignoreBOM);
        };
        globalThis.TextDecoder.prototype.decode = function(input, _options) {
            if (input === undefined) return '';
            var bytes;
            if (input instanceof Uint8Array) {
                bytes = input;
            } else if (input instanceof ArrayBuffer) {
                bytes = new Uint8Array(input);
            } else if (input && typeof input.byteLength === 'number') {
                bytes = new Uint8Array(
                    input.buffer || input,
                    input.byteOffset || 0,
                    input.byteLength
                );
            } else {
                return '';
            }
            // Pure-JS UTF-8 decode. Doesn't route through Buffer to
            // avoid recursion when Buffer's own codec calls back here.
            var s = '';
            var i = 0;
            while (i < bytes.length) {
                var b1 = bytes[i++];
                if (b1 < 0x80) {
                    s += String.fromCharCode(b1);
                } else if (b1 < 0xC0) {
                    s += '�';
                } else if (b1 < 0xE0) {
                    var b2 = bytes[i++] || 0;
                    s += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
                } else if (b1 < 0xF0) {
                    var b2c = bytes[i++] || 0;
                    var b3 = bytes[i++] || 0;
                    s += String.fromCharCode(
                        ((b1 & 0x0F) << 12) | ((b2c & 0x3F) << 6) | (b3 & 0x3F)
                    );
                } else {
                    var b2d = bytes[i++] || 0;
                    var b3d = bytes[i++] || 0;
                    var b4 = bytes[i++] || 0;
                    var cp =
                        ((b1 & 0x07) << 18) |
                        ((b2d & 0x3F) << 12) |
                        ((b3d & 0x3F) << 6) |
                        (b4 & 0x3F);
                    cp -= 0x10000;
                    s += String.fromCharCode(
                        0xD800 + (cp >> 10),
                        0xDC00 + (cp & 0x3FF)
                    );
                }
            }
            return s;
        };
    }

    // `btoa` / `atob` — base64 encoders. QuickJS doesn't ship these.
    if (typeof globalThis.btoa !== 'function') {
        globalThis.btoa = function(str) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(str), 'binary').toString('base64');
        };
    }
    if (typeof globalThis.atob !== 'function') {
        globalThis.atob = function(b64) {
            var Buffer = require('buffer').Buffer;
            return Buffer.from(String(b64), 'base64').toString('binary');
        };
    }

    // Node 20 LTS globals exposed without `require`:
    //   * `Buffer`           — global since v0.x.
    //   * `global`           — alias to globalThis since v12.
    //   * `URL` / `URLSearchParams` — global since v10.
    if (typeof globalThis.Buffer !== 'function') {
        globalThis.Buffer = require('buffer').Buffer;
    }
    if (typeof globalThis.global !== 'object') {
        globalThis.global = globalThis;
    }

    // ----- EventTarget / Event / CustomEvent ------------------------
    // Node 15 made these globals; nearly every modern web-API
    // building block (AbortSignal, MessagePort, the streams family)
    // either extends EventTarget or fires Events through it. Anything
    // that does `class X extends EventTarget {}` falls over without
    // a real constructor, even when the extending code never actually
    // dispatches an event.
    if (typeof globalThis.Event !== 'function') {
        var Event = function Event(type, init) {
            init = init || {};
            this.type = String(type);
            this.bubbles = !!init.bubbles;
            this.cancelable = !!init.cancelable;
            this.composed = !!init.composed;
            this.defaultPrevented = false;
            this.timeStamp = Date.now();
            this.target = null;
            this.currentTarget = null;
            this.eventPhase = 0;
            this.isTrusted = false;
            this._propagationStopped = false;
            this._immediatePropagationStopped = false;
        };
        Event.prototype.preventDefault = function() {
            if (this.cancelable) this.defaultPrevented = true;
        };
        Event.prototype.stopPropagation = function() { this._propagationStopped = true; };
        Event.prototype.stopImmediatePropagation = function() {
            this._propagationStopped = true;
            this._immediatePropagationStopped = true;
        };
        Event.prototype.composedPath = function() { return []; };
        Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
        globalThis.Event = Event;
    }
    if (typeof globalThis.CustomEvent !== 'function') {
        globalThis.CustomEvent = function CustomEvent(type, init) {
            globalThis.Event.call(this, type, init);
            this.detail = init && 'detail' in init ? init.detail : null;
        };
        globalThis.CustomEvent.prototype = Object.create(globalThis.Event.prototype);
        globalThis.CustomEvent.prototype.constructor = globalThis.CustomEvent;
    }
    if (typeof globalThis.EventTarget !== 'function') {
        var EventTarget = function EventTarget() { this._listeners = {}; };
        EventTarget.prototype.addEventListener = function(type, listener, _options) {
            if (!this._listeners) this._listeners = {};
            (this._listeners[type] = this._listeners[type] || []).push(listener);
        };
        EventTarget.prototype.removeEventListener = function(type, listener) {
            if (!this._listeners || !this._listeners[type]) return;
            var arr = this._listeners[type];
            for (var i = arr.length - 1; i >= 0; i--) {
                if (arr[i] === listener) arr.splice(i, 1);
            }
        };
        EventTarget.prototype.dispatchEvent = function(event) {
            if (!event || typeof event.type !== 'string') {
                throw new TypeError('dispatchEvent: argument must be an Event');
            }
            event.target = this;
            event.currentTarget = this;
            event.eventPhase = 2; // AT_TARGET
            var arr = (this._listeners && this._listeners[event.type]) || [];
            for (var i = 0; i < arr.length; i++) {
                if (event._immediatePropagationStopped) break;
                try {
                    var fn = arr[i];
                    if (typeof fn === 'function') fn.call(this, event);
                    else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(event);
                } catch (e) {
                    // Swallow per Web spec — an exceptional handler
                    // shouldn't prevent siblings from firing. Surface
                    // via the runtime's error reporting path.
                    if (typeof globalThis.queueMicrotask === 'function') {
                        globalThis.queueMicrotask(function() { throw e; });
                    }
                }
            }
            event.eventPhase = 0;
            return !event.defaultPrevented;
        };
        globalThis.EventTarget = EventTarget;
    }

    // ----- DOMException ---------------------------------------------
    // Used by AbortController.abort() (DOMException 'AbortError'),
    // various Streams APIs, and Cache/IndexedDB shims. Most callers
    // construct it as `new DOMException(message, name)` and read
    // `.name` to discriminate error types.
    if (typeof globalThis.DOMException !== 'function') {
        var DOMException = function DOMException(message, name) {
            this.message = message === undefined ? '' : String(message);
            this.name = name === undefined ? 'Error' : String(name);
            // .code: legacy numeric. 0 if name doesn't map.
            var legacy = {
                IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
                InvalidCharacterError: 5, NoModificationAllowedError: 7,
                NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
                InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
                NamespaceError: 14, InvalidAccessError: 15, SecurityError: 18,
                NetworkError: 19, AbortError: 20, URLMismatchError: 21,
                QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24,
                DataCloneError: 25,
            };
            this.code = legacy[this.name] || 0;
            // Stack trace via Error to make it inspectable.
            try { Error.captureStackTrace(this, DOMException); }
            catch (_) { this.stack = (new Error(this.message)).stack; }
        };
        DOMException.prototype = Object.create(Error.prototype);
        DOMException.prototype.constructor = DOMException;
        DOMException.prototype.toString = function() { return this.name + ': ' + this.message; };
        // Static legacy code constants on the constructor.
        var codes = ['INDEX_SIZE_ERR','DOMSTRING_SIZE_ERR','HIERARCHY_REQUEST_ERR','WRONG_DOCUMENT_ERR','INVALID_CHARACTER_ERR','NO_DATA_ALLOWED_ERR','NO_MODIFICATION_ALLOWED_ERR','NOT_FOUND_ERR','NOT_SUPPORTED_ERR','INUSE_ATTRIBUTE_ERR','INVALID_STATE_ERR','SYNTAX_ERR','INVALID_MODIFICATION_ERR','NAMESPACE_ERR','INVALID_ACCESS_ERR','VALIDATION_ERR','TYPE_MISMATCH_ERR','SECURITY_ERR','NETWORK_ERR','ABORT_ERR','URL_MISMATCH_ERR','QUOTA_EXCEEDED_ERR','TIMEOUT_ERR','INVALID_NODE_TYPE_ERR','DATA_CLONE_ERR'];
        for (var ci = 0; ci < codes.length; ci++) DOMException[codes[ci]] = ci + 1;
        globalThis.DOMException = DOMException;
    }

    // ----- Blob / File / FormData -----------------------------------
    // Node 18+ globals. node-fetch / undici-style clients construct
    // Blobs to wrap response bodies; multer / form-data libraries
    // build FormData. Buffer-backed implementations — covers the API
    // shape; binary streaming is best-effort sync.
    if (typeof globalThis.Blob !== 'function') {
        var Blob = function Blob(parts, options) {
            options = options || {};
            this.type = options.type ? String(options.type).toLowerCase() : '';
            var arr = parts || [];
            // Coerce each part to bytes.
            var Buf = (typeof globalThis.Buffer === 'function') ? globalThis.Buffer : null;
            var pieces = [];
            for (var i = 0; i < arr.length; i++) {
                var p = arr[i];
                if (Buf && Buf.isBuffer && Buf.isBuffer(p)) pieces.push(p);
                else if (p instanceof Uint8Array) pieces.push(Buf ? Buf.from(p) : p);
                else if (p instanceof ArrayBuffer) pieces.push(Buf ? Buf.from(new Uint8Array(p)) : new Uint8Array(p));
                else if (typeof p === 'string') pieces.push(Buf ? Buf.from(p, 'utf8') : new globalThis.TextEncoder().encode(p));
                else if (p && typeof p.arrayBuffer === 'function') {
                    // Nested Blob — sync access to its internal bytes.
                    pieces.push(Buf ? Buf.from(p._bytes || []) : (p._bytes || new Uint8Array(0)));
                } else {
                    var s = String(p);
                    pieces.push(Buf ? Buf.from(s, 'utf8') : new globalThis.TextEncoder().encode(s));
                }
            }
            // Concatenate.
            var total = 0;
            for (var j = 0; j < pieces.length; j++) total += pieces[j].length;
            var out = Buf ? Buf.alloc(total) : new Uint8Array(total);
            var off = 0;
            for (var k = 0; k < pieces.length; k++) {
                if (Buf) pieces[k].copy(out, off);
                else out.set(pieces[k], off);
                off += pieces[k].length;
            }
            this._bytes = out;
            this.size = total;
        };
        Blob.prototype.arrayBuffer = function() {
            var b = this._bytes;
            return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        };
        Blob.prototype.text = function() {
            return Promise.resolve(new globalThis.TextDecoder().decode(this._bytes));
        };
        Blob.prototype.bytes = function() {
            return Promise.resolve(new Uint8Array(this._bytes.buffer, this._bytes.byteOffset, this._bytes.byteLength));
        };
        Blob.prototype.slice = function(start, end, type) {
            var s = (start === undefined) ? 0 : (start | 0);
            var e = (end === undefined) ? this.size : (end | 0);
            if (s < 0) s = Math.max(this.size + s, 0);
            if (e < 0) e = Math.max(this.size + e, 0);
            s = Math.min(s, this.size); e = Math.min(e, this.size);
            var sub = this._bytes.slice(s, e);
            var out = Object.create(Blob.prototype);
            out._bytes = sub; out.size = sub.length;
            out.type = type ? String(type).toLowerCase() : '';
            return out;
        };
        Blob.prototype.stream = function() {
            // Best-effort: a stream-shaped object with one chunk.
            var bytes = this._bytes;
            var done = false;
            return {
                getReader: function() {
                    return {
                        read: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            return Promise.resolve({ value: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), done: false });
                        },
                        cancel: function() { done = true; return Promise.resolve(); },
                        releaseLock: function() {},
                    };
                },
                [Symbol.asyncIterator]: function() {
                    return {
                        next: function() {
                            if (done) return Promise.resolve({ value: undefined, done: true });
                            done = true;
                            return Promise.resolve({ value: bytes, done: false });
                        },
                    };
                },
            };
        };
        globalThis.Blob = Blob;
    }
    if (typeof globalThis.File !== 'function') {
        globalThis.File = function File(parts, name, options) {
            globalThis.Blob.call(this, parts, options);
            this.name = String(name);
            this.lastModified = (options && typeof options.lastModified === 'number') ? options.lastModified : Date.now();
            this.webkitRelativePath = '';
        };
        globalThis.File.prototype = Object.create(globalThis.Blob.prototype);
        globalThis.File.prototype.constructor = globalThis.File;
    }
    if (typeof globalThis.FormData !== 'function') {
        globalThis.FormData = function FormData() {
            this._entries = [];
        };
        var FP = globalThis.FormData.prototype;
        FP.append = function(key, value, filename) {
            this._entries.push([String(key), value, filename]);
        };
        FP.set = function(key, value, filename) {
            this._entries = this._entries.filter(function(e) { return e[0] !== String(key); });
            this._entries.push([String(key), value, filename]);
        };
        FP.delete = function(key) {
            this._entries = this._entries.filter(function(e) { return e[0] !== String(key); });
        };
        FP.has = function(key) {
            return this._entries.some(function(e) { return e[0] === String(key); });
        };
        FP.get = function(key) {
            for (var i = 0; i < this._entries.length; i++)
                if (this._entries[i][0] === String(key)) return this._entries[i][1];
            return null;
        };
        FP.getAll = function(key) {
            return this._entries.filter(function(e) { return e[0] === String(key); }).map(function(e) { return e[1]; });
        };
        FP.entries = function() {
            var arr = this._entries.map(function(e) { return [e[0], e[1]]; });
            var idx = 0;
            return {
                next: function() {
                    if (idx >= arr.length) return { value: undefined, done: true };
                    return { value: arr[idx++], done: false };
                },
                [Symbol.iterator]: function() { return this; },
            };
        };
        FP.keys = function() {
            var arr = this._entries.map(function(e) { return e[0]; });
            var idx = 0;
            return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } };
        };
        FP.values = function() {
            var arr = this._entries.map(function(e) { return e[1]; });
            var idx = 0;
            return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } };
        };
        FP.forEach = function(cb, thisArg) {
            for (var i = 0; i < this._entries.length; i++) cb.call(thisArg, this._entries[i][1], this._entries[i][0], this);
        };
        FP[Symbol.iterator] = FP.entries;
    }

    // ----- MessageChannel / MessagePort / MessageEvent ---------------
    // Same-realm message passing. Worker code uses the API surface
    // even when the actual cross-thread mechanism is provided by the
    // worker_threads polyfill — we expose a same-realm impl so user
    // code that does `new MessageChannel()` doesn't crash.
    if (typeof globalThis.MessageEvent !== 'function') {
        globalThis.MessageEvent = function MessageEvent(type, init) {
            globalThis.Event.call(this, type, init);
            init = init || {};
            this.data = init.data === undefined ? null : init.data;
            this.origin = init.origin || '';
            this.lastEventId = init.lastEventId || '';
            this.source = init.source || null;
            this.ports = init.ports || [];
        };
        globalThis.MessageEvent.prototype = Object.create(globalThis.Event.prototype);
        globalThis.MessageEvent.prototype.constructor = globalThis.MessageEvent;
    }
    if (typeof globalThis.MessagePort !== 'function') {
        var MessagePort = function MessagePort() {
            globalThis.EventTarget.call(this);
            this._other = null;
            this._started = false;
            this._queued = [];
            this._onmessage = null;
        };
        MessagePort.prototype = Object.create(globalThis.EventTarget.prototype);
        MessagePort.prototype.constructor = MessagePort;
        Object.defineProperty(MessagePort.prototype, 'onmessage', {
            get: function() { return this._onmessage; },
            set: function(fn) {
                this._onmessage = fn;
                this.start();
            },
        });
        MessagePort.prototype.postMessage = function(data, transferList) {
            var other = this._other;
            if (!other) return;
            var ev = new globalThis.MessageEvent('message', { data: data, ports: transferList || [] });
            if (other._started || other._onmessage) {
                if (typeof globalThis.queueMicrotask === 'function') {
                    globalThis.queueMicrotask(function() {
                        if (typeof other._onmessage === 'function') other._onmessage(ev);
                        other.dispatchEvent(ev);
                    });
                } else {
                    Promise.resolve().then(function() {
                        if (typeof other._onmessage === 'function') other._onmessage(ev);
                        other.dispatchEvent(ev);
                    });
                }
            } else {
                other._queued.push(ev);
            }
        };
        MessagePort.prototype.start = function() {
            if (this._started) return;
            this._started = true;
            var self = this;
            for (var i = 0; i < this._queued.length; i++) {
                (function(ev) {
                    Promise.resolve().then(function() {
                        if (typeof self._onmessage === 'function') self._onmessage(ev);
                        self.dispatchEvent(ev);
                    });
                })(this._queued[i]);
            }
            this._queued.length = 0;
        };
        MessagePort.prototype.close = function() {
            this._other = null;
            this._onmessage = null;
        };
        globalThis.MessagePort = MessagePort;
    }
    if (typeof globalThis.MessageChannel !== 'function') {
        globalThis.MessageChannel = function MessageChannel() {
            this.port1 = new globalThis.MessagePort();
            this.port2 = new globalThis.MessagePort();
            this.port1._other = this.port2;
            this.port2._other = this.port1;
        };
    }
    if (typeof globalThis.BroadcastChannel !== 'function') {
        // Sandbox is single-realm, so a BroadcastChannel just delivers
        // messages to other channels with the same name in this same
        // process. Useful for in-process module-coordination patterns.
        if (!globalThis.__ab_bc_registry) globalThis.__ab_bc_registry = {};
        var BroadcastChannel = function BroadcastChannel(name) {
            globalThis.EventTarget.call(this);
            this.name = String(name);
            this._closed = false;
            this._onmessage = null;
            var reg = globalThis.__ab_bc_registry;
            (reg[this.name] = reg[this.name] || []).push(this);
        };
        BroadcastChannel.prototype = Object.create(globalThis.EventTarget.prototype);
        BroadcastChannel.prototype.constructor = BroadcastChannel;
        Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
            get: function() { return this._onmessage; },
            set: function(v) { this._onmessage = v; },
        });
        BroadcastChannel.prototype.postMessage = function(data) {
            if (this._closed) return;
            var ev = new globalThis.MessageEvent('message', { data: data });
            var peers = (globalThis.__ab_bc_registry[this.name] || []).filter(function(c) { return c !== this; }, this);
            var self = this;
            peers.forEach(function(peer) {
                if (peer._closed) return;
                Promise.resolve().then(function() {
                    if (typeof peer._onmessage === 'function') peer._onmessage(ev);
                    peer.dispatchEvent(ev);
                });
            });
        };
        BroadcastChannel.prototype.close = function() {
            this._closed = true;
            var reg = globalThis.__ab_bc_registry;
            if (reg[this.name]) {
                reg[this.name] = reg[this.name].filter(function(c) { return c !== this; }, this);
            }
        };
        globalThis.BroadcastChannel = BroadcastChannel;
    }

    // ----- Web Crypto (globalThis.crypto) ---------------------------
    // Modern crypto is via the SubtleCrypto WebCrypto API. Most uses
    // we see in Node code are `crypto.randomUUID()`,
    // `crypto.getRandomValues()`, `crypto.subtle.digest()`. Lazy-load
    // node:crypto on first call so module-init time doesn't reach
    // into the host bridge before host imports are wired (Wizer
    // pre-init runs the bundle without our custom wasm imports
    // bound; eager require here trips the linker).
    if (typeof globalThis.crypto !== 'object' || !globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
        var webCrypto = globalThis.crypto || {};
        function _hexToBytes(hex) {
            var out = new Uint8Array(hex.length / 2);
            for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
            return out;
        }
        webCrypto.randomUUID = function() {
            try {
                var nc = require('crypto');
                if (typeof nc.randomUUID === 'function') return nc.randomUUID();
            } catch (_) {}
            var r = '';
            for (var i = 0; i < 32; i++) {
                if (i === 8 || i === 12 || i === 16 || i === 20) r += '-';
                r += Math.floor(Math.random() * 16).toString(16);
            }
            return r;
        };
        webCrypto.getRandomValues = function(typed) {
            if (!typed || typeof typed.length !== 'number') {
                throw new TypeError('getRandomValues: typed-array required');
            }
            var n = typed.byteLength || typed.length;
            try {
                var nc = require('crypto');
                if (nc && nc.randomBytes) {
                    var hex = nc.randomBytes(n);
                    var bytes = (typeof hex === 'string') ? _hexToBytes(hex) : hex;
                    var view = new Uint8Array(typed.buffer || typed, typed.byteOffset || 0, n);
                    for (var i = 0; i < n; i++) view[i] = bytes[i];
                    return typed;
                }
            } catch (_) {}
            var view2 = new Uint8Array(typed.buffer || typed, typed.byteOffset || 0, n);
            for (var j = 0; j < n; j++) view2[j] = Math.floor(Math.random() * 256);
            return typed;
        };
        webCrypto.subtle = webCrypto.subtle || {
            digest: function(algo, data) {
                var algorithm = (typeof algo === 'string') ? algo : (algo && algo.name) || '';
                var nodeAlgo = algorithm.toLowerCase().replace('-', '');
                try {
                    var nc = require('crypto');
                    var hash = nc.createHash(nodeAlgo);
                    var bytes = (data instanceof ArrayBuffer) ? new Uint8Array(data)
                              : (data && data.buffer) ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
                              : data;
                    hash.update(bytes);
                    var hex = hash.digest('hex');
                    return Promise.resolve(_hexToBytes(hex).buffer);
                } catch (e) { return Promise.reject(e); }
            },
        };
        globalThis.crypto = webCrypto;
    }

    // ----- navigator (Node 22+) -------------------------------------
    if (typeof globalThis.navigator !== 'object' || !globalThis.navigator) {
        globalThis.navigator = {
            userAgent: 'Node.js/26.0.0 (Afterburner)',
            language: 'en-US',
            languages: ['en-US'],
            hardwareConcurrency: 1,
            platform: globalThis.process && globalThis.process.platform || 'linux',
            onLine: true,
        };
    }

    // ----- Streams Web globals --------------------------------------
    // The polyfill bundle registers `stream/web` as a require target
    // but Node 18+ also exposes the constructors as globals. Bring
    // them onto globalThis so undici / web-streams-polyfill probes
    // see them.
    try {
        var sw = require('stream/web');
        ['ReadableStream','WritableStream','TransformStream',
         'ByteLengthQueuingStrategy','CountQueuingStrategy',
         'ReadableStreamDefaultReader','ReadableStreamBYOBReader',
         'WritableStreamDefaultWriter','TransformStreamDefaultController'
        ].forEach(function(name) {
            if (sw[name] && !globalThis[name]) globalThis[name] = sw[name];
        });
    } catch (_) {}

    // ----- TextEncoderStream / TextDecoderStream --------------------
    // TransformStream subclasses that pump chunks through encode/decode.
    // Defer until ReadableStream is available so we can compose.
    if (typeof globalThis.TextEncoderStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var TES = function TextEncoderStream() {
            var enc = new globalThis.TextEncoder();
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    controller.enqueue(enc.encode(String(chunk)));
                },
            });
            this.encoding = enc.encoding;
        };
        TES.prototype = Object.create(globalThis.TransformStream && globalThis.TransformStream.prototype || Object.prototype);
        globalThis.TextEncoderStream = TES;
    }
    if (typeof globalThis.TextDecoderStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var TDS = function TextDecoderStream(label, options) {
            var dec = new globalThis.TextDecoder(label, options);
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    controller.enqueue(dec.decode(chunk));
                },
            });
            this.encoding = dec.encoding;
        };
        TDS.prototype = Object.create(globalThis.TransformStream && globalThis.TransformStream.prototype || Object.prototype);
        globalThis.TextDecoderStream = TDS;
    }

    // ----- CompressionStream / DecompressionStream ------------------
    // Node 17+. Wrap zlib for the underlying codec; defer the
    // require to first call so Wizer pre-init doesn't reach the
    // host bridge.
    if (typeof globalThis.CompressionStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var CS = function CompressionStream(format) {
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    try {
                        var nz = require('zlib');
                        var Buf = globalThis.Buffer;
                        var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                        var syncFn = (format === 'gzip') ? nz.gzipSync :
                                     (format === 'deflate') ? nz.deflateSync :
                                     (format === 'deflate-raw') ? nz.deflateRawSync : null;
                        if (syncFn) controller.enqueue(syncFn(buf));
                        else controller.enqueue(chunk);
                    } catch (e) { controller.error(e); }
                },
            });
        };
        globalThis.CompressionStream = CS;
    }
    if (typeof globalThis.DecompressionStream !== 'function' && typeof globalThis.TransformStream === 'function') {
        var DS = function DecompressionStream(format) {
            globalThis.TransformStream.call(this, {
                transform: function(chunk, controller) {
                    try {
                        var nz = require('zlib');
                        var Buf = globalThis.Buffer;
                        var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                        var syncFn = (format === 'gzip') ? nz.gunzipSync :
                                     (format === 'deflate') ? nz.inflateSync :
                                     (format === 'deflate-raw') ? nz.inflateRawSync : null;
                        if (syncFn) controller.enqueue(syncFn(buf));
                        else controller.enqueue(chunk);
                    } catch (e) { controller.error(e); }
                },
            });
        };
        globalThis.DecompressionStream = DS;
    }
    if (typeof globalThis.URL !== 'function') {
        var urlMod = require('url');
        if (typeof urlMod.URL === 'function') {
            globalThis.URL = urlMod.URL;
            globalThis.URLSearchParams = urlMod.URLSearchParams;
        } else {
            // Minimal regex-based parser when neither host nor url
            // module exposes a URL constructor. Doesn't claim WHATWG
            // conformance — covers `new URL(href).{protocol,host,
            // pathname,search,searchParams}` which is what most Node
            // code actually uses.
            globalThis.URL = function URL(href, base) {
                if (base) href = String(base).replace(/[^/]*$/, '') + href;
                var s = String(href);
                var m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
                this.href = s;
                this.protocol = m && m[1] ? m[1] + ':' : '';
                this.host = (m && m[2]) || '';
                var hp = this.host.split(':');
                this.hostname = hp[0] || '';
                this.port = hp[1] || '';
                this.pathname = (m && m[3]) || '';
                this.search = (m && m[4]) || '';
                this.hash = (m && m[5]) || '';
                this.origin = this.protocol + (this.host ? '//' + this.host : '');
                this.searchParams = new globalThis.URLSearchParams(this.search.slice(1));
            };
            globalThis.URL.prototype.toString = function() { return this.href; };

            globalThis.URLSearchParams = function URLSearchParams(init) {
                this._pairs = [];
                var self = this;
                if (typeof init === 'string') {
                    var s = init.replace(/^\?/, '');
                    if (s) s.split('&').forEach(function(p) {
                        var eq = p.indexOf('=');
                        var k = eq < 0 ? p : p.slice(0, eq);
                        var v = eq < 0 ? '' : p.slice(eq + 1);
                        self._pairs.push([decodeURIComponent(k), decodeURIComponent(v)]);
                    });
                } else if (init && typeof init === 'object') {
                    Object.keys(init).forEach(function(k) {
                        self._pairs.push([k, String(init[k])]);
                    });
                }
            };
            var P = globalThis.URLSearchParams.prototype;
            P.get = function(k) {
                for (var i = 0; i < this._pairs.length; i++)
                    if (this._pairs[i][0] === k) return this._pairs[i][1];
                return null;
            };
            P.getAll = function(k) {
                return this._pairs.filter(function(p) { return p[0] === k; })
                                  .map(function(p) { return p[1]; });
            };
            P.has = function(k) {
                return this._pairs.some(function(p) { return p[0] === k; });
            };
            P.set = function(k, v) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
                this._pairs.push([k, String(v)]);
            };
            P.append = function(k, v) { this._pairs.push([k, String(v)]); };
            P.delete = function(k) {
                this._pairs = this._pairs.filter(function(p) { return p[0] !== k; });
            };
            P.toString = function() {
                return this._pairs.map(function(p) {
                    return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
                }).join('&');
            };
        }
    }
})();

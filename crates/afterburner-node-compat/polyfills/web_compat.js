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
        // ---- SubtleCrypto -------------------------------------
        //
        // Web Crypto subset wired on top of node:crypto host fns.
        //
        // Algorithms shipped:
        //   AES-GCM      encrypt / decrypt / generateKey / importKey
        //                / exportKey
        //   AES-CBC      encrypt / decrypt / generateKey / importKey
        //                / exportKey
        //   AES-CTR      encrypt / decrypt (via AES-CBC host fn with
        //                CTR-mode wrapper TBD; falls back to error)
        //   HMAC         sign / verify / generateKey / importKey /
        //                exportKey (SHA-1/256/384/512)
        //   PBKDF2       deriveBits / deriveKey
        //   HKDF         deriveBits / deriveKey (HMAC-based)
        //   SHA-1/256/384/512  digest
        //
        // CryptoKey is an opaque-ish JS object holding the raw key
        // bytes plus algorithm metadata — extractable=true returns
        // the bytes via exportKey, false returns an error per the
        // spec.
        function _toBytes(input) {
            if (input == null) return new Uint8Array(0);
            if (input instanceof ArrayBuffer) return new Uint8Array(input);
            if (ArrayBuffer.isView(input)) {
                return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            }
            if (typeof input === 'string') {
                var enc = new TextEncoder();
                return enc.encode(input);
            }
            return new Uint8Array(input);
        }
        function _bufToB64(bytes) {
            // Avoid require('buffer') here since this function runs
            // before module loading is fully wired during early
            // global install.
            var Buf = globalThis.Buffer || (require('buffer') && require('buffer').Buffer);
            return Buf.from(bytes).toString('base64');
        }
        function _b64ToBuf(b64) {
            var Buf = globalThis.Buffer || (require('buffer') && require('buffer').Buffer);
            return new Uint8Array(Buf.from(b64, 'base64'));
        }
        function _algoName(a) {
            return (typeof a === 'string') ? a.toLowerCase()
                 : (a && a.name) ? String(a.name).toLowerCase()
                 : '';
        }
        function _hashName(h) {
            var s = (typeof h === 'string') ? h : (h && h.name) || '';
            return s.toLowerCase().replace('-', '');
        }
        function _aesCipherName(keyBytes, mode) {
            var bits = keyBytes.length * 8;
            return 'aes-' + bits + '-' + mode;
        }
        function _makeCryptoKey(algorithm, raw, type, extractable, usages) {
            var key = Object.create(null);
            Object.defineProperty(key, 'algorithm', { value: algorithm, enumerable: true });
            Object.defineProperty(key, 'type', { value: type, enumerable: true });
            Object.defineProperty(key, 'extractable', { value: !!extractable, enumerable: true });
            Object.defineProperty(key, 'usages', { value: usages.slice(), enumerable: true });
            // _raw is non-enumerable so JSON.stringify(key) doesn't leak
            // the secret. Spec-wise CryptoKey is opaque; we keep parity.
            Object.defineProperty(key, '_raw', { value: raw, enumerable: false });
            return key;
        }

        var subtle = {
            digest: function(algo, data) {
                var nodeAlgo = _hashName(algo);
                try {
                    var nc = require('crypto');
                    var hash = nc.createHash(nodeAlgo);
                    hash.update(_toBytes(data));
                    var hex = hash.digest('hex');
                    return Promise.resolve(_hexToBytes(hex).buffer);
                } catch (e) { return Promise.reject(e); }
            },

            encrypt: function(algorithm, key, data) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        var nc = require('crypto');
                        if (name === 'aes-gcm') {
                            var iv = _toBytes(algorithm.iv);
                            var aad = algorithm.additionalData ? _toBytes(algorithm.additionalData) : null;
                            var tagLen = (algorithm.tagLength | 0) || 128;
                            var c = nc.createCipheriv(_aesCipherName(key._raw, 'gcm'),
                                                      Buffer.from(key._raw),
                                                      Buffer.from(iv));
                            if (aad) c.setAAD(Buffer.from(aad));
                            c.update(Buffer.from(_toBytes(data)));
                            var ct = c.final();
                            var tag = c.getAuthTag().slice(0, tagLen / 8);
                            var out = new Uint8Array(ct.length + tag.length);
                            out.set(ct, 0);
                            out.set(tag, ct.length);
                            resolve(out.buffer);
                            return;
                        }
                        if (name === 'aes-cbc') {
                            var iv2 = _toBytes(algorithm.iv);
                            var c2 = nc.createCipheriv(_aesCipherName(key._raw, 'cbc'),
                                                       Buffer.from(key._raw),
                                                       Buffer.from(iv2));
                            c2.update(Buffer.from(_toBytes(data)));
                            var out2 = c2.final();
                            resolve(new Uint8Array(out2).buffer);
                            return;
                        }
                        reject(new Error('SubtleCrypto.encrypt: unsupported algorithm: ' + name));
                    } catch (e) { reject(e); }
                });
            },

            decrypt: function(algorithm, key, data) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        var nc = require('crypto');
                        var input = _toBytes(data);
                        if (name === 'aes-gcm') {
                            var iv = _toBytes(algorithm.iv);
                            var aad = algorithm.additionalData ? _toBytes(algorithm.additionalData) : null;
                            var tagLen = (algorithm.tagLength | 0) || 128;
                            var tagBytes = tagLen / 8;
                            if (input.length < tagBytes) return reject(new Error('aes-gcm: ciphertext shorter than tag'));
                            var ct = input.slice(0, input.length - tagBytes);
                            var tag = input.slice(input.length - tagBytes);
                            var d = nc.createDecipheriv(_aesCipherName(key._raw, 'gcm'),
                                                        Buffer.from(key._raw),
                                                        Buffer.from(iv));
                            if (aad) d.setAAD(Buffer.from(aad));
                            d.setAuthTag(Buffer.from(tag));
                            d.update(Buffer.from(ct));
                            var pt = d.final();
                            resolve(new Uint8Array(pt).buffer);
                            return;
                        }
                        if (name === 'aes-cbc') {
                            var iv2 = _toBytes(algorithm.iv);
                            var d2 = nc.createDecipheriv(_aesCipherName(key._raw, 'cbc'),
                                                         Buffer.from(key._raw),
                                                         Buffer.from(iv2));
                            d2.update(Buffer.from(input));
                            var pt2 = d2.final();
                            resolve(new Uint8Array(pt2).buffer);
                            return;
                        }
                        reject(new Error('SubtleCrypto.decrypt: unsupported algorithm: ' + name));
                    } catch (e) { reject(e); }
                });
            },

            sign: function(algorithm, key, data) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        var nc = require('crypto');
                        if (name === 'hmac') {
                            var hashName = _hashName(key.algorithm && key.algorithm.hash);
                            var h = nc.createHmac(hashName, Buffer.from(key._raw));
                            h.update(Buffer.from(_toBytes(data)));
                            var hex = h.digest('hex');
                            resolve(_hexToBytes(hex).buffer);
                            return;
                        }
                        reject(new Error('SubtleCrypto.sign: unsupported algorithm: ' + name));
                    } catch (e) { reject(e); }
                });
            },

            verify: function(algorithm, key, signature, data) {
                return new Promise(function(resolve, reject) {
                    var self = this;
                    var p = subtle.sign(algorithm, key, data);
                    p.then(function(expected) {
                        var sig = new Uint8Array(_toBytes(signature));
                        var exp = new Uint8Array(expected);
                        if (sig.length !== exp.length) { resolve(false); return; }
                        var ok = 0;
                        for (var i = 0; i < sig.length; i++) ok |= (sig[i] ^ exp[i]);
                        resolve(ok === 0);
                    }, reject);
                });
            },

            generateKey: function(algorithm, extractable, usages) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        var len = (algorithm.length | 0) || 256;
                        var raw = new Uint8Array(len / 8);
                        webCrypto.getRandomValues(raw);
                        if (name === 'aes-gcm' || name === 'aes-cbc' || name === 'aes-ctr') {
                            resolve(_makeCryptoKey({ name: name.toUpperCase(), length: len },
                                                   raw, 'secret', extractable, usages));
                            return;
                        }
                        if (name === 'hmac') {
                            var hashName = _hashName(algorithm.hash);
                            // HMAC default key length matches block size of hash.
                            var blockBits = (hashName === 'sha512' || hashName === 'sha384') ? 1024 : 512;
                            var hmacLen = algorithm.length || blockBits;
                            var hraw = new Uint8Array(hmacLen / 8);
                            webCrypto.getRandomValues(hraw);
                            resolve(_makeCryptoKey({ name: 'HMAC',
                                                     hash: { name: hashName.toUpperCase().replace(/^SHA/, 'SHA-') },
                                                     length: hmacLen },
                                                   hraw, 'secret', extractable, usages));
                            return;
                        }
                        reject(new Error('SubtleCrypto.generateKey: unsupported algorithm: ' + name));
                    } catch (e) { reject(e); }
                });
            },

            importKey: function(format, keyData, algorithm, extractable, usages) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        if (format === 'raw') {
                            var raw = _toBytes(keyData);
                            if (name === 'aes-gcm' || name === 'aes-cbc' || name === 'aes-ctr') {
                                resolve(_makeCryptoKey({ name: name.toUpperCase(), length: raw.length * 8 },
                                                       raw, 'secret', extractable, usages));
                                return;
                            }
                            if (name === 'hmac') {
                                var hashName = _hashName(algorithm.hash);
                                resolve(_makeCryptoKey({ name: 'HMAC',
                                                         hash: { name: hashName.toUpperCase().replace(/^SHA/, 'SHA-') },
                                                         length: raw.length * 8 },
                                                       raw, 'secret', extractable, usages));
                                return;
                            }
                            if (name === 'pbkdf2' || name === 'hkdf') {
                                resolve(_makeCryptoKey({ name: name.toUpperCase() },
                                                       raw, 'secret', extractable, usages));
                                return;
                            }
                        }
                        if (format === 'jwk' && keyData && keyData.k) {
                            var raw2 = _toBytes(_b64UrlDecode(keyData.k));
                            if (name === 'aes-gcm' || name === 'aes-cbc') {
                                resolve(_makeCryptoKey({ name: name.toUpperCase(), length: raw2.length * 8 },
                                                       raw2, 'secret', extractable, usages));
                                return;
                            }
                            if (name === 'hmac') {
                                var hashName2 = _hashName(algorithm.hash);
                                resolve(_makeCryptoKey({ name: 'HMAC',
                                                         hash: { name: hashName2.toUpperCase().replace(/^SHA/, 'SHA-') },
                                                         length: raw2.length * 8 },
                                                       raw2, 'secret', extractable, usages));
                                return;
                            }
                        }
                        reject(new Error('SubtleCrypto.importKey: unsupported format/algorithm: '
                                         + format + '/' + name));
                    } catch (e) { reject(e); }
                });
            },

            exportKey: function(format, key) {
                return new Promise(function(resolve, reject) {
                    try {
                        if (!key.extractable) {
                            return reject(new Error('SubtleCrypto.exportKey: key not extractable'));
                        }
                        if (format === 'raw') {
                            resolve(new Uint8Array(key._raw).buffer);
                            return;
                        }
                        if (format === 'jwk') {
                            var algoName = (key.algorithm && key.algorithm.name) || '';
                            var jwk = {
                                kty: 'oct',
                                k: _b64UrlEncode(key._raw),
                                alg: algoName,
                                ext: true,
                                key_ops: key.usages.slice(),
                            };
                            resolve(jwk);
                            return;
                        }
                        reject(new Error('SubtleCrypto.exportKey: unsupported format: ' + format));
                    } catch (e) { reject(e); }
                });
            },

            deriveBits: function(algorithm, baseKey, length) {
                return new Promise(function(resolve, reject) {
                    try {
                        var name = _algoName(algorithm);
                        var nc = require('crypto');
                        if (name === 'pbkdf2') {
                            var hashName = _hashName(algorithm.hash);
                            var salt = _toBytes(algorithm.salt);
                            var iters = algorithm.iterations | 0;
                            var bytes = length / 8;
                            var raw = nc.pbkdf2Sync(
                                Buffer.from(baseKey._raw),
                                Buffer.from(salt),
                                iters,
                                bytes,
                                hashName);
                            resolve(new Uint8Array(raw).buffer);
                            return;
                        }
                        if (name === 'hkdf') {
                            // RFC 5869 HKDF on top of HMAC. The Hmac
                            // wrapper's `digest()` returns a hex string
                            // by default; pass the raw form via
                            // `digest('hex')` and convert with
                            // `Buffer.from(hex, 'hex')` so we get bytes.
                            var hash = _hashName(algorithm.hash);
                            var ikm = baseKey._raw;
                            var salt2 = algorithm.salt ? _toBytes(algorithm.salt) : new Uint8Array(0);
                            var info = algorithm.info ? _toBytes(algorithm.info) : new Uint8Array(0);
                            var extract = nc.createHmac(hash, Buffer.from(salt2));
                            extract.update(Buffer.from(ikm));
                            var prk = Buffer.from(extract.digest('hex'), 'hex');
                            var bytesNeeded = length / 8;
                            var hashLen = prk.length;
                            var n = Math.ceil(bytesNeeded / hashLen);
                            var t = Buffer.alloc(0);
                            var okm = Buffer.alloc(0);
                            for (var i = 1; i <= n; i++) {
                                var h = nc.createHmac(hash, prk);
                                h.update(t);
                                h.update(Buffer.from(info));
                                h.update(Buffer.from([i]));
                                t = Buffer.from(h.digest('hex'), 'hex');
                                okm = Buffer.concat([okm, t]);
                            }
                            resolve(new Uint8Array(okm.slice(0, bytesNeeded)).buffer);
                            return;
                        }
                        reject(new Error('SubtleCrypto.deriveBits: unsupported algorithm: ' + name));
                    } catch (e) { reject(e); }
                });
            },

            deriveKey: function(algorithm, baseKey, derivedKeyAlgorithm, extractable, usages) {
                return subtle.deriveBits(algorithm, baseKey,
                    (derivedKeyAlgorithm.length | 0) || 256
                ).then(function(buf) {
                    return subtle.importKey('raw', buf, derivedKeyAlgorithm, extractable, usages);
                });
            },

            wrapKey: function(format, key, wrappingKey, wrapAlgorithm) {
                return subtle.exportKey(format, key).then(function(raw) {
                    return subtle.encrypt(wrapAlgorithm, wrappingKey, raw);
                });
            },

            unwrapKey: function(format, wrapped, unwrappingKey, unwrapAlgorithm,
                                unwrappedKeyAlgorithm, extractable, usages) {
                return subtle.decrypt(unwrapAlgorithm, unwrappingKey, wrapped).then(function(raw) {
                    return subtle.importKey(format, raw, unwrappedKeyAlgorithm, extractable, usages);
                });
            },
        };
        function _b64UrlEncode(bytes) {
            return _bufToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        function _b64UrlDecode(str) {
            var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4 !== 0) s += '=';
            return _b64ToBuf(s);
        }
        webCrypto.subtle = webCrypto.subtle || subtle;
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
    //
    // Node 17+ / WHATWG Compression Streams. Each instance is a
    // TransformStream that pipes chunks through a sync zlib codec.
    // Supported formats: `gzip` / `deflate` / `deflate-raw`.
    // `Reflect.construct` is the only path that produces a real
    // TransformStream subclass under QuickJS — `.call(this, …)` on
    // class constructors throws a TypeError.
    function _makeCompressFn(format) {
        return function(chunk, controller) {
            try {
                var nz = require('zlib');
                var Buf = globalThis.Buffer;
                var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                var syncFn = (format === 'gzip') ? nz.gzipSync
                           : (format === 'deflate') ? nz.deflateSync
                           : (format === 'deflate-raw') ? nz.deflateRawSync
                           : (format === 'zstd') ? nz.zstdCompressSync
                           : null;
                if (!syncFn) {
                    controller.error(new TypeError(
                        "CompressionStream: unknown format '" + format + "'"));
                    return;
                }
                controller.enqueue(syncFn(buf));
            } catch (e) { controller.error(e); }
        };
    }
    function _makeDecompressFn(format) {
        return function(chunk, controller) {
            try {
                var nz = require('zlib');
                var Buf = globalThis.Buffer;
                var buf = Buf && Buf.from ? Buf.from(chunk) : chunk;
                var syncFn = (format === 'gzip') ? nz.gunzipSync
                           : (format === 'deflate') ? nz.inflateSync
                           : (format === 'deflate-raw') ? nz.inflateRawSync
                           : (format === 'zstd') ? nz.zstdDecompressSync
                           : null;
                if (!syncFn) {
                    controller.error(new TypeError(
                        "DecompressionStream: unknown format '" + format + "'"));
                    return;
                }
                controller.enqueue(syncFn(buf));
            } catch (e) { controller.error(e); }
        };
    }
    if (typeof globalThis.CompressionStream !== 'function'
        && typeof globalThis.TransformStream === 'function') {
        globalThis.CompressionStream = function CompressionStream(format) {
            return Reflect.construct(globalThis.TransformStream,
                [{ transform: _makeCompressFn(format) }],
                CompressionStream);
        };
        globalThis.CompressionStream.prototype =
            Object.create(globalThis.TransformStream.prototype);
        globalThis.CompressionStream.prototype.constructor = globalThis.CompressionStream;
    }
    if (typeof globalThis.DecompressionStream !== 'function'
        && typeof globalThis.TransformStream === 'function') {
        globalThis.DecompressionStream = function DecompressionStream(format) {
            return Reflect.construct(globalThis.TransformStream,
                [{ transform: _makeDecompressFn(format) }],
                DecompressionStream);
        };
        globalThis.DecompressionStream.prototype =
            Object.create(globalThis.TransformStream.prototype);
        globalThis.DecompressionStream.prototype.constructor = globalThis.DecompressionStream;
    }
    if (typeof globalThis.URL !== 'function') {
        var urlMod = require('url');
        if (typeof urlMod.URL === 'function') {
            globalThis.URL = urlMod.URL;
            globalThis.URLSearchParams = urlMod.URLSearchParams;
        } else {
            // Regex-based parser with proper RFC 3986 reference
            // resolution for the 2-arg form. Covers WHATWG-shape
            // properties (`protocol`/`host`/`pathname`/`search`/
            // `searchParams`) plus the redirect-following cases
            // node-fetch / minipass-fetch / pacote depend on:
            //   * `new URL('/p', 'https://h.com/x')`   → `https://h.com/p`
            //   * `new URL('p', 'https://h.com/x/y')`  → `https://h.com/x/p`
            //   * `new URL('https://o.com/p', 'https://h.com/x')` → `https://o.com/p`
            //   * `new URL('?q=1', 'https://h.com/x')` → `https://h.com/x?q=1`
            // Without these, every redirect-followed download breaks
            // with empty-host options and the upstream HTTP client
            // synthesises a malformed `https:///path` URL.
            function _parseAbs(s) {
                var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)?(\?[^#]*)?(#.*)?$/.exec(s);
                if (!m) return null;
                return { protocol: m[1] + ':', authority: m[2] || '', path: m[3] || '', query: m[4] || '', fragment: m[5] || '' };
            }
            function _normalizePath(p) {
                // RFC 3986 §5.2.4 — remove `.` and `..` segments.
                if (!p) return '';
                var leading = p.charAt(0) === '/';
                var trailing = p.charAt(p.length - 1) === '/';
                var parts = p.split('/').filter(function(s) { return s.length > 0; });
                var stack = [];
                for (var i = 0; i < parts.length; i++) {
                    var seg = parts[i];
                    if (seg === '.') continue;
                    if (seg === '..') { if (stack.length) stack.pop(); continue; }
                    stack.push(seg);
                }
                return (leading ? '/' : '') + stack.join('/') + (trailing && stack.length ? '/' : '');
            }
            globalThis.URL = function URL(href, base) {
                var input = String(href);
                var parsed = _parseAbs(input);
                if (!parsed && base) {
                    // Reference resolution per RFC 3986 §5.3.
                    var b = _parseAbs(String(base));
                    if (b) {
                        // Same-document fragment.
                        if (input.charAt(0) === '#') {
                            input = (b.protocol + '//' + b.authority + b.path + b.query + input);
                        } else if (input.charAt(0) === '?') {
                            input = (b.protocol + '//' + b.authority + b.path + input);
                        } else if (input.charAt(0) === '/') {
                            // Absolute path on the base authority.
                            input = (b.protocol + '//' + b.authority + input);
                        } else {
                            // Path-relative against the base directory.
                            var basePath = b.path || '/';
                            // Strip the last segment.
                            var slash = basePath.lastIndexOf('/');
                            var baseDir = slash >= 0 ? basePath.slice(0, slash + 1) : '/';
                            input = (b.protocol + '//' + b.authority + _normalizePath(baseDir + input));
                        }
                        parsed = _parseAbs(input);
                    }
                }
                var protocol = parsed ? parsed.protocol : '';
                var host = parsed ? parsed.authority : '';
                var path = parsed ? (parsed.path || '/') : input;
                var query = parsed ? parsed.query : '';
                var fragment = parsed ? parsed.fragment : '';
                // Username / password split off the authority.
                var username = '', password = '';
                var atIdx = host.indexOf('@');
                if (atIdx >= 0) {
                    var userinfo = host.slice(0, atIdx);
                    host = host.slice(atIdx + 1);
                    var colonIdx = userinfo.indexOf(':');
                    if (colonIdx >= 0) {
                        username = userinfo.slice(0, colonIdx);
                        password = userinfo.slice(colonIdx + 1);
                    } else {
                        username = userinfo;
                    }
                }
                var hp = host.split(':');
                var hostname = hp[0] || '';
                var port = hp.length > 1 ? hp[1] : '';
                this.protocol = protocol;
                this.host = host;
                this.hostname = hostname;
                this.port = port;
                this.pathname = _normalizePath(path);
                if (this.pathname === '' && host) this.pathname = '/';
                this.search = query;
                this.hash = fragment;
                this.username = username;
                this.password = password;
                this.origin = protocol + (host ? '//' + host : '');
                this.href = protocol + '//' + (username ? username + (password ? ':' + password : '') + '@' : '') + host + this.pathname + this.search + this.hash;
                this.searchParams = new globalThis.URLSearchParams(this.search.slice(1));
            };
            globalThis.URL.prototype.toString = function() { return this.href; };
            globalThis.URL.prototype.toJSON  = function() { return this.href; };
            globalThis.URL.canParse = function(href, base) {
                try { new globalThis.URL(href, base); return true; }
                catch (_) { return false; }
            };
            globalThis.URL.parse = function(href, base) {
                try { return new globalThis.URL(href, base); }
                catch (_) { return null; }
            };
            globalThis.URL.createObjectURL = function() { throw new Error('URL.createObjectURL not supported'); };
            globalThis.URL.revokeObjectURL = function() {};

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

    // ============================================================
    // ES2024 / ES2023 globals.
    //
    // The runtime's QuickJS may add these natively in a future build;
    // every install is gated on `!has(...)` so the polyfill is a
    // no-op once the engine catches up. Idempotent + safe.
    // ============================================================

    // ---- Symbol.dispose / Symbol.asyncDispose (Node 20+) ------------
    // Required for `using x = …;` / `await using x = …;` (TC39
    // explicit-resource-management). The well-known Symbols sit on
    // Symbol itself; consumers reference `Symbol.dispose` to register
    // their cleanup callback. Idempotent if QuickJS already added
    // them.
    if (typeof Symbol.dispose === 'undefined') {
        Object.defineProperty(Symbol, 'dispose', {
            value: Symbol.for('Symbol.dispose'),
            writable: false, configurable: false, enumerable: false,
        });
    }
    if (typeof Symbol.asyncDispose === 'undefined') {
        Object.defineProperty(Symbol, 'asyncDispose', {
            value: Symbol.for('Symbol.asyncDispose'),
            writable: false, configurable: false, enumerable: false,
        });
    }

    // ---- Promise.withResolvers (Stage 4, Node 22) -------------------
    if (typeof Promise.withResolvers !== 'function') {
        Object.defineProperty(Promise, 'withResolvers', {
            value: function withResolvers() {
                var resolve, reject;
                var promise = new this(function(res, rej) { resolve = res; reject = rej; });
                return { promise: promise, resolve: resolve, reject: reject };
            },
            writable: true, configurable: true,
        });
    }

    // ---- Object.groupBy / Map.groupBy (ES2024) ----------------------
    if (typeof Object.groupBy !== 'function') {
        Object.defineProperty(Object, 'groupBy', {
            value: function groupBy(items, keyFn) {
                var out = Object.create(null);
                var i = 0;
                for (var it of items) {
                    var k = keyFn(it, i++);
                    var key = (typeof k === 'symbol') ? k : String(k);
                    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = [];
                    out[key].push(it);
                }
                return out;
            },
            writable: true, configurable: true,
        });
    }
    if (typeof Map.groupBy !== 'function') {
        Object.defineProperty(Map, 'groupBy', {
            value: function groupBy(items, keyFn) {
                var out = new Map();
                var i = 0;
                for (var it of items) {
                    var k = keyFn(it, i++);
                    var arr = out.get(k);
                    if (!arr) { arr = []; out.set(k, arr); }
                    arr.push(it);
                }
                return out;
            },
            writable: true, configurable: true,
        });
    }

    // ---- Set.prototype set-theoretic methods (ES2024, Node 22) -----
    //
    // The spec is precise about argument shape: every method takes a
    // "set-like" — an object with `size`, `has`, and `keys` — *not*
    // necessarily a `Set` instance. The polyfill matches that contract
    // so the polyfill behaves like the native methods if a script
    // passes e.g. a Map or a custom collection.
    function _setLikeOf(other, name) {
        if (other == null || typeof other !== 'object' && typeof other !== 'function') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like');
        }
        var size = other.size;
        if (typeof size !== 'number') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like (size)');
        }
        if (typeof other.has !== 'function' || typeof other.keys !== 'function') {
            throw new TypeError('Set.prototype.' + name + ': argument is not set-like (has/keys)');
        }
        return { size: size, has: other.has.bind(other), keys: other.keys.bind(other) };
    }
    function _installSetMethod(name, impl) {
        if (typeof Set.prototype[name] === 'function') return;
        Object.defineProperty(Set.prototype, name, {
            value: impl, writable: true, configurable: true,
        });
    }
    _installSetMethod('intersection', function intersection(other) {
        var s = _setLikeOf(other, 'intersection');
        var result = new Set();
        // Iterate the smaller of (this, other) for O(min(n, m)).
        if (this.size <= s.size) {
            for (var v of this) if (s.has(v)) result.add(v);
        } else {
            var it = s.keys();
            for (var step = it.next(); !step.done; step = it.next()) {
                if (this.has(step.value)) result.add(step.value);
            }
        }
        return result;
    });
    _installSetMethod('union', function union(other) {
        var s = _setLikeOf(other, 'union');
        var result = new Set(this);
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            result.add(step.value);
        }
        return result;
    });
    _installSetMethod('difference', function difference(other) {
        var s = _setLikeOf(other, 'difference');
        var result = new Set();
        for (var v of this) if (!s.has(v)) result.add(v);
        return result;
    });
    _installSetMethod('symmetricDifference', function symmetricDifference(other) {
        var s = _setLikeOf(other, 'symmetricDifference');
        var result = new Set();
        for (var v of this) if (!s.has(v)) result.add(v);
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            if (!this.has(step.value)) result.add(step.value);
        }
        return result;
    });
    _installSetMethod('isSubsetOf', function isSubsetOf(other) {
        var s = _setLikeOf(other, 'isSubsetOf');
        if (this.size > s.size) return false;
        for (var v of this) if (!s.has(v)) return false;
        return true;
    });
    _installSetMethod('isSupersetOf', function isSupersetOf(other) {
        var s = _setLikeOf(other, 'isSupersetOf');
        if (this.size < s.size) return false;
        var it = s.keys();
        for (var step = it.next(); !step.done; step = it.next()) {
            if (!this.has(step.value)) return false;
        }
        return true;
    });
    _installSetMethod('isDisjointFrom', function isDisjointFrom(other) {
        var s = _setLikeOf(other, 'isDisjointFrom');
        if (this.size <= s.size) {
            for (var v of this) if (s.has(v)) return false;
        } else {
            var it = s.keys();
            for (var step = it.next(); !step.done; step = it.next()) {
                if (this.has(step.value)) return false;
            }
        }
        return true;
    });

    // ============================================================
    // URLPattern — WHATWG URL Pattern Standard.
    //
    // Supports the canonical shape used by routing libraries:
    //   new URLPattern({ pathname: '/users/:id' })
    //   new URLPattern('https://*.example.com/:path*')
    //   pattern.test(input) / pattern.exec(input)
    //
    // The matcher converts each component pattern into a RegExp with
    // named groups and a small wildcard grammar:
    //
    //   :name        capture (one segment, no `/`)
    //   :name(re)    capture with custom inline regex
    //   *            wildcard (zero-or-more anything)
    //   {x}          group
    //   {x}?         optional group
    //
    // Not implemented: pattern modifiers `?`/`+` after capture
    // groups (rare in practice). Real URL Pattern Standard supports
    // them — extend if a real workload surfaces.
    // ============================================================
    // ============================================================
    // WebSocket client (RFC 6455).
    //
    // Builds on top of `net.connect` / `tls.connect` so no new
    // Rust host fns are needed. Performs the HTTP/1.1 Upgrade
    // handshake (verifies `Sec-WebSocket-Accept`), then frames
    // text / binary / close / ping / pong per the spec. Client
    // → server frames are masked with a random 4-byte key.
    //
    // Surface matches WHATWG WebSocket: constructor(url[, protocols]),
    // `.send(data)` for string / ArrayBuffer / TypedArray / Blob,
    // `.close(code?, reason?)`, `readyState` (0..3),
    // `addEventListener`, on{open,message,error,close} setters,
    // `binaryType` ('blob' | 'arraybuffer'). Subprotocol negotiation
    // through the `protocols` argument; `extensions` left empty.
    // ============================================================
    if (typeof globalThis.WebSocket !== 'function') {
        var WS_CONNECTING = 0, WS_OPEN = 1, WS_CLOSING = 2, WS_CLOSED = 3;
        var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

        function _ws_random16() {
            var arr = new Uint8Array(16);
            globalThis.crypto.getRandomValues(arr);
            return arr;
        }
        function _ws_b64(bytes) {
            // node:buffer is available in our polyfill bundle.
            var Buf = globalThis.Buffer || (require('buffer') && require('buffer').Buffer);
            return Buf.from(bytes).toString('base64');
        }
        function _ws_sha1_b64(input) {
            // SHA-1 + base64 — used to verify Sec-WebSocket-Accept.
            var nc = require('crypto');
            var h = nc.createHash('sha1');
            h.update(input);
            var hex = h.digest('hex');
            var bytes = new Uint8Array(hex.length / 2);
            for (var i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            return _ws_b64(bytes);
        }
        function _ws_parseUrl(url) {
            // Reuse globalThis.URL — we just need scheme/host/port/path.
            var u = new URL(url);
            var secure = u.protocol === 'wss:' || u.protocol === 'https:';
            var port = u.port ? parseInt(u.port, 10) : (secure ? 443 : 80);
            return { secure: secure, host: u.hostname, port: port,
                     path: u.pathname + (u.search || '') };
        }

        function _ws_buildHandshake(parsed, key, protocols) {
            var lines = [
                'GET ' + parsed.path + ' HTTP/1.1',
                'Host: ' + parsed.host + (parsed.port !== (parsed.secure ? 443 : 80)
                    ? ':' + parsed.port : ''),
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: ' + key,
                'Sec-WebSocket-Version: 13',
            ];
            if (protocols && protocols.length) {
                var list = Array.isArray(protocols) ? protocols : [protocols];
                lines.push('Sec-WebSocket-Protocol: ' + list.join(', '));
            }
            return lines.join('\r\n') + '\r\n\r\n';
        }

        function _ws_encodeFrame(opcode, payload) {
            // RFC 6455 §5.2. Client→server frames are masked.
            var Buf = globalThis.Buffer || require('buffer').Buffer;
            var data = (typeof payload === 'string') ? Buf.from(payload, 'utf8')
                     : Buf.isBuffer(payload) ? payload
                     : Buf.from(payload);
            var len = data.length;
            var hdr;
            var maskOffset;
            if (len < 126) {
                hdr = Buf.alloc(2 + 4);
                hdr[0] = 0x80 | (opcode & 0x0F); // FIN=1
                hdr[1] = 0x80 | len; // MASK=1, len
                maskOffset = 2;
            } else if (len < 65536) {
                hdr = Buf.alloc(4 + 4);
                hdr[0] = 0x80 | (opcode & 0x0F);
                hdr[1] = 0x80 | 126;
                hdr[2] = (len >> 8) & 0xFF;
                hdr[3] = len & 0xFF;
                maskOffset = 4;
            } else {
                hdr = Buf.alloc(10 + 4);
                hdr[0] = 0x80 | (opcode & 0x0F);
                hdr[1] = 0x80 | 127;
                // 64-bit length, big-endian. JS ints are 53-bit safe; cap
                // at 2^31-1 here. Real-world payloads above 2 GiB hit
                // memory caps anyway.
                hdr.writeUInt32BE(0, 2);
                hdr.writeUInt32BE(len, 6);
                maskOffset = 10;
            }
            var mask = new Uint8Array(4);
            globalThis.crypto.getRandomValues(mask);
            hdr[maskOffset]     = mask[0];
            hdr[maskOffset + 1] = mask[1];
            hdr[maskOffset + 2] = mask[2];
            hdr[maskOffset + 3] = mask[3];
            var masked = Buf.alloc(len);
            for (var i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
            return Buf.concat([hdr, masked]);
        }

        function _ws_decodeFrames(buffer) {
            // Returns { frames: [{opcode, payload, fin}], rest: Buffer }
            // server→client frames are NOT masked.
            var frames = [];
            var p = 0;
            while (p + 2 <= buffer.length) {
                var b1 = buffer[p];
                var b2 = buffer[p + 1];
                var fin = (b1 & 0x80) !== 0;
                var opcode = b1 & 0x0F;
                var masked = (b2 & 0x80) !== 0;
                var len = b2 & 0x7F;
                var hdrLen = 2;
                if (len === 126) {
                    if (buffer.length < p + 4) break;
                    len = buffer.readUInt16BE(p + 2);
                    hdrLen = 4;
                } else if (len === 127) {
                    if (buffer.length < p + 10) break;
                    // Top 32 bits ignored — see encode comment.
                    len = buffer.readUInt32BE(p + 6);
                    hdrLen = 10;
                }
                var maskKey = null;
                if (masked) {
                    if (buffer.length < p + hdrLen + 4) break;
                    maskKey = buffer.slice(p + hdrLen, p + hdrLen + 4);
                    hdrLen += 4;
                }
                if (buffer.length < p + hdrLen + len) break;
                var payload = buffer.slice(p + hdrLen, p + hdrLen + len);
                if (masked) {
                    var unmasked = globalThis.Buffer.alloc(len);
                    for (var i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
                    payload = unmasked;
                }
                frames.push({ opcode: opcode, payload: payload, fin: fin });
                p += hdrLen + len;
            }
            return { frames: frames, rest: buffer.slice(p) };
        }

        function WebSocket(url, protocols) {
            if (!(this instanceof WebSocket)) {
                throw new TypeError('WebSocket is a constructor');
            }
            this.url = String(url);
            this.readyState = WS_CONNECTING;
            this.binaryType = 'blob';
            this.bufferedAmount = 0;
            this.extensions = '';
            this.protocol = '';
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.onclose = null;
            this._listeners = Object.create(null);
            this._handshakeBuf = globalThis.Buffer.alloc(0);
            this._frameBuf = globalThis.Buffer.alloc(0);
            this._handshakeDone = false;
            this._fragments = [];
            this._fragmentOpcode = 0;

            var parsed = _ws_parseUrl(this.url);
            var key = _ws_b64(_ws_random16());
            this._handshakeKey = key;
            this._expectedAccept = _ws_sha1_b64(key + WS_GUID);

            var connectMod = parsed.secure ? 'tls' : 'net';
            var sock;
            try {
                var mod = require(connectMod);
                sock = mod.connect({
                    host: parsed.host,
                    port: parsed.port,
                    servername: parsed.host,
                });
            } catch (e) {
                this._fireError(e);
                this._setReadyState(WS_CLOSED);
                return;
            }
            this._sock = sock;

            var self = this;
            sock.once('connect', function() {
                try {
                    sock.write(_ws_buildHandshake(parsed, key, protocols));
                } catch (e) { self._fireError(e); }
            });
            // TLS sockets fire 'secureConnect' after the TLS handshake;
            // both shapes work here because net's connect→data flow
            // matches.
            sock.once('secureConnect', function() {
                try {
                    sock.write(_ws_buildHandshake(parsed, key, protocols));
                } catch (e) { self._fireError(e); }
            });
            sock.on('data', function(chunk) {
                if (!self._handshakeDone) {
                    self._handshakeBuf = globalThis.Buffer.concat([self._handshakeBuf, chunk]);
                    var idx = self._handshakeBuf.indexOf('\r\n\r\n');
                    if (idx < 0) return;
                    var head = self._handshakeBuf.slice(0, idx).toString('utf8');
                    var rest = self._handshakeBuf.slice(idx + 4);
                    self._handshakeBuf = globalThis.Buffer.alloc(0);
                    if (!self._verifyHandshake(head)) return;
                    self._handshakeDone = true;
                    self._setReadyState(WS_OPEN);
                    self._fire('open', {});
                    if (rest.length) self._handleData(rest);
                    return;
                }
                self._handleData(chunk);
            });
            sock.on('error', function(e) {
                self._fireError(e);
                self._setReadyState(WS_CLOSED);
                self._fire('close', { code: 1006, reason: '', wasClean: false });
            });
            sock.on('close', function() {
                if (self.readyState !== WS_CLOSED) {
                    self._setReadyState(WS_CLOSED);
                    self._fire('close', { code: 1006, reason: '', wasClean: false });
                }
            });
        }
        WebSocket.CONNECTING = WS_CONNECTING;
        WebSocket.OPEN = WS_OPEN;
        WebSocket.CLOSING = WS_CLOSING;
        WebSocket.CLOSED = WS_CLOSED;
        WebSocket.prototype.CONNECTING = WS_CONNECTING;
        WebSocket.prototype.OPEN = WS_OPEN;
        WebSocket.prototype.CLOSING = WS_CLOSING;
        WebSocket.prototype.CLOSED = WS_CLOSED;

        WebSocket.prototype._setReadyState = function(s) { this.readyState = s; };
        WebSocket.prototype._fireError = function(err) {
            var e = (err && err.message) ? err : new Error(String(err || 'WebSocket error'));
            this._fire('error', { error: e, message: e.message });
        };
        WebSocket.prototype._fire = function(type, detail) {
            var ev = Object.assign({ type: type, target: this }, detail || {});
            var prop = 'on' + type;
            try { if (typeof this[prop] === 'function') this[prop](ev); } catch (_) {}
            var arr = this._listeners[type];
            if (arr) {
                for (var i = 0; i < arr.length; i++) {
                    try { arr[i](ev); } catch (_) {}
                }
            }
        };
        WebSocket.prototype._verifyHandshake = function(head) {
            var lines = head.split('\r\n');
            var status = lines[0] || '';
            if (status.indexOf(' 101 ') === -1) {
                this._fireError(new Error('WebSocket handshake failed: ' + status));
                this._setReadyState(WS_CLOSED);
                this._fire('close', { code: 1006, reason: '', wasClean: false });
                return false;
            }
            var accept = '';
            var protocol = '';
            for (var i = 1; i < lines.length; i++) {
                var c = lines[i].indexOf(':');
                if (c < 0) continue;
                var name = lines[i].slice(0, c).trim().toLowerCase();
                var value = lines[i].slice(c + 1).trim();
                if (name === 'sec-websocket-accept') accept = value;
                else if (name === 'sec-websocket-protocol') protocol = value;
            }
            if (accept !== this._expectedAccept) {
                this._fireError(new Error('WebSocket handshake: bad Sec-WebSocket-Accept'));
                this._setReadyState(WS_CLOSED);
                this._fire('close', { code: 1006, reason: '', wasClean: false });
                return false;
            }
            this.protocol = protocol;
            return true;
        };
        WebSocket.prototype._handleData = function(chunk) {
            this._frameBuf = globalThis.Buffer.concat([this._frameBuf, chunk]);
            var dec = _ws_decodeFrames(this._frameBuf);
            this._frameBuf = dec.rest;
            for (var i = 0; i < dec.frames.length; i++) this._handleFrame(dec.frames[i]);
        };
        WebSocket.prototype._handleFrame = function(frame) {
            switch (frame.opcode) {
                case 0x0: // continuation
                    this._fragments.push(frame.payload);
                    if (frame.fin) {
                        var full = globalThis.Buffer.concat(this._fragments);
                        this._fragments = [];
                        this._dispatchMessage(this._fragmentOpcode, full);
                    }
                    break;
                case 0x1: // text
                case 0x2: // binary
                    if (frame.fin) {
                        this._dispatchMessage(frame.opcode, frame.payload);
                    } else {
                        this._fragments = [frame.payload];
                        this._fragmentOpcode = frame.opcode;
                    }
                    break;
                case 0x8: // close
                    var code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
                    var reason = frame.payload.length > 2
                        ? frame.payload.slice(2).toString('utf8') : '';
                    this._setReadyState(WS_CLOSING);
                    try { this._sock.write(_ws_encodeFrame(0x8, frame.payload)); } catch (_) {}
                    try { this._sock.end(); } catch (_) {}
                    this._setReadyState(WS_CLOSED);
                    this._fire('close', { code: code, reason: reason, wasClean: true });
                    break;
                case 0x9: // ping → respond with pong, same payload
                    try { this._sock.write(_ws_encodeFrame(0xA, frame.payload)); } catch (_) {}
                    break;
                case 0xA: // pong → ignore
                    break;
                default:
                    // Unknown opcode → fail the connection per spec.
                    this._fireError(new Error('WebSocket: unknown opcode ' + frame.opcode));
                    try { this._sock.end(); } catch (_) {}
                    break;
            }
        };
        WebSocket.prototype._dispatchMessage = function(opcode, payload) {
            var data;
            if (opcode === 0x1) {
                data = payload.toString('utf8');
            } else if (this.binaryType === 'arraybuffer') {
                var ab = new ArrayBuffer(payload.length);
                new Uint8Array(ab).set(payload);
                data = ab;
            } else {
                // 'blob' default — surface as Buffer (Blob exists but the
                // canonical browser shape is opaque; node's `ws` package
                // surfaces Buffer here too).
                data = payload;
            }
            this._fire('message', { data: data });
        };
        WebSocket.prototype.send = function(data) {
            if (this.readyState !== WS_OPEN) {
                throw new Error('WebSocket is not open: readyState ' + this.readyState);
            }
            var opcode = (typeof data === 'string') ? 0x1 : 0x2;
            var Buf = globalThis.Buffer;
            var payload;
            if (typeof data === 'string') {
                payload = Buf.from(data, 'utf8');
            } else if (data instanceof ArrayBuffer) {
                payload = Buf.from(new Uint8Array(data));
            } else if (ArrayBuffer.isView(data)) {
                payload = Buf.from(data.buffer, data.byteOffset, data.byteLength);
            } else if (Buf.isBuffer(data)) {
                payload = data;
            } else {
                payload = Buf.from(String(data), 'utf8');
            }
            try { this._sock.write(_ws_encodeFrame(opcode, payload)); }
            catch (e) { this._fireError(e); }
        };
        WebSocket.prototype.close = function(code, reason) {
            if (this.readyState >= WS_CLOSING) return;
            this._setReadyState(WS_CLOSING);
            var Buf = globalThis.Buffer;
            var payload = Buf.alloc(0);
            if (typeof code === 'number') {
                var rb = reason ? Buf.from(String(reason), 'utf8') : Buf.alloc(0);
                payload = Buf.alloc(2 + rb.length);
                payload.writeUInt16BE(code, 0);
                if (rb.length) rb.copy(payload, 2);
            }
            try { this._sock.write(_ws_encodeFrame(0x8, payload)); } catch (_) {}
            try { this._sock.end(); } catch (_) {}
        };
        WebSocket.prototype.addEventListener = function(type, listener) {
            if (typeof listener !== 'function') return;
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(listener);
        };
        WebSocket.prototype.removeEventListener = function(type, listener) {
            var arr = this._listeners[type];
            if (!arr) return;
            var idx = arr.indexOf(listener);
            if (idx >= 0) arr.splice(idx, 1);
        };
        WebSocket.prototype.dispatchEvent = function(event) {
            if (event && typeof event.type === 'string') this._fire(event.type, event);
            return true;
        };

        globalThis.WebSocket = WebSocket;
    }

    // ============================================================
    // EventSource (Server-Sent Events client).
    //
    // RFC 6202 / WHATWG. Built on `fetch`. Our fetch buffers the
    // whole response body (no streaming), so this implementation is
    // best-effort: it issues a request, parses every `data:` event
    // out of the returned body in one pass, fires `message` events,
    // and reconnects per the `retry:` directive (or 3s default).
    // Works perfectly for finite SSE responses where the server
    // sends N events then closes; longer-lived infinite streams
    // would benefit from streaming HTTP responses (separate feature).
    // ============================================================
    if (typeof globalThis.EventSource !== 'function') {
        var ES_CONNECTING = 0, ES_OPEN = 1, ES_CLOSED = 2;
        function EventSource(url, init) {
            if (!(this instanceof EventSource)) {
                throw new TypeError('EventSource is a constructor');
            }
            this.url = String(url);
            this.readyState = ES_CONNECTING;
            this.withCredentials = !!(init && init.withCredentials);
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this._listeners = Object.create(null);
            this._lastEventId = '';
            this._retryMs = 3000;
            this._closed = false;
            this._connect();
        }
        EventSource.CONNECTING = ES_CONNECTING;
        EventSource.OPEN = ES_OPEN;
        EventSource.CLOSED = ES_CLOSED;
        EventSource.prototype.CONNECTING = ES_CONNECTING;
        EventSource.prototype.OPEN = ES_OPEN;
        EventSource.prototype.CLOSED = ES_CLOSED;

        EventSource.prototype._fire = function(type, detail) {
            var ev = Object.assign({ type: type, target: this }, detail || {});
            var prop = 'on' + type;
            try { if (typeof this[prop] === 'function') this[prop](ev); } catch (_) {}
            var arr = this._listeners[type];
            if (arr) for (var i = 0; i < arr.length; i++) {
                try { arr[i](ev); } catch (_) {}
            }
        };
        EventSource.prototype.addEventListener = function(type, listener) {
            if (typeof listener !== 'function') return;
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(listener);
        };
        EventSource.prototype.removeEventListener = function(type, listener) {
            var arr = this._listeners[type];
            if (!arr) return;
            var idx = arr.indexOf(listener);
            if (idx >= 0) arr.splice(idx, 1);
        };
        EventSource.prototype.dispatchEvent = function(event) {
            if (event && typeof event.type === 'string') this._fire(event.type, event);
            return true;
        };
        EventSource.prototype.close = function() {
            this._closed = true;
            this.readyState = ES_CLOSED;
        };

        EventSource.prototype._connect = function() {
            if (this._closed) return;
            var self = this;
            var headers = { 'Accept': 'text/event-stream' };
            if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;
            // Use the global fetch installed at the top of the
            // bundle. Buffered body comes back as text — we parse
            // the whole stream at once.
            globalThis.fetch(this.url, { headers: headers }).then(function(resp) {
                if (self._closed) return;
                if (!resp.ok) {
                    self._fire('error', { message: 'EventSource HTTP ' + resp.status });
                    self._scheduleReconnect();
                    return;
                }
                self.readyState = ES_OPEN;
                self._fire('open', {});
                return resp.text().then(function(body) {
                    self._parse(body);
                    self._scheduleReconnect();
                });
            }).catch(function(e) {
                if (self._closed) return;
                self._fire('error', { message: e && e.message });
                self._scheduleReconnect();
            });
        };

        EventSource.prototype._scheduleReconnect = function() {
            if (this._closed) return;
            var self = this;
            this.readyState = ES_CONNECTING;
            setTimeout(function() { self._connect(); }, this._retryMs);
        };

        EventSource.prototype._parse = function(body) {
            // Split into events on blank lines (\n\n or \r\n\r\n).
            // Each event is a sequence of `field: value` lines.
            var events = String(body).split(/\r?\n\r?\n/);
            for (var i = 0; i < events.length; i++) {
                var raw = events[i];
                if (!raw) continue;
                var lines = raw.split(/\r?\n/);
                var name = 'message';
                var data = '';
                var id = null;
                for (var j = 0; j < lines.length; j++) {
                    var line = lines[j];
                    if (!line || line.charAt(0) === ':') continue;
                    var c = line.indexOf(':');
                    var field = c < 0 ? line : line.slice(0, c);
                    var value = c < 0 ? '' : line.slice(c + 1);
                    if (value.charAt(0) === ' ') value = value.slice(1);
                    if (field === 'event') name = value;
                    else if (field === 'data') data += (data ? '\n' : '') + value;
                    else if (field === 'id') id = value;
                    else if (field === 'retry') {
                        var n = parseInt(value, 10);
                        if (!isNaN(n) && n > 0) this._retryMs = n;
                    }
                }
                if (id !== null) this._lastEventId = id;
                if (data === '' && lines.length === 1 && lines[0] === '') continue;
                this._fire(name, { data: data, lastEventId: this._lastEventId, origin: this.url });
            }
        };
        globalThis.EventSource = EventSource;
    }

    if (typeof globalThis.URLPattern !== 'function') {
        var COMPONENTS = ['protocol', 'username', 'password', 'hostname', 'port',
                          'pathname', 'search', 'hash'];

        function compileURLPattern(pat, isPath) {
            // Empty pattern → match anything.
            if (pat === undefined || pat === null || pat === '') {
                return { regex: /^.*$/, names: [] };
            }
            var src = String(pat);
            var out = '^';
            var names = [];
            var i = 0;
            while (i < src.length) {
                var c = src[i];
                if (c === '\\') {
                    // Escape: copy the next char raw.
                    if (i + 1 < src.length) {
                        out += '\\' + src[i + 1];
                        i += 2;
                    } else {
                        out += '\\\\';
                        i += 1;
                    }
                    continue;
                }
                if (c === ':' && /[A-Za-z_$]/.test(src[i + 1] || '')) {
                    // Capture group `:name` or `:name(regex)`.
                    var j = i + 1;
                    while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
                    var name = src.slice(i + 1, j);
                    var re;
                    if (src[j] === '(') {
                        var depth = 1, k = j + 1;
                        while (k < src.length && depth > 0) {
                            if (src[k] === '\\') { k += 2; continue; }
                            if (src[k] === '(') depth++;
                            else if (src[k] === ')') depth--;
                            if (depth > 0) k++;
                        }
                        re = src.slice(j + 1, k);
                        j = k + 1; // past `)`
                    } else {
                        re = isPath ? '[^/]+' : '[^/]+';
                    }
                    names.push(name);
                    out += '(' + re + ')';
                    i = j;
                    continue;
                }
                if (c === '*') {
                    out += '.*';
                    i += 1;
                    continue;
                }
                // Regex metacharacters get escaped so the literal text
                // matches itself, not as a metacharacter.
                if ('.^$+?()[]{}|'.indexOf(c) !== -1) {
                    out += '\\' + c;
                } else {
                    out += c;
                }
                i += 1;
            }
            out += '$';
            return { regex: new RegExp(out), names: names };
        }

        function URLPattern(input, baseURL) {
            if (!(this instanceof URLPattern)) {
                throw new TypeError('URLPattern is a constructor');
            }
            var spec = {};
            if (typeof input === 'string') {
                // Parse as URL pattern string. Use the first absolute
                // separator to split off scheme + host + path; we
                // rely on the URL parser for the easy split, then
                // assign each piece's pattern.
                try {
                    // The URL parser doesn't accept `:name` syntax in
                    // the path — temporarily encode `:` so URL parses,
                    // then decode.
                    var encoded = input.replace(/:([A-Za-z_$][A-Za-z0-9_$]*)/g, '__AB_URLP_$1__');
                    var u = new URL(encoded, baseURL || 'http://x.invalid/');
                    var dec = function(s) { return s.replace(/__AB_URLP_([A-Za-z0-9_$]+)__/g, ':$1'); };
                    spec.protocol = dec(u.protocol.replace(/:$/, ''));
                    spec.hostname = dec(u.hostname);
                    spec.port = dec(u.port);
                    spec.pathname = dec(u.pathname);
                    spec.search = dec(u.search.replace(/^\?/, ''));
                    spec.hash = dec(u.hash.replace(/^#/, ''));
                } catch (_) {
                    spec.pathname = input;
                }
            } else if (input && typeof input === 'object') {
                for (var k = 0; k < COMPONENTS.length; k++) {
                    if (input[COMPONENTS[k]] !== undefined) {
                        spec[COMPONENTS[k]] = String(input[COMPONENTS[k]]);
                    }
                }
            } else {
                throw new TypeError('URLPattern: input must be a string or object');
            }
            this._compiled = {};
            for (var n = 0; n < COMPONENTS.length; n++) {
                var name = COMPONENTS[n];
                this._compiled[name] = compileURLPattern(spec[name], name === 'pathname');
            }
        }

        function _exec(self, input) {
            var u;
            try {
                if (typeof input === 'string') u = new URL(input);
                else if (input && typeof input === 'object') {
                    // input shape: { pathname, search, ... } or full URL
                    u = {
                        protocol: (input.protocol || '').replace(/:$/, ''),
                        username: input.username || '',
                        password: input.password || '',
                        hostname: input.hostname || '',
                        port: input.port || '',
                        pathname: input.pathname || '',
                        search: (input.search || '').replace(/^\?/, ''),
                        hash: (input.hash || '').replace(/^#/, ''),
                    };
                } else {
                    return null;
                }
            } catch (_) { return null; }

            var inputs = {
                protocol: (u.protocol || '').replace(/:$/, ''),
                username: u.username || '',
                password: u.password || '',
                hostname: u.hostname || '',
                port: u.port || '',
                pathname: u.pathname || '',
                search: (u.search || '').replace(/^\?/, ''),
                hash: (u.hash || '').replace(/^#/, ''),
            };
            var result = { inputs: [input] };
            for (var i = 0; i < COMPONENTS.length; i++) {
                var name = COMPONENTS[i];
                var c = self._compiled[name];
                var m = c.regex.exec(inputs[name]);
                if (!m) return null;
                var groups = {};
                for (var g = 0; g < c.names.length; g++) {
                    groups[c.names[g]] = m[g + 1];
                }
                result[name] = { input: inputs[name], groups: groups };
            }
            return result;
        }

        URLPattern.prototype.test = function(input) { return _exec(this, input) !== null; };
        URLPattern.prototype.exec = function(input) { return _exec(this, input); };
        // Spec accessors (return the source pattern strings). Best-
        // effort: we don't reconstruct the original `:name` form, just
        // return a compiled regex source so `console.log(p.pathname)`
        // is at least informative.
        for (var ci = 0; ci < COMPONENTS.length; ci++) {
            (function(name) {
                Object.defineProperty(URLPattern.prototype, name, {
                    get: function() { return this._compiled[name].regex.source; },
                    configurable: true,
                });
            })(COMPONENTS[ci]);
        }

        globalThis.URLPattern = URLPattern;
    }
})();

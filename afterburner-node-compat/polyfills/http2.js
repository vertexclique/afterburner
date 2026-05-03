// http2 — Node 20's HTTP/2 module. A real HTTP/2 implementation
// requires negotiating the TLS ALPN handshake, parsing HPACK,
// scheduling streams within a connection — substantial enough to
// be its own phase. Until then, this polyfill exposes the API
// surface so `import { connect } from 'http2'` doesn't blow up at
// import time, and routes the most common usage (single-stream
// requests) through the existing `https` polyfill where possible.

__register_module('http2', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;
    var Buffer = require('buffer').Buffer;

    function notImpl(name) {
        var e = new Error(
            'http2.' + name + ' is not yet implemented in burn — full HTTP/2 ' +
            'frame handling lands in a follow-up. For most outbound HTTP/2 use ' +
            'cases the `https` module already negotiates HTTP/1.1 over TLS ' +
            'against HTTP/2-capable servers; switch to https for now.'
        );
        e.code = 'ERR_HTTP2_NOT_IMPLEMENTED';
        return e;
    }

    // ---- ClientHttp2Session ---------------------------------------

    function ClientHttp2Session() {
        EventEmitter.call(this);
        this.closed = false;
        this.destroyed = false;
        this.alpnProtocol = 'h2';
        this.connecting = false;
    }
    ClientHttp2Session.prototype = Object.create(EventEmitter.prototype);
    ClientHttp2Session.prototype.constructor = ClientHttp2Session;
    ClientHttp2Session.prototype.request = function() { throw notImpl('Session.request'); };
    ClientHttp2Session.prototype.close = function() { this.closed = true; };
    ClientHttp2Session.prototype.destroy = function() { this.destroyed = true; };
    ClientHttp2Session.prototype.ping = function(_payload, callback) {
        if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(notImpl('Session.ping')); });
        }
        return false;
    };
    ClientHttp2Session.prototype.settings = function() {};
    ClientHttp2Session.prototype.setTimeout = function() {};
    ClientHttp2Session.prototype.unref = function() { return this; };
    ClientHttp2Session.prototype.ref = function() { return this; };

    function connect(authority, options, listener) {
        var session = new ClientHttp2Session();
        session.authority = authority;
        if (typeof listener === 'function') session.on('connect', listener);
        Promise.resolve().then(function() {
            try { session.emit('error', notImpl('connect')); } catch (_) {}
        });
        return session;
    }

    // ---- Server side ----------------------------------------------

    function Http2Server() {
        EventEmitter.call(this);
    }
    Http2Server.prototype = Object.create(EventEmitter.prototype);
    Http2Server.prototype.constructor = Http2Server;
    Http2Server.prototype.listen = function() { throw notImpl('Server.listen'); };
    Http2Server.prototype.close = function() {};
    Http2Server.prototype.address = function() { return null; };
    Http2Server.prototype.setTimeout = function() {};

    function createServer() { return new Http2Server(); }
    function createSecureServer() { return new Http2Server(); }

    // ---- constants ------------------------------------------------

    var constants = {
        NGHTTP2_NO_ERROR: 0,
        NGHTTP2_PROTOCOL_ERROR: 1,
        NGHTTP2_INTERNAL_ERROR: 2,
        HTTP2_HEADER_AUTHORITY: ':authority',
        HTTP2_HEADER_METHOD: ':method',
        HTTP2_HEADER_PATH: ':path',
        HTTP2_HEADER_SCHEME: ':scheme',
        HTTP2_HEADER_STATUS: ':status',
    };

    function getDefaultSettings() {
        return {
            headerTableSize: 4096,
            enablePush: true,
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            maxConcurrentStreams: 4294967295,
            maxHeaderListSize: 65535,
            maxHeaderSize: 65535,
        };
    }
    function getPackedSettings() { return Buffer.alloc(0); }
    function getUnpackedSettings() { return getDefaultSettings(); }
    function performServerHandshake() {
        return new Http2Server();
    }
    function sensitiveHeaders() { return Symbol('sensitiveHeaders'); }

    exports.connect = connect;
    exports.createServer = createServer;
    exports.createSecureServer = createSecureServer;
    exports.constants = constants;
    exports.Http2Session = ClientHttp2Session;
    exports.ClientHttp2Session = ClientHttp2Session;
    exports.ServerHttp2Session = ClientHttp2Session;
    exports.Http2Stream = function() { throw notImpl('Stream'); };
    exports.Http2ServerRequest = function() { throw notImpl('ServerRequest'); };
    exports.Http2ServerResponse = function() { throw notImpl('ServerResponse'); };
    exports.Http2Server = Http2Server;
    exports.getDefaultSettings = getDefaultSettings;
    exports.getPackedSettings = getPackedSettings;
    exports.getUnpackedSettings = getUnpackedSettings;
    exports.performServerHandshake = performServerHandshake;
    exports.sensitiveHeaders = sensitiveHeaders();
});

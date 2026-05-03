// dgram — Node 20's UDP socket module. Real UDP isn't sandbox-safe
// without manifold gating + a tokio host coordinator (parallel to
// `daemon_net` but for UDP). v1 of this polyfill exposes the API
// shape with stub behaviour: socket creation succeeds, send /
// receive surface a clear error explaining the host UDP coordinator
// hasn't shipped yet, and library code that imports `dgram`
// defensively (e.g. some metrics + tracing libraries) doesn't
// crash on import.
//
// When the daemon-side UDP coordinator lands, the body of `bind` /
// `send` / `addMembership` etc. swap to host-import calls — the
// JS surface stays unchanged.

__register_module('dgram', function(module, exports, require) {
    var EventEmitter = require('events').EventEmitter;

    function Socket(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.type = (typeof opts === 'string') ? opts : (opts.type || 'udp4');
        this._reuseAddr = !!opts.reuseAddr;
        this._ipv6Only = !!opts.ipv6Only;
        this._bound = false;
        this._closed = false;
    }
    Socket.prototype = Object.create(EventEmitter.prototype);
    Socket.prototype.constructor = Socket;

    function notImpl(name) {
        var e = new Error(
            'dgram.Socket.' + name + ' is not yet implemented in burn — the host-side ' +
            'UDP coordinator (parallel to daemon_net) lands in a follow-up. The API ' +
            'surface is exposed today so libraries that import dgram defensively ' +
            "don't crash; runtime use will surface this error."
        );
        e.code = 'ERR_NOT_IMPLEMENTED';
        return e;
    }

    Socket.prototype.bind = function(_port, _address, callback) {
        var err = notImpl('bind');
        if (typeof callback === 'function') {
            Promise.resolve().then(function() { callback(err); });
        }
        var self = this;
        Promise.resolve().then(function() { try { self.emit('error', err); } catch (_) {} });
        return this;
    };
    Socket.prototype.close = function(callback) {
        this._closed = true;
        var self = this;
        Promise.resolve().then(function() {
            try { self.emit('close'); } catch (_) {}
            if (typeof callback === 'function') callback();
        });
        return this;
    };
    Socket.prototype.send = function(_msg /*, ...rest, callback */) {
        var args = Array.prototype.slice.call(arguments);
        var callback = (args.length && typeof args[args.length - 1] === 'function')
            ? args.pop()
            : null;
        var err = notImpl('send');
        if (callback) {
            Promise.resolve().then(function() { callback(err); });
        } else {
            throw err;
        }
        return this;
    };
    Socket.prototype.address = function() {
        if (!this._bound) {
            var e = new Error('Not running');
            e.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
            throw e;
        }
        return { address: '0.0.0.0', port: 0, family: this.type === 'udp6' ? 'IPv6' : 'IPv4' };
    };
    Socket.prototype.connect = function() { throw notImpl('connect'); };
    Socket.prototype.disconnect = function() { throw notImpl('disconnect'); };
    Socket.prototype.remoteAddress = function() { throw notImpl('remoteAddress'); };
    Socket.prototype.setBroadcast = function() {};
    Socket.prototype.setTTL = function() {};
    Socket.prototype.setMulticastTTL = function() {};
    Socket.prototype.setMulticastInterface = function() {};
    Socket.prototype.setMulticastLoopback = function() {};
    Socket.prototype.addMembership = function() {};
    Socket.prototype.dropMembership = function() {};
    Socket.prototype.addSourceSpecificMembership = function() {};
    Socket.prototype.dropSourceSpecificMembership = function() {};
    Socket.prototype.setRecvBufferSize = function() {};
    Socket.prototype.setSendBufferSize = function() {};
    Socket.prototype.getRecvBufferSize = function() { return 0; };
    Socket.prototype.getSendBufferSize = function() { return 0; };
    Socket.prototype.ref = function() { return this; };
    Socket.prototype.unref = function() { return this; };

    function createSocket(opts, callback) {
        var sock = new Socket(opts);
        if (typeof callback === 'function') sock.on('message', callback);
        return sock;
    }

    exports.createSocket = createSocket;
    exports.Socket = Socket;
});

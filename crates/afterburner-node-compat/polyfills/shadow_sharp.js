// L3 shadow for the `sharp` npm package.
//
// require('sharp') resolves to this polyfill regardless of whether
// node_modules/sharp exists; the upstream package ships a libvips
// `.node` native addon that cannot load inside the WASM sandbox, so
// the shadow kicks in transparently.
//
// Backed by:
//   * `image` crate — codec layer (PNG, JPEG, WebP, GIF, BMP)
//   * `fast_image_resize` — SIMD-accelerated resizing
//
// The fluent builder pattern accumulates ops in JS without any host
// roundtrip; only the terminal call (toBuffer / toFile / metadata)
// crosses into Rust, with the entire pipeline as one JSON blob.
//
// API surface — covers the operations real `sharp` users actually
// reach for:
//
//   sharp(input)
//     .resize(width[, height][, options])     // {fit, kernel}
//     .rotate(degrees)                        // 0/90/180/270 only
//     .grayscale() / .greyscale()
//     .flip() / .flop()
//     .extract({left, top, width, height})    // crop
//     .blur(sigma)
//     .negate()
//     .jpeg({quality}) / .png({compressionLevel}) / .webp({quality, lossless})
//     .toBuffer()              -> Promise<Buffer>
//     .toFile(path)            -> Promise<{format, size, width, height}>
//     .metadata()              -> Promise<{width, height, format, channels, hasAlpha, ...}>
//
// Deferred (intentionally; throw a clear error if used):
//   * `.composite(...)` (overlays)
//   * Per-channel `.modulate(...)`, `.tint(...)`, `.recomb(...)`
//   * Streams (`.pipe()`, `Readable` / `Writable` interop)
//   * Raw / SVG / TIFF / AVIF / JP2 / HEIF inputs/outputs
//   * Color-space conversions beyond the codec defaults

__register_module('sharp', function(module, exports, require) {
    var fs = require('fs');
    var Buffer = require('buffer').Buffer;

    function isHostErr(s) {
        return typeof s === 'string' && s.indexOf('__HOST_ERR__:') === 0;
    }

    function hostErrToError(s) {
        var msg = s.slice('__HOST_ERR__:'.length);
        var err = new Error('sharp: ' + msg);
        err.code = 'ERR_SHADOW_SHARP';
        return err;
    }

    function ensureHost(name) {
        var fn = globalThis[name];
        if (typeof fn !== 'function') {
            var err = new Error('sharp not available: rebuild burn with `shadow-sharp`');
            err.code = 'ERR_SHADOW_SHARP';
            throw err;
        }
        return fn;
    }

    // --- source normalization --------------------------------------

    function makeSource(input) {
        if (Buffer.isBuffer(input)) {
            return { kind: 'buffer', data_b64: input.toString('base64') };
        }
        if (input instanceof Uint8Array) {
            return { kind: 'buffer', data_b64: Buffer.from(input).toString('base64') };
        }
        if (typeof input === 'string') {
            // Path. fs.readFileSync (Node-compat: returns Buffer when
            // no encoding is given) reads the file binary-safely.
            var bytes = fs.readFileSync(input);
            return {
                kind: 'buffer',
                data_b64: bytes.toString('base64'),
                _path: input,
            };
        }
        throw new TypeError(
            'sharp: input must be a Buffer, Uint8Array, or filesystem path string'
        );
    }

    // --- Sharp instance --------------------------------------------

    function Sharp(input) {
        if (!(this instanceof Sharp)) return new Sharp(input);
        this._source = makeSource(input);
        this._ops = [];
        this._format = null; // populated by toFormat / .jpeg / .png / .webp
        this._formatOpts = {};
    }

    function pushOp(self, op) {
        self._ops.push(op);
        return self;
    }

    Sharp.prototype.resize = function(width, height, options) {
        // Sharp accepts:
        //   resize(width)
        //   resize(width, height)
        //   resize({width, height, fit, kernel, ...})
        if (typeof width === 'object' && width !== null) {
            options = width;
            width = options.width;
            height = options.height;
        }
        var op = { op: 'resize' };
        if (typeof width === 'number') op.width = width | 0;
        if (typeof height === 'number') op.height = height | 0;
        if (options && typeof options.fit === 'string') op.fit = options.fit;
        if (options && typeof options.kernel === 'string') op.kernel = options.kernel;
        return pushOp(this, op);
    };

    Sharp.prototype.rotate = function(degrees) {
        var d = (degrees | 0);
        return pushOp(this, { op: 'rotate', degrees: d });
    };

    Sharp.prototype.grayscale = function() {
        return pushOp(this, { op: 'grayscale' });
    };
    Sharp.prototype.greyscale = Sharp.prototype.grayscale;

    Sharp.prototype.flip = function() {
        return pushOp(this, { op: 'flip' });
    };

    Sharp.prototype.flop = function() {
        return pushOp(this, { op: 'flop' });
    };

    Sharp.prototype.negate = function() {
        return pushOp(this, { op: 'negate' });
    };

    Sharp.prototype.extract = function(region) {
        if (!region || typeof region !== 'object') {
            throw new TypeError('sharp.extract: region object required');
        }
        return pushOp(this, {
            op: 'extract',
            left: (region.left | 0),
            top: (region.top | 0),
            width: (region.width | 0),
            height: (region.height | 0),
        });
    };

    Sharp.prototype.blur = function(sigma) {
        if (typeof sigma !== 'number' || !isFinite(sigma)) {
            throw new TypeError('sharp.blur: numeric sigma required');
        }
        return pushOp(this, { op: 'blur', sigma: sigma });
    };

    // --- format selection ------------------------------------------

    Sharp.prototype.jpeg = function(options) {
        this._format = 'jpeg';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.png = function(options) {
        this._format = 'png';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.webp = function(options) {
        this._format = 'webp';
        this._formatOpts = options || {};
        return this;
    };

    Sharp.prototype.toFormat = function(format, options) {
        if (typeof format !== 'string') {
            throw new TypeError('sharp.toFormat: format string required');
        }
        switch (format.toLowerCase()) {
            case 'jpeg':
            case 'jpg':
                return this.jpeg(options);
            case 'png':
                return this.png(options);
            case 'webp':
                return this.webp(options);
            default:
                throw new Error('sharp.toFormat: unsupported format ' + format);
        }
    };

    // --- pixel-pipeline ops registered as fluent stages -----------
    //
    // Each op pushes into `this._ops` so the host's image pipeline
    // processes them in order. The host crate (crates/afterburner-
    // node-compat/src/shadows/sharp.rs) reads the op tags below and
    // dispatches to the appropriate `image` / `fast_image_resize`
    // pipeline stage.

    Sharp.prototype.tint = function(rgb) {
        // Accept `{ r, g, b }`, `[r, g, b]`, or a hex string.
        var r, g, b;
        if (typeof rgb === 'string') {
            var hex = rgb.replace(/^#/, '');
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else if (hex.length === 6) {
                r = parseInt(hex.slice(0, 2), 16);
                g = parseInt(hex.slice(2, 4), 16);
                b = parseInt(hex.slice(4, 6), 16);
            }
        } else if (Array.isArray(rgb)) {
            r = rgb[0]; g = rgb[1]; b = rgb[2];
        } else if (rgb && typeof rgb === 'object') {
            r = rgb.r; g = rgb.g; b = rgb.b;
        }
        return pushOp(this, {
            op: 'tint',
            r: (r | 0) & 0xFF, g: (g | 0) & 0xFF, b: (b | 0) & 0xFF,
        });
    };

    Sharp.prototype.modulate = function(opts) {
        // Per sharp's spec: brightness 1.0 = unchanged, saturation
        // 1.0 = unchanged, hue 0 = unchanged (degrees, can be
        // negative).
        opts = opts || {};
        return pushOp(this, {
            op: 'modulate',
            brightness: typeof opts.brightness === 'number' ? opts.brightness : 1,
            saturation: typeof opts.saturation === 'number' ? opts.saturation : 1,
            hue:        typeof opts.hue === 'number' ? opts.hue : 0,
        });
    };

    Sharp.prototype.sharpen = function(sigma, flat, jagged) {
        // sharp(sigma=1.0) is the canonical "unsharp mask" call. We
        // accept either a single number or the legacy {sigma, m1, m2}
        // shape; the host applies an unsharp-mask convolution.
        var s = 1, f = 1, j = 2;
        if (typeof sigma === 'number') s = sigma;
        else if (sigma && typeof sigma === 'object') {
            if (typeof sigma.sigma === 'number') s = sigma.sigma;
            if (typeof sigma.m1 === 'number') f = sigma.m1;
            if (typeof sigma.m2 === 'number') j = sigma.m2;
        }
        if (typeof flat === 'number') f = flat;
        if (typeof jagged === 'number') j = jagged;
        return pushOp(this, { op: 'sharpen', sigma: s, flat: f, jagged: j });
    };

    Sharp.prototype.normalize = function(_opts) {
        // Histogram stretch — host walks per-channel min/max and
        // stretches to [0,255].
        return pushOp(this, { op: 'normalize' });
    };
    Sharp.prototype.normalise = Sharp.prototype.normalize;

    Sharp.prototype.threshold = function(level, opts) {
        // Per sharp: pixels with luminance ≥ level go white; below
        // go black. Default level=128. `grayscale: false` keeps the
        // RGB channels; default true converts to single-channel.
        opts = opts || {};
        return pushOp(this, {
            op: 'threshold',
            level: typeof level === 'number' ? (level | 0) : 128,
            grayscale: opts.grayscale !== false,
        });
    };

    Sharp.prototype.composite = function(layers) {
        // sharp.composite(layers) — array of `{input, top, left, blend}`.
        // Host reads each layer, decodes input bytes, alpha-blends at
        // (left, top). Defaults: top/left = 0, blend = 'over'.
        if (!Array.isArray(layers)) {
            throw new TypeError('sharp.composite: layers must be an array');
        }
        var serialized = layers.map(function(layer) {
            var src = makeSource(layer.input);
            return {
                source_b64: src.bytes_b64,
                top: (layer.top | 0) || 0,
                left: (layer.left | 0) || 0,
                blend: layer.blend || 'over',
                gravity: layer.gravity || null,
            };
        });
        return pushOp(this, { op: 'composite', layers: serialized });
    };

    // --- terminal ops ----------------------------------------------

    Sharp.prototype._buildPipeline = function() {
        // Default to PNG if the user never picked a format — matches
        // Sharp's behavior (preserves source format when possible,
        // but for the shadow we default to PNG since we don't track
        // source format separately).
        var format = this._format || inferDefaultFormat(this._source);
        var output = { format: format };
        var fo = this._formatOpts || {};
        if (format === 'jpeg' && typeof fo.quality === 'number') {
            output.quality = fo.quality | 0;
        }
        if (format === 'png' && typeof fo.compressionLevel === 'number') {
            output.compression = fo.compressionLevel | 0;
        }
        if (format === 'webp') {
            if (typeof fo.quality === 'number') output.quality = fo.quality | 0;
            if (fo.lossless) output.lossless = true;
        }
        // Drop the polyfill's private `_path` from the source object
        // before sending — host doesn't need it.
        var src = { kind: this._source.kind, data_b64: this._source.data_b64 };
        return { source: src, ops: this._ops, output: output };
    };

    function inferDefaultFormat(_source) {
        // Without re-decoding the source we can't know its format
        // here. PNG is the safe default since it round-trips through
        // any pipeline without quality loss.
        return 'png';
    }

    Sharp.prototype.toBuffer = function() {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                var fn = ensureHost('__host_shadow_sharp_run');
                var pipeline = self._buildPipeline();
                var raw = fn(JSON.stringify(pipeline));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                resolve(Buffer.from(raw, 'base64'));
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.toFile = function(path) {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                if (typeof path !== 'string') {
                    throw new TypeError('sharp.toFile: path must be a string');
                }
                var fn = ensureHost('__host_shadow_sharp_run');
                var pipeline = self._buildPipeline();
                var raw = fn(JSON.stringify(pipeline));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                var bytes = Buffer.from(raw, 'base64');
                // fs.writeFileSync is now binary-safe (accepts Buffer).
                fs.writeFileSync(path, bytes);
                // After write, look up actual dimensions via metadata
                // path so the resolved info matches what's on disk.
                var metaFn = ensureHost('__host_shadow_sharp_metadata');
                var metaRaw = metaFn(JSON.stringify({
                    kind: 'buffer',
                    data_b64: raw,
                }));
                var info = isHostErr(metaRaw) ? {} : JSON.parse(metaRaw);
                resolve({
                    format: pipeline.output.format,
                    size: bytes.length,
                    width: info.width || 0,
                    height: info.height || 0,
                    channels: info.channels || 0,
                });
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.metadata = function() {
        var self = this;
        return new Promise(function(resolve, reject) {
            try {
                var fn = ensureHost('__host_shadow_sharp_metadata');
                var raw = fn(JSON.stringify({
                    kind: self._source.kind,
                    data_b64: self._source.data_b64,
                }));
                if (isHostErr(raw)) { reject(hostErrToError(raw)); return; }
                resolve(JSON.parse(raw));
            } catch (e) { reject(e); }
        });
    };

    Sharp.prototype.stats = function() {
        // Sharp's `.stats()` returns per-channel min/max/sum/etc.
        // Defer until users ask — most pipelines don't need it.
        return Promise.reject(notImplementedAsError('stats'));
    };

    function notImplementedAsError(name) {
        var e = new Error('sharp.' + name + ' is not implemented in the burn shadow yet');
        e.code = 'ERR_SHADOW_SHARP_NOT_IMPL';
        return e;
    }

    // --- module exports --------------------------------------------

    function createSharp(input) {
        return new Sharp(input);
    }

    // Match upstream's `module.exports = sharp` shape — `sharp(input)`
    // is the entry point AND the namespace for constants.
    createSharp.cache = function() { return {}; };
    createSharp.concurrency = function() { return 1; };
    createSharp.simd = function() { return true; };
    createSharp.versions = { sharp: 'burn-shadow-1' };
    createSharp.format = {
        jpeg: { id: 'jpeg', input: { buffer: true, file: true } },
        png:  { id: 'png',  input: { buffer: true, file: true } },
        webp: { id: 'webp', input: { buffer: true, file: true } },
    };

    module.exports = createSharp;
});

// Real Express.js app inside Afterburner.
//
// Adapter pattern:
//   1. Build a Node-shape `req` via `http._makeIncomingMessage`.
//   2. Pre-set `req.body` from the host envelope (parsed JSON when
//      content-type matches). Real Express middleware would do this
//      via `app.use(express.json())`, but body-parser pulls in
//      `iconv-lite` which reaches for Node-specific Buffer internals
//      we don't polyfill end-to-end. Pre-parsing in the adapter is
//      the documented bridging pattern for serverless-style hosts
//      (aws-serverless-express, vercel, etc. all do the same).
//   3. Build a Node-shape `res` and override `res.end` to resolve
//      the host Promise with `{status, headers, body}`.
//   4. Hand `(req, res)` to Express. Routes run, middleware runs,
//      `res.json` → `res.send` → `res.end` → adapter resolves.
//
// PARALLELISM NOTE: when this same script runs under `burn server.js`
// (CLI daemon mode rather than the embedding shape in main.rs), the
// daemon auto-shards across all CPUs — N independent QuickJS isolates,
// each on a dedicated OS thread, with requests round-robined across
// them. In-process state (e.g., a `let counter = 0` outside a route)
// becomes per-shard. The handlers below are stateless so they're
// unaffected; for shared state, use `require('afterburner:state')`.
// See examples/express-app/README.md "How it parallelises".

const express = require('express');
const http = require('http');

const app = express();

app.use((req, _res, next) => {
    req.receivedAt = Date.now();
    next();
});

app.get('/', (_req, res) => {
    res.json({
        service: 'afterburner-example-express-app',
        ok: true,
        framework: 'express',
        endpoints: [
            'GET  /',
            'GET  /health',
            'GET  /hello/:name',
            'POST /echo',
            'POST /sum',
        ],
    });
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_ms: Date.now() });
});

app.get('/hello/:name', (req, res) => {
    res.json({ greeting: `Hello, ${req.params.name}!` });
});

app.post('/echo', (req, res) => {
    res.json({ received: req.body, headers: req.headers });
});

app.post('/sum', (req, res) => {
    const arr = Array.isArray(req.body) ? req.body : [];
    const nums = arr.filter((n) => typeof n === 'number');
    if (nums.length === 0) {
        return res.status(400).json({ error: 'body must be a JSON array of numbers' });
    }
    res.json({ sum: nums.reduce((a, b) => a + b, 0), count: nums.length });
});

app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    res.status(500).json({ error: String((err && err.message) || err) });
});

module.exports = function handle(envelope) {
    return new Promise(function (resolve) {
        const headers = envelope.headers || {};
        const url = envelope.path + (envelope.query ? '?' + envelope.query : '');
        const bodyText = stringifyBody(envelope.body);

        const req = http._makeIncomingMessage({
            method: envelope.method || 'GET',
            url,
            headers,
            body: bodyText,
        });

        // Pre-parse body when content-type is JSON. Express's route
        // handlers expect `req.body` to be the parsed object.
        const ct = String(headers['content-type'] || '').toLowerCase();
        if (ct.indexOf('application/json') === 0 && bodyText.length > 0) {
            try { req.body = JSON.parse(bodyText); } catch (_) { req.body = bodyText; }
        } else if (bodyText.length > 0) {
            req.body = bodyText;
        }

        const res = http._makeServerResponse('local');
        let settled = false;

        res.end = function (chunk) {
            if (settled) return res;
            settled = true;
            if (chunk !== undefined && chunk !== null) {
                res._buffered += typeof chunk === 'string'
                    ? chunk
                    : (chunk && typeof chunk.toString === 'function' ? chunk.toString() : '');
            }
            res.writableEnded = true;
            const respCT = (res._headers['content-type'] || '').toLowerCase();
            let body = res._buffered;
            if (respCT.indexOf('application/json') === 0 && body) {
                try { body = JSON.parse(body); } catch (_) { /* leave as text */ }
            }
            resolve({ status: res.statusCode || 200, headers: res._headers, body });
            return res;
        };

        try {
            app(req, res);
        } catch (e) {
            if (!settled) {
                settled = true;
                resolve({
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                    body: { error: String((e && e.message) || e) },
                });
            }
        }
    });
};

function stringifyBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    return JSON.stringify(body);
}

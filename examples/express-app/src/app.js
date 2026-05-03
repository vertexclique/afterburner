// Express-style JS app that runs *inside* Afterburner. No real HTTP
// server in here — the host (axum in main.rs) listens, serializes
// each request as { method, path, query, headers, body }, dispatches
// through this handler via `Afterburner::run`, and serializes the
// { status, headers, body } response back onto the wire.
//
// The router is ~40 lines of vanilla JS that mirrors the pieces of
// Express.js every app actually uses: `.get`, `.post`, path params,
// json bodies, `res.status`, `res.json`, and middleware via `.use`.

const app = (() => {
    const routes = [];
    const mws = [];

    const match = (pattern, path) => {
        const pp = pattern.split('/').filter(Boolean);
        const ap = path.split('/').filter(Boolean);
        if (pp.length !== ap.length) return null;
        const params = {};
        for (let i = 0; i < pp.length; i++) {
            if (pp[i].startsWith(':')) {
                params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
            } else if (pp[i] !== ap[i]) {
                return null;
            }
        }
        return params;
    };

    const makeRes = () => {
        let status = 200;
        const headers = {};
        let body = null;
        const res = {
            status: (s) => { status = s; return res; },
            set: (k, v) => { headers[k] = v; return res; },
            json: (b) => { body = b; headers['content-type'] ||= 'application/json'; return res; },
            text: (b) => { body = b; headers['content-type'] ||= 'text/plain'; return res; },
            html: (b) => { body = b; headers['content-type'] ||= 'text/html'; return res; },
            _finish: () => ({ status, headers, body }),
        };
        return res;
    };

    const handle = (req) => {
        const res = makeRes();
        // Run all "use" middlewares. They can mutate req/res in place
        // or short-circuit by setting a body before a route runs.
        for (const mw of mws) mw(req, res);

        for (const r of routes) {
            if (r.method !== req.method) continue;
            const params = match(r.path, req.path);
            if (!params) continue;
            req.params = params;
            r.handler(req, res);
            return res._finish();
        }
        return res.status(404).json({ error: `no route for ${req.method} ${req.path}` })._finish();
    };

    const register = (method) => (path, handler) => routes.push({ method, path, handler });
    return {
        get: register('GET'),
        post: register('POST'),
        put: register('PUT'),
        delete: register('DELETE'),
        use: (fn) => mws.push(fn),
        handle,
    };
})();

// ── Routes ───────────────────────────────────────────────────────────

app.use((req, _res) => {
    // Access-log middleware: attaches a request-received timestamp.
    req.receivedAt = Date.now();
});

app.get('/', (_req, res) => {
    res.json({
        service: 'afterburner-example-express-app',
        ok: true,
        endpoints: [
            'GET /',
            'GET /health',
            'GET /hello/:name',
            'POST /echo',
            'POST /sum',
        ],
    });
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_ms: Date.now() });
});

app.get('/hello/:name', (req, res) => {
    const { name } = req.params;
    res.json({ greeting: `Hello, ${name}!` });
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
    const sum = nums.reduce((a, b) => a + b, 0);
    res.json({ sum, count: nums.length });
});

module.exports = (req) => app.handle(req);

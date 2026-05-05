// app.ts — Example burn TypeScript app.
//
// Run:
//   burn -A app.ts
//
// `burn` strips the TypeScript types via oxc and runs the resulting
// JavaScript inside a Wasmtime-backed sandbox. Capability gates
// (`-A` = all caps; pick a specific subset for tighter sandboxing)
// control whether the script can listen on sockets, read the
// filesystem, see process.env, etc.
//
// HTTP routes:
//   GET  /         → JSON hello with metadata
//   GET  /health   → liveness probe
//   GET  /counter  → atomic per-process counter (proof of state across requests)
//   POST /echo     → echoes the JSON body back with a server-side sha256

import * as http from 'node:http';
import * as crypto from 'node:crypto';

interface HelloResponse {
  service: 'burn-example';
  version: string;
  uptimeSeconds: number;
  pid: number;
}

interface EchoResponse<T> {
  receivedAt: string;
  bytes: number;
  sha256: string;
  echo: T;
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => Promise<void>;

const startTime = Date.now();
let counter = 0;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(json).toString());
  res.end(json);
}

const routes: Record<string, Record<string, RouteHandler>> = {
  GET: {
    '/': async (_req, res) => {
      const payload: HelloResponse = {
        service: 'burn-example',
        version: '0.1.1',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        pid: process.pid,
      };
      sendJson(res, 200, payload);
    },
    '/health': async (_req, res) => {
      sendJson(res, 200, { status: 'ok' });
    },
    // NOTE: in burn's multi-shard daemon, this counter is per-shard.
    // Hitting /counter on a 16-core box returns values from 16
    // independent counters, not a single monotonic stream. Each
    // shard's counter starts at 0 and the dispatcher round-robins
    // requests across shards, so the first 16 hits all return
    // {"value":1}, the next 16 return {"value":2}, and so on. Use
    // require('afterburner:state') for shared state across shards.
    '/counter': async (_req, res) => {
      counter += 1;
      sendJson(res, 200, { value: counter });
    },
  },
  POST: {
    '/echo': async (_req, res, body) => {
      let parsed: unknown = null;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch (e) {
          sendJson(res, 400, { error: 'invalid JSON', detail: String(e) });
          return;
        }
      }
      const response: EchoResponse<unknown> = {
        receivedAt: new Date().toISOString(),
        bytes: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        echo: parsed,
      };
      sendJson(res, 200, response);
    },
  },
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = req.url ?? '/';
  const handler = routes[method]?.[url];
  if (!handler) {
    sendJson(res, 404, { error: `no route for ${method} ${url}` });
    return;
  }
  try {
    const body =
      method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    await handler(req, res, body);
  } catch (e) {
    sendJson(res, 500, { error: 'handler failed', detail: String(e) });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`burn-example listening on http://127.0.0.1:${port}`);
  console.log('try:');
  console.log(`  curl http://127.0.0.1:${port}/`);
  console.log(`  curl http://127.0.0.1:${port}/health`);
  console.log(`  curl http://127.0.0.1:${port}/counter`);
  console.log(`  curl -X POST -d '{"hi":1}' http://127.0.0.1:${port}/echo`);
});

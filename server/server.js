import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DEFAULT_DB } from './db.js';
import { createStore, HttpError } from './store.js';
import { SimulatedPositionSource, Simulator } from './sim.js';
import { seed } from './seed.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const LEAFLET = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
const PORT = Number(process.env.PORT || 3000);

const db = openDb(process.env.DB_FILE || DEFAULT_DB);
const store = createStore(db, { demo: process.env.DEMO !== '0', simScale: Number(process.env.SIM_SCALE || 20), fetchRoads: true });
if (store.isEmpty()) seed(store);

const positions = new SimulatedPositionSource(store);
new Simulator(store, positions).start();

// ------------------------------------------------------------------ live updates (SSE)

const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let pending = null;
store.on('change', () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    if (!clients.size) return;
    const snap = store.snapshot();
    for (const c of clients) send(c.res, 'snapshot', snap);
  }, 150);
});

setInterval(() => {
  const wanting = [...clients].filter((c) => c.pos);
  if (!wanting.length) return;
  const pos = positions.getPositions();
  for (const c of wanting) send(c.res, 'pos', pos);
}, 1000).unref();

setInterval(() => {
  for (const c of clients) c.res.write(': keep-alive\n\n');
}, 20_000).unref();

function stream(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, pos: url.searchParams.get('pos') === '1' };
  clients.add(client);
  send(res, 'snapshot', store.snapshot());
  if (client.pos) send(res, 'pos', positions.getPositions());
  req.on('close', () => clients.delete(client));
}

// ------------------------------------------------------------------ API

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  let match;

  if (m === 'GET' && p === '/api/stream') return stream(req, res, url);
  if (m === 'GET' && p === '/api/snapshot') return json(res, 200, store.snapshot());
  if (m === 'GET' && p === '/api/positions') return json(res, 200, positions.getPositions());
  if (m === 'POST' && p === '/api/action') return json(res, 200, store.act(await readBody(req)));
  if (m === 'POST' && p === '/api/taxis') return json(res, 201, store.createTaxi(await readBody(req)));
  if (m === 'GET' && (match = p.match(/^\/api\/taxis\/(\d+)\/history$/))) return json(res, 200, store.taxiHistory(match[1]));
  if (m === 'POST' && p === '/api/ranks') return json(res, 201, store.createRank(await readBody(req)));
  if ((match = p.match(/^\/api\/ranks\/(\d+)$/))) {
    if (m === 'PUT') return json(res, 200, store.updateRank(match[1], await readBody(req)));
    if (m === 'DELETE') return json(res, 200, store.deleteRank(match[1]));
  }
  if (m === 'POST' && p === '/api/routes') return json(res, 201, store.createRoute(await readBody(req)));
  if (m === 'DELETE' && (match = p.match(/^\/api\/routes\/(\d+)$/))) return json(res, 200, store.deleteRoute(match[1]));
  if (m === 'POST' && p === '/api/demo') return json(res, 200, store.setDemo((await readBody(req)).on));
  if (m === 'POST' && p === '/api/reset') {
    seed(store);
    return json(res, 200, { message: 'Demo data reloaded' });
  }
  throw new HttpError(404, 'No such API endpoint.');
}

// ------------------------------------------------------------------ static files

const PAGES = { '/': 'index.html', '/staff': 'staff.html', '/marshal': 'marshal.html', '/dashboard': 'dashboard.html', '/editor': 'editor.html', '/board': 'board.html' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
};

function serveFile(res, base, rel) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(base + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  if (PAGES[p] && serveFile(res, PUBLIC, PAGES[p])) return;
  if (p.startsWith('/vendor/leaflet/') && serveFile(res, LEAFLET, p.slice('/vendor/leaflet/'.length))) return;
  if (serveFile(res, PUBLIC, p)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Page not found');
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else throw new HttpError(405, 'Method not allowed.');
  } catch (err) {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Benoni Taxi Association rank tracker running on http://localhost:${PORT}`);
  console.log(`Demo mode ${store.settings.demo ? 'on' : 'off'}, simulated taxis drive ${store.settings.simScale}x faster than real time.`);
});

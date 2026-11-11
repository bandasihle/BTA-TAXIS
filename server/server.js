import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DEFAULT_DB } from './db.js';
import { createStore, HttpError, toId } from './store.js';
import { createAuth } from './auth.js';
import { PositionSource } from './positions.js';
import { CONSENT_VERSION } from '../public/js/consent.js';
import { seed } from './seed.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const LEAFLET = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
const PORT = Number(process.env.PORT || 3000);
// How many proxies in front of us add to X-Forwarded-For (Render: 1). 0 trusts none, so a
// client cannot dodge the sign-in limit by sending its own header.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);

const db = openDb(process.env.DB_FILE || DEFAULT_DB);
const store = createStore(db, { fetchRoads: true });
if (store.isEmpty()) seed(store);
const auth = createAuth(db);
const positions = new PositionSource(store);
setInterval(() => positions.sweep(), 60_000).unref();
// Planned fare changes become the fare on their day.
store.applyDueFares();
setInterval(() => store.applyDueFares(), 60_000).unref();

// The first admin, when there are no accounts yet: from secret environment variables (on a
// host with no shell), or with `npm run create-admin` on the machine itself.
if (!auth.hasUsers() && process.env.BOOTSTRAP_ADMIN_PHONE && process.env.BOOTSTRAP_ADMIN_PIN) {
  auth.createUser({
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Admin', phone: process.env.BOOTSTRAP_ADMIN_PHONE,
    role: 'admin', pin: process.env.BOOTSTRAP_ADMIN_PIN,
  }).then(({ user }) => console.log(`Created the first admin (${user.phone}). They must choose a new PIN when they sign in.`))
    .catch((err) => console.error(`Could not create the first admin: ${err.message}`));
}

const STAFF = ['admin', 'marshal'];
const COOKIE = 'bta_session';

// Who may use the staff screens in a web browser. The Android app always can.
//   on     every staff role (the default: local preview and tests)
//   admin  admins only, so the office works on a computer; marshals and drivers use the app
//   off    nobody: every staff member uses the app
// A value that is set but not one of these stops the server, rather than guessing.
const WEB_STAFF = process.env.WEB_STAFF ?? 'on';
if (!['on', 'admin', 'off'].includes(WEB_STAFF)) throw new Error(`WEB_STAFF must be on, admin or off, not "${WEB_STAFF}"`);
const WEB_ROLES = { on: ['admin', 'marshal', 'driver'], admin: ['admin'], off: [] }[WEB_STAFF];
const onWeb = (role) => WEB_ROLES.includes(role);

// The staff pages and their entry scripts, with the roles that use them. One no web role uses
// is not served to browsers at all, so its code is not handed to every visitor.
const STAFF_FILES = {
  'staff.html': ['admin'], 'js/home.js': ['admin'],
  'dashboard.html': ['admin'], 'js/dashboard.js': ['admin'],
  'editor.html': ['admin'], 'js/editor.js': ['admin'],
  'users.html': ['admin'], 'js/users.js': ['admin'],
  'fares.html': ['admin'], 'js/fares-admin.js': ['admin'],
  'marshal.html': ['admin', 'marshal'], 'js/marshal.js': ['admin', 'marshal'],
  'rank.html': ['admin', 'marshal'], 'js/rank.js': ['admin', 'marshal'],
  'driver.html': ['driver'], 'js/driver.js': ['driver'],
};
/** True when `rel` (a path inside public/) is a staff file that no web role uses. */
function hiddenOnWeb(rel) {
  // compared lower-case, without trailing dots or spaces, as some file systems ignore both
  const key = rel.replace(/^\/+/, '').toLowerCase().replace(/[. ]+$/, '');
  const roles = STAFF_FILES[key];
  return !!roles && !roles.some(onWeb);
}

// ------------------------------------------------------------------ live updates (SSE)

const clients = new Set();
// One script must not be able to hold every connection the server has. Phones on the same
// mobile network often share one public IP, so the per-IP cap is generous.
const MAX_STREAMS = 2000;
const MAX_STREAMS_PER_IP = 40;
const streamsByIp = new Map();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let pending = null;
store.on('change', () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    if (!clients.size) return;
    const full = [...clients].some((c) => c.user) ? store.snapshot() : null;
    const pub = store.publicSnapshot();
    for (const c of clients) send(c.res, 'snapshot', c.user ? full : pub);
  }, 150);
});

setInterval(() => {
  const wanting = [...clients].filter((c) => c.pos);
  if (!wanting.length) return;
  const pub = positions.getPositions();
  const staff = wanting.some((c) => c.user) ? positions.getPositions({ staff: true }) : null;
  for (const c of wanting) send(c.res, 'pos', c.user ? staff : pub); // estimates go to staff only
}, 1000).unref();

setInterval(() => {
  for (const c of clients) c.res.write(': keep-alive\n\n');
}, 20_000).unref();

// A staff stream ends when its session does: signed out, PIN reset, account switched off.
function closeDeadStreams() {
  for (const c of clients) {
    if (c.user && !auth.sessionAlive(c.user.sessionId)) {
      clients.delete(c);
      c.res.end();
    }
  }
}
setInterval(closeDeadStreams, 30_000).unref();

function stream(req, res, url) {
  const ip = clientIp(req);
  const mine = streamsByIp.get(ip) ?? 0;
  if (clients.size >= MAX_STREAMS || mine >= MAX_STREAMS_PER_IP) throw new HttpError(429, 'Too many live connections. Try again in a minute.');
  let user = null;
  if (url.searchParams.get('staff') === '1') {
    const ticket = url.searchParams.get('ticket');
    user = ticket ? auth.redeemTicket(ticket) : cookieUser(cookies(req)[COOKIE]);
    if (!user) throw new HttpError(401, 'Sign in to see the staff view.');
    if (user.mustChangePin || !STAFF.includes(user.role)) throw new HttpError(403, 'Your account cannot see the staff view.');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, pos: url.searchParams.get('pos') === '1', user };
  clients.add(client);
  streamsByIp.set(ip, mine + 1);
  send(res, 'snapshot', user ? store.snapshot() : store.publicSnapshot());
  if (client.pos) send(res, 'pos', positions.getPositions({ staff: !!user }));
  req.on('close', () => {
    clients.delete(client);
    const left = (streamsByIp.get(ip) ?? 1) - 1;
    if (left > 0) streamsByIp.set(ip, left);
    else streamsByIp.delete(ip);
  });
}

// A plain per-IP cap on API requests per minute, well above what a busy marshal or a driver
// sending every 10 seconds needs, so a script cannot keep the server busy on its own.
const API_PER_MINUTE = 600;
const apiHits = new Map();
function limitApi(req) {
  const t = Date.now();
  const ip = clientIp(req);
  let e = apiHits.get(ip);
  if (!e || e.resetAt <= t) {
    e = { n: 0, resetAt: t + 60_000 };
    apiHits.set(ip, e);
  }
  if (++e.n > API_PER_MINUTE) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of apiHits) if (v.resetAt <= t) apiHits.delete(k);
}, 60_000).unref();

// ------------------------------------------------------------------ request helpers

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('application/json')) return Promise.reject(new HttpError(415, 'Send the request as JSON.'));
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'Request body must be a JSON object.'));
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* a malformed cookie is ignored, never an error */
    }
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length >= TRUST_PROXY_HOPS) return hops[hops.length - TRUST_PROXY_HOPS];
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY_HOPS > 0 && req.headers['x-forwarded-proto'] === 'https');

function sessionCookie(req, token, maxAgeSec) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, ...(isHttps(req) ? ['Secure'] : [])].join('; ');
}

/**
 * The signed-in user, from the app's Bearer token or the website's cookie. A cookie only
 * counts on a change (POST/PUT/DELETE) when the request comes from this site, so another
 * site cannot make a signed-in browser act (CSRF).
 */
function signedIn(req) {
  const header = String(req.headers.authorization ?? '');
  if (header.startsWith('Bearer ')) return auth.authenticate(header.slice(7).trim());
  const token = cookies(req)[COOKIE];
  if (!token || !WEB_ROLES.length) return null; // with staff off on the website, cookies mean nothing
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let host = null;
    try {
      host = new URL(req.headers.origin).host;
    } catch {
      /* missing or "null" origin */
    }
    if (!host || host !== req.headers.host) throw new HttpError(403, 'This request did not come from the tracker.');
  }
  return cookieUser(token);
}

/** The user of a website session cookie, if their role may use the website. */
function cookieUser(token) {
  const user = auth.authenticate(token);
  return user && onWeb(user.role) ? user : null;
}

/** Throws unless someone with one of `roles` is signed in (and has set their own PIN). */
function need(req, roles) {
  const user = signedIn(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (user.mustChangePin) throw new HttpError(403, 'Choose your own PIN first.');
  if (!roles.includes(user.role)) throw new HttpError(403, 'Your account is not allowed to do that.');
  return user;
}

/** Marshals work their own rank only; admins can act anywhere. */
function needRank(user, rankId) {
  if (user.role === 'admin') return;
  if (rankId == null || rankId !== user.rankId) throw new HttpError(403, 'You can only record taxis at your own rank.');
}

// ------------------------------------------------------------------ API

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  let match;

  // public
  if (m === 'GET' && p === '/api/stream') return stream(req, res, url);
  if (m === 'GET' && p === '/api/snapshot') return json(res, 200, store.publicSnapshot());
  if (m === 'GET' && p === '/api/positions') return json(res, 200, positions.getPositions());
  // the sideload build of the app asks this once per start, to offer an update
  if (m === 'GET' && p === '/api/app-version') return json(res, 200, appVersion());

  // signing in and out
  if (m === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    // With staff limited on the website, "the app" must also come from the app's own origin.
    const app = body.client === 'app' && (WEB_STAFF === 'on' || APP_ORIGINS.has(req.headers.origin));
    // Refused before the PIN is checked, so it is not a try and cannot be used to lock anyone out.
    if (!app && WEB_STAFF === 'off') throw new HttpError(403, 'Staff sign in on the Dankie Driver app.');
    const r = await auth.login(body, { ip: clientIp(req), client: app ? 'app' : 'web' });
    // The website gets an HttpOnly cookie that scripts cannot read; the app keeps the token.
    if (app) return json(res, 200, { user: r.user, token: r.token, expiresAt: r.expiresAt });
    if (!onWeb(r.user.role)) {
      // The PIN was right but this role works in the app. Saying so tells nothing the app's own
      // sign-in would not, and it has the same limits. The session is ended at once.
      auth.logout(auth.authenticate(r.token));
      throw new HttpError(403, 'Drivers and marshals sign in on the Dankie Driver app.');
    }
    return json(res, 200, { user: r.user, expiresAt: r.expiresAt }, { 'Set-Cookie': sessionCookie(req, r.token, Math.floor((r.expiresAt - Date.now()) / 1000)) });
  }
  if (m === 'POST' && p === '/api/logout') {
    const user = signedIn(req);
    if (user) auth.logout(user);
    closeDeadStreams();
    return json(res, 200, { message: 'Signed out' }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  // The public screens ask whether someone is signed in on this device. Not being signed in is
  // the normal answer there, so it is a 200 with user: null rather than a 401 error.
  if (m === 'GET' && p === '/api/session') {
    const user = signedIn(req);
    if (!user) return json(res, 200, { user: null, staffWeb: WEB_STAFF });
    const { sessionId, ...me } = user;
    return json(res, 200, { user: me, staffWeb: WEB_STAFF });
  }
  if (m === 'GET' && p === '/api/me') {
    const user = signedIn(req);
    if (!user) throw new HttpError(401, 'Please sign in.');
    const { sessionId, ...me } = user;
    return json(res, 200, me);
  }
  if (m === 'POST' && p === '/api/me/pin') {
    const user = signedIn(req);
    if (!user) throw new HttpError(401, 'Please sign in.');
    const body = await readBody(req);
    const r = await auth.changePin(user, body.oldPin, body.newPin);
    closeDeadStreams();
    return json(res, 200, r);
  }
  if (m === 'POST' && p === '/api/stream-ticket') return json(res, 200, auth.streamTicket(need(req, STAFF)));

  // drivers: their taxi, the location notice, and GPS points
  if (m === 'GET' && p === '/api/driver') {
    const user = need(req, ['driver']);
    const taxi = user.taxiId ? db.prepare('SELECT id, plate, status FROM taxis WHERE id = ?').get(user.taxiId) : null;
    return json(res, 200, {
      name: user.name, taxi: taxi ?? null, consentVersion: CONSENT_VERSION,
      consented: user.locationConsentVersion === CONSENT_VERSION, consentedAt: user.locationConsentAt,
    });
  }
  if (m === 'POST' && p === '/api/driver/consent') {
    const user = need(req, ['driver']);
    return json(res, 200, auth.giveConsent(user, (await readBody(req)).version));
  }
  if (m === 'DELETE' && p === '/api/driver/consent') {
    const user = need(req, ['driver']);
    const r = auth.withdrawConsent(user);
    positions.forget(user.taxiId);
    return json(res, 200, r);
  }
  if (m === 'POST' && p === '/api/driver/position') {
    const user = need(req, ['driver']);
    return json(res, 200, positions.record(user, await readBody(req)));
  }
  if (m === 'DELETE' && p === '/api/driver/position') {
    const user = need(req, ['driver']);
    positions.forget(user.taxiId); // the driver pressed Stop: their taxi's point goes now
    return json(res, 200, { message: 'Sharing stopped.' });
  }

  // rank work: marshals at their own rank, admins anywhere
  if (m === 'POST' && p === '/api/action') {
    const user = need(req, STAFF);
    const body = await readBody(req);
    needRank(user, store.rankForAction(body));
    return json(res, 200, store.act({ ...body, by: user.name })); // who did it comes from the session, not the phone
  }
  if (m === 'POST' && p === '/api/taxis') {
    const user = need(req, STAFF);
    const body = await readBody(req);
    const homeRankId = user.role === 'marshal' ? user.rankId : body.homeRankId;
    return json(res, 201, store.createTaxi({ ...body, homeRankId, by: user.name }));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/taxis\/(\d+)\/history$/))) {
    need(req, STAFF);
    return json(res, 200, store.taxiHistory(match[1]));
  }

  // ranks and routes: admins
  if (m === 'POST' && p === '/api/ranks') {
    need(req, ['admin']);
    return json(res, 201, store.createRank(await readBody(req)));
  }
  if ((match = p.match(/^\/api\/ranks\/(\d+)$/)) && (m === 'PUT' || m === 'DELETE')) {
    need(req, ['admin']);
    if (m === 'PUT') return json(res, 200, store.updateRank(match[1], await readBody(req)));
    return json(res, 200, store.deleteRank(match[1]));
  }
  if (m === 'POST' && p === '/api/routes') {
    need(req, ['admin']);
    return json(res, 201, store.createRoute(await readBody(req)));
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/routes\/(\d+)$/))) {
    need(req, ['admin']);
    return json(res, 200, store.deleteRoute(match[1]));
  }
  if ((match = p.match(/^\/api\/routes\/(\d+)\/fare$/)) && (m === 'PUT' || m === 'DELETE')) {
    const user = need(req, ['admin']);
    if (m === 'PUT') return json(res, 200, store.setFare(match[1], await readBody(req), user.name));
    return json(res, 200, store.deleteFare(match[1], user.name));
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/routes\/(\d+)\/fare-change$/))) {
    const user = need(req, ['admin']);
    return json(res, 200, store.cancelFareChange(match[1], user.name));
  }

  // requests: a marshal asks for a fare or the rank's spot at their own rank (the rank comes
  // from their session, never from the phone); only an admin's decision changes what
  // passengers see
  if (m === 'POST' && p === '/api/proposals/fare') {
    const user = need(req, ['marshal']);
    return json(res, 201, store.proposeFare(user, await readBody(req)));
  }
  if (m === 'POST' && p === '/api/proposals/location') {
    const user = need(req, ['marshal']);
    return json(res, 201, store.proposeLocation(user, await readBody(req)));
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/proposals\/(\d+)$/))) {
    const user = need(req, ['marshal']);
    return json(res, 200, store.withdrawProposal(match[1], user));
  }
  if (m === 'POST' && (match = p.match(/^\/api\/proposals\/(\d+)\/decision$/))) {
    const user = need(req, ['admin']);
    return json(res, 200, store.decideProposal(match[1], user, await readBody(req)));
  }

  // holding area: the marshal at that rank, or an admin
  if (m === 'PUT' && (match = p.match(/^\/api\/ranks\/(\d+)\/holding$/))) {
    const user = need(req, STAFF);
    needRank(user, toId(match[1]));
    return json(res, 200, store.setHolding(match[1], (await readBody(req)).on, user.name));
  }

  // staff accounts: admins. A new or reset PIN is shown once, to the admin, and never stored in plain text.
  if (m === 'GET' && p === '/api/users') {
    need(req, ['admin']);
    return json(res, 200, auth.listUsers());
  }
  if (m === 'POST' && p === '/api/users') {
    const user = need(req, ['admin']);
    const { pin: _ignored, newTaxi, ...body } = await readBody(req);
    const plan = newTaxi != null && body.role === 'driver'
      ? { makeTaxi: () => store.createTaxi({ ...taxiFields(newTaxi), by: user.name }).id, tx: oneChange }
      : {};
    return json(res, 201, await auth.createUser(body, plan));
  }
  if (m === 'PUT' && (match = p.match(/^\/api\/users\/(\d+)$/))) {
    const user = need(req, ['admin']);
    const { newTaxi, ...input } = await readBody(req);
    const { leftTaxi, ...r } = newTaxi != null && input.role === 'driver'
      // the new taxi and the change to the driver are saved together, or not at all
      ? oneChange(() => auth.updateUser(user, match[1], { ...input, taxiId: store.createTaxi({ ...taxiFields(newTaxi), by: user.name }).id }))
      : auth.updateUser(user, match[1], input);
    if (leftTaxi != null) positions.forget(leftTaxi);
    closeDeadStreams();
    store.emitChange(); // marshal names on the staff screens
    return json(res, 200, r);
  }
  if (m === 'POST' && (match = p.match(/^\/api\/users\/(\d+)\/pin$/))) {
    need(req, ['admin']);
    const r = await auth.resetPin(match[1]);
    closeDeadStreams();
    return json(res, 200, r);
  }

  throw new HttpError(404, 'No such API endpoint.');
}

/** A new taxi typed in by an admin on the staff screen: only its plate and seats are taken. */
function taxiFields(t) {
  if (typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'Enter the number plate of the new taxi.');
  return { plate: t.plate, capacity: t.capacity };
}

/** Runs writes in one transaction; screens hear about it once, after it is saved or undone. */
const oneChange = (fn) => store.quietly(() => store.tx(fn));

// ------------------------------------------------------------------ static files

const PAGES = {
  '/': 'index.html', '/staff': 'staff.html', '/marshal': 'marshal.html', '/dashboard': 'dashboard.html',
  '/editor': 'editor.html', '/board': 'board.html', '/login': 'login.html', '/users': 'users.html', '/fares': 'fares.html', '/rank': 'rank.html',
  '/driver': 'driver.html', '/download': 'download.html', '/privacy': 'privacy.html',
};

// The staff app's latest version, edited by hand at each release (see docs/website-plan.md).
const VERSION_FILE = path.join(PUBLIC, 'download', 'version.json');
// The APK is only ever fetched from this project's GitHub releases, so the download link can
// never be turned into a redirect to somewhere else.
const APK_PREFIX = 'https://github.com/bandasihle/BTA-TAXIS/releases/download/';

function appVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    const apkUrl = typeof v.apkUrl === 'string' && v.apkUrl.startsWith(APK_PREFIX) && !v.apkUrl.includes('..') ? v.apkUrl : '';
    return { versionCode: Number(v.versionCode) || 0, versionName: String(v.versionName ?? ''), apkUrl };
  } catch {
    return { versionCode: 0, versionName: '', apkUrl: '' };
  }
}
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, base, rel) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(base + path.sep)) return false;
  if (base === PUBLIC && hiddenOnWeb(path.relative(PUBLIC, file).split(path.sep).join('/'))) return false;
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
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Bad address.');
  }
  if (p === '/download/dankie-driver.apk') {
    const { apkUrl } = appVersion();
    if (!apkUrl) throw new HttpError(404, 'The app is not available to download yet.');
    res.writeHead(302, { Location: apkUrl, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  if (PAGES[p] && serveFile(res, PUBLIC, PAGES[p])) return;
  if (p.startsWith('/vendor/leaflet/') && serveFile(res, LEAFLET, p.slice('/vendor/leaflet/'.length))) return;
  if (serveFile(res, PUBLIC, p)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Page not found');
}

// ------------------------------------------------------------------ server

// The Android app loads its pages from the phone (https://localhost) and calls this API.
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

function allowApp(req, res) {
  const origin = req.headers.origin;
  if (!APP_ORIGINS.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// The one inline script (the theme switch at the top of each staff page) is allowed by its hash.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-fMGC9cq7HoMARjUnLNzi6WaLxfVp0aITKZ2WWRoXCRY='",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // OpenStreetMap needs to know the site asking for tiles; never the path
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  securityHeaders(req, res);
  try {
    if (url.pathname.startsWith('/api/')) allowApp(req, res);
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      limitApi(req);
      await api(req, res, url);
    }
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
  if (!auth.hasUsers()) console.log('No staff accounts yet. Create the first admin with: npm run create-admin');
});

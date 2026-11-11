// Starts the real server on a throwaway database and tries what an attacker would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONSENT_VERSION } from '../public/js/consent.js';

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bta-api-'));
const ADMIN = { phone: '0821111111', pin: '482915' };
let server;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: path.join(DIR, 'test.db'), BOOTSTRAP_ADMIN_PHONE: ADMIN.phone, BOOTSTRAP_ADMIN_PIN: '719353', BOOTSTRAP_ADMIN_NAME: 'Boss' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15_000);
    const on = (d) => {
      log += d;
      if (log.includes('Created the first admin')) {
        clearTimeout(t);
        resolve();
      }
    };
    server.stdout.on('data', on);
    server.stderr.on('data', on);
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited; // Windows keeps the database file locked until the process is gone
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** fetch with JSON; `cookie` and `token` sign in, `origin` defaults to this site. */
async function call(method, p, { body, cookie, token, origin = BASE, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  if (token) h.Authorization = `Bearer ${token}`;
  if (origin) h.Origin = origin;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const cookieOf = (r) => r.headers.get('set-cookie')?.split(';')[0];

async function webLogin(phone, pin) {
  const r = await call('POST', '/api/login', { body: { phone, pin } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return cookieOf(r);
}

/** Reads the first snapshot from an SSE stream. */
async function firstSnapshot(p, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + p, { headers, signal: ctrl.signal });
  if (res.status !== 200) return { status: res.status };
  const reader = res.body.getReader();
  let buf = '';
  for (;;) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
    const m = buf.match(/event: snapshot\ndata: (.*)\n\n/);
    if (m) {
      ctrl.abort();
      return { status: 200, snap: JSON.parse(m[1]) };
    }
  }
}

let adminCookie;
let marshalCookie;
let ranks;

test('the first admin must choose a new PIN before doing anything', async () => {
  const cookie = await webLogin(ADMIN.phone, '719353');
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.mustChangePin, true);
  assert.equal((await call('GET', '/api/users', { cookie })).status, 403);
  assert.equal((await call('POST', '/api/me/pin', { cookie, body: { oldPin: '719353', newPin: ADMIN.pin } })).status, 200);
  assert.equal((await call('GET', '/api/users', { cookie })).status, 200);
  adminCookie = cookie;
  ranks = (await call('GET', '/api/snapshot')).data.ranks;
});

test('nothing that changes data works without signing in', async () => {
  const tries = [
    ['POST', '/api/action', { type: 'checkIn', taxiId: 1, rankId: 1, routeId: 1 }],
    ['POST', '/api/taxis', { plate: 'ZZ 99 ZZ GP' }],
    ['POST', '/api/ranks', { name: 'Fake', lat: -26.1, lng: 28.4 }],
    ['PUT', `/api/ranks/${ranks[0].id}`, { name: 'Hacked' }],
    ['DELETE', `/api/ranks/${ranks[0].id}`],
    ['POST', '/api/routes', { fromRankId: ranks[0].id, toRankId: ranks[1].id }],
    ['GET', '/api/users'],
    ['POST', '/api/users', { name: 'Evil', phone: '0829999999', role: 'admin' }],
    ['POST', '/api/users/1/pin'],
    ['GET', '/api/taxis/1/history'],
    ['POST', '/api/stream-ticket'],
  ];
  for (const [m, p, body] of tries) assert.equal((await call(m, p, { body })).status, 401, `${m} ${p}`);
  for (const p of ['/api/demo', '/api/reset']) assert.equal((await call('POST', p, { cookie: adminCookie, body: {} })).status, 404, p);
});

test('the public sign-in check answers quietly and never leaks the session id', async () => {
  const anon = await call('GET', '/api/session');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.data, { user: null });
  const forged = await call('GET', '/api/session', { cookie: 'bta_session=' + 'A'.repeat(43) });
  assert.deepEqual(forged.data, { user: null });
  const mine = await call('GET', '/api/session', { cookie: adminCookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.user.role, 'admin');
  assert.equal(mine.data.user.sessionId, undefined);
  assert.deepEqual(mine.data.user, (await call('GET', '/api/me', { cookie: adminCookie })).data);
  // the staff screens still rely on a 401 from /api/me
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('a forged or expired session is refused', async () => {
  assert.equal((await call('GET', '/api/users', { cookie: 'bta_session=' + 'A'.repeat(43) })).status, 401);
  assert.equal((await call('GET', '/api/users', { token: 'not-a-real-token-at-all-1234567890' })).status, 401);
});

test('a signed-in browser cannot be made to act by another site (CSRF)', async () => {
  const body = { name: 'Via CSRF', lat: -26.1, lng: 28.4 };
  assert.equal((await call('POST', '/api/ranks', { cookie: adminCookie, body, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/ranks', { cookie: adminCookie, body, origin: null })).status, 403);
  assert.equal((await call('POST', '/api/ranks', { cookie: adminCookie, body: undefined, origin: BASE, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const ok = await call('POST', '/api/ranks', { cookie: adminCookie, body });
  assert.equal(ok.status, 201);
  assert.equal((await call('DELETE', `/api/ranks/${ok.data.id}`, { cookie: adminCookie })).status, 200);
});

test('the website cookie is HttpOnly and SameSite; the app gets a token and no cookie', async () => {
  const web = await call('POST', '/api/login', { body: ADMIN });
  const set = web.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.equal(web.data.token, undefined, 'the website never sees the token');

  const app = await call('POST', '/api/login', { body: { ...ADMIN, client: 'app' }, origin: 'https://localhost' });
  assert.equal(app.headers.get('set-cookie'), null);
  assert.equal(app.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.ok(app.data.token);
  assert.equal((await call('GET', '/api/users', { token: app.data.token, origin: 'https://localhost' })).status, 200);
});

test('marshals work only their own rank, and cannot touch ranks, routes or staff', async () => {
  const etwatwa = ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const daveyton = ranks.find((r) => r.name === 'Daveyton');
  const created = await call('POST', '/api/users', { cookie: adminCookie, body: { name: 'Marshal Etwatwa', phone: '0822222222', role: 'marshal', rankId: etwatwa.id, pin: '000000' } });
  assert.equal(created.status, 201);
  assert.notEqual(created.data.pin, '000000', 'admins cannot pick a PIN for someone else');
  const temp = created.data.pin;
  const first = await webLogin('0822222222', temp);
  await call('POST', '/api/me/pin', { cookie: first, body: { oldPin: temp, newPin: '582047' } });
  const marshal = first;
  marshalCookie = first;

  // a taxi registered by the marshal is homed at the marshal's rank, whatever the phone says
  const taxi = await call('POST', '/api/taxis', { cookie: marshal, body: { plate: 'MA 12 RS GP', homeRankId: daveyton.id } });
  assert.equal(taxi.status, 201);
  const snap = (await call('GET', '/api/snapshot')).data;
  const routeOut = snap.routes.find((r) => r.fromRankId === etwatwa.id && r.toRankId === daveyton.id);
  const routeBack = snap.routes.find((r) => r.fromRankId === daveyton.id && r.toRankId === etwatwa.id);

  assert.equal((await call('POST', '/api/action', { cookie: marshal, body: { type: 'checkIn', taxiId: taxi.data.id, rankId: daveyton.id, routeId: routeBack.id } })).status, 403, 'not at another rank');
  const ok = await call('POST', '/api/action', { cookie: marshal, body: { type: 'checkIn', taxiId: taxi.data.id, rankId: etwatwa.id, routeId: routeOut.id, by: 'Someone Else' } });
  assert.equal(ok.status, 200);

  for (const [m, p, body] of [
    ['POST', '/api/ranks', { name: 'X', lat: -26.1, lng: 28.4 }],
    ['DELETE', `/api/ranks/${daveyton.id}`],
    ['GET', '/api/users'],
    ['POST', '/api/users', { name: 'Evil', phone: '0829999998', role: 'admin' }],
  ]) assert.equal((await call(m, p, { cookie: marshal, body })).status, 403, `${m} ${p}`);

  const history = await call('GET', `/api/taxis/${taxi.data.id}/history`, { cookie: marshal });
  assert.ok(history.data.events.every((e) => e.by === 'Marshal Etwatwa'), 'who did it comes from the session, not the request');
});

test('marshals ask for fares and the spot of their rank; only an admin decides', async () => {
  const etwatwa = ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const daveyton = ranks.find((r) => r.name === 'Daveyton');
  const fare = { toRankId: daveyton.id, from: '04:00', until: '24:00', price: 25 };
  const spot = { lat: etwatwa.lat + 0.001, lng: etwatwa.lng, accuracy: 9 };

  // signed out, and from another site
  for (const [m, p, body] of [
    ['POST', '/api/proposals/fare', fare],
    ['POST', '/api/proposals/location', spot],
    ['POST', '/api/proposals/1/decision', { approve: true }],
    ['DELETE', '/api/proposals/1'],
    ['PUT', `/api/ranks/${etwatwa.id}/holding`, { on: true }],
    ['DELETE', '/api/routes/1/fare-change'],
  ]) assert.equal((await call(m, p, { body })).status, 401, `${m} ${p}`);
  assert.equal((await call('POST', '/api/proposals/fare', { cookie: marshalCookie, body: fare, origin: 'https://evil.example' })).status, 403, 'CSRF');

  // an admin sets fares directly and has no rank to ask for
  assert.equal((await call('POST', '/api/proposals/fare', { cookie: adminCookie, body: fare })).status, 403);
  assert.equal((await call('POST', '/api/proposals/location', { cookie: adminCookie, body: spot })).status, 403);

  const sent = await call('POST', '/api/proposals/fare', { cookie: marshalCookie, body: { ...fare, rankId: daveyton.id, by: 'Someone Else', status: 'APPROVED' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal((await call('POST', '/api/proposals/location', { cookie: marshalCookie, body: { ...spot, accuracy: 400 } })).status, 400);
  assert.equal((await call('POST', '/api/proposals/location', { cookie: marshalCookie, body: spot })).status, 201);

  const staff = (await firstSnapshot('/api/stream?staff=1', { Cookie: adminCookie })).snap;
  const open = staff.proposals.filter((p) => p.status === 'PENDING');
  assert.equal(open.length, 2);
  assert.ok(open.every((p) => p.rankId === etwatwa.id && p.by === 'Marshal Etwatwa'), 'the rank and the name come from the session');
  const pub = (await call('GET', '/api/snapshot')).data;
  assert.deepEqual(pub.proposals, [], 'passengers never see requests');
  const route = pub.routes.find((r) => r.fromRankId === etwatwa.id && r.toRankId === daveyton.id);
  assert.equal(pub.fares.find((f) => f.routeId === route.id).price, 20, 'the fare has not changed');
  assert.equal(pub.ranks.find((r) => r.id === etwatwa.id).lat, etwatwa.lat, 'the pin has not moved');

  // a marshal cannot approve, not even their own
  for (const p of open) assert.equal((await call('POST', `/api/proposals/${p.id}/decision`, { cookie: marshalCookie, body: { approve: true } })).status, 403);
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { cookie: marshalCookie, body: fare })).status, 403);
  assert.equal((await call('DELETE', `/api/routes/${route.id}/fare-change`, { cookie: marshalCookie })).status, 403);

  const fareAsk = open.find((p) => p.kind === 'FARE');
  const spotAsk = open.find((p) => p.kind === 'LOCATION');
  assert.equal((await call('POST', `/api/proposals/${fareAsk.id}/decision`, { cookie: adminCookie, body: { approve: false, reason: 'x'.repeat(201) } })).status, 400);
  assert.equal((await call('POST', `/api/proposals/${fareAsk.id}/decision`, { cookie: adminCookie, body: { approve: false, reason: 'Not agreed' } })).status, 200);
  assert.equal((await call('POST', `/api/proposals/${fareAsk.id}/decision`, { cookie: adminCookie, body: { approve: true } })).status, 409, 'decided once');
  assert.equal((await call('DELETE', `/api/proposals/${spotAsk.id}`, { cookie: marshalCookie })).status, 200);
  assert.equal((await call('POST', `/api/proposals/${spotAsk.id}/decision`, { cookie: adminCookie, body: { approve: true } })).status, 409, 'taken back');
  assert.equal((await call('GET', '/api/snapshot')).data.ranks.find((r) => r.id === etwatwa.id).lat, etwatwa.lat);
});

test('holding area: the marshal at that rank or an admin; passengers and drivers see it', async () => {
  const etwatwa = ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const daveyton = ranks.find((r) => r.name === 'Daveyton');
  const holding = async (id) => (await call('GET', '/api/snapshot')).data.ranks.find((r) => r.id === id).holding;
  assert.equal((await call('PUT', `/api/ranks/${daveyton.id}/holding`, { cookie: marshalCookie, body: { on: true } })).status, 403, 'not another rank');
  assert.equal(await holding(daveyton.id), false);
  assert.equal((await call('PUT', `/api/ranks/${etwatwa.id}/holding`, { cookie: marshalCookie, body: { on: 'true' } })).status, 400);
  assert.equal((await call('PUT', `/api/ranks/${etwatwa.id}/holding`, { cookie: marshalCookie, body: { on: true } })).status, 200);
  assert.equal(await holding(etwatwa.id), true);
  assert.equal((await call('PUT', `/api/ranks/${etwatwa.id}/holding`, { cookie: adminCookie, body: { on: false } })).status, 200);
  assert.equal(await holding(etwatwa.id), false);
});

test('passengers get the public stream; the staff stream needs a staff sign-in', async () => {
  const pub = await firstSnapshot('/api/stream');
  assert.equal(pub.status, 200);
  assert.ok(!JSON.stringify(pub.snap).includes('Marshal Etwatwa'));
  assert.deepEqual(pub.snap.marshals, []);

  assert.equal((await firstSnapshot('/api/stream?staff=1')).status, 401);
  assert.equal((await firstSnapshot('/api/stream?staff=1&ticket=made-up')).status, 401);
  const staff = await firstSnapshot('/api/stream?staff=1', { Cookie: adminCookie });
  assert.equal(staff.status, 200);
  assert.ok(staff.snap.marshals.some((m) => m.name === 'Marshal Etwatwa'));

  const { data } = await call('POST', '/api/stream-ticket', { cookie: adminCookie });
  assert.equal((await firstSnapshot(`/api/stream?staff=1&ticket=${data.ticket}`)).status, 200);
  assert.equal((await firstSnapshot(`/api/stream?staff=1&ticket=${data.ticket}`)).status, 401, 'a ticket works once');
});

test('only admins change fares; passengers see the result straight away', async () => {
  const snap = (await call('GET', '/api/snapshot')).data;
  const etwatwa = snap.ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const route = snap.routes.find((r) => r.fromRankId === etwatwa.id && snap.fares.some((f) => f.routeId === r.id));
  const body = { from: '05:00', until: '21:00', price: 27.5 };
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { body })).status, 401);
  const marshal = await webLogin('0822222222', '582047');
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { cookie: marshal, body })).status, 403);
  assert.equal((await call('DELETE', `/api/routes/${route.id}/fare`, { cookie: marshal })).status, 403);
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { cookie: adminCookie, body, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { cookie: adminCookie, body: { ...body, price: -1 } })).status, 400);
  assert.equal((await call('PUT', `/api/routes/${route.id}/fare`, { cookie: adminCookie, body })).status, 200);
  const fare = (await call('GET', '/api/snapshot')).data.fares.find((f) => f.routeId === route.id);
  assert.deepEqual(fare, { routeId: route.id, ...body });
  const pub = await firstSnapshot('/api/stream');
  assert.ok(pub.snap.fares.every((f) => !('updatedBy' in f)), 'passengers do not see who set a fare');
});

test('pages carry security headers', async () => {
  const res = await fetch(`${BASE}/staff.html`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'map tiles need the site name, not the page path');
});

test('signing out ends the session', async () => {
  const cookie = await webLogin(ADMIN.phone, ADMIN.pin);
  assert.equal((await call('POST', '/api/logout', { cookie, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/users', { cookie })).status, 401);
});

test('driver GPS: drivers only, their own taxi only, consent first; passengers see a dot only on a trip', async () => {
  const snap = (await call('GET', '/api/snapshot')).data;
  const taxi = snap.taxis.find((t) => t.plate === 'MA 12 RS GP');
  const etwatwa = snap.ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const created = await call('POST', '/api/users', { cookie: adminCookie, body: { name: 'Driver Sipho', phone: '0833333333', role: 'driver', taxiId: taxi.id } });
  assert.equal(created.status, 201);
  const login = await call('POST', '/api/login', { body: { phone: '0833333333', pin: created.data.pin, client: 'app' } });
  const token = login.data.token;
  assert.equal((await call('GET', '/api/driver', { token })).status, 403, 'must choose a PIN first');
  await call('POST', '/api/me/pin', { token, body: { oldPin: created.data.pin, newPin: '603918' } });

  const marshal = await webLogin('0822222222', '582047');
  for (const cookie of [marshal, adminCookie]) {
    assert.equal((await call('GET', '/api/driver', { cookie })).status, 403);
    assert.equal((await call('POST', '/api/driver/consent', { cookie, body: { version: CONSENT_VERSION } })).status, 403);
    assert.equal((await call('POST', '/api/driver/position', { cookie, body: { lat: etwatwa.lat, lng: etwatwa.lng, accuracy: 10, at: Date.now() } })).status, 403);
  }
  assert.equal((await call('POST', '/api/action', { token, body: { type: 'offDuty', taxiId: taxi.id } })).status, 403, 'drivers do not run the rank');

  const me = await call('GET', '/api/driver', { token });
  assert.deepEqual(me.data.taxi, { id: taxi.id, plate: 'MA 12 RS GP', status: 'QUEUED' });
  assert.equal(me.data.consented, false);
  const point = () => ({ lat: etwatwa.lat + 0.00123456, lng: etwatwa.lng, accuracy: 12, at: Date.now(), taxiId: 999999 });
  assert.equal((await call('POST', '/api/driver/position', { token, body: point() })).status, 403, 'nothing before consent');
  assert.equal((await call('POST', '/api/driver/consent', { token, body: { version: 'old' } })).status, 409);
  assert.equal((await call('POST', '/api/driver/consent', { token, body: { version: CONSENT_VERSION } })).status, 200);

  const atRank = await call('POST', '/api/driver/position', { token, body: point() });
  assert.equal(atRank.data.stored, false, 'not used while the taxi waits at the rank');

  await call('POST', '/api/action', { cookie: adminCookie, body: { type: 'seat', taxiId: taxi.id, delta: 1 } });
  assert.equal((await call('POST', '/api/action', { cookie: adminCookie, body: { type: 'depart', taxiId: taxi.id } })).status, 200);
  await new Promise((r) => setTimeout(r, 3_100)); // one point every 3 seconds
  const sent = await call('POST', '/api/driver/position', { token, body: point() });
  assert.equal(sent.data.stored, true, JSON.stringify(sent.data));
  const dots = (await call('GET', '/api/positions')).data.filter((p) => p.gps);
  assert.deepEqual(dots.map((p) => p.id), [taxi.id], "the point went to the driver's own taxi, not the one in the request");
  assert.equal(dots[0].lat, +(etwatwa.lat + 0.00123456).toFixed(4));

  // pressing Stop deletes the point; only the driver can do that, and only for their own taxi
  assert.equal((await call('DELETE', '/api/driver/position', { cookie: marshal })).status, 403);
  assert.equal((await call('DELETE', '/api/driver/position', { cookie: adminCookie })).status, 403);
  assert.ok((await call('GET', '/api/positions')).data.some((p) => p.gps), 'still there after the refused requests');
  assert.equal((await call('DELETE', '/api/driver/position', { token })).status, 200);
  assert.ok(!(await call('GET', '/api/positions')).data.some((p) => p.gps), 'Stop deletes the point');
  await new Promise((r) => setTimeout(r, 3_100));
  assert.equal((await call('POST', '/api/driver/position', { token, body: point() })).data.stored, true, 'sharing can start again');
  assert.ok(!JSON.stringify(dots).includes('Sipho') && !('accuracy' in dots[0]));

  assert.equal((await call('DELETE', '/api/driver/consent', { token })).status, 200);
  assert.ok(!(await call('GET', '/api/positions')).data.some((p) => p.gps), 'withdrawing deletes the point');
  assert.equal((await call('POST', '/api/driver/position', { token, body: point() })).status, 403);
});

test('malformed addresses and cookies are refused politely, never a server error', async () => {
  assert.equal((await fetch(`${BASE}/%E0%A4%A.html`)).status, 400);
  const r = await call('GET', '/api/me', { headers: { Cookie: 'bta_session=%E0%A4%A' } });
  assert.equal(r.status, 401);
});

test('the API answers the app (https://localhost) cross-origin, not plain http://localhost', async () => {
  const app = await fetch(`${BASE}/api/snapshot`, { headers: { Origin: 'https://localhost' } });
  assert.equal(app.headers.get('access-control-allow-origin'), 'https://localhost');
  const plain = await fetch(`${BASE}/api/snapshot`, { headers: { Origin: 'http://localhost' } });
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
});

test('free-text fields have a length limit', async () => {
  const cookie = await webLogin(ADMIN.phone, ADMIN.pin);
  const r = await call('POST', '/api/taxis', { cookie, body: { plate: 'LONG 1 GP', ownerName: 'x'.repeat(61) } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /owner name/);
});

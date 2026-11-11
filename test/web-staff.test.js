// The WEB_STAFF switch: which staff can use the website, and what the website refuses.
// Starts real servers in "admin" mode (the live site: the office on a computer, everyone else
// in the app) and in "off" mode (every staff member in the app).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMIN = { phone: '0821111111', temp: '719353', pin: '482915' };
const APP = 'https://localhost';
const servers = {};

async function start(mode) {
  const port = 5300 + Math.floor(Math.random() * 600);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bta-web-${mode}-`));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
    env: {
      ...process.env, PORT: String(port), DB_FILE: path.join(dir, 'test.db'), WEB_STAFF: mode,
      BOOTSTRAP_ADMIN_PHONE: ADMIN.phone, BOOTSTRAP_ADMIN_PIN: ADMIN.temp, BOOTSTRAP_ADMIN_NAME: 'Boss',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15_000);
    const on = (d) => {
      log += d;
      if (log.includes('Created the first admin')) { clearTimeout(t); resolve(); }
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
  });
  const base = `http://localhost:${port}`;
  async function call(method, p, { body, cookie, token, origin = base } = {}) {
    const h = {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    if (token) h.Authorization = `Bearer ${token}`;
    if (origin) h.Origin = origin;
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* a page */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { proc, dir, base, call };
}

before(async () => {
  servers.admin = await start('admin');
  servers.off = await start('off');
});

after(async () => {
  for (const s of Object.values(servers)) {
    if (s.proc.exitCode === null) {
      const exited = new Promise((r) => s.proc.once('exit', r));
      s.proc.kill();
      await exited;
    }
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const cookieOf = (r) => r.headers.get('set-cookie')?.split(';')[0];
const page = async (s, p) => (await fetch(s.base + p)).status;

test('a bad WEB_STAFF value stops the server instead of guessing', async () => {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
    env: { ...process.env, PORT: '0', DB_FILE: ':memory:', WEB_STAFF: 'Admin' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => proc.once('exit', r));
  assert.notEqual(code, 0);
  assert.match(err, /WEB_STAFF must be on, admin or off/);
});

test('admin mode: the office screens are on the website, the driver screen is not', async () => {
  const s = servers.admin;
  for (const p of ['/', '/login.html', '/board.html', '/dashboard', '/dashboard.html', '/editor.html', '/users.html', '/fares.html', '/staff.html', '/marshal.html', '/rank.html', '/js/dashboard.js']) {
    assert.equal(await page(s, p), 200, p);
  }
  for (const p of ['/driver.html', '/driver', '/js/driver.js', '/DRIVER.HTML', '/js/../driver.html', '/driver.html.']) {
    assert.equal(await page(s, p), 404, p);
  }
  assert.equal((await s.call('GET', '/api/session')).data.staffWeb, 'admin');
});

test('admin mode: an admin signs in on a computer; marshals are sent to the app', async () => {
  const s = servers.admin;
  const first = await s.call('POST', '/api/login', { body: { phone: ADMIN.phone, pin: ADMIN.temp } });
  assert.equal(first.status, 200);
  const cookie = cookieOf(first);
  assert.ok(cookie, 'the admin gets a website cookie');
  assert.equal((await s.call('POST', '/api/me/pin', { cookie, body: { oldPin: ADMIN.temp, newPin: ADMIN.pin } })).status, 200);
  assert.equal((await s.call('GET', '/api/users', { cookie })).status, 200);

  const rank = (await s.call('GET', '/api/snapshot')).data.ranks[0];
  const made = await s.call('POST', '/api/users', { cookie, body: { name: 'Marshal M', phone: '0822222222', role: 'marshal', rankId: rank.id } });
  assert.equal(made.status, 201);

  const web = await s.call('POST', '/api/login', { body: { phone: '0822222222', pin: made.data.pin } });
  assert.equal(web.status, 403);
  assert.match(web.data.error, /app/);
  assert.equal(web.headers.get('set-cookie'), null, 'no cookie for a marshal on the website');

  // "client: app" from the website's own origin is still the website
  const pretend = await s.call('POST', '/api/login', { body: { phone: '0822222222', pin: made.data.pin, client: 'app' } });
  assert.equal(pretend.status, 403);
  assert.equal(pretend.data.token, undefined);

  const app = await s.call('POST', '/api/login', { origin: APP, body: { phone: '0822222222', pin: made.data.pin, client: 'app' } });
  assert.equal(app.status, 200);
  assert.ok(app.data.token, 'the marshal signs in on the app');
});

test('off mode: no staff page is on the website', async () => {
  const s = servers.off;
  for (const p of ['/', '/login.html', '/board.html', '/js/board.js']) assert.equal(await page(s, p), 200, p);
  for (const p of ['/dashboard', '/dashboard.html', '/editor.html', '/users.html', '/fares.html', '/staff.html', '/marshal.html', '/rank.html', '/driver.html', '/js/users.js', '/js/marshal.js']) {
    assert.equal(await page(s, p), 404, p);
  }
  assert.equal((await s.call('GET', '/api/session')).data.staffWeb, 'off');
});

test('off mode: website sign-in is refused before the PIN is checked, so it locks nobody out', async () => {
  const s = servers.off;
  for (let i = 0; i < 7; i++) {
    const r = await s.call('POST', '/api/login', { body: { phone: ADMIN.phone, pin: '000001' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const app = await s.call('POST', '/api/login', { origin: APP, body: { phone: ADMIN.phone, pin: ADMIN.temp, client: 'app' } });
  assert.equal(app.status, 200, 'seven refused website tries did not lock the account');
  const token = app.data.token;
  assert.equal((await s.call('POST', '/api/me/pin', { token, origin: APP, body: { oldPin: ADMIN.temp, newPin: ADMIN.pin } })).status, 200);
  assert.equal((await s.call('GET', '/api/users', { token, origin: APP })).status, 200);

  // even a real session token means nothing when it arrives as a website cookie
  assert.equal((await s.call('GET', '/api/users', { cookie: `bta_session=${token}` })).status, 401);
  assert.equal((await s.call('GET', '/api/session', { cookie: `bta_session=${token}` })).data.user, null);
});

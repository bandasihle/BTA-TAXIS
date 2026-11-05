import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { seed } from '../server/seed.js';
import { createAuth, normalizePhone, pinProblem } from '../server/auth.js';

const FAST = { N: 1024, r: 8, p: 1 }; // cheap hashing so the tests run quickly

function setup() {
  let t = 1_800_000_000_000;
  const db = openDb(':memory:');
  seed(createStore(db, { now: () => t }));
  const auth = createAuth(db, { now: () => t, scrypt: FAST });
  return { db, auth, advance: (ms) => (t += ms) };
}

/** An admin who has already set their own PIN, signed in. */
async function admin(auth, phone = '0821111111', pin = '482915') {
  const { user, pin: temp } = await auth.createUser({ name: 'Admin', phone, role: 'admin' });
  const first = await auth.login({ phone, pin: temp });
  await auth.changePin(auth.authenticate(first.token), temp, pin);
  return { ...auth.authenticate(first.token), id: user.id };
}

test('phone numbers: SA cellphones in any common format, nothing else', () => {
  for (const p of ['082 123 4567', '0821234567', '+27821234567', '27 82 123 4567', '(082) 123-4567']) {
    assert.equal(normalizePhone(p), '+27821234567', p);
  }
  for (const p of ['012 345 6789', '082123456', '08212345678', '+44 7700 900123', '', null, 'abc', { toString: () => '0821234567x' }]) {
    assert.equal(normalizePhone(p), null, String(p));
  }
});

test('PINs: exactly 6 digits, not one digit repeated, not a straight run', () => {
  assert.equal(pinProblem('482915'), null);
  for (const p of ['12345', '1234567', 'abcdef', '12 345', '111111', '123456', '654321', '345678', 123456, null]) {
    assert.ok(pinProblem(p), String(p));
  }
});

test('PINs are stored hashed and salted, never in plain text', async () => {
  const { db, auth } = setup();
  const a = await auth.createUser({ name: 'A', phone: '0821111111', role: 'driver', pin: '482915' });
  const b = await auth.createUser({ name: 'B', phone: '0822222222', role: 'driver', pin: '482915' });
  const rows = db.prepare('SELECT pin_hash FROM users WHERE id IN (?, ?)').all(a.user.id, b.user.id);
  for (const r of rows) {
    assert.ok(!r.pin_hash.includes('482915'));
    assert.match(r.pin_hash, /^scrypt\$/);
  }
  assert.notEqual(rows[0].pin_hash, rows[1].pin_hash, 'same PIN, different salt');
});

test('a wrong phone and a wrong PIN give the same answer', async () => {
  const { auth } = setup();
  await admin(auth);
  const wrongPin = await auth.login({ phone: '0821111111', pin: '000001' }).catch((e) => e);
  const noSuchPhone = await auth.login({ phone: '0829999999', pin: '482915' }).catch((e) => e);
  const junk = await auth.login({ phone: { $ne: 1 }, pin: ['482915'] }).catch((e) => e);
  for (const e of [wrongPin, noSuchPhone, junk]) {
    assert.equal(e.status, 401);
    assert.equal(e.message, wrongPin.message);
  }
});

test('5 wrong PINs lock the account for 15 minutes, even with the right PIN', async () => {
  const { auth, advance } = setup();
  await admin(auth);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login({ phone: '0821111111', pin: '000001' }, { ip: `10.0.0.${i}` }), { status: 401 });
  await assert.rejects(auth.login({ phone: '0821111111', pin: '482915' }, { ip: '10.0.1.1' }), { status: 429 });
  advance(15 * 60_000 + 1);
  const ok = await auth.login({ phone: '0821111111', pin: '482915' }, { ip: '10.0.1.1' });
  assert.ok(ok.token);
});

test('one device gets 20 sign-in tries per 15 minutes, across all accounts', async () => {
  const { auth, advance } = setup();
  for (let i = 0; i < 20; i++) await assert.rejects(auth.login({ phone: `08200000${String(i).padStart(2, '0')}`, pin: '482915' }, { ip: '1.2.3.4' }), { status: 401 });
  await assert.rejects(auth.login({ phone: '0821111111', pin: '482915' }, { ip: '1.2.3.4' }), { status: 429 });
  await assert.rejects(auth.login({ phone: '0821111111', pin: '482915' }, { ip: '5.6.7.8' }), { status: 401 }, 'other devices are not blocked');
  advance(15 * 60_000 + 1);
  await assert.rejects(auth.login({ phone: '0821111111', pin: '482915' }, { ip: '1.2.3.4' }), { status: 401 });
});

test('sessions: only the token hash is stored; tokens expire and can be signed out', async () => {
  const { db, auth, advance } = setup();
  await admin(auth);
  const { token } = await auth.login({ phone: '0821111111', pin: '482915' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n, 0);
  const me = auth.authenticate(token);
  assert.equal(me.role, 'admin');
  assert.equal(auth.authenticate(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  auth.logout(me);
  assert.equal(auth.authenticate(token), null);

  const again = await auth.login({ phone: '0821111111', pin: '482915' });
  advance(7 * 24 * 60 * 60_000 + 1);
  assert.equal(auth.authenticate(again.token), null);
});

test('a new account must choose its own PIN; changing it signs out other devices', async () => {
  const { auth } = setup();
  const { pin } = await auth.createUser({ name: 'M', phone: '0823333333', role: 'driver' });
  const a = await auth.login({ phone: '0823333333', pin });
  const b = await auth.login({ phone: '0823333333', pin });
  const me = auth.authenticate(a.token);
  assert.equal(me.mustChangePin, true);
  await assert.rejects(auth.changePin(me, '000001', '482915'), /current PIN is wrong/);
  await assert.rejects(auth.changePin(me, pin, '123456'), /in a row/);
  await assert.rejects(auth.changePin(me, pin, pin), /different/);
  await auth.changePin(me, pin, '482915');
  assert.equal(auth.authenticate(a.token).mustChangePin, false);
  assert.equal(auth.authenticate(b.token), null, 'the other device is signed out');
});

test('switching an account off or resetting its PIN signs it out everywhere', async () => {
  const { auth } = setup();
  const boss = await admin(auth);
  const { user, pin } = await auth.createUser({ name: 'D', phone: '0824444444', role: 'driver' });
  const s = await auth.login({ phone: '0824444444', pin });
  auth.updateUser(boss, user.id, { active: false });
  assert.equal(auth.authenticate(s.token), null);
  await assert.rejects(auth.login({ phone: '0824444444', pin }), { status: 401 }, 'switched-off accounts cannot sign in');

  auth.updateUser(boss, user.id, { active: true });
  const s2 = await auth.login({ phone: '0824444444', pin });
  const { pin: fresh } = await auth.resetPin(user.id);
  assert.equal(auth.authenticate(s2.token), null);
  await assert.rejects(auth.login({ phone: '0824444444', pin }), { status: 401 });
  assert.ok((await auth.login({ phone: '0824444444', pin: fresh })).token);
});

test('the last admin cannot be removed, and admins cannot demote themselves', async () => {
  const { auth } = setup();
  const boss = await admin(auth);
  assert.throws(() => auth.updateUser(boss, boss.id, { role: 'driver' }), /only admin/);
  assert.throws(() => auth.updateUser(boss, boss.id, { active: false }), /only admin/);
  const { user: second } = await auth.createUser({ name: 'Second', phone: '0825555555', role: 'admin' });
  assert.throws(() => auth.updateUser(boss, boss.id, { role: 'driver' }), /your own admin/);
  auth.updateUser(boss, second.id, { role: 'driver' });
});

test('a marshal needs a real rank; account fields are validated', async () => {
  const { auth } = setup();
  await assert.rejects(auth.createUser({ name: 'M', phone: '0826666666', role: 'marshal' }), /rank/);
  await assert.rejects(auth.createUser({ name: 'M', phone: '0826666666', role: 'marshal', rankId: 99999 }), /rank/);
  await assert.rejects(auth.createUser({ name: 'M', phone: '0826666666', role: 'superuser' }), /role/);
  await assert.rejects(auth.createUser({ name: '', phone: '0826666666', role: 'driver' }), /name/);
  await assert.rejects(auth.createUser({ name: 'M', phone: '12345', role: 'driver' }), /cellphone/);
  await auth.createUser({ name: 'M', phone: '0826666666', role: 'driver' });
  await assert.rejects(auth.createUser({ name: 'N', phone: '+27826666666', role: 'driver' }), { status: 409 });
});

test('stream tickets work once, for 30 seconds, and die with the session', async () => {
  const { auth, advance } = setup();
  await admin(auth);
  const { token } = await auth.login({ phone: '0821111111', pin: '482915' });
  const me = auth.authenticate(token);
  const { ticket } = auth.streamTicket(me);
  assert.equal(auth.redeemTicket(ticket).id, me.id);
  assert.equal(auth.redeemTicket(ticket), null, 'used once');

  const late = auth.streamTicket(me).ticket;
  advance(30_001);
  assert.equal(auth.redeemTicket(late), null, 'expired');

  const orphan = auth.streamTicket(me).ticket;
  auth.logout(me);
  assert.equal(auth.redeemTicket(orphan), null, 'signed out');
});

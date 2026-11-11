// Driver GPS: what a phone may report, what is kept, and what passengers get to see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { seed } from '../server/seed.js';
import { PositionSource, FRESH_MS } from '../server/positions.js';
import { createAuth } from '../server/auth.js';
import { CONSENT_VERSION } from '../public/js/consent.js';

const FAST = { N: 1024, r: 8, p: 1 };

/** A seeded store with one taxi on its way from Etwatwa Las Vegas to Daveyton, and its driver. */
function onTrip() {
  let t = 1_800_000_000_000;
  const now = () => t;
  const db = openDb(':memory:');
  const store = createStore(db, { now });
  seed(store);
  const s = store.snapshot();
  const from = s.ranks.find((r) => r.name === 'Etwatwa Las Vegas');
  const to = s.ranks.find((r) => r.name === 'Daveyton');
  const route = s.routes.find((r) => r.fromRankId === from.id && r.toRankId === to.id);
  const { id } = store.createTaxi({ plate: 'GP 12 SG GP', homeRankId: from.id });
  store.act({ type: 'checkIn', taxiId: id, rankId: from.id, routeId: route.id });
  store.act({ type: 'seat', taxiId: id, delta: 1 });
  store.act({ type: 'depart', taxiId: id });
  const userId = db.prepare(
    `INSERT INTO users (name, phone, role, taxi_id, pin_hash, must_change_pin, created_at) VALUES ('Sipho', '+27831111111', 'driver', ?, 'x', 0, ?)`,
  ).run(id, t).lastInsertRowid;
  const driver = { id: Number(userId), name: 'Sipho', role: 'driver', taxiId: id, locationConsentVersion: CONSENT_VERSION };
  const source = new PositionSource(store);
  const fix = (at, extra = {}) => ({ lat: at.lat, lng: at.lng, accuracy: 20, at: t, ...extra });
  return { db, store, source, driver, taxiId: id, from, to, fix, now, advance: (ms) => (t += ms) };
}

const statusOf = (store, id) => store.snapshot().taxis.find((x) => x.id === id).status;
const gpsDot = (source, id) => source.getPositions().find((p) => p.id === id && p.gps);

test('nothing is taken without consent to the current notice, or from a driver with no taxi', () => {
  const { source, driver, from, fix } = onTrip();
  assert.throws(() => source.record({ ...driver, locationConsentVersion: null }, fix(from)), { status: 403 });
  assert.throws(() => source.record({ ...driver, locationConsentVersion: '2020-01-v0' }, fix(from)), { status: 403 }, 'an old notice is not enough');
  assert.throws(() => source.record({ ...driver, id: 8, taxiId: null }, fix(from)), { status: 409 });
});

test('a point is only for the driver\'s own taxi, whatever the phone sends', () => {
  const { source, driver, taxiId, from, fix, db } = onTrip();
  source.record(driver, fix(from, { taxiId: 999, taxi_id: 999 }));
  assert.deepEqual(db.prepare('SELECT taxi_id FROM positions').all().map((r) => r.taxi_id), [taxiId]);
});

test('impossible points are refused: outside SA, bad types, no accuracy', () => {
  const { source, driver, from, fix, advance } = onTrip();
  for (const bad of [
    { lat: 51.5, lng: -0.12 }, // London
    { lat: 0, lng: 0 },
    { lat: '-26.1', lng: '28.4' }, // strings
    { lat: [-26.1], lng: [28.4] },
    { lat: NaN, lng: 28.4 },
    { lat: from.lat, lng: from.lng, accuracy: -1 },
    { lat: from.lat, lng: from.lng, accuracy: undefined },
    { lat: from.lat, lng: from.lng, accuracy: 1e9 },
  ]) {
    advance(5_000); // past the rate limit, so each one is judged on its own
    assert.throws(() => source.record(driver, fix(from, bad)), { status: 400 }, JSON.stringify(bad));
  }
});

test('one point every 3 seconds per driver', () => {
  const { source, driver, from, fix, advance } = onTrip();
  assert.equal(source.record(driver, fix(from)).stored, true);
  advance(1_000);
  assert.throws(() => source.record(driver, fix(from)), { status: 429 });
  advance(3_000);
  assert.equal(source.record(driver, fix(from)).stored, true);
});

test('old points, and points while the taxi is at a rank, are not kept', () => {
  const { store, source, driver, taxiId, from, to, fix, advance, db } = onTrip();
  assert.equal(source.record(driver, fix(from, { at: 0 })).stored, false, 'queued on the phone for ages');
  advance(5_000);
  assert.equal(source.record(driver, fix(from, { at: Date.now() + 3_600_000 })).stored, false, 'from the future');

  store.act({ type: 'arrive', taxiId });
  advance(5_000);
  const r = source.record(driver, fix(to));
  assert.equal(r.stored, false);
  assert.match(r.message, /at a rank/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
});

test('a jump faster than a taxi can drive is ignored', () => {
  const { source, driver, taxiId, from, fix, advance } = onTrip();
  source.record(driver, fix(from));
  advance(5_000);
  const r = source.record(driver, fix({ lat: -33.92, lng: 18.42 })); // Cape Town five seconds later
  assert.equal(r.stored, false);
  assert.equal(gpsDot(source, taxiId).lat, +from.lat.toFixed(4), 'the last good point stays');
});

test('reaching the destination rank with a good fix records the arrival', () => {
  const { store, source, driver, taxiId, to, fix, advance, db } = onTrip();
  advance(20 * 60_000);
  assert.equal(source.record(driver, fix(to, { accuracy: 500 })).arrived, undefined, 'a rough fix is not trusted');
  assert.equal(statusOf(store, taxiId), 'EN_ROUTE');
  advance(5_000);
  const r = source.record(driver, fix({ lat: to.lat + 0.0005, lng: to.lng }, { accuracy: 15 })); // about 55 m away
  assert.equal(r.arrived, true);
  assert.equal(statusOf(store, taxiId), 'ARRIVED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0, 'the point is deleted on arrival');
  assert.ok(store.snapshot().events.some((e) => e.taxiId === taxiId && e.by === 'GPS (Sipho)'));
});

test('passengers see a rounded point, only while fresh; old points are deleted', () => {
  const { source, driver, taxiId, from, fix, advance, db } = onTrip();
  source.record(driver, fix({ lat: from.lat + 0.000123456, lng: from.lng - 0.000987654 }));
  const dot = gpsDot(source, taxiId);
  assert.equal(dot.lat, +(from.lat + 0.000123456).toFixed(4));
  assert.equal(dot.lng, +(from.lng - 0.000987654).toFixed(4));
  assert.ok(dot.etaMs > 0);
  assert.deepEqual(Object.keys(dot).sort(), ['etaMs', 'gps', 'id', 'lat', 'lng', 'routeId', 'status'], 'no accuracy, time or driver');

  advance(FRESH_MS + 1);
  assert.equal(gpsDot(source, taxiId), undefined, 'a stale point is not shown');
  source.sweep();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 1, 'kept a little longer in case the signal returns');
  advance(10 * 60_000);
  source.sweep();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
});

test('forget deletes the point straight away; off duty deletes it too', () => {
  const a = onTrip();
  a.source.record(a.driver, a.fix(a.from));
  a.source.forget(a.taxiId);
  assert.equal(gpsDot(a.source, a.taxiId), undefined);

  const b = onTrip();
  b.source.record(b.driver, b.fix(b.from));
  b.store.act({ type: 'arrive', taxiId: b.taxiId });
  b.store.act({ type: 'offDuty', taxiId: b.taxiId });
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
});

test('accounts: only drivers are linked to a taxi, and only to a registered one; consent is per notice', async () => {
  const { db, taxiId } = onTrip();
  const auth = createAuth(db, { now: () => 1_800_000_000_000, scrypt: FAST });
  const { user: driver } = await auth.createUser({ name: 'Sipho', phone: '0831234567', role: 'driver', taxiId });
  assert.equal(driver.taxiId, taxiId);
  const { user: marshal } = await auth.createUser({ name: 'M', phone: '0831234568', role: 'marshal', rankId: 1, taxiId });
  assert.equal(marshal.taxiId, null, 'marshals are not linked to a taxi');
  for (const bad of [999, '1; DROP TABLE taxis', 1.5, [taxiId], true, '1e0', ` ${taxiId}`, { id: taxiId }]) {
    await assert.rejects(auth.createUser({ name: 'X', phone: '0831234569', role: 'driver', taxiId: bad }), { status: 400 }, JSON.stringify(bad));
  }

  assert.throws(() => auth.giveConsent({ ...marshal, role: 'marshal' }, CONSENT_VERSION), { status: 403 });
  assert.throws(() => auth.giveConsent(driver, 'old'), { status: 409 });
  auth.giveConsent(driver, CONSENT_VERSION);
  assert.equal(auth.listUsers().find((u) => u.id === driver.id).locationConsentVersion, CONSENT_VERSION);
  auth.withdrawConsent(driver);
  assert.equal(auth.listUsers().find((u) => u.id === driver.id).locationConsentVersion, null);

  const admin = { id: -1 };
  const moved = auth.updateUser(admin, driver.id, { taxiId: null });
  assert.equal(moved.leftTaxi, taxiId, 'unlinking tells the server to drop the old taxi\'s point');
});

test('positions marked as coming from a fake-location app are not kept', () => {
  const { source, driver, taxiId, from, fix } = onTrip();
  const r = source.record(driver, fix(from, { simulated: true }));
  assert.equal(r.stored, false);
  assert.match(r.message, /fake location/);
  assert.equal(gpsDot(source, taxiId), undefined);
});

test('staff see a taxi with no GPS where it should be by now; passengers never get the guess', () => {
  const { store, source, taxiId, from, to, advance } = onTrip();
  const trip = store.snapshot().trips.find((x) => x.taxiId === taxiId);
  const staffDot = () => source.getPositions({ staff: true }).find((p) => p.id === taxiId);

  assert.equal(source.getPositions().find((p) => p.id === taxiId), undefined, 'the public list has no made-up position');
  const start = staffDot();
  assert.equal(start.estimated, true);
  assert.equal(start.gps, false);
  assert.equal(start.lastGpsAt, null);
  assert.equal(start.overdue, false);
  assert.ok(Math.abs(start.lat - from.lat) < 0.002 && Math.abs(start.lng - from.lng) < 0.002, 'starts at the rank it left');

  advance(trip.durationMs / 2);
  const mid = staffDot();
  assert.ok(Math.abs(mid.lat - from.lat) > 0.001 || Math.abs(mid.lng - from.lng) > 0.001, 'moves along the route');
  assert.equal(source.getPositions().find((p) => p.id === taxiId), undefined);

  advance(trip.durationMs / 2 + Math.max(trip.durationMs, 10 * 60_000));
  const late = staffDot();
  assert.equal(late.overdue, true);
  assert.ok(late.lateMs >= Math.max(trip.durationMs, 10 * 60_000));
  assert.ok(Math.abs(late.lat - to.lat) < 0.002 && Math.abs(late.lng - to.lng) < 0.002, 'waits at the destination once due');
});

test('a taxi whose GPS stops is estimated again, with when GPS was last heard', () => {
  const { source, driver, taxiId, from, fix, advance, now } = onTrip();
  advance(5_000);
  source.record(driver, fix(from));
  const heard = now();
  const live = source.getPositions({ staff: true }).find((p) => p.id === taxiId);
  assert.equal(live.gps, true);
  assert.equal(live.estimated, undefined);
  assert.equal(typeof live.lateMs, 'number');
  assert.equal(source.getPositions().find((p) => p.id === taxiId).lateMs, undefined, 'lateness is for staff');

  advance(FRESH_MS + 1_000);
  const lost = source.getPositions({ staff: true }).find((p) => p.id === taxiId);
  assert.equal(lost.estimated, true);
  assert.equal(lost.lastGpsAt, heard);
});

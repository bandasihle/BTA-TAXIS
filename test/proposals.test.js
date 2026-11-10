// Marshals ask, the office decides: fares with notice, the rank's spot, and the holding area.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createStore, saDate } from '../server/store.js';
import { seed } from '../server/seed.js';
import { buildDirectory, lookup } from '../public/js/fares.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 11, 8, 0); // 11 Nov 2026, 10:00 in South Africa

function fresh() {
  const clock = { t: T0 };
  const db = openDb(':memory:');
  const store = createStore(db, { now: () => clock.t });
  seed(store);
  const rank = (name) => store.snapshot().ranks.find((r) => r.name === name);
  const route = (a, b) => store.snapshot().routes.find((r) => r.fromRankId === rank(a).id && r.toRankId === rank(b).id);
  const fare = (a, b) => store.snapshot().fares.find((f) => f.routeId === route(a, b)?.id);
  const addUser = (name, role, rankId = null) => {
    const id = Number(db.prepare('INSERT INTO users (name, phone, role, rank_id, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, `08${Math.random().toString().slice(2, 10)}`, role, rankId, 'x', T0).lastInsertRowid);
    return { id, name, role, rankId };
  };
  const admin = addUser('Boss', 'admin');
  const sipho = addUser('Sipho', 'marshal', rank('Etwatwa Las Vegas').id);
  const thabo = addUser('Thabo', 'marshal', rank('Etwatwa Las Vegas').id);
  const lindiwe = addUser('Lindiwe', 'marshal', rank('Barcelona').id);
  const pending = () => store.snapshot().proposals.filter((p) => p.status === 'PENDING');
  return { store, clock, rank, route, fare, admin, sipho, thabo, lindiwe, pending };
}

const fails = (fn, status, re) => assert.throws(fn, (err) => err.status === status && (!re || re.test(err.message)), `expected ${status}`);

test('a marshal\'s fare reaches passengers only after the office approves it', () => {
  const { store, rank, fare, admin, sipho, pending } = fresh();
  const to = rank('Daveyton').id;
  store.proposeFare(sipho, { toRankId: to, from: '04:00', until: '24:00', price: 22 });
  assert.equal(fare('Etwatwa Las Vegas', 'Daveyton').price, 20, 'still the old fare');
  assert.equal(store.publicSnapshot().proposals.length, 0, 'passengers never see requests');
  assert.equal(pending().length, 1);

  store.decideProposal(pending()[0].id, admin, { approve: true });
  const f = fare('Etwatwa Las Vegas', 'Daveyton');
  assert.equal(f.price, 22);
  assert.equal(f.updatedBy, 'Boss', 'the admin who approved is on the fare');
  assert.equal(pending().length, 0);
  assert.match(store.snapshot().events.find((e) => e.type === 'FARE').detail, /sent by Sipho/);
});

test('a marshal can only ask for their own rank, whatever the phone sends', () => {
  const { store, rank, lindiwe, pending } = fresh();
  store.proposeFare(lindiwe, { rankId: rank('Etwatwa Las Vegas').id, fromRankId: rank('Etwatwa Las Vegas').id, toRankId: rank('Daveyton').id, from: '05:00', until: '20:00', price: 15 });
  assert.equal(pending()[0].rankId, rank('Barcelona').id, 'the rank is the marshal\'s own');
  fails(() => store.proposeFare(lindiwe, { toRankId: rank('Barcelona').id, from: '05:00', until: '20:00', price: 15 }), 400);
  fails(() => store.proposeFare({ id: 99, name: 'Nobody', rankId: null }, { toRankId: rank('Daveyton').id, from: '05:00', until: '20:00', price: 15 }), 403);
});

test('bad fares are refused when asked, not at approval', () => {
  const { store, rank, sipho } = fresh();
  const to = rank('Springs').id;
  const ask = (x) => () => store.proposeFare(sipho, { toRankId: to, from: '04:00', until: '18:00', price: 45, ...x });
  fails(ask({ price: -5 }), 400);
  fails(ask({ price: 99999 }), 400);
  fails(ask({ price: ['45'] }), 400);
  fails(ask({ from: '19:00' }), 400);
  fails(ask({ until: '<script>' }), 400);
  fails(ask({ startsOn: '2026-02-30' }), 400, /real/);
  fails(ask({ startsOn: '2026-11-01' }), 400, /passed/);
  fails(ask({ startsOn: '2027-06-01' }), 400, /90 days/);
  fails(ask({ startsOn: 20261201 }), 400);
  fails(ask({ toRankId: 123456 }), 404);
  fails(ask({ price: 40 }), 409, /already the fare/);
});

test('one open request per destination: your own is replaced, a colleague\'s is not', () => {
  const { store, rank, sipho, thabo, pending } = fresh();
  const to = rank('Springs').id;
  store.proposeFare(sipho, { toRankId: to, from: '04:00', until: '18:00', price: 45 });
  store.proposeFare(sipho, { toRankId: to, from: '04:00', until: '18:00', price: 44 });
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].price, 44);
  fails(() => store.proposeFare(thabo, { toRankId: to, from: '04:00', until: '18:00', price: 60 }), 409, /Sipho/);
  fails(() => store.withdrawProposal(pending()[0].id, thabo), 403);
  store.withdrawProposal(pending()[0].id, sipho);
  assert.equal(pending().length, 0);
  store.proposeFare(thabo, { toRankId: to, from: '04:00', until: '18:00', price: 60 });
  assert.equal(pending()[0].by, 'Thabo');
});

test('a request is decided once', () => {
  const { store, rank, fare, admin, sipho, pending } = fresh();
  store.proposeFare(sipho, { toRankId: rank('Springs').id, from: '04:00', until: '18:00', price: 45 });
  const id = pending()[0].id;
  fails(() => store.decideProposal(id, admin, { approve: 'yes' }), 400);
  fails(() => store.decideProposal(id, admin, {}), 400);
  store.decideProposal(id, admin, { approve: false, reason: 'Not agreed at the meeting' });
  assert.equal(fare('Etwatwa Las Vegas', 'Springs').price, 40);
  fails(() => store.decideProposal(id, admin, { approve: true }), 409);
  fails(() => store.withdrawProposal(id, sipho), 409);
  const p = store.snapshot().proposals.find((x) => x.id === id);
  assert.equal(p.status, 'DECLINED');
  assert.equal(p.reason, 'Not agreed at the meeting');
  fails(() => store.decideProposal(id + 50, admin, { approve: true }), 404);
});

test('a fare with a start date is shown as notice, then becomes the fare on that day', () => {
  const { store, clock, rank, route, fare, admin, sipho, pending } = fresh();
  store.proposeFare(sipho, { toRankId: rank('Daveyton').id, from: '04:00', until: '24:00', price: 23, startsOn: '2026-12-01' });
  store.decideProposal(pending()[0].id, admin, { approve: true });
  assert.equal(fare('Etwatwa Las Vegas', 'Daveyton').price, 20, 'today\'s fare is unchanged');

  const pub = store.publicSnapshot();
  assert.deepEqual(pub.fareChanges, [{ routeId: route('Etwatwa Las Vegas', 'Daveyton').id, from: '04:00', until: '24:00', price: 23, startsOn: '2026-12-01' }]);
  const dest = lookup(['gauteng', 'benoni-ekurhuleni', 'etwatwa-las-vegas'], buildDirectory(pub)).rank.destinations.find((d) => d.name === 'Daveyton');
  assert.equal(dest.price, 20);
  assert.deepEqual(dest.next, { from: '04:00', until: '24:00', price: 23, startsOn: '2026-12-01' });

  clock.t = Date.UTC(2026, 10, 30, 21, 59); // 23:59 on 30 Nov in South Africa
  assert.equal(store.applyDueFares(), 0);
  clock.t += 2 * 60_000; // 00:01 on 1 Dec in South Africa, still 30 Nov in UTC
  assert.equal(saDate(clock.t), '2026-12-01');
  assert.equal(store.applyDueFares(), 1);
  assert.equal(fare('Etwatwa Las Vegas', 'Daveyton').price, 23);
  assert.equal(store.publicSnapshot().fareChanges.length, 0);
  assert.equal(store.applyDueFares(), 0, 'applied once');
});

test('a request approved after its start date starts now', () => {
  const { store, clock, rank, fare, admin, sipho, pending } = fresh();
  store.proposeFare(sipho, { toRankId: rank('Daveyton').id, from: '04:00', until: '24:00', price: 23, startsOn: '2026-11-15' });
  clock.t += 10 * DAY;
  store.decideProposal(pending()[0].id, admin, { approve: true });
  assert.equal(fare('Etwatwa Las Vegas', 'Daveyton').price, 23);
  assert.equal(store.snapshot().fareChanges.length, 0);
});

test('an admin can plan a fare change and cancel it', () => {
  const { store, route, fare } = fresh();
  const id = route('Etwatwa Las Vegas', 'Springs').id;
  store.setFare(id, { from: '04:00', until: '18:00', price: 43, startsOn: '2026-11-25' }, 'Boss');
  assert.equal(fare('Etwatwa Las Vegas', 'Springs').price, 40);
  assert.equal(store.snapshot().fareChanges[0].price, 43);
  store.cancelFareChange(id, 'Boss');
  assert.equal(store.snapshot().fareChanges.length, 0);
  fails(() => store.cancelFareChange(id, 'Boss'), 404);
  store.setFare(id, { from: '04:00', until: '18:00', price: 43, startsOn: '2026-11-25' }, 'Boss');
  store.deleteFare(id, 'Boss');
  assert.equal(store.snapshot().fareChanges.length, 0, 'removing the fare drops its planned change');
});

test('approving a fare to a new destination adds the route both ways and lists the rank', () => {
  const { store, rank, route, admin, lindiwe, pending } = fresh();
  assert.equal(route('Barcelona', 'Daveyton'), undefined);
  store.proposeFare(lindiwe, { toRankId: rank('Daveyton').id, from: '05:00', until: '19:00', price: 18 });
  assert.equal(route('Barcelona', 'Daveyton'), undefined, 'nothing is added until it is approved');
  store.decideProposal(pending()[0].id, admin, { approve: true });
  assert.ok(route('Barcelona', 'Daveyton'));
  assert.ok(route('Daveyton', 'Barcelona'));
  const barcelona = lookup(['gauteng', 'benoni-ekurhuleni', 'barcelona'], buildDirectory(store.publicSnapshot())).rank;
  assert.deepEqual(barcelona.destinations.map((d) => `${d.name} R${d.price}`), ['Daveyton R18']);
});

test('the rank\'s spot: a good fix near the rank, approved by the office, moves the pin', () => {
  const { store, rank, admin, lindiwe, pending } = fresh();
  const before = rank('Barcelona');
  assert.equal(before.verified, false);
  const spot = { lat: before.lat + 0.004, lng: before.lng - 0.003, accuracy: 8.4 };
  const send = (x) => () => store.proposeLocation(lindiwe, { ...spot, ...x });
  fails(send({ accuracy: 180 }), 400, /accurate/);
  fails(send({ accuracy: 0 }), 400);
  fails(send({ accuracy: undefined }), 400);
  fails(send({ lat: '-26.1' }), 400);
  fails(send({ lat: 51.5, lng: -0.1 }), 400, /outside South Africa/);
  fails(send({ lat: -33.92, lng: 18.42 }), 400, /km from/); // Cape Town
  fails(() => store.proposeLocation({ id: 1, name: 'Boss', rankId: null }, spot), 403);

  send({})();
  assert.equal(rank('Barcelona').lat, before.lat, 'the pin has not moved yet');
  assert.equal(store.publicSnapshot().ranks.find((r) => r.id === before.id).verified, false);
  store.decideProposal(pending()[0].id, admin, { approve: true });
  const after = rank('Barcelona');
  assert.equal(after.lat, +spot.lat.toFixed(6));
  assert.equal(after.lng, +spot.lng.toFixed(6));
  assert.equal(after.verified, true);
  assert.equal(after.source, 'Marked at the rank by Lindiwe');
  assert.match(store.snapshot().events.find((e) => e.type === 'RANK').detail, /pin moved \d+ m/);
});

test('holding area: on and off, logged, and it stops counting after 12 hours', () => {
  const { store, clock, rank } = fresh();
  const id = rank('Etwatwa Las Vegas').id;
  const holding = () => store.publicSnapshot().ranks.find((r) => r.id === id).holding;
  assert.equal(holding(), false);
  fails(() => store.setHolding(id, 'yes', 'Sipho'), 400);
  fails(() => store.setHolding(987654, true, 'Sipho'), 404);
  store.setHolding(id, true, 'Sipho');
  assert.equal(holding(), true);
  store.setHolding(id, true, 'Sipho');
  assert.equal(store.snapshot().events.filter((e) => e.type === 'HOLDING').length, 1, 'a repeat is not logged twice');
  store.setHolding(id, false, 'Sipho');
  assert.equal(holding(), false);
  store.setHolding(id, true, 'Sipho');
  clock.t += 13 * 3_600_000;
  assert.equal(holding(), false, 'a flag left on overnight no longer counts');
  store.setHolding(id, true, 'Sipho');
  assert.equal(holding(), true);
});

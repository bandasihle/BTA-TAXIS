import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTransition, STATUS, TransitionError } from '../server/state.js';
import { openDb } from '../server/db.js';
import { createStore, expectedTripMs, toId } from '../server/store.js';
import { seed, RANKS, ROUTE_PAIRS } from '../server/seed.js';
import { PositionSource } from '../server/positions.js';
import { lineLength } from '../server/geo.js';

const taxi = (status, extra = {}) => ({ plate: 'AB 12 CD GP', capacity: 15, status, rank_id: 1, ...extra });
const route = { from_rank_id: 1, to_rank_id: 2 };

test('check-in moves an off-duty taxi into the queue', () => {
  assert.equal(checkTransition('checkIn', taxi(STATUS.OFF_DUTY), { rankId: 1, route }), STATUS.QUEUED);
});

test('check-in rejects a taxi on the road, already queued, or at another rank', () => {
  assert.throws(() => checkTransition('checkIn', taxi(STATUS.EN_ROUTE), { rankId: 1, route }), TransitionError);
  assert.throws(() => checkTransition('checkIn', taxi(STATUS.QUEUED), { rankId: 1, route }), TransitionError);
  assert.throws(() => checkTransition('checkIn', taxi(STATUS.ARRIVED, { rank_id: 9 }), { rankId: 1, route }), TransitionError);
});

test('check-in rejects a route that leaves from another rank', () => {
  assert.throws(() => checkTransition('checkIn', taxi(STATUS.OFF_DUTY), { rankId: 3, route }), /does not leave/);
});

test('seats move between queued and loading and respect capacity', () => {
  assert.equal(checkTransition('seat', taxi(STATUS.QUEUED), { seats: 0, delta: 1 }), STATUS.LOADING);
  assert.equal(checkTransition('seat', taxi(STATUS.LOADING), { seats: 1, delta: -1 }), STATUS.QUEUED);
  assert.throws(() => checkTransition('seat', taxi(STATUS.LOADING), { seats: 15, delta: 1 }), /full/);
  assert.throws(() => checkTransition('seat', taxi(STATUS.QUEUED), { seats: 0, delta: -1 }), /no passengers/);
  assert.throws(() => checkTransition('seat', taxi(STATUS.OFF_DUTY), { seats: 0, delta: 1 }), TransitionError);
});

test('a taxi cannot depart before check-in', () => {
  assert.throws(() => checkTransition('depart', taxi(STATUS.OFF_DUTY)), /Check .* in before it departs/);
  assert.throws(() => checkTransition('depart', taxi(STATUS.ARRIVED)), TransitionError);
  assert.throws(() => checkTransition('depart', taxi(STATUS.EN_ROUTE)), /already departed/);
  assert.equal(checkTransition('depart', taxi(STATUS.LOADING)), STATUS.EN_ROUTE);
});

test('only taxis on the road can arrive; taxis on the road cannot go off duty', () => {
  assert.equal(checkTransition('arrive', taxi(STATUS.EN_ROUTE)), STATUS.ARRIVED);
  assert.throws(() => checkTransition('arrive', taxi(STATUS.QUEUED)), TransitionError);
  assert.throws(() => checkTransition('offDuty', taxi(STATUS.EN_ROUTE)), TransitionError);
  assert.equal(checkTransition('offDuty', taxi(STATUS.LOADING)), STATUS.OFF_DUTY);
});

// ---------------------------------------------------------------- store, end to end

function freshStore() {
  let t = 1_800_000_000_000;
  const store = createStore(openDb(':memory:'), { now: () => t });
  seed(store);
  return { store, advance: (ms) => (t += ms) };
}

const rankNamed = (store, name) => store.snapshot().ranks.find((r) => r.name === name);

/** A registered taxi off duty at Etwatwa Las Vegas, with the route to Daveyton. */
function taxiAtEtwatwa(store, plate = 'AB 12 CD GP') {
  const etwatwa = rankNamed(store, 'Etwatwa Las Vegas');
  const daveyton = rankNamed(store, 'Daveyton');
  const route = store.snapshot().routes.find((r) => r.fromRankId === etwatwa.id && r.toRankId === daveyton.id);
  const { id } = store.createTaxi({ plate, homeRankId: etwatwa.id, driverName: 'Test Driver', ownerName: 'Test Owner' });
  return { id, rankId: etwatwa.id, route };
}

test('seed loads ranks, two-way routes and the association fares: no taxis, drivers or marshals', () => {
  const { store } = freshStore();
  const s = store.snapshot();
  assert.equal(s.ranks.length, RANKS.length);
  assert.equal(s.routes.length, ROUTE_PAIRS.length * 2);
  assert.equal(s.taxis.length, 0);
  assert.equal(s.marshals.length, 0);
  assert.ok(s.events.every((e) => e.type === 'FARE' && e.by === 'Association list'), 'only the starting fares are logged');
  assert.equal(s.fares.length, 5, 'Etwatwa Las Vegas has its 5 fares from the association');
});

test('seed refuses to run on a database that already has ranks', () => {
  const { store } = freshStore();
  const { id } = taxiAtEtwatwa(store);
  assert.throws(() => seed(store), /empty database/);
  assert.ok(store.snapshot().taxis.some((t) => t.id === id), 'nothing was wiped');
});

test('full journey: check in, load, depart, arrive, queue again', () => {
  const { store, advance } = freshStore();
  const t = taxiAtEtwatwa(store);
  const { route } = t;

  store.act({ type: 'checkIn', taxiId: t.id, rankId: t.rankId, routeId: route.id });
  for (let i = 0; i < 3; i++) store.act({ type: 'seat', taxiId: t.id, delta: 1 });
  assert.equal(store.snapshot().queue.find((q) => q.taxiId === t.id).seats, 3);

  const source = new PositionSource(store);
  assert.ok(source.getPositions().some((p) => p.id === t.id && p.status === 'LOADING' && p.rankId === t.rankId));

  store.act({ type: 'depart', taxiId: t.id });
  const after = store.snapshot();
  assert.equal(after.taxis.find((x) => x.id === t.id).status, 'EN_ROUTE');
  assert.ok(!after.queue.some((q) => q.taxiId === t.id));
  const trip = after.trips.find((x) => x.taxiId === t.id);
  assert.equal(trip.durationMs, expectedTripMs(lineLength(route.polyline)), 'trip time is real time, not sped up');
  assert.ok(!source.getPositions().some((p) => p.id === t.id), 'no made-up position on the road');

  advance(30 * 60 * 1000);
  store.act({ type: 'arrive', taxiId: t.id });
  const arrived = store.snapshot().taxis.find((x) => x.id === t.id);
  assert.equal(arrived.status, 'ARRIVED');
  assert.equal(arrived.rankId, route.toRankId);

  const back = store.snapshot().routes.find((r) => r.fromRankId === route.toRankId && r.toRankId === t.rankId);
  store.act({ type: 'checkIn', taxiId: t.id, rankId: route.toRankId, routeId: back.id });
  assert.equal(store.snapshot().taxis.find((x) => x.id === t.id).status, 'QUEUED');
});

test('queue positions stay 1..n when a taxi leaves the middle', () => {
  const { store } = freshStore();
  const taxis = ['AA 11 AA GP', 'BB 22 BB GP', 'CC 33 CC GP'].map((plate) => taxiAtEtwatwa(store, plate));
  for (const t of taxis) store.act({ type: 'checkIn', taxiId: t.id, rankId: t.rankId, routeId: t.route.id });
  store.act({ type: 'depart', taxiId: taxis[1].id });
  const queue = store.snapshot().queue.filter((q) => q.routeId === taxis[0].route.id);
  assert.deepEqual(queue.map((q) => [q.taxiId, q.position]), [[taxis[0].id, 1], [taxis[2].id, 2]]);
});

test('illegal moves leave the database unchanged', () => {
  const { store } = freshStore();
  const t = taxiAtEtwatwa(store);
  const before = JSON.stringify(store.snapshot().queue);
  assert.throws(() => store.act({ type: 'depart', taxiId: t.id }), /before it departs/);
  assert.equal(JSON.stringify(store.snapshot().queue), before);
});

test('the public snapshot has no driver, owner or marshal details and no event log', () => {
  const { store } = freshStore();
  const t = taxiAtEtwatwa(store);
  store.act({ type: 'checkIn', taxiId: t.id, rankId: t.rankId, routeId: t.route.id });
  const pub = store.publicSnapshot();
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('Test Driver') && !text.includes('Test Owner'));
  assert.deepEqual(pub.events, []);
  assert.deepEqual(pub.marshals, []);
  assert.deepEqual(Object.keys(pub.taxis[0]).sort(), ['capacity', 'id', 'plate', 'rankId', 'status', 'tripId']);
  assert.ok(pub.queue.some((q) => q.taxiId === t.id), 'passengers still see the loading taxi');
});

test('new ranks and routes are available straight away', () => {
  const { store } = freshStore();
  const { id } = store.createRank({ name: 'Etwatwa Ext 9', lat: -26.11, lng: 28.46 });
  const daveyton = rankNamed(store, 'Daveyton');
  store.createRoute({ fromRankId: id, toRankId: daveyton.id, bothWays: true });
  const s = store.snapshot();
  assert.ok(s.routes.some((r) => r.fromRankId === id && r.toRankId === daveyton.id));
  assert.ok(s.routes.some((r) => r.fromRankId === daveyton.id && r.toRankId === id));
  assert.throws(() => store.createRank({ name: 'Nowhere', lat: 51.5, lng: -0.1 }), /outside South Africa/);
});

test('a busy rank cannot be deleted', () => {
  const { store } = freshStore();
  const t = taxiAtEtwatwa(store);
  store.act({ type: 'checkIn', taxiId: t.id, rankId: t.rankId, routeId: t.route.id });
  assert.throws(() => store.deleteRank(t.rankId), /still has/);
});

test('ids from requests: whole positive numbers or plain digits, nothing that only looks like one', () => {
  for (const [v, want] of [[1, 1], [42, 42], ['7', 7], ['123', 123]]) assert.equal(toId(v), want, JSON.stringify(v));
  for (const v of [0, -1, 1.5, NaN, Infinity, '0', '01', '1e3', ' 1', '1 ', '0x1', '', null, undefined, true, [1], { valueOf: () => 1 }, 2 ** 60]) {
    assert.equal(toId(v), null, String(v));
  }
});

test('a taxi id that is not a plain number names no taxi, for the rank check and the action alike', () => {
  const { store } = freshStore();
  const t = taxiAtEtwatwa(store);
  for (const v of [[t.id], String(t.id) + ' ', { toString: () => String(t.id) }]) {
    assert.equal(store.rankForAction({ type: 'seat', taxiId: v }), null);
    assert.throws(() => store.act({ type: 'offDuty', taxiId: v }), { status: 404 });
  }
});

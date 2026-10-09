import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTransition, STATUS, TransitionError } from '../server/state.js';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { seed } from '../server/seed.js';
import { SimulatedPositionSource } from '../server/sim.js';

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
  const store = createStore(openDb(':memory:'), { now: () => t, random: () => 0.5, simScale: 20 });
  seed(store);
  return { store, advance: (ms) => (t += ms) };
}

test('seed loads ranks, two-way routes and taxis in every state', () => {
  const { store } = freshStore();
  const s = store.snapshot();
  assert.equal(s.ranks.length, 11);
  assert.equal(s.routes.length, 12);
  assert.equal(s.taxis.length, 30);
  for (const st of Object.values(STATUS)) assert.ok(s.taxis.some((t) => t.status === st), `no taxi is ${st}`);
});

test('full journey: check in, load, depart, drive, arrive, queue again', () => {
  const { store, advance } = freshStore();
  const s = store.snapshot();
  const t = s.taxis.find((x) => x.status === 'OFF_DUTY');
  const route = s.routes.find((r) => r.fromRankId === t.rankId);

  store.act({ type: 'checkIn', taxiId: t.id, rankId: t.rankId, routeId: route.id });
  // put it at the front so the queue order is easy to assert
  while (store.snapshot().queue.find((q) => q.taxiId === t.id).position > 1) store.act({ type: 'move', taxiId: t.id, dir: 'up' });
  for (let i = 0; i < 3; i++) store.act({ type: 'seat', taxiId: t.id, delta: 1 });
  assert.equal(store.snapshot().queue.find((q) => q.taxiId === t.id).seats, 3);

  store.act({ type: 'depart', taxiId: t.id });
  const after = store.snapshot();
  assert.equal(after.taxis.find((x) => x.id === t.id).status, 'EN_ROUTE');
  assert.ok(!after.queue.some((q) => q.taxiId === t.id));
  const positionsInRoute = after.queue.filter((q) => q.routeId === route.id).map((q) => q.position);
  assert.deepEqual(positionsInRoute, positionsInRoute.map((_, i) => i + 1), 'queue positions stay 1..n');

  const source = new SimulatedPositionSource(store);
  assert.ok(source.getPositions().some((p) => p.id === t.id && p.status === 'EN_ROUTE'));
  assert.ok(!source.dueArrivals().includes(t.id));
  advance(60 * 60 * 1000);
  assert.ok(source.dueArrivals().includes(t.id));

  store.act({ type: 'arrive', taxiId: t.id, by: 'simulator' });
  const arrived = store.snapshot().taxis.find((x) => x.id === t.id);
  assert.equal(arrived.status, 'ARRIVED');
  assert.equal(arrived.rankId, route.toRankId);

  const back = store.snapshot().routes.find((r) => r.fromRankId === route.toRankId);
  store.act({ type: 'checkIn', taxiId: t.id, rankId: route.toRankId, routeId: back.id });
  assert.equal(store.snapshot().taxis.find((x) => x.id === t.id).status, 'QUEUED');
});

test('illegal moves leave the database unchanged', () => {
  const { store } = freshStore();
  const t = store.snapshot().taxis.find((x) => x.status === 'OFF_DUTY');
  const before = JSON.stringify(store.snapshot().queue);
  assert.throws(() => store.act({ type: 'depart', taxiId: t.id }), /before it departs/);
  assert.equal(JSON.stringify(store.snapshot().queue), before);
});

test('new ranks and routes are available straight away', () => {
  const { store } = freshStore();
  const { id } = store.createRank({ name: 'Etwatwa Ext 9', lat: -26.11, lng: 28.46 });
  const daveyton = store.snapshot().ranks.find((r) => r.name === 'Daveyton Main');
  store.createRoute({ fromRankId: id, toRankId: daveyton.id, bothWays: true });
  const s = store.snapshot();
  assert.ok(s.routes.some((r) => r.fromRankId === id && r.toRankId === daveyton.id));
  assert.ok(s.routes.some((r) => r.fromRankId === daveyton.id && r.toRankId === id));
  assert.throws(() => store.createRank({ name: 'Nowhere', lat: 51.5, lng: -0.1 }), /outside South Africa/);
});

test('a busy rank cannot be deleted', () => {
  const { store } = freshStore();
  const s = store.snapshot();
  const busy = s.taxis.find((t) => t.status === 'QUEUED').rankId;
  assert.throws(() => store.deleteRank(busy), /still has/);
});

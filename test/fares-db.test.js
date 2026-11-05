import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, slugify } from '../server/db.js';
import { createStore } from '../server/store.js';
import { seed } from '../server/seed.js';
import { buildDirectory, lookup, priceLabel } from '../public/js/fares.js';

function fresh() {
  const store = createStore(openDb(':memory:'));
  seed(store);
  const s = store.snapshot();
  const rank = (name) => s.ranks.find((r) => r.name === name);
  const route = (a, b) => s.routes.find((r) => r.fromRankId === rank(a).id && r.toRankId === rank(b).id);
  return { store, rank, route };
}

test('the passenger directory comes from the database, in the same shape as before', () => {
  const { store } = fresh();
  const tree = buildDirectory(store.publicSnapshot());
  const { rank } = lookup(['gauteng', 'benoni-ekurhuleni', 'etwatwa-las-vegas'], tree);
  assert.equal(rank.name, 'Etwatwa Las Vegas');
  assert.equal(rank.exact, true);
  assert.deepEqual(
    rank.destinations.map((d) => `${d.name} ${d.from}-${d.until} ${priceLabel(d.price)}`).sort(),
    ['Daveyton 04:00-24:00 R20', 'East Rand Mall 04:00-24:00 R40', 'Farrarmere & Rynfield 04:00-22:30 R30', 'Germiston 04:00-24:00 R40', 'Springs 04:00-18:00 R40'],
  );
  const erm = rank.destinations.find((d) => d.name === 'East Rand Mall');
  assert.deepEqual(erm.toPath, ['gauteng', 'benoni-ekurhuleni', 'east-rand-mall'], 'a destination that is also a rank links to it');
  assert.equal(rank.destinations.find((d) => d.name === 'Germiston').toPath, null, 'a destination-only place has no link');
  assert.ok(rank.destinations.every((d) => d.routeId && d.backRouteId), 'routes both ways for live taxis');

  const region = tree[0].regions.find((g) => g.id === 'benoni-ekurhuleni');
  assert.ok(!region.ranks.some((k) => k.name === 'Germiston'), 'destination-only places are not listed to board at');
  assert.equal(region.ranks[0].id, 'etwatwa-las-vegas', 'ranks with fares come first');
});

test('a route without a fare is not shown to passengers', () => {
  const { store, route } = fresh();
  store.deleteFare(route('Etwatwa Las Vegas', 'Springs').id, 'Tester');
  const rank = lookup(['gauteng', 'benoni-ekurhuleni', 'etwatwa-las-vegas'], buildDirectory(store.publicSnapshot())).rank;
  assert.ok(!rank.destinations.some((d) => d.name === 'Springs'));
  assert.ok(store.snapshot().routes.some((r) => r.id === route('Etwatwa Las Vegas', 'Springs').id), 'the route itself stays for marshals');
});

test('fares are validated: real times in order, a sensible price in rand', () => {
  const { store, route } = fresh();
  const id = route('Etwatwa Las Vegas', 'Daveyton').id;
  const bad = [
    [{ from: '4:00', until: '20:00', price: 20 }, /Times/],
    [{ from: '04:00', until: '24:30', price: 20 }, /Times/],
    [{ from: '25:00', until: '26:00', price: 20 }, /Times/],
    [{ from: '20:00', until: '04:00', price: 20 }, /after the first/],
    [{ from: '04:00', until: '04:00', price: 20 }, /after the first/],
    [{ from: '04:00', until: '20:00', price: 0 }, /price/],
    [{ from: '04:00', until: '20:00', price: -5 }, /price/],
    [{ from: '04:00', until: '20:00', price: 12.345 }, /price/],
    [{ from: '04:00', until: '20:00', price: 2001 }, /price/],
    [{ from: '04:00', until: '20:00', price: 'twenty' }, /price/],
    [{ from: ['04:00'], until: '20:00', price: 20 }, /Times/],
    [{ from: '04:00', until: '20:00', price: [20] }, /price/],
    [{ from: '04:00', until: '20:00', price: true }, /price/],
    [{ from: '04:00', until: '20:00', price: '' }, /price/],
  ];
  for (const [input, msg] of bad) assert.throws(() => store.setFare(id, input, 'Tester'), msg, JSON.stringify(input));
  assert.throws(() => store.setFare(99999, { from: '04:00', until: '20:00', price: 20 }), /does not exist/);
  store.setFare(id, { from: '04:30', until: '24:00', price: 12.5 }, 'Tester');
  assert.deepEqual(store.publicSnapshot().fares.find((f) => f.routeId === id), { routeId: id, from: '04:30', until: '24:00', price: 12.5 });
});

test('every fare change is logged with who made it and what it was before', () => {
  const { store, route } = fresh();
  const id = route('Etwatwa Las Vegas', 'Daveyton').id;
  store.setFare(id, { from: '04:00', until: '24:00', price: 22 }, 'Admin One');
  assert.equal(store.setFare(id, { from: '04:00', until: '24:00', price: 22 }, 'Admin One').message, 'Nothing to change');
  store.deleteFare(id, 'Admin Two');
  const log = store.snapshot().events.filter((e) => e.type === 'FARE' && e.routeId === id).map((e) => [e.by, e.detail]);
  assert.deepEqual(log.slice(0, 2), [
    ['Admin Two', 'Etwatwa Las Vegas to Daveyton: fare removed (was 04:00–24:00, R22)'],
    ['Admin One', 'Etwatwa Las Vegas to Daveyton: 04:00–24:00, R20 changed to 04:00–24:00, R22'],
  ]);
  const fare = store.snapshot().fares.find((f) => f.routeId === id);
  assert.equal(fare, undefined);
});

test('deleting a route deletes its fare', () => {
  const { store, rank, route } = fresh();
  const { id } = store.createRank({ name: 'Etwatwa Ext 9', lat: -26.11, lng: 28.46, regionId: 'benoni-ekurhuleni' });
  store.createRoute({ fromRankId: id, toRankId: rank('Daveyton').id });
  const r = store.snapshot().routes.find((x) => x.fromRankId === id);
  store.setFare(r.id, { from: '05:00', until: '19:00', price: 15 });
  store.deleteRoute(r.id);
  assert.ok(!store.snapshot().fares.some((f) => f.routeId === r.id));
  assert.ok(route('Etwatwa Las Vegas', 'Daveyton'), 'other routes are untouched');
});

test('new ranks get a unique link name and a checked region', () => {
  const { store } = fresh();
  const a = store.createRank({ name: 'Etwatwa Ext 9', lat: -26.11, lng: 28.46, regionId: 'benoni-ekurhuleni' });
  const b = store.createRank({ name: 'Etwatwa Ext 9!', lat: -26.12, lng: 28.46 });
  const ranks = store.snapshot().ranks;
  assert.equal(ranks.find((r) => r.id === a.id).slug, 'etwatwa-ext-9');
  assert.equal(ranks.find((r) => r.id === b.id).slug, 'etwatwa-ext-9-2');
  assert.equal(ranks.find((r) => r.id === b.id).regionId, null);
  assert.throws(() => store.createRank({ name: 'X', lat: -26.1, lng: 28.4, regionId: 'atlantis' }), /regions/);
  store.updateRank(a.id, { name: 'Etwatwa Extension 9' });
  assert.equal(store.snapshot().ranks.find((r) => r.id === a.id).slug, 'etwatwa-ext-9', 'renaming keeps old links working');
  assert.equal(slugify('Farrarmere & Rynfield'), 'farrarmere-and-rynfield');
  assert.equal(slugify('<script>'), 'script');
});

test('a database from the previous version is upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bta-migrate-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE ranks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      area TEXT, verified INTEGER NOT NULL DEFAULT 0, source TEXT, note TEXT);
      INSERT INTO ranks (name, lat, lng) VALUES ('Benoni CBD', -26.2, 28.3), ('Benoni CBD', -26.21, 28.31);`);
    old.close();
    const db = openDb(file);
    const rows = db.prepare('SELECT id, slug, region_id FROM ranks ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.slug), [`benoni-cbd-${rows[0].id}`, `benoni-cbd-${rows[1].id}`]);
    assert.ok(rows.every((r) => r.region_id === null));
    db.close();
    openDb(file).close(); // running it again is harmless
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

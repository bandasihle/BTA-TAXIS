import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVINCES, lookup, timeLabel, runningNow, trackerName, saMinutes } from '../public/js/fares.js';

test('all nine provinces are listed', () => {
  assert.deepEqual(PROVINCES.map((p) => p.name), [
    'Gauteng', 'Limpopo', 'Mpumalanga', 'North West', 'Free State', 'KwaZulu-Natal',
    'Eastern Cape', 'Western Cape', 'Northern Cape',
  ]);
});

test('every rank has destinations with a time and a price', () => {
  const ids = new Set();
  for (const p of PROVINCES) {
    for (const r of p.regions) {
      for (const k of r.ranks) {
        const path = `${p.id}/${r.id}/${k.id}`;
        assert.ok(!ids.has(path), `duplicate ${path}`);
        ids.add(path);
        assert.ok(k.destinations.length > 0, `${k.name} has no destinations`);
        for (const d of k.destinations) {
          assert.match(d.from, /^([01]\d|2[0-4]):[0-5]\d$/, `${k.name} > ${d.name} start time`);
          assert.match(d.until, /^([01]\d|2[0-4]):[0-5]\d$/, `${k.name} > ${d.name} end time`);
          assert.ok(Number.isInteger(d.price) && d.price > 0, `${k.name} > ${d.name} price`);
        }
      }
    }
  }
});

test('Etwatwa Las Vegas matches the association list', () => {
  const { rank } = lookup(['gauteng', 'benoni-ekurhuleni', 'etwatwa-las-vegas']);
  assert.equal(rank.sample, false);
  assert.deepEqual(
    rank.destinations.map((d) => `${d.name} | ${timeLabel(d.from)} - ${timeLabel(d.until)} | R${d.price}`),
    [
      'Germiston | 04:00 - midnight | R40',
      'Springs | 04:00 - 18:00 | R40',
      'Farrarmere & Rynfield | 04:00 - 22:30 | R30',
      'East Rand Mall | 04:00 - midnight | R40',
      'Daveyton | 04:00 - midnight | R20',
    ],
  );
});

test('the ranks under Benoni Ekurhuleni are the ones the association named', () => {
  const { region } = lookup(['gauteng', 'benoni-ekurhuleni']);
  assert.deepEqual(region.ranks.map((k) => k.name), [
    'Etwatwa Las Vegas Taxi Rank', 'Barcelona Taxi Rank', 'Cloverdene Taxi Rank', 'Lakeside Taxi Rank',
    'Dunswart Taxi Rank', 'Northmead Square Taxi Rank', 'East Rand Mall Taxi Rank', 'SuperSpar Taxi Rank',
  ]);
});

test('lookup stops at the deepest part that exists', () => {
  const r = lookup(['gauteng', 'nowhere', 'x']);
  assert.equal(r.province.id, 'gauteng');
  assert.equal(r.region, null);
  assert.equal(r.rank, null);
});

test('running now: open, last taxi soon, closed', () => {
  const springs = { from: '04:00', until: '18:00' };
  const at = (h, m = 0) => h * 60 + m;
  assert.deepEqual(runningNow(springs, at(3, 59)), { open: false, text: 'Closed, opens 04:00' });
  assert.deepEqual(runningNow(springs, at(4)), { open: true, soon: false, text: 'Running now' });
  assert.deepEqual(runningNow(springs, at(17, 20)), { open: true, soon: true, text: 'Last taxi in 40 min' });
  assert.equal(runningNow(springs, at(18)).open, false);
  assert.equal(runningNow({ from: '04:00', until: '24:00' }, at(23, 59)).open, true);
});

test('South African time does not depend on the phone time zone', () => {
  assert.equal(saMinutes(new Date('2026-10-11T22:30:00Z')), 30); // 00:30 in Johannesburg
});

test('places map to the rank tracker names', () => {
  assert.equal(trackerName('Etwatwa'), 'Etwatwa Las Vegas');
  assert.equal(trackerName('Germiston'), 'Germiston');
  assert.equal(trackerName(lookup(['gauteng', 'benoni-ekurhuleni', 'dunswart']).rank), 'Dunswart');
});

import { pathToFileURL } from 'node:url';
import { openDb, DEFAULT_DB } from './db.js';
import { createStore } from './store.js';
import { PLACES, allRanks, trackerName } from '../public/js/fares.js';

// Ranks and routes come from the Danki Driver directory (public/js/fares.js), so the
// passenger app, the dashboard and the rank editor all show the same places. Every Danki
// rank becomes a rank here, and so does every place taxis go to. Positions come from
// OpenStreetMap place search: most pins sit on the right area, not on the exact rank.
const PLACE_NOTE = 'Pin is on the area, not on the exact rank. Drag it to the rank to fix it.';

export const RANKS = [
  ...allRanks().map(({ region, rank }) => ({
    key: rank.id, name: trackerName(rank), lat: rank.at[0], lng: rank.at[1], area: region.name,
    verified: rank.exact, source: rank.exact ? 'Position sent by the association' : 'OpenStreetMap place search',
    note: rank.exact ? null : PLACE_NOTE,
  })),
  ...Object.entries(PLACES).filter(([, p]) => !p.rank).map(([name, p]) => ({
    key: name, name, lat: p.at[0], lng: p.at[1], area: name, source: 'OpenStreetMap place search', note: PLACE_NOTE,
  })),
];

// One two-way route for every destination on a Danki rank's fare list.
export const ROUTE_PAIRS = (() => {
  const seen = new Set();
  const pairs = [];
  for (const { rank } of allRanks()) {
    for (const d of rank.destinations) {
      const pair = [rank.id, PLACES[d.name].rank ?? d.name];
      const id = [...pair].sort().join('|');
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push(pair);
    }
  }
  return pairs;
})();

const DRIVERS = [
  'Sipho Nkosi', 'Thabo Mokoena', 'Bongani Dlamini', 'Lucky Mahlangu', 'Themba Khumalo', 'Mandla Zulu',
  'Jabu Ndlovu', 'Kagiso Molefe', 'Sibusiso Mthembu', 'Tshepo Maseko', 'Vusi Shabangu', 'Nomsa Sithole',
  'Lerato Mokoena', 'Petrus Masilela', 'Elias Skosana', 'Musa Ngcobo', 'Andile Mabena', 'Johannes Motaung',
  'Sello Radebe', 'Zodwa Nhlapo', 'Bheki Msimango', 'Kabelo Tau', 'Simon Mnguni', 'Thulani Buthelezi',
  'Godfrey Malinga', 'Lindiwe Hlongwane', 'Pule Seleka', 'Ntokozo Cele', 'Dumisani Nxumalo', 'Isaac Mashego',
];
const OWNERS = ['M. Mahlangu Transport', 'Ndlovu Fleet', 'S. Khumalo', 'Masilela Bros', 'T. Zulu', 'Daveyton Ride Co (demo)'];
const HOMES = ['etwatwa-las-vegas', 'etwatwa-las-vegas', 'barcelona', 'Daveyton', 'cloverdene', 'Benoni CBD', 'east-rand-mall', 'dunswart', 'lakeside', 'northmead-square', 'superspar', 'Springs'];

function seeded(seed) {
  let s = seed;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function makePlates(rand, n) {
  const L = 'BCDFGHJKLMNPRSTVWXYZ';
  const letter = () => L[Math.floor(rand() * L.length)];
  const plates = new Set();
  while (plates.size < n) {
    plates.add(`${letter()}${letter()} ${String(10 + Math.floor(rand() * 90))} ${letter()}${letter()} GP`);
  }
  return [...plates];
}

/** Wipes everything and loads demo data. Leaves some taxis queued, loading, on the road, waiting and off duty. */
export function seed(store) {
  const { db } = store;
  const rand = seeded(20261009);
  const now = store.now();

  store.quietly(() => {
    store.tx(() => {
      db.exec('DELETE FROM events; DELETE FROM trips; DELETE FROM queue_entries; DELETE FROM taxis; DELETE FROM marshals; DELETE FROM drivers; DELETE FROM routes; DELETE FROM ranks;');

      const rankId = {};
      for (const r of RANKS) {
        rankId[r.key] = store.createRank({ ...r, verified: !!r.verified }).id;
      }
      for (const [a, b] of ROUTE_PAIRS) store.createRoute({ fromRankId: rankId[a], toRankId: rankId[b], bothWays: true });

      const marshalNames = ['Mr Mabuza', 'Ms Radebe', 'Mr Tshabalala', 'Mr Sibiya', 'Ms Nkosi', 'Mr Zwane', 'Mr Mathebula', 'Ms Mokoena', 'Mr Ngwenya', 'Mr Mazibuko', 'Ms Dube'];
      RANKS.forEach((r, i) => db.prepare('INSERT INTO marshals (name, rank_id) VALUES (?, ?)').run(`${marshalNames[i % marshalNames.length]} (demo)`, rankId[r.key]));

      const plates = makePlates(rand, DRIVERS.length);
      const routes = store.snapshot().routes;
      const routesFrom = (id) => routes.filter((r) => r.fromRankId === id);

      const taxis = plates.map((plate, i) => {
        const home = rankId[HOMES[i % HOMES.length]];
        const { id } = store.createTaxi({
          plate, capacity: i % 9 === 4 ? 22 : 15, driverName: `${DRIVERS[i]} (demo)`,
          ownerName: OWNERS[i % OWNERS.length], homeRankId: home, by: 'seed',
        });
        return { id, home };
      });

      taxis.forEach(({ id, home }, i) => {
        const options = routesFrom(home);
        const route = options[Math.floor(rand() * options.length)];
        const mode = i % 6;
        if (mode === 5 || !route) return; // off duty at home
        store.act({ type: 'checkIn', taxiId: id, rankId: home, routeId: route.id, by: 'seed' });
        if (mode === 2 || mode === 3) {
          const { tripId } = store.act({ type: 'depart', taxiId: id, by: 'seed' });
          const trip = db.prepare('SELECT duration_ms FROM trips WHERE id = ?').get(tripId);
          db.prepare('UPDATE trips SET departed_at = ? WHERE id = ?').run(now - Math.round(trip.duration_ms * (0.1 + rand() * 0.75)), tripId);
        } else if (mode === 4) {
          store.act({ type: 'remove', taxiId: id, by: 'seed' });
        }
      });

      // Fill the taxi at the front of each queue part of the way.
      const s = store.snapshot();
      const seen = new Set();
      for (const q of s.queue) {
        if (seen.has(q.routeId)) continue;
        seen.add(q.routeId);
        const cap = s.taxis.find((t) => t.id === q.taxiId).capacity;
        const n = 2 + Math.floor(rand() * (cap - 3));
        for (let k = 0; k < n; k++) store.act({ type: 'seat', taxiId: q.taxiId, delta: 1, by: 'seed' });
      }

      // Spread the seed log over the last half hour so the trip log reads naturally.
      const evs = db.prepare('SELECT id FROM events ORDER BY id').all();
      evs.forEach((e, i) => db.prepare('UPDATE events SET at = ? WHERE id = ?').run(now - (evs.length - i) * 45_000, e.id));
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(process.env.DB_FILE || DEFAULT_DB);
  seed(createStore(db));
  const n = db.prepare('SELECT COUNT(*) AS n FROM taxis').get().n;
  console.log(`Demo data loaded: ${RANKS.length} ranks, ${ROUTE_PAIRS.length * 2} routes, ${n} taxis.`);
}

import { pathToFileURL } from 'node:url';
import { openDb, DEFAULT_DB, slugify } from './db.js';
import { createStore } from './store.js';
import { PLACES, allRanks, trackerName } from '../public/js/fares.js';

// The starting ranks, routes and fares come from the association's list (public/js/fares.js).
// After that they live in the database and admins change them in the app. Every rank on the
// list becomes a rank people board at (with its region), and every other place taxis go to
// becomes a destination-only rank. Positions come from OpenStreetMap place search: most pins
// sit on the right area, not on the exact rank.
const PLACE_NOTE = 'Pin is on the area, not on the exact rank. Drag it to the rank to fix it.';

export const RANKS = [
  ...allRanks().map(({ region, rank }) => ({
    key: rank.id, slug: rank.id, regionId: region.id, name: trackerName(rank), lat: rank.at[0], lng: rank.at[1], area: region.name,
    verified: rank.exact, source: rank.exact ? 'Position sent by the association' : 'OpenStreetMap place search',
    note: rank.exact ? null : PLACE_NOTE,
  })),
  ...Object.entries(PLACES).filter(([, p]) => !p.rank).map(([name, p]) => ({
    key: name, slug: slugify(name), name, lat: p.at[0], lng: p.at[1], area: name, source: 'OpenStreetMap place search', note: PLACE_NOTE,
  })),
];

// One two-way route for every destination on a Dankie rank's fare list.
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

/**
 * Loads the association's ranks and the routes on their fare lists into an empty
 * database. It never deletes anything: on a database that already has ranks it refuses,
 * so real records can't be wiped by running it by mistake.
 */
export function seed(store) {
  if (!store.isEmpty()) throw new Error('The database already has ranks. Seeding only runs on an empty database.');
  store.quietly(() => {
    store.tx(() => {
      const rankId = {};
      for (const r of RANKS) rankId[r.key] = store.createRank({ ...r, verified: !!r.verified }).id;
      for (const [a, b] of ROUTE_PAIRS) store.createRoute({ fromRankId: rankId[a], toRankId: rankId[b], bothWays: true });
      const routeId = new Map(store.snapshot().routes.map((r) => [`${r.fromRankId}>${r.toRankId}`, r.id]));
      for (const { rank } of allRanks()) {
        for (const d of rank.destinations) {
          const to = rankId[PLACES[d.name].rank ?? d.name];
          store.setFare(routeId.get(`${rankId[rank.id]}>${to}`), { from: d.from, until: d.until, price: d.price }, 'Association list');
        }
      }
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(process.env.DB_FILE || DEFAULT_DB);
  try {
    seed(createStore(db));
    const fares = allRanks().reduce((n, { rank }) => n + rank.destinations.length, 0);
    console.log(`Loaded ${RANKS.length} ranks, ${ROUTE_PAIRS.length * 2} routes and ${fares} fares.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

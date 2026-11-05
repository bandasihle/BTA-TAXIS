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
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(process.env.DB_FILE || DEFAULT_DB);
  try {
    seed(createStore(db));
    console.log(`Loaded ${RANKS.length} ranks and ${ROUTE_PAIRS.length * 2} routes.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

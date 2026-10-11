// Fetches the road for every demo route (both ways) and saves them in server/roads.json.
// Run with `npm run roads`. Roads already saved are skipped; add --all to fetch them again.

import { RANKS, ROUTE_PAIRS } from './seed.js';
import { fetchRoad, savedRoad, saveRoads } from './roads.js';

const all = process.argv.includes('--all');
const byKey = new Map(RANKS.map((r) => [r.key, r]));
const legs = ROUTE_PAIRS.flatMap(([a, b]) => [[byKey.get(a), byKey.get(b)], [byKey.get(b), byKey.get(a)]]);

let fetched = 0;
let failed = 0;
for (const [a, b] of legs) {
  if (!all && savedRoad(a, b)) continue;
  try {
    const road = await fetchRoad(a, b);
    fetched++;
    console.log(`${a.name} to ${b.name}: ${road.length} points`);
  } catch (err) {
    failed++;
    console.log(`${a.name} to ${b.name}: failed, ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1100)); // the free planner asks for at most one request a second
}
saveRoads();
console.log(`Fetched ${fetched} roads${failed ? `, ${failed} failed (run again to retry)` : ''}. ${legs.length} routes in total.`);

// Road routes between ranks, from OSRM (a free route planner on OpenStreetMap data).
//
// The routes for the demo data are fetched once with `npm run roads` and saved in
// server/roads.json, so the app never needs the route planner to start. A route added or
// moved in the rank editor asks the planner for its road there and then (see store.js).
// Roads are keyed by the two end points, so moving a pin never reuses an old road.

import fs from 'node:fs';
import path from 'node:path';

export const ROADS_FILE = path.resolve(import.meta.dirname, 'roads.json');
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

const saved = (() => {
  try {
    return JSON.parse(fs.readFileSync(ROADS_FILE, 'utf8'));
  } catch {
    return {};
  }
})();

const fixed = (n) => Number(n).toFixed(5);
export const roadKey = (a, b) => `${fixed(a.lat)},${fixed(a.lng)};${fixed(b.lat)},${fixed(b.lng)}`;

/** The saved road from rank a to rank b as [[lat, lng], ...], or null. */
export function savedRoad(a, b) {
  return saved[roadKey(a, b)] ?? null;
}

/** Asks the route planner for the road from a to b. Resolves to [[lat, lng], ...]. */
export async function fetchRoad(a, b) {
  const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { 'User-Agent': 'bta-rank-tracker (prototype)' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Route planner answered ${res.status}`);
  const data = await res.json();
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== 'Ok' || !coords?.length) throw new Error(`No road found (${data.code})`);
  // the planner starts and ends on the nearest road; join that up with the rank pins
  const line = [[a.lat, a.lng], ...coords.map(([lng, lat]) => [lat, lng]), [b.lat, b.lng]];
  const road = simplify(line, 15).map(([lat, lng]) => [+lat.toFixed(5), +lng.toFixed(5)]);
  saved[roadKey(a, b)] = road;
  return road;
}

/** Writes every road fetched so far to roads.json. */
export function saveRoads() {
  const sorted = Object.fromEntries(Object.entries(saved).sort(([x], [y]) => x.localeCompare(y)));
  fs.writeFileSync(ROADS_FILE, JSON.stringify(sorted) + '\n');
}

// Douglas-Peucker: drops points that sit within `metres` of the line, so a road keeps
// its shape with far fewer points (the routes go to every screen with each update).
function simplify(points, metres) {
  if (points.length < 3) return points;
  const lat0 = (points[0][0] * Math.PI) / 180;
  const xy = points.map(([lat, lng]) => [lng * 111_320 * Math.cos(lat0), lat * 110_540]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = xy[s];
    const [x2, y2] = xy[e];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    let far = -1;
    let best = metres;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((x2 - x1) * (y1 - xy[i][1]) - (x1 - xy[i][0]) * (y2 - y1)) / len;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([s, far], [far, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

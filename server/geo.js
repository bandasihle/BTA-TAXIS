// Small geometry helpers. Points are [lat, lng].

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm([lat1, lng1], [lat2, lng2]) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

export function lineLength(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return km;
}

/** Point at fraction t (0..1) of the line's length. */
export function pointAlong(points, t) {
  if (points.length === 1 || t <= 0) return points[0];
  if (t >= 1) return points[points.length - 1];
  const target = lineLength(points) * t;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversineKm(points[i - 1], points[i]);
    if (walked + seg >= target) {
      const f = seg === 0 ? 0 : (target - walked) / seg;
      const [a, b] = [points[i - 1], points[i]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    walked += seg;
  }
  return points[points.length - 1];
}

function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * A road-ish line between two points: a gentle bend plus small wiggles, so simulated
 * taxis don't fly in perfectly straight lines. The same pair always gives the same line,
 * and B→A is A→B reversed.
 */
export function roadLine(a, b, idA, idB) {
  const flip = idA > idB;
  const [p, q] = flip ? [b, a] : [a, b];
  const rand = seededRandom(Math.min(idA, idB) * 7919 + Math.max(idA, idB) * 104729);
  const dLat = q[0] - p[0];
  const dLng = q[1] - p[1];
  const len = Math.hypot(dLat, dLng) || 1e-9;
  const perp = [-dLng / len, dLat / len];
  const bend = (rand() - 0.5) * 0.3 * len;
  const n = 14;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wiggle = i === 0 || i === n ? 0 : (rand() - 0.5) * 0.035 * len;
    const off = Math.sin(Math.PI * t) * bend + wiggle;
    pts.push([
      +(p[0] + dLat * t + perp[0] * off).toFixed(5),
      +(p[1] + dLng * t + perp[1] * off).toFixed(5),
    ]);
  }
  return flip ? pts.reverse() : pts;
}

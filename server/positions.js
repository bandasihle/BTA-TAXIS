// Where taxis are. A taxi at a rank is at that rank (marshals record it). A taxi on a trip is
// where its driver's phone last said, if the driver has accepted the location notice and is
// sharing. Only the latest point per taxi is kept, never a history.
//
// Points from phones are not trusted: they must be inside South Africa, recent by the server's
// clock, physically possible after the last point, and from the driver linked to that taxi.
import { haversineKm, pointAlong } from './geo.js';
import { lateness } from '../public/js/trips.js';
import { STATUS } from './state.js';
import { HttpError } from './store.js';
import { CONSENT_VERSION } from '../public/js/consent.js';

export const FRESH_MS = 2 * 60_000; // older points are not shown on the map
const KEEP_MS = 10 * 60_000; // older points are deleted
const MIN_GAP_MS = 3_000; // one point every 3 seconds per driver at most
const MAX_AGE_MS = 2 * 60_000; // points queued on the phone for longer are dropped
const MAX_KMH = 180; // anything faster is a GPS glitch or a fake
const ARRIVE_KM = 0.15; // within 150 m of the destination rank counts as arrived...
const ARRIVE_ACCURACY_M = 100; // ...when the fix is at least this accurate

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

export class PositionSource {
  constructor(store, { now } = {}) {
    this.store = store;
    this.now = now ?? store.now;
    this.lastPing = new Map();
  }

  get db() {
    return this.store.db;
  }

  /**
   * Takes a GPS point from a signed-in driver. Returns { stored, message }: stored is false
   * (with the reason) when the point is valid but not needed, such as while the taxi is at a rank.
   */
  record(user, input = {}) {
    const t = this.now();
    if (user.locationConsentVersion !== CONSENT_VERSION) throw new HttpError(403, 'Read and accept the location notice first.');
    if (!user.taxiId) throw new HttpError(409, 'Your account is not linked to a taxi yet. Ask an admin to link it.');
    if (t - (this.lastPing.get(user.id) ?? 0) < MIN_GAP_MS) throw new HttpError(429, 'Too many positions. Send one every few seconds.');
    this.lastPing.set(user.id, t);

    const lat = num(input.lat);
    const lng = num(input.lng);
    const accuracy = num(input.accuracy);
    const at = num(input.at);
    if (!(lat >= -35 && lat <= -22 && lng >= 16 && lng <= 33)) throw new HttpError(400, 'That position is outside South Africa.');
    if (!(accuracy >= 0 && accuracy <= 5000)) throw new HttpError(400, 'Missing or impossible GPS accuracy.');
    if (!(Math.abs(t - at) <= MAX_AGE_MS)) return { stored: false, message: 'That position is too old to use.' };
    // Android marks positions from fake-location apps. A changed app could hide this, so it is
    // one check among the others, not proof.
    if (input.simulated === true) return { stored: false, message: 'Your phone is using a fake location app. Switch it off to share your position.' };

    const taxi = this.db.prepare('SELECT * FROM taxis WHERE id = ?').get(user.taxiId);
    if (!taxi) throw new HttpError(409, 'Your taxi is no longer registered. Ask an admin.');
    if (taxi.status !== STATUS.EN_ROUTE) {
      return { stored: false, message: taxi.status === STATUS.OFF_DUTY ? 'Your taxi is off duty. Your position is used once a marshal sends it on a trip.' : 'Your taxi is at a rank. Your position is used once it leaves on a trip.' };
    }

    const prev = this.db.prepare('SELECT * FROM positions WHERE taxi_id = ?').get(taxi.id);
    if (prev && t > prev.at) {
      const kmh = haversineKm([prev.lat, prev.lng], [lat, lng]) / ((t - prev.at) / 3_600_000);
      if (kmh > MAX_KMH) return { stored: false, message: 'That position jumped too far from the last one. Waiting for a steadier GPS signal.' };
    }

    this.db.prepare(
      `INSERT INTO positions (taxi_id, lat, lng, accuracy, at, user_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (taxi_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, at = excluded.at, user_id = excluded.user_id`,
    ).run(taxi.id, lat, lng, accuracy, t, user.id);

    // Arrived? Close enough to the destination rank with a good fix: record it like a marshal would.
    const dest = this.db.prepare(
      'SELECT k.lat, k.lng FROM trips t JOIN routes r ON r.id = t.route_id JOIN ranks k ON k.id = r.to_rank_id WHERE t.id = ?',
    ).get(taxi.trip_id);
    if (dest && accuracy <= ARRIVE_ACCURACY_M && haversineKm([lat, lng], [dest.lat, dest.lng]) <= ARRIVE_KM) {
      const r = this.store.act({ type: 'arrive', taxiId: taxi.id, by: `GPS (${user.name})` });
      return { stored: true, arrived: true, message: r.message };
    }
    this.store.emitChange();
    return { stored: true, message: 'Sharing your taxi\'s position.' };
  }

  /** Deletes a taxi's point straight away (consent withdrawn, account changed). */
  forget(taxiId) {
    if (taxiId != null) this.db.prepare('DELETE FROM positions WHERE taxi_id = ?').run(taxiId);
    this.store.emitChange();
  }

  /** Deletes points nobody has updated for a while. */
  sweep() {
    this.db.prepare('DELETE FROM positions WHERE at < ?').run(this.now() - KEEP_MS);
  }

  /** Route lines, parsed once per route and kept until the route's line changes. */
  #lines = new Map();
  #line(routeId, raw) {
    const hit = this.#lines.get(routeId);
    if (hit?.raw === raw) return hit.points;
    const points = JSON.parse(raw);
    this.#lines.set(routeId, { raw, points });
    return points;
  }

  /**
   * Every working taxi's position: taxis at a rank at the rank, taxis on a trip at their latest
   * fresh GPS point (rounded to about 10 m), with the expected time left on the trip.
   *
   *   [{ id, lat, lng, status, rankId?, routeId?, slot?, etaMs?, gps? }]
   *
   * With staff: true, a taxi on a trip with no fresh GPS is placed where it should be along its
   * route by now (estimated: true), and every trip says how late it is. Passengers never get
   * estimates: a guessed dot could send someone to wait for a taxi that is not there.
   *
   *   staff extras: { estimated?, lastGpsAt?, lateMs, overdue }
   */
  getPositions({ staff = false } = {}) {
    const t = this.now();
    const atRank = this.db.prepare(
      `SELECT x.id, x.status, x.rank_id, r.lat, r.lng, q.route_id, q.position
       FROM taxis x JOIN ranks r ON r.id = x.rank_id
       LEFT JOIN queue_entries q ON q.taxi_id = x.id
       WHERE x.status IN ('ARRIVED','QUEUED','LOADING')
       ORDER BY x.rank_id, q.route_id IS NULL, q.route_id, q.position, x.id`,
    ).all();
    const slots = new Map();
    const out = atRank.map((row) => {
      const slot = slots.get(row.rank_id) ?? 0;
      slots.set(row.rank_id, slot + 1);
      return { id: row.id, lat: row.lat, lng: row.lng, status: row.status, rankId: row.rank_id, routeId: row.route_id, slot };
    });
    const driving = this.db.prepare(
      `SELECT x.id, p.lat, p.lng, p.at, t.route_id, t.departed_at, t.duration_ms, r.polyline
       FROM taxis x JOIN trips t ON t.id = x.trip_id
       LEFT JOIN positions p ON p.taxi_id = x.id
       LEFT JOIN routes r ON r.id = t.route_id
       WHERE x.status = 'EN_ROUTE'`,
    ).all();
    for (const d of driving) {
      const fresh = d.at != null && d.at >= t - FRESH_MS;
      const base = { id: d.id, status: STATUS.EN_ROUTE, routeId: d.route_id, etaMs: Math.max(0, d.departed_at + d.duration_ms - t) };
      const late = staff ? lateness({ departedAt: d.departed_at, durationMs: d.duration_ms }, t) : null;
      const extras = late ? { lateMs: late.lateMs, overdue: late.overdue } : {};
      if (fresh) {
        out.push({ ...base, lat: +d.lat.toFixed(4), lng: +d.lng.toFixed(4), gps: true, ...extras });
      } else if (staff && d.polyline) {
        const progress = d.duration_ms > 0 ? (t - d.departed_at) / d.duration_ms : 1;
        const [lat, lng] = pointAlong(this.#line(d.route_id, d.polyline), Math.min(1, Math.max(0, progress)));
        out.push({
          ...base, lat: +lat.toFixed(4), lng: +lng.toFixed(4), gps: false, estimated: true,
          lastGpsAt: d.at != null && d.at >= d.departed_at ? d.at : null, ...extras,
        });
      }
    }
    return out;
  }
}

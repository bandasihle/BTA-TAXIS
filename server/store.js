import { EventEmitter } from 'node:events';
import { checkTransition, STATUS, TransitionError } from './state.js';
import { roadLine, lineLength, haversineKm } from './geo.js';
import { savedRoad, fetchRoad } from './roads.js';
import { slugify } from './db.js';
import { PROVINCES } from '../public/js/fares.js';

const REGION_IDS = new Set(PROVINCES.flatMap((p) => p.regions.map((r) => r.id)));
const TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const MAX_PRICE = 2000;

// Fare notice: an approved fare can start on a later day, so passengers are told before it
// changes. Days are South African dates (UTC+2 all year, no daylight saving).
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_NOTICE_DAYS = 90;
export const saDate = (ms) => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);

// A marshal marking the rank's spot must be standing at it with a good fix: the phone's
// accuracy has to be this tight, and the spot this close to where the rank already is.
const MAX_SPOT_ACCURACY_M = 50;
const MAX_SPOT_MOVE_KM = 25;
// "Rank full, use the holding area" is switched off by the marshal; a flag left on overnight
// stops counting after this long.
const HOLDING_MAX_MS = 12 * 3_600_000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A row id from a request: a positive whole number, or digits as text (from a URL or a form).
 * Anything else ([1], '1e3', true, ' 1') is null, so a permission check and the action it
 * guards can never read the same input as two different ids.
 */
export function toId(v) {
  if (Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v)) return Number(v);
  return null;
}

/** Optional free text: trimmed, at most `max` characters, or null. */
function optText(value, max, what) {
  const s = String(value ?? '').trim();
  if (s.length > max) throw new HttpError(400, `Keep the ${what} under ${max} characters.`);
  return s || null;
}

const AT_RANK = [STATUS.ARRIVED, STATUS.QUEUED, STATUS.LOADING];

// Expected time on the road, for "arriving in about 20 min": an average taxi speed plus
// stops. Real arrival is recorded by the marshal at the destination (later, by GPS).
const AVG_SPEED_KMH = 40;
const STOPS_MS = 5 * 60_000;
export const expectedTripMs = (km) => Math.round((km / AVG_SPEED_KMH) * 3_600_000 + STOPS_MS);

const rand = (cents) => `R${cents % 100 ? (cents / 100).toFixed(2) : cents / 100}`;

export function normalizePlate(plate) {
  return String(plate ?? '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * All reads and writes go through here. Every write emits 'change' so the server
 * can push a fresh snapshot to connected screens.
 */
export function createStore(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const emitter = new EventEmitter();

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  let depth = 0;
  function tx(fn) {
    if (depth) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }
  const changed = () => emitter.emit('change');

  const byId = (table, label) => (id) => {
    const n = toId(id);
    const row = n && one(`SELECT * FROM ${table} WHERE id = ?`, n);
    if (!row) throw new HttpError(404, `That ${label} does not exist.`);
    return row;
  };
  const getTaxi = byId('taxis', 'taxi');
  const getRank = byId('ranks', 'rank');
  const getRoute = byId('routes', 'route');
  const rankName = (id) => (id == null ? null : one('SELECT name FROM ranks WHERE id = ?', id)?.name ?? 'a removed rank');

  function log(taxiId, type, rankId, routeId, by, detail = null) {
    run(
      'INSERT INTO events (taxi_id, type, rank_id, route_id, at, by, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      taxiId ?? null, type, rankId ?? null, routeId ?? null, now(), by ?? 'marshal', detail,
    );
  }

  function compact(routeId) {
    all('SELECT id FROM queue_entries WHERE route_id = ? ORDER BY position, id', routeId)
      .forEach((row, i) => run('UPDATE queue_entries SET position = ? WHERE id = ?', i + 1, row.id));
  }

  // ---------------------------------------------------------------- taxi actions

  function act(input = {}) {
    const { type, by = 'marshal' } = input;
    if (!type) throw new HttpError(400, 'Missing action type.');
    if (input.taxiId == null) throw new HttpError(400, 'Choose a taxi first.');

    const result = tx(() => {
      const taxi = getTaxi(input.taxiId);
      const entry = one('SELECT * FROM queue_entries WHERE taxi_id = ?', taxi.id);

      switch (type) {
        case 'checkIn': {
          const rank = getRank(input.rankId);
          const route = getRoute(input.routeId);
          checkTransition('checkIn', taxi, {
            rankId: rank.id,
            route,
            rankName: rankName(entry?.rank_id ?? taxi.rank_id),
          });
          const position = (one('SELECT MAX(position) AS m FROM queue_entries WHERE route_id = ?', route.id).m ?? 0) + 1;
          run(
            'INSERT INTO queue_entries (taxi_id, rank_id, route_id, position, seats, status, enqueued_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
            taxi.id, rank.id, route.id, position, STATUS.QUEUED, now(),
          );
          run('UPDATE taxis SET status = ?, rank_id = ?, trip_id = NULL WHERE id = ?', STATUS.QUEUED, rank.id, taxi.id);
          const dest = rankName(route.to_rank_id);
          log(taxi.id, 'QUEUED', rank.id, route.id, by, `Joined the queue to ${dest} at number ${position}`);
          return { message: `${taxi.plate} is number ${position} in the queue to ${dest}` };
        }

        case 'seat': {
          const delta = Number(input.delta) < 0 ? -1 : 1;
          const next = checkTransition('seat', taxi, { seats: entry?.seats ?? 0, delta });
          const seats = entry.seats + delta;
          run('UPDATE queue_entries SET seats = ?, status = ? WHERE id = ?', seats, next, entry.id);
          run('UPDATE taxis SET status = ? WHERE id = ?', next, taxi.id);
          if (delta > 0 && seats === 1) log(taxi.id, 'LOADING', entry.rank_id, entry.route_id, by, 'Started loading passengers');
          if (seats === taxi.capacity) log(taxi.id, 'FULL', entry.rank_id, entry.route_id, by, `Full with ${seats} passengers`);
          return {
            seats,
            message: seats === taxi.capacity ? `${taxi.plate} is full` : `${taxi.plate}: ${seats} of ${taxi.capacity} seats filled`,
          };
        }

        case 'depart': {
          checkTransition('depart', taxi);
          const route = getRoute(entry.route_id);
          const durationMs = expectedTripMs(lineLength(JSON.parse(route.polyline)));
          const trip = run(
            'INSERT INTO trips (taxi_id, route_id, departed_at, seats_at_departure, duration_ms, speed_kmh) VALUES (?, ?, ?, ?, ?, ?)',
            taxi.id, route.id, now(), entry.seats, durationMs, AVG_SPEED_KMH,
          );
          const tripId = Number(trip.lastInsertRowid);
          run('DELETE FROM queue_entries WHERE id = ?', entry.id);
          compact(route.id);
          run('UPDATE taxis SET status = ?, rank_id = NULL, trip_id = ? WHERE id = ?', STATUS.EN_ROUTE, tripId, taxi.id);
          const dest = rankName(route.to_rank_id);
          log(taxi.id, 'DEPARTED', entry.rank_id, route.id, by, `Left for ${dest} with ${entry.seats} of ${taxi.capacity} passengers`);
          return { tripId, message: `${taxi.plate} departed to ${dest}` };
        }

        case 'arrive': {
          checkTransition('arrive', taxi);
          const trip = one('SELECT * FROM trips WHERE id = ?', taxi.trip_id);
          const route = trip ? one('SELECT * FROM routes WHERE id = ?', trip.route_id) : null;
          const destId = route?.to_rank_id ?? null;
          if (trip) run('UPDATE trips SET arrived_at = ? WHERE id = ?', now(), trip.id);
          run('DELETE FROM positions WHERE taxi_id = ?', taxi.id); // at the rank now: its GPS point is no longer needed
          run('UPDATE taxis SET status = ?, rank_id = ?, trip_id = NULL WHERE id = ?', destId ? STATUS.ARRIVED : STATUS.OFF_DUTY, destId, taxi.id);
          log(taxi.id, 'ARRIVED', destId, route?.id, by, destId ? `Arrived at ${rankName(destId)}` : 'Arrived; its route was removed');
          return { message: destId ? `${taxi.plate} arrived at ${rankName(destId)}` : `${taxi.plate} arrived` };
        }

        case 'remove': {
          checkTransition('remove', taxi);
          run('DELETE FROM queue_entries WHERE id = ?', entry.id);
          compact(entry.route_id);
          run('UPDATE taxis SET status = ? WHERE id = ?', STATUS.ARRIVED, taxi.id);
          log(taxi.id, 'REMOVED', entry.rank_id, entry.route_id, by, 'Taken off the queue, still at the rank');
          return { message: `${taxi.plate} taken off the queue` };
        }

        case 'offDuty': {
          checkTransition('offDuty', taxi);
          if (entry) {
            run('DELETE FROM queue_entries WHERE id = ?', entry.id);
            compact(entry.route_id);
          }
          run('UPDATE taxis SET status = ?, trip_id = NULL WHERE id = ?', STATUS.OFF_DUTY, taxi.id);
          run('DELETE FROM positions WHERE taxi_id = ?', taxi.id);
          log(taxi.id, 'OFF_DUTY', taxi.rank_id, entry?.route_id, by, 'Went off duty');
          return { message: `${taxi.plate} is off duty` };
        }

        case 'move': {
          checkTransition('move', taxi);
          const step = input.dir === 'down' ? 1 : -1;
          const other = one('SELECT * FROM queue_entries WHERE route_id = ? AND position = ?', entry.route_id, entry.position + step);
          if (!other) {
            throw new TransitionError(step < 0 ? `${taxi.plate} is already first in line.` : `${taxi.plate} is already last in line.`);
          }
          run('UPDATE queue_entries SET position = ? WHERE id = ?', other.position, entry.id);
          run('UPDATE queue_entries SET position = ? WHERE id = ?', entry.position, other.id);
          log(taxi.id, 'MOVED', entry.rank_id, entry.route_id, by, `Moved to number ${other.position}`);
          return { message: `${taxi.plate} is now number ${other.position}` };
        }

        default:
          throw new HttpError(400, `Unknown action "${type}".`);
      }
    });
    changed();
    return result;
  }

  /**
   * The rank an action happens at, for permission checks: where the taxi is checking in,
   * where it is queued or waiting, or (for an arrival) where its trip ends. Null when unknown.
   */
  function rankForAction(input = {}) {
    if (input.type === 'checkIn') return toId(input.rankId);
    const taxiId = toId(input.taxiId);
    const taxi = taxiId && one('SELECT * FROM taxis WHERE id = ?', taxiId);
    if (!taxi) return null;
    if (input.type === 'arrive') {
      return one('SELECT r.to_rank_id AS id FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ?', taxi.trip_id)?.id ?? null;
    }
    return one('SELECT rank_id FROM queue_entries WHERE taxi_id = ?', taxi.id)?.rank_id ?? taxi.rank_id ?? null;
  }

  // ---------------------------------------------------------------- taxis

  function createTaxi(input = {}) {
    const plate = normalizePlate(input.plate);
    if (plate.length < 4) throw new HttpError(400, 'Enter the full number plate.');
    const capacity = Number(input.capacity ?? 15);
    if (!Number.isInteger(capacity) || capacity < 4 || capacity > 35) {
      throw new HttpError(400, 'Seats must be a whole number from 4 to 35.');
    }
    if (one('SELECT id FROM taxis WHERE plate = ?', plate)) throw new HttpError(409, `${plate} is already registered.`);
    const homeRankId = input.homeRankId != null ? getRank(input.homeRankId).id : null;

    const id = tx(() => {
      let driverId = null;
      const driverName = optText(input.driverName, 60, 'driver name');
      if (driverName) driverId = Number(run('INSERT INTO drivers (name, phone) VALUES (?, ?)', driverName, optText(input.driverPhone, 20, 'driver phone')).lastInsertRowid);
      const res = run(
        'INSERT INTO taxis (plate, capacity, owner_name, driver_id, status, rank_id, home_rank_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        plate, capacity, optText(input.ownerName, 60, 'owner name'), driverId, STATUS.OFF_DUTY, homeRankId, homeRankId,
      );
      const taxiId = Number(res.lastInsertRowid);
      log(taxiId, 'REGISTERED', homeRankId, null, input.by ?? 'marshal', 'Registered as a new taxi');
      return taxiId;
    });
    changed();
    return { id, plate, message: `${plate} registered` };
  }

  function taxiHistory(id) {
    const taxi = getTaxi(id);
    const trips = all('SELECT * FROM trips WHERE taxi_id = ? ORDER BY departed_at DESC LIMIT 20', taxi.id).map(mapTrip);
    const events = all('SELECT * FROM events WHERE taxi_id = ? ORDER BY at DESC, id DESC LIMIT 40', taxi.id).map(mapEvent);
    return { taxiId: taxi.id, trips, events };
  }

  // ---------------------------------------------------------------- ranks & routes

  /** The saved road between two ranks, or a stand-in line until the real road arrives. */
  function lineBetween(a, b) {
    return JSON.stringify(savedRoad(a, b) ?? roadLine([a.lat, a.lng], [b.lat, b.lng], a.id, b.id));
  }

  // With fetchRoads on (the server, not the tests), a route with no saved road asks the
  // route planner for it and swaps it in when it arrives. No answer keeps the stand-in.
  function fetchMissingRoads(routeIds) {
    if (!opts.fetchRoads) return;
    for (const id of routeIds) {
      const r = one('SELECT * FROM routes WHERE id = ?', id);
      if (!r) continue;
      const a = getRank(r.from_rank_id);
      const b = getRank(r.to_rank_id);
      if (savedRoad(a, b)) continue;
      fetchRoad(a, b)
        .then((road) => {
          const now = one('SELECT r.id FROM routes r JOIN ranks f ON f.id = r.from_rank_id JOIN ranks t ON t.id = r.to_rank_id WHERE r.id = ? AND f.lat = ? AND f.lng = ? AND t.lat = ? AND t.lng = ?', id, a.lat, a.lng, b.lat, b.lng);
          if (!now) return; // deleted or moved again while we waited
          run('UPDATE routes SET polyline = ? WHERE id = ?', JSON.stringify(road), id);
          changed();
        })
        .catch((err) => console.warn(`No road for ${a.name} to ${b.name}: ${err.message}`));
    }
  }

  function validRankFields(input, partial = false) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Give the rank a name.');
      if (name.length > 60) throw new HttpError(400, 'Keep the rank name under 60 characters.');
      out.name = name;
    }
    for (const key of ['lat', 'lng']) {
      if (!partial || input[key] !== undefined) {
        const v = Number(input[key]);
        const ok = key === 'lat' ? v >= -35 && v <= -22 : v >= 16 && v <= 33;
        if (!Number.isFinite(v) || !ok) throw new HttpError(400, 'That position is outside South Africa.');
        out[key] = v;
      }
    }
    if (input.area !== undefined) out.area = optText(input.area, 80, 'area');
    if (input.note !== undefined) out.note = optText(input.note, 300, 'note');
    if (input.verified !== undefined) out.verified = input.verified ? 1 : 0;
    if (input.source !== undefined) out.source = optText(input.source, 200, 'source');
    if (input.regionId !== undefined) {
      // A rank with a region is listed for passengers to board at; without one it is only a destination.
      const regionId = input.regionId == null || input.regionId === '' ? null : String(input.regionId);
      if (regionId !== null && !REGION_IDS.has(regionId)) throw new HttpError(400, 'Choose one of the listed regions.');
      out.region_id = regionId;
    }
    return out;
  }

  /** A link-safe name for a new rank, unique among ranks. */
  function uniqueSlug(wanted, name) {
    const base = (/^[a-z0-9-]{1,50}$/.test(String(wanted ?? '')) ? wanted : slugify(name)) || 'rank';
    let slug = base;
    for (let n = 2; one('SELECT id FROM ranks WHERE slug = ?', slug); n++) slug = `${base}-${n}`;
    return slug;
  }

  function createRank(input = {}) {
    const f = validRankFields(input);
    const res = run(
      'INSERT INTO ranks (name, lat, lng, area, verified, source, note, slug, region_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.name, f.lat, f.lng, f.area ?? null, f.verified ?? 0, f.source ?? 'Added in the rank editor', f.note ?? null,
      uniqueSlug(input.slug, f.name), f.region_id ?? null,
    );
    changed();
    return { id: Number(res.lastInsertRowid), message: `${f.name} added` };
  }

  function updateRank(id, input = {}) {
    const rank = getRank(id);
    const f = validRankFields(input, true);
    const keys = Object.keys(f);
    if (!keys.length) return { id: rank.id, message: 'Nothing to change' };
    let moved = [];
    tx(() => {
      run(`UPDATE ranks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), rank.id);
      if (f.lat !== undefined || f.lng !== undefined) {
        const routes = all('SELECT * FROM routes WHERE from_rank_id = ? OR to_rank_id = ?', rank.id, rank.id);
        for (const r of routes) run('UPDATE routes SET polyline = ? WHERE id = ?', lineBetween(getRank(r.from_rank_id), getRank(r.to_rank_id)), r.id);
        moved = routes.map((r) => r.id);
      }
    });
    changed();
    fetchMissingRoads(moved);
    return { id: rank.id, message: `${f.name ?? rank.name} saved` };
  }

  function deleteRank(id) {
    const rank = getRank(id);
    const busy = one(`SELECT COUNT(*) AS n FROM taxis WHERE rank_id = ? AND status IN ('ARRIVED','QUEUED','LOADING')`, rank.id).n;
    if (busy) throw new HttpError(409, `${rank.name} still has ${busy} taxi${busy === 1 ? '' : 's'} at the rank. Move them or take them off duty first.`);
    const driving = one(
      `SELECT COUNT(*) AS n FROM trips t JOIN routes r ON r.id = t.route_id
       WHERE t.arrived_at IS NULL AND (r.from_rank_id = ? OR r.to_rank_id = ?)`, rank.id, rank.id,
    ).n;
    if (driving) throw new HttpError(409, `${driving} taxi${driving === 1 ? ' is' : 's are'} driving to or from ${rank.name}. Wait for them to arrive.`);
    tx(() => {
      run('UPDATE taxis SET rank_id = NULL WHERE rank_id = ?', rank.id);
      run('UPDATE taxis SET home_rank_id = NULL WHERE home_rank_id = ?', rank.id);
      run('DELETE FROM ranks WHERE id = ?', rank.id);
    });
    changed();
    return { message: `${rank.name} deleted` };
  }

  function createRoute(input = {}) {
    const from = getRank(input.fromRankId);
    const to = getRank(input.toRankId);
    if (from.id === to.id) throw new HttpError(400, 'Pick two different ranks.');
    const pairs = input.bothWays ? [[from, to], [to, from]] : [[from, to]];
    const created = [];
    tx(() => {
      for (const [a, b] of pairs) {
        if (one('SELECT id FROM routes WHERE from_rank_id = ? AND to_rank_id = ?', a.id, b.id)) continue;
        created.push(Number(run('INSERT INTO routes (from_rank_id, to_rank_id, polyline) VALUES (?, ?, ?)', a.id, b.id, lineBetween(a, b)).lastInsertRowid));
      }
    });
    if (!created.length) throw new HttpError(409, `${from.name} to ${to.name} already exists.`);
    changed();
    fetchMissingRoads(created);
    return { ids: created, message: created.length === 2 ? `${from.name} and ${to.name} linked both ways` : `${from.name} to ${to.name} added` };
  }

  function deleteRoute(id) {
    const route = getRoute(id);
    const label = `${rankName(route.from_rank_id)} to ${rankName(route.to_rank_id)}`;
    const queued = one('SELECT COUNT(*) AS n FROM queue_entries WHERE route_id = ?', route.id).n;
    if (queued) throw new HttpError(409, `${queued} taxi${queued === 1 ? ' is' : 's are'} queued for ${label}. Clear the queue first.`);
    const driving = one('SELECT COUNT(*) AS n FROM trips WHERE route_id = ? AND arrived_at IS NULL', route.id).n;
    if (driving) throw new HttpError(409, `${driving} taxi${driving === 1 ? ' is' : 's are'} on the road for ${label}. Wait for them to arrive.`);
    run('DELETE FROM routes WHERE id = ?', route.id);
    changed();
    return { message: `${label} deleted` };
  }

  // ---------------------------------------------------------------- fares

  /** The hours and price from a request, checked. Exact types only: a list like ["04:00"] would otherwise slip through as text. */
  function validFare(input) {
    const from = typeof input.from === 'string' ? input.from : '';
    const until = typeof input.until === 'string' ? input.until : '';
    if (!TIME.test(from) || !TIME.test(until)) throw new HttpError(400, 'Times must look like 04:30. Use 24:00 for midnight.');
    if (minutesOf(from) >= minutesOf(until)) throw new HttpError(400, 'The last taxi must leave after the first one.');
    const price = typeof input.price === 'number' || typeof input.price === 'string' ? Number(input.price) : NaN;
    const cents = Math.round(price * 100);
    if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE || Math.abs(cents - price * 100) > 1e-6) {
      throw new HttpError(400, `Enter the price in rand, more than 0 and up to R${MAX_PRICE}, like 25 or 12.50.`);
    }
    return { from_time: from, until_time: until, price_cents: cents };
  }

  /**
   * The day a fare starts: null for "now" (nothing given, or today), or a South African date
   * up to 90 days ahead. `lenient` turns a day that has passed into "now" (a request that
   * waited for approval past its date); otherwise a past day is refused.
   */
  function validStart(value, { lenient = false } = {}) {
    if (value == null || value === '') return null;
    const real = typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!real) throw new HttpError(400, 'Choose a real start date.');
    const today = saDate(now());
    if (value === today || (lenient && value < today)) return null;
    if (value < today) throw new HttpError(400, 'That start date has passed. Choose today or a later day.');
    if (value > saDate(now() + MAX_NOTICE_DAYS * DAY_MS)) throw new HttpError(400, `Choose a start date in the next ${MAX_NOTICE_DAYS} days.`);
    return value;
  }

  const fareText = (f) => `${f.from_time}–${f.until_time}, ${rand(f.price_cents)}`;
  const routeLabel = (route) => `${rankName(route.from_rank_id)} to ${rankName(route.to_rank_id)}`;

  /** Writes a checked fare: now, or as a planned change for `start`. Call inside tx(). */
  function writeFare(route, fare, start, by, note = '') {
    const label = routeLabel(route);
    const before = one('SELECT * FROM fares WHERE route_id = ?', route.id);
    if (start) {
      run(
        `INSERT INTO fare_changes (route_id, from_time, until_time, price_cents, starts_on, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (route_id) DO UPDATE SET from_time = excluded.from_time, until_time = excluded.until_time,
           price_cents = excluded.price_cents, starts_on = excluded.starts_on, set_at = excluded.set_at, set_by = excluded.set_by`,
        route.id, fare.from_time, fare.until_time, fare.price_cents, start, now(), by,
      );
      log(null, 'FARE', route.from_rank_id, route.id, by, `${label}: ${before ? `${fareText(before)} changes to` : 'fare will be'} ${fareText(fare)} on ${start}${note}`);
      return { message: `${label} will change on ${start}` };
    }
    if (before && fareText(before) === fareText(fare)) return { message: 'Nothing to change' };
    run(
      `INSERT INTO fares (route_id, from_time, until_time, price_cents, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (route_id) DO UPDATE SET from_time = excluded.from_time, until_time = excluded.until_time,
         price_cents = excluded.price_cents, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      route.id, fare.from_time, fare.until_time, fare.price_cents, now(), by,
    );
    log(null, 'FARE', route.from_rank_id, route.id, by, `${label}: ${before ? `${fareText(before)} changed to ${fareText(fare)}` : `fare set to ${fareText(fare)}`}${note}`);
    return { message: `${label} saved` };
  }

  /**
   * Sets the passenger fare on a route: the hours taxis run and the price. One fare per
   * route. With `startsOn` (a later day) the fare is kept as a planned change and passengers
   * are shown the notice until that day. Every change goes in the event log with who made it
   * and what it was before.
   */
  function setFare(routeId, input = {}, by = 'admin') {
    const route = getRoute(routeId);
    const fare = validFare(input);
    const start = validStart(input.startsOn);
    const result = tx(() => writeFare(route, fare, start, by));
    changed();
    return result;
  }

  /** Drops a planned fare change before its day. */
  function cancelFareChange(routeId, by = 'admin') {
    const route = getRoute(routeId);
    const planned = one('SELECT * FROM fare_changes WHERE route_id = ?', route.id);
    if (!planned) throw new HttpError(404, 'That route has no planned fare change.');
    tx(() => {
      run('DELETE FROM fare_changes WHERE route_id = ?', route.id);
      log(null, 'FARE', route.from_rank_id, route.id, by, `${routeLabel(route)}: planned change to ${fareText(planned)} on ${planned.starts_on} cancelled`);
    });
    changed();
    return { message: `${routeLabel(route)} keeps its fare` };
  }

  /** Makes planned fares the fare once their day has come. The server runs this every minute. */
  function applyDueFares() {
    const due = all('SELECT * FROM fare_changes WHERE starts_on <= ? ORDER BY route_id', saDate(now()));
    if (!due.length) return 0;
    tx(() => {
      for (const c of due) {
        const route = one('SELECT * FROM routes WHERE id = ?', c.route_id);
        run('DELETE FROM fare_changes WHERE route_id = ?', c.route_id);
        if (route) writeFare(route, c, null, c.set_by ?? 'admin', ' (planned change)');
      }
    });
    changed();
    return due.length;
  }

  function deleteFare(routeId, by = 'admin') {
    const route = getRoute(routeId);
    const before = one('SELECT * FROM fares WHERE route_id = ?', route.id);
    if (!before) throw new HttpError(404, 'That route has no fare.');
    const label = `${rankName(route.from_rank_id)} to ${rankName(route.to_rank_id)}`;
    tx(() => {
      run('DELETE FROM fares WHERE route_id = ?', route.id);
      run('DELETE FROM fare_changes WHERE route_id = ?', route.id);
      log(null, 'FARE', route.from_rank_id, route.id, by, `${label}: fare removed (was ${before.from_time}–${before.until_time}, ${rand(before.price_cents)})`);
    });
    changed();
    return { message: `${label} is no longer shown to passengers` };
  }

  // ---------------------------------------------------------------- requests (a marshal asks, the office decides)

  const getProposal = byId('proposals', 'request');

  /** The marshal's own rank, from their session. A marshal with no rank can't ask for anything. */
  function marshalRank(user) {
    const id = toId(user?.rankId);
    const rank = id && one('SELECT * FROM ranks WHERE id = ?', id);
    if (!rank) throw new HttpError(403, 'Your account is not linked to a rank. Ask the office to set your rank.');
    return rank;
  }

  /** One open request per thing: a marshal replaces their own, and can't overwrite a colleague's. */
  function openRequest(user, where, ...params) {
    const open = one(`SELECT * FROM proposals WHERE status = 'PENDING' AND ${where}`, ...params);
    if (open && open.proposed_by_id !== user.id) {
      throw new HttpError(409, `${open.proposed_by} already sent this to the office. It must be decided first.`);
    }
    return open;
  }

  /**
   * A marshal asks for a fare from their own rank to a destination: hours, price and the day
   * it starts. Passengers see nothing until an admin approves it.
   */
  function proposeFare(user, input = {}) {
    const rank = marshalRank(user);
    const to = getRank(input.toRankId);
    if (to.id === rank.id) throw new HttpError(400, 'Choose a destination other than your own rank.');
    const fare = validFare(input);
    const start = validStart(input.startsOn);
    const route = one('SELECT * FROM routes WHERE from_rank_id = ? AND to_rank_id = ?', rank.id, to.id);
    const live = route && one('SELECT * FROM fares WHERE route_id = ?', route.id);
    if (live && !start && fareText(live) === fareText(fare)) throw new HttpError(409, 'That is already the fare passengers see.');
    tx(() => {
      const open = openRequest(user, `kind = 'FARE' AND rank_id = ? AND to_rank_id = ?`, rank.id, to.id);
      if (open) run('DELETE FROM proposals WHERE id = ?', open.id);
      run(
        `INSERT INTO proposals (kind, rank_id, to_rank_id, from_time, until_time, price_cents, starts_on, proposed_by_id, proposed_by, proposed_at)
         VALUES ('FARE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rank.id, to.id, fare.from_time, fare.until_time, fare.price_cents, start, user.id, user.name, now(),
      );
    });
    changed();
    return { message: `Sent to the office: ${to.name}, ${fareText(fare)}` };
  }

  /** A marshal standing at their rank sends its spot from their phone. An admin approves it before the pin moves. */
  function proposeLocation(user, input = {}) {
    const rank = marshalRank(user);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const lat = num(input.lat);
    const lng = num(input.lng);
    const accuracy = num(input.accuracy);
    if (!(lat >= -35 && lat <= -22) || !(lng >= 16 && lng <= 33)) throw new HttpError(400, 'That position is outside South Africa.');
    if (!(accuracy > 0)) throw new HttpError(400, 'Your phone did not say how accurate its location is. Try again.');
    if (accuracy > MAX_SPOT_ACCURACY_M) {
      throw new HttpError(400, `Your phone's location is only accurate to about ${Math.round(accuracy)} m. Stand in the open at the rank and try again.`);
    }
    const km = haversineKm([rank.lat, rank.lng], [lat, lng]);
    if (km > MAX_SPOT_MOVE_KM) {
      throw new HttpError(400, `You are about ${Math.round(km)} km from where ${rank.name} is on the map. Mark it while standing at the rank, or ask the office to move the pin.`);
    }
    tx(() => {
      const open = openRequest(user, `kind = 'LOCATION' AND rank_id = ?`, rank.id);
      if (open) run('DELETE FROM proposals WHERE id = ?', open.id);
      run(
        `INSERT INTO proposals (kind, rank_id, lat, lng, accuracy, proposed_by_id, proposed_by, proposed_at) VALUES ('LOCATION', ?, ?, ?, ?, ?, ?, ?)`,
        rank.id, +lat.toFixed(6), +lng.toFixed(6), Math.max(1, Math.round(accuracy)), user.id, user.name, now(),
      );
    });
    changed();
    return { message: `Sent to the office: the spot for ${rank.name}` };
  }

  /** The marshal takes back their own request before the office decides. */
  function withdrawProposal(id, user) {
    const p = getProposal(id);
    if (p.proposed_by_id !== user.id) throw new HttpError(403, 'You can only take back what you sent.');
    if (p.status !== 'PENDING') throw new HttpError(409, 'The office has already decided on that.');
    run(`UPDATE proposals SET status = 'WITHDRAWN', decided_at = ? WHERE id = ?`, now(), p.id);
    changed();
    return { message: 'Taken back' };
  }

  /**
   * An admin approves or declines a marshal's request. Approving a fare adds the route (both
   * ways) when it is new, then sets the fare, now or as a planned change. Approving a spot
   * moves the rank's pin and marks it checked.
   */
  function decideProposal(id, admin, input = {}) {
    if (typeof input.approve !== 'boolean') throw new HttpError(400, 'Say whether to approve or decline.');
    const reason = input.approve ? null : optText(input.reason, 200, 'reason');
    const newRoutes = [];
    const result = tx(() => {
      const p = getProposal(id);
      if (p.status !== 'PENDING') throw new HttpError(409, 'That request has already been decided or taken back.');
      const rank = getRank(p.rank_id);
      const sentBy = ` (sent by ${p.proposed_by})`;
      let message;
      if (!input.approve) {
        const what = p.kind === 'FARE' ? `fare to ${rankName(p.to_rank_id)} (${fareText(p)})` : 'rank spot';
        log(null, p.kind === 'FARE' ? 'FARE' : 'RANK', rank.id, null, admin.name, `${rank.name}: ${what} declined${reason ? `: ${reason}` : ''}${sentBy}`);
        message = 'Declined';
      } else if (p.kind === 'FARE') {
        const to = getRank(p.to_rank_id);
        for (const [a, b] of [[rank, to], [to, rank]]) {
          if (one('SELECT id FROM routes WHERE from_rank_id = ? AND to_rank_id = ?', a.id, b.id)) continue;
          newRoutes.push(Number(run('INSERT INTO routes (from_rank_id, to_rank_id, polyline) VALUES (?, ?, ?)', a.id, b.id, lineBetween(a, b)).lastInsertRowid));
        }
        const route = one('SELECT * FROM routes WHERE from_rank_id = ? AND to_rank_id = ?', rank.id, to.id);
        message = writeFare(route, p, validStart(p.starts_on, { lenient: true }), admin.name, sentBy).message;
      } else {
        const km = haversineKm([rank.lat, rank.lng], [p.lat, p.lng]);
        updateRank(rank.id, { lat: p.lat, lng: p.lng, verified: true, source: `Marked at the rank by ${p.proposed_by}`, note: '' });
        log(null, 'RANK', rank.id, null, admin.name, `${rank.name}: pin moved ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} to the spot marked at the rank${sentBy}`);
        message = `${rank.name} is now on the exact spot`;
      }
      run('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?', input.approve ? 'APPROVED' : 'DECLINED', admin.name, now(), reason, p.id);
      return { message };
    });
    changed();
    fetchMissingRoads(newRoutes);
    return result;
  }

  // ---------------------------------------------------------------- holding area

  /** The marshal says the rank is full and taxis must wait in the holding area, or that there is space again. */
  function setHolding(rankId, on, by = 'marshal') {
    if (typeof on !== 'boolean') throw new HttpError(400, 'Say whether the holding area is in use.');
    const rank = getRank(rankId);
    const active = rank.holding_since != null && now() - rank.holding_since < HOLDING_MAX_MS;
    if (active === on) return { message: on ? 'The holding area is already in use' : 'The rank already has space' };
    tx(() => {
      run('UPDATE ranks SET holding_since = ? WHERE id = ?', on ? now() : null, rank.id);
      log(null, 'HOLDING', rank.id, null, by, on ? `${rank.name} is full: taxis wait in the holding area` : `${rank.name} has space again`);
    });
    changed();
    return { message: on ? 'Holding area in use. Drivers and passengers can see it.' : 'The rank has space again' };
  }

  // ---------------------------------------------------------------- reads

  const mapTrip = (t) => ({
    id: t.id, taxiId: t.taxi_id, routeId: t.route_id, departedAt: t.departed_at, arrivedAt: t.arrived_at,
    seatsAtDeparture: t.seats_at_departure, durationMs: t.duration_ms, speedKmh: t.speed_kmh,
  });
  const mapProposal = (p) => ({
    id: p.id, kind: p.kind, rankId: p.rank_id, toRankId: p.to_rank_id, status: p.status,
    from: p.from_time, until: p.until_time, price: p.price_cents == null ? null : p.price_cents / 100, startsOn: p.starts_on,
    lat: p.lat, lng: p.lng, accuracy: p.accuracy,
    byId: p.proposed_by_id, by: p.proposed_by, at: p.proposed_at, decidedBy: p.decided_by, decidedAt: p.decided_at, reason: p.reason,
  });
  const mapEvent = (e) => ({
    id: e.id, taxiId: e.taxi_id, type: e.type, rankId: e.rank_id, routeId: e.route_id, at: e.at, by: e.by, detail: e.detail,
  });

  function snapshot() {
    return {
      ranks: all('SELECT * FROM ranks ORDER BY name').map((r) => {
        const holding = r.holding_since != null && now() - r.holding_since < HOLDING_MAX_MS;
        return {
          id: r.id, slug: r.slug, name: r.name, lat: r.lat, lng: r.lng, area: r.area, regionId: r.region_id,
          verified: !!r.verified, source: r.source, note: r.note, holding, holdingSince: holding ? r.holding_since : null,
        };
      }),
      fareChanges: all('SELECT * FROM fare_changes ORDER BY route_id').map((c) => ({
        routeId: c.route_id, from: c.from_time, until: c.until_time, price: c.price_cents / 100, startsOn: c.starts_on, setBy: c.set_by,
      })),
      // every open request, and the latest decisions so a marshal sees what the office said
      proposals: all(`SELECT * FROM proposals WHERE status = 'PENDING'
                      OR id IN (SELECT id FROM proposals WHERE status IN ('APPROVED', 'DECLINED') ORDER BY decided_at DESC LIMIT 40)
                      ORDER BY proposed_at DESC, id DESC`).map(mapProposal),
      fares: all('SELECT * FROM fares ORDER BY route_id').map((f) => ({
        routeId: f.route_id, from: f.from_time, until: f.until_time, price: f.price_cents / 100, updatedAt: f.updated_at, updatedBy: f.updated_by,
      })),
      routes: all('SELECT * FROM routes ORDER BY id').map((r) => {
        const polyline = JSON.parse(r.polyline);
        return { id: r.id, fromRankId: r.from_rank_id, toRankId: r.to_rank_id, polyline, km: +lineLength(polyline).toFixed(1) };
      }),
      taxis: all(`SELECT t.*, d.name AS driver_name, d.phone AS driver_phone FROM taxis t LEFT JOIN drivers d ON d.id = t.driver_id ORDER BY t.plate`).map((t) => ({
        id: t.id, plate: t.plate, capacity: t.capacity, ownerName: t.owner_name, driverId: t.driver_id, driverName: t.driver_name,
        status: t.status, rankId: t.rank_id, homeRankId: t.home_rank_id, tripId: t.trip_id,
      })),
      queue: all('SELECT * FROM queue_entries ORDER BY route_id, position').map((q) => ({
        id: q.id, taxiId: q.taxi_id, rankId: q.rank_id, routeId: q.route_id, position: q.position, seats: q.seats, status: q.status, enqueuedAt: q.enqueued_at,
      })),
      trips: all(`SELECT * FROM trips WHERE arrived_at IS NULL
                  OR id IN (SELECT id FROM trips WHERE arrived_at IS NOT NULL ORDER BY arrived_at DESC LIMIT 40)
                  ORDER BY departed_at DESC`).map(mapTrip),
      events: all('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT 100').map(mapEvent),
      marshals: all(`SELECT id, name, rank_id FROM users WHERE role = 'marshal' AND active = 1 ORDER BY name`).map((m) => ({ id: m.id, name: m.name, rankId: m.rank_id })),
      meta: { serverTime: now() },
    };
  }

  /**
   * What passengers may see: ranks, routes, queues and taxis by plate and seats, and
   * open trips for arrival times. No driver, owner or marshal details, and no event log.
   */
  function publicSnapshot() {
    const s = snapshot();
    return {
      ranks: s.ranks.map(({ id, slug, name, lat, lng, area, regionId, verified, holding }) => ({ id, slug, name, lat, lng, area, regionId, verified, holding })),
      routes: s.routes,
      fares: s.fares.map(({ routeId, from, until, price }) => ({ routeId, from, until, price })),
      fareChanges: s.fareChanges.map(({ routeId, from, until, price, startsOn }) => ({ routeId, from, until, price, startsOn })),
      proposals: [],
      taxis: s.taxis.map(({ id, plate, capacity, status, rankId, tripId }) => ({ id, plate, capacity, status, rankId, tripId })),
      queue: s.queue.map(({ id, taxiId, rankId, routeId, position, seats, status }) => ({ id, taxiId, rankId, routeId, position, seats, status })),
      trips: s.trips.filter((t) => !t.arrivedAt).map(({ id, taxiId, routeId, departedAt, durationMs }) => ({ id, taxiId, routeId, departedAt, durationMs })),
      events: [],
      marshals: [],
      meta: s.meta,
    };
  }

  function isEmpty() {
    return one('SELECT COUNT(*) AS n FROM ranks').n === 0;
  }

  return {
    db, tx, act, rankForAction, createTaxi, taxiHistory, createRank, updateRank, deleteRank, createRoute, deleteRoute,
    setFare, deleteFare, cancelFareChange, applyDueFares,
    proposeFare, proposeLocation, withdrawProposal, decideProposal, setHolding,
    snapshot, publicSnapshot, isEmpty, now,
    on: (...a) => emitter.on(...a),
    off: (...a) => emitter.off(...a),
    emitChange: changed,
    /** Run a batch of writes and emit only one change at the end. */
    quietly(fn) {
      const emit = emitter.emit;
      emitter.emit = () => false;
      try { return fn(); } finally { emitter.emit = emit; changed(); }
    },
  };
}

export { AT_RANK };

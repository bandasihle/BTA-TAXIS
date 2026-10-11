import { EventEmitter } from 'node:events';
import { checkTransition, STATUS, TransitionError } from './state.js';
import { roadLine, lineLength } from './geo.js';
import { savedRoad, fetchRoad } from './roads.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const AT_RANK = [STATUS.ARRIVED, STATUS.QUEUED, STATUS.LOADING];

export function normalizePlate(plate) {
  return String(plate ?? '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * All reads and writes go through here. Every write emits 'change' so the server
 * can push a fresh snapshot to connected screens.
 */
export function createStore(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const emitter = new EventEmitter();
  const settings = { demo: opts.demo ?? false, simScale: opts.simScale ?? 20 };

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
    const row = one(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
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
          const km = lineLength(JSON.parse(route.polyline));
          const speed = 30 + random() * 30;
          const durationMs = Math.max(20_000, Math.round(((km / speed) * 3_600_000) / settings.simScale));
          const trip = run(
            'INSERT INTO trips (taxi_id, route_id, departed_at, seats_at_departure, duration_ms, speed_kmh) VALUES (?, ?, ?, ?, ?, ?)',
            taxi.id, route.id, now(), entry.seats, durationMs, +speed.toFixed(1),
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
      const driverName = String(input.driverName ?? '').trim();
      if (driverName) driverId = Number(run('INSERT INTO drivers (name, phone) VALUES (?, ?)', driverName, input.driverPhone ?? null).lastInsertRowid);
      const res = run(
        'INSERT INTO taxis (plate, capacity, owner_name, driver_id, status, rank_id, home_rank_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        plate, capacity, String(input.ownerName ?? '').trim() || null, driverId, STATUS.OFF_DUTY, homeRankId, homeRankId,
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
    if (input.area !== undefined) out.area = String(input.area ?? '').trim() || null;
    if (input.note !== undefined) out.note = String(input.note ?? '').trim() || null;
    if (input.verified !== undefined) out.verified = input.verified ? 1 : 0;
    if (input.source !== undefined) out.source = String(input.source ?? '').trim() || null;
    return out;
  }

  function createRank(input = {}) {
    const f = validRankFields(input);
    const res = run(
      'INSERT INTO ranks (name, lat, lng, area, verified, source, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.name, f.lat, f.lng, f.area ?? null, f.verified ?? 0, f.source ?? 'Added in the rank editor', f.note ?? null,
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

  // ---------------------------------------------------------------- reads

  const mapTrip = (t) => ({
    id: t.id, taxiId: t.taxi_id, routeId: t.route_id, departedAt: t.departed_at, arrivedAt: t.arrived_at,
    seatsAtDeparture: t.seats_at_departure, durationMs: t.duration_ms, speedKmh: t.speed_kmh,
  });
  const mapEvent = (e) => ({
    id: e.id, taxiId: e.taxi_id, type: e.type, rankId: e.rank_id, routeId: e.route_id, at: e.at, by: e.by, detail: e.detail,
  });

  function snapshot() {
    return {
      ranks: all('SELECT * FROM ranks ORDER BY name').map((r) => ({
        id: r.id, name: r.name, lat: r.lat, lng: r.lng, area: r.area, verified: !!r.verified, source: r.source, note: r.note,
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
      marshals: all('SELECT * FROM marshals ORDER BY name').map((m) => ({ id: m.id, name: m.name, rankId: m.rank_id })),
      meta: { demo: settings.demo, simScale: settings.simScale, serverTime: now(), demoData: true },
    };
  }

  function isEmpty() {
    return one('SELECT COUNT(*) AS n FROM ranks').n === 0;
  }

  function setDemo(on) {
    settings.demo = !!on;
    changed();
    return { demo: settings.demo, message: settings.demo ? 'Demo mode on' : 'Demo mode off' };
  }

  return {
    db, tx, act, createTaxi, taxiHistory, createRank, updateRank, deleteRank, createRoute, deleteRoute,
    snapshot, isEmpty, setDemo, settings, now, random,
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

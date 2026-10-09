import { pointAlong } from './geo.js';
import { STATUS } from './state.js';

/**
 * A PositionSource answers "where is every working taxi right now?".
 *
 *   getPositions(t) -> [{ id, lat, lng, status, rankId?, slot?, progress?, etaMs? }]
 *   dueArrivals(t)  -> taxi ids that have reached their destination
 *
 * This one works the positions out from trip timings along each route line.
 * A real version would read the last GPS ping from each driver's phone and use
 * geofences around ranks for dueArrivals(); the screens would not change.
 */
export class SimulatedPositionSource {
  constructor(store) {
    this.store = store;
  }

  openTrips() {
    return this.store.db.prepare(
      `SELECT t.id, t.taxi_id, t.route_id, t.departed_at, t.duration_ms, r.polyline
       FROM trips t JOIN routes r ON r.id = t.route_id
       JOIN taxis x ON x.id = t.taxi_id AND x.trip_id = t.id
       WHERE t.arrived_at IS NULL`,
    ).all();
  }

  getPositions(t = this.store.now()) {
    const out = [];
    for (const trip of this.openTrips()) {
      const progress = Math.min(1, Math.max(0, (t - trip.departed_at) / trip.duration_ms));
      const [lat, lng] = pointAlong(JSON.parse(trip.polyline), progress);
      out.push({
        id: trip.taxi_id, lat: +lat.toFixed(5), lng: +lng.toFixed(5), status: STATUS.EN_ROUTE,
        routeId: trip.route_id, progress: +progress.toFixed(3), etaMs: Math.max(0, trip.departed_at + trip.duration_ms - t),
      });
    }
    const atRank = this.store.db.prepare(
      `SELECT x.id, x.status, x.rank_id, r.lat, r.lng, q.route_id, q.position
       FROM taxis x JOIN ranks r ON r.id = x.rank_id
       LEFT JOIN queue_entries q ON q.taxi_id = x.id
       WHERE x.status IN ('ARRIVED','QUEUED','LOADING')
       ORDER BY x.rank_id, q.route_id IS NULL, q.route_id, q.position, x.id`,
    ).all();
    const slots = new Map();
    for (const row of atRank) {
      const slot = slots.get(row.rank_id) ?? 0;
      slots.set(row.rank_id, slot + 1);
      out.push({ id: row.id, lat: row.lat, lng: row.lng, status: row.status, rankId: row.rank_id, routeId: row.route_id, slot });
    }
    return out;
  }

  dueArrivals(t = this.store.now()) {
    return this.openTrips().filter((trip) => t >= trip.departed_at + trip.duration_ms).map((trip) => trip.taxi_id);
  }
}

/** Moves simulated taxis to their destination and, in demo mode, plays the part of busy marshals. */
export class Simulator {
  constructor(store, source, { tickMs = 1000, demoEveryMs = 2500 } = {}) {
    this.store = store;
    this.source = source;
    this.tickMs = tickMs;
    this.demoEveryMs = demoEveryMs;
    this.lastDemo = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const t = this.store.now();
    for (const taxiId of this.source.dueArrivals(t)) this.try({ type: 'arrive', taxiId, by: 'simulator' });
    if (this.store.settings.demo && t - this.lastDemo >= this.demoEveryMs) {
      this.lastDemo = t;
      this.demoStep();
    }
  }

  try(action) {
    try {
      return this.store.act(action);
    } catch {
      return null; // the state moved on underneath us; skip
    }
  }

  demoStep() {
    const { random } = this.store;
    const s = this.store.snapshot();
    const taxis = new Map(s.taxis.map((t) => [t.id, t]));
    const routesFrom = (rankId) => s.routes.filter((r) => r.fromRankId === rankId);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const by = 'demo';

    const fronts = new Map();
    for (const q of s.queue) if (!fronts.has(q.routeId)) fronts.set(q.routeId, q);

    this.store.quietly(() => {
      for (const front of fronts.values()) {
        const taxi = taxis.get(front.taxiId);
        if (!taxi) continue;
        if (front.seats >= taxi.capacity) {
          if (random() < 0.5) this.try({ type: 'depart', taxiId: taxi.id, by });
        } else if (random() < 0.55) {
          this.try({ type: 'seat', taxiId: taxi.id, delta: 1, by });
          if (random() < 0.3 && front.seats + 1 < taxi.capacity) this.try({ type: 'seat', taxiId: taxi.id, delta: 1, by });
        } else if (front.seats >= taxi.capacity - 2 && random() < 0.08) {
          this.try({ type: 'depart', taxiId: taxi.id, by });
        }
      }
      for (const taxi of s.taxis) {
        if (taxi.status === STATUS.ARRIVED) {
          const r = random();
          if (r < 0.2) {
            const route = pick(routesFrom(taxi.rankId));
            if (route) this.try({ type: 'checkIn', taxiId: taxi.id, rankId: taxi.rankId, routeId: route.id, by });
          } else if (r < 0.215) {
            this.try({ type: 'offDuty', taxiId: taxi.id, by });
          }
        } else if (taxi.status === STATUS.OFF_DUTY && random() < 0.03) {
          const rankId = taxi.rankId ?? taxi.homeRankId;
          const route = rankId != null && pick(routesFrom(rankId));
          if (route) this.try({ type: 'checkIn', taxiId: taxi.id, rankId, routeId: route.id, by });
        }
      }
    });
  }
}

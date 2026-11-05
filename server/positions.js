/**
 * A PositionSource answers "where is every working taxi right now?".
 *
 *   getPositions(t) -> [{ id, lat, lng, status, rankId?, routeId?, slot? }]
 *
 * This one only knows what marshals record: a taxi at a rank is at that rank. Taxis on
 * the road have no position until drivers' phones send GPS; the screens show them in
 * lists with an expected arrival time instead of guessing a spot on the map.
 */
export class RankPositionSource {
  constructor(store) {
    this.store = store;
  }

  getPositions() {
    const atRank = this.store.db.prepare(
      `SELECT x.id, x.status, x.rank_id, r.lat, r.lng, q.route_id, q.position
       FROM taxis x JOIN ranks r ON r.id = x.rank_id
       LEFT JOIN queue_entries q ON q.taxi_id = x.id
       WHERE x.status IN ('ARRIVED','QUEUED','LOADING')
       ORDER BY x.rank_id, q.route_id IS NULL, q.route_id, q.position, x.id`,
    ).all();
    const slots = new Map();
    return atRank.map((row) => {
      const slot = slots.get(row.rank_id) ?? 0;
      slots.set(row.rank_id, slot + 1);
      return { id: row.id, lat: row.lat, lng: row.lng, status: row.status, rankId: row.rank_id, routeId: row.route_id, slot };
    });
  }
}

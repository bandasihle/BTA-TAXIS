// How late a trip is. Shared by the server and the staff screens so they always agree.

/** A trip counts as overdue once it is late by its own length, and by at least 10 minutes. */
const MIN_OVERDUE_MS = 10 * 60_000;

/**
 * @param {{ departedAt: number, durationMs: number }} trip
 * @param {number} now
 * @returns {{ dueAt: number, lateMs: number, overdue: boolean }}
 */
export function lateness(trip, now) {
  const dueAt = trip.departedAt + trip.durationMs;
  const lateMs = Math.max(0, now - dueAt);
  return { dueAt, lateMs, overdue: lateMs >= Math.max(trip.durationMs, MIN_OVERDUE_MS) };
}

/** A length of time in words: "45 min", "3 h 5 min", "2 days". */
export function span(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

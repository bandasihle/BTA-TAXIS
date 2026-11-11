// When a trip counts as late, shared by the server and the staff screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateness, span } from '../public/js/trips.js';

test('a trip is overdue once late by its own length, and by at least 10 minutes', () => {
  const trip = { departedAt: 0, durationMs: 15 * 60_000 };
  assert.deepEqual(lateness(trip, 10 * 60_000), { dueAt: 15 * 60_000, lateMs: 0, overdue: false });
  assert.equal(lateness(trip, 29 * 60_000).overdue, false, '14 minutes late is not yet overdue');
  assert.equal(lateness(trip, 30 * 60_000).overdue, true);
  const short = { departedAt: 0, durationMs: 4 * 60_000 };
  assert.equal(lateness(short, 12 * 60_000).overdue, false, 'a short trip still gets 10 minutes');
  assert.equal(lateness(short, 14 * 60_000).overdue, true);
});

test('lengths of time read naturally', () => {
  assert.equal(span(30_000), '1 min');
  assert.equal(span(45 * 60_000), '45 min');
  assert.equal(span(3 * 3_600_000 + 5 * 60_000), '3 h 5 min');
  assert.equal(span(10 * 3_600_000), '10 h');
  assert.equal(span(3 * 86_400_000), '3 days');
});

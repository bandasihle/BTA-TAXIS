import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DB = path.resolve(import.meta.dirname, '..', 'data', 'taxi.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ranks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  area TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  from_rank_id INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  to_rank_id INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  polyline TEXT NOT NULL,
  UNIQUE (from_rank_id, to_rank_id)
);
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT
);
CREATE TABLE IF NOT EXISTS marshals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS taxis (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 15,
  owner_name TEXT,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OFF_DUTY',
  rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL,
  home_rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL,
  trip_id INTEGER
);
CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY,
  taxi_id INTEGER NOT NULL UNIQUE REFERENCES taxis(id) ON DELETE CASCADE,
  rank_id INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  seats INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  taxi_id INTEGER NOT NULL,
  route_id INTEGER NOT NULL,
  departed_at INTEGER NOT NULL,
  arrived_at INTEGER,
  seats_at_departure INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  speed_kmh REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  taxi_id INTEGER,
  type TEXT NOT NULL,
  rank_id INTEGER,
  route_id INTEGER,
  at INTEGER NOT NULL,
  by TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS trips_open ON trips(arrived_at);
`;

export function openDb(file = DEFAULT_DB) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

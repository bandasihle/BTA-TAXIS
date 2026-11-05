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
  note TEXT,
  slug TEXT,
  region_id TEXT
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  from_rank_id INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  to_rank_id INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  polyline TEXT NOT NULL,
  UNIQUE (from_rank_id, to_rank_id)
);
CREATE TABLE IF NOT EXISTS fares (
  route_id INTEGER PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  from_time TEXT NOT NULL,
  until_time TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT
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
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'marshal', 'driver')),
  rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL,
  pin_hash TEXT NOT NULL,
  must_change_pin INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  taxi_id INTEGER REFERENCES taxis(id) ON DELETE SET NULL,
  location_consent_at INTEGER,
  location_consent_version TEXT
);
-- The latest GPS point per taxi, and nothing older: no location history is kept.
CREATE TABLE IF NOT EXISTS positions (
  taxi_id INTEGER PRIMARY KEY REFERENCES taxis(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL NOT NULL,
  at INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  client TEXT NOT NULL
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
  migrate(db);
  return db;
}

/** Brings a database made by an older version up to date. Each step is safe to run again. */
function migrate(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has('ranks', 'slug')) db.exec('ALTER TABLE ranks ADD COLUMN slug TEXT');
  if (!has('ranks', 'region_id')) db.exec('ALTER TABLE ranks ADD COLUMN region_id TEXT');
  for (const r of db.prepare('SELECT id, name FROM ranks WHERE slug IS NULL').all()) {
    db.prepare('UPDATE ranks SET slug = ? WHERE id = ?').run(`${slugify(r.name) || 'rank'}-${r.id}`, r.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ranks_slug ON ranks(slug)');
  if (!has('users', 'taxi_id')) db.exec('ALTER TABLE users ADD COLUMN taxi_id INTEGER REFERENCES taxis(id) ON DELETE SET NULL');
  if (!has('users', 'location_consent_at')) db.exec('ALTER TABLE users ADD COLUMN location_consent_at INTEGER');
  if (!has('users', 'location_consent_version')) db.exec('ALTER TABLE users ADD COLUMN location_consent_version TEXT');
}

/** "Etwatwa Las Vegas" -> "etwatwa-las-vegas", for links. */
export function slugify(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

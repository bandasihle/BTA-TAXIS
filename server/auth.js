// Staff accounts, PINs and sessions. Node's crypto only, no extra dependencies.
//
// - PINs are 6 digits, stored as scrypt hashes with a per-user salt, compared in constant time.
// - 5 wrong PINs lock the account for 15 minutes; each IP also gets a limited number of tries.
// - A wrong phone and a wrong PIN give the same answer in about the same time, so nobody can
//   find out which phone numbers have accounts.
// - Session tokens are random; only their SHA-256 hash is stored, so a copy of the database
//   cannot be used to sign in.
// - The app cannot send headers on an EventSource, so it swaps its token for a one-time stream
//   ticket that lives 30 seconds, instead of putting the token in a URL.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './store.js';

const scrypt = promisify(crypto.scrypt);

export const ROLES = Object.freeze(['admin', 'marshal', 'driver']);
export const SESSION_MS = 7 * 24 * 60 * 60_000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX_TRIES = 20;
const TICKET_MS = 30_000;
const WRONG = 'That phone number and PIN do not match.';

/** South African mobile numbers in any common format become +27XXXXXXXXX; anything else is null. */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/[\s()-]/g, '');
  const m = digits.match(/^(?:\+27|27|0)([6-8]\d{8})$/);
  return m ? `+27${m[1]}` : null;
}

/** Returns a reason the PIN is not allowed, or null when it is fine. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return 'The PIN must be exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Do not use the same digit six times.';
  const steps = [...pin].map((d, i) => (i ? Number(d) - Number(pin[i - 1]) : 0)).slice(1);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Do not use digits in a row like 123456.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomPin = () => {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!pinProblem(pin)) return pin;
  }
};

function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new HttpError(400, 'Enter the person\'s name.');
  if (n.length > 60) throw new HttpError(400, 'Keep the name under 60 characters.');
  return n;
}

export function createAuth(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  // Tests use a cheaper cost so they run fast; the server uses the default.
  const cost = opts.scrypt ?? { N: 16384, r: 8, p: 1 };

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  async function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(pin, salt, 32, cost);
    return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async function pinMatches(pin, stored) {
    const [kind, N, r, p, salt, key] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = await scrypt(String(pin), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(got, want);
  }

  // Compared against when the phone is unknown, so that path costs the same as a real check.
  const dummyHash = hashPin(randomPin());

  const publicUser = (u) => u && ({
    id: u.id, name: u.name, phone: u.phone, role: u.role, rankId: u.rank_id, active: !!u.active,
    mustChangePin: !!u.must_change_pin, lockedUntil: u.locked_until && u.locked_until > now() ? u.locked_until : null,
    lastLoginAt: u.last_login_at,
  });

  const getUser = (id) => {
    const u = one('SELECT * FROM users WHERE id = ?', Number(id));
    if (!u) throw new HttpError(404, 'That staff member does not exist.');
    return u;
  };

  function validRank(role, rankId) {
    if (role !== 'marshal') return null;
    const id = Number(rankId);
    if (!Number.isInteger(id) || !one('SELECT id FROM ranks WHERE id = ?', id)) throw new HttpError(400, 'Choose the rank this marshal works at.');
    return id;
  }

  const activeAdmins = () => one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).n;
  const endSessions = (userId) => run('DELETE FROM sessions WHERE user_id = ?', userId);

  // ---------------------------------------------------------------- per-IP limit

  const tries = new Map();
  function countTry(ip) {
    const t = now();
    let entry = tries.get(ip);
    if (!entry || entry.resetAt <= t) entry = { n: 0, resetAt: t + IP_WINDOW_MS };
    entry.n++;
    tries.set(ip, entry);
    if (tries.size > 10_000) for (const [k, v] of tries) if (v.resetAt <= t) tries.delete(k);
    if (entry.n > IP_MAX_TRIES) {
      const mins = Math.ceil((entry.resetAt - t) / 60_000);
      throw new HttpError(429, `Too many sign-in attempts from this device. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  // ---------------------------------------------------------------- accounts

  async function createUser(input = {}) {
    const name = cleanName(input.name);
    const phone = normalizePhone(input.phone);
    if (!phone) throw new HttpError(400, 'Enter a South African cellphone number, like 082 123 4567.');
    const role = String(input.role ?? '');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role: admin, marshal or driver.');
    const rankId = validRank(role, input.rankId);
    if (one('SELECT id FROM users WHERE phone = ?', phone)) throw new HttpError(409, 'Someone already has an account with that phone number.');
    // A PIN chosen by someone else is temporary: the person must set their own when they sign in.
    let pin = input.pin;
    if (pin == null) pin = randomPin();
    else if (pinProblem(pin)) throw new HttpError(400, pinProblem(pin));
    const hash = await hashPin(pin);
    const res = run(
      'INSERT INTO users (name, phone, role, rank_id, pin_hash, must_change_pin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      name, phone, role, rankId, hash, now(),
    );
    return { user: publicUser(getUser(res.lastInsertRowid)), pin, message: `${name} added` };
  }

  function updateUser(actor, id, input = {}) {
    const u = getUser(id);
    const role = input.role !== undefined ? String(input.role) : u.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role: admin, marshal or driver.');
    const active = input.active !== undefined ? (input.active ? 1 : 0) : u.active;
    const name = input.name !== undefined ? cleanName(input.name) : u.name;
    const rankId = role === 'marshal' ? validRank(role, input.rankId !== undefined ? input.rankId : u.rank_id) : null;
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && activeAdmins() <= 1) {
      throw new HttpError(409, 'This is the only admin. Make someone else an admin first.');
    }
    if (u.id === actor.id && (role !== 'admin' || !active)) throw new HttpError(409, 'You cannot remove your own admin access.');
    run('UPDATE users SET name = ?, role = ?, rank_id = ?, active = ? WHERE id = ?', name, role, rankId, active, u.id);
    if (!active || role !== u.role) endSessions(u.id); // signed out everywhere when access changes
    return { user: publicUser(getUser(u.id)), message: `${name} saved` };
  }

  async function resetPin(id) {
    const u = getUser(id);
    const pin = randomPin();
    run('UPDATE users SET pin_hash = ?, must_change_pin = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', await hashPin(pin), u.id);
    endSessions(u.id);
    return { pin, message: `New PIN for ${u.name}` };
  }

  async function changePin(user, oldPin, newPin) {
    const u = getUser(user.id);
    if (!(await pinMatches(String(oldPin ?? ''), u.pin_hash))) throw new HttpError(400, 'Your current PIN is wrong.');
    const problem = pinProblem(newPin);
    if (problem) throw new HttpError(400, problem);
    if (await pinMatches(newPin, u.pin_hash)) throw new HttpError(400, 'Choose a PIN different from the old one.');
    run('UPDATE users SET pin_hash = ?, must_change_pin = 0 WHERE id = ?', await hashPin(newPin), u.id);
    // Other devices are signed out; this one keeps its session.
    run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, user.sessionId);
    return { message: 'PIN changed' };
  }

  const listUsers = () => all('SELECT * FROM users ORDER BY active DESC, name').map(publicUser);

  // ---------------------------------------------------------------- sign in

  async function login(input = {}, { ip = 'unknown', client = 'web' } = {}) {
    countTry(ip);
    const phone = normalizePhone(input.phone);
    const pin = typeof input.pin === 'string' ? input.pin : '';
    const u = phone ? one('SELECT * FROM users WHERE phone = ?', phone) : null;
    if (!u) {
      await pinMatches(pin, await dummyHash);
      throw new HttpError(401, WRONG);
    }
    if (u.locked_until && u.locked_until > now()) {
      await pinMatches(pin, await dummyHash);
      const mins = Math.ceil((u.locked_until - now()) / 60_000);
      throw new HttpError(429, `Too many wrong PINs. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`);
    }
    const ok = await pinMatches(pin, u.pin_hash);
    if (!ok || !u.active) {
      if (!ok) {
        const failed = u.failed_logins + 1;
        run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED ? now() + LOCK_MS : null, u.id);
      }
      throw new HttpError(401, WRONG); // a deactivated account gets the same answer as a wrong PIN
    }
    run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), u.id);
    run('DELETE FROM sessions WHERE expires_at <= ?', now());
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + SESSION_MS;
    run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, ?, ?, ?, ?)',
      sha256(token), u.id, now(), expiresAt, client === 'app' ? 'app' : 'web');
    return { token, expiresAt, user: publicUser(u) };
  }

  /** The signed-in user for a token, with sessionId, or null. */
  function authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = one(
      `SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha256(token), now(),
    );
    return row ? { ...publicUser(row), sessionId: row.session_id } : null;
  }

  function logout(user) {
    if (user?.sessionId) run('DELETE FROM sessions WHERE id = ?', user.sessionId);
    for (const [k, v] of tickets) if (v.sessionId === user?.sessionId) tickets.delete(k);
    return { message: 'Signed out' };
  }

  const sessionAlive = (sessionId) => !!one(
    'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.active = 1', sessionId, now(),
  );

  // ---------------------------------------------------------------- stream tickets

  const tickets = new Map();
  function streamTicket(user) {
    const t = now();
    for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticket, { sessionId: user.sessionId, exp: t + TICKET_MS });
    return { ticket };
  }

  /** Swaps a ticket (once) for the signed-in user, or null. */
  function redeemTicket(ticket) {
    const entry = tickets.get(ticket);
    if (!entry) return null;
    tickets.delete(ticket);
    if (entry.exp <= now()) return null;
    const row = one(
      `SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`, entry.sessionId, now(),
    );
    return row ? { ...publicUser(row), sessionId: row.session_id } : null;
  }

  const hasUsers = () => one('SELECT COUNT(*) AS n FROM users').n > 0;

  return {
    createUser, updateUser, resetPin, changePin, listUsers, login, authenticate, logout,
    sessionAlive, streamTicket, redeemTicket, hasUsers,
  };
}

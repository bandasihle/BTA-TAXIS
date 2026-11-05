// Shared helpers for every screen.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** localStorage that never throws (private windows, blocked storage). */
export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`bta:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`bta:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

export const STATUS_LABEL = {
  EN_ROUTE: 'On the road',
  LOADING: 'Loading',
  QUEUED: 'In queue',
  ARRIVED: 'Waiting at rank',
  OFF_DUTY: 'Off duty',
};
export const STATUS_ORDER = ['EN_ROUTE', 'LOADING', 'QUEUED', 'ARRIVED', 'OFF_DUTY'];

export const mark = (status) => `<span class="mark mark-${status}" aria-hidden="true"></span>`;
export const plate = (text, cls = '') => `<span class="plate ${cls}">${esc(text)}</span>`;

// ------------------------------------------------------------------ theme + top bar

export function initTheme() {
  const t = local.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  local.set('theme', next);
}

// Each screen and who may open it. The server checks every request again; hiding a link is
// only a convenience.
export const NAV = [
  ['/dashboard.html', 'Dashboard', ['admin']],
  ['/marshal.html', 'Marshal', ['admin', 'marshal']],
  ['/board.html', 'Rank screen', ['admin', 'marshal']],
  ['/editor.html', 'Ranks &amp; routes', ['admin']],
  ['/fares.html', 'Fares', ['admin']],
  ['/users.html', 'Staff', ['admin']],
];

const THEME_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>`;

export function renderTopbar(active, user) {
  const el = document.getElementById('topbar');
  el.className = 'topbar';
  const links = NAV.filter(([, , roles]) => roles.includes(user?.role));
  el.innerHTML = `
    <a class="brand" href="${homeFor(user)}">
      <span class="brand-name">Benoni Taxi Association<small>Rank tracker</small></span></a>
    <nav class="nav" aria-label="Screens">${links.map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="topbar-tools">
      ${user ? `<span class="who small">${esc(user.name)}</span><button class="btn sm quiet" id="sign-out" type="button">Sign out</button>` : ''}
      <button class="btn sm quiet" id="menu-btn" type="button" aria-haspopup="dialog">Menu</button>
      <button class="icon-btn" id="theme-toggle" type="button" aria-label="Switch between light and dark">${THEME_ICON}</button>
      <a class="brand-logo" href="/" title="Danki Driver, the passenger app"><img src="/img/dankie-logo-128.jpg" width="40" height="40" alt="Dankie Driver, Benoni Taxi Association" style="border-radius:50%"></a>
    </div>`;
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#sign-out')?.addEventListener('click', signOut);
  import('./menu.js').then(({ mountMenu }) => mountMenu($('#menu-btn'), { user, current: active }));
}

// ------------------------------------------------------------------ the welcome screen

/**
 * Danki Driver opens on the welcome screen once per visit (see js/gate.js). Choosing to
 * continue as a passenger, or signing in, marks this visit so the gate lets you through.
 */
export function enter(kind) {
  try {
    sessionStorage.setItem('dk:in', kind);
  } catch {
    /* storage blocked: the gate cannot read it either, so it lets everyone through */
  }
}

// ------------------------------------------------------------------ server time, API, live updates

// Inside the Android app the pages load from the phone, so API calls go to the live server.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
export const API_BASE = NATIVE ? 'https://bta-taxis.onrender.com' : '';
export const IS_APP = NATIVE;

export const clock = {
  offset: 0,
  now() {
    return Date.now() + this.offset;
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = session.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `The server answered ${res.status}.`);
    err.status = res.status;
    // a staff screen whose session ended (signed out elsewhere, PIN reset) goes back to sign-in
    if (res.status === 401 && document.body.dataset.staff != null) goToSignIn();
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ signing in

/**
 * The app keeps its session token on the phone and sends it as a Bearer header. The website
 * never sees its token: it lives in an HttpOnly cookie the browser sends by itself.
 */
export const session = {
  token: () => (NATIVE ? local.get('session') : null),
  set(token) {
    if (NATIVE) local.set('session', token);
  },
  clear() {
    if (NATIVE) local.set('session', null);
  },
};

/** Where someone lands after signing in. */
export function homeFor(user) {
  if (user?.role === 'admin') return '/dashboard.html';
  if (user?.role === 'marshal') return `/marshal.html?rank=${user.rankId}`;
  if (user?.role === 'driver') return '/driver.html';
  return '/login.html';
}

export function goToSignIn() {
  const next = location.pathname + location.search;
  location.replace(`/login.html?next=${encodeURIComponent(next)}`);
}

const never = () => new Promise(() => {});

/**
 * Call first on every staff screen. Resolves with the signed-in user when their role may use
 * this screen; otherwise sends them to sign in (or to their own screen) and never resolves.
 */
export async function requireStaff(roles) {
  document.body.dataset.staff = '';
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status !== 401) {
      document.body.innerHTML = '<p style="padding:24px">The tracker cannot be reached. Check your connection and reload.</p>';
    }
    return never();
  }
  if (me.mustChangePin) {
    goToSignIn();
    return never();
  }
  if (!roles.includes(me.role)) {
    location.replace(homeFor(me));
    return never();
  }
  enter('staff');
  return me;
}

export async function signOut() {
  await flushOutbox(); // taps saved offline belong to this person; send them before signing out
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch {
    /* signed out on this phone either way */
  }
  session.clear();
  local.set('outbox', []);
  location.replace('/login.html');
}

/**
 * Sends a taxi action. With no signal, the tap is kept on this phone and sent later,
 * so a marshal can keep working through a dead spot.
 */
export async function act(payload, { quiet = false } = {}) {
  try {
    const r = await api('/api/action', { method: 'POST', body: payload });
    if (!quiet && r?.message) toast(r.message);
    return r;
  } catch (err) {
    if (err.status) {
      toast(err.message, 'error');
      throw err;
    }
    const box = local.get('outbox', []);
    box.push({ ...payload, savedAt: Date.now() });
    local.set('outbox', box);
    toast('No signal. Saved on this phone, it will send when you are back online.', 'warn');
    return null;
  }
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  const box = local.get('outbox', []);
  if (!box.length) return;
  flushing = true;
  const left = [];
  let sent = 0;
  for (const item of box) {
    const { savedAt, ...payload } = item;
    try {
      await api('/api/action', { method: 'POST', body: payload });
      sent++;
    } catch (err) {
      if (err.status) toast(`A saved tap could not be applied: ${err.message}`, 'error');
      else left.push(item);
    }
  }
  local.set('outbox', left);
  flushing = false;
  if (sent) toast(`Sent ${sent} saved tap${sent === 1 ? '' : 's'}.`);
}

/**
 * Opens the live stream. Calls onSnapshot with the state, onPos with positions (when pos is true).
 * Staff screens get the full state; everyone else gets the public one, with no personal details.
 */
export function connect({ pos = false, staff = false, onSnapshot, onPos }) {
  const banner = document.createElement('div');
  banner.className = 'banner offline';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  banner.textContent = 'Connection lost. Reconnecting… what you see may be out of date.';
  document.getElementById('topbar')?.after(banner);

  // The browser retries a dropped stream by itself. When the server refuses it instead (the
  // session ended, or the app's one-time ticket was used), open a fresh one. A staff screen
  // checks the session first, which sends the person to sign in when it has ended.
  let es;
  async function open() {
    const params = new URLSearchParams();
    if (pos) params.set('pos', '1');
    if (staff) {
      params.set('staff', '1');
      try {
        await api('/api/me');
        if (NATIVE) params.set('ticket', (await api('/api/stream-ticket', { method: 'POST', body: {} })).ticket);
      } catch {
        banner.hidden = false;
        return void setTimeout(open, 5000);
      }
    }
    es = new EventSource(`${API_BASE}/api/stream?${params}`);
    es.addEventListener('snapshot', (e) => {
      banner.hidden = true;
      const snap = JSON.parse(e.data);
      clock.offset = snap.meta.serverTime - Date.now();
      onSnapshot(index(snap));
      flushOutbox();
    });
    if (onPos) es.addEventListener('pos', (e) => onPos(JSON.parse(e.data)));
    es.addEventListener('error', () => {
      banner.hidden = false;
      if (es.readyState === EventSource.CLOSED) setTimeout(open, 3000);
    });
  }
  open();
  addEventListener('online', flushOutbox);
}

/** Adds lookup maps to a snapshot. */
function index(s) {
  s.rankById = new Map(s.ranks.map((r) => [r.id, r]));
  s.routeById = new Map(s.routes.map((r) => [r.id, r]));
  s.taxiById = new Map(s.taxis.map((t) => [t.id, t]));
  s.tripById = new Map(s.trips.map((t) => [t.id, t]));
  s.queueByTaxi = new Map(s.queue.map((q) => [q.taxiId, q]));
  s.rankName = (id) => s.rankById.get(id)?.name ?? 'a removed rank';
  s.routeLabel = (id) => {
    const r = s.routeById.get(id);
    return r ? `${s.rankName(r.fromRankId)} to ${s.rankName(r.toRankId)}` : 'a removed route';
  };
  s.dest = (routeId) => {
    const r = s.routeById.get(routeId);
    return r ? s.rankName(r.toRankId) : 'a removed route';
  };
  return s;
}

/** Plain-language "where is this taxi". */
export function whereIs(s, t) {
  const q = s.queueByTaxi.get(t.id);
  if (t.status === 'EN_ROUTE') {
    const trip = s.tripById.get(t.tripId);
    if (!trip) return 'On the road';
    return `To ${s.dest(trip.routeId)}, ${eta(trip.departedAt + trip.durationMs - clock.now())}`;
  }
  if (q) return `${s.rankName(q.rankId)}, number ${q.position} to ${s.dest(q.routeId)}`;
  if (t.status === 'ARRIVED') return `Waiting at ${s.rankName(t.rankId)}`;
  return t.rankId ? `Off duty, last at ${s.rankName(t.rankId)}` : 'Off duty';
}

// ------------------------------------------------------------------ formatting

export function eta(ms) {
  if (ms <= 5_000) return 'arriving now';
  if (ms < 90_000) return `${Math.ceil(ms / 5_000) * 5} sec away`;
  return `${Math.round(ms / 60_000)} min away`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
}

export function ago(ts) {
  const s = Math.max(0, Math.round((clock.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return clockTime(ts);
}

// ------------------------------------------------------------------ seats

/**
 * The minibus seen from above, front at the top. Right-hand drive: driver top right,
 * sliding door on the left. Passengers fill from the back row forward.
 */
export function busSeats(seats, capacity, { size = '', popIndex = -1 } = {}) {
  const front = Math.min(2, capacity);
  const rest = capacity - front;
  const back = Math.min(4, rest);
  const mid = rest - back;
  const rows = [];
  rows.push(front === 2 ? ['gap', 'p', 'p', 'driver'] : ['gap', 'gap', 'p', 'driver']);
  for (let left = mid; left > 0; left -= 3) {
    const n = Math.min(3, left);
    rows.push(['gap', ...Array(3 - n).fill('gap'), ...Array(n).fill('p')]);
  }
  if (back) rows.push([...Array(4 - back).fill('gap'), ...Array(back).fill('p')]);

  // boarding order: back row first
  const order = [];
  for (let r = rows.length - 1; r >= 0; r--) rows[r].forEach((c, i) => c === 'p' && order.push(`${r}:${i}`));
  const filled = new Set(order.slice(0, seats));
  const popped = popIndex >= 0 ? order[popIndex] : null;

  const cells = rows.flatMap((row, r) =>
    row.map((c, i) => {
      if (c === 'gap') return '<span class="seat gap"></span>';
      if (c === 'driver') return '<span class="seat driver"></span>';
      const key = `${r}:${i}`;
      return `<span class="seat${filled.has(key) ? ' on' : ''}${key === popped ? ' pop' : ''}"></span>`;
    }),
  );
  return `<div class="bus ${size}" role="img" aria-label="${seats} of ${capacity} seats filled">${cells.join('')}</div>`;
}

export function seatBar(seats, capacity) {
  return `<span class="seatbar" aria-hidden="true">${Array.from({ length: capacity }, (_, i) => `<i${i < seats ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

// ------------------------------------------------------------------ toast

let toastBox;
export function toast(message, kind = '') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
}

/** Runs an async handler with the button disabled, so double taps don't double count. */
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch {
    /* already reported */
  } finally {
    if (button) button.disabled = false;
  }
}

/** A yes/no question in a proper dialog. Resolves true when the person confirms. */
export function confirmDialog(title, text, okLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="dialog-body">
        <h2>${esc(title)}</h2><p>${esc(text)}</p>
        <div class="dialog-actions">
          <button class="btn quiet" value="no">Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(okLabel)}</button>
        </div></form>`;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'yes');
      dlg.remove();
    });
    dlg.showModal();
    dlg.querySelector('[value="yes"]').focus();
  });
}

/** Re-renders a container and puts keyboard focus back on the same control. */
export function renderKeepingFocus(container, html) {
  const key = document.activeElement?.dataset?.key;
  container.innerHTML = html;
  if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

export function registerServiceWorker() {
  if (!NATIVE && 'serviceWorker' in navigator && location.hostname !== '') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

export const FOOTER = `Rank positions come from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
  contributors (ODbL); pins marked "unverified" need checking.`;

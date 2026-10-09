/* global L */
import {
  $, $$, esc, local, renderTopbar, connect, api, toast, plate, mark, seatBar, busSeats, eta, ago, clockTime, clock,
  whereIs, confirmDialog, registerServiceWorker, STATUS_LABEL, STATUS_ORDER,
} from './common.js';

renderTopbar('/dashboard');
registerServiceWorker();

// ------------------------------------------------------------------ state

let s = null;
let positions = [];
let tab = local.get('dash-tab', 'ranks');
let selectedTaxi = null;
let selectedRank = null;
const filter = { state: local.get('dash-state', 'all'), route: 'all', q: '' };

// ------------------------------------------------------------------ map

const map = L.map('map', { zoomControl: true, zoomSnap: 0.5 }).setView([-26.18, 28.34], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  className: 'map-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const rankLayer = L.layerGroup().addTo(map);
const taxiLayer = L.layerGroup().addTo(map);
const taxiMarkers = new Map();
let fitted = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawStatic() {
  routeLayer.clearLayers();
  rankLayer.clearLayers();
  const lineColor = cssVar('--ink-3');
  const drawn = new Set();
  for (const r of s.routes) {
    const key = [r.fromRankId, r.toRankId].sort().join('-');
    if (drawn.has(key)) continue; // both directions share one line
    drawn.add(key);
    const active = filter.route === 'all' || [r.id, reverseOf(r)?.id].includes(Number(filter.route));
    L.polyline(r.polyline, { color: lineColor, weight: active ? 3 : 2, opacity: active ? 0.55 : 0.18, dashArray: active ? null : '4 6', interactive: false }).addTo(routeLayer);
  }
  for (const rank of s.ranks) {
    const queued = s.queue.filter((q) => q.rankId === rank.id).length;
    const icon = L.divIcon({
      className: '',
      iconSize: [0, 0],
      html: `<div class="rank-pin${rank.verified ? '' : ' is-guess'}${selectedRank === rank.id ? ' is-selected' : ''}">
        <span class="dot"></span><span class="label">${esc(rank.name)}${queued ? `<b>${queued}</b>` : ''}</span></div>`,
    });
    L.marker([rank.lat, rank.lng], { icon, title: `${rank.name}${rank.verified ? '' : ' (unverified position)'}`, zIndexOffset: -500, keyboard: true })
      .on('click', () => selectRank(rank.id))
      .addTo(rankLayer);
  }
  if (!fitted && s.ranks.length) {
    fitted = true;
    map.fitBounds(L.latLngBounds(s.ranks.map((r) => [r.lat, r.lng])).pad(0.08));
  }
}

const reverseOf = (r) => s.routes.find((x) => x.fromRankId === r.toRankId && x.toRankId === r.fromRankId);

function visible(t, pos) {
  if (!t) return false;
  if (filter.state !== 'all' && t.status !== filter.state) return false;
  if (filter.route !== 'all') {
    const rid = Number(filter.route);
    const routeId = pos?.routeId ?? s.queueByTaxi.get(t.id)?.routeId ?? s.tripById.get(t.tripId)?.routeId;
    if (routeId !== rid) return false;
  }
  if (filter.q && !t.plate.replace(/\s/g, '').includes(filter.q)) return false;
  return true;
}

function iconFor(p, selected) {
  let anchor;
  const size = p.status === 'EN_ROUTE' ? 16 : 14;
  if (p.slot != null) {
    // fan taxis waiting at a rank around its pin, so they don't stack
    const ring = Math.floor(p.slot / 10);
    const idx = p.slot % 10;
    const radius = 22 + ring * 13;
    const angle = (idx / 10) * Math.PI * 2 + ring * 0.3 + Math.PI / 2;
    const dx = Math.cos(angle) * radius;
    const dy = Math.sin(angle) * radius;
    anchor = [size / 2 - dx, size / 2 - dy];
  } else {
    anchor = [size / 2, size / 2];
  }
  return L.divIcon({
    className: 'taxi-icon',
    iconSize: [size, size],
    iconAnchor: anchor,
    html: `<span class="tx tx-${p.status}${selected ? ' is-selected' : ''}"></span>`,
  });
}

function drawTaxis() {
  if (!s) return;
  const seen = new Set();
  for (const p of positions) {
    const t = s.taxiById.get(p.id);
    if (!visible(t, p)) continue;
    seen.add(p.id);
    const key = `${p.status}:${p.slot ?? ''}:${selectedTaxi === p.id}`;
    let m = taxiMarkers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lng], { icon: iconFor(p, selectedTaxi === p.id), title: `${t.plate}: ${STATUS_LABEL[p.status]}`, riseOnHover: true })
        .on('click', () => selectTaxi(p.id))
        .addTo(taxiLayer);
      m.key = key;
      taxiMarkers.set(p.id, m);
    } else {
      if (m.key !== key) {
        m.setIcon(iconFor(p, selectedTaxi === p.id));
        m.key = key;
      }
      m.setLatLng([p.lat, p.lng]);
      m.options.title = `${t.plate}: ${STATUS_LABEL[p.status]}`;
    }
    m.setZIndexOffset(selectedTaxi === p.id ? 1000 : p.status === 'EN_ROUTE' ? 200 : 0);
  }
  for (const [id, m] of taxiMarkers) {
    if (!seen.has(id)) {
      taxiLayer.removeLayer(m);
      taxiMarkers.delete(id);
    }
  }
}

// ------------------------------------------------------------------ panel

function renderSummary() {
  const counts = Object.fromEntries(STATUS_ORDER.map((st) => [st, 0]));
  for (const t of s.taxis) counts[t.status]++;
  const chip = (st, label, n) => `<button class="chip" type="button" data-state="${st}" aria-pressed="${filter.state === st}">
      ${st === 'all' ? '' : mark(st)}<b>${n}</b> ${label}</button>`;
  $('#summary').innerHTML = [
    chip('all', 'all taxis', s.taxis.length),
    ...STATUS_ORDER.map((st) => chip(st, STATUS_LABEL[st].toLowerCase(), counts[st])),
  ].join('');
}

function renderRouteFilter() {
  const sel = $('#f-route');
  const current = filter.route;
  sel.innerHTML = '<option value="all">All routes</option>' + s.routes
    .map((r) => [r, s.routeLabel(r.id)])
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([r, label]) => `<option value="${r.id}">${esc(label)}</option>`).join('');
  sel.value = s.routeById.has(Number(current)) ? current : 'all';
  filter.route = sel.value;
}

function renderPanel() {
  $$('.ptab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab && !selectedTaxi)));
  const body = $('#panel-body');
  const scroll = body.scrollTop;
  if (selectedTaxi && s.taxiById.has(selectedTaxi)) {
    renderTaxiDetail(body);
    return;
  }
  if (tab === 'ranks') body.innerHTML = ranksHtml();
  else if (tab === 'trips') body.innerHTML = tripsHtml();
  else body.innerHTML = taxisHtml();
  body.scrollTop = scroll;
}

function ranksHtml() {
  const q = filter.route === 'all' ? null : Number(filter.route);
  const rows = [...s.ranks]
    .map((rank) => {
      const routes = s.routes.filter((r) => r.fromRankId === rank.id && (!q || r.id === q));
      const waiting = s.taxis.filter((t) => t.status === 'ARRIVED' && t.rankId === rank.id).length;
      const incoming = s.trips.filter((tr) => !tr.arrivedAt && s.routeById.get(tr.routeId)?.toRankId === rank.id).length;
      const queued = s.queue.filter((x) => x.rankId === rank.id).length;
      return { rank, routes, waiting, incoming, queued };
    })
    .filter((x) => !q || x.routes.length)
    .sort((a, b) => b.queued + b.incoming - (a.queued + a.incoming) || a.rank.name.localeCompare(b.rank.name));

  return `<ul class="plist">${rows.map(({ rank, routes, waiting, incoming }) => {
    const lines = routes.map((r) => {
      const queue = s.queue.filter((x) => x.routeId === r.id).sort((a, b) => a.position - b.position);
      const front = queue[0];
      const ft = front && s.taxiById.get(front.taxiId);
      return `<div class="qline">
        <span class="dest">To ${esc(s.rankName(r.toRankId))}</span>
        <span>${ft ? `${seatBar(front.seats, ft.capacity)} <span class="small">${front.seats}/${ft.capacity}</span>` : '<span class="muted small">empty</span>'}</span>
        <span class="meta">${queue.length ? `${queue.length} in queue` : ''}</span>
      </div>`;
    }).join('');
    const extra = [waiting && `${waiting} waiting, not queued`, incoming && `${incoming} on the way in`].filter(Boolean).join('. ');
    return `<li class="clickable${selectedRank === rank.id ? ' is-selected' : ''}" data-rank="${rank.id}" tabindex="0">
      <div class="rank-card-head"><h3>${esc(rank.name)}</h3>${rank.verified ? '' : '<span class="guess">Unverified pin</span>'}</div>
      ${lines || '<p class="muted small">No routes from this rank.</p>'}
      ${extra ? `<p class="rank-extra">${extra}.</p>` : ''}
      <p class="rank-extra"><a href="/marshal?rank=${rank.id}">Open marshal view</a> &nbsp; <a href="/board?rank=${rank.id}">Rank screen</a></p>
    </li>`;
  }).join('') || '<li class="empty">No ranks match this route.</li>'}</ul>`;
}

const EVENT_TEXT = {
  QUEUED: 'joined a queue', LOADING: 'started loading', FULL: 'is full', DEPARTED: 'departed', ARRIVED: 'arrived',
  REMOVED: 'taken off a queue', OFF_DUTY: 'went off duty', MOVED: 'moved in the queue', REGISTERED: 'registered',
};

function tripsHtml() {
  const events = s.events.filter((e) => {
    const t = s.taxiById.get(e.taxiId);
    if (filter.q && !(t?.plate ?? '').replace(/\s/g, '').includes(filter.q)) return false;
    if (filter.route !== 'all' && e.routeId !== Number(filter.route)) return false;
    if (filter.state !== 'all' && t?.status !== filter.state) return false;
    return true;
  });
  if (!events.length) return '<ul class="plist"><li class="empty">Nothing has happened that matches these filters yet.</li></ul>';
  return `<ul class="plist">${events.slice(0, 80).map((e) => {
    const t = s.taxiById.get(e.taxiId);
    return `<li class="${t ? 'clickable' : ''}" ${t ? `data-taxi="${t.id}" tabindex="0"` : ''}>
      <div class="event">
        <time datetime="${new Date(e.at).toISOString()}" title="${ago(e.at)}">${clockTime(e.at)}</time>
        <span class="what">${t ? plate(t.plate) : ''} <span>${esc(e.detail ?? EVENT_TEXT[e.type] ?? e.type)}</span></span>
        <span class="by">${esc(e.rankId ? s.rankName(e.rankId) : '')}${e.by && e.by !== 'marshal' ? ` (by ${esc(e.by)})` : ''}</span>
      </div></li>`;
  }).join('')}</ul>`;
}

function taxisHtml() {
  const taxis = s.taxis
    .filter((t) => visible(t))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.plate.localeCompare(b.plate));
  if (!taxis.length) return '<ul class="plist"><li class="empty">No taxis match these filters.</li></ul>';
  return `<ul class="plist">${taxis.map((t) => `<li class="clickable" data-taxi="${t.id}" tabindex="0">
      <div class="taxi-line">${plate(t.plate)}<span class="small muted">${esc(t.driverName ?? '')}</span>
        <span class="where">${mark(t.status)} ${esc(whereIs(s, t))}</span></div>
    </li>`).join('')}</ul>`;
}

async function renderTaxiDetail(body) {
  const t = s.taxiById.get(selectedTaxi);
  const q = s.queueByTaxi.get(t.id);
  const trip = t.tripId ? s.tripById.get(t.tripId) : null;
  const pct = trip ? Math.min(100, ((clock.now() - trip.departedAt) / trip.durationMs) * 100) : 0;
  body.innerHTML = `<div class="detail">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      ${plate(t.plate, 'lg')}
      <button class="btn sm quiet" type="button" id="detail-close">Back to list</button>
    </div>
    <p style="display:flex;gap:8px;align-items:center;font-weight:600">${mark(t.status)} ${STATUS_LABEL[t.status]}</p>
    <p>${esc(whereIs(s, t))}</p>
    ${trip ? `<div class="progress"><i style="width:${pct.toFixed(0)}%"></i></div>` : ''}
    ${q ? `<div style="display:flex;gap:16px;align-items:center">${busSeats(q.seats, t.capacity)}<p><b style="font-family:var(--font-cond);font-size:34px">${q.seats}</b> of ${t.capacity} seated</p></div>` : ''}
    <dl>
      <dt>Driver</dt><dd>${esc(t.driverName ?? 'Not recorded')}</dd>
      <dt>Owner</dt><dd>${esc(t.ownerName ?? 'Not recorded')}</dd>
      <dt>Seats</dt><dd>${t.capacity}</dd>
      <dt>Home rank</dt><dd>${esc(t.homeRankId ? s.rankName(t.homeRankId) : 'None')}</dd>
    </dl>
    <div><h3>Recent trips</h3><div id="detail-trips"><p class="muted small" style="padding-top:8px">Loading…</p></div></div>
  </div>`;
  $('#detail-close').addEventListener('click', () => selectTaxi(null));
  try {
    const h = await api(`/api/taxis/${t.id}/history`);
    if (selectedTaxi !== t.id) return;
    $('#detail-trips').innerHTML = h.trips.length
      ? `<ul class="plist">${h.trips.map((tr) => `<li style="padding:10px 0"><div class="event">
          <time>${clockTime(tr.departedAt)}</time>
          <span class="what">${esc(s.routeLabel(tr.routeId))}</span>
          <span class="by">${tr.seatsAtDeparture} passengers, ${tr.arrivedAt ? `arrived ${clockTime(tr.arrivedAt)}` : 'still on the road'}</span>
        </div></li>`).join('')}</ul>`
      : '<p class="muted small" style="padding-top:8px">No trips yet.</p>';
  } catch (err) {
    $('#detail-trips').textContent = err.message;
  }
}

// ------------------------------------------------------------------ selection

function selectTaxi(id) {
  selectedTaxi = id;
  if (id) {
    selectedRank = null;
    const p = positions.find((x) => x.id === id);
    if (p) map.panTo([p.lat, p.lng], { animate: true });
  }
  drawStatic();
  drawTaxis();
  renderPanel();
}

function selectRank(id) {
  selectedTaxi = null;
  selectedRank = id;
  tab = 'ranks';
  local.set('dash-tab', tab);
  const rank = s.rankById.get(id);
  if (rank) map.panTo([rank.lat, rank.lng], { animate: true });
  drawStatic();
  drawTaxis();
  renderPanel();
  $(`#panel-body [data-rank="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ------------------------------------------------------------------ wiring

$('#summary').addEventListener('click', (e) => {
  const b = e.target.closest('[data-state]');
  if (!b) return;
  filter.state = b.dataset.state === filter.state ? 'all' : b.dataset.state;
  local.set('dash-state', filter.state);
  renderSummary();
  drawTaxis();
  renderPanel();
});

$('#f-route').addEventListener('change', (e) => {
  filter.route = e.target.value;
  drawStatic();
  drawTaxis();
  renderPanel();
});

$('#f-q').addEventListener('input', (e) => {
  filter.q = e.target.value.toUpperCase().replace(/\s/g, '');
  drawTaxis();
  if (!selectedTaxi) renderPanel();
});

$$('.ptab').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  local.set('dash-tab', tab);
  selectedTaxi = null;
  drawTaxis();
  renderPanel();
}));

function activate(e) {
  if (e.target.closest('a, button')) return;
  const li = e.target.closest('[data-taxi], [data-rank]');
  if (!li) return;
  if (li.dataset.taxi) selectTaxi(Number(li.dataset.taxi));
  else selectRank(Number(li.dataset.rank));
}
$('#panel-body').addEventListener('click', activate);
$('#panel-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.target.matches('[data-taxi], [data-rank]')) {
      e.preventDefault();
      activate(e);
    }
  }
});

$('#reset').addEventListener('click', async () => {
  const ok = await confirmDialog('Reload demo data?', 'This puts every rank, route and taxi back to the starting demo state. Ranks you added or moved will be lost.', 'Reload demo data', { danger: true });
  if (!ok) return;
  try {
    toast((await api('/api/reset', { method: 'POST' })).message);
    selectedTaxi = null;
    fitted = false;
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Leaflet animates zoom with transforms; switch off our marker easing while it does.
map.on('zoomstart', () => map.getContainer().classList.add('no-anim'));
map.on('zoomend', () => setTimeout(() => map.getContainer().classList.remove('no-anim'), 50));

connect({
  pos: true,
  onSnapshot(snap) {
    s = snap;
    $('#sim-note').textContent = `Simulated taxis drive ${s.meta.simScale} times faster than real time.`;
    renderSummary();
    renderRouteFilter();
    drawStatic();
    drawTaxis();
    // don't rebuild the detail view (it refetches history) on every change
    if (!selectedTaxi) renderPanel();
    else if (!s.taxiById.has(selectedTaxi)) selectTaxi(null);
  },
  onPos(p) {
    positions = p;
    drawTaxis();
  },
});

// refresh ETAs and the open taxi detail now and then
setInterval(() => {
  if (!s) return;
  if (selectedTaxi) renderPanel();
  else if (tab === 'taxis') renderPanel();
}, 10_000);

// Danki Driver, the passenger app: province > region > rank > destination, time, price.
// Every step can be picked on the map or in the list beside it. The path lives in the URL
// hash (#/gauteng/benoni-ekurhuleni/barcelona), so the phone's back button and shared
// links work.
//
// On a rank's screen it also shows the tracker's live taxis: which destinations are
// running right now, the taxi loading for each one, taxis driving on the map, and a trip
// preview. Passengers never see queue numbers.
//
// Ranks and fares come from the server (admins edit them in the app). The last copy is kept
// on the phone, so fares still show with no signal.

import { lookup, buildDirectory, priceLabel, timeLabel, runningNow, saMinutes } from './fares.js';
import { esc, local, registerServiceWorker, connect, api } from './common.js';
import { mountMenu } from './menu.js';

let cached = local.get('directory');
let tree;
let loaded = false;
try {
  tree = buildDirectory(cached ?? {});
  loaded = !!cached;
} catch {
  cached = null; // a copy from an older version of the app; wait for the server instead
  tree = buildDirectory();
}

const view = document.getElementById('view');
const trail = document.getElementById('trail');
const panel = document.getElementById('panel');
const head = document.getElementById('sh');
const headTitle = document.getElementById('sh-title');
const slip = document.getElementById('slip');
const $slip = (id) => document.getElementById(`slip-${id}`);

const href = (...ids) => `#/${ids.join('/')}`;
const CHEVRON = '<svg class="dk-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortName = (rank) => rank.name.replace(/ Taxi Rank$/, '');

// ------------------------------------------------------------------ map

// Danki Driver covers Gauteng for now: the map stays on the province and the list starts there.
const HOME = 'gauteng';
const GAUTENG = L.latLngBounds([-27.05, 26.95], [-25.0, 29.25]);
const map = L.map('map', { zoomControl: true, zoomSnap: 0.25, attributionControl: true, maxBounds: GAUTENG, maxBoundsViscosity: 0.9, minZoom: 8 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  className: 'dk-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const lines = L.layerGroup().addTo(map);
const pins = L.layerGroup().addTo(map);
const taxiLayer = L.layerGroup().addTo(map);
const tripLayer = L.layerGroup().addTo(map);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let current = {};
let destPins = [];

/** The frosted header covers the top of the map; fitted views leave room under it. */
const headRoom = () => head.offsetHeight;

/** A labelled pin. kind: area | rank | here | dest. */
function pin(at, { label, tag = '', kind = 'area', link = null, dim = false, bare = false, title = label }) {
  const icon = L.divIcon({
    className: '',
    html: `<span class="pin pin-${kind}${dim ? ' is-dim' : ''}"><i></i>${bare ? '' : `<b>${tag}${esc(label)}</b>`}</span>`,
    iconSize: [0, 0],
  });
  const m = L.marker(at, { icon, title, keyboard: !!link, interactive: !!link, zIndexOffset: kind === 'here' ? 1000 : dim ? -100 : 0 });
  if (link) m.on('click', () => (location.hash = link));
  m.addTo(pins);
  return m;
}

function fit(points, maxZoom) {
  map.invalidateSize();
  if (points.length === 1) map.setView(points[0], maxZoom, { animate: !first });
  // labels sit to the right of their pins, so leave more room on that side
  else {
    const right = Math.min(170, map.getSize().x * 0.25);
    map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [24, 30 + headRoom()], paddingBottomRight: [right, 30], maxZoom, animate: !first });
  }
}

function drawMap(province, region, rank) {
  pins.clearLayers();
  lines.clearLayers();
  stopTrip();

  if (rank) {
    for (const k of region.ranks) if (k !== rank) pin(k.at, { label: shortName(k), kind: 'rank', dim: true, bare: true, link: href(province.id, region.id, k.id) });
    destPins = rank.destinations.map((d) => pin(d.at, {
        label: `${d.name}  ${priceLabel(d.price)}`, kind: 'dest',
        title: `${d.name}, ${priceLabel(d.price)}`,
        link: d.toPath ? href(...d.toPath) : null,
      }));
    pin(rank.at, { label: shortName(rank), kind: 'here' });
    drawRouteLines();
    fit([rank.at, ...rank.destinations.map((d) => d.at)], 13);
  } else if (region) {
    for (const k of region.ranks) pin(k.at, { label: shortName(k), kind: 'rank', link: href(province.id, region.id, k.id) });
    if (!region.ranks.length) pin(region.at, { label: region.name, dim: true });
    fit(region.ranks.length ? region.ranks.map((k) => k.at) : [region.at], 11);
  } else if (province) {
    for (const r of province.regions) pin(r.at, { label: r.name, dim: !r.ranks.length, link: href(province.id, r.id) });
    if (!province.regions.length) pin(province.at, { label: province.name, tag: `<em>${province.code}</em>`, dim: true });
    fit(province.regions.length ? province.regions.map((r) => r.at) : [province.at], 10);
  } else {
    for (const p of tree) pin(p.at, { label: p.name, tag: `<em>${p.code}</em>`, dim: !p.regions.length, link: href(p.id) });
    fit(tree.map((p) => p.at), 6);
  }
}

// ------------------------------------------------------------------ list

function list(items) {
  return `<ul class="dk-list">${items
    .map(({ link, tag = '', name, sub = '' }) => `<li><a href="${link}">${tag}<span class="dk-name">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${CHEVRON}</a></li>`)
    .join('')}</ul>`;
}

function empty(text) {
  return `<p class="dk-empty">${esc(text)}</p><p><a class="dk-back" href="#/gauteng/benoni-ekurhuleni">See the Benoni Ekurhuleni ranks</a></p>`;
}

function provinces() {
  return `<h1>Where are you catching a taxi?</h1>
    <p class="dk-lede">Pick your province on the map or in the list.</p>
    ${list(tree.map((p) => ({
      link: href(p.id),
      tag: `<span class="dk-code" aria-hidden="true">${p.code}</span>`,
      name: p.name,
      sub: p.regions.length ? plural(p.regions.length, 'region') : 'No ranks yet',
    })))}`;
}

function regions(province) {
  if (!province.regions.length) return `<h1>${esc(province.name)}</h1>${empty(`Ranks in ${province.name} have not been added yet.`)}`;
  return `<h1>${esc(province.name)}</h1>
    <p class="dk-lede">Pick your area.</p>
    ${list(province.regions.map((r) => ({
      link: href(province.id, r.id),
      name: r.name,
      sub: r.ranks.length ? plural(r.ranks.length, 'taxi rank') : 'No ranks yet',
    })))}`;
}

function ranks(province, region) {
  if (!region.ranks.length && !loaded) return `<h1>${esc(region.name)}</h1><p class="dk-empty">Loading ranks and fares…</p>`;
  if (!region.ranks.length) return `<h1>${esc(region.name)}</h1>${empty(`Ranks in ${region.name} have not been added yet.`)}`;
  return `<h1>${esc(region.name)}</h1>
    <p class="dk-lede">Pick the rank you are at.</p>
    ${list(region.ranks.map((k) => ({
      link: href(province.id, region.id, k.id),
      name: k.name,
      sub: k.destinations.length ? plural(k.destinations.length, 'destination') : 'No fares yet',
    })))}`;
}

function fares(province, region, rank) {
  const from = shortName(rank);
  if (!rank.destinations.length) {
    return `<h1>${esc(rank.name)}</h1>
      <p class="dk-lede">${esc(region.name)}, ${esc(province.name)}</p>
      ${empty(`The association has not added destinations and prices for ${from} yet.`)}`;
  }
  return `<h1>${esc(rank.name)}</h1>
    <p class="dk-lede">${esc(region.name)}, ${esc(province.name)}</p>
    <ul class="dk-fares" aria-label="Taxis from ${esc(from)}">
      ${rank.destinations.map((d, i) => `
        <li class="dk-fare" data-i="${i}">
          <button class="dk-fare-btn" type="button" data-slip="${i}" aria-expanded="false" aria-controls="slip">
            <span class="dk-to"><span class="dk-to-name"><span class="vh">To </span>${esc(d.name)}</span></span>
            <span class="dk-price">${priceLabel(d.price)}</span>
            <span class="dk-when"><span class="dk-time">${hoursLabel(d)}</span><span class="dk-open" data-open></span></span>
          </button>
          <div class="dk-live"><span class="dk-load" data-load></span></div>
        </li>`).join('')}
    </ul>
    ${rank.exact ? '' : '<p class="dk-small">The pin shows the area. The exact rank spot still needs to be marked.</p>'}`;
}

const hoursLabel = (d) => `${timeLabel(d.from)} – ${timeLabel(d.until)}`;

function crumbs(province, region, rank) {
  const parts = [];
  if (province) parts.push([province.name, href(province.id)]);
  if (region) parts.push([region.name, href(province.id, region.id)]);
  if (rank) parts.push([shortName(rank), null]);
  if (parts.length <= 1) return '';
  return `<ol>${parts
    .map(([name, link], i) => (i === parts.length - 1 ? `<li><span aria-current="page">${esc(name)}</span></li>` : `<li><a href="${link}">${esc(name)}</a></li>`))
    .join('')}</ol>`;
}

// ------------------------------------------------------------------ routing

let first = true;
function render() {
  const ids = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const { province, region, rank } = lookup(ids, tree);
  if (province?.id !== HOME) {
    location.replace(href(HOME));
    return;
  }

  // An unknown link falls back to the deepest part that exists (once the ranks are loaded,
  // so a rank link opened with no signal waits instead of losing its place).
  const depth = rank ? 3 : region ? 2 : province ? 1 : 0;
  if (ids.length > depth && !loaded && region) {
    view.innerHTML = `<h1>${esc(region.name)}</h1><p class="dk-empty">Loading ranks and fares…</p>`;
    return;
  }
  if (ids.length > depth) {
    location.replace(depth ? href(...ids.slice(0, depth)) : '#/');
    return;
  }

  closeSlip({ quiet: true });
  view.innerHTML = rank ? fares(province, region, rank)
    : region ? ranks(province, region)
      : province ? regions(province)
        : provinces();
  trail.innerHTML = crumbs(province, region, rank);
  trail.hidden = !trail.innerHTML;
  document.title = rank ? `${rank.name} | Danki Driver` : region ? `${region.name} | Danki Driver` : province ? `${province.name} | Danki Driver` : 'Danki Driver';
  current = { province, region, rank };
  drawMap(province, region, rank);
  updateLive();
  drawTaxis();
  watchTitle();

  if (!first) {
    panel.scrollTop = 0;
    view.focus({ preventScroll: true });
  }
  first = false;
}

// ------------------------------------------------------------------ live: hours, loading, taxis

let snap = null;
let positions = [];
let lastData = null;

/** The tracker routes out to and back from each destination of the open rank. */
function links() {
  const { rank } = current;
  if (!rank || !snap) return null;
  return rank.destinations.map((d) => ({ out: snap.routeById.get(d.routeId), back: snap.routeById.get(d.backRouteId) }));
}

function seatBar(seats, capacity) {
  return `<span class="dk-seats" aria-hidden="true">${Array.from({ length: capacity }, (_, i) => `<i${i < seats ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

function updateLive() {
  const { rank } = current;
  if (!rank) return;
  const now = saMinutes();
  const ls = links();
  rank.destinations.forEach((d, i) => {
    const row = view.querySelector(`.dk-fare[data-i="${i}"]`);
    if (!row) return;
    const hours = runningNow(d, now);
    row.classList.toggle('is-closed', !hours.open);
    const open = row.querySelector('[data-open]');
    open.textContent = hours.text;
    open.className = `dk-open${hours.open ? (hours.soon ? ' is-soon' : '') : ' is-closed'}`;

    const load = row.querySelector('[data-load]');
    if (!hours.open) return void (load.innerHTML = '');
    const route = ls?.[i]?.out;
    if (!route) return void (load.textContent = snap ? '' : 'Checking for taxis…');
    const front = snap.queue.filter((q) => q.routeId === route.id).sort((a, b) => a.position - b.position)[0];
    const taxi = front && snap.taxiById.get(front.taxiId);
    if (!taxi) return void (load.textContent = 'No taxi loading yet');
    const full = front.seats >= taxi.capacity;
    load.innerHTML = `${seatBar(front.seats, taxi.capacity)}<span>${full ? 'Full, leaving now' : `Loading: ${front.seats} of ${taxi.capacity} seats filled`}</span>`;
  });
  if (slipIndex >= 0) fillSlip(slipIndex);
}

let routeLines = [];

/** The road from the rank to each destination (a straight line until the routes load). */
function drawRouteLines() {
  const { rank } = current;
  lines.clearLayers();
  if (!rank) return;
  const ls = links();
  routeLines = rank.destinations.map((d, i) => L.polyline(ls?.[i]?.out?.polyline ?? [rank.at, d.at], { className: 'dk-line', interactive: false }).addTo(lines));
  highlight(slipIndex);
}

// taxis on the road to or from this rank, on destinations that are running now
const taxiMarkers = new Map();
function drawTaxis() {
  const ls = links();
  const { rank } = current;
  const wanted = new Map();
  if (ls) {
    const now = saMinutes();
    rank.destinations.forEach((d, i) => {
      if (!runningNow(d, now).open) return;
      if (ls[i].out) wanted.set(ls[i].out.id, { out: true, text: `To ${d.name}` });
      if (ls[i].back) wanted.set(ls[i].back.id, { out: false, text: `Coming in from ${d.name}` });
    });
  }
  const seen = new Set();
  for (const p of positions) {
    const w = p.status === 'EN_ROUTE' && wanted.get(p.routeId);
    if (!w) continue;
    seen.add(p.id);
    const mins = Math.max(1, Math.round(p.etaMs / 60_000));
    let m = taxiMarkers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'dk-taxi-icon', html: `<span class="dk-taxi${w.out ? '' : ' is-in'}"></span>`, iconSize: [16, 16] }),
        keyboard: false, zIndexOffset: 500,
      }).bindTooltip('', { direction: 'top', offset: [0, -8] }).addTo(taxiLayer);
      taxiMarkers.set(p.id, m);
    } else m.setLatLng([p.lat, p.lng]);
    m.setTooltipContent(esc(`${w.text}, about ${mins} min to go`));
  }
  for (const [id, m] of taxiMarkers) {
    if (seen.has(id)) continue;
    taxiLayer.removeLayer(m);
    taxiMarkers.delete(id);
  }
}

// ------------------------------------------------------------------ trip preview

const tripBox = L.DomUtil.create('div', 'dk-trip');
tripBox.hidden = true;
tripBox.setAttribute('role', 'status');
map.getContainer().append(tripBox);
let tripFrame = 0;
let tripIndex = -1;

function stopTrip() {
  cancelAnimationFrame(tripFrame);
  tripLayer.clearLayers();
  tripBox.hidden = true;
  tripIndex = -1;
  $slip('trip').setAttribute('aria-pressed', 'false');
}

/** The point a fraction t (0..1) of the way along a line. */
function along(line, lengths, total, t) {
  const want = total * t;
  for (let i = 1; i < line.length; i++) {
    if (lengths[i] >= want) {
      const k = (want - lengths[i - 1]) / ((lengths[i] - lengths[i - 1]) || 1);
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k];
    }
  }
  return line[line.length - 1];
}

/** Rough time on the road: about 50 km/h on the road plus 5 minutes of stops, rounded to 5 minutes. */
function duration(km) {
  const mins = Math.max(5, Math.round(((km / 50) * 60 + 5) / 5) * 5);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}

function previewTrip(i) {
  const { rank } = current;
  const d = rank.destinations[i];
  stopTrip();
  tripIndex = i;
  const route = links()?.[i]?.out;
  const line = route?.polyline ?? [rank.at, d.at];
  const lengths = [0];
  for (let k = 1; k < line.length; k++) lengths.push(lengths[k - 1] + map.distance(line[k - 1], line[k]));
  const total = lengths[lengths.length - 1];

  L.polyline(line, { className: 'dk-trip-line', interactive: false }).addTo(tripLayer);
  const bus = L.marker(line[0], {
    icon: L.divIcon({ className: 'dk-trip-icon', html: '<span class="dk-taxi is-trip"></span>', iconSize: [22, 22] }),
    keyboard: false, interactive: false, zIndexOffset: 2000,
  }).addTo(tripLayer);
  map.fitBounds(L.latLngBounds(line), { paddingTopLeft: [40, 100 + headRoom()], paddingBottomRight: [Math.min(150, map.getSize().x * 0.25), 40], maxZoom: 14 }); // room for the trip box and labels
  tripBox.innerHTML = `<b>${esc(shortName(rank))} to ${esc(d.name)}</b><span>About ${duration(total / 1000)} on the road. ${priceLabel(d.price)}.</span>`;
  tripBox.hidden = false;
  if (map.getContainer().getBoundingClientRect().top < 0) map.getContainer().scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth' });

  if (reduceMotion.matches) return void bus.setLatLng(line[line.length - 1]);
  const start = performance.now();
  const RUN = 4500;
  const step = (t) => {
    const k = Math.min(1, (t - start) / RUN);
    const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    bus.setLatLng(along(line, lengths, total, eased));
    if (k < 1) tripFrame = requestAnimationFrame(step);
  };
  tripFrame = requestAnimationFrame(step);
}

// ------------------------------------------------------------------ the slip: one destination, printed

let slipIndex = -1;
let slipOpener = null;

function highlight(i) {
  destPins.forEach((m, j) => m.getElement()?.querySelector('.pin')?.classList.toggle('is-on', j === i));
  routeLines.forEach((l, j) => l.getElement()?.classList.toggle('is-on', j === i));
}

/** Copies the destination's current state (hours, running, loading) onto the slip. */
function fillSlip(i) {
  const { rank } = current;
  const d = rank?.destinations[i];
  if (!d) return;
  const row = view.querySelector(`.dk-fare[data-i="${i}"]`);
  $slip('to').textContent = d.name;
  $slip('from').textContent = `From ${shortName(rank)}`;
  $slip('price').textContent = priceLabel(d.price);
  $slip('hours').textContent = hoursLabel(d);
  const open = row?.querySelector('[data-open]');
  $slip('now').innerHTML = open?.textContent ? `<span class="${open.className}">${esc(open.textContent)}</span>` : '';
  $slip('load').innerHTML = row?.querySelector('[data-load]')?.innerHTML || (runningNow(d, saMinutes()).open ? 'Not known yet' : 'No taxis now');
  $slip('trip').setAttribute('aria-pressed', String(tripIndex === i));
}

function openSlip(i, opener) {
  slipIndex = i;
  slipOpener = opener;
  view.querySelectorAll('.dk-fare-btn').forEach((b) => b.setAttribute('aria-expanded', String(b === opener)));
  fillSlip(i);
  highlight(i);
  slip.hidden = false;
  // feed the slip again from the bottom, as a printer would
  slip.classList.remove('is-open');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    slip.classList.add('is-open');
    $slip('to').focus({ preventScroll: true });
  }));
}

function closeSlip({ quiet = false } = {}) {
  if (slipIndex < 0) return;
  slip.classList.remove('is-open');
  view.querySelectorAll('.dk-fare-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  slipIndex = -1;
  highlight(-1);
  if (!quiet) slipOpener?.focus({ preventScroll: true });
  slipOpener = null;
}

view.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slip]');
  if (!b) return;
  const i = Number(b.dataset.slip);
  if (slipIndex === i) closeSlip();
  else openSlip(i, b);
});
$slip('close').addEventListener('click', () => closeSlip());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && slipIndex >= 0) closeSlip();
});
$slip('trip').addEventListener('click', () => {
  const i = slipIndex;
  if (tripIndex === i) return void drawMap(current.province, current.region, current.rank);
  closeSlip({ quiet: true });
  previewTrip(i);
  highlight(-1);
});

// ------------------------------------------------------------------ header: frosted bar, title on scroll

let titleWatch = null;
function watchTitle() {
  titleWatch?.disconnect();
  const h1 = view.querySelector('h1');
  headTitle.textContent = current.rank ? shortName(current.rank) : (h1?.textContent ?? '');
  head.classList.remove('has-title');
  if (!h1) return;
  titleWatch = new IntersectionObserver(([e]) => head.classList.toggle('has-title', !e.isIntersecting && e.boundingClientRect.top < headRoom()),
    { rootMargin: `-${headRoom()}px 0px 0px 0px` });
  titleWatch.observe(h1);
}
const markScrolled = () => head.classList.toggle('is-scrolled', (scrollY || panel.scrollTop) > 4);
addEventListener('scroll', markScrolled, { passive: true });
panel.addEventListener('scroll', markScrolled, { passive: true });

connect({
  pos: true,
  onSnapshot(s) {
    snap = s;
    const data = { ranks: s.ranks, routes: s.routes, fares: s.fares };
    const changed = !loaded || JSON.stringify(data) !== JSON.stringify(lastData ?? cached);
    lastData = data;
    if (changed) {
      tree = buildDirectory(data);
      loaded = true;
      local.set('directory', data);
      if (tripBox.hidden) render();
    }
    if (tripBox.hidden) drawRouteLines(); // leave a trip preview alone; the lines catch up when it closes
    updateLive();
    drawTaxis();
  },
  onPos(p) {
    positions = p;
    drawTaxis();
  },
});
setInterval(updateLive, 30_000);

addEventListener('hashchange', render);
addEventListener('resize', () => map.invalidateSize());
render();
registerServiceWorker();

// The menu shows the screens of whoever is signed in on this phone, or staff sign in.
Promise.race([api('/api/me'), new Promise((_, no) => setTimeout(no, 3000))])
  .then((me) => mountMenu(document.getElementById('menu-btn'), { user: me.mustChangePin ? null : me }))
  .catch(() => mountMenu(document.getElementById('menu-btn')));

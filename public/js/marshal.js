import {
  $, esc, local, renderTopbar, connect, api, act, busy, toast, plate, busSeats, eta, ago, clock,
  confirmDialog, renderKeepingFocus, FOOTER, registerServiceWorker, STATUS_LABEL,
} from './common.js';

renderTopbar('/marshal');
$('#footer').innerHTML = FOOTER;
registerServiceWorker();

const app = $('#app');
const params = new URLSearchParams(location.search);
let rankId = Number(params.get('rank')) || local.get('marshal-rank');
let routeTab = null;
let s = null;
const lastSeats = new Map();

const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

connect({
  onSnapshot(snap) {
    s = snap;
    if (!s.rankById.has(rankId)) rankId = s.ranks[0]?.id;
    render();
  },
});
setInterval(() => s && !document.querySelector('dialog[open]') && render(), 5_000); // keep arrival times fresh

function setRank(id) {
  rankId = id;
  routeTab = null;
  local.set('marshal-rank', id);
  history.replaceState(null, '', `/marshal?rank=${id}`);
  render();
}

function queueFor(routeId) {
  return s.queue.filter((q) => q.routeId === routeId).sort((a, b) => a.position - b.position);
}

function render() {
  const rank = s.rankById.get(rankId);
  if (!rank) {
    app.innerHTML = '<p class="muted" style="padding:24px 0">There are no ranks yet. Add one in <a href="/editor">Ranks and routes</a>.</p>';
    return;
  }
  local.set('marshal-rank', rankId);
  document.title = `${rank.name} marshal | BTA Rank Tracker`;

  const routes = s.routes.filter((r) => r.fromRankId === rankId).sort((a, b) => s.rankName(a.toRankId).localeCompare(s.rankName(b.toRankId)));
  if (routeTab == null) routeTab = local.get(`tab:${rankId}`);
  if (!routes.some((r) => r.id === routeTab)) routeTab = routes[0]?.id ?? null;

  const marshal = s.marshals.find((m) => m.rankId === rankId);
  const waiting = s.taxis.filter((t) => t.status === 'ARRIVED' && t.rankId === rankId);
  const incoming = s.trips
    .filter((tr) => !tr.arrivedAt && s.routeById.get(tr.routeId)?.toRankId === rankId && s.taxiById.get(tr.taxiId)?.tripId === tr.id)
    .map((tr) => ({ tr, left: tr.departedAt + tr.durationMs - clock.now() }))
    .sort((a, b) => a.left - b.left);

  const head = `
    <div class="m-head">
      <div class="m-head-row">
        <h1 class="m-rank">${esc(rank.name)}</h1>
        ${rank.verified ? '' : '<span class="guess" title="This pin has not been checked on the ground yet">Unverified pin</span>'}
      </div>
      <div class="m-head-row">
        <span class="muted small">${marshal ? `Marshal: ${esc(marshal.name)}` : 'No marshal assigned'}</span>
        <label class="visually-hidden" for="rank-switch">Switch rank</label>
        <select class="input m-rank-select" id="rank-switch" data-key="rank-switch">
          ${s.ranks.map((r) => `<option value="${r.id}"${r.id === rankId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${s.meta.demo ? `<p class="banner demo" style="margin:0 0 12px;border:1px solid var(--line)">Demo mode is on: simulated marshals are working these queues too.
      <button class="btn sm" data-action="demo-off" data-key="demo-off" type="button">Turn it off</button></p>` : ''}`;

  const tabs = routes.length
    ? `<div class="tabs" role="tablist" aria-label="Routes from ${esc(rank.name)}">
        ${routes.map((r) => `<button class="tab" type="button" role="tab" aria-selected="${r.id === routeTab}" data-action="tab" data-route="${r.id}" data-key="tab-${r.id}">
            To ${esc(s.rankName(r.toRankId))} <span class="count" aria-label="taxis queued">${queueFor(r.id).length}</span></button>`).join('')}
      </div>`
    : `<p class="hint">No routes leave from ${esc(rank.name)} yet. Add one in <a href="/editor">Ranks and routes</a>.</p>`;

  const queue = routeTab ? queueFor(routeTab) : [];
  const dest = routeTab ? s.dest(routeTab) : '';
  const front = queue[0];

  let panel = '';
  if (routeTab && front) {
    const t = s.taxiById.get(front.taxiId);
    const prev = lastSeats.get(t.id);
    const popIndex = prev != null && front.seats > prev ? front.seats - 1 : -1;
    lastSeats.set(t.id, front.seats);
    const full = front.seats >= t.capacity;
    panel = `
      <section class="loading-panel" aria-label="Loading now">
        <div class="lp-who">
          <span class="muted">Loading now to ${esc(dest)}</span>
          ${plate(t.plate, 'lg')}
          <span class="muted small">${esc(t.driverName ?? 'No driver recorded')}</span>
        </div>
        <div class="lp-count" aria-live="polite"><strong>${front.seats}</strong><span> of ${t.capacity}${full ? ', full' : ''}</span></div>
        <div class="lp-bus">${busSeats(front.seats, t.capacity, { popIndex })}</div>
        <div class="lp-controls">
          <button class="btn" type="button" data-action="seat" data-delta="-1" data-taxi="${t.id}" data-key="minus" ${front.seats === 0 ? 'disabled' : ''} aria-label="Remove one passenger">−1</button>
          <button class="btn primary" type="button" data-action="seat" data-delta="1" data-taxi="${t.id}" data-key="plus" ${full ? 'disabled' : ''}>Add passenger</button>
        </div>
        <div class="lp-depart">
          <button class="btn ${full ? 'go' : ''}" type="button" data-action="depart" data-taxi="${t.id}" data-key="depart">Depart to ${esc(dest)}</button>
        </div>
      </section>`;
  } else if (routeTab) {
    panel = `<section class="loading-panel lp-empty"><p>No taxis in the queue to ${esc(dest)}. Check one in to start loading.</p></section>`;
  }

  const next = queue.slice(1).map((q) => {
    const t = s.taxiById.get(q.taxiId);
    return `<div class="row">
      <span class="pos" aria-label="Number ${q.position}">${q.position}</span>
      <div class="grow">${plate(t.plate)}<span class="small">${q.seats ? `${q.seats} of ${t.capacity} already seated, ` : ''}queued ${ago(q.enqueuedAt)}</span></div>
      <div class="actions">
        <button class="btn sm" type="button" data-action="up" data-taxi="${t.id}" data-key="up-${t.id}" aria-label="Move ${esc(t.plate)} up">${ICON_UP}</button>
        <button class="btn sm" type="button" data-action="down" data-taxi="${t.id}" data-key="down-${t.id}" aria-label="Move ${esc(t.plate)} down" ${q.position === queue.length ? 'disabled' : ''}>${ICON_DOWN}</button>
        <button class="btn sm" type="button" data-action="remove" data-taxi="${t.id}" data-key="rm-${t.id}">Take off</button>
      </div>
    </div>`;
  }).join('');

  const waitingRows = waiting.map((t) => `<div class="row">
      <div class="grow">${plate(t.plate)}<span class="small">${esc(t.driverName ?? '')}</span></div>
      <div class="actions">
        ${routeTab ? `<button class="btn sm primary" type="button" data-action="queue" data-taxi="${t.id}" data-key="q-${t.id}">Queue to ${esc(dest)}</button>` : ''}
        <button class="btn sm" type="button" data-action="offduty" data-taxi="${t.id}" data-key="off-${t.id}">Off duty</button>
      </div>
    </div>`).join('');

  const incomingRows = incoming.map(({ tr, left }) => {
    const t = s.taxiById.get(tr.taxiId);
    const route = s.routeById.get(tr.routeId);
    const pct = Math.min(100, Math.max(0, ((clock.now() - tr.departedAt) / tr.durationMs) * 100));
    return `<div class="row">
      <div class="grow">
        <span>${plate(t.plate)} <span class="small muted">from ${esc(s.rankName(route.fromRankId))}, ${tr.seatsAtDeparture} on board</span></span>
        <span class="small">${eta(left)}</span>
        <span class="progress" style="max-width:220px"><i style="width:${pct.toFixed(0)}%"></i></span>
      </div>
      <div class="actions"><button class="btn sm" type="button" data-action="arrive" data-taxi="${t.id}" data-key="arr-${t.id}">Mark arrived</button></div>
    </div>`;
  }).join('');

  renderKeepingFocus(app, `
    ${head}
    ${tabs}
    ${panel}
    ${routeTab ? `<section class="m-section" aria-label="Next in line"><h2>Next in line to ${esc(dest)}</h2>
      ${next || '<p class="muted">Nobody else is waiting for this route.</p>'}</section>` : ''}
    <section class="m-section"><h2>At the rank, not in a queue</h2>
      ${waitingRows || '<p class="muted">Every taxi here is queued.</p>'}</section>
    <section class="m-section"><h2>On the way here</h2>
      ${incomingRows || '<p class="muted">No taxis are driving to this rank right now.</p>'}</section>
  `);
}

app.addEventListener('change', (e) => {
  if (e.target.id === 'rank-switch') setRank(Number(e.target.value));
});

app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || !s) return;
  const taxiId = Number(b.dataset.taxi);
  const t = s.taxiById.get(taxiId);
  switch (b.dataset.action) {
    case 'tab':
      routeTab = Number(b.dataset.route);
      local.set(`tab:${rankId}`, routeTab);
      render();
      break;
    case 'seat':
      await busy(b, async () => {
        const r = await act({ type: 'seat', taxiId, delta: Number(b.dataset.delta) }, { quiet: true });
        if (r && r.seats === t.capacity) toast(`${t.plate} is full. Send it off when the driver is ready.`);
      });
      break;
    case 'depart': {
      const q = s.queueByTaxi.get(taxiId);
      if (q && q.seats < t.capacity) {
        const ok = await confirmDialog(
          'Depart before it is full?',
          `${t.plate} has ${q.seats} of ${t.capacity} seats filled.`,
          `Depart with ${q.seats}`,
        );
        if (!ok) return;
      }
      await busy(b, () => act({ type: 'depart', taxiId }));
      break;
    }
    case 'up':
    case 'down':
      await busy(b, () => act({ type: 'move', taxiId, dir: b.dataset.action }, { quiet: true }));
      break;
    case 'remove':
      await busy(b, () => act({ type: 'remove', taxiId }));
      break;
    case 'queue':
      await busy(b, () => act({ type: 'checkIn', taxiId, rankId, routeId: routeTab }));
      break;
    case 'offduty':
      await busy(b, () => act({ type: 'offDuty', taxiId }));
      break;
    case 'arrive':
      await busy(b, () => act({ type: 'arrive', taxiId }));
      break;
    case 'demo-off':
      await busy(b, async () => toast((await api('/api/demo', { method: 'POST', body: { on: false } })).message));
      break;
  }
});

// ------------------------------------------------------------------ check-in dialog

const dlg = $('#checkin');
const plateInput = $('#ci-plate');
const norm = (p) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');

function findTaxi(text) {
  const n = norm(text);
  return n ? s.taxis.find((t) => norm(t.plate) === n) : null;
}

function updateCheckinStatus() {
  const text = plateInput.value.trim();
  const t = findTaxi(text);
  const status = $('#ci-status');
  const isNew = !t && norm(text).length >= 4;
  $('#ci-new').hidden = !isNew;
  $('#ci-submit').textContent = isNew ? 'Register and queue' : 'Add to queue';
  if (!text) status.textContent = '';
  else if (!t) status.textContent = isNew ? '' : 'Keep typing the plate.';
  else {
    const here = t.rankId === rankId;
    const where = t.status === 'EN_ROUTE' ? 'is still on the road' : t.status === 'OFF_DUTY' ? 'is off duty and can be checked in'
      : t.status === 'ARRIVED' ? (here ? 'is waiting here' : `is waiting at ${s.rankName(t.rankId)}`)
        : `is already ${STATUS_LABEL[t.status].toLowerCase()} at ${s.rankName(t.rankId)}`;
    status.textContent = `${t.plate} ${where}.`;
  }
}

$('#checkin-open').addEventListener('click', () => {
  if (!s) return;
  const routes = s.routes.filter((r) => r.fromRankId === rankId);
  if (!routes.length) {
    toast('Add a route from this rank first, in Ranks and routes.', 'error');
    return;
  }
  $('#ci-route').innerHTML = routes
    .map((r) => `<option value="${r.id}"${r.id === routeTab ? ' selected' : ''}>To ${esc(s.rankName(r.toRankId))}</option>`).join('');
  const eligible = s.taxis.filter((t) => t.status === 'OFF_DUTY' || (t.status === 'ARRIVED' && t.rankId === rankId));
  $('#ci-plates').innerHTML = eligible.map((t) => `<option value="${esc(t.plate)}">${STATUS_LABEL[t.status]}</option>`).join('');
  $('#checkin-form').reset();
  updateCheckinStatus();
  dlg.showModal();
  plateInput.focus();
});
plateInput.addEventListener('input', updateCheckinStatus);
$('#ci-cancel').addEventListener('click', () => dlg.close());

$('#checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const routeId = Number($('#ci-route').value);
  const submit = $('#ci-submit');
  await busy(submit, async () => {
    let t = findTaxi(plateInput.value);
    if (!t) {
      try {
        const created = await api('/api/taxis', {
          method: 'POST',
          body: { plate: plateInput.value, capacity: Number($('#ci-cap').value), driverName: $('#ci-driver').value, homeRankId: rankId },
        });
        t = { id: created.id };
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    }
    const r = await act({ type: 'checkIn', taxiId: t.id, rankId, routeId });
    if (r !== undefined) {
      routeTab = routeId;
      local.set(`tab:${rankId}`, routeId);
      dlg.close();
    }
  });
});

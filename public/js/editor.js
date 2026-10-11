/* global L */
import { $, esc, renderTopbar, connect, api, toast, confirmDialog, busy, FOOTER, registerServiceWorker } from './common.js';

renderTopbar('/editor');
$('#footer').innerHTML = FOOTER;
registerServiceWorker();

let s = null;
let sig = '';
let selected = null; // rank id, 'new', or null
let draft = null; // { lat, lng } for a new pin or a moved one

const map = L.map('map', { zoomSnap: 0.5 }).setView([-26.18, 28.34], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'map-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const rankLayer = L.layerGroup().addTo(map);
let newMarker = null;
let fitted = false;

const fmt = (n) => Number(n).toFixed(5);

function drawMap() {
  routeLayer.clearLayers();
  rankLayer.clearLayers();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim();
  for (const r of s.routes) L.polyline(r.polyline, { color, weight: 2.5, opacity: 0.5, interactive: false }).addTo(routeLayer);
  for (const rank of s.ranks) {
    const pos = selected === rank.id && draft ? [draft.lat, draft.lng] : [rank.lat, rank.lng];
    const m = L.marker(pos, {
      draggable: true,
      title: `${rank.name}: drag to move`,
      icon: L.divIcon({
        className: '',
        iconSize: [0, 0],
        html: `<div class="rank-pin${rank.verified ? '' : ' is-guess'}${selected === rank.id ? ' is-selected' : ''}"><span class="dot"></span><span class="label">${esc(rank.name)}</span></div>`,
      }),
    });
    m.on('click', () => select(rank.id));
    m.on('dragend', () => {
      const ll = m.getLatLng();
      if (selected !== rank.id) select(rank.id, false);
      draft = { lat: ll.lat, lng: ll.lng };
      renderForm();
    });
    m.addTo(rankLayer);
  }
  if (!fitted && s.ranks.length) {
    fitted = true;
    map.fitBounds(L.latLngBounds(s.ranks.map((r) => [r.lat, r.lng])).pad(0.1));
  }
}

function select(id, redraw = true) {
  selected = id;
  draft = null;
  if (id !== 'new' && newMarker) {
    map.removeLayer(newMarker);
    newMarker = null;
  }
  renderForm();
  renderLists();
  if (redraw) drawMap();
}

map.on('click', (e) => {
  selected = 'new';
  draft = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (!newMarker) {
    newMarker = L.marker(e.latlng, { draggable: true, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="new-pin"></div>' }) })
      .on('dragend', () => {
        const ll = newMarker.getLatLng();
        draft = { lat: ll.lat, lng: ll.lng };
        renderCoords();
      })
      .addTo(map);
  } else newMarker.setLatLng(e.latlng);
  renderForm();
  renderLists();
  drawMap();
  $('#f-name')?.focus();
});

function renderCoords() {
  const el = $('#f-coords');
  if (el && draft) el.textContent = `${fmt(draft.lat)}, ${fmt(draft.lng)}`;
}

function renderForm() {
  const wrap = $('#rank-form-wrap');
  if (!s) return;
  if (selected == null) {
    wrap.innerHTML = `<div class="editor-form"><p class="hint">Every rank is already on the map. Pins marked "unverified" sit on the right area (found with OpenStreetMap place search), not on the exact rank.
      To fix one, drag the pin to the exact spot, then tick "Checked on the ground". Tap an empty part of the map to add a rank.</p></div>`;
    return;
  }
  const isNew = selected === 'new';
  const rank = isNew ? { name: '', area: '', note: '', verified: false, source: '' } : s.rankById.get(selected);
  if (!rank) {
    selected = null;
    renderForm();
    return;
  }
  const lat = draft?.lat ?? rank.lat;
  const lng = draft?.lng ?? rank.lng;
  const moved = !isNew && draft;
  wrap.innerHTML = `<form class="editor-form" id="rank-form" autocomplete="off">
      <h2>${isNew ? 'New rank' : `Edit ${esc(rank.name)}`}</h2>
      <label class="field">Name <input class="input" id="f-name" required maxlength="60" value="${esc(rank.name)}" placeholder="For example Etwatwa Ext 8"></label>
      <label class="field">Area <input class="input" id="f-area" value="${esc(rank.area ?? '')}" placeholder="For example Etwatwa"></label>
      <label class="field">Notes <textarea class="input" id="f-note" rows="2">${esc(rank.note ?? '')}</textarea></label>
      <label class="check"><input type="checkbox" id="f-verified" ${rank.verified ? 'checked' : ''}> Checked on the ground</label>
      <p class="small muted">Position <span id="f-coords">${fmt(lat)}, ${fmt(lng)}</span>${moved ? ' <b style="color:var(--accent-text)">moved, not saved yet</b>' : ''}</p>
      ${rank.source ? `<p class="small muted">Source: ${esc(rank.source)}</p>` : ''}
      <div class="btns">
        <button class="btn primary" type="submit">${isNew ? 'Save rank' : 'Save changes'}</button>
        <button class="btn quiet" type="button" id="f-cancel">Cancel</button>
        ${isNew ? '' : '<button class="btn danger" type="button" id="f-delete" style="margin-left:auto">Delete rank</button>'}
      </div>
    </form>`;

  $('#f-cancel').addEventListener('click', () => {
    if (newMarker) {
      map.removeLayer(newMarker);
      newMarker = null;
    }
    select(null);
  });
  $('#f-delete')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog(`Delete ${rank.name}?`, 'Its routes are deleted too. Taxis that call it home keep running.', 'Delete rank', { danger: true });
    if (!ok) return;
    await busy(e.target, async () => {
      try {
        toast((await api(`/api/ranks/${rank.id}`, { method: 'DELETE' })).message);
        select(null);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  $('#rank-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('#f-name').value,
      area: $('#f-area').value,
      note: $('#f-note').value,
      verified: $('#f-verified').checked,
      lat: draft?.lat ?? rank.lat,
      lng: draft?.lng ?? rank.lng,
    };
    await busy(e.submitter, async () => {
      try {
        const r = isNew ? await api('/api/ranks', { method: 'POST', body }) : await api(`/api/ranks/${rank.id}`, { method: 'PUT', body });
        toast(r.message);
        if (newMarker) {
          map.removeLayer(newMarker);
          newMarker = null;
        }
        selected = r.id;
        draft = null;
        sig = ''; // force a redraw with the saved data
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function renderLists() {
  $('#rank-list').innerHTML = s.ranks.map((r) => `<li class="clickable${selected === r.id ? ' is-selected' : ''}" data-rank="${r.id}" tabindex="0">
      <div class="rank-card-head" style="margin:0"><h3 style="font-size:16px">${esc(r.name)}</h3>${r.verified ? '' : '<span class="guess">Unverified</span>'}</div>
      <p class="small muted">${esc(r.area ?? '')}${r.area ? ', ' : ''}${s.routes.filter((x) => x.fromRankId === r.id).length} routes out</p>
    </li>`).join('') || '<li class="empty">No ranks yet. Tap the map to add one.</li>';

  const opts = s.ranks.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const from = $('#r-from');
  const to = $('#r-to');
  const [fv, tv] = [from.value, to.value];
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (fv) from.value = fv;
  to.value = tv || s.ranks[1]?.id || '';

  const sorted = [...s.routes].sort((a, b) => s.routeLabel(a.id).localeCompare(s.routeLabel(b.id)));
  $('#route-list').innerHTML = sorted.map((r) => `<li><div class="route-row">
      <span>${esc(s.routeLabel(r.id))} <span class="small muted">${r.km} km</span></span>
      <button class="btn sm danger" type="button" data-del-route="${r.id}" aria-label="Delete route ${esc(s.routeLabel(r.id))}">Delete</button>
    </div></li>`).join('') || '<li class="empty">No routes yet.</li>';
}

$('#rank-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-rank]');
  if (!li) return;
  const id = Number(li.dataset.rank);
  select(id);
  const r = s.rankById.get(id);
  map.setView([r.lat, r.lng], Math.max(map.getZoom(), 15));
});
$('#rank-list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.rank) {
    e.preventDefault();
    e.target.click();
  }
});

$('#route-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-route]');
  if (!b) return;
  await busy(b, async () => {
    try {
      toast((await api(`/api/routes/${b.dataset.delRoute}`, { method: 'DELETE' })).message);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

$('#route-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await busy(e.submitter, async () => {
    try {
      const r = await api('/api/routes', {
        method: 'POST',
        body: { fromRankId: Number($('#r-from').value), toRankId: Number($('#r-to').value), bothWays: $('#r-both').checked },
      });
      toast(r.message);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

connect({
  onSnapshot(snap) {
    s = snap;
    // Taxi movement changes the snapshot every few seconds; only redraw when ranks or routes change,
    // so a pin being dragged or a half-typed form is left alone.
    const next = JSON.stringify([s.ranks, s.routes.map((r) => [r.id, r.fromRankId, r.toRankId, r.polyline.length, r.km])]);
    if (next === sig) return;
    const first = !sig;
    sig = next;
    drawMap();
    renderLists();
    if (first || selected == null || (selected !== 'new' && !s.rankById.has(selected))) renderForm();
  },
});

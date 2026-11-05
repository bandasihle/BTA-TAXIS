// Fares (admins only; the server checks too): for each rank, the destinations passengers can
// take, the hours taxis run and the price. A route without a fare is not shown to passengers.
import { $, esc, local, api, toast, busy, confirmDialog, renderTopbar, requireStaff, connect, clockTime, ago } from './common.js';
import { PROVINCES, priceLabel } from './fares.js';

const me = await requireStaff(['admin']);
renderTopbar('/fares.html', me);

const REGION_NAME = new Map(PROVINCES.flatMap((p) => p.regions.map((r) => [r.id, `${r.name}, ${p.name}`])));
let s = null;
let rankId = local.get('fares-rank');
const dirty = new Set(); // rows with unsaved edits are left alone when new data arrives

const fareOf = (routeId) => s.fares.find((f) => f.routeId === routeId);

function renderRankSelect() {
  const boarding = s.ranks.filter((r) => r.regionId);
  const other = s.ranks.filter((r) => !r.regionId);
  if (!s.rankById.has(rankId)) rankId = boarding[0]?.id ?? s.ranks[0]?.id;
  const opt = (r) => `<option value="${r.id}"${r.id === rankId ? ' selected' : ''}>${esc(r.name)}</option>`;
  $('#rank').innerHTML = `<optgroup label="Ranks passengers board at">${boarding.map(opt).join('')}</optgroup>
    ${other.length ? `<optgroup label="Destinations only (no region set)">${other.map(opt).join('')}</optgroup>` : ''}`;
}

function row(route) {
  const f = fareOf(route.id);
  const to = s.rankName(route.toRankId);
  const midnight = f?.until === '24:00';
  return `<li class="user-row fare-row" data-route="${route.id}">
    <div class="user-main">
      <b>To ${esc(to)}</b>
      <span class="small muted">${f ? `${priceLabel(f.price)}, ${esc(f.from)} to ${midnight ? 'midnight' : esc(f.until)}${f.updatedBy ? ` · set by ${esc(f.updatedBy)} ${esc(ago(f.updatedAt))}` : ''}` : 'Not shown to passengers yet'}</span>
    </div>
    <form class="fare-form" novalidate>
      <label class="field">First taxi <input class="input" type="time" name="from" step="60" value="${esc(f?.from ?? '05:00')}" required></label>
      <label class="field">Last taxi <input class="input" type="time" name="until" step="60" value="${esc(midnight ? '23:59' : f?.until ?? '20:00')}"${midnight ? ' disabled' : ''} required></label>
      <label class="check small"><input type="checkbox" name="midnight"${midnight ? ' checked' : ''}> Until midnight</label>
      <label class="field">Price (R) <input class="input" type="number" name="price" min="0.5" max="2000" step="0.5" inputmode="decimal" value="${f ? f.price : ''}" placeholder="25" required></label>
      <div class="user-tools">
        <button class="btn sm primary" type="submit">${f ? 'Save' : 'Show to passengers'}</button>
        ${f ? '<button class="btn sm danger" type="button" data-remove>Stop showing</button>' : ''}
      </div>
    </form>
  </li>`;
}

function render() {
  renderRankSelect();
  const rank = s.rankById.get(rankId);
  if (!rank) {
    $('#fares').innerHTML = '<li class="muted">There are no ranks yet. Add one in Ranks &amp; routes.</li>';
    return;
  }
  $('#rank-note').innerHTML = rank.regionId
    ? `<p class="small muted">Listed for passengers under ${esc(REGION_NAME.get(rank.regionId) ?? rank.regionId)}.</p>`
    : '<p class="banner" style="border:1px solid var(--line);border-radius:var(--r-s)">Passengers can\'t board at this rank in the app: it has no region. Set its region in <a href="/editor.html">Ranks &amp; routes</a> to list it.</p>';

  const routes = s.routes.filter((r) => r.fromRankId === rank.id)
    .sort((a, b) => !!fareOf(b.id) - !!fareOf(a.id) || s.rankName(a.toRankId).localeCompare(s.rankName(b.toRankId)));
  dirty.clear();
  $('#fares').innerHTML = routes.length ? routes.map(row).join('') : '<li class="muted">No destinations from this rank yet. Add one below.</li>';

  const linked = new Set(routes.map((r) => r.toRankId));
  const options = s.ranks.filter((r) => r.id !== rank.id && !linked.has(r.id));
  $('#add-to').innerHTML = options.length
    ? options.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')
    : '<option value="">Every rank is already a destination</option>';

  const log = s.events.filter((e) => e.type === 'FARE' && e.rankId === rank.id).slice(0, 20);
  $('#log').innerHTML = log.length
    ? log.map((e) => `<li><div class="event"><time datetime="${new Date(e.at).toISOString()}" title="${esc(ago(e.at))}">${clockTime(e.at)}</time>
        <span class="what"><span>${esc(e.detail)}</span></span><span class="by">${e.by ? `by ${esc(e.by)}` : ''}</span></div></li>`).join('')
    : '<li class="empty">No changes yet.</li>';
}

connect({
  staff: true,
  onSnapshot(snap) {
    const first = !s;
    s = snap;
    if (first || !dirty.size) render();
  },
});

$('#rank').addEventListener('change', (e) => {
  rankId = Number(e.target.value);
  local.set('fares-rank', rankId);
  render();
});

$('#fares').addEventListener('input', (e) => {
  const li = e.target.closest('[data-route]');
  if (li) dirty.add(li.dataset.route);
  if (e.target.name === 'midnight') e.target.form.elements.namedItem('until').disabled = e.target.checked;
});

$('#fares').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const routeId = form.closest('[data-route]').dataset.route;
  const field = (n) => form.elements.namedItem(n);
  const body = {
    from: field('from').value,
    until: field('midnight').checked ? '24:00' : field('until').value,
    price: Number(field('price').value),
  };
  await busy(e.submitter, async () => {
    try {
      toast((await api(`/api/routes/${routeId}/fare`, { method: 'PUT', body })).message);
      dirty.delete(routeId);
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

$('#fares').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const routeId = b.closest('[data-route]').dataset.route;
  const route = s.routeById.get(Number(routeId));
  const ok = await confirmDialog(`Stop showing ${s.routeLabel(route.id)}?`, 'Passengers will no longer see this destination, its hours or its price. The route stays for marshals.', 'Stop showing', { danger: true });
  if (!ok) return;
  await busy(b, async () => {
    try {
      toast((await api(`/api/routes/${routeId}/fare`, { method: 'DELETE' })).message);
      dirty.delete(routeId);
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const toRankId = Number($('#add-to').value);
  if (!toRankId) return;
  await busy(e.submitter, async () => {
    try {
      // both ways, so taxis can queue back; the fare for the way back is set at that rank
      toast((await api('/api/routes', { method: 'POST', body: { fromRankId: rankId, toRankId, bothWays: true } })).message);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

import { $, esc, local, connect, plate, clock, eta } from './common.js';

const params = new URLSearchParams(location.search);
let rankId = Number(params.get('rank')) || local.get('board-rank');
let s = null;

function tick() {
  $('#b-clock').textContent = new Date(clock.now()).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
}
tick();
setInterval(tick, 5000);

function render() {
  if (!s.rankById.has(rankId)) rankId = s.ranks[0]?.id;
  const rank = s.rankById.get(rankId);
  if (!rank) return;
  local.set('board-rank', rankId);
  document.title = `${rank.name} rank screen | BTA`;
  $('#b-rank').textContent = rank.name;
  $('#b-switch').innerHTML = s.ranks.map((r) => `<option value="${r.id}"${r.id === rankId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');

  const routes = s.routes.filter((r) => r.fromRankId === rankId).sort((a, b) => s.rankName(a.toRankId).localeCompare(s.rankName(b.toRankId)));
  $('#b-rows').innerHTML = routes.map((r) => {
    const queue = s.queue.filter((q) => q.routeId === r.id).sort((a, b) => a.position - b.position);
    const [front, next] = queue;
    const t = front && s.taxiById.get(front.taxiId);
    if (!t) {
      return `<li class="board-row"><span class="to"><small>To</small>${esc(s.rankName(r.toRankId))}</span><span></span>
        <span class="state" style="color:#b4b9ff">No taxi loading yet</span></li>`;
    }
    const left = t.capacity - front.seats;
    const full = left === 0;
    const nt = next && s.taxiById.get(next.taxiId);
    return `<li class="board-row${full ? ' full' : ''}">
      <span class="to"><small>To</small>${esc(s.rankName(r.toRankId))}</span>
      ${plate(t.plate)}
      <span class="state">${full ? 'Full, leaving now' : `${left} seat${left === 1 ? '' : 's'} left`}
        <span class="seatsline" aria-hidden="true">${Array.from({ length: t.capacity }, (_, i) => `<i${i < front.seats ? ' class="on"' : ''}></i>`).join('')}</span></span>
      ${nt ? `<span class="then">Next: ${esc(nt.plate)}${queue.length > 2 ? `, then ${queue.length - 2} more` : ''}</span>` : ''}
    </li>`;
  }).join('') || '<li class="board-empty">No routes leave from this rank yet.</li>';

  const coming = s.trips
    .filter((tr) => !tr.arrivedAt && s.routeById.get(tr.routeId)?.toRankId === rankId && s.taxiById.get(tr.taxiId)?.tripId === tr.id)
    .map((tr) => ({ tr, left: tr.departedAt + tr.durationMs - clock.now() }))
    .sort((a, b) => a.left - b.left)
    .slice(0, 4);
  $('#b-arrivals').innerHTML = coming.length
    ? `On the way in: ${coming.map(({ tr, left }) => `<b>${esc(s.taxiById.get(tr.taxiId).plate)}</b> from ${esc(s.rankName(s.routeById.get(tr.routeId).fromRankId))}, ${eta(left)}`).join('; ')}.`
    : '';
}

$('#b-switch').addEventListener('change', (e) => {
  rankId = Number(e.target.value);
  history.replaceState(null, '', `/board?rank=${rankId}`);
  render();
});

connect({
  onSnapshot(snap) {
    s = snap;
    render();
  },
});
setInterval(() => s && render(), 15_000);

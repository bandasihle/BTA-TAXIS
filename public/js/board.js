import { $, esc, local, connect, plate, clock, eta, api, renderTopbar } from './common.js';
import { mountMenu } from './menu.js';

// The same header as every other screen: staff get their screens and the Menu; anyone else
// (a passenger, or the wall screen before anyone signs in) gets the Danki Driver bar and Menu.
api('/api/session')
  .then(({ user: me }) => {
    if (!me || me.mustChangePin || !['admin', 'marshal'].includes(me.role)) throw new Error('not staff');
    renderTopbar('/board.html', me);
    if (me.role === 'marshal' && !new URLSearchParams(location.search).get('rank')) {
      rankId = me.rankId; // a marshal's rank screen opens on their own rank
      if (s) render();
    }
  })
  .catch(() => {
    const bar = $('#topbar');
    bar.className = 'sh';
    bar.innerHTML = `<div class="sh-in">
        <a class="sh-word" href="/" aria-label="Danki Driver, find a taxi">Danki <b>Driver</b></a>
        <span class="sh-end"><button class="sh-btn sh-menu" id="menu-btn" type="button"></button>
          <img src="/img/dankie-logo-128.jpg" width="36" height="36" alt="Dankie Driver, Benoni Taxi Association"></span>
      </div>`;
    mountMenu($('#menu-btn'));
  });

// On the wall the screen hides the header and fills the display; Esc or a tap on the button
// brings it back.
$('#b-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-wall', !!document.fullscreenElement);
  $('#b-full').textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen for the wall';
});

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
  document.title = `${rank.name} rank screen | Danki Driver`;
  $('#b-rank').textContent = rank.name;
  $('#b-switch').innerHTML = s.ranks.map((r) => `<option value="${r.id}"${r.id === rankId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');

  const routes = s.routes.filter((r) => r.fromRankId === rankId).sort((a, b) => s.rankName(a.toRankId).localeCompare(s.rankName(b.toRankId)));
  $('#b-rows').innerHTML = routes.map((r) => {
    const queue = s.queue.filter((q) => q.routeId === r.id).sort((a, b) => a.position - b.position);
    const [front, next] = queue;
    const t = front && s.taxiById.get(front.taxiId);
    if (!t) {
      return `<li class="board-row"><span class="to"><small>To</small>${esc(s.rankName(r.toRankId))}</span><span></span>
        <span class="state board-none">No taxi loading yet</span></li>`;
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
  history.replaceState(null, '', `/board.html?rank=${rankId}`);
  render();
});

connect({
  onSnapshot(snap) {
    s = snap;
    render();
  },
});
setInterval(() => s && render(), 15_000);

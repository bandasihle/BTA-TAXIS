import { $, esc, local, renderTopbar, connect, FOOTER, registerServiceWorker, mark } from './common.js';

renderTopbar('/staff');
$('#footer').innerHTML = FOOTER;
registerServiceWorker();

let filled = false;
connect({
  onSnapshot(s) {
    if (!filled) {
      filled = true;
      const opts = s.ranks.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
      $('#marshal-rank').insertAdjacentHTML('beforeend', opts);
      $('#board-rank').insertAdjacentHTML('beforeend', opts);
      const last = local.get('marshal-rank');
      if (last && s.rankById.has(last)) $('#marshal-rank').value = last;
    }
    const count = (st) => s.taxis.filter((t) => t.status === st).length;
    $('#live').innerHTML = [
      ['EN_ROUTE', 'on the road'],
      ['LOADING', 'loading'],
      ['QUEUED', 'queued'],
    ].map(([st, label]) => `<span class="chip" style="cursor:default">${mark(st)}<b>${count(st)}</b> ${label}</span>`).join('');
  },
});

$('#marshal-go').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#marshal-rank').value;
  if (id) location.href = `/marshal?rank=${id}`;
});
$('#board-go').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#board-rank').value;
  if (id) location.href = `/board?rank=${id}`;
});

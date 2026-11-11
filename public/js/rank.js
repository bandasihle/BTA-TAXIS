// A marshal's own rank: the fares passengers see from it, and its spot on the map. The
// marshal asks; the association office approves before anything changes for passengers. The
// server takes the rank from the marshal's session and checks everything again.
import {
  $, esc, api, toast, busy, confirmDialog, renderTopbar, requireStaff, connect, ago, clock, renderKeepingFocus, registerServiceWorker,
} from './common.js';
import { priceLabel, timeLabel, dayLabel } from './fares.js';

const me = await requireStaff(['marshal']);
renderTopbar('/rank.html', me);
registerServiceWorker();

const app = $('#app');
let s = null;
let spot = { busy: false, text: '', kind: '' };

const DAY_MS = 86_400_000;
const saDay = (ms) => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10); // South African date
const hours = (f) => `${timeLabel(f.from)} to ${f.until === '24:00' ? 'midnight' : timeLabel(f.until)}`;
const fareLine = (f) => `${priceLabel(f.price)}, ${hours(f)}`;
const metres = (km) => (km < 1 ? `${Math.max(1, Math.round(km * 1000))} m` : `${km.toFixed(1)} km`);

function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

connect({
  staff: true,
  onSnapshot(snap) {
    s = snap;
    if (!document.querySelector('dialog[open]')) render();
  },
});
setInterval(() => s && !document.querySelector('dialog[open]') && render(), 30_000); // keep "5 min ago" fresh

// ------------------------------------------------------------------ what to show

/** Every destination from this rank: its route, fare, planned change, open request and last refusal. */
function destinations(rank) {
  const mine = s.proposals.filter((p) => p.kind === 'FARE' && p.rankId === rank.id);
  const ids = new Set([
    ...s.routes.filter((r) => r.fromRankId === rank.id).map((r) => r.toRankId),
    ...mine.filter((p) => p.status === 'PENDING').map((p) => p.toRankId),
  ]);
  return [...ids].filter((id) => s.rankById.has(id)).map((toId) => {
    const route = s.routes.find((r) => r.fromRankId === rank.id && r.toRankId === toId);
    const asked = mine.filter((p) => p.toRankId === toId); // newest first
    const open = asked.find((p) => p.status === 'PENDING') ?? null;
    const last = asked.find((p) => p.status !== 'PENDING');
    return {
      toId, name: s.rankName(toId),
      fare: route ? s.fares.find((f) => f.routeId === route.id) ?? null : null,
      planned: route ? s.fareChanges.find((c) => c.routeId === route.id) ?? null : null,
      open,
      declined: !open && last?.status === 'DECLINED' && clock.now() - last.decidedAt < 14 * DAY_MS ? last : null,
    };
  }).sort((a, b) => !!b.fare - !!a.fare || a.name.localeCompare(b.name));
}

function fareRow(d) {
  const theirs = d.open && d.open.byId !== me.id;
  return `<li class="rk-row">
    <div class="rk-main">
      <b>To ${esc(d.name)}</b>
      ${d.fare ? `<span class="rk-fare">${esc(fareLine(d.fare))}</span>` : '<span class="muted">No fare yet. Passengers can\'t see this destination.</span>'}
      ${d.planned ? `<span class="rk-note">Changes to ${esc(fareLine(d.planned))} on ${esc(dayLabel(d.planned.startsOn))}. Passengers can see this.</span>` : ''}
      ${d.open ? `<span class="rk-wait">Waiting for the office: ${esc(fareLine(d.open))}${d.open.startsOn ? `, from ${esc(dayLabel(d.open.startsOn))}` : ''}
        <small>Sent ${theirs ? `by ${esc(d.open.by)} ` : ''}${esc(ago(d.open.at))}</small></span>` : ''}
      ${d.declined ? `<span class="rk-no">The office said no to ${esc(fareLine(d.declined))}${d.declined.reason ? `: ${esc(d.declined.reason)}` : '.'}</span>` : ''}
    </div>
    <div class="actions">
      ${theirs ? '' : `<button class="btn sm" type="button" data-action="fare" data-to="${d.toId}" data-key="fare-${d.toId}">${d.open ? 'Change what I sent' : d.fare ? 'Ask to change' : 'Set the fare'}</button>`}
      ${d.open && !theirs ? `<button class="btn sm quiet" type="button" data-action="withdraw" data-id="${d.open.id}" data-key="back-${d.open.id}">Take back</button>` : ''}
    </div>
  </li>`;
}

function spotSection(rank) {
  const asked = s.proposals.filter((p) => p.kind === 'LOCATION' && p.rankId === rank.id);
  const open = asked.find((p) => p.status === 'PENDING');
  const last = asked.find((p) => p.status !== 'PENDING');
  const declined = !open && last?.status === 'DECLINED' && clock.now() - last.decidedAt < 14 * DAY_MS ? last : null;
  const theirs = open && open.byId !== me.id;
  return `<section class="m-section rk-spot" aria-label="Where the rank is">
    <h2>Where the rank is on the map</h2>
    <p class="st ${rank.verified ? 'go' : 'soon'}">${rank.verified ? 'The pin is on the exact rank.' : 'The pin is only on the area, not on the rank itself.'}</p>
    ${open ? `<p class="rk-wait">Waiting for the office: a new spot, ${esc(metres(distanceKm([rank.lat, rank.lng], [open.lat, open.lng])))} from the pin.
        <small>Sent ${theirs ? `by ${esc(open.by)} ` : ''}${esc(ago(open.at))}</small></p>
        ${theirs ? '' : `<button class="btn sm quiet" type="button" data-action="withdraw" data-id="${open.id}" data-key="back-${open.id}">Take back</button>`}`
    : `<button class="btn ${rank.verified ? '' : 'primary'} rk-mark" type="button" data-action="spot" data-key="spot" ${spot.busy ? 'disabled' : ''}>${spot.busy ? 'Finding where you are…' : rank.verified ? 'Mark the spot again from here' : 'Mark the rank\'s spot from here'}</button>
       <p class="small muted">Stand at the rank, out in the open. Your phone's location is sent once, only after you confirm, and the office checks it before the map changes.</p>`}
    <p class="rk-status ${esc(spot.kind)}" role="status">${esc(spot.text)}</p>
    ${declined ? `<p class="rk-no">The office said no to the last spot${declined.reason ? `: ${esc(declined.reason)}` : '.'}</p>` : ''}
  </section>`;
}

function render() {
  const rank = s.rankById.get(me.rankId);
  if (!rank) {
    app.innerHTML = '<p class="muted" style="padding:24px 0">Your account is not linked to a rank. Ask the office to set your rank.</p>';
    return;
  }
  const list = destinations(rank);
  const canAdd = s.ranks.some((r) => r.id !== rank.id && !list.some((d) => d.toId === r.id));
  renderKeepingFocus(app, `
    <div class="m-head">
      <a class="rk-back" href="/marshal.html?rank=${rank.id}">Back to the queue</a>
      <h1 class="m-rank">${esc(rank.name)}</h1>
      <p class="muted">The fares passengers see from this rank, and where it is on the map. What you send goes to the association office, and passengers see it once the office approves.</p>
    </div>
    <section class="m-section" aria-label="Fares from this rank">
      <h2>Fares from this rank</h2>
      ${list.length ? `<ul class="rk-list">${list.map(fareRow).join('')}</ul>` : '<p class="muted">No destinations yet. Add the first one.</p>'}
      ${canAdd ? '<button class="btn rk-add" type="button" data-action="add" data-key="add">Add a destination</button>' : ''}
    </section>
    ${spotSection(rank)}
  `);
}

// ------------------------------------------------------------------ the fare form

const dlg = $('#fare-dlg');
const field = (id) => $(`#fd-${id}`);
let formTo = null;

function showError(text) {
  field('error').textContent = text;
}

function openFare(toId) {
  const rank = s.rankById.get(me.rankId);
  const list = destinations(rank);
  const d = toId ? list.find((x) => x.toId === toId) : null;
  formTo = toId;
  const start = d?.open ?? d?.planned ?? d?.fare ?? null;
  field('title').textContent = d ? `Fare to ${d.name}` : 'Add a destination';
  field('now').textContent = d?.fare ? `Passengers see ${fareLine(d.fare)} now.` : d ? 'Passengers can\'t see this destination yet.' : 'Choose where taxis go from this rank, then the hours and price.';
  field('to-wrap').hidden = !!d;
  if (!d) {
    field('to').innerHTML = s.ranks.filter((r) => r.id !== rank.id && !list.some((x) => x.toId === r.id))
      .map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  }
  const midnight = start?.until === '24:00';
  field('from').value = start?.from ?? '05:00';
  field('until').value = midnight ? '23:59' : start?.until ?? '20:00';
  field('until').disabled = midnight;
  field('midnight').checked = midnight;
  field('price').value = start?.price ?? '';
  const today = clock.now();
  field('date').min = saDay(today + DAY_MS);
  field('date').max = saDay(today + 90 * DAY_MS);
  const onDate = !!d?.open?.startsOn && d.open.startsOn >= field('date').min;
  field('date').value = onDate ? d.open.startsOn : '';
  field('date').hidden = !onDate;
  dlg.querySelector(`[name="start"][value="${onDate ? 'date' : 'now'}"]`).checked = true;
  showError('');
  dlg.showModal();
  (d ? field('price') : field('to')).focus();
}

field('midnight').addEventListener('change', (e) => (field('until').disabled = e.target.checked));
dlg.addEventListener('change', (e) => {
  if (e.target.name !== 'start') return;
  field('date').hidden = e.target.value !== 'date';
  if (!field('date').hidden) field('date').focus();
});
field('cancel').addEventListener('click', () => dlg.close());

$('#fare-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const onDate = dlg.querySelector('[name="start"]:checked').value === 'date';
  const body = {
    toRankId: formTo ?? Number(field('to').value),
    from: field('from').value,
    until: field('midnight').checked ? '24:00' : field('until').value,
    price: Number(field('price').value),
    startsOn: onDate ? field('date').value : null,
  };
  // the same checks the server makes, said next to the form before anything is sent
  if (!body.toRankId) return showError('Choose a destination.');
  if (!body.from || !body.until) return showError('Enter the time of the first and the last taxi.');
  if (body.from >= body.until) return showError('The last taxi must leave after the first one.');
  if (!(body.price > 0)) return showError('Enter the price in rand, like 25 or 12.50.');
  if (onDate && !body.startsOn) return showError('Choose the date it starts.');
  showError('');
  await busy(field('submit'), async () => {
    try {
      const r = await api('/api/proposals/fare', { method: 'POST', body });
      dlg.close();
      toast(r.message);
      render();
    } catch (err) {
      showError(err.status ? err.message : 'No signal. Nothing was sent. Try again when you are back online.');
    }
  });
});

// ------------------------------------------------------------------ the rank's spot

/** The phone's best position within about 20 seconds: stops early on a good fix. */
function findMe() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This phone cannot share its location.'));
    let best = null;
    const done = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(new Error('Your phone could not find where you are. Check that location is on, then try again.'));
    };
    const timer = setTimeout(done, 20_000);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (best.accuracy <= 15) done();
      },
      (err) => {
        if (err.code !== err.PERMISSION_DENIED) return; // a slow fix: keep waiting until the timer
        navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        reject(new Error('Location is not allowed for Dankie Driver. Allow it in your phone\'s settings, then try again.'));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  });
}

async function markSpot() {
  const rank = s.rankById.get(me.rankId);
  spot = { busy: true, text: '', kind: '' };
  render();
  let fix;
  try {
    fix = await findMe();
  } catch (err) {
    spot = { busy: false, text: err.message, kind: 'warn' };
    return render();
  }
  spot = { busy: false, text: '', kind: '' };
  render();
  if (fix.accuracy > 50) {
    spot.text = `Your phone's location is only accurate to about ${Math.round(fix.accuracy)} m. Stand out in the open at the rank and try again.`;
    spot.kind = 'warn';
    return render();
  }
  const away = metres(distanceKm([rank.lat, rank.lng], [fix.lat, fix.lng]));
  const ok = await confirmDialog(
    'Send this spot to the office?',
    `You are ${away} from the pin on the map, and your phone is accurate to about ${Math.round(fix.accuracy)} m. Only send it if you are standing at ${rank.name} now.`,
    'Send the spot',
  );
  if (!ok) return;
  try {
    toast((await api('/api/proposals/location', { method: 'POST', body: fix })).message);
  } catch (err) {
    spot = { busy: false, text: err.status ? err.message : 'No signal. Nothing was sent. Try again when you are back online.', kind: 'warn' };
    render();
  }
}

app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || !s) return;
  switch (b.dataset.action) {
    case 'fare':
      openFare(Number(b.dataset.to));
      break;
    case 'add':
      openFare(null);
      break;
    case 'spot':
      if (!spot.busy) await markSpot();
      break;
    case 'withdraw': {
      const ok = await confirmDialog('Take it back?', 'The office will no longer see what you sent.', 'Take back');
      if (!ok) return;
      await busy(b, async () => {
        try {
          toast((await api(`/api/proposals/${Number(b.dataset.id)}`, { method: 'DELETE' })).message);
        } catch (err) {
          toast(err.status ? err.message : 'No signal. Try again when you are back online.', 'error');
        }
      });
      break;
    }
  }
});

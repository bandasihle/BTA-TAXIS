// Driver mode: after accepting the location notice, the driver switches sharing on and the
// phone sends its GPS position every few seconds while the taxi is on a trip. Sharing is
// always started by the driver, never automatically, and stops with one tap. In the app it
// carries on with the phone locked, with an Android notification showing the whole time.
import { $, esc, api, toast, busy, confirmDialog, renderTopbar, requireStaff, connect, clockTime } from './common.js';
import { CONSENT_VERSION, CONSENT_NOTICE } from './consent.js';
import { watchLocation, openLocationSettings, BACKGROUND } from './location.js';

const me = await requireStaff(['driver']);
renderTopbar('/driver.html', me);

const app = $('#app');
const SEND_EVERY_MS = 10_000;
const STATUS_TEXT = { OFF_DUTY: 'Off duty', ARRIVED: 'At a rank', QUEUED: 'In a queue', LOADING: 'Loading passengers', EN_ROUTE: 'On a trip' };

let info = null;
let taxiStatus = null;
let stopWatch = null;
let wakeLock = null;
let lastSent = 0;
let sending = false;
const IDLE = { text: '', at: null, accuracy: null, kind: '', denied: false };
let state = { ...IDLE };

async function load() {
  try {
    info = await api('/api/driver');
  } catch (err) {
    app.innerHTML = `<p class="signin-error">${esc(err.message)}</p>`;
    return;
  }
  taxiStatus = info.taxi?.status ?? null;
  render();
}

function render() {
  if (!info.taxi) {
    app.innerHTML = `<section class="driver-card"><h1>Hello ${esc(info.name)}</h1>
      <p>Your account is not linked to a taxi yet. Ask an admin at the association office to link you to the taxi you drive.</p></section>`;
    return;
  }
  if (!info.consented) return renderNotice();
  const on = stopWatch != null;
  app.innerHTML = `<section class="driver-card">
      <p class="small muted">You drive</p>
      <p class="driver-plate"><span class="plate">${esc(info.taxi.plate)}</span></p>
      <p class="small muted">Taxi status: <b>${esc(STATUS_TEXT[taxiStatus] ?? 'Unknown')}</b></p>
      <button class="btn ${on ? 'danger' : 'go'} driver-go" type="button" id="toggle">${on ? 'Stop sharing my location' : 'Start sharing my location'}</button>
      <p class="driver-state ${esc(state.kind)}" id="state">${on ? esc(state.text || 'Finding your position…') : esc(state.text || 'Not sharing. Nothing is sent until you press Start.')}</p>
      ${state.denied && BACKGROUND ? '<button class="btn" type="button" id="settings">Open phone settings</button>' : ''}
      ${on && state.at ? `<p class="small muted">Last sent at ${clockTime(state.at)}${state.accuracy != null ? `, accurate to about ${Math.round(state.accuracy)} m` : ''}.</p>` : ''}
      ${on ? `<p class="small muted">${BACKGROUND ? 'You can lock your phone or use other apps. A notification shows while sharing is on.' : 'Keep this page open and the screen on while you drive.'} Your position is only used while your taxi is on a trip.</p>` : ''}
    </section>
    <p class="small muted driver-foot">You agreed to the location notice on ${new Date(info.consentedAt).toLocaleDateString('en-ZA')}.
      <button class="btn sm quiet" type="button" id="notice">Read it again</button>
      <button class="btn sm quiet" type="button" id="withdraw">Withdraw consent</button></p>`;
  $('#toggle').addEventListener('click', () => (stopWatch == null ? start() : stop()));
  $('#settings')?.addEventListener('click', openLocationSettings);
  $('#notice').addEventListener('click', () => renderNotice(true));
  $('#withdraw').addEventListener('click', withdraw);
}

function renderNotice(reading = false) {
  app.innerHTML = `<section class="driver-card">
      <h1>Sharing your location</h1>
      <p>Before your phone shares anything, here is exactly what happens. Please read it.</p>
      <dl class="notice">${CONSENT_NOTICE.map(([h, t]) => `<dt>${esc(h)}</dt><dd>${esc(t)}</dd>`).join('')}</dl>
      ${reading ? '<button class="btn" type="button" id="back">Back</button>' : `
        <button class="btn go driver-go" type="button" id="agree">I agree: share my location while I drive</button>
        <p class="small muted">If you don't agree, nothing is shared. Marshals can still record your taxi at the ranks.</p>`}
    </section>`;
  $('#back')?.addEventListener('click', render);
  $('#agree')?.addEventListener('click', async (e) => {
    await busy(e.target, async () => {
      try {
        toast((await api('/api/driver/consent', { method: 'POST', body: { version: CONSENT_VERSION } })).message);
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// ------------------------------------------------------------------ sharing

function setState(text, kind = '', extra = {}) {
  state = { ...state, text, kind, ...extra };
  render();
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or refused; the driver keeps the screen on */
  }
}

function start() {
  lastSent = 0;
  state = { ...IDLE };
  stopWatch = watchLocation(onFix, onError);
  if (!BACKGROUND) keepAwake();
  setState('Finding your position…');
}

/** Stops sharing. Unless the server has already dropped it, the taxi's point is deleted now. */
function stop({ forget = true, text = '', denied = false } = {}) {
  stopWatch?.();
  stopWatch = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  state = { ...IDLE, text, kind: text ? 'warn' : '', denied };
  render();
  if (forget) api('/api/driver/position', { method: 'DELETE' }).catch(() => {});
}

async function onFix(fix) {
  if (stopWatch == null || sending || Date.now() - lastSent < SEND_EVERY_MS) return;
  sending = true;
  lastSent = Date.now();
  try {
    const r = await api('/api/driver/position', { method: 'POST', body: fix });
    if (stopWatch == null) return; // stopped while this was on its way
    setState(r.message, r.stored ? 'ok' : '', r.stored ? { at: Date.now(), accuracy: fix.accuracy } : {});
    if (r.arrived) toast(r.message);
  } catch (err) {
    if (err.status === 403 || err.status === 409) {
      stop({ forget: false });
      toast(err.message, 'error');
      load();
    } else if (stopWatch != null) setState(err.status ? err.message : 'No signal. Trying again…', 'warn');
  } finally {
    sending = false;
  }
}

function onError(err) {
  if (err.denied) {
    stop({
      text: BACKGROUND ? 'Location is not allowed for Danki Driver. Allow it in your phone settings, then press Start again.' : 'Location is blocked for this site. Allow it in your browser settings, then press Start again.',
      denied: true,
    });
  } else if (err.off) {
    stop({ text: 'Location is switched off on this phone. Switch it on, then press Start again.' });
  } else setState('Waiting for a GPS signal. Go outside or near a window if this takes long.', 'warn');
}

async function withdraw() {
  const ok = await confirmDialog('Withdraw consent?', 'Sharing stops now and your taxi\'s last position is deleted. You can agree again later.', 'Withdraw', { danger: true });
  if (!ok) return;
  stop({ forget: false }); // withdrawing deletes the point anyway
  try {
    toast((await api('/api/driver/consent', { method: 'DELETE' })).message);
  } catch (err) {
    toast(err.message, 'error');
  }
  load();
}

// The screen lock is dropped when the app goes to the background; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stopWatch != null && !BACKGROUND) keepAwake();
});

// The taxi's status (off duty, queued, on a trip) changes as marshals record it.
connect({
  onSnapshot(s) {
    const t = info?.taxi && s.taxiById.get(info.taxi.id);
    if (t && t.status !== taxiStatus) {
      taxiStatus = t.status;
      if (info.consented) render();
    }
  },
});

load();

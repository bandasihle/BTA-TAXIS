// The welcome screen. While it loads it asks the server who is signed in (which also wakes
// the server on its free plan). Signed-in staff go on to their own screen; everyone else
// chooses: continue as a passenger (no account) or staff sign in with phone and PIN, then,
// the first time or after a reset, choosing their own PIN.
import { $, api, session, homeFor, IS_APP, enter } from './common.js';

const signin = $('#signin');
const newpin = $('#newpin');
const loadMsg = $('#load-msg');
const head = $('#sh');
let tempPin = null;

const MIN_LOADING_MS = 600;
const SLOW_MS = 4000;
const GIVE_UP_MS = 70_000; // a sleeping free server can take most of a minute to wake

/** Only a path on this site, so a crafted link can't send someone elsewhere after signing in. */
function nextPage(user) {
  const next = new URLSearchParams(location.search).get('next');
  const safe = next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login');
  return safe ? next : homeFor(user);
}

// The staff form stays folded away behind a small link, so the welcome screen offers nothing to
// strangers but the passenger app. It opens by itself in the staff app, on a phone where staff
// have signed in before, from the Menu's "Staff sign in" (#staff), and when a session has ended.
// This only keeps it out of sight: the real protection is on the server (one answer for every
// failed sign-in, per-device limits, and locks that grow longer).
const STAFF_DEVICE = 'dk:staff-device';
const remembered = () => { try { return localStorage.getItem(STAFF_DEVICE) === '1'; } catch { return false; } };
let staffOpen = IS_APP || remembered() || location.hash === '#staff' || new URLSearchParams(location.search).has('next');
// Who may sign in here, from the server's WEB_STAFF setting. The app always may.
let staffWeb = 'on';

function show(form) {
  const mode = IS_APP ? 'on' : staffWeb;
  if (mode === 'admin') {
    $('#staff-open').textContent = 'Office sign in';
    $('#s-head').textContent = 'Office sign in';
    $('#s-blurb').textContent = 'For the association office. Drivers and rank marshals sign in on the Dankie Driver app.';
  }
  newpin.hidden = form !== newpin;
  signin.hidden = form !== signin || !staffOpen || mode === 'off';
  $('#staff-open').hidden = form !== signin || staffOpen || mode === 'off';
  $('#get-app').hidden = form !== signin || mode === 'on';
  $('#staff-open').setAttribute('aria-expanded', String(!signin.hidden));
  $('#passenger').closest('.gate-card').hidden = form === newpin;
  $('#gate-title').textContent = form === newpin ? 'Choose your PIN' : 'Find your taxi';
}

function done(user) {
  enter('staff');
  location.replace(nextPage(user));
}

function fail(box, message) {
  box.textContent = message;
  box.hidden = false;
}

function reveal({ offline = false } = {}) {
  $('#offline').hidden = !offline;
  document.body.classList.remove('is-loading');
  $('#loading').removeAttribute('role');
}

// ------------------------------------------------------------------ loading

const started = Date.now();
const slow = setTimeout(() => (loadMsg.textContent = 'Waking up the server. The first open of the day can take up to a minute…'), SLOW_MS);
const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { status: 0 })), GIVE_UP_MS));
let me = null;
let offline = false;
try {
  const s = await Promise.race([api('/api/session'), timeout]);
  me = s.user; // null when nobody is signed in
  staffWeb = s.staffWeb ?? 'on';
} catch (err) {
  offline = !err.status; // no answer at all, as opposed to "not signed in"
}
clearTimeout(slow);
await new Promise((r) => setTimeout(r, Math.max(0, MIN_LOADING_MS - (Date.now() - started))));

if (me && !me.mustChangePin) {
  loadMsg.textContent = `Signed in as ${me.name}. Opening your screen…`;
  done(me);
} else {
  if (me?.mustChangePin) {
    // reloaded after signing in with a temporary PIN: we no longer know it, so sign in again
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    session.clear();
    staffOpen = true;
    fail($('#signin-error'), 'Sign in again with your temporary PIN, then choose your own.');
  }
  show(signin);
  reveal({ offline });
}

// ------------------------------------------------------------------ choices

$('#staff-open').addEventListener('click', () => {
  staffOpen = true;
  show(signin);
  $('#phone').focus();
});

$('#passenger').addEventListener('click', () => {
  enter('passenger');
  location.replace('/');
});

signin.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#signin-error');
  err.hidden = true;
  const phone = $('#phone').value.trim();
  const pin = $('#pin').value.trim();
  if (!phone) return fail(err, 'Enter your cellphone number.');
  if (!/^\d{6}$/.test(pin)) return fail(err, 'Your PIN is 6 digits.');
  const button = signin.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const r = await api('/api/login', { method: 'POST', body: { phone, pin, client: IS_APP ? 'app' : 'web' } });
    if (r.token) session.set(r.token);
    try { localStorage.setItem(STAFF_DEVICE, '1'); } catch { /* private mode: the link stays */ }
    $('#pin').value = '';
    $('#offline').hidden = true;
    if (r.user.mustChangePin) {
      tempPin = pin;
      show(newpin);
      $('#new-pin').focus();
    } else done(r.user);
  } catch (ex) {
    fail(err, ex.status ? ex.message : 'No connection to the server. Check your data or Wi-Fi and try again.');
    $('#pin').value = '';
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

newpin.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#newpin-error');
  err.hidden = true;
  const a = $('#new-pin').value.trim();
  const b = $('#new-pin-2').value.trim();
  if (!/^\d{6}$/.test(a)) return fail(err, 'The PIN must be exactly 6 digits.');
  if (a !== b) return fail(err, 'The two PINs are different. Type the same PIN twice.');
  const button = newpin.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/me/pin', { method: 'POST', body: { oldPin: tempPin, newPin: a } });
    tempPin = null;
    done(await api('/api/me'));
  } catch (ex) {
    fail(err, ex.message);
    if (ex.status === 429) location.reload(); // locked and signed out: start again
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------------ header

addEventListener('scroll', () => {
  head.classList.toggle('is-scrolled', scrollY > 4);
  head.classList.toggle('has-title', scrollY > 48);
}, { passive: true });

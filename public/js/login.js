// Staff sign in: phone and PIN, then (first time, or after a reset) choosing their own PIN.
import { $, api, session, homeFor, signOut, IS_APP } from './common.js';

const signin = $('#signin');
const newpin = $('#newpin');
let tempPin = null;

/** Only a path on this site, so a crafted link can't send someone elsewhere after signing in. */
function nextPage(user) {
  const next = new URLSearchParams(location.search).get('next');
  const safe = next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login');
  return safe ? next : homeFor(user);
}

function show(form) {
  for (const el of [signin, newpin, $('#driver')]) el.hidden = el !== form;
  form.querySelector('input, button')?.focus();
}

function done(user) {
  if (user.role === 'driver') return show($('#driver'));
  location.replace(nextPage(user));
}

function fail(box, message) {
  box.textContent = message;
  box.hidden = false;
}

// Already signed in? Go straight on.
try {
  const me = await api('/api/me');
  if (me.mustChangePin) show(newpin);
  else done(me);
} catch {
  /* not signed in */
}

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
  try {
    const r = await api('/api/login', { method: 'POST', body: { phone, pin, client: IS_APP ? 'app' : 'web' } });
    if (r.token) session.set(r.token);
    $('#pin').value = '';
    if (r.user.mustChangePin) {
      tempPin = pin;
      show(newpin);
    } else done(r.user);
  } catch (ex) {
    fail(err, ex.message);
    $('#pin').value = '';
  } finally {
    button.disabled = false;
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
  if (!tempPin) {
    // reloaded after signing in with a temporary PIN: sign in again so we know the old one
    await signOut();
    return;
  }
  const button = newpin.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/me/pin', { method: 'POST', body: { oldPin: tempPin, newPin: a } });
    tempPin = null;
    done(await api('/api/me'));
  } catch (ex) {
    fail(err, ex.message);
  } finally {
    button.disabled = false;
  }
});

$('#driver-out').addEventListener('click', signOut);

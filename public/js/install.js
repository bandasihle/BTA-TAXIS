// "Add Dankie Driver to your home screen", for passengers on the website.
// Shown once a passenger has opened a rank (so they've seen what the site is for), never in the
// staff app, never when already installed, and never again after "Not now" or an install.
// Android Chrome gives us its install prompt; iPhones have none, so we say where the button is.
import { IS_APP, local } from './common.js';

const KEY = 'install-bar-done';
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferred = null;
let offered = false;

if (!IS_APP) {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep Chrome's own banner quiet; we ask at a better moment
    deferred = e;
  });
  addEventListener('appinstalled', () => {
    local.set(KEY, true);
    document.getElementById('dk-install')?.remove();
  });
}

function close(remember) {
  if (remember) local.set(KEY, true);
  document.getElementById('dk-install')?.remove();
}

/** Call when a rank's screen opens. Waits a moment so the fares come first. */
export function offerInstall() {
  if (IS_APP || offered || local.get(KEY) || standalone()) return;
  offered = true;
  setTimeout(() => {
    if (!deferred && !isIOS) return; // this browser can't install sites, or already did
    const bar = document.createElement('aside');
    bar.id = 'dk-install';
    bar.className = 'dk-install';
    bar.setAttribute('aria-label', 'Add to home screen');
    bar.innerHTML = `
      <p><b>Add Dankie Driver to your home screen.</b>
        ${deferred ? 'It opens like an app and shows the last fares without signal.' : 'Tap <b>Share</b>, then <b>Add to Home Screen</b>.'}</p>
      <span class="dk-install-do">
        ${deferred ? '<button type="button" class="dk-install-go">Add</button>' : ''}
        <button type="button" class="dk-install-x">${deferred ? 'Not now' : 'Got it'}</button>
      </span>`;
    bar.querySelector('.dk-install-x').addEventListener('click', () => close(true));
    bar.querySelector('.dk-install-go')?.addEventListener('click', async () => {
      const prompt = deferred;
      deferred = null;
      close(false);
      prompt.prompt();
      await prompt.userChoice.catch(() => {});
      local.set(KEY, true); // asked once, whatever they chose
    });
    document.body.append(bar);
  }, 4000);
}

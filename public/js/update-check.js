// In the sideload app only: once per start, ask the server for the latest version and, when it
// is newer than this one, offer the download page. Never installs anything by itself.
import { api, API_BASE, esc } from './common.js';
import { BUILD } from './build-info.js';

const SEEN = 'dk:update-checked';

export async function checkForUpdate() {
  if (!BUILD.updateCheck) return;
  try {
    if (sessionStorage.getItem(SEEN)) return;
    sessionStorage.setItem(SEEN, '1');
  } catch { /* storage blocked: check anyway */ }
  let latest;
  try {
    latest = await api('/api/app-version');
  } catch {
    return; // offline or an older server: try again next start
  }
  if (!latest?.apkUrl || !(Number(latest.versionCode) > BUILD.versionCode)) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/update.css';
  document.head.append(link);
  const bar = document.createElement('div');
  bar.className = 'upd';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<p>A new version of Dankie Driver is ready (${esc(latest.versionName)}).</p>
    <a class="upd-go" href="${esc(API_BASE)}/download" target="_blank" rel="noopener">Update</a>
    <button class="upd-x" type="button" aria-label="Not now">Not now</button>`;
  bar.querySelector('.upd-x').addEventListener('click', () => bar.remove());
  document.body.prepend(bar);
}

// The app menu: the header's Menu button opens a sheet listing where this person can go,
// who is signed in, and signing in or out. The server checks every screen again; the menu
// only leaves out what a role can't open.
import { esc, NAV, navHref, signOut } from './common.js';

const ROLE = { admin: 'Association office', marshal: 'Rank marshal', driver: 'Driver' };
const ICON = {
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

let cssLoaded = false;
function loadCss() {
  if (cssLoaded) return;
  cssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/menu.css';
  document.head.append(link);
}

function items(user) {
  const list = [['/', 'Find a taxi', 'Ranks, fares and taxis on the way']];
  if (user?.role === 'driver') list.push(['/driver.html', 'Share my location', 'Start and stop sharing your taxi\'s position']);
  for (const [href, label, roles] of NAV) {
    if (!roles.includes(user?.role)) continue;
    list.push([navHref(href, user), label.replace('&amp;', '&'), '']);
  }
  return list;
}

/** Wires `button` to open the menu. `onSignOut` lets a screen tidy up first (the driver's GPS). */
export function mountMenu(button, { user = null, current = location.pathname, onSignOut = signOut } = {}) {
  if (!button) return;
  loadCss();
  if (!button.querySelector('svg') && !button.textContent.trim()) button.innerHTML = `${ICON.menu}<span>Menu</span>`;
  button.setAttribute('aria-haspopup', 'dialog');

  const dlg = document.createElement('dialog');
  dlg.className = 'mn';
  dlg.setAttribute('aria-label', 'Menu');
  const here = (href) => href.split('?')[0] === current;
  dlg.innerHTML = `
    <div class="mn-top">
      <span class="mn-word">Danki <b>Driver</b></span>
      <button class="mn-close" type="button" aria-label="Close menu">${ICON.close}</button>
    </div>
    ${user ? `<p class="mn-who"><b>${esc(user.name)}</b><span>${esc(ROLE[user.role] ?? '')}</span></p>` : ''}
    <nav aria-label="Screens"><ul class="mn-list">
      ${items(user).map(([href, label, sub]) => `<li><a href="${esc(href)}"${here(href) ? ' aria-current="page"' : ''}>
        <span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</a></li>`).join('')}
    </ul></nav>
    <div class="mn-end">
      ${user ? '<button class="mn-out" type="button">Sign out</button>' : '<a class="mn-in" href="/login.html#staff">Staff sign in</a><p>For drivers, rank marshals and the association office.</p>'}
    </div>
    <p class="mn-foot">Benoni Taxi Association. The wheels of the nation.</p>`;
  document.body.append(dlg);

  button.addEventListener('click', () => {
    dlg.showModal();
    button.setAttribute('aria-expanded', 'true');
  });
  dlg.addEventListener('close', () => {
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  });
  dlg.querySelector('.mn-close').addEventListener('click', () => dlg.close());
  // a tap on the dimmed page outside the sheet closes it
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.querySelector('.mn-out')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await onSignOut();
  });
}

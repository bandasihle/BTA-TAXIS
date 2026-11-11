// Copies the web pages into www/ for the Android app (Capacitor), with Leaflet at
// /vendor/leaflet/ where the server would normally serve it. Run with `npm run app:build`.
//
// In the app the pages load from the phone, not from the server, so they don't get the
// server's Content-Security-Policy header. Each page gets the same policy as a <meta> tag
// instead, allowing only the live API, the map tiles and the page's own inline scripts
// (by hash). Capacitor adds its bridge as a document-start script, which CSP doesn't block.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const WWW = path.join(ROOT, 'www');
// The app talks to the address in API_BASE (public/js/common.js), so that one line is the
// only place to change when the server moves; the app's CSP is built from it here.
const API = fs.readFileSync(path.join(ROOT, 'public/js/common.js'), 'utf8')
  .match(/export const API_BASE = NATIVE \? '(https:\/\/[a-z0-9.-]+)' : '';/)?.[1];
if (!API) throw new Error('build-app: could not read an https API_BASE from public/js/common.js');

fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), WWW, { recursive: true });
fs.rmSync(path.join(WWW, 'sw.js'));
// website-only pages, and the web's build-info.js: the Android build writes the app's own
for (const f of ['download.html', 'download', 'js/download.js', 'js/build-info.js', 'robots.txt']) fs.rmSync(path.join(WWW, f), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), path.join(WWW, 'vendor', 'leaflet'), { recursive: true });

function policy(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    `connect-src 'self' ${API}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

for (const name of fs.readdirSync(WWW).filter((f) => f.endsWith('.html'))) {
  const file = path.join(WWW, name);
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes('<meta charset="utf-8">')) throw new Error(`${name}: expected <meta charset="utf-8"> to place the policy after`);
  fs.writeFileSync(file, html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy(html)}">`));
}

console.log(`Copied the app pages to ${path.relative(ROOT, WWW)}/, each with a Content-Security-Policy`);

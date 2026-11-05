// Copies the web pages into www/ for the Android app (Capacitor), with Leaflet at
// /vendor/leaflet/ where the server would normally serve it. Run with `npm run app:build`.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WWW = path.join(ROOT, 'www');

fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), WWW, { recursive: true });
fs.rmSync(path.join(WWW, 'sw.js'));
fs.cpSync(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), path.join(WWW, 'vendor', 'leaflet'), { recursive: true });

console.log(`Copied the app pages to ${path.relative(ROOT, WWW)}/`);

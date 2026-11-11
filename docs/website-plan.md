# Website plan: passenger site + staff app download

Written 2026-11-11 as a handoff, then built the same day on `unslop-preview`. One change from
the first draft: the owner wants the **admin screens on office computers** ("no negotiation"),
so the switch has an `admin` mode, and that is what the live site uses.
Target: live for the testers' build on 2026-11-28.

## Status

| Phase | State | Commit |
|---|---|---|
| 1. Rename to Dankie Driver | Done | `dc6f543` |
| 2. `WEB_STAFF` switch (`on` / `admin` / `off`) | Done, live site uses `admin` | `091470b` |
| 3. `/download` and the update check | Done (waits for the first release) | `93577d1` |
| 4. `/privacy` | Done, **owner contact details still missing** | `93577d1` |
| 5. Passenger install, link previews, robots.txt | Done | `76c52ef` |
| 6. Point the app at the domain | Prepared (`ad408eb`); waits for the domain | |

## Decisions (made by the owner, 2026-11-11)

| Question | Decision |
|---|---|
| Spelling | **Dankie Driver** everywhere (it matches the logo). |
| Domain | A .co.za for "dankiedriver" (owner registers; written `DOMAIN` below). |
| APK hosting | GitHub Releases on `bandasihle/BTA-TAXIS`. The repo is public for now; the owner would prefer private later (see "If the repo goes private"). |
| Download link | Visible to everyone: in the website Menu and footer. |
| Staff on the website | **Admins only**, on any computer, same look as the app. Drivers and marshals use the Android app. |

## The idea

One website on `DOMAIN`, served by the existing Render service, which also keeps serving the API.

| Who | Where | What they get |
|---|---|---|
| Passenger | Website, in the browser or installed to the home screen | Map, ranks, fares, taxis on the way, the rank board. No account. |
| Admin | Website on a computer, or the app | Dashboard, staff, fares, ranks, users, phone + PIN. |
| Driver, marshal | Android app only | Their screens as today, phone + PIN. |
| Anyone | `/download` | The app download and install steps. |
| Anyone | `/privacy` | The privacy policy (Play needs it later too). |

## Rules for whoever builds this

- Work on branch `unslop-preview`. Commit as `bandasihle`, with **no AI or Claude attribution**
  in commits, PRs or files.
- **Do not push `main`** until the owner says Render is on Starter with a disk. `main`
  auto-deploys, and the free plan wipes the database.
- Security first. Every change below that touches sign-in or serving needs tests.
- UI: use the unslop style and the logo colours (royal blue, navy, livery red). Plain words in
  every label and message.
- Deliver as local files and commits. No web documents.
- Local preview: `PORT=3420 DB_FILE=<scratch>/preview.db npm start`. Demo PINs go in a scratch
  file, never in chat or the repo.
- Each phase below is one commit. Run `npm test` (92 pass today) before each.

## Phase 1: rename to Dankie Driver

About 55 places say "Danki Driver": `public/` pages and scripts, `public/manifest.webmanifest`,
`capacitor.config.json` (`appName`), Android `strings.xml`, `README.md`, `package.json`,
server log lines.

- Change the visible name everywhere to **Dankie Driver**.
- **Keep** the app id `za.co.bta.dankidriver`. Changing it would make a different app and
  break updates for anyone who has it installed.
- Keep storage keys (`dk:...`) and the cookie name as they are.
- The header wordmark is two-tone (`Danki <b>Driver</b>`): keep that treatment.
- Done when: `git grep -P "Danki(?!e)"` finds only the app id, and the tests pass.

## Phase 2: the `WEB_STAFF` switch (as built)

Modes: `on` (every role on the website: local preview and tests), `admin` (live: the office
screens and admin sign-in on the website; `driver.html` and its script are 404; a driver or
marshal who signs in on the website gets 403 "Drivers and marshals sign in on the Dankie Driver
app." and the session is ended at once, no cookie), `off` (as described below). Any other value
stops the server. `/api/session` returns `staffWeb: 'on' | 'admin' | 'off'`. Tests:
`test/web-staff.test.js`.

The original `off` design, still available as `WEB_STAFF=off`:

An environment variable, read once in `server/server.js`. **Default is on** (today's behaviour),
so local preview and the tests keep working. `render.yaml` sets `WEB_STAFF: "off"`.

With `WEB_STAFF=off` the server must:

1. **Not serve staff pages.** In `serveStatic` (and the `PAGES` map), these return 404:
   `staff`, `marshal`, `dashboard`, `editor`, `users`, `fares`, `rank`, `driver` (both the short
   path and the `.html` file). Also 404 their scripts: `dashboard.js`, `marshal.js`, `editor.js`,
   `users.js`, `fares-admin.js`, `rank.js`, `driver.js`, `home.js`. Keep `index.html`,
   `login.html`, `board.html` and the shared files.
2. **Refuse website sign-in.** `POST /api/login` succeeds only when `body.client === 'app'`
   **and** the `Origin` header is in `APP_ORIGINS`. Otherwise 403: "Staff sign in is in the
   Dankie Driver app." Check this **before** calling `auth.login`, so a refused request doesn't
   count as a try and can't be used to lock accounts.
3. **Ignore cookies.** `signedIn()` accepts only `Authorization: Bearer`. The staff stream
   (`/api/stream?staff=1`) accepts only a ticket. Never send `Set-Cookie`.
4. **Tell the pages.** `GET /api/session` returns `{ user, staffWeb: false }` (true when the
   switch is on). The existing test that expects exactly `{ user: null }` needs updating.

Website pages, when `staffWeb` is false and it is not the app (`IS_APP` false):

- `public/js/login.js`: no staff form and no "Staff sign in" link. Show the passenger card and a
  quiet link "Drivers and marshals: get the app" to `/download`.
- `public/js/menu.js`: the "Staff sign in" entry becomes "Staff: get the app", to `/download`.
- `public/index.html` footer: "Association staff: rank tracker" becomes "Staff: get the app".
- `public/js/board.js`: already falls back to the passenger header when nobody is signed in.

In the app nothing changes: its pages are bundled in the APK, and `IS_APP` is true.

Be honest in comments about what this buys: no sign-in form on the open web, no cookies (so no
cookie theft and no cross-site request forgery), staff code not handed to visitors. It does not
stop requests sent straight to the API with a forged `Origin`; the limits from commit `da1d940`
(one answer for every failure, 20 tries per device per 15 minutes, locks of 15 min / 1 h / 4 h)
still do that job.

Tests to add (`test/api.test.js` starts a real server; start a second one with `WEB_STAFF=off`):
- each staff page and staff script is 404; `/`, `/login.html`, `/board.html` are 200
- website sign-in with a correct PIN is 403, sets no cookie, and does not count as a failed try
- app sign-in (`client: 'app'`, `Origin: https://localhost`) works and returns a token
- a valid session cookie from before the switch is ignored on `/api/users` (401)
- `/api/session` reports `staffWeb: false`
- with the switch on (default), all 92 existing tests still pass unchanged

## Phase 3: `/download` and the update check

Files:
- `public/download.html`, in the passenger look (`slip-base.css`): logo, "Dankie Driver for
  drivers and marshals", one Download button, version, date, size, SHA-256, install steps, and
  "Passengers don't need this app" linking to `/`.
- `public/download/version.json`, edited by hand at each release:
  `{ "versionCode": 1, "versionName": "1.0", "apkUrl": "https://github.com/bandasihle/BTA-TAXIS/releases/download/v1.0/dankie-driver-1.0.apk", "sha256": "...", "sizeBytes": 0, "releasedAt": "2026-11-28" }`
- `public/js/download.js` fills the page from `version.json` (no inline script: the CSP allows
  only one hashed inline script).

Server:
- Add `/download` and `/privacy` to `PAGES`.
- `GET /download/dankie-driver.apk` answers 302 to `apkUrl`. Only redirect when the URL starts
  with `https://github.com/bandasihle/`, so the file can never become an open redirect.
- Allow the app's origins (`APP_ORIGINS`) to read `/download/version.json` cross-origin.

Install steps on the page (plain words): tap Download; open the file when it finishes; if Android
asks, allow your browser to install apps; tap Install. Say that Android warns about apps from
outside the Play Store and that this is expected until the Play launch. **Only the
release-signed APK is ever published**, never the debug build.

Update check (sideload build only):
- Add Gradle product flavours `sideload` and `play` in `android/app/build.gradle`, same app id,
  same signing config. No `REQUEST_INSTALL_PACKAGES` permission in either.
- `server/build-app.js` writes `www/js/build-info.js` with the `versionCode` read from
  `build.gradle` and `updateCheck: false`. The `sideload` flavour overrides that one file from
  `android/app/src/sideload/assets/public/js/build-info.js` with `updateCheck: true`.
  This avoids adding a new Capacitor plugin.
- When `updateCheck` is true, the app fetches `version.json` once per start. If the site's
  `versionCode` is higher, show a dismissible line: "A new version is ready. Update", linking to
  `https://DOMAIN/download` (an external link, so it opens in the phone's browser; confirm this
  on a real device).
- `build-app.js` should leave `download.html` and `privacy.html` out of `www/`.

## Phase 4: `/privacy`

`public/privacy.html`, one plain page:
- Passengers: no account, no tracking, no cookies.
- Drivers: location is sent only during a trip, only after agreeing to the notice in the app,
  and stops when they switch it off. Match the wording of `public/js/consent.js`.
- Staff accounts: name, cellphone number, a scrambled PIN, sign-in times.
- Who is responsible (the Benoni Taxi Association), a contact, and how to ask for data to be
  corrected or removed (POPIA). **The owner must supply the contact name, phone or email.**
- Link it from the passenger footer, the download page and the app's Menu.

## Phase 5: passenger install and sharing

- Android Chrome: catch `beforeinstallprompt` in `public/js/danki.js`; after the passenger has
  opened a rank page, show a small "Add Dankie Driver to your home screen" bar. Remember a
  dismissal in `localStorage` and never show it again.
- iPhone Safari (no prompt exists): the same bar says "Tap Share, then Add to Home Screen".
- Never show the bar inside the app or when already installed
  (`matchMedia('(display-mode: standalone)')`).
- Check `manifest.webmanifest`: name, `start_url: "/"`, icons. Check the installed site opens on
  the passenger map and shows the last fares with no signal (`sw.js` plus the saved directory).
- Add Open Graph tags (title, description, logo image) to `index.html` so WhatsApp shows a
  proper preview. Add `robots.txt` allowing the passenger pages.
- In `securityHeaders`, add `Strict-Transport-Security` on HTTPS requests if it's not there.

## Phase 6: point the app at the domain

- `public/js/common.js` (`API_BASE`): change `https://bta-taxis.onrender.com` to
  `https://DOMAIN`. `server/build-app.js` now reads the app's CSP address from that line.
- `public/index.html`: change `og:url` and `og:image` to the domain (link previews need full
  addresses).
- The Render service keeps answering on `onrender.com`, so already-installed test builds keep
  working.
- Bump `versionCode` and `versionName`, then build:
  `npm run app:build`, then in `android/`:
  `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleSideloadRelease`.

## Go-live checklist

Owner, first:
1. Register the domain.
2. Render: upgrade to Starter, add a disk, set `DB_FILE` to a path on the disk.
3. Create the release keystore (steps in `README.md`) and `android/keystore.properties`. Back
   the keystore up in two places. Losing it means no more updates to the app.
4. Supply the privacy contact details.

Then together:
1. Push `main`. Render deploys with `WEB_STAFF=admin`.
2. In Render, add the custom domain and create the DNS records it shows. Wait for HTTPS.
3. Create the real admin, then delete the `BOOTSTRAP_ADMIN_*` variables in Render.
4. Build the signed sideload APK. Create GitHub Release `v1.0` with the file. Put its URL,
   SHA-256 and size in `version.json`, commit, push.
5. On a real phone: open the site, install it to the home screen, download and install the APK,
   sign in as admin, marshal and driver, share location on a trip, see the dot on the dashboard.
6. From a PC browser: sign in as the admin and open the dashboard. Confirm `/driver.html` is
   "Page not found" and that a marshal's PIN is refused with "sign in on the Dankie Driver app".

## The public repository

Checked on 2026-11-11: no secrets are tracked. `android/.gitignore` covers
`keystore.properties`, `*.jks` and `*.keystore`; no database, `.env` or PIN file is in git.
Keep it that way: never commit the keystore, its passwords, or real phone numbers.

**If the repo goes private later:** release downloads would then need a login. Create a small
public repo that holds only the APK releases, and change `apkUrl` (and the allowed prefix in the
redirect) to point there. Nothing else changes.

## Not in this plan

- Google Play submission (the `play` flavour is prepared here; the listing is later).
- Exact spots and fares for the other 7 ranks (waiting on the association).
- A logo without the Toyota emblem (needed before Play, not before the testers' build).

## The office dashboard on a computer (decided)

The owner wants it, so the live site runs `WEB_STAFF=admin`: the admin signs in on the website
from any computer with the same phone and PIN. What protects it: one answer for every sign-in
failure, 20 tries per device per 15 minutes, locks of 15 min / 1 h / 4 h, HttpOnly SameSite
cookies, and the staff sign-in folded behind a link on the welcome screen. Drivers and marshals
still cannot sign in on the website, and the driver screen is not served there.

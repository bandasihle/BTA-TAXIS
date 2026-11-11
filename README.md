# BTA Rank Tracker (prototype)

**Live: https://bta-taxis.onrender.com**

It runs on Render's free plan: after about 15 minutes without visitors it sleeps, so the first load can take up to a minute. The free plan has no lasting disk, so anything recorded is lost when it restarts; real use needs a paid plan with a disk (`DB_FILE` on the disk).

| Screen | Link |
|---|---|
| Dankie Driver, the passenger app | https://bta-taxis.onrender.com |
| Staff home | https://bta-taxis.onrender.com/staff |
| Office dashboard (live map) | https://bta-taxis.onrender.com/dashboard |
| Marshal screen (try it on a phone) | https://bta-taxis.onrender.com/marshal |
| Rank screen for passengers | https://bta-taxis.onrender.com/board |
| Ranks and routes editor | https://bta-taxis.onrender.com/editor |

Two parts for the Benoni Taxi Association:

- **Dankie Driver** (passenger app, `/`). Pick a province, then a region, then a rank, on the map or in the list, and see each destination with the hours taxis run and the price. Built from the association's brief in `docs/danki-driver-app.pdf`. On a rank's screen it also shows, live: whether each destination is running now ("Last taxi in 40 min", "Closed, opens 04:00", in South African time), the taxi loading for it (seats filled, no queue numbers), taxis driving to and from the rank on the map (once drivers' phones send GPS), and a trip preview with a rough travel time. Loading taxis come from what marshals record.
- **Rank tracker** (staff, `/staff`). Tracks which taxi is where: rank queues, loading, departures and taxis on the road between Etwatwa, Daveyton, Benoni and nearby ranks.

**Dankie Driver data.** All nine provinces are listed. Only Gauteng > Benoni Ekurhuleni has ranks so far. Ranks, destinations, times and prices live in the database and admins change them on the **Fares** page (`/fares`); passengers' phones update straight away and keep the last copy for when there is no signal. A route without a fare is not shown to passengers. A rank is listed for passengers when it has a region (set in Ranks and routes); without one it is a destination only. Every fare change is logged with who made it and the old and new values. The first run loads the association's list from `public/js/fares.js`: Etwatwa Las Vegas with its fares, and the other ranks (Barcelona, Cloverdene, Lakeside, Dunswart, Northmead Square, East Rand Mall, SuperSpar) with none yet.

**Places.** The passenger app, the dashboard and the rank editor all use the same places from `public/js/fares.js`, so they are already on the map. Etwatwa Las Vegas is at the spot the association gave. The others were found with OpenStreetMap place search and sit on the right area, not the exact rank ("Danstreet" in the brief is Dunswart, "Jimeston" is Germiston). Barcelona is only placed inside Etwatwa.

**No demo data.** The tracker starts with the ranks and the routes on the Dankie Driver fare lists, and no taxis, drivers or marshals. Taxis are registered by marshals.

## Run it

Needs Node 22.13 or newer (it uses Node's built-in SQLite, so there are no native builds).

```sh
npm install
npm start          # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm start` | Runs the app on port 3000 (`PORT=4000 npm start` to change). |
| `npm run dev` | Same, restarting when server files change. |
| `npm run create-admin -- --name "Full Name" --phone 0821234567` | Creates an admin and prints a temporary PIN once. They choose their own PIN when they first sign in. |
| `npm run seed` | Loads the association's ranks and routes into an empty database. It refuses to run on a database that has data, so it can never wipe real records. |
| `npm run roads` | Fetches the road for any fare-list route not yet saved in `server/roads.json` (`-- --all` fetches them all again). |
| `npm test` | State machine, end-to-end store and Dankie Driver data tests. |

## Android app

The same pages run as an Android app through [Capacitor](https://capacitorjs.com) (`android/`, app id `za.co.bta.dankidriver`). The pages are bundled in the app; the API and live updates come from https://bta-taxis.onrender.com (set in `public/js/common.js`), and the server allows requests from the app's origin.

Needs Android Studio (for the Android SDK and its bundled Java 21).

```sh
npm run app:build  # copies public/ and Leaflet into www/ and syncs them into android/
npm run app:open   # opens the project in Android Studio; press Run for a phone or emulator
```

Run `npm run app:build` again after changing anything in `public/`. Server changes need a deploy to Render before the app sees them. In the app each page carries the same Content-Security-Policy as the website, as a `<meta>` tag added by the build. App data is kept out of Android backups and phone-to-phone transfers, so the sign-in token stays on the phone.

**Release build (for Play or for handing out).** Debug builds can be inspected over USB and are signed with Android's shared test key, so never hand one out. Release builds need your own signing key. Create it once and keep it out of git:

```sh
cd android
keytool -genkeypair -v -keystore danki-release.jks -alias danki -keyalg RSA -keysize 4096 -validity 10000
```

Then create `android/keystore.properties` (it's in `.gitignore`):

```
storeFile=danki-release.jks
storePassword=<the password you chose>
keyAlias=danki
keyPassword=<the password you chose>
```

There are two builds of the same app (same id, same key):
- **sideload**, downloaded from the website's `/download` page. It checks `/api/app-version` once per start and offers the download page when a newer version is out. Build it with `./gradlew assembleSideloadRelease` (an `.apk`).
- **play**, for the Play Store, which handles updates itself. Build it with `./gradlew bundlePlayRelease` (an `.aab`).

To publish a sideload release: raise `versionCode` and `versionName` in `android/app/build.gradle`, build, upload the `.apk` to a GitHub Release, then put its address, SHA-256, size and date in `public/download/version.json` and deploy. The site only links to files under `https://github.com/bandasihle/BTA-TAXIS/releases/download/`. Back up the `.jks` and its password in two safe places. Without them you can never update the app, and anyone who has them can sign a fake update.

Settings (environment variables): `PORT` (default 3000), `DB_FILE` (default `data/taxi.db`), `TRUST_PROXY_HOPS` (default 0; set 1 behind Render's proxy so the sign-in limit sees the real client address), and `BOOTSTRAP_ADMIN_PHONE` + `BOOTSTRAP_ADMIN_PIN` (+ optional `BOOTSTRAP_ADMIN_NAME`) to create the first admin on a host with no shell. Only used while there are no accounts; set them as secrets.

## Staff sign-in and security

Passengers need no account. Staff sign in at `/login` with their cellphone number and a 6-digit PIN.

- **Roles.** Admins can do everything, including managing staff at `/users`. Marshals record taxis at their own rank only. Drivers share their own taxi's position from `/driver` (see below). Every request is checked on the server; hidden links are only a convenience.
- **Accounts.** Only an admin can add people. A new or reset PIN is shown to the admin once, and the person must choose their own at first sign-in. Weak PINs (`111111`, `123456`) are refused.
- **PINs** are stored as scrypt hashes with a salt per person. 5 wrong PINs lock an account for 15 minutes, and each device gets 20 tries per 15 minutes. A wrong phone number and a wrong PIN get the same answer, so nobody can find out who has an account.
- **Sessions** last 7 days. Only a hash of the session token is stored. The website keeps it in an HttpOnly, SameSite=Strict cookie and refuses changes that come from other sites; the Android app sends it as a Bearer token and gets a one-time, 30-second ticket for the live stream. Switching an account off, changing its role or resetting its PIN signs it out on every phone.
- **Location plugin.** `@capacitor-community/background-geolocation` 1.3.1 is pinned exactly and was read before adding: no network, storage or tracking of its own. Its service is overridden to `exported="false"` in our manifest, so other apps cannot stop a driver's sharing.
- **Audit.** "Who did it" in the trip log comes from the session, never from what the phone sends.
- **Public data.** Passengers see ranks, routes, plates and seats. Driver, owner and marshal names and the trip log go only to signed-in staff.
- **Headers.** Every response has a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, and a referrer policy that sends other sites only our site name (OpenStreetMap needs it for map tiles), never the page path.

## Screens

| Path | For |
|---|---|
| `/` | Dankie Driver: a map and list of province, region, rank, then destination, time and price, with the routes drawn on the map. Links like `/#/gauteng/benoni-ekurhuleni/etwatwa-las-vegas` open a rank directly. |
| `/login` | The welcome screen the app opens on: a loading screen while the server wakes, then "Continue as a passenger" (no account) or staff sign in, and choosing your own PIN. Every screen has a Menu in the header listing what the signed-in role can open. |
| `/staff` | Staff home. |
| `/driver` | Drivers: read and accept the location notice, then start and stop sharing their taxi's position. |
| `/users` | Admins: add staff, change roles and ranks, link drivers to their taxi, switch accounts off, make new PINs. |
| `/fares` | Admins: each rank's destinations, hours and prices for passengers, and the log of changes. |
| `/marshal?rank=<id>` | Phone screen for the rank marshal: check taxis in, add passengers, depart, reorder, mark arrivals. Taps made with no signal are saved on the phone and sent later. |
| `/dashboard` | Association office: live map, queue per rank, trip log, taxi search and history. |
| `/board?rank=<id>` | Big-text rank screen for passengers. |
| `/editor` | Add or move ranks (tap the map, drag pins), add or delete routes. |

## How tracking works

1. **Rank events (real).** A marshal moves each taxi through `OFF_DUTY → QUEUED → LOADING → EN_ROUTE → ARRIVED`. The rules are in `server/state.js`; illegal moves (such as departing before check-in) are rejected with a message the marshal can act on.
2. **Positions.** `server/positions.js` (`PositionSource`): a taxi at a rank is shown at that rank. A taxi on a trip is shown where its driver's phone last said, if the driver is sharing; otherwise screens list it with an expected arrival (an average 40 km/h plus stops). A shared position within 150 m of the destination rank, accurate to 100 m, records the arrival by itself (logged as `GPS (driver name)`); otherwise the marshal there records it.

## Driver GPS and privacy (POPIA)

Location is personal information, so the rules are strict and enforced on the server:

- **Consent first.** A driver sees a plain-language notice (`public/js/consent.js`: who, what, why, who sees it, how long, their rights) and must agree before anything is accepted. The notice has a version; if it changes, every driver must agree again. Drivers can withdraw at any time from `/driver`, which deletes their taxi's point immediately.
- **Driver starts it.** Nothing is sent until the driver presses Start. In the Android app sharing carries on with the phone locked (a foreground service from `@capacitor-community/background-geolocation`), and Android shows a notification the whole time; on the website it runs only while the page is open. The app asks for location permission when Start is pressed, not at install. Pressing Stop deletes the taxi's point straight away.
- **Only the latest point.** One row per taxi, no history. It is deleted when the driver presses Stop, when the taxi arrives or goes off duty, when consent is withdrawn or the driver is unlinked, and after 10 minutes without an update.
- **Only on a trip.** Points sent while the taxi waits at a rank or is off duty are not kept.
- **Not trusted.** A point must come from the signed-in driver linked to that taxi (a taxi id in the request is ignored), lie inside South Africa, not be marked by Android as coming from a fake-location app, be under 2 minutes old by the server's clock, not imply more than 180 km/h since the last one, and arrive at most once every 3 seconds.
- **What passengers see.** Only for taxis on a trip, and only while the point is under 2 minutes old: a dot rounded to about 10 m with the plate and expected arrival. Never the driver's name, the accuracy or the time.

Admins link a driver to a taxi on `/users`.

### Look

Dankie Driver (`/`), the welcome screen and the driver screen share `public/css/slip-base.css`. Colours come from the Dankie Driver badge (`docs/dankie-driver-logo.jpeg`): royal blue, navy and the red and white of the taxi livery. Answers are printed slips with figures in Spline Sans Mono under a frosted blue header with a red and white livery stripe that takes the page title once the big title scrolls under it. Tapping a destination prints its slip: fare, hours, what is running now and the taxi loading at the rank, with the trip preview. The font is bundled in `public/fonts/` (SIL Open Font License, see the licence file there), so these pages load no third-party fonts. The staff screens keep `app.css`.

## Layout

```
server/
  server.js   HTTP server, JSON API, live updates (Server-Sent Events), static files
  store.js    every read and write; emits 'change'
  state.js    taxi state machine (pure)
  positions.js  where taxis are (at ranks now; driver GPS later)
  seed.js     loads ranks and routes from public/js/fares.js into an empty database
  build-app.js  copies the pages into www/ for the Android app
  geo.js      distance and route-line helpers
  roads.js    road routes: the saved ones in roads.json, and fetching new ones from OSRM
  fetch-roads.js  `npm run roads`
  auth.js     staff accounts, PINs, sessions, stream tickets
  create-admin.js  `npm run create-admin`
  db.js       SQLite schema
public/       Dankie Driver and the five staff screens (vanilla JS modules, Leaflet map), PWA manifest + service worker
  js/fares.js provinces and regions, the association's starting ranks and fares, buildDirectory() for the passenger app
docs/         the association's Dankie Driver brief and the original BTA logo
test/         node:test suites
```

### Why a plain Node server?

This prototype uses a plain Node server, Node's built-in SQLite and vanilla JS rather than a framework: one dependency (Leaflet), nothing to compile, no native modules to build on Windows, and small pages that suit cheap phones on mobile data. The API is small, so it can be moved behind a framework later.

## API

Public: `GET /api/snapshot`, `GET /api/stream` (SSE; `?pos=1` adds positions every second). Staff (signed in): `GET /api/stream?staff=1` (cookie, or `&ticket=` from `POST /api/stream-ticket`) for the full view; `POST /api/action` with `{type, taxiId, ...}` where type is `checkIn` (`rankId`, `routeId`), `seat` (`delta` ±1), `depart`, `arrive`, `remove`, `offDuty` or `move` (`dir` up or down). Also `POST /api/taxis`, `GET /api/taxis/:id/history`. Admins: `POST/PUT/DELETE /api/ranks`, `POST/DELETE /api/routes`, `PUT/DELETE /api/routes/:id/fare {from, until, price}`, `GET/POST /api/users`, `PUT /api/users/:id`, `POST /api/users/:id/pin`. Drivers: `GET /api/driver`, `POST /api/driver/consent {version}`, `DELETE /api/driver/consent`, `POST /api/driver/position {lat, lng, accuracy, at, simulated?}`, `DELETE /api/driver/position` (Stop). Public: `GET /api/positions`. Anyone: `POST /api/login {phone, pin, client?}`, `POST /api/logout`, `GET /api/me`, `POST /api/me/pin {oldPin, newPin}`.

## Known gaps

- Locking an account after wrong PINs means someone who knows a marshal's number can lock them out for 15 minutes at a time. An admin can see the lock on `/users`.
- On the website, sharing stops when the driver leaves the page or the phone locks; drivers should use the Android app.
- Some phone makers (Xiaomi, Huawei, Oppo, Samsung on battery saver) kill background apps despite the notification. Drivers may need to set Dankie Driver to "No restrictions" under battery settings.
- The fake-location check trusts the app; a modified app could hide it. The speed and time checks still apply.
- Rank pins other than Etwatwa Las Vegas sit on the right area, not the exact rank.
- Map tiles come from openstreetmap.org and need a connection.
- Routes follow the fastest road for a car, from the free OSRM route planner (router.project-osrm.org), which is not always the road taxis take. The fare-list routes are saved in `server/roads.json`; a route added or moved in the editor fetches its road when it is saved and keeps a stand-in line if the planner cannot be reached.

Map data © OpenStreetMap contributors, ODbL.

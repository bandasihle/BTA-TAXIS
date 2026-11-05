# BTA Rank Tracker (prototype)

**Live: https://bta-taxis.onrender.com**

It runs on Render's free plan: after about 15 minutes without visitors it sleeps, so the first load can take up to a minute. The free plan has no lasting disk, so anything recorded is lost when it restarts; real use needs a paid plan with a disk (`DB_FILE` on the disk).

| Screen | Link |
|---|---|
| Danki Driver, the passenger app | https://bta-taxis.onrender.com |
| Staff home | https://bta-taxis.onrender.com/staff |
| Office dashboard (live map) | https://bta-taxis.onrender.com/dashboard |
| Marshal screen (try it on a phone) | https://bta-taxis.onrender.com/marshal |
| Rank screen for passengers | https://bta-taxis.onrender.com/board |
| Ranks and routes editor | https://bta-taxis.onrender.com/editor |

Two parts for the Benoni Taxi Association:

- **Danki Driver** (passenger app, `/`). Pick a province, then a region, then a rank, on the map or in the list, and see each destination with the hours taxis run and the price. Built from the association's brief in `docs/danki-driver-app.pdf`. On a rank's screen it also shows, live: whether each destination is running now ("Last taxi in 40 min", "Closed, opens 04:00", in South African time), the taxi loading for it (seats filled, no queue numbers), taxis driving to and from the rank on the map (once drivers' phones send GPS), and a trip preview with a rough travel time. Loading taxis come from what marshals record.
- **Rank tracker** (staff, `/staff`). Tracks which taxi is where: rank queues, loading, departures and taxis on the road between Etwatwa, Daveyton, Benoni and nearby ranks.

**Danki Driver data.** All nine provinces are listed. Only Gauteng > Benoni Ekurhuleni has ranks so far. The Etwatwa Las Vegas destinations, times and prices come from the association. The other ranks (Barcelona, Cloverdene, Lakeside, Dunswart, Northmead Square, East Rand Mall, SuperSpar) are listed with no fares until the association sends them. Fares are in `public/js/fares.js`.

**Places.** The passenger app, the dashboard and the rank editor all use the same places from `public/js/fares.js`, so they are already on the map. Etwatwa Las Vegas is at the spot the association gave. The others were found with OpenStreetMap place search and sit on the right area, not the exact rank ("Danstreet" in the brief is Dunswart, "Jimeston" is Germiston). Barcelona is only placed inside Etwatwa.

**No demo data.** The tracker starts with the ranks and the routes on the Danki Driver fare lists, and no taxis, drivers or marshals. Taxis are registered by marshals.

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
| `npm run seed` | Loads the association's ranks and routes into an empty database. It refuses to run on a database that has data, so it can never wipe real records. |
| `npm run roads` | Fetches the road for any fare-list route not yet saved in `server/roads.json` (`-- --all` fetches them all again). |
| `npm test` | State machine, end-to-end store and Danki Driver data tests. |

## Android app

The same pages run as an Android app through [Capacitor](https://capacitorjs.com) (`android/`, app id `za.co.bta.dankidriver`). The pages are bundled in the app; the API and live updates come from https://bta-taxis.onrender.com (set in `public/js/common.js`), and the server allows requests from the app's origin.

Needs Android Studio (for the Android SDK and its bundled Java 21).

```sh
npm run app:build  # copies public/ and Leaflet into www/ and syncs them into android/
npm run app:open   # opens the project in Android Studio; press Run for a phone or emulator
```

Run `npm run app:build` again after changing anything in `public/`. Server changes need a deploy to Render before the app sees them.

Settings (environment variables): `PORT` (default 3000), `DB_FILE` (default `data/taxi.db`).

## Screens

| Path | For |
|---|---|
| `/` | Danki Driver: a map and list of province, region, rank, then destination, time and price, with the routes drawn on the map. Links like `/#/gauteng/benoni-ekurhuleni/etwatwa-las-vegas` open a rank directly. |
| `/staff` | Pick a staff role. |
| `/marshal?rank=<id>` | Phone screen for the rank marshal: check taxis in, add passengers, depart, reorder, mark arrivals. Taps made with no signal are saved on the phone and sent later. |
| `/dashboard` | Association office: live map, queue per rank, trip log, taxi search and history. |
| `/board?rank=<id>` | Big-text rank screen for passengers. |
| `/editor` | Add or move ranks (tap the map, drag pins), add or delete routes. |

## How tracking works

1. **Rank events (real).** A marshal moves each taxi through `OFF_DUTY → QUEUED → LOADING → EN_ROUTE → ARRIVED`. The rules are in `server/state.js`; illegal moves (such as departing before check-in) are rejected with a message the marshal can act on.
2. **Positions.** `server/positions.js` has a `RankPositionSource`: a taxi at a rank is shown at that rank. Taxis on the road have no map position yet; screens list them with an expected arrival (an average 40 km/h plus stops), and the marshal at the destination records the arrival. Driver GPS will be a source with the same `getPositions` method; no screen needs to change.

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
  db.js       SQLite schema
public/       Danki Driver and the five staff screens (vanilla JS modules, Leaflet map), PWA manifest + service worker
  js/fares.js Danki Driver provinces, regions, ranks, destinations, times and prices
docs/         the association's Danki Driver brief and the original BTA logo
test/         node:test suites
```

### Why a plain Node server?

This prototype uses a plain Node server, Node's built-in SQLite and vanilla JS rather than a framework: one dependency (Leaflet), nothing to compile, no native modules to build on Windows, and small pages that suit cheap phones on mobile data. The API is small, so it can be moved behind a framework later.

## API

`GET /api/snapshot` (public view), `GET /api/stream` (SSE; `?pos=1` adds positions every second; `?staff=1` sends the full staff view), `POST /api/action` with `{type, taxiId, ...}` where type is `checkIn` (`rankId`, `routeId`), `seat` (`delta` ±1), `depart`, `arrive`, `remove`, `offDuty` or `move` (`dir` up or down). Also `POST /api/taxis`, `GET /api/taxis/:id/history`, `POST/PUT/DELETE /api/ranks`, `POST/DELETE /api/routes`.

## Known gaps

- No login: anyone with the link can act as any marshal.
- Rank pins other than Etwatwa Las Vegas sit on the right area, not the exact rank.
- Map tiles come from openstreetmap.org and need a connection.
- Routes follow the fastest road for a car, from the free OSRM route planner (router.project-osrm.org), which is not always the road taxis take. The fare-list routes are saved in `server/roads.json`; a route added or moved in the editor fetches its road when it is saved and keeps a stand-in line if the planner cannot be reached.

Map data © OpenStreetMap contributors, ODbL.

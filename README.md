# BTA Rank Tracker (prototype)

**Live demo: https://bta-taxis.onrender.com**

The demo runs on Render's free plan: after about 15 minutes without visitors it sleeps, so the first load can take up to a minute. It resets to the demo data whenever it restarts.

| Screen | Link |
|---|---|
| Danki Driver, the passenger app | https://bta-taxis.onrender.com |
| Staff home | https://bta-taxis.onrender.com/staff |
| Office dashboard (live map) | https://bta-taxis.onrender.com/dashboard |
| Marshal screen (try it on a phone) | https://bta-taxis.onrender.com/marshal |
| Rank screen for passengers | https://bta-taxis.onrender.com/board |
| Ranks and routes editor | https://bta-taxis.onrender.com/editor |

Two parts for the Benoni Taxi Association:

- **Danki Driver** (passenger app, `/`). Pick a province, then a region, then a rank, on the map or in the list, and see each destination with the hours taxis run and the price. Built from the association's brief in `docs/danki-driver-app.pdf`. On a rank's screen it also shows, live: whether each destination is running now ("Last taxi in 40 min", "Closed, opens 04:00", in South African time), the taxi loading for it (seats filled, no queue numbers), taxis driving to and from the rank on the map, and a trip preview with a rough travel time. Loading and moving taxis come from the tracker's simulation.
- **Rank tracker** (staff, `/staff`). Tracks which taxi is where: rank queues, loading, departures and taxis on the road between Etwatwa, Daveyton, Benoni and nearby ranks.

**Danki Driver data.** All nine provinces are listed. Only Gauteng > Benoni Ekurhuleni has ranks so far. The Etwatwa Las Vegas destinations, times and prices come from the association. The other ranks (Barcelona, Cloverdene, Lakeside, Danstreet, Northmead Square, East Rand Mall, SuperSpar) have sample destinations and prices, and the app says so on their screens. Edit `public/js/fares.js` to confirm or change them.

**Places.** The passenger app, the dashboard and the rank editor all use the same places from `public/js/fares.js`, so they are already on the map. Etwatwa Las Vegas is at the spot the association gave. The others were found with OpenStreetMap place search and sit on the right area, not the exact rank ("Danstreet" in the brief is Dunswart, "Jimeston" is Germiston). Barcelona is only placed inside Etwatwa.

**The rank tracker's taxis are demo data.** Taxis, drivers and marshals are made up, and its routes are the Danki Driver fare lists.

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
| `npm run seed` | Wipes the database and reloads demo data. |
| `npm run roads` | Fetches the road for any demo route not yet saved in `server/roads.json` (`-- --all` fetches them all again). |
| `npm test` | State machine, end-to-end store and Danki Driver data tests. |

Settings (environment variables): `PORT` (default 3000), `DEMO=0` to start with demo mode off, `SIM_SCALE` (default 20: simulated taxis drive 20x faster than real time), `DB_FILE` (default `data/taxi.db`).

## Screens

| Path | For |
|---|---|
| `/` | Danki Driver: a map and list of province, region, rank, then destination, time and price, with the routes drawn on the map. Links like `/#/gauteng/benoni-ekurhuleni/etwatwa-las-vegas` open a rank directly. |
| `/staff` | Pick a staff role. |
| `/marshal?rank=<id>` | Phone screen for the rank marshal: check taxis in, add passengers, depart, reorder, mark arrivals. Taps made with no signal are saved on the phone and sent later. |
| `/dashboard` | Association office: live map, queue per rank, trip log, taxi search and history. |
| `/board?rank=<id>` | Big-text rank screen for passengers. |
| `/editor` | Add or move ranks (tap the map, drag pins), add or delete routes. |

**Demo mode** (toggle in the top bar) has simulated marshals loading and sending off taxis so the dashboard moves on its own. Turn it off to drive everything yourself from the marshal screen.

## How tracking works

1. **Rank events (real).** A marshal moves each taxi through `OFF_DUTY → QUEUED → LOADING → EN_ROUTE → ARRIVED`. The rules are in `server/state.js`; illegal moves (such as departing before check-in) are rejected with a message the marshal can act on.
2. **Positions (simulated).** `server/sim.js` has a `SimulatedPositionSource` that works out where each taxi is from its trip timing along the route line, and marks it arrived when it gets there. To use real GPS later, write a source with the same two methods (`getPositions`, `dueArrivals`) that reads drivers' phone pings and geofences the ranks; no screen needs to change.

## Layout

```
server/
  server.js   HTTP server, JSON API, live updates (Server-Sent Events), static files
  store.js    every read and write; emits 'change'
  state.js    taxi state machine (pure)
  sim.js      position source + simulator + demo mode
  seed.js     demo taxis; ranks and routes come from public/js/fares.js
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

`GET /api/snapshot`, `GET /api/stream` (SSE; `?pos=1` adds positions every second), `POST /api/action` with `{type, taxiId, ...}` where type is `checkIn` (`rankId`, `routeId`), `seat` (`delta` ±1), `depart`, `arrive`, `remove`, `offDuty` or `move` (`dir` up or down). Also `POST /api/taxis`, `GET /api/taxis/:id/history`, `POST/PUT/DELETE /api/ranks`, `POST/DELETE /api/routes`, `POST /api/demo {on}`, `POST /api/reset`.

## Known gaps

- No login: anyone with the link can act as any marshal.
- Rank pins other than Etwatwa Las Vegas sit on the right area, not the exact rank.
- Map tiles come from openstreetmap.org and need a connection.
- Routes follow the fastest road for a car, from the free OSRM route planner (router.project-osrm.org), which is not always the road taxis take. The demo routes are saved in `server/roads.json`; a route added or moved in the editor fetches its road when it is saved and keeps a stand-in line if the planner cannot be reached.

Map data © OpenStreetMap contributors, ODbL.

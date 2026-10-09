# BTA Rank Tracker (prototype)

Tracks which taxi is where for the Benoni Taxi Association: rank queues, loading, departures and taxis on the road between Etwatwa, Daveyton, Benoni and nearby ranks.

**Everything in here is demo data.** Taxis, drivers, marshals and routes are made up. Rank positions come from OpenStreetMap; the Daveyton and Etwatwa pins are placeholders.

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
| `npm test` | State machine and end-to-end store tests. |

Settings (environment variables): `PORT` (default 3000), `DEMO=0` to start with demo mode off, `SIM_SCALE` (default 20: simulated taxis drive 20x faster than real time), `DB_FILE` (default `data/taxi.db`).

## Screens

| Path | For |
|---|---|
| `/` | Pick a role. |
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
  seed.js     ranks (from OpenStreetMap), routes, demo taxis
  geo.js      distance and route-line helpers
  db.js       SQLite schema
public/       the five screens (vanilla JS modules, Leaflet map), PWA manifest + service worker
test/         node:test suites
```

### Why a plain Node server?

This prototype uses a plain Node server, Node's built-in SQLite and vanilla JS rather than a framework: one dependency (Leaflet), nothing to compile, no native modules to build on Windows, and small pages that suit cheap phones on mobile data. The API is small, so it can be moved behind a framework later.

## API

`GET /api/snapshot`, `GET /api/stream` (SSE; `?pos=1` adds positions every second), `POST /api/action` with `{type, taxiId, ...}` where type is `checkIn` (`rankId`, `routeId`), `seat` (`delta` ±1), `depart`, `arrive`, `remove`, `offDuty` or `move` (`dir` up or down). Also `POST /api/taxis`, `GET /api/taxis/:id/history`, `POST/PUT/DELETE /api/ranks`, `POST/DELETE /api/routes`, `POST /api/demo {on}`, `POST /api/reset`.

## Known gaps

- No login: anyone with the link can act as any marshal.
- Rank names other than Benoni CBD, Daveyton and Etwatwa are taken from street names in OpenStreetMap and need confirming.
- Map tiles come from openstreetmap.org and need a connection.

Map data © OpenStreetMap contributors, ODbL.

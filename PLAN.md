# Benoni Taxi Association: Rank & Trip Tracker (Prototype)

Area: Etwatwa, Daveyton, Benoni and surroundings (Ekurhuleni, Gauteng).

## 1. Goal
Show the Benoni Taxi Association which taxi is where and where it is going: rank queues, loading status, departures, and en-route movement on a map. This is a demo prototype for the association, not production.

## 2. Scope (v1)
**In:** marshal-driven tracking, simulated GPS, association dashboard, rank editor, seed data.
**Out:** real driver GPS, fares/revenue, payments, passenger accounts, login security beyond a simple role picker, native apps.

## 3. Core idea: two layers
1. **Rank events (real, manual).** A marshal at each rank moves taxis through states with big buttons. This matches how ranks work today.
2. **Live position (simulated).** A simulator moves en-route taxis along straight or road-ish lines between ranks so the map looks alive. Design the position feed behind one interface (`PositionSource`) so real driver-phone GPS can replace the simulator later without touching the UI.

### Taxi state machine
`ARRIVED -> QUEUED (route, queue position) -> LOADING (seats n/capacity) -> DEPARTED (destination rank) -> EN_ROUTE -> ARRIVED (at destination)`
Also: `OFF_DUTY`. Rules: a taxi can only be in one queue; queue order is first-come; marshal can reorder or remove; a taxi can depart before full (marshal confirms); on arrival at the destination it can queue for the return route.

## 4. Screens
1. **Role picker (home).** Marshal, Association Admin, Passenger Board. Marshal picks their rank. No real auth in v1.
2. **Marshal view (phone-first, large touch targets, readable in sunlight).**
   - Queue for this rank, grouped by route, in order.
   - "Check in taxi" (pick by plate or add new), "+1 seat" / "-1 seat", "Depart -> [destination]", "Remove", and "Move up/down".
   - Incoming list: taxis en route to this rank with a simulated ETA.
3. **Association dashboard (desktop-first).**
   - Map (Leaflet + OpenStreetMap) with ranks as markers, taxis as moving dots coloured by state.
   - Side panel: per-rank queue length, taxis per route, live trip log, filters (route, state, plate search).
   - Click a taxi: plate, driver, route, seats, trip history.
4. **Rank editor (admin).** Drop or drag a pin to add or move a rank, set its name, and draw or define routes between ranks. This exists because OSM is missing most Etwatwa and Daveyton ranks.
5. **Passenger board (optional, simple).** Per rank: "Next to Benoni: [plate] loading 11/15". Big text, auto-refreshing, usable on a screen at the rank.

## 5. Data model
- **Rank**: id, name, lat, lng, area, verified (bool), source
- **Route**: id, fromRankId, toRankId, name, (optional) polyline
- **Taxi**: id, plate, capacity (default 15), ownerName, driverId, status
- **Driver**: id, name, phone
- **Marshal**: id, name, rankId
- **QueueEntry**: id, taxiId, rankId, routeId, position, seats, status, enqueuedAt
- **Trip**: id, taxiId, routeId, departedAt, arrivedAt, seatsAtDeparture
- **Event log**: append-only (taxiId, type, rankId, at, by). The trip log and dashboard derive from this.

## 6. Seed data (real ranks from OpenStreetMap, verified June/July 2026 data)
Rank names below are inferred from street names where OSM has no name. Mark all `verified: false` except where noted, and let the association correct them in the rank editor.

| Rank (working name) | Lat | Lng | Note |
|---|---|---|---|
| Benoni CBD / Station Rank | -26.20930 | 28.28736 | Commissioner St; the job-listing source places Benoni Station Rank at Voortrekker St and Station Rd |
| Benoni Atlasville | -26.15929 | 28.28054 | Reier Rd |
| Benoni Kleinfontein | -26.18370 | 28.31863 | Voortrekker Rd |
| Modderbee | -26.18715 | 28.39734 | Isibusiso St; nearest mapped point to Daveyton/Etwatwa |
| Brakpan Station (Anzac) | -26.24046 | 28.36158 | Station Rd |
| Brakpan Karee St (ER011) | -26.25268 | 28.33381 | OSM name "Taxi Rank ER011" |
| Springs | -26.24900 | 28.43887 | 1st St / 1st East Ave; OSM has 3 nearby points, merge into one |
| Boksburg Railway St | -26.21864 | 28.24519 | |
| Jet Park | -26.16756 | 28.20563 | Jet Park Rd |
| Daveyton Main Rank | approx -26.1670 | 28.4110 | **Placeholder position.** Eiselen St per a job-listing site, unverified, so the admin must fix it |
| Etwatwa Rank(s) | approx -26.1500 | 28.4400 | **Placeholder.** No mapped data; the admin must place the real ones |

Seed routes (placeholders, all editable): Daveyton to Benoni, Etwatwa to Daveyton, Etwatwa to Benoni, Benoni to Brakpan, Brakpan to Springs, Daveyton to Springs, and the reverse of each.
Seed about 30 fake taxis (plates like `CA 123-456 GP`), 10 drivers and one marshal per rank. All fake data must be clearly labelled "demo data".

A one-off script may re-fetch ranks from OSM via the Overpass API (`amenity=taxi` inside bbox `-26.30,28.20,-26.05,28.50`). Note that the API needs a normal `User-Agent` header and a mirror such as `overpass.kumi.systems` worked when the main server returned 406. Attribute OpenStreetMap contributors (ODbL) in the UI footer.

## 7. Simulator
- Runs server-side on a timer. For each EN_ROUTE taxi, move it along its route line to the destination at a believable speed (about 30-60 km/h with a little jitter).
- On arrival, emit the same event the marshal would (`ARRIVED`) so the destination marshal sees it as incoming and can queue it.
- Optional "demo mode" button that auto-generates marshal activity (check-ins, loading, departures) so the dashboard moves without anyone pressing buttons.

## 8. Tech
- Web app, mobile-first PWA (installable, works on cheap phones, data-light).
- Suggested: Next.js (App Router) + TypeScript, SQLite via Drizzle or Prisma, Leaflet + OSM tiles, live updates via Server-Sent Events (simple, low data). Equivalents are fine if there is a strong reason.
- No paid APIs or keys. One command to install, seed and run (`npm run dev`).
- Offline tolerance for marshals: queue button taps locally and sync when data returns (nice to have; skip if it slows v1).

## 9. Design (important)
The UI must not look like a generic template. Design direction:
- Feels like a South African transport tool, not a generic SaaS dashboard: confident, high-contrast, and practical.
- Marshal view: huge buttons, high contrast, one-hand use, minimal text, works in bright sun, with clear state colours that never rely on colour alone.
- Taxi association colour cue: warm yellow/amber (the minibus taxi association) with dark neutral surfaces. The user can change this.
- Dashboard: a clear map with a legend, readable queue panels, no clutter.
- Support light and dark. Test at 360px width first, then desktop.
- Charts and the map legend use the same state colours and shapes as the rest of the UI.

## 10. Build order
1. Project scaffold, DB schema, seed script (ranks, routes, taxis, drivers, marshals).
2. State machine and event log with unit tests for the allowed transitions.
3. Marshal view wired to the real API.
4. Simulator and `PositionSource` interface; SSE stream.
5. Dashboard map and panels.
6. Rank editor.
7. Passenger board.
8. Demo mode, polish, README with run steps.

## 11. Acceptance checks
- A marshal can check a taxi in, fill seats, and depart it to another rank in under 10 seconds of tapping.
- The departed taxi appears on the dashboard map moving to the destination and shows as incoming at the destination marshal's screen.
- The state machine rejects illegal moves (e.g. depart before check-in).
- An admin can add a new rank from the map and it appears immediately in route and queue pickers.
- Works at 360px width with no horizontal scrolling.
- Everything demo is labelled as demo data.

## 12. Open questions for the association
- Real list of ranks and routes (names, positions) including all Etwatwa and Daveyton ranks.
- Do marshals exist at every rank, or do drivers sometimes check themselves in?
- Typical capacity (assumed 15) and whether taxis depart only when full.
- Does the association want fares or revenue tracking later?

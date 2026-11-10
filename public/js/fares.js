// Danki Driver directory: province > region > rank > destination, time and price.
//
// The provinces and regions below are fixed. The ranks and fares in them are the starting
// data from the association: server/seed.js loads them into an empty database, and from then
// on admins change ranks and fares in the app. The passenger app builds its directory from the
// server's data with buildDirectory(), not from this file.
//
// Times are 24-hour "HH:MM"; "24:00" means the last taxi leaves at midnight.
// Destinations, times and prices come from the association (docs/danki-driver-app.pdf).
// So far only Etwatwa Las Vegas has them; the other ranks are listed with no fares yet.
//
// Positions (`at`, [lat, lng]) come from OpenStreetMap place search, October 2026. They put
// each rank in the right place, not on the exact rank: `exact: false` marks those.

/** Places taxis go to. A place that is also a rank names it with `rank`. */
export const PLACES = {
  'Daveyton': { at: [-26.14249, 28.42581] },
  'East Rand Mall': { at: [-26.18196, 28.23962], rank: 'east-rand-mall' },
  'Etwatwa': { at: [-26.11931, 28.4799], rank: 'etwatwa-las-vegas' },
  'Farrarmere & Rynfield': { at: [-26.16472, 28.29388] },
  'Germiston': { at: [-26.22944, 28.18056] },
  'Springs': { at: [-26.249, 28.43887] },
};

const rank = (id, name, at, destinations, { exact = false } = {}) => ({ id, name, at, exact, destinations });
const to = (name, from, until, price) => {
  if (!PLACES[name]) throw new Error(`No position for ${name}`);
  return { name, from, until, price, at: PLACES[name].at };
};

export const PROVINCES = [
  {
    id: 'gauteng', code: 'GP', name: 'Gauteng', at: [-26.27, 28.11],
    regions: [
      {
        id: 'benoni-ekurhuleni', name: 'Benoni Ekurhuleni', at: [-26.17, 28.33],
        ranks: [
          rank('etwatwa-las-vegas', 'Etwatwa Las Vegas Taxi Rank', [-26.11931, 28.4799], [
            to('Germiston', '04:00', '24:00', 40),
            to('Springs', '04:00', '18:00', 40),
            to('Farrarmere & Rynfield', '04:00', '22:30', 30),
            to('East Rand Mall', '04:00', '24:00', 40),
            to('Daveyton', '04:00', '24:00', 20),
          ], { exact: true }),
          rank('barcelona', 'Barcelona Taxi Rank', [-26.106, 28.456], []),
          rank('cloverdene', 'Cloverdene Taxi Rank', [-26.15317, 28.3712], []),
          rank('lakeside', 'Lakeside Taxi Rank', [-26.18516, 28.31515], []),
          rank('dunswart', 'Dunswart Taxi Rank', [-26.20955, 28.28547], []),
          rank('northmead-square', 'Northmead Square Taxi Rank', [-26.16279, 28.32323], []),
          rank('east-rand-mall', 'East Rand Mall Taxi Rank', [-26.18196, 28.23962], []),
          rank('superspar', 'SuperSpar Taxi Rank', [-26.19219, 28.31839], []),
        ],
      },
      { id: 'johannesburg', name: 'Johannesburg', at: [-26.205, 28.04972], ranks: [] },
      { id: 'tshwane', name: 'Tshwane', at: [-25.74592, 28.18791], ranks: [] },
      { id: 'west-rand', name: 'West Rand', at: [-26.09555, 27.77556], ranks: [] },
      { id: 'sedibeng', name: 'Sedibeng', at: [-26.67472, 27.92611], ranks: [] },
    ],
  },
  { id: 'limpopo', code: 'LP', name: 'Limpopo', at: [-23.4, 29.42], regions: [] },
  { id: 'mpumalanga', code: 'MP', name: 'Mpumalanga', at: [-25.57, 30.53], regions: [] },
  { id: 'north-west', code: 'NW', name: 'North West', at: [-26.66, 25.28], regions: [] },
  { id: 'free-state', code: 'FS', name: 'Free State', at: [-28.45, 26.8], regions: [] },
  { id: 'kzn', code: 'KZN', name: 'KwaZulu-Natal', at: [-28.53, 30.9], regions: [] },
  { id: 'eastern-cape', code: 'EC', name: 'Eastern Cape', at: [-32.3, 26.42], regions: [] },
  { id: 'western-cape', code: 'WC', name: 'Western Cape', at: [-33.23, 21.86], regions: [] },
  { id: 'northern-cape', code: 'NC', name: 'Northern Cape', at: [-29.05, 21.86], regions: [] },
];

/** "04:00" stays as is; "24:00" reads as midnight. */
export function timeLabel(t) {
  return t === '24:00' || t === '00:00' ? 'midnight' : t;
}

/** Finds the province, region and rank for a path like ['gauteng', 'benoni-ekurhuleni', 'barcelona']. */
export function lookup([p, r, k] = [], provinces = PROVINCES) {
  const province = provinces.find((x) => x.id === p) ?? null;
  const region = province?.regions.find((x) => x.id === r) ?? null;
  const rankItem = region?.ranks.find((x) => x.id === k) ?? null;
  return { province, region, rank: rankItem };
}

/**
 * The passenger directory from the server's ranks, routes and fares: the fixed provinces and
 * regions, each region with the ranks in it, and each rank with its destinations (routes out
 * that have a fare). Same shape as PROVINCES, so the passenger app works the same way.
 *
 * rank:        { id (link slug), dbId, name, at, exact, destinations }
 * destination: { name, at, from, until, price, routeId, backRouteId, toPath (link to it as a rank, or null),
 *                next (a fare change the association has announced: { from, until, price, startsOn }, or null) }
 */
export function buildDirectory({ ranks = [], routes = [], fares = [], fareChanges = [] } = {}) {
  const fareByRoute = new Map(fares.map((f) => [f.routeId, f]));
  const nextByRoute = new Map(fareChanges.map(({ routeId, from, until, price, startsOn }) => [routeId, { from, until, price, startsOn }]));
  const rankById = new Map(ranks.map((r) => [r.id, r]));
  const regionPath = new Map(PROVINCES.flatMap((p) => p.regions.map((g) => [g.id, p.id])));
  const pathTo = (r) => (r.regionId && regionPath.has(r.regionId) ? [regionPath.get(r.regionId), r.regionId, r.slug] : null);

  const toRank = (r) => ({
    id: r.slug, dbId: r.id, name: r.name, at: [r.lat, r.lng], exact: !!r.verified,
    destinations: routes
      .filter((x) => x.fromRankId === r.id && fareByRoute.has(x.id) && rankById.has(x.toRankId))
      .map((x) => {
        const f = fareByRoute.get(x.id);
        const there = rankById.get(x.toRankId);
        const back = routes.find((y) => y.fromRankId === x.toRankId && y.toRankId === r.id);
        return { name: there.name, at: [there.lat, there.lng], from: f.from, until: f.until, price: f.price, routeId: x.id, backRouteId: back?.id ?? null, toPath: pathTo(there), next: nextByRoute.get(x.id) ?? null };
      }),
  });

  return PROVINCES.map((p) => ({
    ...p,
    regions: p.regions.map((g) => ({
      ...g,
      ranks: ranks.filter((r) => r.regionId === g.id).map(toRank)
        // ranks with fares first, then by name
        .sort((a, b) => (b.destinations.length > 0) - (a.destinations.length > 0) || a.name.localeCompare(b.name)),
    })),
  }));
}

/** "R40" or "R12.50". */
export function priceLabel(price) {
  return `R${Number.isInteger(price) ? price : price.toFixed(2)}`;
}

/** "1 Dec" for a start date like "2026-12-01". */
export function dayLabel(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Every rank, with the region and province it belongs to. */
export function allRanks() {
  return PROVINCES.flatMap((p) => p.regions.flatMap((r) => r.ranks.map((k) => ({ province: p, region: r, rank: k }))));
}

/** The name a place has in the rank tracker (server/seed.js uses the same rule). */
export function trackerName(placeOrRank) {
  const id = typeof placeOrRank === 'string' ? PLACES[placeOrRank]?.rank : placeOrRank.id;
  if (!id) return placeOrRank;
  const found = allRanks().find(({ rank: k }) => k.id === id);
  return found.rank.name.replace(/ Taxi Rank$/, '');
}

const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/**
 * Is this destination running at `nowMin` (minutes since midnight, South African time)?
 * Returns { open, text }: "Running", "Last taxi in 40 min" or "Closed, opens 04:00".
 */
export function runningNow(d, nowMin) {
  const from = minutes(d.from);
  const until = minutes(d.until);
  if (nowMin >= from && nowMin < until) {
    const left = until - nowMin;
    return { open: true, soon: left <= 60, text: left <= 60 ? `Last taxi in ${left} min` : 'Running now' };
  }
  return { open: false, text: `Closed, opens ${timeLabel(d.from)}` };
}

/** Minutes since midnight in South Africa, whatever the phone's time zone. */
export function saMinutes(date = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date).split(':').map(Number);
  return h * 60 + m;
}

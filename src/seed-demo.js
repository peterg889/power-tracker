// Generates a SYNTHETIC storm history so you can see the accuracy dashboard
// fully populated before real data has accumulated. It feeds fabricated poll
// snapshots through the exact same ingestSnapshot() path the live collector
// uses, so what you see is the real analysis running on made-up outages.
//
//   node src/seed-demo.js            -> writes data/demo.db
//   DB_PATH=data/demo.db npm start   -> view it
//
// NOTE: numbers here are invented to exercise the UI. They are NOT real
// utility performance. Delete data/demo.db and collect live data for that.

import { openDb, ingestSnapshot } from './db.js';

// Deterministic PRNG so runs are reproducible (no Math.random dependence).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260705);
const MIN = 60000;

const COUNTIES = ['MORRIS', 'MONMOUTH', 'MERCER', 'SUSSEX', 'HUNTERDON'];
const NAMES = [
  'RANDOLPH',
  'MARLBORO',
  'HOPEWELL',
  'CHESTER',
  'ROXBURY',
  'WASHINGTON',
  'FREEHOLD',
  'MADISON',
  'MENDHAM',
  'BOONTON',
  'DENVILLE',
  'ROCKAWAY',
  'JEFFERSON',
  'MONTVILLE',
  'PARSIPPANY',
  'HOWELL',
  'MIDDLETOWN',
  'WALL',
  'MANALAPAN',
  'ABERDEEN',
];

// Build a set of synthetic outages. Each has a start, a TRUE restoration time,
// and an ETR behavior: the utility's estimate carries a bias (they tend to be
// a bit optimistic during a storm) plus noise, and may be revised.
function buildOutages(t0) {
  const outages = [];
  for (let i = 0; i < 34; i++) {
    const county = COUNTIES[Math.floor(rnd() * COUNTIES.length)];
    const name = `${NAMES[i % NAMES.length]} TOWNSHIP`;
    const startOffset = Math.floor(rnd() * 6) * 60 * MIN; // storm rolls in over 6h
    const start = t0 + startOffset;
    const durationH = 2 + rnd() * 30; // 2h .. 32h to restore
    const trueRestore = start + durationH * 60 * MIN;

    // The utility's estimate: on average 20% optimistic (too early) with noise.
    const bias = -0.2 * durationH * 60 * MIN;
    const noise = (rnd() - 0.5) * 0.5 * durationH * 60 * MIN;
    const initialEtr = start + durationH * 60 * MIN + bias + noise;
    // Some outages get a revision partway through as reality sets in.
    const revises = rnd() < 0.5;
    const revisedEtr = trueRestore + (rnd() - 0.3) * 3 * 60 * MIN;
    const reviseAt = start + durationH * 0.5 * 60 * MIN;

    outages.push({
      areaId: `JC|${county}|NEW JERSEY|${name}|Township`,
      name,
      county,
      start,
      trueRestore,
      peak: 50 + Math.floor(rnd() * 4000),
      initialEtr: Math.round(initialEtr),
      revises,
      revisedEtr: Math.round(revisedEtr),
      reviseAt,
    });
  }
  return outages;
}

function main() {
  const dbPath = process.env.DB_PATH || new URL('../data/demo.db', import.meta.url).pathname;
  const db = openDb(dbPath);
  db.exec('DELETE FROM episodes; DELETE FROM polls;');

  const t0 = 1783000000000; // fixed base time
  const outages = buildOutages(t0);
  const horizon = t0 + 40 * 60 * MIN; // 40h
  const stepMs = 15 * MIN;

  let polls = 0;
  for (let t = t0; t <= horizon; t += stepMs) {
    const areas = [];
    for (const o of outages) {
      if (t < o.start || t >= o.trueRestore) continue;
      const etr = o.revises && t >= o.reviseAt ? o.revisedEtr : o.initialEtr;
      // customers decay as restoration approaches
      const frac = 1 - (t - o.start) / (o.trueRestore - o.start);
      const custA = Math.max(1, Math.round(o.peak * (0.3 + 0.7 * frac)));
      areas.push({
        areaId: o.areaId,
        name: o.name,
        county: o.county,
        state: 'NEW JERSEY',
        custA,
        custS: 20000,
        percentA: 1,
        nOut: Math.max(1, Math.round(custA / 40)),
        etr,
        etrRaw: new Date(etr).toISOString(),
        etrConfidence: null,
      });
    }
    ingestSnapshot(db, {
      fetchedAt: t,
      generatedAt: t,
      intervalId: 'demo',
      updatedAt: t,
      pageMode: areas.length > 15 ? 'STORM' : 'BLUESKY',
      totals: {
        custOut: areas.reduce((s, a) => s + a.custA, 0),
        custServed: 1158126,
        outages: areas.reduce((s, a) => s + a.nOut, 0),
        percentOut: 5,
      },
      areas,
    });
    polls++;
  }

  const resolved = db.prepare('SELECT COUNT(*) c FROM episodes WHERE resolved=1').get().c;
  console.log(
    `Seeded ${dbPath}: ${polls} polls, ${outages.length} outages, ${resolved} resolved.`
  );
  console.log(`View with:  DB_PATH=${dbPath} npm start`);
  db.close();
}

main();

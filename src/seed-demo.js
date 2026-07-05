// Generates a SYNTHETIC storm history so you can see the accuracy dashboard
// fully populated before real data has accumulated. It feeds fabricated poll
// snapshots through the exact same engine the live collector uses, then writes
// the state + dashboard JSON via the file store.
//
//   npm run demo                    -> writes data/state.json + public/data/*.json
//   npm start                       -> view it (uses the same state)
//
// NOTE: numbers here are invented to exercise the UI. They are NOT real utility
// performance. Delete data/state.json and collect live data for that.

import { createState, applySnapshot, buildOutputs } from './engine.js';
import { FileStore } from './store.js';
import { publicConfig } from './config.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  'RANDOLPH', 'MARLBORO', 'HOPEWELL', 'CHESTER', 'ROXBURY', 'WASHINGTON',
  'FREEHOLD', 'MADISON', 'MENDHAM', 'BOONTON', 'DENVILLE', 'ROCKAWAY',
  'JEFFERSON', 'MONTVILLE', 'PARSIPPANY', 'HOWELL', 'MIDDLETOWN', 'WALL',
  'MANALAPAN', 'ABERDEEN',
];

function buildOutages(t0) {
  const outages = [];
  for (let i = 0; i < 34; i++) {
    const county = COUNTIES[Math.floor(rnd() * COUNTIES.length)];
    const name = `${NAMES[i % NAMES.length]} TOWNSHIP`;
    const start = t0 + Math.floor(rnd() * 6) * 60 * MIN;
    const durationH = 2 + rnd() * 30;
    const trueRestore = start + durationH * 60 * MIN;
    const bias = -0.2 * durationH * 60 * MIN; // utility ~20% optimistic
    const noise = (rnd() - 0.5) * 0.5 * durationH * 60 * MIN;
    outages.push({
      areaId: `JC|${county}|NEW JERSEY|${name}|Township`,
      name,
      county,
      start,
      trueRestore,
      peak: 50 + Math.floor(rnd() * 4000),
      initialEtr: Math.round(start + durationH * 60 * MIN + bias + noise),
      revises: rnd() < 0.5,
      revisedEtr: Math.round(trueRestore + (rnd() - 0.3) * 3 * 60 * MIN),
      reviseAt: start + durationH * 0.5 * 60 * MIN,
    });
  }
  return outages;
}

async function main() {
  const state = createState();
  const t0 = 1783000000000;
  const outages = buildOutages(t0);
  const horizon = t0 + 40 * 60 * MIN;
  const stepMs = 15 * MIN;

  let polls = 0;
  for (let t = t0; t <= horizon; t += stepMs) {
    const areas = [];
    for (const o of outages) {
      if (t < o.start || t >= o.trueRestore) continue;
      const etr = o.revises && t >= o.reviseAt ? o.revisedEtr : o.initialEtr;
      const frac = 1 - (t - o.start) / (o.trueRestore - o.start);
      const custA = Math.max(1, Math.round(o.peak * (0.3 + 0.7 * frac)));
      areas.push({
        areaId: o.areaId, name: o.name, county: o.county, state: 'NEW JERSEY',
        custA, custS: 20000, percentA: 1,
        nOut: Math.max(1, Math.round(custA / 40)),
        etr, etrRaw: new Date(etr).toISOString(), etrConfidence: null,
      });
    }
    applySnapshot(state, {
      fetchedAt: t, generatedAt: t, intervalId: 'demo', updatedAt: t,
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

  const store = new FileStore(join(__dirname, '..', 'data', 'state.json'));
  await store.save(state);
  const outputs = buildOutputs(state);
  outputs.config = { ...publicConfig(), generatedAt: horizon };
  await store.writeOutputs(outputs);

  const resolved = state.episodes.filter((e) => e.resolved).length;
  console.log(
    `Seeded ${polls} polls, ${outages.length} outages, ${resolved} resolved.`
  );
  console.log('Run `npm start` (with NO_SCHEDULER=1 to keep the demo data) to view.');
}

main();

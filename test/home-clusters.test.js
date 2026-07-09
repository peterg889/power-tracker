// Rigorous coverage of the house-through-many-clusters problem.
//
// JCP&L models OUTAGE CLUSTERS; a household experiences one thing — is my
// power on. Over a single continuous house-outage the covering clusters
// merge, split, get redrawn, disagree with each other, and revise their
// promises (sometimes back to an earlier value). The home model must ride
// through all of it as ONE episode with a faithful promise trail, so the
// household question — when did power come back vs the FIRST estimate given —
// is answerable.
//
// The centerpiece scenario mirrors a real 2026-07 Mendham Township outage as
// lived by an affected household: ~a dozen cluster incarnations, promises
// revised repeatedly (including reverting to a prior value), a feed coverage
// flap mid-outage, and restoration that BEAT the final promise by hours while
// missing the FIRST promise by days.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  applyHomeImpact,
  homeStatus,
} from '../src/engine.js';
import { homeImpactFromOutages } from '../src/geo.js';

const MIN = 60000;
const H = 60 * MIN;
const T0 = 1751700000000;

const HOME = { lat: 40.765, lon: -74.572, radiusM: 250 };

// Build a covering impact directly (unit level): kind + per-cluster promises.
const covered = (matches) => ({
  checked: true,
  covered: true,
  matches,
  nearestM: Math.min(...matches.map((m) => m.distM ?? 0)),
  radiusM: 250,
});
const clear = { checked: true, covered: false, matches: [], nearestM: 4000, radiusM: 250 };
const poly = (etr, distM = 500, extra = {}) => ({
  kind: 'polygon', distM, custA: 30, nOut: 1, etr, cause: null, crewStatus: null, ...extra,
});
const pt = (etr, distM = 100, extra = {}) => ({
  kind: 'point', distM, custA: 10, nOut: 1, etr, cause: null, crewStatus: null, ...extra,
});

// Minimal polyline encoder for geo-level fixtures.
function encodeRing(pts) {
  let out = '';
  let plat = 0;
  let plon = 0;
  const enc = (v) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let str = '';
    while (x >= 0x20) {
      str += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    return str + String.fromCharCode(x + 63);
  };
  for (const [lat, lon] of pts) {
    const ilat = Math.round(lat * 1e5);
    const ilon = Math.round(lon * 1e5);
    out += enc(ilat - plat) + enc(ilon - plon);
    plat = ilat;
    plon = ilon;
  }
  return out;
}
const squareAroundHome = (halfDeg = 0.01) =>
  encodeRing([
    [HOME.lat - halfDeg, HOME.lon - halfDeg],
    [HOME.lat + halfDeg, HOME.lon - halfDeg],
    [HOME.lat + halfDeg, HOME.lon + halfDeg],
    [HOME.lat - halfDeg, HOME.lon + halfDeg],
  ]);

test('the long outage, as lived: a dozen cluster incarnations, one episode, faithful promise trail', () => {
  const s = createState();
  // Promises, echoing the real sequence's shape (first promise same day,
  // slips by a day, then intraday shuffling incl. a revert, final promise
  // the morning of day 4):
  const P1 = T0 + 22 * H; // first promise: this evening
  const P2 = T0 + 41 * H; // slips to tomorrow morning
  const P3 = T0 + 63 * H; // day 3
  const P4 = T0 + 87.5 * H; // day 4, 11:30
  const P5 = T0 + 88.5 * H; // day 4, 12:30
  const P6 = T0 + 92 * H; // day 4, 2 PM

  //  0h  point cluster A, promise P1
  applyHomeImpact(s, covered([pt(P1)]), T0);
  //  6h  redrawn as polygon B, same promise (same-ETR cluster churn)
  applyHomeImpact(s, covered([poly(P1)]), T0 + 6 * H);
  // 12h  polygon C, promise slips to P2
  applyHomeImpact(s, covered([poly(P2)]), T0 + 12 * H);
  // 18h  TWO clusters cover at once: display-best polygon carries NO
  //      promise, a covering point does -> the point's promise counts,
  //      and it is outage-provenance, not a township fallback.
  applyHomeImpact(s, covered([poly(null, 400), pt(P3, 90)]), T0 + 18 * H, T0 + 999 * H);
  assert.equal(s.homeEpisodes[0].finalEtr, P3);
  assert.equal(s.homeEpisodes[0].etrSource, 'outage');
  // 24h  feed flap: coverage vanishes for one poll while power is still out
  const flap = applyHomeImpact(s, clear, T0 + 24 * H);
  assert.equal(flap.pending, true);
  // 30h  polygon D covers again, same promise P3 (flap healed, no revision)
  applyHomeImpact(s, covered([poly(P3)]), T0 + 30 * H);
  // 36h  only a max-zoom cluster marker near home, no promise; township says
  //      P3 too -> township fallback, same value, still no phantom revision
  applyHomeImpact(
    s,
    covered([{ kind: 'cluster', distM: 200, custA: null, nOut: null, etr: null, cause: null, crewStatus: null }]),
    T0 + 36 * H,
    P3
  );
  assert.equal(s.homeEpisodes[0].etrRevisions, 2, 'same-value updates are not revisions');
  // 42h-54h  day-4 shuffle: 11:30 -> 12:30 -> back to 11:30
  applyHomeImpact(s, covered([poly(P4)]), T0 + 42 * H);
  applyHomeImpact(s, covered([poly(P5)]), T0 + 48 * H);
  applyHomeImpact(s, covered([poly(P4)]), T0 + 54 * H);
  // 60h  final incarnation, promise P6 (2 PM)
  applyHomeImpact(s, covered([pt(P6)]), T0 + 60 * H);
  // 66h  power actually back (~3 AM analog): clear, then confirmed
  applyHomeImpact(s, clear, T0 + 66 * H);
  applyHomeImpact(s, clear, T0 + 72 * H);

  // ONE episode despite ~a dozen cluster incarnations and a flap.
  assert.equal(s.homeEpisodes.length, 1, 'raw state: one continuous episode');
  const h = homeStatus(s);
  assert.equal(h.episodes, 1);
  const rec = h.history[0];

  assert.equal(rec.resolved, true);
  assert.equal(rec.flaps, 1, 'the mid-outage feed flap is on the record');

  // The promise trail is verbatim: every distinct change, in order,
  // including the revert to P4.
  assert.deepEqual(
    rec.etrHistory.map((x) => x.etr),
    [P1, P2, P3, P4, P5, P4, P6]
  );
  assert.equal(rec.etrRevisions, 6);
  assert.equal(rec.firstEtr, P1, 'the FIRST estimate the household was given');
  assert.equal(rec.finalEtr, P6);

  // Restoration: last covered 60h, first clear 66h -> actual estimate 63h.
  // vs final promise (92h): 29h EARLY — the number the utility would tout.
  // vs first promise (22h): 41h LATE — the number the household lived.
  assert.equal(rec.graded, true);
  assert.equal(rec.finalErrorMin, (63 - 92) * 60);
  assert.equal(rec.firstErrorMin, (63 - 22) * 60);
  assert.equal(h.medianFirstErrorMin, (63 - 22) * 60);
  assert.equal(h.medianFinalErrorMin, (63 - 92) * 60);
});

test('promise provenance ladder: own shape, then any covering shape, then township', () => {
  // Display-best has its own promise -> it wins even if others disagree.
  const s1 = createState();
  applyHomeImpact(s1, covered([poly(111, 500), pt(222, 50)]), T0, 333);
  assert.equal(s1.homeEpisodes[0].finalEtr, 111);
  assert.equal(s1.homeEpisodes[0].etrSource, 'outage');

  // Display-best silent, another covering shape speaks -> its promise, still
  // outage provenance.
  const s2 = createState();
  applyHomeImpact(s2, covered([poly(null, 500), pt(222, 50)]), T0, 333);
  assert.equal(s2.homeEpisodes[0].finalEtr, 222);
  assert.equal(s2.homeEpisodes[0].etrSource, 'outage');

  // Every covering shape silent -> township estimate, labeled as such.
  const s3 = createState();
  applyHomeImpact(s3, covered([poly(null, 500)]), T0, 333);
  assert.equal(s3.homeEpisodes[0].finalEtr, 333);
  assert.equal(s3.homeEpisodes[0].etrSource, 'area');

  // Nobody speaks -> no promise, no phantom history entry.
  const s4 = createState();
  applyHomeImpact(s4, covered([poly(null, 500)]), T0, null);
  assert.equal(s4.homeEpisodes[0].finalEtr, null);
  assert.equal(s4.homeEpisodes[0].etrHistory.length, 0);
});

test('promise switching between covering clusters is a revision, recorded once per change', () => {
  const s = createState();
  // Two clusters cover simultaneously with different promises; the polygon
  // (display-best) wins first...
  applyHomeImpact(s, covered([poly(111, 500), pt(222, 50)]), T0);
  // ...then the polygon disappears and only the point remains: the promise
  // the house sees switches 111 -> 222. One revision.
  applyHomeImpact(s, covered([pt(222, 50)]), T0 + H);
  // Point persists: no further revisions.
  applyHomeImpact(s, covered([pt(222, 50)]), T0 + 2 * H);
  const ep = s.homeEpisodes[0];
  assert.deepEqual(ep.etrHistory.map((x) => x.etr), [111, 222]);
  assert.equal(ep.etrRevisions, 1);
});

test('geo-level determinism: polygon containment outranks a nearer point marker', () => {
  const ring = squareAroundHome();
  const impact = homeImpactFromOutages(
    {
      outages: [
        // Point outage 90 m from home.
        { point: [HOME.lat + 0.0008, HOME.lon], geomA: [], custA: 5, nOut: 1, etr: 111, cause: null, crewStatus: null },
        // Polygon covering home, marker 800 m away.
        { point: [HOME.lat + 0.0072, HOME.lon], geomA: [ring], custA: 50, nOut: 1, etr: 222, cause: null, crewStatus: null },
      ],
    },
    HOME
  );
  assert.equal(impact.covered, true);
  assert.equal(impact.matches.length, 2, 'both cover');
  assert.equal(impact.matches[0].kind, 'polygon', 'containment outranks distance');
  assert.equal(impact.matches[0].etr, 222);
  assert.equal(impact.matches[1].kind, 'point');
});

test('geo-level determinism: among covering polygons, nearest marker wins', () => {
  const ring = squareAroundHome();
  const far = { point: [HOME.lat + 0.009, HOME.lon], geomA: [ring], custA: 1, nOut: 1, etr: 111, cause: null, crewStatus: null };
  const near = { point: [HOME.lat + 0.002, HOME.lon], geomA: [ring], custA: 1, nOut: 1, etr: 222, cause: null, crewStatus: null };
  // Input order must not matter.
  const a = homeImpactFromOutages({ outages: [far, near] }, HOME);
  const b = homeImpactFromOutages({ outages: [near, far] }, HOME);
  assert.equal(a.matches[0].etr, 222);
  assert.equal(b.matches[0].etr, 222);
});

test('cluster-count churn never forks the home episode (merge/split immunity)', () => {
  const s = createState();
  // 1 cluster -> 3 clusters (split) -> 2 -> 1 (merges), power out throughout.
  applyHomeImpact(s, covered([poly(111)]), T0);
  applyHomeImpact(s, covered([poly(111), pt(111, 40), pt(111, 200)]), T0 + H);
  applyHomeImpact(s, covered([pt(111, 40), pt(111, 200)]), T0 + 2 * H);
  applyHomeImpact(s, covered([pt(111, 40)]), T0 + 3 * H);
  assert.equal(s.homeEpisodes.length, 1);
  assert.equal(s.homeEpisodes[0].etrRevisions, 0, 'same promise all along');
  assert.equal(s.homeEpisodes[0].samples, 4);
});

test('peak customers reflects the largest simultaneous covering set, not a sum over time', () => {
  const s = createState();
  applyHomeImpact(s, covered([poly(null, 500, { custA: 30 })]), T0);
  applyHomeImpact(s, covered([poly(null, 500, { custA: 25 }), pt(null, 50, { custA: 25 })]), T0 + H);
  applyHomeImpact(s, covered([pt(null, 50, { custA: 10 })]), T0 + 2 * H);
  assert.equal(s.homeEpisodes[0].peakCustA, 50, 'max over polls of the per-poll sum');
});

test('a real restoration between two distinct outages stays two episodes', () => {
  const s = createState();
  applyHomeImpact(s, covered([pt(111)]), T0);
  // Clear for three consecutive polls (well past flap grace + coalescing).
  applyHomeImpact(s, clear, T0 + 1 * H);
  applyHomeImpact(s, clear, T0 + 2 * H);
  applyHomeImpact(s, clear, T0 + 3 * H);
  // New outage next day.
  applyHomeImpact(s, covered([pt(222)]), T0 + 27 * H);
  const h = homeStatus(s);
  assert.equal(h.episodes, 2, 'a day of power between outages is not a flap');
  assert.equal(h.history[0].resolved, false);
  assert.equal(h.history[0].firstEtr, 222, 'the new outage starts its own promise trail');
  assert.equal(h.history[1].firstEtr, 111);
});

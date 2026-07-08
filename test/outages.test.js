// The geometric (outage-level) tracker: continuity by proximity, merge/split
// tainting, and clean-lifecycle-only grading. Offsets use ~1e-3 deg latitude
// ≈ 111 m.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  applyOutageGeometries,
  applyHomeImpact,
  outageAccuracy,
  homeStatus,
} from '../src/engine.js';

const T0 = 1700000000000;
const MIN = 60000;
const step = 30 * MIN;

const out = (lat, lon, etr, extra = {}) => ({
  point: [lat, lon],
  geomA: [],
  custA: 10,
  nOut: 1,
  etr,
  cause: null,
  crewStatus: null,
  ...extra,
});

test('clean lifecycle: continuity within radius, revision tracking, grading', () => {
  const s = createState();
  // Polls 1-2: same outage (moves 50 m), ETR revised down at poll 2.
  applyOutageGeometries(s, { outages: [out(40.7, -74.5, T0 + 120 * MIN)] }, T0);
  applyOutageGeometries(s, { outages: [out(40.7005, -74.5, T0 + 90 * MIN)] }, T0 + step);
  // Poll 3: gone -> resolved. last seen T0+30m, gone T0+60m -> actual T0+45m.
  const r3 = applyOutageGeometries(s, { outages: [] }, T0 + 2 * step);
  assert.equal(r3.resolved, 1);

  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 1);
  assert.equal(acc.taintedCount, 0);
  // final ETR T0+90m vs actual T0+45m -> 45 min early
  assert.equal(acc.final.medianErrorMin, -45);
  // first ETR T0+120m vs actual T0+45m -> 75 min early
  assert.equal(acc.first.medianErrorMin, -75);
  assert.equal(acc.meanRevisions, 1);
});

test('distant observation is a different outage, not a continuation', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(40.7, -74.5, null)] }, T0);
  // 1.1 km north: outside the 150 m default radius.
  const r = applyOutageGeometries(s, { outages: [out(40.71, -74.5, null)] }, T0 + step);
  assert.equal(r.opened, 1);
  assert.equal(r.resolved, 1);
  assert.equal(r.continued, 0);
});

test('merge taints every episode involved and excludes them from grading', () => {
  const s = createState();
  // Two distinct outages 600 m apart.
  applyOutageGeometries(
    s,
    { outages: [out(40.7, -74.5, T0 + 60 * MIN), out(40.7054, -74.5, T0 + 60 * MIN)] },
    T0
  );
  // They reconcile into one shape at the midpoint (within 300 m of both...
  // use a radius that links both: 150 m default won't reach, so place the
  // merged marker 100 m from each original by using closer originals).
  const s2 = createState();
  applyOutageGeometries(
    s2,
    { outages: [out(40.7, -74.5, T0 + 60 * MIN), out(40.7018, -74.5, T0 + 60 * MIN)] },
    T0
  );
  const merged = applyOutageGeometries(
    s2,
    { outages: [out(40.7009, -74.5, T0 + 60 * MIN)] },
    T0 + step
  );
  assert.equal(merged.merged, 2, 'both episodes tainted by the merge');
  // Resolve everything and check nothing got graded.
  applyOutageGeometries(s2, { outages: [] }, T0 + 2 * step);
  const acc = outageAccuracy(s2);
  assert.equal(acc.gradedCount, 0);
  assert.equal(acc.taintedCount, 2);
});

test('split taints the parent and marks children as split-born', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(40.7, -74.5, T0 + 60 * MIN)] }, T0);
  // One outage becomes two flanking observations, both within radius.
  const r = applyOutageGeometries(
    s,
    { outages: [out(40.7005, -74.5, T0 + 60 * MIN), out(40.6995, -74.5, T0 + 60 * MIN)] },
    T0 + step
  );
  assert.equal(r.split, 1);
  assert.equal(r.opened, 1, 'second fragment becomes a new (tainted) episode');
  applyOutageGeometries(s, { outages: [] }, T0 + 2 * step);
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 0, 'no lifecycle stays clean through a split');
  assert.equal(acc.taintedCount, 2);
});

test('polygon containment links an episode to its redrawn shape', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(40.7, -74.5, null)] }, T0);
  // Redrawn as a polygon whose marker moved 1+ km away but whose ring still
  // covers the episode point: encode a square around (40.7, -74.5).
  // Encoded ring for [[40.69,-74.51],[40.71,-74.51],[40.71,-74.49],[40.69,-74.49]]
  const ring = encodeRing([
    [40.69, -74.51],
    [40.71, -74.51],
    [40.71, -74.49],
    [40.69, -74.49],
  ]);
  const r = applyOutageGeometries(
    s,
    { outages: [out(40.71, -74.49, null, { geomA: [ring] })] },
    T0 + step
  );
  assert.equal(r.continued, 1);
  assert.equal(r.opened, 0);
});

test('cluster leaves keep nearby episodes alive but taint them', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(40.7, -74.5, T0 + 60 * MIN)] }, T0);
  const r = applyOutageGeometries(
    s,
    { outages: [], clusterPoints: [[40.703, -74.5]] },
    T0 + step
  );
  assert.equal(r.clustered, 1);
  assert.equal(r.resolved, 0);
  const ep = s.outageEpisodes[0];
  assert.equal(ep.resolved, false);
  assert.equal(ep.taint, 'clustered');
});

test('home episodes: coverage continuity survives merge-like churn', () => {
  const s = createState();
  const impactOut = (etr) => ({
    checked: true,
    covered: true,
    matches: [{ kind: 'polygon', distM: 0, custA: 40, nOut: 1, etr, cause: null, crewStatus: null }],
    nearestM: 0,
    radiusM: 250,
  });
  const impactClear = { checked: true, covered: false, matches: [], nearestM: 5000, radiusM: 250 };

  applyHomeImpact(s, impactOut(T0 + 120 * MIN), T0);
  // Different shape covers home next poll (a merge happened) — same episode.
  applyHomeImpact(s, impactOut(T0 + 90 * MIN), T0 + step);
  applyHomeImpact(s, impactClear, T0 + 2 * step);

  const h = homeStatus(s);
  assert.equal(h.enabled, true);
  assert.equal(h.episodes, 1, 'merges over a fixed point never fork episodes');
  assert.equal(h.gradedCount, 1);
  // actual midpoint T0+45m vs final promise T0+90m -> 45 early
  assert.equal(h.medianFinalErrorMin, -45);
  assert.equal(h.current, null);

  // ETR falls back to the township estimate when the outage has none.
  const s2 = createState();
  applyHomeImpact(
    s2,
    { ...impactOut(null), matches: [{ ...impactOut(null).matches[0], etr: null }] },
    T0,
    T0 + 60 * MIN
  );
  assert.equal(s2.homeEpisodes[0].finalEtr, T0 + 60 * MIN);
  assert.equal(s2.homeEpisodes[0].etrSource, 'area');
});

// Minimal Google polyline encoder (test-only) for building geom.a fixtures.
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

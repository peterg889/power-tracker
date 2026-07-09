// Thorough coverage of geometric merge/split reconciliation over time.
//
// Background, verified against the live feed: outage entries carry NO stable
// identity (desc.inc_id is null on every public entry; the visible id is
// `{zoom}-{index}`, a tile position reassigned on every regeneration), and no
// merge/split lineage is published. The tracker therefore (a) links
// observations across polls purely by geometric continuity, (b) taints every
// lifecycle a merge or split touches and excludes it from grading, and
// (c) synthesizes the lineage record the feed doesn't provide (geoEvents).
//
// Distances: 1e-3 deg latitude ≈ 111 m. Default match radius is 150 m
// (0.00135 deg lat).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  applyOutageGeometries,
  outageAccuracy,
} from '../src/engine.js';

const T0 = 1700000000000;
const MIN = 60000;
const step = 30 * MIN;
const t = (n) => T0 + n * step;

const out = (lat, lon, etr = null, extra = {}) => ({
  point: [lat, lon],
  geomA: [],
  custA: 10,
  nOut: 1,
  etr,
  cause: null,
  crewStatus: null,
  ...extra,
});

const LAT = 40.7;
const LON = -74.5;
const M = (meters) => meters / 111195; // meters -> degrees latitude

// Minimal Google polyline encoder for building geom.a ring fixtures.
function encodeRing(pts) {
  let outStr = '';
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
    outStr += enc(ilat - plat) + enc(ilon - plon);
    plat = ilat;
    plon = ilon;
  }
  return outStr;
}
const squareAround = (lat, lon, halfM) => {
  const d = M(halfM);
  return encodeRing([
    [lat - d, lon - d],
    [lat + d, lon - d],
    [lat + d, lon + d],
    [lat - d, lon + d],
  ]);
};

// ---------------------------------------------------------------- merges

test('three-way merge: all tainted, one survivor continues, losers resolve at merge time', () => {
  const s = createState();
  // Three outages in a 120 m row: A -- B -- C (each 120 m apart, so A-C are
  // 240 m apart and do NOT link to each other's positions directly).
  applyOutageGeometries(
    s,
    { outages: [out(LAT, LON, t(4)), out(LAT + M(120), LON, t(4)), out(LAT + M(240), LON, t(4))] },
    t(0)
  );
  assert.equal(s.outageEpisodes.length, 3);

  // They reconcile into one shape at B's position: links to all three
  // (A and C are 120 m from it, B is 0 m).
  const r = applyOutageGeometries(s, { outages: [out(LAT + M(120), LON, t(4))] }, t(1));
  assert.equal(r.merged, 3, 'all three episodes tainted by the merge');
  assert.equal(r.continued, 1, 'exactly one continues as the merged shape');
  assert.equal(r.resolved, 2, 'the absorbed episodes resolve at merge time');

  const eps = s.outageEpisodes;
  assert.equal(eps.filter((e) => e.taint === 'merged').length, 3);
  const losers = eps.filter((e) => e.resolved);
  assert.equal(losers.length, 2);
  for (const l of losers) assert.equal(l.resolvedTs, t(1));

  // Lineage: one merge event naming all three, with the survivor recorded.
  assert.equal(s.geoStats.merges, 1);
  const ev = s.geoEvents[0];
  assert.equal(ev.type, 'merge');
  assert.equal(ev.episodeIds.length, 3);
  const survivor = eps.find((e) => !e.resolved);
  assert.equal(ev.survivorId, survivor.id);

  // Nothing from a merge is ever graded, even with ETRs on record.
  applyOutageGeometries(s, { outages: [] }, t(2));
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 0);
  assert.equal(acc.taintedCount, 3);
  assert.equal(acc.reconciliations.merges, 1);
});

test('chain merge: an already-merged blob absorbing a clean episode taints it too', () => {
  const s = createState();
  applyOutageGeometries(
    s,
    { outages: [out(LAT, LON), out(LAT + M(120), LON), out(LAT + M(1500), LON)] },
    t(0)
  );
  // Poll 2: first two merge; the far one continues cleanly.
  applyOutageGeometries(
    s,
    { outages: [out(LAT + M(60), LON), out(LAT + M(1500), LON)] },
    t(1)
  );
  assert.equal(s.geoStats.merges, 1);
  const farEp = s.outageEpisodes.find((e) => e.point[0] > LAT + M(1000));
  assert.equal(farEp.taint, null, 'distant episode untouched so far');

  // Poll 3: the blob spreads and now also links the far episode.
  const blob = out(LAT + M(780), LON, null, {
    geomA: [squareAround(LAT + M(780), LON, 800)], // covers both remaining points
  });
  const r = applyOutageGeometries(s, { outages: [blob] }, t(2));
  assert.ok(r.merged >= 1, 'the clean far episode is now merge-tainted');
  assert.equal(s.geoStats.merges, 2);
  assert.equal(farEp.taint, 'merged');
});

test('polygon-mediated merge: containment links shapes whose markers are far apart', () => {
  const s = createState();
  // Two point episodes 500 m apart — far beyond the 150 m radius.
  applyOutageGeometries(s, { outages: [out(LAT, LON), out(LAT + M(500), LON)] }, t(0));
  // One new outage: marker ~5 km away, but its polygon covers both points.
  const big = out(LAT + M(5000), LON, null, {
    geomA: [squareAround(LAT + M(250), LON, 400)],
  });
  const r = applyOutageGeometries(s, { outages: [big] }, t(1));
  assert.equal(r.merged, 2, 'containment alone is a link');
  assert.equal(s.outageEpisodes.filter((e) => e.taint === 'merged').length, 2);
});

// ---------------------------------------------------------------- splits

test('split into three: parent tainted, two split-children born tainted, lineage recorded', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON, t(4))] }, t(0));
  const parentId = s.outageEpisodes[0].id;

  // Fragments at -120 m, 0 m, +120 m: all within radius of the parent point.
  const r = applyOutageGeometries(
    s,
    {
      outages: [
        out(LAT - M(120), LON, t(4)),
        out(LAT, LON, t(4)),
        out(LAT + M(120), LON, t(4)),
      ],
    },
    t(1)
  );
  assert.equal(r.split, 3, 'parent + two children newly tainted');
  assert.equal(r.continued, 1, 'parent continues as the nearest fragment');
  assert.equal(r.opened, 2, 'two fragments become new episodes');

  const children = s.outageEpisodes.filter((e) => e.id !== parentId);
  assert.equal(children.length, 2);
  for (const c of children) assert.equal(c.taint, 'split');
  assert.equal(s.outageEpisodes.find((e) => e.id === parentId).taint, 'split');

  assert.equal(s.geoStats.splits, 2, 'one lineage event per child');
  const evs = s.geoEvents.filter((e) => e.type === 'split-child');
  assert.equal(evs.length, 2);
  for (const ev of evs) assert.deepEqual(ev.parentIds, [parentId]);

  // Resolve everything: no fragment lifecycle is gradable.
  applyOutageGeometries(s, { outages: [] }, t(2));
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 0);
  assert.equal(acc.taintedCount, 3);
});

test('polygon-mediated split: fragments inside the old shape, beyond point radius', () => {
  const s = createState();
  // The episode's own observed polygon is what links it to its fragments.
  applyOutageGeometries(
    s,
    { outages: [out(LAT, LON, null, { geomA: [squareAround(LAT, LON, 600)] })] },
    t(0)
  );
  // Two fragments 400 m either side: outside 150 m radius, inside the ring.
  const r = applyOutageGeometries(
    s,
    { outages: [out(LAT + M(400), LON), out(LAT - M(400), LON)] },
    t(1)
  );
  assert.equal(r.split, 2, 'parent + one child newly tainted');
  assert.equal(r.opened, 1);
  assert.equal(s.outageEpisodes.length, 2);
  assert.ok(s.outageEpisodes.every((e) => e.taint === 'split'));
});

test('split then re-merge: episodes stay tainted, lineage shows both events', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON)] }, t(0));
  applyOutageGeometries(
    s,
    { outages: [out(LAT + M(100), LON), out(LAT - M(100), LON)] },
    t(1)
  ); // split
  applyOutageGeometries(s, { outages: [out(LAT, LON)] }, t(2)); // re-merge
  applyOutageGeometries(s, { outages: [] }, t(3)); // all clear

  assert.equal(s.geoStats.splits, 1);
  assert.equal(s.geoStats.merges, 1);
  assert.equal(s.outageEpisodes.length, 2, 'parent + one split child, never more');
  assert.ok(s.outageEpisodes.every((e) => e.resolved));
  assert.ok(s.outageEpisodes.every((e) => e.taint != null));
  assert.equal(outageAccuracy(s).gradedCount, 0);
});

test('taint records the FIRST cause and is never overwritten', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON)] }, t(0));
  applyOutageGeometries(
    s,
    { outages: [out(LAT + M(100), LON), out(LAT - M(100), LON)] },
    t(1)
  ); // split taints parent + child
  const parent = s.outageEpisodes[0];
  assert.equal(parent.taint, 'split');
  // Now those two merge back — merge would taint, but 'split' must stick.
  applyOutageGeometries(s, { outages: [out(LAT, LON)] }, t(2));
  assert.equal(parent.taint, 'split');
});

// ------------------------------------------------------------ isolation

test('taint is local: a clean lifecycle in the same polls still grades', () => {
  const s = createState();
  const FAR = LAT + M(10000);
  applyOutageGeometries(
    s,
    {
      outages: [
        out(LAT, LON, t(4)),
        out(LAT + M(120), LON, t(4)),
        out(FAR, LON, t(2)), // clean, promises t(2)
      ],
    },
    t(0)
  );
  applyOutageGeometries(
    s,
    { outages: [out(LAT + M(60), LON, t(4)), out(FAR, LON, t(2))] },
    t(1)
  ); // merge happens near LAT; FAR continues cleanly
  applyOutageGeometries(s, { outages: [] }, t(2)); // everything restored

  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 1, 'only the clean lifecycle grades');
  assert.equal(acc.taintedCount, 2);
  // FAR: last seen t(1), gone t(2) -> actual t(1.5) = T0+45m vs promise T0+60m -> 15 early
  assert.equal(acc.final.medianErrorMin, -15);
});

test('co-located persistent outages are ambiguous, NOT merges (live-feed regression)', () => {
  // Observed live: two distinct outages ~43 m apart, both persisting across
  // polls. Raw edge multiplicity misread this as a merge every poll; the
  // correct reading is 1:1 continuation with unresolvable identity.
  const s = createState();
  const pair = () => [out(LAT, LON, t(4)), out(LAT + M(100), LON, t(4))];
  applyOutageGeometries(s, { outages: pair() }, t(0));
  const r = applyOutageGeometries(s, { outages: pair() }, t(1));

  assert.equal(r.continued, 2, 'both continue 1:1');
  assert.equal(r.merged, 0, 'no absorption happened');
  assert.equal(r.ambiguous, 2, 'both flagged: identities could silently swap');
  assert.equal(s.geoStats.merges, 0, 'no merge event fabricated');
  assert.equal(s.geoEvents.length, 0);
  assert.ok(s.outageEpisodes.every((e) => e.taint === 'ambiguous'));

  // Steady state: already tainted, nothing double-counts.
  const r2 = applyOutageGeometries(s, { outages: pair() }, t(2));
  assert.equal(r2.ambiguous, 0);
  assert.equal(s.geoStats.ambiguous, 2);

  // Excluded from grading like every other taint.
  applyOutageGeometries(s, { outages: [] }, t(3));
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 0);
  assert.equal(acc.taintedCount, 2);
  assert.equal(acc.reconciliations.ambiguous, 2);
});

test('a well-separated pair never picks up ambiguity taint', () => {
  const s = createState();
  const pair = () => [out(LAT, LON, t(4)), out(LAT + M(400), LON, t(4))];
  applyOutageGeometries(s, { outages: pair() }, t(0));
  applyOutageGeometries(s, { outages: pair() }, t(1));
  applyOutageGeometries(s, { outages: [] }, t(2));
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 2, 'both clean lifecycles grade');
  assert.equal(acc.taintedCount, 0);
});

// ------------------------------------------------------- continuity edges

test('boundary: 140 m links as the same outage, 165 m does not', () => {
  const near = createState();
  applyOutageGeometries(near, { outages: [out(LAT, LON)] }, t(0));
  const rNear = applyOutageGeometries(near, { outages: [out(LAT + M(140), LON)] }, t(1));
  assert.equal(rNear.continued, 1);
  assert.equal(rNear.opened, 0);

  const far = createState();
  applyOutageGeometries(far, { outages: [out(LAT, LON)] }, t(0));
  const rFar = applyOutageGeometries(far, { outages: [out(LAT + M(165), LON)] }, t(1));
  assert.equal(rFar.continued, 0);
  assert.equal(rFar.opened, 1);
  assert.equal(rFar.resolved, 1);
});

test('slow drift stays one clean episode even after moving far in total', () => {
  const s = createState();
  for (let i = 0; i <= 5; i++) {
    applyOutageGeometries(s, { outages: [out(LAT + M(100 * i), LON, t(8))] }, t(i));
  }
  assert.equal(s.outageEpisodes.length, 1, '500 m total drift, 100 m per poll');
  assert.equal(s.outageEpisodes[0].taint, null);
  assert.equal(s.outageEpisodes[0].samples, 6);
  applyOutageGeometries(s, { outages: [] }, t(6));
  assert.equal(outageAccuracy(s).gradedCount, 1);
});

test('cluster keepalive bridges a clustered poll, then the episode resolves normally', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON, t(4))] }, t(0));
  // Poll 2: the area collapses into an unresolvable max-zoom cluster nearby.
  const r2 = applyOutageGeometries(
    s,
    { outages: [], clusterPoints: [[LAT + M(300), LON]] },
    t(1)
  );
  assert.equal(r2.clustered, 1);
  assert.equal(r2.resolved, 0);
  // Poll 3: individual again at the same spot — same episode continues.
  const r3 = applyOutageGeometries(s, { outages: [out(LAT, LON, t(4))] }, t(2));
  assert.equal(r3.continued, 1);
  assert.equal(s.outageEpisodes.length, 1);
  assert.equal(s.outageEpisodes[0].taint, 'clustered', 'the blind poll leaves a mark');
  // ...and because it was blind once, it is excluded from grading.
  applyOutageGeometries(s, { outages: [] }, t(3));
  const acc = outageAccuracy(s);
  assert.equal(acc.gradedCount, 0);
  assert.equal(acc.taintedCount, 1);
});

test('re-outage at the same location is a new episode, not a resurrection', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON, t(1))] }, t(0));
  applyOutageGeometries(s, { outages: [] }, t(1)); // resolves
  applyOutageGeometries(s, { outages: [out(LAT, LON, t(6))] }, t(4)); // same spot, hours later
  assert.equal(s.outageEpisodes.length, 2);
  assert.equal(s.outageEpisodes[0].resolved, true);
  assert.equal(s.outageEpisodes[1].resolved, false);
  assert.equal(s.outageEpisodes[1].taint, null, 'a resolved episode cannot taint its successor');
});

// ----------------------------------------------------------- accounting

test('gap exclusion and no-ETR accounting apply at the outage level too', () => {
  const s = createState();
  applyOutageGeometries(
    s,
    { outages: [out(LAT, LON, t(2)), out(LAT + M(5000), LON, null)] },
    t(0)
  );
  // Collector goes dark for 6 h; both are gone when polling resumes.
  applyOutageGeometries(s, { outages: [] }, t(12));
  const strict = outageAccuracy(s, { maxGapMin: 45 });
  assert.equal(strict.gradedCount, 0);
  assert.equal(strict.excludedForGapCount, 1, 'the promised one is gap-excluded');
  assert.equal(strict.noEtrCount, 1, 'the promise-less one is counted separately');
  const lax = outageAccuracy(s, { maxGapMin: 720 });
  assert.equal(lax.gradedCount, 1);
});

test('reconciliations block reports totals and recent events', () => {
  const s = createState();
  applyOutageGeometries(s, { outages: [out(LAT, LON), out(LAT + M(120), LON)] }, t(0));
  applyOutageGeometries(s, { outages: [out(LAT + M(60), LON)] }, t(1)); // merge
  const acc = outageAccuracy(s);
  assert.equal(acc.reconciliations.merges, 1);
  assert.equal(acc.reconciliations.splits, 0);
  assert.equal(acc.reconciliations.recent.length, 1);
  assert.equal(acc.reconciliations.recent[0].type, 'merge');
});

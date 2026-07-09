// Storm / incident segmentation: events open on a customers-out surge and
// close only after sustained quiet, so one storm's accuracy numbers can never
// contaminate the next storm's — the separation the dashboard's period
// selector relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, detectStorms, buildOutputs, applySnapshot } from '../src/engine.js';

const T0 = 1700000000000;
const H = 3600000;
const OPTS = { onsetCustOut: 15000, clearCustOut: 5000, clearMs: 6 * H };

function stateWithCurve(points) {
  // points: [hoursFromT0, custOut]
  const s = createState();
  for (const [h, custOut] of points) {
    s.polls.push({ fetchedAt: T0 + h * H, custOut, outages: 1, areaCount: 1 });
  }
  return s;
}

test('background churn never registers as a storm', () => {
  const s = stateWithCurve([[0, 2000], [1, 3500], [2, 8000], [3, 4000], [4, 1400]]);
  assert.deepEqual(detectStorms(s, OPTS), []);
});

test('a surge opens a storm, tracks its peak, and stays open until sustained quiet', () => {
  const s = stateWithCurve([
    [0, 2000],
    [1, 22000], // onset
    [2, 41000], // peak
    [3, 30000],
    [4, 9000], // recovering but not quiet
    [5, 6000],
  ]);
  const storms = detectStorms(s, OPTS);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].startTs, T0 + 1 * H);
  assert.equal(storms[0].peakCustOut, 41000);
  assert.equal(storms[0].peakTs, T0 + 2 * H);
  assert.equal(storms[0].endTs, null, 'still active — never went quiet');
});

test('a brief dip below the clear threshold does not end the storm', () => {
  const s = stateWithCurve([
    [0, 22000],
    [1, 4000], // dips below clear...
    [2, 3000],
    [3, 18000], // ...but re-surges within clearMs (6 h)
    [4, 25000],
  ]);
  const storms = detectStorms(s, OPTS);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].endTs, null);
  assert.equal(storms[0].peakCustOut, 25000);
});

test('sustained quiet closes the storm, dated to the FIRST quiet poll', () => {
  const s = stateWithCurve([
    [0, 22000],
    [2, 30000],
    [4, 4500], // quiet begins
    [6, 3000],
    [8, 2500],
    [11, 2000], // 7 h of quiet -> closed
  ]);
  const storms = detectStorms(s, OPTS);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].endTs, T0 + 4 * H);
});

test('the next storm is a separate record — no contamination', () => {
  const s = stateWithCurve([
    [0, 25000],
    [2, 4000],
    [4, 3000],
    [9, 2500], // storm 1 closed (quiet since h2)
    [50, 60000], // storm 2, ten times worse
    [52, 30000],
  ]);
  const storms = detectStorms(s, OPTS);
  assert.equal(storms.length, 2);
  assert.equal(storms[0].endTs, T0 + 2 * H);
  assert.equal(storms[1].startTs, T0 + 50 * H);
  assert.equal(storms[1].peakCustOut, 60000);
  assert.equal(storms[1].endTs, null);
});

test('buildOutputs publishes storms and startTs-carrying scatter rows for period filtering', () => {
  const s = createState();
  const MIN = 60000;
  const snap = (fetchedAt, areas, custOut) => ({
    fetchedAt,
    generatedAt: fetchedAt,
    intervalId: 'test',
    pageMode: 'STORM',
    totals: { custOut, custServed: 1000000, outages: areas.length, percentOut: 1 },
    areas: areas.map((a) => ({
      areaId: a.id, name: a.id, county: 'X', state: 'NJ',
      custA: 100, custS: 1000, percentA: 1, nOut: 1,
      etr: a.etr ?? null, etrRaw: null, etrConfidence: null,
    })),
  });
  applySnapshot(s, snap(T0, [{ id: 'A', etr: T0 + 60 * MIN }], 20000));
  applySnapshot(s, snap(T0 + 30 * MIN, [], 2000)); // A resolves
  const out = buildOutputs(s, { storm: { onsetCustOut: 15000, clearCustOut: 5000, clearMs: 6 * H } });

  assert.ok(out.storms, 'storms document published');
  assert.equal(out.storms.active.startTs, T0);
  assert.equal(out.storms.active.peakCustOut, 20000);

  assert.equal(out.accuracy.scatter.length, 1);
  assert.equal(out.accuracy.scatter[0].startTs, T0, 'scatter rows carry startTs');
  assert.equal(out.accuracy.scatter[0].etrRevisions, 0);
});

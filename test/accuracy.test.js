// Verifies the episode lifecycle and the accuracy math by feeding a controlled
// sequence of poll snapshots through the engine and checking the derived
// numbers. Pure in-memory — no storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  applySnapshot,
  accuracySummary,
  status,
  buildOutputs,
} from '../src/engine.js';

const T0 = 1700000000000;
const MIN = 60000;
const step = 30 * MIN;

function snap(fetchedAt, areas) {
  return {
    fetchedAt,
    generatedAt: fetchedAt,
    intervalId: 'test',
    updatedAt: fetchedAt,
    pageMode: 'BLUESKY',
    totals: {
      custOut: areas.reduce((s, a) => s + (a.custA || 0), 0),
      custServed: 1000000,
      outages: areas.length,
      percentOut: 1,
    },
    areas: areas.map((a) => ({
      areaId: a.areaId,
      name: a.name || a.areaId,
      county: a.county || 'X',
      state: 'NEW JERSEY',
      custA: a.custA,
      custS: 1000,
      percentA: 1,
      nOut: a.nOut ?? 1,
      etr: a.etr ?? null,
      etrRaw: a.etr ? new Date(a.etr).toISOString() : null,
      etrConfidence: null,
    })),
  };
}

test('episode grading, revisions, and open/no-ETR exclusion', () => {
  const s = createState();

  // Poll 1 @ T0
  applySnapshot(
    s,
    snap(T0, [
      { areaId: 'A', county: 'X', custA: 100, etr: T0 + 60 * MIN },
      { areaId: 'B', county: 'Y', custA: 40, etr: T0 + 120 * MIN },
      { areaId: 'C', county: 'Z', custA: 10, etr: T0 + 200 * MIN }, // stays open
      { areaId: 'D', county: 'W', custA: 5, etr: null }, // never has ETR
    ])
  );

  // Poll 2 @ T0+30m: B revises its ETR down; D disappears (resolves, no ETR).
  applySnapshot(
    s,
    snap(T0 + step, [
      { areaId: 'A', county: 'X', custA: 100, etr: T0 + 60 * MIN },
      { areaId: 'B', county: 'Y', custA: 40, etr: T0 + 90 * MIN },
      { areaId: 'C', county: 'Z', custA: 10, etr: T0 + 200 * MIN },
    ])
  );

  // Poll 3 @ T0+60m: B disappears (resolves).
  applySnapshot(
    s,
    snap(T0 + 2 * step, [
      { areaId: 'A', county: 'X', custA: 100, etr: T0 + 60 * MIN },
      { areaId: 'C', county: 'Z', custA: 10, etr: T0 + 200 * MIN },
    ])
  );

  // Poll 4 @ T0+90m: A disappears (resolves).
  applySnapshot(
    s,
    snap(T0 + 3 * step, [{ areaId: 'C', county: 'Z', custA: 10, etr: T0 + 200 * MIN }])
  );

  const st = status(s);
  assert.equal(st.polls, 4);
  assert.equal(st.openEpisodes, 1, 'C should still be open');
  assert.equal(st.resolvedEpisodes, 3, 'A, B, D resolved');
  assert.equal(st.gradedEpisodes, 2, 'only A and B are gradable (D had no ETR)');

  // A: last_seen T0+60m, gone T0+90m -> actual T0+75m; final ETR T0+60m -> +15 late
  // B: last_seen T0+30m, gone T0+60m -> actual T0+45m; final ETR T0+90m -> -45 early, 1 revision
  const acc60 = accuracySummary(s, { onTimeWindowMin: 60 });
  assert.equal(acc60.gradedCount, 2);
  assert.equal(acc60.meanErrorMin, -15);
  assert.equal(acc60.medianErrorMin, -15);
  assert.equal(acc60.onTimeRate, 1);
  assert.equal(acc60.lateRate, 0);
  assert.equal(acc60.earlyRate, 0);
  assert.equal(acc60.meanRevisions, 0.5);

  const acc10 = accuracySummary(s, { onTimeWindowMin: 10 });
  assert.equal(acc10.onTimeRate, 0);
  assert.equal(acc10.lateRate, 0.5);
  assert.equal(acc10.earlyRate, 0.5);
});

test('re-outage creates a second episode for the same area', () => {
  const s = createState();
  applySnapshot(s, snap(T0, [{ areaId: 'A', custA: 50, etr: T0 + 60 * MIN }]));
  applySnapshot(s, snap(T0 + step, [])); // A resolves
  applySnapshot(
    s,
    snap(T0 + 10 * step, [{ areaId: 'A', custA: 30, etr: T0 + 12 * step }])
  ); // A out again (new episode)

  const st = status(s);
  assert.equal(st.openEpisodes, 1, 'the second outage is open');
  assert.equal(st.resolvedEpisodes, 1, 'the first outage resolved');
});

test('buildOutputs carries a raw errors array for client-side windowing', () => {
  const s = createState();
  applySnapshot(s, snap(T0, [{ areaId: 'A', custA: 10, etr: T0 + 60 * MIN }]));
  applySnapshot(s, snap(T0 + step, [])); // resolve
  const { accuracy } = buildOutputs(s);
  assert.equal(accuracy.gradedCount, 1);
  assert.ok(Array.isArray(accuracy.errors));
  assert.equal(accuracy.errors.length, 1);
});

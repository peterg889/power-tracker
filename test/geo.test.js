// Geo primitives, pinned against values verified live against the KUBRA feed
// (quadkey + shard confirmed by fetching real tiles; the decoded point matched
// a real outage marker).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quadkey,
  quadkeyShard,
  decodePolyline,
  pointInPolygon,
  haversineM,
  homeImpactFromOutages,
} from '../src/geo.js';

test('quadkey + shard match the live tile addressing', () => {
  // Verified live: this tile URL returned outage data for Mendham Township.
  assert.equal(quadkey(40.765187, -74.572022, 13), '0320101011331');
  assert.equal(quadkey(40.765187, -74.572022, 8), '03201010');
  assert.equal(quadkeyShard('0320101011331'), '133');
  assert.equal(quadkeyShard('03201010113310'), '013');
});

test('decodePolyline decodes a real feed marker', () => {
  // A geom.p payload observed in a live cluster tile.
  const [pt] = decodePolyline('}lwwFd`}eM');
  assert.equal(pt[0], 40.75743);
  assert.equal(pt[1], -74.53715);
});

test('pointInPolygon ray casting', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(-1, -1, square), false);
});

test('haversineM sanity', () => {
  // ~111 km per degree of latitude.
  const d = haversineM(40, -74, 41, -74);
  assert.ok(d > 110000 && d < 112000, `got ${d}`);
});

test('homeImpactFromOutages: containment, radius, and clear', () => {
  const HOME = { lat: 40.765, lon: -74.572, radiusM: 250 };
  // Encode a square around home by decoding is hard to hand-write; use a point
  // outage 100 m north instead, and one 5 km away.
  const near = { point: [40.7659, -74.572], geomA: [], custA: 12, nOut: 1, etr: 123, cause: 'Tree', crewStatus: null };
  const far = { point: [40.81, -74.572], geomA: [], custA: 500, nOut: 3, etr: null, cause: null, crewStatus: null };

  const hit = homeImpactFromOutages({ outages: [near, far] }, HOME);
  assert.equal(hit.covered, true);
  assert.equal(hit.matches.length, 1);
  assert.equal(hit.matches[0].kind, 'point');
  assert.equal(hit.matches[0].etr, 123);
  assert.ok(hit.matches[0].distM <= 150);

  const clear = homeImpactFromOutages({ outages: [far] }, HOME);
  assert.equal(clear.covered, false);
  assert.ok(clear.nearestM > 4000, 'nearest distance still reported');

  const cluster = homeImpactFromOutages(
    { outages: [], clusterPoints: [[40.7655, -74.572]] },
    HOME
  );
  assert.equal(cluster.covered, true);
  assert.equal(cluster.matches[0].kind, 'cluster');
});

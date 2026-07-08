// Verifies the KUBRA report parsing: leaf-area extraction from the nested
// state → county → township hierarchy, ETR parsing (including the sentinel
// strings the feed emits during storm assessment), and numeric coercion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLeafAreas, parseEtr } from '../src/kubra.js';

// Trimmed-down shape of a real report's file_data node.
const REPORT_FIXTURE = {
  areas: [
    {
      areaId: 'JC|NEW JERSEY',
      name: 'NEW JERSEY',
      areas: [
        {
          areaId: 'JC|MORRIS|NEW JERSEY',
          name: 'MORRIS',
          areas: [
            {
              areaId: 'JC|MORRIS|NEW JERSEY|HARDING TOWNSHIP|Township',
              name: 'HARDING TOWNSHIP',
              county: 'MORRIS',
              state: 'NEW JERSEY',
              cust_a: { val: 307 },
              cust_s: 1834,
              percent_cust_a: { val: 16.7 },
              n_out: 57,
              etr: '2026-07-08T20:00:00-04:00',
              etr_confidence: 90,
            },
            {
              areaId: 'JC|MORRIS|NEW JERSEY|CHESTER TOWNSHIP|Township',
              name: 'CHESTER TOWNSHIP',
              county: 'MORRIS',
              state: 'NEW JERSEY',
              cust_a: { val: 12 },
              n_out: 3,
              // Sentinel emitted during storm assessment — must not parse
              // into a bogus timestamp.
              etr: 'Assessing',
            },
          ],
        },
      ],
    },
  ],
};

test('collectLeafAreas extracts township leaves with parsed ETRs', () => {
  const acc = [];
  collectLeafAreas(REPORT_FIXTURE, acc);
  assert.equal(acc.length, 2, 'only leaf (township) nodes, not state/county');

  const harding = acc.find((a) => a.name === 'HARDING TOWNSHIP');
  assert.equal(harding.county, 'MORRIS');
  assert.equal(harding.custA, 307);
  assert.equal(harding.nOut, 57);
  assert.equal(harding.etr, Date.parse('2026-07-08T20:00:00-04:00'));
  assert.equal(harding.etrConfidence, 90);

  const chester = acc.find((a) => a.name === 'CHESTER TOWNSHIP');
  assert.equal(chester.etr, null, 'sentinel ETR strings must parse to null');
  assert.equal(chester.etrRaw, 'Assessing', 'raw value preserved for inspection');
  assert.equal(chester.custS, 0, 'missing numerics coerce to 0');
});

test('parseEtr handles ISO dates, sentinels, and junk', () => {
  assert.equal(parseEtr('2026-07-08T20:00:00Z'), Date.parse('2026-07-08T20:00:00Z'));
  assert.equal(parseEtr('Assessing'), null);
  assert.equal(parseEtr('TBD'), null);
  assert.equal(parseEtr(null), null);
  assert.equal(parseEtr(12345), null, 'non-strings are not trusted');
});

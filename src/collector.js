// One collection cycle: fetch a snapshot, fold it into the persisted state, and
// write the refreshed dashboard outputs. Storage-agnostic — works with the local
// file store or the S3 store. Reused by the dev server and the AWS Lambda.

import { fetchSnapshot, fetchOutageGeometries } from './kubra.js';
import {
  applySnapshot,
  applyHomeImpact,
  applyOutageGeometries,
  buildOutputs,
  matchesHomeArea,
  snapshotLooksSuspect,
} from './engine.js';
import { homeImpactFromOutages } from './geo.js';
import { makeStore } from './store.js';
import { config, publicConfig } from './config.js';

export async function collectOnce(store = makeStore()) {
  const state = await store.load();
  const snap = await fetchSnapshot();
  if (snapshotLooksSuspect(snap)) {
    throw new Error(
      `suspect snapshot (custOut=${snap.totals.custOut} but 0 areas) — ` +
        `skipping this poll to protect episode history`
    );
  }
  const result = applySnapshot(state, snap);

  // Geometry layer: walk the cluster tiles once and drive both the
  // outage-level tracker and the home-point test from the same data. A walk
  // failure must not lose the township-level poll — it degrades to a logged
  // skip (a skipped poll neither opens nor closes geometric episodes; long
  // skips surface later as gap exclusions).
  try {
    const geo = await fetchOutageGeometries(snap.clusterPath);
    result.outageGeo = applyOutageGeometries(state, geo, snap.fetchedAt, {
      matchRadiusM: config.matchRadiusM,
    });
    result.outageGeo.fetches = geo.fetches;
    if (config.homeConfigured) {
      const impact = homeImpactFromOutages(geo, {
        lat: config.homeLat,
        lon: config.homeLon,
        radiusM: config.homeRadiusM,
      });
      const homeArea = snap.areas.find((a) =>
        matchesHomeArea(a.name, a.county, config.homeAreas)
      );
      result.home = applyHomeImpact(state, impact, snap.fetchedAt, homeArea?.etr ?? null);
    }
  } catch (err) {
    console.error('[collect] geometry walk failed (outage-level + home skipped):', err.message);
  }

  await store.save(state);
  const outputs = buildOutputs(state, {
    maxGapMin: config.maxGapMinutes,
    storm: {
      onsetCustOut: config.stormOnsetCust,
      clearCustOut: config.stormClearCust,
      clearMs: config.stormClearHours * 3600000,
    },
  });
  outputs.config = { ...publicConfig(), generatedAt: snap.fetchedAt };
  await store.writeOutputs(outputs);
  return { snap, result, state, outputs };
}

// CLI entry point: `npm run collect`
if (import.meta.url === `file://${process.argv[1]}`) {
  collectOnce()
    .then(({ snap, result }) => {
      const t = snap.totals || {};
      let line =
        `[collect ${new Date(snap.fetchedAt).toISOString()}] ` +
        `mode=${snap.pageMode} custOut=${t.custOut} outages=${t.outages} ` +
        `areas=${snap.areas.length} | opened=${result.opened} ` +
        `updated=${result.updated} resolved=${result.resolved}`;
      const g = result.outageGeo;
      if (g) {
        line +=
          ` | geo: tiles=${g.fetches} opened=${g.opened} continued=${g.continued} ` +
          `resolved=${g.resolved} merged=${g.merged} split=${g.split} ` +
          `ambiguous=${g.ambiguous} clustered=${g.clustered}`;
      }
      if (result.home) line += ` | home: ${result.home.covered ? 'OUT' : 'clear'}`;
      console.log(line);
    })
    .catch((err) => {
      console.error('[collect] failed:', err.message);
      process.exit(1);
    });
}

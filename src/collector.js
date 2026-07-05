// One collection cycle: fetch a snapshot, fold it into the persisted state, and
// write the refreshed dashboard outputs. Storage-agnostic — works with the local
// file store or the S3 store. Reused by the dev server and the AWS Lambda.

import { fetchSnapshot } from './kubra.js';
import { applySnapshot, buildOutputs } from './engine.js';
import { makeStore } from './store.js';
import { publicConfig } from './config.js';

export async function collectOnce(store = makeStore()) {
  const state = await store.load();
  const snap = await fetchSnapshot();
  const result = applySnapshot(state, snap);
  await store.save(state);
  const outputs = buildOutputs(state);
  outputs.config = { ...publicConfig(), generatedAt: snap.fetchedAt };
  await store.writeOutputs(outputs);
  return { snap, result, state, outputs };
}

// CLI entry point: `npm run collect`
if (import.meta.url === `file://${process.argv[1]}`) {
  collectOnce()
    .then(({ snap, result }) => {
      const t = snap.totals || {};
      console.log(
        `[collect ${new Date(snap.fetchedAt).toISOString()}] ` +
          `mode=${snap.pageMode} custOut=${t.custOut} outages=${t.outages} ` +
          `areas=${snap.areas.length} | opened=${result.opened} ` +
          `updated=${result.updated} resolved=${result.resolved}`
      );
    })
    .catch((err) => {
      console.error('[collect] failed:', err.message);
      process.exit(1);
    });
}

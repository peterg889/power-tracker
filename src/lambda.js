// AWS Lambda handler for the scheduled collector.
//
// Triggered by EventBridge Scheduler (see infra/template.yaml). Each invocation
// reads state from S3, folds in a fresh snapshot of the outage feed, writes
// state back, and republishes the dashboard's JSON — all as a pure-JS zip, no
// native modules. Configuration comes from environment variables (S3_BUCKET,
// AWS_REGION, and any KUBRA_* overrides).

import { collectOnce } from './collector.js';
import { makeStore } from './store.js';

export const handler = async () => {
  const { snap, result } = await collectOnce(makeStore());
  const t = snap.totals || {};
  const summary = {
    fetchedAt: new Date(snap.fetchedAt).toISOString(),
    pageMode: snap.pageMode,
    custOut: t.custOut,
    outages: t.outages,
    areas: snap.areas.length,
    ...result,
  };
  console.log('[collect]', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

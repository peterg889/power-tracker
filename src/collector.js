// One collection cycle: fetch a snapshot and fold it into the database.
// Runnable standalone (`npm run collect`) for cron-style deployments, and
// imported by the server for the built-in scheduler.

import { fetchSnapshot } from './kubra.js';
import { openDb, ingestSnapshot } from './db.js';

export async function collectOnce(db) {
  const ownDb = !db;
  const database = db || openDb();
  try {
    const snap = await fetchSnapshot();
    const result = ingestSnapshot(database, snap);
    return { snap, result };
  } finally {
    if (ownDb) database.close();
  }
}

// CLI entry point.
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

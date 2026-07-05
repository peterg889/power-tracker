// Local dev server: serves the static dashboard, regenerates the dashboard's
// JSON data files (the same shapes the S3 deploy publishes), and runs the
// built-in poller so `npm start` is all you need locally.
//
// In production on AWS there is NO server — S3 serves the static site and a
// scheduled Lambda republishes the JSON. This file exists only for local dev
// and for running the collector on a plain always-on host.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { makeStore } from './store.js';
import { collectOnce } from './collector.js';
import { buildOutputs } from './engine.js';
import { publicConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const store = makeStore();
const app = express();

// Ensure the data/*.json the dashboard reads exist on boot (empty state is fine).
async function ensureOutputs() {
  const state = await store.load();
  const outputs = buildOutputs(state);
  outputs.config = { ...publicConfig(), generatedAt: Date.now() };
  await store.writeOutputs(outputs);
}

app.use(express.static(join(__dirname, '..', 'public')));

// Trigger a poll on demand (first data point / manual refresh).
app.post('/api/collect', async (_req, res) => {
  try {
    const { snap, result } = await collectOnce(store);
    res.json({ ok: true, fetchedAt: snap.fetchedAt, totals: snap.totals, result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

async function scheduledCollect() {
  try {
    const { snap, result } = await collectOnce(store);
    const t = snap.totals || {};
    console.log(
      `[poll ${new Date(snap.fetchedAt).toISOString()}] custOut=${t.custOut} ` +
        `outages=${t.outages} opened=${result.opened} updated=${result.updated} ` +
        `resolved=${result.resolved}`
    );
  } catch (err) {
    console.error('[poll] failed:', err.message);
  }
}

const intervalMs = Math.max(1, config.pollMinutes) * 60000;

async function main() {
  await ensureOutputs();

  if (process.env.NO_SCHEDULER !== '1') {
    const { status } = await import('./engine.js');
    const state = await store.load();
    const last = status(state).lastPollTs;
    if (!last || Date.now() - last >= intervalMs) scheduledCollect();
    setInterval(scheduledCollect, intervalMs).unref?.();
  }

  app.listen(config.port, () => {
    console.log(
      `power-tracker: dashboard on http://localhost:${config.port} ` +
        `(polling ${config.utilityName} every ${config.pollMinutes} min)`
    );
  });
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});

// Dashboard server: serves the static UI and a small JSON API, and runs the
// built-in poller on an interval so `npm start` is all you need.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { collectOnce } from './collector.js';
import {
  accuracySummary,
  status,
  currentOutages,
  timeseries,
  gradedEpisodes,
} from './analytics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();
const app = express();

app.use(express.static(join(__dirname, '..', 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    utilityName: config.utilityName,
    sourceUrl: config.sourceUrl,
    pollMinutes: config.pollMinutes,
    resolutionUncertaintyMinutes: config.resolutionUncertaintyMinutes,
  });
});

app.get('/api/status', (_req, res) => res.json(status(db)));

app.get('/api/current', (req, res) =>
  res.json(currentOutages(db, req_limit(req, 500)))
);

app.get('/api/accuracy', (req, res) => {
  const win = Number(req.query.window || 60);
  res.json(accuracySummary(db, { onTimeWindowMin: win }));
});

app.get('/api/episodes', (req, res) => {
  const limit = Number(req.query.limit || 500);
  res.json(gradedEpisodes(db).slice(0, limit));
});

app.get('/api/timeseries', (_req, res) => res.json(timeseries(db)));

// Trigger a poll on demand (useful for a first data point / testing).
app.post('/api/collect', async (_req, res) => {
  try {
    const { snap, result } = await collectOnce(db);
    res.json({ ok: true, fetchedAt: snap.fetchedAt, totals: snap.totals, result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

function req_limit(req, def) {
  const v = Number(req.query.limit);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Scheduler: poll immediately on boot (if it's been a while) then on interval.
async function scheduledCollect() {
  try {
    const { snap, result } = await collectOnce(db);
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
if (process.env.NO_SCHEDULER !== '1') {
  const last = status(db).lastPollTs;
  const due = !last || Date.now() - last >= intervalMs;
  if (due) scheduledCollect();
  setInterval(scheduledCollect, intervalMs).unref?.();
}

app.listen(config.port, () => {
  console.log(
    `power-tracker: dashboard on http://localhost:${config.port} ` +
      `(polling ${config.utilityName} every ${config.pollMinutes} min)`
  );
});

// SQLite storage + the episode model that turns raw poll snapshots into
// gradable "outage episodes".
//
// An EPISODE is one continuous stretch during which a given area (township)
// has customers out. It starts when the area first appears with cust_a > 0 and
// ends when the area drops out of the feed (or falls to 0). The same township
// can have many episodes over time (a new storm = a new episode), so we key
// tracking on (area_id + open episode), never on area_id alone.
//
// For each episode we keep the full ETR history, so we can grade the FINAL
// promised ETR against the actual restoration time and also study how much the
// utility revised its estimate along the way.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export function openDb(dbPath = config.dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at     INTEGER NOT NULL,      -- when we fetched (ms epoch)
      generated_at   INTEGER,               -- feed's own generation time
      interval_id    TEXT,
      page_mode      TEXT,
      total_cust_out INTEGER,
      total_cust_served INTEGER,
      total_outages  INTEGER,
      area_count     INTEGER
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      area_id        TEXT NOT NULL,
      name           TEXT,
      county         TEXT,
      state          TEXT,
      start_ts       INTEGER NOT NULL,      -- first poll seen out
      last_seen_ts   INTEGER NOT NULL,      -- last poll still out
      resolved_ts    INTEGER,               -- first poll seen gone (null = open)
      resolved       INTEGER NOT NULL DEFAULT 0,
      peak_cust_a    INTEGER NOT NULL DEFAULT 0,
      peak_n_out     INTEGER NOT NULL DEFAULT 0,
      first_etr      INTEGER,               -- first non-null ETR (ms)
      final_etr      INTEGER,               -- last non-null ETR while out (ms)
      had_etr        INTEGER NOT NULL DEFAULT 0,
      etr_revisions  INTEGER NOT NULL DEFAULT 0,
      samples        INTEGER NOT NULL DEFAULT 0,
      etr_history    TEXT NOT NULL DEFAULT '[]'  -- JSON: [{ts, etr}]
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_open ON episodes(area_id, resolved);
    CREATE INDEX IF NOT EXISTS idx_episodes_resolved ON episodes(resolved, resolved_ts);
    CREATE INDEX IF NOT EXISTS idx_polls_fetched ON polls(fetched_at);
  `);
}

// Ingest one snapshot: record the poll, then advance every episode.
// Returns a small summary of what changed, for logging.
export function ingestSnapshot(db, snap) {
  const tx = db.transaction(() => {
    const pollInfo = db
      .prepare(
        `INSERT INTO polls (fetched_at, generated_at, interval_id, page_mode,
            total_cust_out, total_cust_served, total_outages, area_count)
         VALUES (@fetchedAt, @generatedAt, @intervalId, @pageMode,
            @custOut, @custServed, @outages, @areaCount)`
      )
      .run({
        fetchedAt: snap.fetchedAt,
        generatedAt: snap.generatedAt,
        intervalId: snap.intervalId,
        pageMode: snap.pageMode,
        custOut: snap.totals?.custOut ?? null,
        custServed: snap.totals?.custServed ?? null,
        outages: snap.totals?.outages ?? null,
        areaCount: snap.areas.length,
      });

    const ts = snap.fetchedAt;

    // Active areas in this snapshot = leaf areas currently reporting outages.
    const active = new Map();
    for (const a of snap.areas) {
      if (a.custA > 0 || a.nOut > 0) active.set(a.areaId, a);
    }

    const openEpisodes = db
      .prepare(`SELECT * FROM episodes WHERE resolved = 0`)
      .all();
    const openByArea = new Map(openEpisodes.map((e) => [e.area_id, e]));

    let opened = 0;
    let updated = 0;
    let resolved = 0;

    // 1) Update or open episodes for currently-active areas.
    for (const [areaId, a] of active) {
      const ep = openByArea.get(areaId);
      if (ep) {
        applyObservation(db, ep, a, ts);
        updated++;
      } else {
        openEpisode(db, a, ts);
        opened++;
      }
    }

    // 2) Close episodes whose area is no longer active.
    for (const ep of openEpisodes) {
      if (!active.has(ep.area_id)) {
        closeEpisode(db, ep, ts);
        resolved++;
      }
    }

    return { pollId: pollInfo.lastInsertRowid, opened, updated, resolved, active: active.size };
  });
  return tx();
}

function openEpisode(db, a, ts) {
  const hasEtr = a.etr != null;
  const history = hasEtr ? [{ ts, etr: a.etr }] : [];
  db.prepare(
    `INSERT INTO episodes
       (area_id, name, county, state, start_ts, last_seen_ts, resolved,
        peak_cust_a, peak_n_out, first_etr, final_etr, had_etr, etr_revisions,
        samples, etr_history)
     VALUES
       (@areaId, @name, @county, @state, @ts, @ts, 0,
        @custA, @nOut, @etr, @etr, @hadEtr, 0,
        1, @history)`
  ).run({
    areaId: a.areaId,
    name: a.name,
    county: a.county,
    state: a.state,
    ts,
    custA: a.custA,
    nOut: a.nOut,
    etr: hasEtr ? a.etr : null,
    hadEtr: hasEtr ? 1 : 0,
    history: JSON.stringify(history),
  });
}

function applyObservation(db, ep, a, ts) {
  const history = JSON.parse(ep.etr_history || '[]');
  let firstEtr = ep.first_etr;
  let finalEtr = ep.final_etr;
  let hadEtr = ep.had_etr;
  let revisions = ep.etr_revisions;

  if (a.etr != null) {
    if (firstEtr == null) firstEtr = a.etr;
    // Count a revision whenever the promised ETR changes from the last known.
    if (finalEtr != null && a.etr !== finalEtr) revisions++;
    finalEtr = a.etr;
    hadEtr = 1;
    const last = history[history.length - 1];
    if (!last || last.etr !== a.etr) history.push({ ts, etr: a.etr });
  }

  db.prepare(
    `UPDATE episodes SET
        name = COALESCE(@name, name),
        county = COALESCE(@county, county),
        state = COALESCE(@state, state),
        last_seen_ts = @ts,
        peak_cust_a = MAX(peak_cust_a, @custA),
        peak_n_out = MAX(peak_n_out, @nOut),
        first_etr = @firstEtr,
        final_etr = @finalEtr,
        had_etr = @hadEtr,
        etr_revisions = @revisions,
        samples = samples + 1,
        etr_history = @history
      WHERE id = @id`
  ).run({
    id: ep.id,
    name: a.name,
    county: a.county,
    state: a.state,
    ts,
    custA: a.custA,
    nOut: a.nOut,
    firstEtr,
    finalEtr,
    hadEtr,
    revisions,
    history: JSON.stringify(history),
  });
}

function closeEpisode(db, ep, ts) {
  db.prepare(
    `UPDATE episodes SET resolved = 1, resolved_ts = @ts WHERE id = @id`
  ).run({ id: ep.id, ts });
}

// The estimated actual restoration time: outage was present at last_seen_ts and
// gone at resolved_ts, so it happened in between. Midpoint is the best point
// estimate; the half-interval is the uncertainty.
export function estimatedResolution(ep) {
  if (!ep.resolved || ep.resolved_ts == null) return null;
  return Math.round((ep.last_seen_ts + ep.resolved_ts) / 2);
}

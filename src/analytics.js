// Turns stored episodes into the accuracy numbers the dashboard shows.
//
// Sign convention for ETR error (minutes):
//   error = actual_restoration - promised_ETR
//     error > 0  -> restored LATER than promised (utility was too optimistic)
//     error < 0  -> restored EARLIER than promised (came back ahead of estimate)
//     error ~ 0  -> spot on
//
// We grade the FINAL promised ETR (the last estimate standing before the
// outage cleared), and separately report on the FIRST ETR and on how often the
// estimate was revised.

import { estimatedResolution } from './db.js';

const MIN = 60000;

export function gradedEpisodes(db) {
  const rows = db
    .prepare(
      `SELECT * FROM episodes
       WHERE resolved = 1 AND had_etr = 1 AND final_etr IS NOT NULL
       ORDER BY resolved_ts DESC`
    )
    .all();

  return rows.map((ep) => {
    const actual = estimatedResolution(ep);
    const finalErr = Math.round((actual - ep.final_etr) / MIN);
    const firstErr =
      ep.first_etr != null ? Math.round((actual - ep.first_etr) / MIN) : null;
    const durationMin = Math.round((actual - ep.start_ts) / MIN);
    // How far in advance the final promise was made, relative to the outage
    // start (a longer promised lead time is a harder forecast).
    const promisedLeadMin = Math.round((ep.final_etr - ep.start_ts) / MIN);
    return {
      id: ep.id,
      areaId: ep.area_id,
      name: ep.name,
      county: ep.county,
      state: ep.state,
      startTs: ep.start_ts,
      resolvedTs: ep.resolved_ts,
      actualResolution: actual,
      firstEtr: ep.first_etr,
      finalEtr: ep.final_etr,
      finalErrorMin: finalErr,
      firstErrorMin: firstErr,
      etrRevisions: ep.etr_revisions,
      peakCustA: ep.peak_cust_a,
      peakNOut: ep.peak_n_out,
      durationMin,
      promisedLeadMin,
    };
  });
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// Aggregate accuracy across graded episodes.
// onTimeWindowMin: an ETR "hit" is within +/- this many minutes.
export function accuracySummary(db, { onTimeWindowMin = 60 } = {}) {
  const eps = gradedEpisodes(db);
  const n = eps.length;

  const base = {
    gradedCount: n,
    onTimeWindowMin,
  };

  if (n === 0) {
    return {
      ...base,
      meanErrorMin: null,
      medianErrorMin: null,
      medianAbsErrorMin: null,
      p10ErrorMin: null,
      p90ErrorMin: null,
      onTimeRate: null,
      lateRate: null,
      earlyRate: null,
      lateShare: null,
      earlyShare: null,
      meanRevisions: null,
      totalCustomerEpisodes: 0,
      histogram: [],
      byCounty: [],
    };
  }

  const errors = eps.map((e) => e.finalErrorMin);
  const sorted = [...errors].sort((a, b) => a - b);
  const mean = errors.reduce((s, x) => s + x, 0) / n;
  const absSorted = errors.map((x) => Math.abs(x)).sort((a, b) => a - b);

  const late = eps.filter((e) => e.finalErrorMin > onTimeWindowMin);
  const early = eps.filter((e) => e.finalErrorMin < -onTimeWindowMin);
  const onTime = n - late.length - early.length;

  const revisionsMean =
    eps.reduce((s, e) => s + e.etrRevisions, 0) / n;

  return {
    ...base,
    meanErrorMin: round1(mean),
    medianErrorMin: round1(quantile(sorted, 0.5)),
    medianAbsErrorMin: round1(quantile(absSorted, 0.5)),
    p10ErrorMin: round1(quantile(sorted, 0.1)),
    p90ErrorMin: round1(quantile(sorted, 0.9)),
    onTimeRate: onTime / n,
    lateRate: late.length / n,
    earlyRate: early.length / n,
    lateShare: late.length / n,
    earlyShare: early.length / n,
    meanRevisions: round1(revisionsMean),
    totalCustomerEpisodes: eps.reduce((s, e) => s + (e.peakCustA || 0), 0),
    histogram: buildHistogram(errors),
    byCounty: byCounty(eps),
    scatter: eps.map((e) => ({
      promisedLeadMin: e.promisedLeadMin,
      errorMin: e.finalErrorMin,
      peakCustA: e.peakCustA,
      name: e.name,
      county: e.county,
    })),
  };
}

// Fixed, human-friendly buckets (hours). Signed so early/late is visible.
function buildHistogram(errors) {
  const edges = [
    -Infinity, -720, -360, -180, -60, 0, 60, 180, 360, 720, Infinity,
  ];
  const labels = [
    '> 12h early',
    '6–12h early',
    '3–6h early',
    '1–3h early',
    '<1h early',
    '<1h late',
    '1–3h late',
    '3–6h late',
    '6–12h late',
    '> 12h late',
  ];
  const counts = new Array(labels.length).fill(0);
  for (const e of errors) {
    for (let i = 0; i < labels.length; i++) {
      if (e >= edges[i] && e < edges[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

function byCounty(eps) {
  const groups = new Map();
  for (const e of eps) {
    const key = e.county || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.finalErrorMin);
  }
  const out = [];
  for (const [county, errs] of groups) {
    const s = [...errs].sort((a, b) => a - b);
    out.push({
      county,
      count: errs.length,
      medianErrorMin: round1(quantile(s, 0.5)),
      meanErrorMin: round1(errs.reduce((a, b) => a + b, 0) / errs.length),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

function round1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

// Collection status + the current outage picture.
export function status(db) {
  const pollAgg = db
    .prepare(
      `SELECT COUNT(*) c, MIN(fetched_at) first, MAX(fetched_at) last FROM polls`
    )
    .get();
  const latest = db
    .prepare(`SELECT * FROM polls ORDER BY fetched_at DESC LIMIT 1`)
    .get();
  const openCount = db
    .prepare(`SELECT COUNT(*) c FROM episodes WHERE resolved = 0`)
    .get().c;
  const resolvedCount = db
    .prepare(`SELECT COUNT(*) c FROM episodes WHERE resolved = 1`)
    .get().c;
  const gradedCount = db
    .prepare(
      `SELECT COUNT(*) c FROM episodes WHERE resolved = 1 AND had_etr = 1 AND final_etr IS NOT NULL`
    )
    .get().c;

  return {
    polls: pollAgg.c,
    firstPollTs: pollAgg.first,
    lastPollTs: pollAgg.last,
    openEpisodes: openCount,
    resolvedEpisodes: resolvedCount,
    gradedEpisodes: gradedCount,
    latest: latest
      ? {
          fetchedAt: latest.fetched_at,
          generatedAt: latest.generated_at,
          pageMode: latest.page_mode,
          totalCustOut: latest.total_cust_out,
          totalOutages: latest.total_outages,
          totalCustServed: latest.total_cust_served,
          areaCount: latest.area_count,
        }
      : null,
  };
}

export function currentOutages(db, limit = 500) {
  return db
    .prepare(
      `SELECT id, area_id, name, county, state, start_ts, last_seen_ts,
              peak_cust_a, peak_n_out, first_etr, final_etr, had_etr, etr_revisions, samples
       FROM episodes WHERE resolved = 0
       ORDER BY peak_cust_a DESC LIMIT ?`
    )
    .all(limit)
    .map((e) => ({
      id: e.id,
      areaId: e.area_id,
      name: e.name,
      county: e.county,
      state: e.state,
      startTs: e.start_ts,
      lastSeenTs: e.last_seen_ts,
      custOut: e.peak_cust_a,
      nOut: e.peak_n_out,
      firstEtr: e.first_etr,
      currentEtr: e.final_etr,
      hadEtr: !!e.had_etr,
      etrRevisions: e.etr_revisions,
      samples: e.samples,
    }));
}

export function timeseries(db, limit = 5000) {
  const rows = db
    .prepare(
      `SELECT fetched_at, total_cust_out, total_outages, page_mode
       FROM polls ORDER BY fetched_at ASC LIMIT ?`
    )
    .all(limit);
  return rows.map((r) => ({
    ts: r.fetched_at,
    custOut: r.total_cust_out,
    outages: r.total_outages,
    pageMode: r.page_mode,
  }));
}

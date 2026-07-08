// Storage-agnostic core: the episode model + accuracy math, operating on plain
// in-memory state so it can be persisted anywhere (a local JSON file for dev, an
// S3 object for the AWS Lambda deploy). No database, no native modules.
//
// state = {
//   seq:      number,            // episode id counter
//   polls:    Poll[],            // one row per collection
//   episodes: Episode[],         // open + resolved outage episodes
// }
//
// An EPISODE is one continuous stretch during which an area (township) has
// customers out: it opens when the area first appears out, records every ETR it
// is given, and closes when the area drops out of the feed. See README for the
// full methodology.

const MIN = 60000;

export function createState() {
  return { seq: 0, polls: [], episodes: [] };
}

// Fold one snapshot into the state. Mutates + returns a small change summary.
export function applySnapshot(state, snap) {
  state.polls.push({
    fetchedAt: snap.fetchedAt,
    generatedAt: snap.generatedAt ?? null,
    intervalId: snap.intervalId ?? null,
    pageMode: snap.pageMode ?? null,
    custOut: snap.totals?.custOut ?? null,
    custServed: snap.totals?.custServed ?? null,
    outages: snap.totals?.outages ?? null,
    areaCount: snap.areas.length,
  });

  const ts = snap.fetchedAt;

  const active = new Map();
  for (const a of snap.areas) {
    if (a.custA > 0 || a.nOut > 0) active.set(a.areaId, a);
  }

  const openByArea = new Map();
  for (const ep of state.episodes) {
    if (!ep.resolved) openByArea.set(ep.areaId, ep);
  }

  let opened = 0;
  let updated = 0;
  let resolved = 0;

  // Open/update episodes for currently-active areas.
  for (const [areaId, a] of active) {
    const ep = openByArea.get(areaId);
    if (ep) {
      applyObservation(ep, a, ts);
      updated++;
    } else {
      state.episodes.push(openEpisode(state, a, ts));
      opened++;
    }
  }

  // Close episodes whose area is no longer active.
  for (const ep of openByArea.values()) {
    if (!active.has(ep.areaId)) {
      ep.resolved = true;
      ep.resolvedTs = ts;
      resolved++;
    }
  }

  return { opened, updated, resolved, active: active.size };
}

function openEpisode(state, a, ts) {
  const hasEtr = a.etr != null;
  return {
    id: ++state.seq,
    areaId: a.areaId,
    name: a.name ?? null,
    county: a.county ?? null,
    state: a.state ?? null,
    startTs: ts,
    lastSeenTs: ts,
    resolvedTs: null,
    resolved: false,
    peakCustA: a.custA || 0,
    peakNOut: a.nOut || 0,
    firstEtr: hasEtr ? a.etr : null,
    finalEtr: hasEtr ? a.etr : null,
    hadEtr: hasEtr,
    etrRevisions: 0,
    samples: 1,
    etrHistory: hasEtr ? [{ ts, etr: a.etr }] : [],
  };
}

function applyObservation(ep, a, ts) {
  ep.lastSeenTs = ts;
  ep.samples++;
  ep.peakCustA = Math.max(ep.peakCustA, a.custA || 0);
  ep.peakNOut = Math.max(ep.peakNOut, a.nOut || 0);
  if (a.name) ep.name = a.name;
  if (a.county) ep.county = a.county;
  if (a.state) ep.state = a.state;

  if (a.etr != null) {
    if (ep.firstEtr == null) ep.firstEtr = a.etr;
    if (ep.finalEtr != null && a.etr !== ep.finalEtr) ep.etrRevisions++;
    ep.finalEtr = a.etr;
    ep.hadEtr = true;
    const last = ep.etrHistory[ep.etrHistory.length - 1];
    if (!last || last.etr !== a.etr) ep.etrHistory.push({ ts, etr: a.etr });
  }
}

// Best estimate of actual restoration: present at lastSeenTs, gone at
// resolvedTs, so midway between is the point estimate.
export function estimatedResolution(ep) {
  if (!ep.resolved || ep.resolvedTs == null) return null;
  return Math.round((ep.lastSeenTs + ep.resolvedTs) / 2);
}

// A snapshot whose summary claims customers out while the report lists zero
// affected areas is almost certainly a feed glitch (the two files are generated
// separately). Folding it in would mass-resolve every open episode with a bogus
// restoration time, permanently poisoning the accuracy stats — so the collector
// skips these and retries next cycle.
export function snapshotLooksSuspect(snap) {
  return Boolean(snap.totals && snap.totals.custOut > 0 && snap.areas.length === 0);
}

// ---------------- analytics ----------------

export function gradedEpisodes(state) {
  return state.episodes
    .filter((ep) => ep.resolved && ep.hadEtr && ep.finalEtr != null)
    .map((ep) => {
      const actual = estimatedResolution(ep);
      return {
        id: ep.id,
        areaId: ep.areaId,
        name: ep.name,
        county: ep.county,
        state: ep.state,
        startTs: ep.startTs,
        resolvedTs: ep.resolvedTs,
        actualResolution: actual,
        firstEtr: ep.firstEtr,
        finalEtr: ep.finalEtr,
        finalErrorMin: Math.round((actual - ep.finalEtr) / MIN),
        firstErrorMin:
          ep.firstEtr != null ? Math.round((actual - ep.firstEtr) / MIN) : null,
        // How long the episode went unobserved before it was found resolved.
        // The true restoration lies somewhere in this window, so a large gap
        // (collector downtime) means the error is too uncertain to grade.
        gapMin: Math.round((ep.resolvedTs - ep.lastSeenTs) / MIN),
        etrRevisions: ep.etrRevisions,
        peakCustA: ep.peakCustA,
        peakNOut: ep.peakNOut,
        durationMin: Math.round((actual - ep.startTs) / MIN),
        promisedLeadMin: Math.round((ep.finalEtr - ep.startTs) / MIN),
        firstLeadMin:
          ep.firstEtr != null ? Math.round((ep.firstEtr - ep.startTs) / MIN) : null,
      };
    })
    .sort((a, b) => b.resolvedTs - a.resolvedTs);
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Compute the window-dependent hit/late/early rates from an array of errors.
// Shared shape with the browser (which recomputes on the window selector).
export function windowRates(errors, onTimeWindowMin) {
  const n = errors.length;
  if (!n) return { onTimeRate: null, lateRate: null, earlyRate: null };
  const late = errors.filter((e) => e > onTimeWindowMin).length;
  const early = errors.filter((e) => e < -onTimeWindowMin).length;
  return {
    onTimeRate: (n - late - early) / n,
    lateRate: late / n,
    earlyRate: early / n,
  };
}

// Distribution stats over an array of signed error minutes.
function errorStats(errors) {
  const n = errors.length;
  if (!n) {
    return {
      meanErrorMin: null,
      medianErrorMin: null,
      medianAbsErrorMin: null,
      p10ErrorMin: null,
      p90ErrorMin: null,
    };
  }
  const sorted = [...errors].sort((a, b) => a - b);
  const absSorted = errors.map(Math.abs).sort((a, b) => a - b);
  return {
    meanErrorMin: round1(errors.reduce((s, x) => s + x, 0) / n),
    medianErrorMin: round1(quantile(sorted, 0.5)),
    medianAbsErrorMin: round1(quantile(absSorted, 0.5)),
    p10ErrorMin: round1(quantile(sorted, 0.1)),
    p90ErrorMin: round1(quantile(sorted, 0.9)),
  };
}

// Accuracy is graded on two bases:
//   final — the utility's last promise before restoration (their official word)
//   first — the promise customers originally planned around; a utility that
//           quietly revises ETRs at the last minute scores well on `final`
//           but poorly on `first`, which is exactly the gap worth surfacing.
// Episodes observed across a collection gap wider than maxGapMin are excluded
// (the actual restoration time is too uncertain to score fairly) and counted
// in excludedForGapCount.
export function accuracySummary(state, { onTimeWindowMin = 60, maxGapMin = Infinity } = {}) {
  const all = gradedEpisodes(state);
  const eps = all.filter((e) => e.gapMin <= maxGapMin);
  const n = eps.length;
  const base = {
    gradedCount: n,
    excludedForGapCount: all.length - n,
    onTimeWindowMin,
    maxGapMin: Number.isFinite(maxGapMin) ? maxGapMin : null,
  };
  if (n === 0) {
    return {
      ...base,
      final: errorStats([]),
      first: errorStats([]),
      onTimeRate: null,
      lateRate: null,
      earlyRate: null,
      meanRevisions: null,
      totalCustomerEpisodes: 0,
      byCounty: [],
      scatter: [],
    };
  }
  const finalErrors = eps.map((e) => e.finalErrorMin);
  const firstErrors = eps.map((e) => e.firstErrorMin).filter((e) => e != null);

  return {
    ...base,
    final: errorStats(finalErrors),
    first: errorStats(firstErrors),
    ...windowRates(finalErrors, onTimeWindowMin),
    meanRevisions: round1(eps.reduce((s, e) => s + e.etrRevisions, 0) / n),
    totalCustomerEpisodes: eps.reduce((s, e) => s + (e.peakCustA || 0), 0),
    byCounty: byCounty(eps),
    scatter: eps.map((e) => ({
      promisedLeadMin: e.promisedLeadMin,
      errorMin: e.finalErrorMin,
      firstLeadMin: e.firstLeadMin,
      firstErrorMin: e.firstErrorMin,
      peakCustA: e.peakCustA,
      name: e.name,
      county: e.county,
    })),
  };
}

function byCounty(eps) {
  const groups = new Map();
  for (const e of eps) {
    const key = e.county || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.entries()]
    .map(([county, group]) => {
      const finals = group.map((e) => e.finalErrorMin).sort((a, b) => a - b);
      const firsts = group
        .map((e) => e.firstErrorMin)
        .filter((e) => e != null)
        .sort((a, b) => a - b);
      return {
        county,
        count: group.length,
        medianErrorMin: round1(quantile(finals, 0.5)),
        meanErrorMin: round1(finals.reduce((a, b) => a + b, 0) / finals.length),
        medianFirstErrorMin: round1(quantile(firsts, 0.5)),
        meanFirstErrorMin: firsts.length
          ? round1(firsts.reduce((a, b) => a + b, 0) / firsts.length)
          : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

export function status(state) {
  const polls = state.polls;
  const latest = polls[polls.length - 1] || null;
  const open = state.episodes.filter((e) => !e.resolved);
  const resolved = state.episodes.filter((e) => e.resolved);
  const graded = resolved.filter((e) => e.hadEtr && e.finalEtr != null);
  return {
    polls: polls.length,
    firstPollTs: polls.length ? polls[0].fetchedAt : null,
    lastPollTs: latest ? latest.fetchedAt : null,
    openEpisodes: open.length,
    resolvedEpisodes: resolved.length,
    gradedEpisodes: graded.length,
    latest: latest
      ? {
          fetchedAt: latest.fetchedAt,
          generatedAt: latest.generatedAt,
          pageMode: latest.pageMode,
          totalCustOut: latest.custOut,
          totalOutages: latest.outages,
          totalCustServed: latest.custServed,
          areaCount: latest.areaCount,
        }
      : null,
  };
}

export function currentOutages(state, limit = 500) {
  return state.episodes
    .filter((e) => !e.resolved)
    .sort((a, b) => b.peakCustA - a.peakCustA)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      areaId: e.areaId,
      name: e.name,
      county: e.county,
      state: e.state,
      startTs: e.startTs,
      lastSeenTs: e.lastSeenTs,
      custOut: e.peakCustA,
      nOut: e.peakNOut,
      firstEtr: e.firstEtr,
      currentEtr: e.finalEtr,
      hadEtr: e.hadEtr,
      etrRevisions: e.etrRevisions,
      samples: e.samples,
    }));
}

export function timeseries(state, limit = 20000) {
  return state.polls.slice(-limit).map((r) => ({
    ts: r.fetchedAt,
    custOut: r.custOut,
    outages: r.outages,
    pageMode: r.pageMode,
  }));
}

// Build the full set of JSON documents the dashboard reads. In the AWS deploy
// these are written to S3 after every collection; locally the server serves the
// same shapes. Accuracy is emitted window-independent (with raw `errors` /
// `errorsFirst` arrays) so the client can recompute rates + the histogram for
// any on-time window and either grading basis without a server round-trip.
export function buildOutputs(state, { onTimeWindowMin = 60, maxGapMin = Infinity } = {}) {
  const acc = accuracySummary(state, { onTimeWindowMin, maxGapMin });
  return {
    status: status(state),
    current: currentOutages(state),
    timeseries: timeseries(state),
    accuracy: {
      ...acc,
      errors: acc.scatter.map((s) => s.errorMin),
      errorsFirst: acc.scatter.map((s) => s.firstErrorMin).filter((e) => e != null),
    },
  };
}

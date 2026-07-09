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

import { pointInPolygon, haversineM, decodePolyline } from './geo.js';

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

// Does a feed area match one of the configured home-area patterns?
// Patterns are upper-case names, optionally county-qualified as "COUNTY/NAME"
// (several NJ township names repeat across counties).
export function matchesHomeArea(name, county, patterns) {
  if (!patterns || !patterns.length || !name) return false;
  const n = String(name).toUpperCase();
  const q = `${String(county || '').toUpperCase()}/${n}`;
  return patterns.some((p) => p === n || p === q);
}

// ---------------- outage-level (geometric) episodes ----------------
//
// The feed's individual outages carry geometry but no stable identity: shapes
// merge, split, and get redrawn between polls. Naively keying on position
// would fabricate restorations at every merge, so this tracker is deliberately
// conservative:
//
//   - observations link across polls by geometric continuity (points within
//     matchRadiusM, or polygon containment either way);
//   - a CLEAN lifecycle (1 outage <-> 1 episode every poll, never absorbed
//     into or spawned from another shape) is graded like a township episode;
//   - any merge or split TAINTS the episodes involved — they are tracked but
//     excluded from grading and counted visibly, because after a reconcile
//     you cannot honestly say which promise belonged to which restoration;
//   - outages still clustered at max tile zoom keep nearby episodes alive but
//     taint them (their geometry is unresolvable that poll).

const CLUSTER_KEEPALIVE_M = 2500; // a z14 cluster centroid can sit >1 km from members
const GEO_EVENT_CAP = 5000;
const M_PER_DEG_LAT = 111195;

// Decode an item's rings once per poll; the O(n²) pair loop then only does
// cheap tests (latitude prefilter, bbox before point-in-polygon).
function prepGeom(point, geomA) {
  const rings = (geomA || []).map(decodePolyline);
  return {
    lat: point[0],
    lon: point[1],
    rings,
    bboxes: rings.map((ring) => {
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (const [la, lo] of ring) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
      return [minLat, minLon, maxLat, maxLon];
    }),
  };
}

function ringsContain(g, lat, lon) {
  for (let k = 0; k < g.rings.length; k++) {
    const [a, b, c, d] = g.bboxes[k];
    if (lat >= a && lat <= c && lon >= b && lon <= d && pointInPolygon(lat, lon, g.rings[k])) {
      return true;
    }
  }
  return false;
}

function outageLinks(a, b, matchRadiusM) {
  // Latitude difference alone lower-bounds the distance — rejects almost
  // every far pair before the trig.
  if (Math.abs(a.lat - b.lat) * M_PER_DEG_LAT <= matchRadiusM) {
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (d <= matchRadiusM) return d;
  }
  if (ringsContain(b, a.lat, a.lon)) return 0;
  if (ringsContain(a, b.lat, b.lon)) return 0;
  return null;
}

export function applyOutageGeometries(state, geo, ts, { matchRadiusM = 150 } = {}) {
  state.outageSeq ??= 0;
  state.outageEpisodes ??= [];
  const open = state.outageEpisodes.filter((e) => !e.resolved);
  const { outages, clusterPoints = [] } = geo;

  // Build the bipartite continuity graph.
  const epGeom = open.map((e) => prepGeom(e.point, e.geomA));
  const outGeom = outages.map((o) => prepGeom(o.point, o.geomA));
  const edges = [];
  const epEdges = open.map(() => []);
  const outEdges = outages.map(() => []);
  for (let i = 0; i < open.length; i++) {
    for (let j = 0; j < outages.length; j++) {
      const dist = outageLinks(epGeom[i], outGeom[j], matchRadiusM);
      if (dist != null) {
        const e = { i, j, dist };
        edges.push(e);
        epEdges[i].push(e);
        outEdges[j].push(e);
      }
    }
  }

  // Who continues as whom: a greedy nearest-first seed (biases matches toward
  // short edges), then Kuhn augmenting paths to reach MAXIMUM-cardinality
  // matching. The augmentation step matters for honesty: greedy alone can
  // strand an episode that a different pairing would have continued,
  // fabricating a merge out of assignment order. After augmentation, an
  // unmatched episode with edges is a real pigeonhole fact — that
  // neighborhood provably has fewer shapes than episodes.
  edges.sort((a, b) => a.dist - b.dist);
  const epAssigned = new Map(); // ep index -> outage index it continued as
  const outAssigned = new Map(); // outage index -> ep index that continued as it
  for (const e of edges) {
    if (epAssigned.has(e.i) || outAssigned.has(e.j)) continue;
    epAssigned.set(e.i, e.j);
    outAssigned.set(e.j, e.i);
  }
  const tryAugment = (i, visited) => {
    for (const e of epEdges[i]) {
      if (visited.has(e.j)) continue;
      visited.add(e.j);
      const holder = outAssigned.get(e.j);
      if (holder == null || tryAugment(holder, visited)) {
        epAssigned.set(i, e.j);
        outAssigned.set(e.j, i);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < open.length; i++) {
    if (!epAssigned.has(i) && epEdges[i].length) tryAugment(i, new Set());
  }
  for (const [i, j] of epAssigned) observeOutage(open[i], outages[j], ts);

  // The feed publishes no lineage (inc_id is nulled, entry ids are positional
  // and reassigned every regeneration), so this synthesized event log is the
  // only durable record of how shapes merged and split.
  state.geoStats ??= { merges: 0, splits: 0, ambiguous: 0 };
  state.geoStats.ambiguous ??= 0;
  state.geoEvents ??= [];
  const logEvent = (ev) => {
    state.geoEvents.push(ev);
    if (state.geoEvents.length > GEO_EVENT_CAP) {
      state.geoEvents.splice(0, state.geoEvents.length - GEO_EVENT_CAP);
    }
  };
  const taint = (ep, kind) => {
    if (ep.taint) return 0;
    ep.taint = kind;
    return 1;
  };
  let merged = 0;
  let split = 0;
  let ambiguous = 0;

  // Merges (absorptions): after maximum matching, an unmatched-but-linked
  // episode means its neighborhood provably has fewer shapes than episodes.
  // Physically that is either a real merge OR a restoration right next to a
  // surviving neighbor — indistinguishable without stable ids, which is
  // exactly why these are excluded from grading rather than interpreted.
  // Group losers by the shape that absorbed them so one event names the event.
  const absorbedSet = new Set();
  const absorbedByOutage = new Map();
  for (let i = 0; i < open.length; i++) {
    if (epAssigned.has(i) || epEdges[i].length === 0) continue;
    absorbedSet.add(i);
    const best = epEdges[i].reduce((a, b) => (a.dist <= b.dist ? a : b));
    if (!absorbedByOutage.has(best.j)) absorbedByOutage.set(best.j, []);
    absorbedByOutage.get(best.j).push(i);
  }
  for (const [j, loserIdxs] of absorbedByOutage) {
    const survivor = outAssigned.has(j) ? open[outAssigned.get(j)] : null;
    for (const i of loserIdxs) merged += taint(open[i], 'merged');
    if (survivor) merged += taint(survivor, 'merged');
    state.geoStats.merges++;
    logEvent({
      ts,
      type: 'merge',
      episodeIds: [...loserIdxs.map((i) => open[i].id), ...(survivor ? [survivor.id] : [])],
      survivorId: survivor?.id ?? null,
      at: outages[j].point,
    });
  }

  // Crossing ambiguity: an unassigned edge whose both endpoints continued —
  // two co-located lifecycles whose identities could silently swap. Tracked,
  // excluded from grading, but no lineage event (nothing actually reconciled).
  for (const e of edges) {
    if (epAssigned.get(e.i) === e.j) continue; // this edge IS the assignment
    if (!epAssigned.has(e.i) || !outAssigned.has(e.j)) continue; // merge/split territory
    ambiguous += taint(open[e.i], 'ambiguous');
    ambiguous += taint(open[outAssigned.get(e.j)], 'ambiguous');
  }
  state.geoStats.ambiguous += ambiguous;

  let opened = 0;
  let resolved = 0;
  let clustered = 0;

  for (let j = 0; j < outages.length; j++) {
    if (outAssigned.has(j)) continue;
    // Unassigned-but-linked outages are split children; standalone ones are new.
    const parents = outEdges[j].map((e) => open[e.i].id);
    const o = outages[j];
    const ep = {
      id: ++state.outageSeq,
      startTs: ts,
      lastSeenTs: ts,
      resolvedTs: null,
      resolved: false,
      samples: 0,
      peakCustA: 0,
      nOut: o.nOut || 1,
      firstEtr: null,
      finalEtr: null,
      etrRevisions: 0,
      taint: parents.length ? 'split' : null,
      point: o.point,
      geomA: [],
      cause: null,
    };
    observeOutage(ep, o, ts);
    state.outageEpisodes.push(ep);
    opened++;
    if (parents.length) {
      split++; // the child is born tainted
      for (const e of outEdges[j]) split += taint(open[e.i], 'split');
      state.geoStats.splits++;
      logEvent({ ts, type: 'split-child', childId: ep.id, parentIds: parents, at: o.point });
    }
  }

  for (let i = 0; i < open.length; i++) {
    if (epAssigned.has(i)) continue;
    const ep = open[i];
    // Near an unresolvable max-zoom cluster: keep alive but taint — we can
    // see "outages here", not which one this episode is. Absorbed episodes
    // are exempt: their lineage event already declared them ended, and an
    // episode the ledger calls merged must not linger open.
    if (!absorbedSet.has(i)) {
      const nearCluster = clusterPoints.some(
        ([clat, clon]) => haversineM(ep.point[0], ep.point[1], clat, clon) <= CLUSTER_KEEPALIVE_M
      );
      if (nearCluster) {
        ep.lastSeenTs = ts;
        ep.samples++;
        if (!ep.taint) ep.taint = 'clustered';
        clustered++;
        continue;
      }
    }
    ep.resolved = true;
    ep.resolvedTs = ts;
    ep.geomA = []; // matching geometry is dead weight once resolved
    resolved++;
  }

  return { opened, continued: epAssigned.size, resolved, merged, split, clustered, ambiguous };
}

function observeOutage(ep, o, ts) {
  ep.lastSeenTs = ts;
  ep.samples++;
  ep.peakCustA = Math.max(ep.peakCustA, o.custA || 0);
  ep.nOut = o.nOut || ep.nOut;
  ep.point = o.point;
  ep.geomA = o.geomA || [];
  if (o.cause) ep.cause = o.cause;
  if (o.etr != null) {
    if (ep.firstEtr == null) ep.firstEtr = o.etr;
    if (ep.finalEtr != null && o.etr !== ep.finalEtr) ep.etrRevisions++;
    ep.finalEtr = o.etr;
  }
}

// Accuracy over clean outage-level lifecycles. Same dual-basis shape as the
// township summary so the dashboard can reuse its renderer.
export function outageAccuracy(state, { onTimeWindowMin = 60, maxGapMin = Infinity } = {}) {
  const eps = state.outageEpisodes || [];
  const resolvedEps = eps.filter((e) => e.resolved);
  const tainted = resolvedEps.filter((e) => e.taint);
  const clean = resolvedEps.filter((e) => !e.taint);
  const noEtr = clean.filter((e) => e.finalEtr == null);
  const graded = clean
    .filter((e) => e.finalEtr != null)
    .map((e) => {
      const actual = Math.round((e.lastSeenTs + e.resolvedTs) / 2);
      return {
        finalErrorMin: Math.round((actual - e.finalEtr) / MIN),
        firstErrorMin:
          e.firstEtr != null ? Math.round((actual - e.firstEtr) / MIN) : null,
        gapMin: Math.round((e.resolvedTs - e.lastSeenTs) / MIN),
        promisedLeadMin: Math.round((e.finalEtr - e.startTs) / MIN),
        firstLeadMin:
          e.firstEtr != null ? Math.round((e.firstEtr - e.startTs) / MIN) : null,
        etrRevisions: e.etrRevisions,
        peakCustA: e.peakCustA,
        cause: e.cause,
      };
    });
  const inGap = graded.filter((e) => e.gapMin <= maxGapMin);
  const finalErrors = inGap.map((e) => e.finalErrorMin);
  const firstErrors = inGap.map((e) => e.firstErrorMin).filter((e) => e != null);
  return {
    trackedOpen: eps.filter((e) => !e.resolved).length,
    gradedCount: inGap.length,
    taintedCount: tainted.length,
    noEtrCount: noEtr.length,
    excludedForGapCount: graded.length - inGap.length,
    reconciliations: {
      merges: state.geoStats?.merges ?? 0,
      splits: state.geoStats?.splits ?? 0,
      ambiguous: state.geoStats?.ambiguous ?? 0,
      recent: (state.geoEvents ?? []).slice(-20),
    },
    onTimeWindowMin,
    final: errorStats(finalErrors),
    first: errorStats(firstErrors),
    ...windowRates(finalErrors, onTimeWindowMin),
    meanRevisions: inGap.length
      ? round1(inGap.reduce((s, e) => s + e.etrRevisions, 0) / inGap.length)
      : null,
    totalCustomerEpisodes: inGap.reduce((s, e) => s + (e.peakCustA || 0), 0),
    byCounty: [],
    scatter: inGap.map((e) => ({
      promisedLeadMin: e.promisedLeadMin,
      errorMin: e.finalErrorMin,
      firstLeadMin: e.firstLeadMin,
      firstErrorMin: e.firstErrorMin,
      peakCustA: e.peakCustA,
      name: e.cause,
      county: null,
    })),
  };
}

// ---------------- home (fixed-point) episodes ----------------
//
// Individual outages in the feed have no stable identity — their shapes merge,
// split, and get redrawn between polls, so tracking "an outage" over time would
// fabricate restorations at every merge. A fixed location avoids the identity
// problem completely: each poll asks "is this point covered by any outage
// geometry right now", and an episode is a continuous stretch of coverage.
// Merges and splits over the point simply keep it covered.
//
// `impact` comes from kubra.fetchHomeImpact; `areaEtr` is the home township's
// report-level ETR, used as the promised time when the covering outage itself
// carries none (blanket area estimates are published at that level).
export function applyHomeImpact(state, impact, ts, areaEtr = null) {
  if (!impact || !impact.checked) return null;
  state.homeSeq ??= 0;
  state.homeEpisodes ??= [];
  state.homeStats ??= { firstCheckTs: ts, checks: 0, covered: 0 };
  state.homeStats.checks++;
  if (impact.covered) state.homeStats.covered++;
  state.lastHomeCheck = {
    ts,
    covered: impact.covered,
    nearestM: impact.nearestM ?? null,
    radiusM: impact.radiusM ?? null,
    matches: impact.matches?.length ?? 0,
  };

  const open = state.homeEpisodes.find((e) => !e.resolved);

  if (!impact.covered) {
    if (open) {
      open.resolved = true;
      open.resolvedTs = ts;
    }
    return { covered: false, resolved: Boolean(open) };
  }

  const best =
    impact.matches.find((m) => m.kind === 'polygon') || impact.matches[0] || {};
  const etr = best.etr ?? areaEtr ?? null;
  const custA = impact.matches.reduce((s, m) => s + (m.custA || 0), 0);

  let ep = open;
  if (!ep) {
    ep = {
      id: ++state.homeSeq,
      startTs: ts,
      lastSeenTs: ts,
      resolvedTs: null,
      resolved: false,
      samples: 0,
      peakCustA: 0,
      firstEtr: null,
      finalEtr: null,
      etrRevisions: 0,
      etrHistory: [],
      etrSource: null,
    };
    state.homeEpisodes.push(ep);
  }
  ep.lastSeenTs = ts;
  ep.samples++;
  ep.peakCustA = Math.max(ep.peakCustA, custA);
  ep.lastKind = best.kind ?? null;
  ep.lastDistM = best.distM ?? null;
  ep.lastCause = best.cause ?? null;
  ep.lastCrewStatus = best.crewStatus ?? null;
  if (etr != null) {
    if (ep.firstEtr == null) ep.firstEtr = etr;
    if (ep.finalEtr != null && etr !== ep.finalEtr) ep.etrRevisions++;
    ep.finalEtr = etr;
    ep.etrSource = best.etr != null ? 'outage' : 'area';
    const last = ep.etrHistory[ep.etrHistory.length - 1];
    if (!last || last.etr !== etr) ep.etrHistory.push({ ts, etr });
  }
  return { covered: true, opened: !open };
}

// Home status + the dedicated history for the GIS-watched point: every home
// episode ever tracked (graded or not, ongoing or resolved) with its full
// promise trail, plus the monitoring ledger (how many checks, how many found
// the point covered). Home episodes are rare, so the full history stays small.
export function homeStatus(state, { maxGapMin = Infinity } = {}) {
  const eps = state.homeEpisodes || [];
  const open = eps.find((e) => !e.resolved) || null;
  const history = eps
    .map((e) => {
      const actual = e.resolved ? Math.round((e.lastSeenTs + e.resolvedTs) / 2) : null;
      const gapMin = e.resolved ? Math.round((e.resolvedTs - e.lastSeenTs) / MIN) : null;
      const graded = e.resolved && e.finalEtr != null && gapMin <= maxGapMin;
      return {
        id: e.id,
        startTs: e.startTs,
        resolvedTs: e.resolvedTs,
        resolved: e.resolved,
        durationMin: actual != null ? Math.round((actual - e.startTs) / MIN) : null,
        peakCustA: e.peakCustA,
        firstEtr: e.firstEtr,
        finalEtr: e.finalEtr,
        finalErrorMin: graded ? Math.round((actual - e.finalEtr) / MIN) : null,
        firstErrorMin:
          graded && e.firstEtr != null ? Math.round((actual - e.firstEtr) / MIN) : null,
        etrRevisions: e.etrRevisions,
        etrSource: e.etrSource,
        etrHistory: e.etrHistory || [],
        kind: e.lastKind ?? null,
        distM: e.lastDistM ?? null,
        cause: e.lastCause ?? null,
        gapMin,
        graded,
      };
    })
    .sort((a, b) => b.startTs - a.startTs);
  const graded = history.filter((e) => e.graded);
  const finals = graded.map((e) => e.finalErrorMin).sort((a, b) => a - b);
  return {
    enabled: Boolean(state.lastHomeCheck),
    lastCheck: state.lastHomeCheck ?? null,
    monitoring: state.homeStats
      ? {
          since: state.homeStats.firstCheckTs,
          checks: state.homeStats.checks,
          coveredChecks: state.homeStats.covered,
        }
      : null,
    current: open
      ? {
          startTs: open.startTs,
          lastSeenTs: open.lastSeenTs,
          custA: open.peakCustA,
          etr: open.finalEtr,
          etrSource: open.etrSource,
          etrRevisions: open.etrRevisions,
          kind: open.lastKind,
          distM: open.lastDistM,
          cause: open.lastCause,
          crewStatus: open.lastCrewStatus,
        }
      : null,
    episodes: eps.length,
    gradedCount: graded.length,
    medianFinalErrorMin: finals.length ? round1(quantile(finals, 0.5)) : null,
    history,
  };
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
  const out = outageAccuracy(state, { onTimeWindowMin, maxGapMin });
  return {
    status: status(state),
    current: currentOutages(state),
    timeseries: timeseries(state),
    home: homeStatus(state, { maxGapMin }),
    accuracy: {
      ...acc,
      errors: acc.scatter.map((s) => s.errorMin),
      errorsFirst: acc.scatter.map((s) => s.firstErrorMin).filter((e) => e != null),
      outages: {
        ...out,
        errors: out.scatter.map((s) => s.errorMin),
        errorsFirst: out.scatter.map((s) => s.firstErrorMin).filter((e) => e != null),
      },
    },
  };
}

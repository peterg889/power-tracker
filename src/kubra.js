// Client for the KUBRA StormCenter outage feed that powers FirstEnergy's
// outage maps. The public data flow is:
//
//   1. currentState  -> the current per-update data directory
//                       (interval_generation_data) + the config deployment id
//   2. configuration -> the file names ("source") of the summary + area report
//   3. summary       -> system-wide totals (customers out, # outages)
//   4. report        -> hierarchical state/county/township areas, each with an
//                       ETR (estimated restoration time) and customers affected
//
// The report's township-level ETR is the unit we grade for accuracy.

import { config } from './config.js';

// Route through the agent proxy when present (remote/dev sandboxes set
// HTTPS_PROXY). On a normal machine no proxy env is set and this is a no-op,
// so the same code works locally and in the sandbox.
let dispatcherReady = false;
async function ensureDispatcher() {
  if (dispatcherReady) return;
  dispatcherReady = true;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
}

async function getJson(url) {
  await ensureDispatcher();
  const res = await fetch(url, {
    headers: { accept: 'application/json,*/*' },
    // The feed is a CDN in front of S3; a modest timeout avoids hanging polls.
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

function apiBase() {
  return `${config.host}/stormcenter/api/v1/stormcenters/${config.instanceId}/views/${config.viewId}`;
}

// Step 1: discover the current data directory and config deployment.
async function fetchCurrentState() {
  const url = `${apiBase()}/currentState?preview=false`;
  const state = await getJson(url);
  const intervalPath = state?.data?.interval_generation_data;
  const deploymentId = state?.stormcenterDeploymentId;
  if (!intervalPath || !deploymentId) {
    throw new Error('currentState missing interval_generation_data or stormcenterDeploymentId');
  }
  return {
    intervalPath,
    deploymentId,
    updatedAt: state?.updatedAt ?? null,
  };
}

// Step 2: resolve the summary + report file names from the config deployment.
// Config rarely changes, so we cache it keyed by deployment id.
const configCache = new Map();
async function fetchSourcePaths(deploymentId) {
  if (configCache.has(deploymentId)) return configCache.get(deploymentId);
  const url = `${apiBase()}/configuration/${deploymentId}?preview=false`;
  const cfg = await getJson(url);

  const summarySource = cfg?.config?.summary?.data?.interval_generation_data?.source;
  const reportDefs = cfg?.config?.reports?.data?.interval_generation_data;
  const reportSources = Array.isArray(reportDefs)
    ? reportDefs.map((r) => r?.source).filter(Boolean)
    : [];

  if (!summarySource && reportSources.length === 0) {
    throw new Error('configuration missing summary/report source paths');
  }
  const result = { summarySource, reportSources };
  configCache.set(deploymentId, result);
  return result;
}

// Recursively collect leaf areas (the deepest level, typically township /
// municipality) from the nested report structure. Leaf = an area node that
// has no child `areas` array.
export function collectLeafAreas(node, acc) {
  if (!node || typeof node !== 'object') return;
  const children = node.areas;
  if (Array.isArray(children) && children.length > 0) {
    for (const child of children) collectLeafAreas(child, acc);
    return;
  }
  // Leaf node describing a specific area with outages.
  if (node.areaId) {
    const etrRaw = node.etr ?? null;
    const etrMs = parseEtr(etrRaw);
    acc.push({
      areaId: String(node.areaId),
      name: node.name ?? null,
      county: node.county ?? null,
      state: node.state ?? null,
      custA: numberOrZero(node?.cust_a?.val),
      custS: numberOrZero(node?.cust_s),
      percentA: node?.percent_cust_a?.val ?? null,
      nOut: numberOrZero(node?.n_out),
      etr: etrMs, // ms epoch or null
      etrRaw, // original string, for debugging/inspection
      etrConfidence: node.etr_confidence ?? null,
    });
  }
}

// The feed uses ISO-8601 for real ETRs, but can also emit sentinel strings
// like "Assessing" / "TBD" during storm assessment. Those parse to null so
// they don't corrupt the accuracy math (an area with no real ETR is tracked
// but excluded from grading).
export function parseEtr(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function numberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Fetch one complete snapshot of the outage feed.
export async function fetchSnapshot() {
  const { intervalPath, deploymentId, updatedAt } = await fetchCurrentState();
  const { summarySource, reportSources } = await fetchSourcePaths(deploymentId);

  let totals = null;
  let generatedAt = null;
  let pageMode = null;
  if (summarySource) {
    const summary = await getJson(`${config.host}/${intervalPath}/${summarySource}`);
    const t = summary?.summaryFileData?.totals?.[0] ?? {};
    totals = {
      custOut: numberOrZero(t?.total_cust_a?.val),
      custServed: numberOrZero(t?.total_cust_s),
      outages: numberOrZero(t?.total_outages),
      percentOut: t?.total_percent_cust_a?.val ?? null,
    };
    generatedAt = parseEtr(summary?.summaryFileData?.date_generated);
    pageMode = summary?.summaryFileData?.page_mode?.mode ?? null;
  }

  const areas = [];
  for (const src of reportSources) {
    const report = await getJson(`${config.host}/${intervalPath}/${src}`);
    collectLeafAreas(report?.file_data, areas);
  }

  // De-duplicate areas by areaId (a report can list the same leaf under
  // multiple parents in rare configs); keep the one with more customers out.
  const byId = new Map();
  for (const a of areas) {
    const prev = byId.get(a.areaId);
    if (!prev || a.custA > prev.custA) byId.set(a.areaId, a);
  }

  return {
    fetchedAt: Date.now(),
    generatedAt,
    intervalId: intervalPath,
    updatedAt,
    pageMode,
    totals,
    areas: [...byId.values()],
  };
}

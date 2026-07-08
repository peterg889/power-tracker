// Configuration for the JCP&L / FirstEnergy (KUBRA StormCenter) outage feed.
//
// These IDs come from the bootstrap config embedded in the outage map page:
//   https://outages-nj.firstenergycorp.com/  ->  var BOOTSTRAP_CONFIG = {...}
// They are stable for a given utility view. The per-update data path
// (interval_generation_data) changes on every refresh and is discovered at
// runtime via the currentState endpoint, so it is NOT hardcoded here.
//
// Any value can be overridden with an environment variable, which makes it
// easy to point this tracker at a different FirstEnergy operating company
// (Met-Ed, Penelec, West Penn, Ohio Edison, etc.) without code changes.

export const config = {
  // KUBRA host that serves both the API and the data bucket.
  host: process.env.KUBRA_HOST || 'https://kubra.io',

  // Identifies the utility's StormCenter deployment.
  instanceId: process.env.KUBRA_INSTANCE_ID || '6c715f0e-bbec-465f-98cc-0b81623744be',
  viewId: process.env.KUBRA_VIEW_ID || 'fcd7c23d-de37-4471-8ca3-37c3260f94fa',

  // Human-readable label for the utility being tracked (UI only).
  utilityName: process.env.UTILITY_NAME || 'JCP&L (FirstEnergy New Jersey)',
  sourceUrl: process.env.SOURCE_URL || 'https://outages-nj.firstenergycorp.com/',

  // How often the built-in scheduler polls the feed, in minutes.
  // The public feed typically regenerates every few minutes; 15 min keeps a
  // good resolution/volume balance for multi-week collection.
  pollMinutes: Number(process.env.POLL_MINUTES || 15),

  // HTTP port for the dashboard/server.
  port: Number(process.env.PORT || 3000),

  // An outage "episode" for an area ends when the area drops out of the feed
  // (or falls to 0 customers affected). Because we only see the feed at poll
  // time, actual restoration happened somewhere between the last poll it was
  // present and the first poll it was gone; we estimate it at the midpoint.
  // This is the timing uncertainty band, in minutes, surfaced in the UI.
  get resolutionUncertaintyMinutes() {
    return this.pollMinutes;
  },

  // If the collector was down and an episode resolved during the gap, the
  // actual restoration time is only known to within that whole gap. Episodes
  // whose unobserved window exceeds this are excluded from grading (but
  // counted, so the exclusion itself is visible). Default: 3 poll intervals.
  get maxGapMinutes() {
    return Number(process.env.MAX_GAP_MINUTES || this.pollMinutes * 3);
  },

  // "Home watch": GIS test of the feed's outage geometry (polygons + point
  // markers) against one fixed location each poll. The coordinates are
  // intentionally env-only — set them as CI secrets, never in this file: the
  // repo and dashboard are public, and the published home.json only carries
  // covered/clear status and distances, not the location itself.
  homeLat: process.env.HOME_LAT ? Number(process.env.HOME_LAT) : null,
  homeLon: process.env.HOME_LON ? Number(process.env.HOME_LON) : null,
  // A point outage (no polygon) this close is treated as affecting home.
  homeRadiusM: Number(process.env.HOME_RADIUS_M || 250),
  homeLabel: process.env.HOME_LABEL || 'Home',
  // Township-level fallback + row highlighting: feed area names, optionally
  // county-qualified as "COUNTY/NAME" (duplicate township names exist across
  // NJ counties). Township granularity only — never a street address.
  homeAreas: (process.env.HOME_AREAS || 'MORRIS/MENDHAM TOWNSHIP')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  get homeConfigured() {
    return Number.isFinite(this.homeLat) && Number.isFinite(this.homeLon);
  },

  // Service-territory bounding box for the geometry tile walk
  // (minLat,minLon,maxLat,maxLon). Default covers JCP&L's New Jersey area.
  territoryBbox: (process.env.TERRITORY_BBOX || '39.2,-75.7,41.4,-73.85')
    .split(',')
    .map(Number),

  // Two outage observations this close (meters) are treated as the same
  // physical outage across polls. Used by the geometric (outage-level)
  // tracker; polygon containment also links observations.
  matchRadiusM: Number(process.env.MATCH_RADIUS_M || 150),
};

// The subset of config exposed to the browser dashboard.
export function publicConfig() {
  return {
    utilityName: config.utilityName,
    sourceUrl: config.sourceUrl,
    pollMinutes: config.pollMinutes,
    resolutionUncertaintyMinutes: config.resolutionUncertaintyMinutes,
    maxGapMinutes: config.maxGapMinutes,
    homeConfigured: config.homeConfigured,
    homeLabel: config.homeLabel,
    homeRadiusM: config.homeRadiusM,
    homeAreas: config.homeAreas,
  };
}

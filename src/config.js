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

  // SQLite database location.
  dbPath: process.env.DB_PATH || new URL('../data/outages.db', import.meta.url).pathname,

  // An outage "episode" for an area ends when the area drops out of the feed
  // (or falls to 0 customers affected). Because we only see the feed at poll
  // time, actual restoration happened somewhere between the last poll it was
  // present and the first poll it was gone; we estimate it at the midpoint.
  // This is the timing uncertainty band, in minutes, surfaced in the UI.
  get resolutionUncertaintyMinutes() {
    return this.pollMinutes;
  },
};

# JCP&L ETR Accuracy Tracker

A web app that watches the **JCP&L / FirstEnergy** outage map and grades how
accurate the utility's **Estimated Restoration Times (ETRs)** turn out to be —
in aggregate.

When your power goes out, JCP&L publishes a restoration estimate. This tool
records that estimate over time, notices when each outage actually clears, and
compares the **last promised ETR** against the **actual restoration time**
across every outage it has seen. The result is a running scorecard: are their
estimates optimistic, pessimistic, or on the money?

Source feed: <https://outages-nj.firstenergycorp.com/>

![dashboard](docs/dashboard.png)

## How it works

The FirstEnergy outage map is powered by KUBRA's StormCenter platform, which
serves outage data as public JSON. Each poll, the collector walks this chain:

1. **currentState** → the current per-update data directory
2. **configuration** → the summary + area-report file names
3. **summary** → system-wide totals (customers out, number of outages)
4. **report** → a state → county → **township** hierarchy where every township
   carries a `cust_a` (customers affected), `n_out`, and — crucially — an
   **`etr`** (estimated restoration time)

The township ETR is the unit we grade.

### From snapshots to a scorecard

Each township outage is tracked as an **episode**: a continuous stretch during
which that township has customers out. An episode:

- **opens** when the township first appears in the feed with customers out,
- **records** every ETR it's given (including revisions), and
- **closes** when the township drops out of the feed (power restored).

Because we only see the feed at poll time, the true restoration happened
somewhere between the last poll the outage was present and the first poll it
was gone. We estimate it at the **midpoint**, and surface the half-interval
(`± poll interval`) as the timing uncertainty.

For each closed episode with an ETR on record:

```
error = actual_restoration − final_promised_ETR
  error > 0  → restored LATER than promised   (estimate was optimistic)
  error < 0  → restored EARLIER than promised  (beat the estimate)
```

The dashboard aggregates these into a median/mean error, an on-time rate
(within an adjustable ± window), an early/late split, an error-distribution
histogram, a promised-lead-time-vs-error scatter, and a per-county breakdown.
The same township can have many episodes over time (a new storm = a new
episode), so re-outages never get confused with the original.

## Quick start

```bash
npm install
npm start          # dashboard on http://localhost:3000, polls every 15 min
```

The server polls on boot and then every `POLL_MINUTES`. Accuracy numbers appear
once outages start resolving — a single snapshot only shows the current
picture, so **leave it running** (through a storm and its recovery is ideal).

Collect a single snapshot without the server (for cron-style setups):

```bash
npm run collect
```

### See it fully populated (synthetic demo)

Accuracy needs resolved outages, which takes time to accumulate. To preview the
full dashboard immediately with a **fabricated** storm:

```bash
npm run demo
NO_SCHEDULER=1 npm start     # NO_SCHEDULER keeps the demo data (no live poll)
```

> The demo numbers are invented to exercise the UI — they are **not** real
> utility performance. Delete `data/state.json` and run live to collect real data.

## Deploy to AWS (serverless, S3-hosted)

The natural home for this is fully serverless on AWS — no server to keep alive,
pennies per month:

```
EventBridge (every 15 min) → Lambda collector → S3
                                                 ├─ (private) state/state.json   running state
                                                 └─ (public)  data/*.json        dashboard feed
S3 static site  ─ CloudFront (HTTPS) ─→  the dashboard, which just reads data/*.json
```

There is no API server and no database: the Lambda folds each poll into a JSON
state object in a **private** bucket and republishes the precomputed dashboard
JSON to a **public** site bucket that CloudFront serves over HTTPS. The browser
reads those static files directly.

**Prerequisites:** the [AWS CLI](https://docs.aws.amazon.com/cli/) and
[AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
with credentials configured for your account (`aws configure`).

```bash
./infra/deploy.sh          # STACK=my-name AWS_REGION=us-east-1 to customize
```

That single command creates the buckets, Lambda, 15-minute schedule, and
CloudFront distribution; uploads the dashboard; seeds the first data point; and
prints the HTTPS URL. Everything is defined in `infra/template.yaml` (AWS SAM);
the Lambda is a pure-JS zip (no native modules, no `node_modules` — global
`fetch` and the runtime-provided AWS SDK are all it needs). Tear down with
`sam delete --stack-name <name>` (empty the buckets first).

Other hosting options (Railway/Render/Fly for the always-on server, or Vercel +
a hosted DB + external cron) also work, but the AWS/S3 path above is the
recommended one.

## Configuration

All via environment variables (see `src/config.js`):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Dashboard port (local server) |
| `POLL_MINUTES` | `15` | Poll interval (also the resolution-timing uncertainty) |
| `STATE_PATH` | `data/state.json` | Local state file |
| `S3_BUCKET` | — | If set, use S3 for the data feed instead of local files (enables the AWS path) |
| `S3_STATE_BUCKET` | = `S3_BUCKET` | Private bucket for running state |
| `NO_SCHEDULER` | — | Set to `1` to disable the built-in poller |
| `KUBRA_INSTANCE_ID` / `KUBRA_VIEW_ID` | JCP&L's | Point at another FirstEnergy operating company |
| `UTILITY_NAME` / `SOURCE_URL` | JCP&L | UI labels |

Because the utility identifiers are just config, the same app can track
Met-Ed, Penelec, West Penn, Ohio Edison, etc. — grab their `instanceId` /
`viewId` from that map's page source (`var BOOTSTRAP_CONFIG`).

## Data feed

The dashboard reads these static JSON documents (published locally under
`public/data/`, in production to `s3://<site-bucket>/data/`):

| File | Contents |
| --- | --- |
| `config.json` | Utility labels + poll interval |
| `status.json` | Collection status + latest snapshot totals |
| `current.json` | Currently-open outages |
| `accuracy.json` | Aggregate accuracy + a raw `errors` array (the on-time window is applied in the browser) |
| `timeseries.json` | Customers-out over the collection window |

The local dev server additionally exposes `POST /api/collect` to trigger a poll
on demand.

## Methodology notes & caveats

- **Granularity is township-level**, matching what the public feed exposes.
  This is the right altitude for an *aggregate* accuracy question.
- **Timing uncertainty** equals the poll interval; tighten `POLL_MINUTES` for
  sharper resolution timestamps (at the cost of more requests).
- Outages that **never carry an ETR** (e.g. during active storm assessment) are
  tracked but excluded from grading — you can't grade an estimate that was
  never made. They're still counted so you can see how often that happens.
- During major events the feed may switch to a **STORM** page mode and suppress
  or coarsen ETRs; the current page mode is shown in the header.
- This is an independent tool built on public data. **Not affiliated with,
  endorsed by, or connected to JCP&L or FirstEnergy.**

## Development

```bash
npm test           # verifies the episode lifecycle + accuracy math
```

## Layout

```
src/
  config.js      utility IDs + tunables (env-overridable)
  kubra.js       KUBRA StormCenter feed client
  engine.js      pure episode model + accuracy math (storage-agnostic core)
  store.js       persistence: local files (dev) or S3 (prod)
  collector.js   one poll → state + published JSON (CLI + importable)
  server.js      local dev server: static dashboard + built-in scheduler
  lambda.js      AWS Lambda handler for the scheduled collector
  seed-demo.js   synthetic storm for previewing the UI
public/          dashboard (vanilla JS + hand-rolled SVG charts, no CDN)
infra/           AWS SAM template + deploy scripts (S3 + Lambda + CloudFront)
test/            accuracy + episode tests
```

The core (`engine.js`) is a pure function library over plain state, so the same
tested logic runs behind the local file store and the S3-backed Lambda.

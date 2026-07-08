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
error = actual_restoration − promised_ETR
  error > 0  → restored LATER than promised   (estimate was optimistic)
  error < 0  → restored EARLIER than promised  (beat the estimate)
```

Accuracy is graded on **two bases**, switchable in the dashboard:

- **final promise** — the last ETR published before restoration (the utility's
  official last word), and
- **first promise** — the ETR customers originally planned around. A utility
  that quietly revises its estimate just before the lights come back scores
  well on the final promise but poorly on the first one; the gap between the
  two is exactly the honesty signal this tool exists to surface.

The dashboard aggregates these into a median/mean error, an on-time rate
(within an adjustable ± window), an early/late split, an error-distribution
histogram, a promised-lead-time-vs-error scatter, and a per-county breakdown.
The same township can have many episodes over time (a new storm = a new
episode), so re-outages never get confused with the original.

### Individual outages: geometry, and why merges get excluded

Beyond the township report, the map's geometry layer exposes each individual
outage as a shape (a marker point, often an affected-area polygon) in public
quadkey-addressed cluster tiles. Each poll, the collector walks that tile
pyramid (~20–60 requests in calm weather) and tracks **outage-level episodes
by geometric continuity**: an observation continues an episode when it sits
within `MATCH_RADIUS_M` (default 150 m) of it, or when either one's polygon
contains the other's point.

The catch — and the reason a naive version of this would lie — is that these
shapes carry **no stable identity** (`inc_id` is null) and visibly **merge,
split, and reconcile** between polls. Treating a merge as "one outage ended"
would fabricate on-time restorations wholesale. So the tracker is
deliberately conservative:

- a **clean lifecycle** (one shape ↔ one episode at every poll) is graded
  exactly like a township episode, on both promise bases;
- any episode touched by a **merge or split is tainted**: still tracked, but
  excluded from grading and **counted visibly** on the dashboard — after a
  reconcile you cannot honestly say which promise belonged to which
  restoration;
- outages still clustered together at max tile zoom keep nearby episodes
  alive but taint them (their geometry is unresolvable that poll).

The dashboard's **scope** selector switches the accuracy panel between
township grading and clean-outage grading. Township numbers answer "is the
promise on the public map honest for my town"; outage-level numbers answer
"is each individual promise honest" — with the merge churn quantified instead
of silently absorbed.

### Home watch (optional GIS point test)

Set `HOME_LAT` / `HOME_LON` (as CI secrets — never commit coordinates; the
repo and dashboard are public) and every poll also tests whether any outage
geometry covers that fixed point: polygon containment, or a marker within
`HOME_RADIUS_M` (default 250 m). The dashboard then shows a home banner with
live status, the promised restoration (outage-specific, or the township-wide
estimate when the outage carries none), and a home-specific track record.

A fixed point is immune to the merge problem by construction: the question
"is this location covered right now" needs no outage identity, so home
episodes are defined purely by coverage continuity. The published `home.json`
carries status and distances only — not the location.

Two guardrails keep the scorecard itself honest:

- **Suspect snapshots are rejected.** If the feed's summary claims customers
  out while its report lists zero affected areas (the two files are generated
  separately and can glitch independently), the poll is skipped rather than
  mass-resolving every open episode with a bogus timestamp.
- **Episodes resolved across a collection gap are excluded.** If the collector
  was down and an outage cleared during the gap, the actual restoration time is
  only known to within that whole gap — too uncertain to score fairly. Such
  episodes are excluded from grading beyond `MAX_GAP_MINUTES` (default 3 poll
  intervals) and the exclusion count is shown on the dashboard.

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

## Deploy

Two supported paths, lightest first.

### Option 1 — GitHub only (recommended, $0, no cloud account)

Everything runs inside GitHub: an Actions workflow polls the feed on a cron,
the running state lives as commits on an orphan **`data` branch**, and the
dashboard (plus its JSON feed) publishes to **GitHub Pages**:

```
GitHub Actions (cron, ~15 min) → collector
        ├─ state.json  → committed to the `data` branch  (git history = audit log)
        └─ data/*.json → public/ → GitHub Pages (the static dashboard)
```

Setup (one time):

1. Push the repo to GitHub, **public** (public repos get unlimited free Actions
   minutes; a private repo would burn ~4,000 min/month against the 2,000 free —
   stretch `POLL_MINUTES` to 30–60 if you must stay private).
2. Repo **Settings → Pages → Source: "GitHub Actions"**.
3. Actions tab → **collect** → *Run workflow* (or wait for the next cron tick).
4. Dashboard appears at `https://<user>.github.io/<repo>/`.

Why this fits this project unusually well: every poll is a timestamped commit,
so the collected dataset is a **public, tamper-evident audit log** — anyone can
verify the numbers weren't massaged after the fact. Failure alerting is free
too: GitHub emails the workflow author when a scheduled run fails (including
polls rejected by the suspect-snapshot guard).

Caveats: GitHub cron is best-effort — runs can drift by minutes and are
occasionally skipped under load. The tracker is built for that (real fetch
timestamps, and the collection-gap exclusion keeps late polls from distorting
grades). The `data` branch accrues ~96 small commits/day; if it ever bothers
you, squash it — the dashboard only reads the latest state.

### Option 2 — AWS serverless (S3 + Lambda + CloudFront)

The heavier-duty path: precise scheduling, CDN hosting, CloudWatch alarms —
no server to keep alive, roughly $1–2/month:

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
ALERT_EMAIL=you@example.com ./infra/deploy.sh   # + email alerts if collection breaks
```

That single command creates the buckets, Lambda, 15-minute schedule, and
CloudFront distribution; uploads the dashboard; seeds the first data point; and
prints the HTTPS URL. Everything is defined in `infra/template.yaml` (AWS SAM);
the Lambda is a pure-JS zip (no native modules, no `node_modules` — global
`fetch` and the runtime-provided AWS SDK are all it needs). Tear down with
`sam delete --stack-name <name>` (empty the buckets first).

Operational safety nets built into the stack:

- **CloudWatch alarms** fire when the collector errors repeatedly or stops
  running for an hour (data gaps weaken the accuracy stats — see the gap
  exclusion above). Set `ALERT_EMAIL` to get notified via SNS; remember to
  confirm the subscription email.
- **The state bucket is versioned** (30-day noncurrent expiry), so one corrupt
  write of `state.json` — the entire collected history lives in that single
  object — can be rolled back.
- Redeploys invalidate the CloudFront cache for the static assets, so dashboard
  updates show up immediately.

### Other hosting options (not built out)

- **Vercel**: free Hobby cron jobs only run **once per day** (with hour-level
  timing), so a 15-minute poll needs an external trigger (e.g. a GitHub Actions
  cron hitting a secret-protected `/api/collect` route) plus Vercel Blob for
  state — two platforms and a storage adapter for what Option 1 does with one.
  Native frequent cron requires the Pro plan.
- **Cloudflare Workers**: free Cron Triggers at any frequency + KV for state +
  Pages for the site — a genuinely good single-platform fit, but it needs a
  KV storage adapter and another account.
- **Railway / Render / Fly**: run `npm start` as an always-on server; simplest
  mental model, but you're paying for 24/7 compute to do 4 fetches an hour.

## Configuration

All via environment variables (see `src/config.js`):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Dashboard port (local server) |
| `POLL_MINUTES` | `15` | Poll interval (also the resolution-timing uncertainty) |
| `STATE_PATH` | `data/state.json` | Local state file |
| `S3_BUCKET` | — | If set, use S3 for the data feed instead of local files (enables the AWS path) |
| `S3_STATE_BUCKET` | = `S3_BUCKET` | Private bucket for running state |
| `MAX_GAP_MINUTES` | `3 × POLL_MINUTES` | Episodes resolved across a longer unobserved gap are excluded from grading |
| `MATCH_RADIUS_M` | `150` | Outage observations within this distance across polls are the same episode |
| `TERRITORY_BBOX` | JCP&L NJ | `minLat,minLon,maxLat,maxLon` for the geometry tile walk |
| `HOME_LAT` / `HOME_LON` | — | Fixed point for the home watch (set as CI secrets, never committed) |
| `HOME_RADIUS_M` | `250` | Marker within this distance of home counts as affecting it |
| `HOME_LABEL` | `Home` | Dashboard label for the home banner |
| `HOME_AREAS` | `MORRIS/MENDHAM TOWNSHIP` | Township fallback + row highlighting (`COUNTY/NAME`, comma-separated) |
| `NO_SCHEDULER` | — | Set to `1` to disable the built-in poller |
| `KUBRA_INSTANCE_ID` / `KUBRA_VIEW_ID` | JCP&L's | Point at another FirstEnergy operating company |
| `UTILITY_NAME` / `SOURCE_URL` | JCP&L | UI labels |

Because the utility identifiers are just config, the same app can track
Met-Ed, Penelec, West Penn, Ohio Edison, etc. — grab their `instanceId` /
`viewId` from that map's page source (`var BOOTSTRAP_CONFIG`).

## Data feed

The dashboard reads these static JSON documents (published locally under
`public/data/`; in production they ship inside the GitHub Pages artifact or to
`s3://<site-bucket>/data/`, depending on the deploy path):

| File | Contents |
| --- | --- |
| `config.json` | Utility labels + poll interval |
| `status.json` | Collection status + latest snapshot totals |
| `current.json` | Currently-open outages |
| `accuracy.json` | Aggregate accuracy on both bases (`final` / `first` stat blocks) + raw `errors` / `errorsFirst` arrays, plus an `outages` block with the same shape for clean geometric lifecycles (window, basis, scope, and histogram are applied in the browser) |
| `home.json` | Home-watch status: covered/clear, nearest-outage distance, current home outage details, home track record (no coordinates) |
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
npm test           # episode lifecycle, accuracy math, and feed-parsing tests
```

CI (GitHub Actions) runs the same suite on every push and pull request.

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

'use strict';

const $ = (sel) => document.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

let cfg = { resolutionUncertaintyMinutes: null };

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Dashboard data is published as static JSON (by the local server or, in
// production, by the S3-writing Lambda). Cache-bust so refreshes see new polls.
const data = (name) => getJSON(`data/${name}.json?t=${Date.now()}`);
// Tolerate documents that older deploys never published.
const dataOrNull = (name) => data(name).catch(() => null);

// Same semantics as the collector's matchesHomeArea: patterns are upper-case
// area names, optionally county-qualified as "COUNTY/NAME".
function isHomeArea(row) {
  const pats = cfg.homeAreas || [];
  if (!pats.length || !row.name) return false;
  const n = String(row.name).toUpperCase();
  const q = `${String(row.county || '').toUpperCase()}/${n}`;
  return pats.some((p) => p === n || p === q);
}

// Recompute the window-dependent hit/late/early rates in the browser, so the
// on-time-window selector needs no server round-trip (and works on static S3).
function computeRates(errors, win) {
  const n = errors.length;
  if (!n) return { onTimeRate: null, lateRate: null, earlyRate: null };
  const late = errors.filter((e) => e > win).length;
  const early = errors.filter((e) => e < -win).length;
  return { onTimeRate: (n - late - early) / n, lateRate: late / n, earlyRate: early / n };
}

// Bucket signed error minutes for the distribution chart. Done client-side so
// the grading-basis selector (first vs. final promise) works on static hosting.
function buildHistogram(errors) {
  const edges = [-Infinity, -720, -360, -180, -60, 0, 60, 180, 360, 720, Infinity];
  const labels = [
    '> 12h early', '6–12h early', '3–6h early', '1–3h early', '<1h early',
    '<1h late', '1–3h late', '3–6h late', '6–12h late', '> 12h late',
  ];
  const counts = new Array(labels.length).fill(0);
  for (const e of errors) {
    for (let i = 0; i < labels.length; i++) {
      if (e >= edges[i] && e < edges[i + 1]) { counts[i]++; break; }
    }
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => (n == null ? '—' : nf.format(Math.round(n)));

function fmtClock(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtRel(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
function fmtDurMin(min) {
  if (min == null) return '—';
  const sign = min < 0 ? '−' : '';
  let x = Math.abs(min);
  if (x < 60) return `${sign}${Math.round(x)} min`;
  const h = x / 60;
  if (h < 48) return `${sign}${h.toFixed(1)} h`;
  return `${sign}${(h / 24).toFixed(1)} d`;
}
// signed error phrasing
function fmtError(min) {
  if (min == null) return '—';
  if (Math.abs(min) < 1) return 'on time';
  return min > 0
    ? `${fmtDurMin(min)} late`
    : `${fmtDurMin(Math.abs(min))} early`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- SVG helpers ----------
function svg(w, h) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('width', w);
  s.setAttribute('height', h);
  return s;
}
function line(x1, y1, x2, y2, cls) {
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', x1);
  l.setAttribute('y1', y1);
  l.setAttribute('x2', x2);
  l.setAttribute('y2', y2);
  if (cls) l.setAttribute('class', cls);
  return l;
}
function rect(x, y, w, h, fill) {
  const r = document.createElementNS(SVGNS, 'rect');
  r.setAttribute('x', x);
  r.setAttribute('y', y);
  r.setAttribute('width', Math.max(0, w));
  r.setAttribute('height', Math.max(0, h));
  r.setAttribute('fill', fill);
  r.setAttribute('rx', 2);
  return r;
}
function text(x, y, str, cls, anchor) {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  if (cls) t.setAttribute('class', cls);
  if (anchor) t.setAttribute('text-anchor', anchor);
  t.textContent = str;
  return t;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- renderers ----------
function renderLiveTiles(status) {
  const box = $('#live-tiles');
  box.innerHTML = '';
  const l = status.latest || {};
  const tiles = [
    { k: 'Customers out', v: fmtInt(l.totalCustOut), cls: 'accent', foot: l.totalCustServed ? `of ${fmtInt(l.totalCustServed)} served` : '' },
    { k: 'Active outages', v: fmtInt(l.totalOutages), foot: `${fmtInt(status.openEpisodes)} areas affected` },
    { k: 'Resolved outages tracked', v: fmtInt(status.resolvedEpisodes), foot: `${fmtInt(status.gradedEpisodes)} with an ETR to grade` },
    { k: 'Polls collected', v: fmtInt(status.polls), foot: status.firstPollTs ? `since ${fmtClock(status.firstPollTs)}` : '' },
  ];
  for (const t of tiles) {
    const d = el('div', 'tile');
    d.appendChild(el('div', 'k', t.k));
    d.appendChild(el('div', `v ${t.cls || ''}`, t.v));
    if (t.foot) d.appendChild(el('div', 'foot', t.foot));
    box.appendChild(d);
  }
}

function renderTimeseries(series) {
  const host = $('#timeseries');
  host.innerHTML = '';
  if (!series.length) {
    host.appendChild(el('div', 'muted', 'No polls yet.'));
    return;
  }
  const W = 1000,
    H = 220,
    pad = { l: 56, r: 12, t: 12, b: 26 };
  const s = svg(W, H);
  const xs = series.map((d) => d.ts);
  const ys = series.map((d) => d.custOut || 0);
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs);
  const ymax = Math.max(10, ...ys);
  const X = (t) =>
    pad.l + ((t - xmin) / Math.max(1, xmax - xmin)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - (v / ymax) * (H - pad.t - pad.b);

  // gridlines + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i;
    const y = Y(v);
    s.appendChild(line(pad.l, y, W - pad.r, y, 'axis'));
    s.appendChild(text(pad.l - 8, y + 4, fmtInt(v), 'axis-text', 'end'));
  }
  // area + line
  const accent = cssVar('--accent');
  let dPath = '';
  series.forEach((d, i) => {
    dPath += `${i === 0 ? 'M' : 'L'} ${X(d.ts).toFixed(1)} ${Y(d.custOut || 0).toFixed(1)} `;
  });
  const area = document.createElementNS(SVGNS, 'path');
  area.setAttribute(
    'd',
    dPath + `L ${X(xmax)} ${Y(0)} L ${X(xmin)} ${Y(0)} Z`
  );
  area.setAttribute('fill', accent);
  area.setAttribute('opacity', '0.12');
  s.appendChild(area);
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', dPath);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', accent);
  path.setAttribute('stroke-width', '2');
  s.appendChild(path);

  // x labels (start/end)
  s.appendChild(text(pad.l, H - 8, fmtClock(xmin), 'axis-text', 'start'));
  s.appendChild(text(W - pad.r, H - 8, fmtClock(xmax), 'axis-text', 'end'));
  host.appendChild(s);
  $('#ts-range').textContent = `${series.length} points`;
}

function renderAccuracy(acc, status, basis) {
  const body = $('#accuracy-body');
  body.innerHTML = '';

  if (!acc.gradedCount) {
    const wrap = el('div', 'empty');
    wrap.appendChild(
      el(
        'div',
        'big',
        'Collecting data — accuracy appears once outages resolve.'
      )
    );
    wrap.appendChild(
      el(
        'div',
        null,
        `${fmtInt(status.openEpisodes)} outages are being watched. ` +
          `${fmtInt(status.resolvedEpisodes)} have resolved so far; ` +
          `we grade one once it clears with an ETR on record.`
      )
    );
    const prog = el('div', 'progress');
    const bar = document.createElement('i');
    bar.style.width = status.gradedEpisodes ? '100%' : '8%';
    prog.appendChild(bar);
    wrap.appendChild(prog);
    body.appendChild(wrap);
    return;
  }

  const stats = (basis === 'first' ? acc.first : acc.final) || {};
  const otherStats = (basis === 'first' ? acc.final : acc.first) || {};
  const otherLabel = basis === 'first' ? 'final promise' : 'first promise';
  const promiseLabel = basis === 'first' ? 'first promise' : 'final promise';
  const errors = (basis === 'first' ? acc.errorsFirst : acc.errors) || [];

  // Verdict tiles
  const v = el('div', 'verdict');
  const med = stats.medianErrorMin;
  const medCls = Math.abs(med) < 1 ? 'ontime' : med > 0 ? 'late' : 'early';
  const tiles = [
    {
      k: `Typical error, ${promiseLabel} (median)`,
      v: fmtError(med),
      cls: medCls,
      foot: `${otherLabel}: ${fmtError(otherStats.medianErrorMin)}`,
    },
    {
      k: `Within ±${fmtDurMin(acc.onTimeWindowMin)}`,
      v: `${Math.round(acc.onTimeRate * 100)}%`,
      cls: 'ontime',
      foot: 'of outages hit their ETR window',
    },
    {
      k: 'Restored late',
      v: `${Math.round(acc.lateRate * 100)}%`,
      cls: 'late',
      foot: 'restored after the promised window',
    },
    {
      k: 'Restored early',
      v: `${Math.round(acc.earlyRate * 100)}%`,
      cls: 'early',
      foot: `beat the estimate`,
    },
    {
      k: 'Avg ETR revisions',
      v: acc.meanRevisions ?? '—',
      foot: 'times the estimate changed',
    },
    {
      k: 'Outages graded',
      v: fmtInt(acc.gradedCount),
      foot:
        `median |error| ${fmtDurMin(stats.medianAbsErrorMin)}` +
        (acc.excludedForGapCount
          ? ` · ${fmtInt(acc.excludedForGapCount)} excluded (collection gap)`
          : '') +
        (acc.taintedCount
          ? ` · ${fmtInt(acc.taintedCount)} excluded (geometry merged/split)`
          : ''),
    },
  ];
  for (const t of tiles) {
    const d = el('div', 'tile');
    d.appendChild(el('div', 'k', t.k));
    d.appendChild(el('div', `v ${t.cls || ''}`, t.v));
    if (t.foot) d.appendChild(el('div', 'foot', t.foot));
    v.appendChild(d);
  }
  body.appendChild(v);

  // Outage scope: how often the utility's shapes reconciled (no public
  // lineage exists — this log is synthesized by the tracker).
  if (acc.reconciliations) {
    const r = acc.reconciliations;
    body.appendChild(
      el(
        'div',
        'muted',
        `Geometry reconciliations observed since tracking began: ` +
          `${fmtInt(r.merges)} merges, ${fmtInt(r.splits)} splits, ` +
          `${fmtInt(r.ambiguous)} co-located lifecycles too close to tell apart. ` +
          `All are excluded from grading rather than guessed at.`
      )
    );
  }

  // Charts split: histogram + scatter
  const split = el('div', 'split');
  const h1 = el('div', 'chart-wrap');
  h1.appendChild(el('h3', null, `Distribution of ETR error (${promiseLabel})`));
  h1.appendChild(histogram(buildHistogram(errors)));
  const leg = el('div', 'legend');
  leg.appendChild(el('span', 'l-early', 'restored early'));
  leg.appendChild(el('span', 'l-late', 'restored late'));
  h1.appendChild(leg);
  split.appendChild(h1);

  const points = (acc.scatter || []).map((p) => ({
    ...p,
    leadMin: basis === 'first' ? p.firstLeadMin : p.promisedLeadMin,
    plotErrorMin: basis === 'first' ? p.firstErrorMin : p.errorMin,
  })).filter((p) => p.leadMin != null && p.plotErrorMin != null);
  const h2 = el('div', 'chart-wrap');
  h2.appendChild(el('h3', null, 'Promised lead time vs. error'));
  h2.appendChild(scatter(points));
  h2.appendChild(
    el('div', 'muted', 'each dot = one resolved outage; size = peak customers')
  );
  split.appendChild(h2);
  body.appendChild(split);

  // By-county table
  if (acc.byCounty && acc.byCounty.length) {
    const wrap = el('div', 'table-wrap');
    wrap.style.marginTop = '18px';
    const t = document.createElement('table');
    t.innerHTML =
      '<thead><tr><th>County</th><th class="num">Graded</th>' +
      '<th class="num">Median error</th><th class="num">Mean error</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const c of acc.byCounty) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', null, c.county));
      tr.appendChild(el('td', 'num', fmtInt(c.count)));
      tr.appendChild(
        el('td', 'num', fmtError(basis === 'first' ? c.medianFirstErrorMin : c.medianErrorMin))
      );
      tr.appendChild(
        el('td', 'num', fmtError(basis === 'first' ? c.meanFirstErrorMin : c.meanErrorMin))
      );
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    body.appendChild(wrap);
  }
}

function histogram(buckets) {
  const W = 480,
    H = 240,
    pad = { l: 30, r: 12, t: 10, b: 64 };
  const s = svg(W, H);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const n = buckets.length;
  const bw = (W - pad.l - pad.r) / n;
  const late = cssVar('--late'),
    early = cssVar('--early');
  const midY = H - pad.b;
  s.appendChild(line(pad.l, midY, W - pad.r, midY, 'axis'));
  buckets.forEach((b, i) => {
    const x = pad.l + i * bw;
    const h = (b.count / max) * (H - pad.t - pad.b);
    const isLate = b.label.includes('late');
    s.appendChild(
      rect(x + 3, midY - h, bw - 6, h, isLate ? late : early)
    );
    if (b.count > 0)
      s.appendChild(
        text(x + bw / 2, midY - h - 4, String(b.count), 'axis-text', 'middle')
      );
    // rotated label
    const t = text(x + bw / 2, midY + 12, b.label, 'bar-label', 'end');
    t.setAttribute('transform', `rotate(-40 ${x + bw / 2} ${midY + 12})`);
    s.appendChild(t);
  });
  return s;
}

function scatter(points) {
  const W = 480,
    H = 240,
    pad = { l: 46, r: 12, t: 12, b: 34 };
  const s = svg(W, H);
  if (!points.length) {
    s.appendChild(text(W / 2, H / 2, 'no data', 'axis-text', 'middle'));
    return s;
  }
  const xs = points.map((p) => p.leadMin);
  const ys = points.map((p) => p.plotErrorMin);
  const xmax = Math.max(60, ...xs);
  const ymax = Math.max(60, ...ys.map((y) => Math.abs(y)));
  const X = (v) => pad.l + (v / xmax) * (W - pad.l - pad.r);
  const Y = (v) => (H - pad.b + pad.t) / 2 - (v / ymax) * (H - pad.t - pad.b) / 2;
  // zero line
  const zeroY = Y(0);
  s.appendChild(line(pad.l, zeroY, W - pad.r, zeroY, 'axis'));
  s.appendChild(text(pad.l - 6, zeroY + 3, 'on time', 'axis-text', 'end'));
  s.appendChild(text(pad.l - 6, Y(ymax) + 8, 'late', 'axis-text', 'end'));
  s.appendChild(text(pad.l - 6, Y(-ymax), 'early', 'axis-text', 'end'));
  s.appendChild(
    text(W - pad.r, H - 6, 'promised lead time →', 'axis-text', 'end')
  );
  const late = cssVar('--late'),
    early = cssVar('--early');
  const maxCust = Math.max(1, ...points.map((p) => p.peakCustA || 0));
  for (const p of points) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', X(Math.max(0, p.leadMin)).toFixed(1));
    c.setAttribute('cy', Y(p.plotErrorMin).toFixed(1));
    const r = 3 + 6 * Math.sqrt((p.peakCustA || 0) / maxCust);
    c.setAttribute('r', r.toFixed(1));
    c.setAttribute('fill', p.plotErrorMin > 0 ? late : early);
    c.setAttribute('opacity', '0.6');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `${p.name || p.county}: ${fmtError(p.plotErrorMin)}, ${fmtInt(p.peakCustA)} out`;
    c.appendChild(title);
    s.appendChild(c);
  }
  return s;
}

// The home panel: geometry-based status for the fixed home point (when the
// collector runs with HOME_LAT/HOME_LON), plus a township-level line.
function renderHome(home, current) {
  const box = $('#home-note');
  const geo = home && home.enabled;
  const homeRows = (current || []).filter(isHomeArea);
  if (!geo && !homeRows.length && !(cfg.homeAreas || []).length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  const label = cfg.homeLabel || 'Home';

  if (geo && home.current) {
    const c = home.current;
    box.className = 'home-note alert';
    const where =
      c.kind === 'polygon'
        ? 'the home location is inside a reported outage area'
        : `an outage is reported ${fmtInt(c.distM)} m from home`;
    box.appendChild(el('div', 'big', `⚡ ${label}: power outage — ${where}`));
    const bits = [];
    bits.push(`out since ${fmtRel(c.startTs)}`);
    if (c.custA) bits.push(`${fmtInt(c.custA)} customers affected nearby`);
    if (c.etr) {
      bits.push(
        `promised restoration ${fmtClock(c.etr)} (${
          c.etrSource === 'area' ? 'township-wide estimate' : 'outage-specific'
        }${c.etrRevisions ? `, revised ×${c.etrRevisions}` : ''})`
      );
    } else {
      bits.push('no restoration estimate given yet');
    }
    if (c.cause) bits.push(`cause: ${c.cause}`);
    if (c.crewStatus) bits.push(`crew: ${c.crewStatus}`);
    box.appendChild(el('div', null, bits.join(' · ')));
  } else if (geo) {
    box.className = 'home-note ok';
    box.appendChild(el('div', 'big', `✓ ${label}: no outage at the home location`));
    const lc = home.lastCheck || {};
    const bits = [];
    if (lc.nearestM != null) {
      bits.push(
        lc.nearestM < 1000
          ? `nearest active outage ${fmtInt(lc.nearestM)} m away`
          : `nearest active outage ${(lc.nearestM / 1000).toFixed(1)} km away`
      );
    }
    if (lc.ts) bits.push(`geometry checked ${fmtRel(lc.ts)}`);
    if (bits.length) box.appendChild(el('div', null, bits.join(' · ')));
  } else {
    box.className = 'home-note ok';
    box.appendChild(el('div', 'big', `${label} area watch`));
  }

  // Township-level line (the grading altitude), regardless of geometry status.
  const twp = [];
  for (const r of homeRows) {
    twp.push(`${r.name}: ${fmtInt(r.custOut)} customers out township-wide`);
  }
  if (!homeRows.length && (cfg.homeAreas || []).length) {
    const names = cfg.homeAreas.map((p) => p.split('/').pop()).join(', ');
    twp.push(`no active outage listed for ${names}`);
  }
  if (home && home.gradedCount) {
    twp.push(
      `track record here: ${fmtInt(home.gradedCount)} home outage${home.gradedCount > 1 ? 's' : ''} graded, ` +
        `median final-promise error ${fmtError(home.medianFinalErrorMin)}`
    );
  }
  if (home && home.monitoring) {
    const m = home.monitoring;
    twp.push(
      `monitored since ${fmtClock(m.since)} · ${fmtInt(m.checks)} geometry checks, ` +
        `home covered during ${fmtInt(m.coveredChecks)}`
    );
  }
  if (twp.length) box.appendChild(el('div', 'muted', twp.join(' · ')));

  // Coverage timeline: one tick per geometry check, so "checked and clear"
  // moments are part of the record too.
  if (home && home.timeline && home.timeline.length) {
    box.appendChild(coverageStrip(home.timeline));
  }

  // Dedicated history: every home episode the GIS watch has ever tracked.
  if (home && home.history && home.history.length) {
    const wrap = el('div', 'table-wrap');
    wrap.style.marginTop = '10px';
    const t = document.createElement('table');
    t.innerHTML =
      '<thead><tr><th>Home outage</th><th class="num">Duration</th>' +
      '<th class="num">Customers</th><th>Promised restoration</th>' +
      '<th class="num">Outcome</th><th class="num">Revisions</th><th>Cause</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const h of home.history) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', null, fmtClock(h.startTs)));
      tr.appendChild(el('td', 'num', h.resolved ? fmtDurMin(h.durationMin) : 'ongoing'));
      tr.appendChild(el('td', 'num', fmtInt(h.peakCustA)));
      tr.appendChild(
        el(
          'td',
          null,
          h.finalEtr
            ? fmtClock(h.finalEtr) + (h.etrSource === 'area' ? ' (township-wide)' : '')
            : 'none given'
        )
      );
      let outcome;
      if (!h.resolved) outcome = '—';
      else if (h.graded) outcome = fmtError(h.finalErrorMin);
      else if (h.finalEtr == null) outcome = 'no promise to grade';
      else outcome = 'not graded (collection gap)';
      tr.appendChild(el('td', 'num', outcome));
      tr.appendChild(el('td', 'num', h.etrRevisions ? `×${h.etrRevisions}` : '0'));
      tr.appendChild(el('td', null, h.cause || '—'));
      tb.appendChild(tr);

      // Specifics sub-row: geometry detail, the verbatim promise trail, and
      // the first-promise grade.
      const bits = [];
      if (h.kind === 'polygon') bits.push('home inside the reported outage area');
      else if (h.distM != null) bits.push(`outage ${fmtInt(h.distM)} m from home`);
      if (h.etrHistory && h.etrHistory.length) {
        bits.push(
          'promise trail: ' + h.etrHistory.map((x) => fmtClock(x.etr)).join(' → ')
        );
      }
      if (h.graded && h.firstErrorMin != null && h.etrRevisions > 0) {
        bits.push(`graded on the first promise: ${fmtError(h.firstErrorMin)}`);
      }
      if (h.resolved && !h.graded && h.finalEtr != null && h.gapMin != null) {
        bits.push(`observation gap ${fmtDurMin(h.gapMin)}`);
      }
      if (bits.length) {
        const sub = document.createElement('tr');
        const td = el('td', 'muted', bits.join(' · '));
        td.colSpan = 7;
        sub.appendChild(td);
        tb.appendChild(sub);
      }
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
  }
}

// A tick strip of home geometry checks: amber = covered, green = clear.
function coverageStrip(timeline) {
  const wrap = el('div');
  wrap.style.marginTop = '10px';
  const W = 1000;
  const H = 26;
  const s = svg(W, H);
  const n = timeline.length;
  const bw = W / Math.max(48, n);
  const accent = cssVar('--accent');
  const ok = cssVar('--ontime');
  timeline.forEach((r, i) => {
    const x = W - (n - i) * bw;
    const tick = rect(x, 4, Math.max(1.5, bw - 1.5), H - 8, r.covered ? accent : ok);
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent =
      `${fmtClock(r.ts)} — ${r.covered ? 'home covered' : 'clear'}` +
      (r.covered && r.custA ? `, ${fmtInt(r.custA)} customers nearby` : '') +
      (r.covered ? (r.etr ? `, promised ${fmtClock(r.etr)}` : ', no promise') : '') +
      (!r.covered && r.nearestM != null ? `, nearest outage ${fmtInt(r.nearestM)} m` : '');
    tick.appendChild(title);
    s.appendChild(tick);
  });
  s.setAttribute('height', H);
  wrap.appendChild(s);
  const cap = el(
    'div',
    'muted',
    `coverage timeline — one tick per geometry check, oldest ${fmtClock(timeline[0].ts)}`
  );
  wrap.appendChild(cap);
  return wrap;
}

function renderCurrent(rows) {
  const tb = $('#current-table tbody');
  tb.innerHTML = '';
  $('#current-count').textContent = `${fmtInt(rows.length)} areas`;
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'muted', 'No active outages in the feed right now.');
    td.colSpan = 7;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  // Pin home-area rows to the top.
  rows = [...rows.filter(isHomeArea), ...rows.filter((r) => !isHomeArea(r))];
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (isHomeArea(r)) tr.className = 'home';
    const nameTd = el('td', null, r.name || r.areaId);
    if (isHomeArea(r)) nameTd.appendChild(el('span', 'home-pill', '⌂ home'));
    tr.appendChild(nameTd);
    tr.appendChild(el('td', null, r.county || '—'));
    tr.appendChild(el('td', 'num', fmtInt(r.custOut)));
    tr.appendChild(el('td', 'num', fmtInt(r.nOut)));
    tr.appendChild(
      el('td', null, r.currentEtr ? fmtClock(r.currentEtr) : 'not provided')
    );
    const revTd = el('td', 'num');
    if (r.etrRevisions > 0) {
      const p = el('span', 'pill', `×${r.etrRevisions}`);
      revTd.appendChild(p);
    } else revTd.textContent = '0';
    tr.appendChild(revTd);
    tr.appendChild(el('td', null, fmtRel(r.startTs)));
    tb.appendChild(tr);
  }
}

// ---------- orchestration ----------
async function refresh() {
  const win = Number($('#window').value);
  const basis = $('#basis').value;
  const [status, accAll, current, ts, home] = await Promise.all([
    data('status'),
    data('accuracy'),
    data('current'),
    data('timeseries'),
    dataOrNull('home'),
  ]);

  // Grading scope: township episodes (name identity) or individual outages
  // (geometric continuity, clean lifecycles only). Older feeds lack the
  // outage-level block — hide the selector then.
  const scopeSel = $('#scope');
  scopeSel.parentElement.style.display = accAll.outages ? '' : 'none';
  const scope = accAll.outages && scopeSel.value === 'outages' ? 'outages' : 'townships';
  const acc = scope === 'outages' ? accAll.outages : accAll;

  // Apply the selected on-time window + grading basis client-side.
  acc.onTimeWindowMin = win;
  const errors = (basis === 'first' ? acc.errorsFirst : acc.errors) || [];
  Object.assign(acc, computeRates(errors, win));

  const l = status.latest || {};
  $('#updated').textContent = l.fetchedAt
    ? `updated ${fmtRel(l.fetchedAt)}`
    : 'no data yet';
  const badge = $('#mode-badge');
  badge.textContent = l.pageMode || '—';
  badge.classList.toggle('storm', (l.pageMode || '').toUpperCase() !== 'BLUESKY');

  renderLiveTiles(status);
  renderTimeseries(ts);
  renderHome(home, current);
  renderAccuracy(acc, status, basis);
  renderCurrent(current);
}

async function init() {
  try {
    cfg = await data('config');
    $('#utility').textContent = `${cfg.utilityName} — ETR Accuracy`;
    document.title = `${cfg.utilityName} — ETR Accuracy`;
    const src = $('#source');
    src.href = cfg.sourceUrl;
    $('#uncertainty').textContent = `±${cfg.resolutionUncertaintyMinutes}`;
  } catch {}

  $('#window').addEventListener('change', () => refresh().catch(console.error));
  $('#basis').addEventListener('change', () => refresh().catch(console.error));
  $('#scope').addEventListener('change', () => refresh().catch(console.error));
  // "Collect now" works against the local dev server. On the static S3 deploy
  // there is no collect endpoint (a Lambda polls on a schedule), so the button
  // gracefully retires itself.
  $('#collect').addEventListener('click', async () => {
    const b = $('#collect');
    b.disabled = true;
    b.textContent = 'Collecting…';
    try {
      const r = await fetch('/api/collect', { method: 'POST' });
      if (!r.ok) throw new Error(`collect -> ${r.status}`);
      await refresh();
      b.disabled = false;
      b.textContent = 'Collect now';
    } catch (e) {
      b.textContent = `auto every ${cfg.pollMinutes || 15} min`;
      b.title = 'Collection runs automatically; manual collect is dev-only.';
    }
  });

  await refresh().catch(console.error);
  setInterval(() => refresh().catch(console.error), 60000);
}

init();

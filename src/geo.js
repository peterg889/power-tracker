// Minimal geo toolkit for the KUBRA cluster (geometry) layer: Bing-style
// quadkeys for tile addressing, Google encoded-polyline decoding for the
// `geom` payloads, and point-in-polygon / distance tests for deciding whether
// an outage shape covers a fixed location.
//
// Why fixed-point coverage instead of tracking outage identity: the public
// feed gives outages no stable id (`inc_id` is null, tile entry ids are
// positional), and shapes visibly merge/split/reconcile between polls. Any
// cross-poll identity matching would fabricate resolutions at every merge.
// A fixed location sidesteps that entirely — "is this point covered right
// now" is answerable per poll, and coverage continuity defines an episode.

// lat/lon -> quadkey at zoom z (Bing tile system).
export function quadkey(lat, lon, z) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = (lon + 180) / 360;
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const n = 1 << z;
  const tx = Math.min(n - 1, Math.max(0, Math.floor(x * n)));
  const ty = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
  return tileToQuadkey(tx, ty, z);
}

export function tileXY(lat, lon, z) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = (lon + 180) / 360;
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const n = 1 << z;
  return {
    tx: Math.min(n - 1, Math.max(0, Math.floor(x * n))),
    ty: Math.min(n - 1, Math.max(0, Math.floor(y * n))),
  };
}

export function tileToQuadkey(tx, ty, z) {
  let qk = '';
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    qk += (tx & mask ? 1 : 0) + (ty & mask ? 2 : 0);
  }
  return qk;
}

// The {qkh} cache-shard in KUBRA cluster-data paths: the last three characters
// of the quadkey, reversed (verified against the StormCenter app bundle).
export function quadkeyShard(qk) {
  return qk.slice(-3).split('').reverse().join('');
}

// Google encoded polyline -> [[lat, lon], ...] (precision 5).
export function decodePolyline(str) {
  let i = 0;
  let lat = 0;
  let lon = 0;
  const pts = [];
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

// Ray-casting point-in-polygon over a [[lat, lon], ...] ring.
export function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// Great-circle distance in meters.
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Test the walked outage geometries against one fixed location: covered when
// a polygon contains the point or a point/cluster marker is within radiusM.
export function homeImpactFromOutages(
  { outages, clusterPoints = [] },
  { lat, lon, radiusM }
) {
  const matches = [];
  let nearestM = null;
  for (const o of outages) {
    const contains = (o.geomA || []).some((enc) =>
      pointInPolygon(lat, lon, decodePolyline(enc))
    );
    const distM = Math.round(haversineM(lat, lon, o.point[0], o.point[1]));
    nearestM = nearestM == null ? distM : Math.min(nearestM, distM);
    if (contains || distM <= radiusM) {
      matches.push({
        kind: contains ? 'polygon' : 'point',
        distM,
        custA: o.custA,
        nOut: o.nOut,
        etr: o.etr,
        cause: o.cause,
        crewStatus: o.crewStatus,
      });
    }
  }
  for (const [clat, clon] of clusterPoints) {
    const distM = Math.round(haversineM(lat, lon, clat, clon));
    nearestM = nearestM == null ? distM : Math.min(nearestM, distM);
    if (distM <= radiusM) {
      matches.push({ kind: 'cluster', distM, custA: null, nOut: null, etr: null, cause: null, crewStatus: null });
    }
  }
  matches.sort((a, b) => (a.kind === 'polygon' ? -1 : 1) - (b.kind === 'polygon' ? -1 : 1) || a.distM - b.distM);
  return {
    checked: true,
    covered: matches.length > 0,
    matches,
    nearestM,
    radiusM,
  };
}

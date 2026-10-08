// Small hand-written geometry helpers so the app doesn't need to ship a full
// GIS library just to answer "which canal is nearest to this point." Turf.js
// runs the real routing at build time; the browser only needs this.

// Ray-casting point-in-polygon test. `ring` is an array of [lon, lat] pairs.
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeometry(point, geometry) {
  if (geometry.type === 'Polygon') {
    return pointInRing(point, geometry.coordinates[0]);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInRing(point, poly[0]));
  }
  return false;
}

// Shortest distance in meters from `latlng` (Leaflet LatLng) to the boundary
// of a GeoJSON polygon/multipolygon geometry (in [lon, lat] coordinates).
function distanceToPolygonBoundaryMeters(latlng, geometry) {
  const point = L.latLng(latlng.lat, latlng.lng);
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);

  let min = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = L.latLng(ring[i][1], ring[i][0]);
      const b = L.latLng(ring[i + 1][1], ring[i + 1][0]);
      const d = distanceToSegmentMeters(point, a, b);
      if (d < min) min = d;
    }
  }
  return min;
}

// Distance from point p to segment ab, all Leaflet LatLngs. Projects into a
// local equirectangular frame to find the closest point on the segment (fine
// at this scale/latitude), then uses Leaflet's own haversine distanceTo for
// the actual meters so the result matches everything else in the app.
function distanceToSegmentMeters(p, a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const kx = Math.cos(latRad); // longitude degrees are shorter than latitude degrees up here

  const px = p.lng * kx;
  const py = p.lat;
  const ax = a.lng * kx;
  const ay = a.lat;
  const bx = b.lng * kx;
  const by = b.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const closest = L.latLng(ay + t * dy, (ax + t * dx) / kx);
  return p.distanceTo(closest);
}

// Finds the canal feature whose polygon is nearest to `latlng`. Returns
// { feature, distanceMeters } or null if canalsGeoJSON has no features.
function findNearestCanal(latlng, canalsGeoJSON) {
  let best = null;
  let bestDistance = Infinity;
  for (const feature of canalsGeoJSON.features) {
    const inside = pointInPolygonGeometry([latlng.lng, latlng.lat], feature.geometry);
    const distance = inside ? 0 : distanceToPolygonBoundaryMeters(latlng, feature.geometry);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = feature;
    }
  }
  if (!best) return null;
  return { feature: best, distanceMeters: bestDistance };
}

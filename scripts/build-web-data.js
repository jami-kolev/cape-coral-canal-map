// Turns the processed pipeline output into compact files the app actually
// loads in the browser: simplified geometry, only the fields the UI needs,
// coordinates rounded to ~1m precision. Run with: npm run data:build-web
//
// Output goes to public/data/. Everything except routes.json is meant for the
// initial map paint; routes.json (per-canal route line + bridge list) is
// fetched lazily the first time a canal is tapped, per the "under 2MB on
// first load, lazy-load extras" target.

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const { isValidPolygonFeature } = require('./lib/graph');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public/data');

const COORD_PRECISION = 6; // ~0.11m at this latitude, plenty for this app

function roundCoords(coords) {
  if (typeof coords[0] === 'number') {
    return coords.map((n) => Math.round(n * 10 ** COORD_PRECISION) / 10 ** COORD_PRECISION);
  }
  return coords.map(roundCoords);
}

function roundGeometry(geometry) {
  return { ...geometry, coordinates: roundCoords(geometry.coordinates) };
}

function loadGeoJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function writeJSON(relPath, data) {
  const outPath = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(outPath, json);
  return json.length;
}

function buildCanals() {
  const canals = loadGeoJSON('data/raw/canals.geojson');
  const routes = loadGeoJSON('data/processed/routes.json');

  const features = canals.features
    .filter(isValidPolygonFeature)
    .map((f) => {
      const simplified = turf.simplify(f, { tolerance: 0.000015, highQuality: true });
      const route = routes[f.properties.OBJECTID] || {};
      return {
        type: 'Feature',
        properties: {
          id: f.properties.OBJECTID,
          name: f.properties.NAME,
          waterType: f.properties.WATER_TYPE,
          navSyst: f.properties.NAV_SYST,
          basin: f.properties.Basin,
          gulfAccess: route.gulfAccess ?? false,
          hasRouteDetail: Boolean(route.routeLine),
          lowestClearanceFt: route.lowestClearanceFt ?? null,
        },
        geometry: roundGeometry(simplified.geometry),
      };
    });

  return { type: 'FeatureCollection', features };
}

function buildBridges() {
  const bridges = loadGeoJSON('data/raw/bridges.geojson');
  const features = bridges.features
    .filter((f) => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 0)
    .map((f) => ({
      type: 'Feature',
      properties: {
        id: f.properties.OBJECTID,
        bridgeNumber: f.properties.BRIDGE_NUMBER,
        canalName: f.properties.CANAL_NAME,
        street: f.properties.Street,
        localName: f.properties.LocalName || null,
        clearanceFt:
          typeof f.properties.VerticalClearance === 'number' && f.properties.VerticalClearance > 0
            ? f.properties.VerticalClearance
            : null,
        navigable: f.properties.Navigable || null,
        structureType: f.properties.StructureType || null,
      },
      geometry: roundGeometry(f.geometry),
    }));
  return { type: 'FeatureCollection', features };
}

function buildWeirs() {
  const weirs = loadGeoJSON('data/raw/weirs.geojson');
  const features = weirs.features.map((f) => ({
    type: 'Feature',
    properties: {
      id: f.properties.OBJECTID,
      canal: f.properties.CANAL,
      location: f.properties.LOCATION,
      type: f.properties.TYPE,
      structureType: f.properties.STRUCTURE_TYPE,
      weirCrest: f.properties.WEIR_CREST ?? null,
    },
    geometry: roundGeometry(f.geometry),
  }));
  return { type: 'FeatureCollection', features };
}

function buildAmenities() {
  const amenities = loadGeoJSON('data/raw/marine-amenities.geojson');
  const features = amenities.features.map((f) => ({
    type: 'Feature',
    properties: {
      category: f.properties.category,
      name: f.properties.name,
    },
    geometry: roundGeometry(f.geometry),
  }));
  return { type: 'FeatureCollection', features };
}

function buildOpenWater() {
  const water = loadGeoJSON('data/raw/open-water.geojson');
  const simplified = turf.simplify(water.features[0], { tolerance: 0.0003, highQuality: false });
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: roundGeometry(simplified.geometry) }],
  };
}

function buildCityBoundary() {
  const boundary = loadGeoJSON('data/raw/city-boundary.geojson');
  const main = boundary.features.reduce((biggest, f) => (turf.area(f) > turf.area(biggest) ? f : biggest));
  const simplified = turf.simplify(main, { tolerance: 0.00008, highQuality: false });
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: roundGeometry(simplified.geometry) }],
  };
}

function buildRoutes() {
  const routes = loadGeoJSON('data/processed/routes.json');
  const compact = {};
  for (const [id, r] of Object.entries(routes)) {
    compact[id] = {
      gulfAccess: r.gulfAccess,
      routeDetailUnavailableReason: r.routeDetailUnavailableReason || null,
      distanceMiles: r.distanceMiles ?? null,
      lowestClearanceFt: r.lowestClearanceFt ?? null,
      hasUnrecordedClearanceBridge: r.hasUnrecordedClearanceBridge ?? false,
      idleTimeMinutes: r.idleTimeMinutes ?? null,
      noWakeSpeedMph: r.noWakeSpeedMph ?? null,
      bridges: r.bridges || [],
      routeLine: r.routeLine ? roundCoords(r.routeLine) : null,
      basin: r.basin ?? null,
    };
  }
  return compact;
}

function main() {
  console.log('Building compact web data...');
  const sizes = {};

  sizes['canals.json'] = writeJSON('canals.json', buildCanals());
  sizes['bridges.json'] = writeJSON('bridges.json', buildBridges());
  sizes['weirs.json'] = writeJSON('weirs.json', buildWeirs());
  sizes['amenities.json'] = writeJSON('amenities.json', buildAmenities());
  sizes['open-water.json'] = writeJSON('open-water.json', buildOpenWater());
  sizes['city-boundary.json'] = writeJSON('city-boundary.json', buildCityBoundary());
  sizes['routes.json'] = writeJSON('routes.json', buildRoutes());

  const firstLoadFiles = ['canals.json', 'bridges.json', 'weirs.json', 'amenities.json', 'open-water.json', 'city-boundary.json'];
  const firstLoadBytes = firstLoadFiles.reduce((sum, f) => sum + sizes[f], 0);

  console.log('  File sizes:');
  for (const [name, bytes] of Object.entries(sizes)) {
    console.log(`    ${name}: ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`  First-load total (excludes lazy-loaded routes.json): ${(firstLoadBytes / 1024).toFixed(1)} KB`);
  if (firstLoadBytes > 2 * 1024 * 1024) {
    console.warn('  WARNING: first-load payload exceeds the 2MB target.');
  }
  console.log('Done. Wrote public/data/*.json');
}

main();

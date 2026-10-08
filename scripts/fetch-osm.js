// Pulls public boat ramps, marinas, and marine fuel points for Cape Coral from
// OpenStreetMap via the Overpass API. Run with: npm run data:fetch-osm

const fs = require('fs');
const path = require('path');
const sources = require('./sources');

const ROOT = path.join(__dirname, '..');

const RAMPS_QUERY = `
[out:json][timeout:60];
area["name"="Cape Coral"]["boundary"="administrative"]->.a;
(
  node["leisure"="slipway"](area.a);
  way["leisure"="slipway"](area.a);
  node["leisure"="marina"](area.a);
  way["leisure"="marina"](area.a);
);
out center tags;
`;

const FUEL_QUERY = `
[out:json][timeout:60];
area["name"="Cape Coral"]["boundary"="administrative"]->.a;
(
  node["amenity"="fuel"]["fuel:marine"="yes"](area.a);
  node["seamark:type"="fuel_station"](area.a);
  node(area.a)["shop"="boat"];
);
out center tags;
`;

// Real centerline of the Caloosahatchee River, used to build the open-water
// boundary's eastern/southern edge (see build-open-water.js) instead of
// hand-guessed coordinates, which overshot onto real land near North Fort Myers.
const RIVER_QUERY = `
[out:json][timeout:90];
way["name"~"Caloosahatchee"]["waterway"="river"](26.40,-82.10,26.75,-81.75);
out geom;
`;

// Large water/wetland bodies across Cape Coral's extent — coves, marshes, tidal
// preserves like Four Mile Cove — that sit *inside* the city boundary and so
// were missed by a boundary-fringe-only approach. Filtered down to sizable
// polygons in build-open-water.js; individual canals also get traced by OSM
// as tiny "water" ways and aren't wanted here. Split into quadrants — the
// single citywide query reliably timed out server-side.
const LARGE_WATER_BBOXES = [
  [26.53, -82.08, 26.64, -81.97], // SW
  [26.53, -81.97, 26.64, -81.85], // SE
  [26.64, -82.08, 26.75, -81.97], // NW
  [26.64, -81.97, 26.75, -81.85], // NE
];
function largeWaterQuery([s, w, n, e]) {
  return `[out:json][timeout:90];(way["natural"="water"](${s},${w},${n},${e});way["natural"="wetland"](${s},${w},${n},${e}););out geom;`;
}

async function runOverpass(query, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(sources.overpassUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': 'cape-coral-canal-map-data-pipeline (thekolevgroup.com)',
        },
        body: query,
      });
      if (!res.ok) {
        throw new Error(`Overpass request failed: ${res.status} ${await res.text()}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      const waitMs = attempt * 8000;
      console.warn(`  Overpass attempt ${attempt} failed (${err.message.slice(0, 80)}), retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

function elementToFeature(el, category) {
  const coords = el.type === 'node' ? [el.lon, el.lat] : [el.center.lon, el.center.lat];
  return {
    type: 'Feature',
    properties: {
      category,
      name: el.tags && el.tags.name ? el.tags.name : null,
      osm_type: el.type,
      osm_id: el.id,
      tags: el.tags || {},
    },
    geometry: { type: 'Point', coordinates: coords },
  };
}

async function fetchAmenities() {
  console.log('Fetching OSM boat ramps / marinas / fuel via Overpass...');

  const ramps = await runOverpass(RAMPS_QUERY);
  await new Promise((r) => setTimeout(r, 1500)); // be polite to the shared Overpass instance
  const fuel = await runOverpass(FUEL_QUERY);

  const features = [
    ...ramps.elements.map((el) =>
      elementToFeature(el, el.tags && el.tags.leisure === 'marina' ? 'marina' : 'ramp'),
    ),
    ...fuel.elements.map((el) => elementToFeature(el, 'fuel')),
  ];

  // De-dupe (marinas sometimes carry both leisure=marina and fuel tags).
  const seen = new Set();
  const deduped = features.filter((f) => {
    const key = `${f.properties.osm_type}/${f.properties.osm_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const geojson = { type: 'FeatureCollection', features: deduped };
  const outFile = 'data/raw/marine-amenities.geojson';
  fs.mkdirSync(path.join(ROOT, 'data/raw'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(geojson, null, 1));

  const counts = deduped.reduce((acc, f) => {
    acc[f.properties.category] = (acc[f.properties.category] || 0) + 1;
    return acc;
  }, {});
  console.log(`  ${deduped.length} features -> ${outFile}`, counts);
}

async function fetchRiverCenterline() {
  console.log('Fetching Caloosahatchee River centerline via Overpass...');
  const river = await runOverpass(RIVER_QUERY, 5);
  const riverLines = {
    type: 'FeatureCollection',
    features: river.elements
      .filter((el) => el.geometry)
      .map((el) => ({
        type: 'Feature',
        properties: { osm_id: el.id, name: el.tags && el.tags.name },
        geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
      })),
  };
  const riverOutFile = 'data/raw/caloosahatchee-river-centerline.geojson';
  fs.writeFileSync(path.join(ROOT, riverOutFile), JSON.stringify(riverLines));
  console.log(`  ${riverLines.features.length} features -> ${riverOutFile}`);
}

function closeRing(coords) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
  return coords;
}

async function fetchLargeWaterBodies() {
  console.log('Fetching large water/wetland bodies (coves, marshes, preserves) via Overpass...');
  const seen = new Set();
  const features = [];
  for (const bbox of LARGE_WATER_BBOXES) {
    const result = await runOverpass(largeWaterQuery(bbox), 5);
    for (const el of result.elements) {
      if (!el.geometry || el.geometry.length < 4 || seen.has(el.id)) continue;
      seen.add(el.id);
      const coords = closeRing(el.geometry.map((p) => [p.lon, p.lat]));
      features.push({
        type: 'Feature',
        properties: { osm_id: el.id, name: el.tags && el.tags.name, natural: el.tags && el.tags.natural },
        geometry: { type: 'Polygon', coordinates: [coords] },
      });
    }
    console.log(`  bbox [${bbox.join(',')}]: ${result.elements.length} elements (${features.length} total so far)`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const outFile = 'data/raw/large-water-bodies.geojson';
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  ${features.length} features -> ${outFile}`);
}

async function main() {
  await fetchAmenities();
  await new Promise((r) => setTimeout(r, 1500));
  await fetchRiverCenterline();
  await new Promise((r) => setTimeout(r, 1500));
  await fetchLargeWaterBodies();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { fetchAmenities, fetchRiverCenterline, fetchLargeWaterBodies };

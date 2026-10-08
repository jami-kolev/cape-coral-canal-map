// Open-water boundary for the Caloosahatchee River, Matlacha Pass / Charlotte
// Harbor, and the adjoining Gulf of Mexico waters around Cape Coral.
//
// There is no ready-made public polygon for this (see DATA_NOTES.md), so it's
// built from three pieces:
//   1. A fringe around the City's own real boundary polygon (the most accurate
//      geometry available), buffered outward ~450m and with the interior
//      subtracted, minus a hand-identified land pocket in the NE (golf
//      course / airpark / wildlife-management land, not canal territory).
//      This is what actually guarantees coverage: an earlier river-centerline-
//      only version missed Four Mile Cove and other real inlets entirely,
//      leaving hundreds of real canal mouths — a whole quadrant of the city —
//      stranded far from the polygon. The boundary itself is authoritative
//      (pulled straight from the City's GIS), so buffering it is far more
//      reliable than continuing to hand-guess coastline coordinates.
//   2. The Caloosahatchee River: OSM's real river centerline, buffered out to
//      a plausible channel width, mostly redundant with #1 now but kept as a
//      second independent check plus a nicer-looking river shape at low zoom.
//   3. Matlacha Pass / San Carlos Bay / the Gulf: a hand-drawn band reaching
//      further offshore than the boundary fringe alone would, so the map
//      shows a recognizable body of water rather than a thin ring.
//   4. Large coves/marshes/preserves (e.g. Four Mile Cove Ecological
//      Preserve) that sit INSIDE the City boundary, so #1 doesn't reach them
//      either. Pulled from OSM, filtered by size and to exclude anything
//      that's really just an interior freshwater lake.
// All pieces are unioned into one polygon, then checked against every
// saltwater canal near the edge of the network so an obviously-missed canal
// mouth shows up as a warning instead of a silent gap.

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');

// Hand-drawn band hugging the west side of Cape Coral: Matlacha Pass -> San
// Carlos Bay / the Gulf. Deliberately stops short of the river on the south
// and east (~lon -82.0) — that side comes from the real river centerline instead.
const handDrawnRing = [
  [-82.16, 26.78],
  [-82.24, 26.72],
  [-82.27, 26.6],
  [-82.24, 26.48],
  [-82.14, 26.4],
  [-82.0, 26.42],
  [-81.98, 26.5],
  [-82.0, 26.545],
  [-82.03, 26.55],
  [-82.045, 26.6],
  [-82.055, 26.65],
  [-82.07, 26.7],
  [-82.09, 26.75],
  [-82.16, 26.78],
];
const handDrawn = turf.polygon([handDrawnRing]);

function isValidPolygonFeature(f) {
  const g = f.geometry;
  if (!g) return false;
  const rings = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!rings || rings.length === 0) return false;
  return rings.every(
    (poly) =>
      poly.length > 0 &&
      poly.every((ring) => ring.length >= 4 && ring.every((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))),
  );
}

// Land pocket the City boundary bulges into in the NE (Herons Glen golf
// course, Pine Shadows Airpark, wildlife-management land) — not canal
// territory, excluded from the buffered-boundary fringe so it doesn't paint
// "open water" over a golf course. Identified visually against the basemap
// in debug-preview.html.
const neLandPocket = turf.polygon([
  [
    [-81.98, 26.68],
    [-81.98, 26.8],
    [-81.85, 26.8],
    [-81.85, 26.68],
    [-81.98, 26.68],
  ],
]);

function buildCityBoundaryFringe() {
  const boundaryPath = path.join(ROOT, 'data/raw/city-boundary.geojson');
  if (!fs.existsSync(boundaryPath)) {
    console.warn('  WARNING: city-boundary.geojson not found — run npm run data:fetch-city first. Skipping boundary fringe.');
    return null;
  }
  const boundary = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
  const mainPolygon = boundary.features.reduce((biggest, f) =>
    turf.area(f) > turf.area(biggest) ? f : biggest,
  );

  const buffered = turf.buffer(mainPolygon, 450, { units: 'meters' });
  let fringe;
  try {
    fringe = turf.difference(turf.featureCollection([buffered, mainPolygon]));
  } catch (err) {
    console.warn('  WARNING: could not subtract city interior from buffer, using full buffer:', err.message);
    fringe = buffered;
  }
  try {
    fringe = turf.difference(turf.featureCollection([fringe, neLandPocket]));
  } catch (err) {
    console.warn('  WARNING: could not subtract NE land pocket:', err.message);
  }
  return fringe;
}

function buildRiverPolygon() {
  const linesPath = path.join(ROOT, 'data/raw/caloosahatchee-river-centerline.geojson');
  if (!fs.existsSync(linesPath)) {
    console.warn('  WARNING: caloosahatchee-river-centerline.geojson not found — run npm run data:fetch-osm first. Skipping river polygon.');
    return null;
  }
  const lines = JSON.parse(fs.readFileSync(linesPath, 'utf8'));
  if (lines.features.length === 0) return null;

  // The river narrows a lot upstream; buffer width is a rough average, generous
  // enough to reach real canal mouths on both banks near Cape Coral.
  const buffered = lines.features.map((f) => turf.buffer(f, 500, { units: 'meters' }));
  let union = buffered[0];
  for (let i = 1; i < buffered.length; i++) {
    union = turf.union(turf.featureCollection([union, buffered[i]]));
  }
  return union;
}

// Coves, marshes, and tidal preserves (e.g. Four Mile Cove Ecological
// Preserve) that sit *inside* the City boundary — the fringe above only
// covers water outside it, and missing these stranded a whole quadrant of
// real saltwater canals from the routing graph (see DATA_NOTES.md). Pulled
// from OSM natural=water/wetland, filtered to bodies big enough to be a real
// cove rather than an individual canal OSM also traces, and excluding
// anything that substantially overlaps the City's own FRESHWATER canal
// polygons — those are just OSM's independent trace of the same interior
// lake, not tidal water, and must not be treated as open water.
const MIN_AREA_M2 = 15000; // ~1.5 hectares; well above a single residential canal, below a real cove
const FRESHWATER_OVERLAP_THRESHOLD = 0.5; // fraction of the OSM polygon's area

function buildLargeWaterBodiesPolygon() {
  const waterPath = path.join(ROOT, 'data/raw/large-water-bodies.geojson');
  if (!fs.existsSync(waterPath)) {
    console.warn('  WARNING: large-water-bodies.geojson not found — run npm run data:fetch-osm first. Skipping.');
    return null;
  }
  const waterBodies = JSON.parse(fs.readFileSync(waterPath, 'utf8'));
  const canals = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/raw/canals.geojson'), 'utf8'));
  const freshCanals = canals.features.filter((f) => f.properties.WATER_TYPE === 'FRESH' && isValidPolygonFeature(f));

  const candidates = waterBodies.features.filter((f) => {
    if (!isValidPolygonFeature(f)) return false;
    let area;
    try {
      area = turf.area(f);
    } catch {
      return false;
    }
    if (area < MIN_AREA_M2) return false;

    let overlapArea = 0;
    for (const fresh of freshCanals) {
      try {
        if (!turf.booleanIntersects(f, fresh)) continue;
        const inter = turf.intersect(turf.featureCollection([f, fresh]));
        if (inter) overlapArea += turf.area(inter);
      } catch {
        // ignore malformed intersections, treat as no overlap
      }
    }
    return overlapArea / area < FRESHWATER_OVERLAP_THRESHOLD;
  });

  console.log(
    `  ${waterBodies.features.length} OSM water/wetland polygons -> ${candidates.length} kept after size + freshwater-overlap filtering`,
  );
  if (candidates.length === 0) return null;

  let union = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    try {
      union = turf.union(turf.featureCollection([union, candidates[i]]));
    } catch {
      // skip pieces that don't union cleanly rather than aborting the whole build
    }
  }
  return union;
}

// Sanity check, not a geometry builder: reports any saltwater canal whose polygon
// doesn't intersect the open-water boundary AND sits within a stone's throw of the
// overall saltwater-network extent (i.e. looks like it should be a network edge/mouth).
// Canals fully in the interior are expected to miss — they reach open water by
// routing through other canals, not by touching this polygon directly.
function reportLikelyMisses(waterPolygon) {
  const canals = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/raw/canals.geojson'), 'utf8'));
  const salt = canals.features.filter((f) => f.properties.WATER_TYPE === 'SALT' && isValidPolygonFeature(f));
  const overallBbox = turf.bbox(turf.featureCollection(salt));
  const edgeTolerance = 0.01; // degrees

  const misses = salt.filter((f) => {
    let intersects = false;
    try {
      intersects = turf.booleanIntersects(f, waterPolygon);
    } catch {
      return false; // malformed geometry, not a real signal either way
    }
    if (intersects) return false;
    const b = turf.bbox(f);
    const nearWestEdge = b[0] - overallBbox[0] < edgeTolerance;
    const nearSouthEdge = b[1] - overallBbox[1] < edgeTolerance;
    const nearEastEdge = overallBbox[2] - b[2] < edgeTolerance;
    const nearNorthEdge = overallBbox[3] - b[3] < edgeTolerance;
    return nearWestEdge || nearSouthEdge || nearEastEdge || nearNorthEdge;
  });

  if (misses.length > 0) {
    console.warn(
      `  NOTE: ${misses.length} saltwater canal(s) near the overall network edge don't touch the open-water polygon directly.`,
    );
    console.warn('  (Expected for interior canals that reach open water via routing, not direct contact — verified properly in build-network.js.)');
  } else {
    console.log('  All edge-adjacent saltwater canals touch the open-water polygon.');
  }
}

async function main() {
  console.log('Building open-water boundary...');

  const pieces = [handDrawn];
  const boundaryFringe = buildCityBoundaryFringe();
  if (boundaryFringe) pieces.push(boundaryFringe);
  const riverPolygon = buildRiverPolygon();
  if (riverPolygon) pieces.push(riverPolygon);
  const largeWaterBodies = buildLargeWaterBodiesPolygon();
  if (largeWaterBodies) pieces.push(largeWaterBodies);

  let combined = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    try {
      combined = turf.union(turf.featureCollection([combined, pieces[i]]));
    } catch (err) {
      console.warn(`  WARNING: could not union piece ${i} into open-water polygon, skipping it:`, err.message);
    }
  }

  const outFeature = turf.feature(combined.geometry, {
    name: 'Open water: Caloosahatchee River / Matlacha Pass / Gulf of Mexico',
    source:
      'City boundary fringe (buffered real City GIS boundary) + buffered OSM river centerline + hand-drawn Matlacha Pass/Gulf band + large OSM-traced coves/marshes inside city limits. Not a navigational boundary.',
  });
  const outGeojson = turf.featureCollection([outFeature]);

  reportLikelyMisses(combined);

  const outFile = 'data/raw/open-water.geojson';
  fs.mkdirSync(path.join(ROOT, 'data/raw'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(outGeojson));
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

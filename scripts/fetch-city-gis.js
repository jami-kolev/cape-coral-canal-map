// Pulls Canals, Bridges, Weirs, Channel Markers, and the City Boundary straight
// from Cape Coral's live ArcGIS REST services and writes them as WGS84 GeoJSON.
// Run with: npm run data:fetch-city

const fs = require('fs');
const path = require('path');
const { fetchAllFeaturesAsGeoJSON, getRecordCount } = require('./lib/arcgis');
const sources = require('./sources');

const ROOT = path.join(__dirname, '..');

async function fetchLayer(key, { layerUrl, outFile }) {
  const serverCount = await getRecordCount(layerUrl);
  const geojson = await fetchAllFeaturesAsGeoJSON(layerUrl);
  const pulled = geojson.features.length;

  if (pulled !== serverCount) {
    console.warn(
      `  WARNING: ${key} — server reports ${serverCount} records, pulled ${pulled}. ` +
        `Check pagination in scripts/lib/arcgis.js before trusting this layer.`,
    );
  }

  const outPath = path.join(ROOT, outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(geojson));
  console.log(`  ${key}: ${pulled} features -> ${outFile}`);
  return { key, count: pulled, outFile };
}

async function main() {
  console.log('Fetching City of Cape Coral GIS layers...');
  const results = [];
  for (const key of ['canals', 'bridges', 'weirs', 'channelMarkers', 'cityBoundary']) {
    results.push(await fetchLayer(key, sources[key]));
  }

  const manifestPath = path.join(ROOT, 'data/raw/city-gis-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ pulledAt: new Date().toISOString(), layers: results }, null, 2),
  );
  console.log('Done. Manifest written to data/raw/city-gis-manifest.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

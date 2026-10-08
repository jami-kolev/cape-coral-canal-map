// Single source of truth for every upstream endpoint the pipeline pulls from.
// Discovered by hand against the live services on 2026-09-23 — see DATA_NOTES.md
// for how each one was found and what it contains.

const CAPE_GIS_BASE = 'https://capeims.capecoral.gov/arcgis/rest/services/OpenData';

module.exports = {
  canals: {
    layerUrl: `${CAPE_GIS_BASE}/PublicWorks/MapServer/11`,
    outFile: 'data/raw/canals.geojson',
  },
  bridges: {
    layerUrl: `${CAPE_GIS_BASE}/PublicWorks/MapServer/0`,
    outFile: 'data/raw/bridges.geojson',
  },
  weirs: {
    layerUrl: `${CAPE_GIS_BASE}/PublicWorks/MapServer/18`,
    outFile: 'data/raw/weirs.geojson',
  },
  channelMarkers: {
    layerUrl: `${CAPE_GIS_BASE}/Marine/MapServer/0`,
    outFile: 'data/raw/channel-markers.geojson',
  },
  cityBoundary: {
    layerUrl: `${CAPE_GIS_BASE}/OpenData/MapServer/0`,
    outFile: 'data/raw/city-boundary.geojson',
  },
  overpassUrl: 'https://overpass-api.de/api/interpreter',
};

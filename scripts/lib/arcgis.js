// Shared helper for pulling full layers out of an ArcGIS REST MapServer/FeatureServer,
// paginating past the server's maxRecordCount so nothing gets silently truncated.

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`);
  }
  return res.json();
}

async function getLayerInfo(layerUrl) {
  return fetchJson(`${layerUrl}?f=json`);
}

async function getRecordCount(layerUrl, where = '1=1') {
  const url = `${layerUrl}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
  const json = await fetchJson(url);
  return json.count;
}

// Pulls every record as WGS84 GeoJSON, paging by objectIds so we never rely on the
// server's default sort order and never lose records to exceededTransferLimit.
async function fetchAllFeaturesAsGeoJSON(layerUrl, { where = '1=1', outFields = '*' } = {}) {
  const info = await getLayerInfo(layerUrl);
  const pageSize = info.maxRecordCount || 1000;

  const idsUrl = `${layerUrl}/query?where=${encodeURIComponent(where)}&returnIdsOnly=true&f=json`;
  const idsJson = await fetchJson(idsUrl);
  const objectIdField = idsJson.objectIdFieldName || 'OBJECTID';
  const allIds = (idsJson.objectIds || []).slice().sort((a, b) => a - b);

  const features = [];
  for (let i = 0; i < allIds.length; i += pageSize) {
    const chunk = allIds.slice(i, i + pageSize);
    const chunkWhere = `${objectIdField} IN (${chunk.join(',')})`;
    const url =
      `${layerUrl}/query?where=${encodeURIComponent(chunkWhere)}` +
      `&outFields=${encodeURIComponent(outFields)}&outSR=4326&f=geojson`;
    const page = await fetchJson(url);
    features.push(...(page.features || []));
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

module.exports = { fetchJson, getLayerInfo, getRecordCount, fetchAllFeaturesAsGeoJSON };

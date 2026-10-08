// Step 2 core logic: builds the canal adjacency graph, applies weirs as hard
// stops, attaches bridges, and precomputes the route from every saltwater
// canal to open water. Writes data/processed/routes.json + a network summary.
// Run with: npm run data:build-network (after data:fetch-city, data:fetch-osm,
// data:build-water have all run).

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const { CanalGraph } = require('./lib/graph');

const ROOT = path.join(__dirname, '..');
// How far a canal's outline may stop short of open water and still count as
// opening onto it. The City's outlines (drawn from parcel boundaries) end at
// the lot line, not the water's edge, so shoreline canals routinely stop short.
// At 0-60 m only 298 of 630 saltwater canals connect; at 100 m nearly all do,
// including every canal at the southeast river shore, and the one listing with
// a known real-world route (2501 SW 28th Terrace) doesn't move.
const OPEN_WATER_TOLERANCE_M = Number(process.env.OPEN_WATER_TOLERANCE_M || 100);
const NO_WAKE_SPEED_MPH = 5; // single config value per the spec; change here to retune all idle-time estimates

function loadGeoJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function orderBridgesAlongPath(pathNodeIds, graph) {
  // Walk the path; for each canal on it, order that canal's bridges by how far
  // along the entry->exit direction they sit, so a canal with two bridges lists
  // them in the order a boat would actually pass under them.
  const ordered = [];
  for (let i = 0; i < pathNodeIds.length; i++) {
    const node = graph.nodes[pathNodeIds[i]];
    if (node.bridges.length === 0) continue;

    const entry = i > 0 ? graph.nodes[pathNodeIds[i - 1]].centroid : node.centroid;
    const exit = i < pathNodeIds.length - 1 ? graph.nodes[pathNodeIds[i + 1]].centroid : node.centroid;
    const dirVec = [exit[0] - entry[0], exit[1] - entry[1]];

    const withProjection = node.bridges.map((b) => {
      const rel = [b.position[0] - entry[0], b.position[1] - entry[1]];
      const projection = rel[0] * dirVec[0] + rel[1] * dirVec[1];
      return { ...b, _projection: projection };
    });
    withProjection.sort((a, b) => a._projection - b._projection);
    withProjection.forEach(({ _projection, ...b }) => ordered.push({ ...b, canalName: node.name }));
  }
  return ordered;
}

// Drawing the route straight from canal center to canal center cuts corners
// across land. Instead it bends at the junction where each pair of canals
// meet, then finishes at the water's edge, so the line follows the canals.
function vertsOf(feature) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out = [];
  for (const poly of polys) for (const ring of poly) for (const pt of ring) out.push(pt);
  return out;
}

function nearestPair(vertsA, vertsB) {
  let best = { d: Infinity, a: null, b: null };
  for (const a of vertsA) {
    for (const b of vertsB) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const d = dx * dx + dy * dy;
      if (d < best.d) best = { d, a, b };
    }
  }
  return best;
}

const jointCache = new Map();
function jointBetween(a, b) {
  const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
  if (jointCache.has(key)) return jointCache.get(key);
  let joint;
  try {
    const inter = turf.intersect(turf.featureCollection([a.feature, b.feature]));
    if (inter) joint = turf.centroid(inter).geometry.coordinates;
  } catch {
    // fall through to nearest-vertex
  }
  if (!joint) {
    const { a: pa, b: pb } = nearestPair(vertsOf(a.feature), vertsOf(b.feature));
    joint = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
  }
  jointCache.set(key, joint);
  return joint;
}

let openWaterVerts = null;
function endInOpenWater(node, openWaterGeoJSON) {
  if (!openWaterVerts) openWaterVerts = vertsOf(openWaterGeoJSON.features[0]);
  const pad = 0.004;
  const [minX, minY, maxX, maxY] = node.bbox;
  const nearby = openWaterVerts.filter((v) => v[0] > minX - pad && v[0] < maxX + pad && v[1] > minY - pad && v[1] < maxY + pad);
  if (nearby.length === 0) return null;
  return nearestPair(vertsOf(node.feature), nearby).b;
}

function buildRouteLine(pathNodeIds, graph, openWaterGeoJSON) {
  const nodes = pathNodeIds.map((id) => graph.nodes[id]);
  // Junction to junction. Detouring through each canal's center point as
  // well made a canal whose two junctions sit at the same end look like an
  // out-and-back spur, inflating distance and idle time.
  const line = [nodes[0].centroid];
  for (let i = 1; i < nodes.length; i++) {
    line.push(jointBetween(nodes[i - 1], nodes[i]));
  }
  const end = endInOpenWater(nodes[nodes.length - 1], openWaterGeoJSON);
  if (end) line.push(end);
  return line;
}

function summarizeRoute(pathNodeIds, graph, openWaterGeoJSON) {
  const routeLine = buildRouteLine(pathNodeIds, graph, openWaterGeoJSON);
  // A canal that itself touches open water is a path of one node/point — zero
  // travel distance, and there's no line to measure.
  const distanceKm = routeLine.length >= 2 ? turf.length(turf.lineString(routeLine), { units: 'kilometers' }) : 0;
  const distanceMiles = distanceKm * 0.621371;
  const bridges = orderBridgesAlongPath(pathNodeIds, graph);

  const recordedClearances = bridges.map((b) => b.clearanceFt).filter((c) => c != null);
  const lowestClearanceFt = recordedClearances.length > 0 ? Math.min(...recordedClearances) : null;

  const idleTimeMinutes = (distanceMiles / NO_WAKE_SPEED_MPH) * 60;

  return {
    distanceMiles: Math.round(distanceMiles * 100) / 100,
    lowestClearanceFt,
    hasUnrecordedClearanceBridge: bridges.some((b) => b.clearanceFt == null),
    idleTimeMinutes: Math.round(idleTimeMinutes),
    noWakeSpeedMph: NO_WAKE_SPEED_MPH,
    bridgeCount: bridges.length,
    bridges: bridges.map((b) => ({
      bridgeNumber: b.bridgeNumber,
      street: b.street,
      localName: b.localName,
      canalName: b.canalName,
      clearanceFt: b.clearanceFt,
    })),
    routeLine,
  };
}

async function main() {
  console.log('Loading layers...');
  const canalsGeoJSON = loadGeoJSON('data/raw/canals.geojson');
  const bridgesGeoJSON = loadGeoJSON('data/raw/bridges.geojson');
  const weirsGeoJSON = loadGeoJSON('data/raw/weirs.geojson');
  const openWaterGeoJSON = loadGeoJSON('data/raw/open-water.geojson');

  console.log('Building canal graph...');
  const graph = CanalGraph.fromFeatureCollection(canalsGeoJSON);
  if (graph.skipped > 0) {
    console.warn(`  WARNING: skipped ${graph.skipped} canal record(s) with malformed geometry`);
  }
  console.log(`  ${graph.nodes.length} canal nodes`);

  const { exactTouches, snapped } = graph.buildAdjacency();
  console.log(`  ${exactTouches} exact-touch adjacencies, ${snapped} snapped (within tolerance)`);

  const bridgeConnectResults = graph.connectViaBridges(bridgesGeoJSON);
  console.log(`  ${bridgeConnectResults.edgesAdded} additional canal-canal edges inferred from bridge crossings`);

  const weirResults = graph.applyWeirs(weirsGeoJSON);
  console.log(`  ${weirResults.blocked} canal-canal edges blocked by weirs`);
  if (weirResults.unmatched.length > 0) {
    console.warn(`  WARNING: ${weirResults.unmatched.length} weir(s) didn't cleanly match 2 canals:`);
    weirResults.unmatched.forEach((w) => console.warn(`    - ${w.canal}: ${w.reason}`));
  }

  const bridgeResults = graph.attachBridges(bridgesGeoJSON);
  console.log(
    `  Bridges: ${bridgeResults.matchedByName} matched by canal name, ${bridgeResults.matchedBySpatial} matched by location, ${bridgeResults.unmatched.length} unmatched, ${bridgeResults.skippedBlank} skipped (blank record)`,
  );
  if (bridgeResults.unmatched.length > 0) {
    bridgeResults.unmatched.forEach((b) =>
      console.warn(`    - unmatched bridge ${b.bridgeNumber} on "${b.canalName}" (${b.street})`),
    );
  }

  const openWaterTouchCount = graph.markOpenWaterTouching(openWaterGeoJSON, OPEN_WATER_TOLERANCE_M);
  console.log(`  ${openWaterTouchCount} canal nodes touch the open-water boundary`);

  // Flag saltwater canals directly adjacent to freshwater canals with no weir between them —
  // a real data inconsistency worth a human look, not something to silently route through.
  const crossTypeLeaks = [];
  for (const node of graph.nodes) {
    if (node.waterType !== 'SALT') continue;
    for (const [neighborId, edge] of node.neighbors) {
      const neighbor = graph.nodes[neighborId];
      if (neighbor.waterType === 'FRESH' && !edge.blockedByWeir && neighborId > node.id) {
        crossTypeLeaks.push(`${node.name} <-> ${neighbor.name}`);
      }
    }
  }
  if (crossTypeLeaks.length > 0) {
    console.warn(`  WARNING: ${crossTypeLeaks.length} SALT/FRESH canal pairs touch with no weir between them:`);
    crossTypeLeaks.forEach((s) => console.warn(`    - ${s}`));
  } else {
    console.log('  No unguarded salt/fresh boundaries found.');
  }

  console.log('Checking connectivity...');
  const components = graph.connectedComponents();
  console.log(`  ${components.length} connected components`);
  const fragments = components
    .map((comp) => ({
      size: comp.length,
      names: comp.slice(0, 5).map((id) => graph.nodes[id].name),
      waterTypes: [...new Set(comp.map((id) => graph.nodes[id].waterType))],
    }))
    .sort((a, b) => a.size - b.size);
  const smallFragments = fragments.filter((f) => f.size <= 3);
  if (smallFragments.length > 0) {
    console.warn(`  ${smallFragments.length} small fragment(s) (<=3 canals) worth a look:`);
    smallFragments.forEach((f) => console.warn(`    - size ${f.size}, ${f.waterTypes.join('/')}: ${f.names.join(', ')}`));
  }

  console.log('Computing routes to open water for every saltwater canal...');
  const routes = {};
  let reachable = 0;
  let unreachable = [];
  for (const node of graph.nodes) {
    if (node.waterType !== 'SALT') continue;
    if (node.touchesOpenWater) {
      routes[node.objectId] = {
        objectId: node.objectId,
        name: node.name,
        waterType: node.waterType,
        navSyst: node.navSyst,
        gulfAccess: true,
        ...summarizeRoute([node.id], graph, openWaterGeoJSON),
      };
      reachable++;
      continue;
    }
    const path = graph.shortestPathToOpenWater(node.id);
    if (path) {
      routes[node.objectId] = {
        objectId: node.objectId,
        name: node.name,
        waterType: node.waterType,
        navSyst: node.navSyst,
        gulfAccess: true,
        ...summarizeRoute(path, graph, openWaterGeoJSON),
      };
      reachable++;
    } else {
      // The City's own NAV_SYST field already assigns this canal to a named
      // spreader system (SW-A..E) — that classification is authoritative for
      // whether it has gulf access at all, even when a real gap in the ~1990s
      // source canal-boundary data (see DATA_NOTES.md) means our own graph
      // can't trace the physical path. Saying "no gulf access" here would be a
      // false negative — worse than admitting we can't detail the route.
      const cityClassifiedSpreaderSystem = /^SW-[A-E]$/.test(node.navSyst);
      routes[node.objectId] = {
        objectId: node.objectId,
        name: node.name,
        waterType: node.waterType,
        navSyst: node.navSyst,
        gulfAccess: cityClassifiedSpreaderSystem,
        routeDetailAvailable: false,
        routeDetailUnavailableReason: cityClassifiedSpreaderSystem
          ? 'Classified by the City as part of spreader system ' +
            node.navSyst +
            ', but a gap in the source canal boundary data kept us from tracing the exact route, bridges, or distance.'
          : 'No traceable route to open water and no City spreader-system classification on record.',
      };
      unreachable.push({ name: node.name, navSyst: node.navSyst, treatedAsGulfAccess: cityClassifiedSpreaderSystem });
    }
  }
  const gulfAccessNoRouteDetail = unreachable.filter((u) => u.treatedAsGulfAccess);
  const noGulfAccessAtAll = unreachable.filter((u) => !u.treatedAsGulfAccess);
  console.log(`  ${reachable} saltwater canals routed to open water with full route detail`);
  if (gulfAccessNoRouteDetail.length > 0) {
    console.warn(
      `  NOTE: ${gulfAccessNoRouteDetail.length} more are City-classified as gulf access (spreader system) but hit a source-data gap, so no bridge/distance detail:`,
    );
    gulfAccessNoRouteDetail.slice(0, 10).forEach((u) => console.warn(`    - ${u.name} (${u.navSyst})`));
    if (gulfAccessNoRouteDetail.length > 10) console.warn(`    ... and ${gulfAccessNoRouteDetail.length - 10} more`);
  }
  if (noGulfAccessAtAll.length > 0) {
    console.warn(`  WARNING: ${noGulfAccessAtAll.length} saltwater canal(s) have no route AND no spreader-system classification:`);
    noGulfAccessAtAll.forEach((u) => console.warn(`    - ${u.name} (${u.navSyst})`));
  }

  // Freshwater canals: report which basin/lake they belong to; no gulf route by definition.
  for (const node of graph.nodes) {
    if (node.waterType !== 'FRESH') continue;
    routes[node.objectId] = {
      objectId: node.objectId,
      name: node.name,
      waterType: node.waterType,
      navSyst: node.navSyst,
      basin: node.basin,
      gulfAccess: false,
    };
  }

  fs.mkdirSync(path.join(ROOT, 'data/processed'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/processed/routes.json'), JSON.stringify(routes));

  const summary = {
    builtAt: new Date().toISOString(),
    noWakeSpeedMph: NO_WAKE_SPEED_MPH,
    canalNodeCount: graph.nodes.length,
    connectedComponents: components.length,
    smallFragments,
    weirEdgesBlocked: weirResults.blocked,
    weirsUnmatched: weirResults.unmatched,
    bridgesUnmatched: bridgeResults.unmatched,
    crossTypeLeaks,
    saltCanalsWithFullRouteDetail: reachable,
    saltCanalsGulfAccessNoRouteDetail: gulfAccessNoRouteDetail,
    saltCanalsNoGulfAccessAtAll: noGulfAccessAtAll,
  };
  fs.writeFileSync(path.join(ROOT, 'data/processed/network-summary.json'), JSON.stringify(summary, null, 1));
  console.log('Wrote data/processed/routes.json and data/processed/network-summary.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

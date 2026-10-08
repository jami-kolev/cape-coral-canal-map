// Builds the canal adjacency graph and runs shortest-path routing to open water.
// Nodes are canal polygons (one per NAME, mostly — see DATA_NOTES.md); edges are
// places where two canal polygons physically touch. Weirs cut edges (hard stop);
// bridges attach to nodes as waypoints.

const turf = require('@turf/turf');

const SNAP_TOLERANCE_DEGREES = 0.00006; // ~6-7m, for polygons that nearly-but-don't-quite touch
const WEIR_SEARCH_RADIUS_METERS = 150; // weir structures often leave a real gap of several dozen meters in the source polygons
const BRIDGE_SEARCH_RADIUS_METERS = 80;
const BRIDGE_CONNECT_RADIUS_METERS = 130; // canals split by a street crossing often don't touch in the source polygons at all

function isValidPolygonFeature(f) {
  const g = f && f.geometry;
  if (!g) return false;
  const rings = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!rings || rings.length === 0) return false;
  return rings.every(
    (poly) =>
      poly.length > 0 &&
      poly.every((ring) => ring.length >= 4 && ring.every((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))),
  );
}

function bboxesOverlap(a, b, pad = 0) {
  return a[0] - pad <= b[2] + pad && a[2] + pad >= b[0] - pad && a[1] - pad <= b[3] + pad && a[3] + pad >= b[1] - pad;
}

class CanalGraph {
  constructor(canalFeatures) {
    this.nodes = canalFeatures.map((f, i) => ({
      id: i,
      objectId: f.properties.OBJECTID,
      name: f.properties.NAME,
      waterType: f.properties.WATER_TYPE,
      navSyst: f.properties.NAV_SYST,
      basin: f.properties.Basin,
      feature: f,
      bbox: turf.bbox(f),
      centroid: turf.centroid(f).geometry.coordinates,
      bridges: [],
      neighbors: new Map(), // neighborId -> { distanceKm, blockedByWeir }
    }));
    this.skipped = canalFeatures.length; // overwritten below once we know how many were valid
  }

  static fromFeatureCollection(canalsGeoJSON) {
    const valid = canalsGeoJSON.features.filter(isValidPolygonFeature);
    const skippedCount = canalsGeoJSON.features.length - valid.length;
    const graph = new CanalGraph(valid);
    graph.skipped = skippedCount;
    return graph;
  }

  buildAdjacency(snapToleranceDegrees = SNAP_TOLERANCE_DEGREES) {
    const n = this.nodes.length;
    let exactTouches = 0;
    let snapped = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        if (!bboxesOverlap(a.bbox, b.bbox, snapToleranceDegrees)) continue;

        let touches = false;
        try {
          touches = turf.booleanIntersects(a.feature, b.feature);
        } catch {
          continue;
        }
        let viaSnap = false;
        if (!touches) {
          // near-miss: buffer both a hair and re-test, to catch small digitization gaps
          try {
            const bufA = turf.buffer(a.feature, snapToleranceDegrees, { units: 'degrees' });
            touches = turf.booleanIntersects(bufA, b.feature);
            viaSnap = touches;
          } catch {
            continue;
          }
        }
        if (touches) {
          const distanceKm = turf.distance(a.centroid, b.centroid, { units: 'kilometers' });
          a.neighbors.set(b.id, { distanceKm, blockedByWeir: false });
          b.neighbors.set(a.id, { distanceKm, blockedByWeir: false });
          if (viaSnap) snapped++;
          else exactTouches++;
        }
      }
    }
    return { exactTouches, snapped };
  }

  applyWeirs(weirsGeoJSON) {
    const results = { blocked: 0, unmatched: [] };
    for (const weir of weirsGeoJSON.features) {
      const pt = weir.geometry;
      if (!pt || pt.type !== 'Point') continue;
      const buffered = turf.buffer(weir, WEIR_SEARCH_RADIUS_METERS, { units: 'meters' });
      const touching = this.nodes.filter((node) => {
        try {
          return turf.booleanIntersects(buffered, node.feature);
        } catch {
          return false;
        }
      });

      if (touching.length < 2) {
        results.unmatched.push({ canal: weir.properties.CANAL, reason: `found ${touching.length} touching canal(s)` });
        continue;
      }
      // Weirs exist specifically to separate fresh water from salt water (per the
      // layer's own description) — only cut edges between DIFFERENT water types.
      // With a generous search radius, a weir can end up near 3+ canals (e.g. the
      // salt/fresh transition on one canal plus an unrelated salt neighbor); cutting
      // every pair among them would wrongly sever real salt-to-salt connections.
      for (let i = 0; i < touching.length; i++) {
        for (let j = i + 1; j < touching.length; j++) {
          const a = touching[i];
          const b = touching[j];
          if (a.waterType === b.waterType) continue;
          if (a.neighbors.has(b.id)) {
            a.neighbors.get(b.id).blockedByWeir = true;
            b.neighbors.get(a.id).blockedByWeir = true;
            results.blocked++;
          }
        }
      }
    }
    return results;
  }

  // Cape Coral's canal polygons were digitized by inverting parcel boundaries
  // (see DATA_NOTES.md), which routinely leaves a real gap — the width of the
  // street right-of-way — between two canals that a bridge actually connects.
  // Wherever the City recorded a bridge, use it as authoritative evidence that
  // every canal near that bridge is physically connected, even if their
  // polygons don't touch. This is deliberately more conservative than just
  // widening the snap tolerance everywhere, which would risk bridging gaps
  // between canals that were never meant to connect.
  connectViaBridges(bridgesGeoJSON) {
    const results = { edgesAdded: 0 };
    for (const bridge of bridgesGeoJSON.features) {
      if (!bridge.geometry || !bridge.geometry.coordinates || bridge.geometry.coordinates.length === 0) continue;
      const buffered = turf.buffer(bridge, BRIDGE_CONNECT_RADIUS_METERS, { units: 'meters' });
      const nearby = this.nodes.filter((node) => {
        try {
          return turf.booleanIntersects(buffered, node.feature);
        } catch {
          return false;
        }
      });
      for (let i = 0; i < nearby.length; i++) {
        for (let j = i + 1; j < nearby.length; j++) {
          const a = nearby[i];
          const b = nearby[j];
          if (a.waterType !== b.waterType) continue; // bridges don't override the fresh/salt boundary
          if (a.neighbors.has(b.id)) continue; // already connected directly
          const distanceKm = turf.distance(a.centroid, b.centroid, { units: 'kilometers' });
          a.neighbors.set(b.id, { distanceKm, blockedByWeir: false, viaBridge: true });
          b.neighbors.set(a.id, { distanceKm, blockedByWeir: false, viaBridge: true });
          results.edgesAdded++;
        }
      }
    }
    return results;
  }

  attachBridges(bridgesGeoJSON) {
    const results = { matchedByName: 0, matchedBySpatial: 0, unmatched: [], skippedBlank: 0 };
    const byName = new Map();
    for (const node of this.nodes) {
      const key = (node.name || '').trim().toUpperCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(node);
    }

    for (const bridge of bridgesGeoJSON.features) {
      if (!bridge.geometry || !bridge.geometry.coordinates || bridge.geometry.coordinates.length === 0) {
        results.skippedBlank++;
        continue;
      }
      const canalName = (bridge.properties.CANAL_NAME || '').trim().toUpperCase();
      let candidates = byName.get(canalName) || [];

      if (candidates.length === 0) {
        // fall back to spatial proximity
        const buffered = turf.buffer(bridge, BRIDGE_SEARCH_RADIUS_METERS, { units: 'meters' });
        candidates = this.nodes.filter((node) => {
          try {
            return turf.booleanIntersects(buffered, node.feature);
          } catch {
            return false;
          }
        });
        if (candidates.length > 0) results.matchedBySpatial++;
      } else {
        results.matchedByName++;
      }

      if (candidates.length === 0) {
        results.unmatched.push({
          bridgeNumber: bridge.properties.BRIDGE_NUMBER,
          canalName: bridge.properties.CANAL_NAME,
          street: bridge.properties.Street,
        });
        continue;
      }

      // Position along the bridge line, used later to order multiple bridges on one canal.
      const midpoint = turf.center(bridge).geometry.coordinates;

      // Some canal names repeat across disconnected segments (see DATA_NOTES.md).
      // When a name match returns more than one candidate, keep only the one the
      // bridge geometry actually sits closest to, instead of attaching it to both.
      if (candidates.length > 1) {
        candidates = [
          candidates.reduce((closest, node) =>
            turf.distance(midpoint, node.centroid) < turf.distance(midpoint, closest.centroid) ? node : closest,
          ),
        ];
      }

      for (const node of candidates) {
        node.bridges.push({
          bridgeNumber: bridge.properties.BRIDGE_NUMBER,
          street: bridge.properties.Street,
          localName: bridge.properties.LocalName,
          clearanceFt:
            typeof bridge.properties.VerticalClearance === 'number' && bridge.properties.VerticalClearance > 0
              ? bridge.properties.VerticalClearance
              : null,
          navigable: bridge.properties.Navigable,
          position: midpoint,
        });
      }
    }
    return results;
  }

  markOpenWaterTouching(openWaterGeoJSON) {
    let count = 0;
    for (const node of this.nodes) {
      try {
        node.touchesOpenWater = turf.booleanIntersects(node.feature, openWaterGeoJSON.features[0]);
      } catch {
        node.touchesOpenWater = false;
      }
      if (node.touchesOpenWater) count++;
    }
    return count;
  }

  // Connected components, ignoring weir-blocked edges.
  connectedComponents() {
    const visited = new Set();
    const components = [];
    for (const node of this.nodes) {
      if (visited.has(node.id)) continue;
      const component = [];
      const stack = [node.id];
      visited.add(node.id);
      while (stack.length) {
        const currentId = stack.pop();
        component.push(currentId);
        const current = this.nodes[currentId];
        for (const [neighborId, edge] of current.neighbors) {
          if (edge.blockedByWeir || visited.has(neighborId)) continue;
          visited.add(neighborId);
          stack.push(neighborId);
        }
      }
      components.push(component);
    }
    return components;
  }

  // Dijkstra from a single canal node to the nearest node that touches open water.
  // Returns null if unreachable.
  shortestPathToOpenWater(startId) {
    const dist = new Map([[startId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = new Set([startId]);

    while (queue.size) {
      let currentId = null;
      let currentDist = Infinity;
      for (const id of queue) {
        if (dist.get(id) < currentDist) {
          currentDist = dist.get(id);
          currentId = id;
        }
      }
      queue.delete(currentId);
      visited.add(currentId);

      const currentNode = this.nodes[currentId];
      if (currentNode.touchesOpenWater) {
        return this._reconstructPath(prev, currentId);
      }

      for (const [neighborId, edge] of currentNode.neighbors) {
        if (edge.blockedByWeir || visited.has(neighborId)) continue;
        const candidateDist = currentDist + edge.distanceKm;
        if (candidateDist < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, candidateDist);
          prev.set(neighborId, currentId);
          queue.add(neighborId);
        }
      }
    }
    return null;
  }

  _reconstructPath(prev, endId) {
    const path = [endId];
    let current = endId;
    while (prev.has(current)) {
      current = prev.get(current);
      path.unshift(current);
    }
    return path;
  }
}

module.exports = { CanalGraph, isValidPolygonFeature };

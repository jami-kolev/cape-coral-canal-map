(function () {
  'use strict';

  const CFG = window.APP_CONFIG;

  // ---------------------------------------------------------------------
  // Map + base layers
  // ---------------------------------------------------------------------

  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(
    CFG.INITIAL_CENTER,
    CFG.INITIAL_ZOOM,
  );
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // Esri's free World Light Gray Canvas: a clean, muted basemap with no API
  // key required (CARTO's equivalent free tiles now require a key — verified
  // live before picking this). Base + reference (labels) layered per Esri's
  // usual pattern for this basemap.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, attribution: 'Basemap &copy; Esri' },
  ).addTo(map);
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, pane: 'shadowPane' },
  ).addTo(map);

  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" title="A JS library for interactive maps">Leaflet</a>',
  );

  // ---------------------------------------------------------------------
  // Panel management (legend / layers / detail / disclaimer share one rule:
  // opening one closes the others)
  // ---------------------------------------------------------------------

  const panels = ['legend-panel', 'layers-panel', 'detail-panel', 'disclaimer-panel'].map((id) =>
    document.getElementById(id),
  );

  function closeAllPanels() {
    // `inert` keeps a closed panel's controls out of tab order and the
    // accessibility tree — without it, a CSS-transformed-offscreen panel is
    // still focusable, so keyboard users could tab into invisible buttons.
    panels.forEach((p) => {
      p.classList.remove('open');
      p.setAttribute('inert', '');
    });
    document.getElementById('legend-toggle').setAttribute('aria-expanded', 'false');
    document.getElementById('layers-toggle').setAttribute('aria-expanded', 'false');
  }

  function openPanel(id) {
    closeAllPanels();
    const panel = document.getElementById(id);
    panel.classList.add('open');
    panel.removeAttribute('inert');
    // Move focus into the panel so keyboard/screen-reader users land
    // somewhere sensible instead of staying on a now-offscreen trigger.
    const heading = panel.querySelector('.panel-close');
    if (heading) heading.focus();
  }

  document.querySelectorAll('[data-close-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAllPanels();
      if (btn.dataset.closePanel === 'detail-panel') deselectCanal();
    });
  });

  function deselectCanal() {
    if (state.selectedCanalLayer) {
      state.selectedCanalLayer.setStyle(canalStyle(state.selectedCanalLayer.feature));
      state.selectedCanalLayer = null;
    }
    state.highlightLayer.clearLayers();
  }

  document.getElementById('legend-toggle').addEventListener('click', (e) => {
    const willOpen = !document.getElementById('legend-panel').classList.contains('open');
    if (willOpen) {
      openPanel('legend-panel');
      e.currentTarget.setAttribute('aria-expanded', 'true');
    } else {
      closeAllPanels();
    }
  });
  document.getElementById('layers-toggle').addEventListener('click', (e) => {
    const willOpen = !document.getElementById('layers-panel').classList.contains('open');
    if (willOpen) {
      openPanel('layers-panel');
      e.currentTarget.setAttribute('aria-expanded', 'true');
    } else {
      closeAllPanels();
    }
  });
  document.getElementById('disclaimer-toggle').addEventListener('click', () => openPanel('disclaimer-panel'));

  // ---------------------------------------------------------------------
  // Styling helpers
  // ---------------------------------------------------------------------

  function canalStyle(feature) {
    const isSalt = feature.properties.waterType === 'SALT';
    const color = isSalt ? '#5d82a3' : '#7a9b76';
    return {
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.55,
      opacity: 0.8,
    };
  }

  function clearanceColor(clearanceFt) {
    if (clearanceFt == null) return '#9a968d';
    if (clearanceFt >= 9) return '#33546c';
    if (clearanceFt >= 6) return '#c98a3e';
    return '#a4503a';
  }

  function clearanceLabel(clearanceFt) {
    if (clearanceFt == null) return 'Not recorded';
    return `${clearanceFt} ft`;
  }

  // ---------------------------------------------------------------------
  // Data loading + layers
  // ---------------------------------------------------------------------

  const state = {
    canalLayer: null,
    canalLayerById: new Map(),
    bridgeLayer: null,
    weirLayer: null,
    amenityLayer: null,
    routesCache: null,
    routesPromise: null,
    highlightLayer: L.layerGroup().addTo(map),
    searchMarker: null,
    selectedCanalLayer: null,
  };

  function fetchJSON(path) {
    return fetch(path).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
      return r.json();
    });
  }

  function loadRoutes() {
    if (state.routesCache) return Promise.resolve(state.routesCache);
    if (!state.routesPromise) {
      state.routesPromise = fetchJSON('data/routes.json').then((data) => {
        state.routesCache = data;
        return data;
      });
    }
    return state.routesPromise;
  }

  Promise.all([
    fetchJSON('data/open-water.json'),
    fetchJSON('data/city-boundary.json'),
    fetchJSON('data/canals.json'),
    fetchJSON('data/bridges.json'),
    fetchJSON('data/weirs.json'),
    fetchJSON('data/amenities.json'),
  ])
    .then(([openWater, cityBoundary, canals, bridges, weirs, amenities]) => {
      L.geoJSON(openWater, {
        interactive: false,
        style: { color: '#a9c7d8', weight: 1, fillColor: '#cfe4ee', fillOpacity: 0.45 },
      }).addTo(map);

      L.geoJSON(cityBoundary, {
        interactive: false,
        style: { color: '#191919', weight: 1, fill: false, dashArray: '3 5', opacity: 0.35 },
      }).addTo(map);

      state.canalLayer = L.geoJSON(canals, {
        style: canalStyle,
        onEachFeature: (feature, layer) => {
          state.canalLayerById.set(feature.properties.id, layer);
          layer.on('click', () => showCanalDetail(feature, layer));
        },
      }).addTo(map);

      // Bridges are LineStrings (a short line across the canal), not Points, so
      // L.geoJSON's pointToLayer option (which only fires for Point geometries)
      // can't be used to render them as clearance-colored dots. Built manually
      // instead: one circleMarker per bridge at the midpoint of its line.
      state.bridgeLayer = L.layerGroup(
        bridges.features
          .filter((f) => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 0)
          .map((feature) => {
            const latlng = midpointOfLine(feature.geometry);
            const marker = bridgeMarkerAt(feature, latlng);
            marker.on('click', () => showBridgePopup(feature, marker));
            return marker;
          }),
      ).addTo(map);

      state.weirLayer = L.geoJSON(weirs, {
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 6,
            weight: 2,
            color: '#ffffff',
            fillColor: '#191919',
            fillOpacity: 1,
            className: 'weir-marker-icon',
          }),
        onEachFeature: (feature, layer) => {
          layer.on('click', () => showWeirPopup(feature, layer));
        },
      }).addTo(map);

      state.amenityLayer = L.geoJSON(amenities, {
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 6,
            weight: 2,
            color: '#ffffff',
            fillColor: feature.properties.category === 'fuel' ? '#8b5fa3' : '#3f7d6b',
            fillOpacity: 1,
            className: 'amenity-marker-icon',
          }),
        onEachFeature: (feature, layer) => {
          layer.on('click', () => showAmenityPopup(feature, layer));
        },
      }).addTo(map);

      wireLayerToggles();
    })
    .catch((err) => {
      console.error(err);
      showSearchStatus('The map data did not load. Try refreshing the page.');
    });

  function midpointOfLine(geometry) {
    const coords = geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }

  function bridgeMarkerAt(feature, latlng) {
    return L.circleMarker(latlng, {
      radius: 6,
      weight: 2,
      color: '#ffffff',
      fillColor: clearanceColor(feature.properties.clearanceFt),
      fillOpacity: 1,
      className: 'bridge-marker-icon',
    });
  }

  function wireLayerToggles() {
    const map_ = {
      'toggle-canals': state.canalLayer,
      'toggle-bridges': state.bridgeLayer,
      'toggle-weirs': state.weirLayer,
      'toggle-amenities': state.amenityLayer,
    };
    Object.entries(map_).forEach(([checkboxId, layer]) => {
      document.getElementById(checkboxId).addEventListener('change', (e) => {
        if (e.target.checked) map.addLayer(layer);
        else map.removeLayer(layer);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Canal detail panel
  // ---------------------------------------------------------------------

  function navSystLabel(navSyst) {
    if (!navSyst) return null;
    if (navSyst.startsWith('SW-') && navSyst !== 'SW-Unspecified') return `Spreader System ${navSyst.slice(3)}`;
    return null;
  }

  function showCanalDetail(feature, layer) {
    highlightFeature(layer);
    map.fitBounds(layer.getBounds(), { maxZoom: 16, padding: [40, 40] });

    document.getElementById('detail-title').textContent = feature.properties.name || 'Canal';
    const body = document.getElementById('detail-body');
    body.innerHTML = '<p>Loading route details...</p>';
    openPanel('detail-panel');

    loadRoutes()
      .then((routes) => renderCanalDetail(feature, routes[feature.properties.id]))
      .catch(() => {
        body.innerHTML = '<p>We couldn’t load the route detail right now. Try again in a moment.</p>';
      });
  }

  function renderCanalDetail(feature, route) {
    const p = feature.properties;
    const isSalt = p.waterType === 'SALT';
    const body = document.getElementById('detail-body');
    const parts = [];

    parts.push(`<div class="detail-kicker">${isSalt ? 'Saltwater canal' : 'Freshwater canal'}</div>`);

    const sysLabel = navSystLabel(p.navSyst);
    if (isSalt && sysLabel) {
      parts.push(`<p>Part of the City’s ${sysLabel}.</p>`);
    }
    if (!isSalt && route && route.basin) {
      parts.push(`<p>Drains to freshwater basin ${route.basin}.</p>`);
    }

    parts.push(
      '<p style="font-size:13px;color:#6b6b6b;">Depth: not surveyed. The City doesn’t publish canal-by-canal depth records.</p>',
    );

    if (!isSalt) {
      parts.push(
        '<div class="data-gap-note">No boat route to the Gulf. Freshwater canals are held back by weirs and used for irrigation, not Gulf access.</div>',
      );
    } else if (route && route.routeLine) {
      parts.push(renderRouteDetail(route));
      drawRouteLine(route.routeLine);
    } else if (route && route.gulfAccess) {
      parts.push(
        `<div class="data-gap-note">This canal is classified by the City as part of the saltwater spreader system, so it does reach the Gulf. We don’t have a clean traced route for it yet, a gap in older City map data. Want us to confirm the exact route, bridges, and clearances for you?</div>`,
      );
    }

    parts.push(`
      <div class="cta-box">
        <p>Want us to confirm this route on the water? Send us the address.</p>
        <a class="cta-button" href="${CFG.CTA_URL}" target="_blank" rel="noopener">Ask The Kolev Group</a>
      </div>
      <p class="disclaimer-note">
        Reference data from City of Cape Coral records, not a survey. Clearances are approximate and not tide
        specific. Verify the route, every bridge, depth, seawall, and Gulf access with a surveyor, a marine
        contractor, and the City before making an offer.
      </p>
    `);

    body.innerHTML = parts.join('\n');
  }

  function renderRouteDetail(route) {
    const bridgeItems = route.bridges
      .map((b) => {
        const color = clearanceColor(b.clearanceFt);
        const label = clearanceLabel(b.clearanceFt);
        const name = b.street || b.localName || `Bridge ${b.bridgeNumber || ''}`.trim();
        return `<li><span>${name}</span><span class="clearance-badge" style="background:${color}">${label}</span></li>`;
      })
      .join('');

    const unrecordedNote = route.hasUnrecordedClearanceBridge
      ? '<p style="font-size:13px;color:#6b6b6b;">One or more bridges on this route don’t have a recorded clearance. Verify clearance in person before running it.</p>'
      : '';

    return `
      <div class="detail-stat-grid">
        <div class="detail-stat"><div class="label">Distance to open water</div><div class="value">${route.distanceMiles} mi</div></div>
        <div class="detail-stat"><div class="label">Est. idle time</div><div class="value">${route.idleTimeMinutes} min</div></div>
        <div class="detail-stat"><div class="label">Lowest clearance</div><div class="value">${clearanceLabel(route.lowestClearanceFt)}</div></div>
        <div class="detail-stat"><div class="label">Bridges on route</div><div class="value">${route.bridges.length}</div></div>
      </div>
      <p style="font-size:13px;color:#6b6b6b;">Idle time is estimated at a ${route.noWakeSpeedMph} mph no-wake speed. Real conditions vary.</p>
      ${route.bridges.length ? `<h3 style="font-family:var(--font-headline);font-size:18px;margin:14px 0 4px;color:var(--deep-water);">Bridges, in order</h3><ul class="bridge-list">${bridgeItems}</ul>` : ''}
      ${unrecordedNote}
    `;
  }

  function drawRouteLine(routeLineCoords) {
    if (!routeLineCoords || routeLineCoords.length < 2) return;
    const latlngs = routeLineCoords.map((c) => [c[1], c[0]]);
    L.polyline(latlngs, {
      color: '#191919',
      weight: 3,
      dashArray: '2 8',
      opacity: 0.9,
      interactive: false,
    }).addTo(state.highlightLayer);
  }

  function highlightFeature(layer) {
    state.highlightLayer.clearLayers();
    if (state.selectedCanalLayer && state.selectedCanalLayer !== layer) {
      state.selectedCanalLayer.setStyle(canalStyle(state.selectedCanalLayer.feature));
    }
    layer.setStyle({ color: '#191919', weight: 3, fillOpacity: 0.7 });
    layer.bringToFront();
    state.selectedCanalLayer = layer;
  }

  // ---------------------------------------------------------------------
  // Bridge / weir / amenity popups
  // ---------------------------------------------------------------------

  function showBridgePopup(feature, layer) {
    const p = feature.properties;
    const html = `
      <h3>${p.street || 'Bridge'}</h3>
      <p>Canal: ${p.canalName || 'Unknown'}</p>
      <p>Clearance: ${clearanceLabel(p.clearanceFt)}</p>
      ${p.navigable === 'NO' ? '<p>Not navigable.</p>' : ''}
    `;
    layer.bindPopup(html).openPopup();
  }

  function showWeirPopup(feature, layer) {
    const p = feature.properties;
    const html = `
      <h3>Weir</h3>
      <p>Canal: ${p.canal || 'Unknown'}</p>
      <p>Location: ${p.location || 'Not recorded'}</p>
      <p>Type: ${p.structureType || p.type || 'Not recorded'}</p>
      <p style="font-size:12px;color:#6b6b6b;">Weirs hold back freshwater from the saltwater canal system. A route can never pass through one.</p>
    `;
    layer.bindPopup(html).openPopup();
  }

  function showAmenityPopup(feature, layer) {
    const p = feature.properties;
    const label = p.category === 'fuel' ? 'Fuel' : p.category === 'marina' ? 'Marina' : 'Boat ramp';
    const html = `<h3>${p.name || label}</h3><p>${label}</p>`;
    layer.bindPopup(html).openPopup();
  }

  // ---------------------------------------------------------------------
  // Address search
  // ---------------------------------------------------------------------

  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const searchStatus = document.getElementById('search-status');

  function showSearchStatus(message) {
    searchStatus.textContent = message;
    searchStatus.classList.add('visible');
  }

  function clearSearchStatus() {
    searchStatus.classList.remove('visible');
    searchStatus.textContent = '';
  }

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    runSearch(query);
  });

  function runSearch(query) {
    showSearchStatus('Looking that up...');
    const [south, west, north, east] = CFG.SEARCH_BOUNDS;
    const params = new URLSearchParams({
      q: `${query}, Cape Coral, FL`,
      format: 'json',
      limit: '1',
      viewbox: `${west},${north},${east},${south}`,
      bounded: '1',
    });

    fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    })
      .then((r) => r.json())
      .then((results) => {
        if (!results.length) {
          showSearchStatus('We couldn’t find that address. Try adding the ZIP code.');
          return;
        }
        handleSearchResult(results[0]);
      })
      .catch(() => {
        showSearchStatus('Search is not responding right now. Try again in a moment.');
      });
  }

  function handleSearchResult(result) {
    const latlng = L.latLng(parseFloat(result.lat), parseFloat(result.lon));

    if (state.searchMarker) map.removeLayer(state.searchMarker);
    state.searchMarker = L.circleMarker(latlng, {
      radius: 7,
      weight: 2,
      color: '#ffffff',
      fillColor: '#191919',
      fillOpacity: 1,
    }).addTo(map);

    if (!state.canalLayer) {
      showSearchStatus('The map is still loading. Try again in a moment.');
      return;
    }

    const canalsGeoJSON = state.canalLayer.toGeoJSON();
    const nearest = findNearestCanal(latlng, canalsGeoJSON);

    if (!nearest || nearest.distanceMeters > CFG.MAX_CANAL_SEARCH_DISTANCE_METERS) {
      map.setView(latlng, 17);
      showSearchStatus(
        'That address doesn’t look like it’s on a mapped canal. If you think this is wrong, send us the address and we’ll take a look.',
      );
      return;
    }

    clearSearchStatus();
    const layer = state.canalLayerById.get(nearest.feature.properties.id);
    if (layer) {
      showCanalDetail(nearest.feature, layer);
    }
  }
})();

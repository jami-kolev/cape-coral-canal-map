// Single place to edit the handful of values that might change without
// touching the rest of the app.
window.APP_CONFIG = {
  CTA_URL: 'https://thekolevgroup.com/contact',

  // Restricts address search (Nominatim) to Cape Coral. [south, west, north, east]
  SEARCH_BOUNDS: [26.52, -82.10, 26.78, -81.88],

  // Center/zoom for the initial map view.
  INITIAL_CENTER: [26.63, -82.0],
  INITIAL_ZOOM: 12,

  // If the nearest canal to a searched address is farther than this, we tell
  // the user it doesn't look like a waterfront address rather than silently
  // pointing at something far away.
  MAX_CANAL_SEARCH_DISTANCE_METERS: 150,
};

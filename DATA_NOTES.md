# Data notes

How to refresh everything:

```bash
npm run data:refresh
```

That runs, in order: `data:fetch-city` (City of Cape Coral GIS), `data:fetch-osm`
(OpenStreetMap ramps/marinas/fuel + the Caloosahatchee River centerline),
`data:build-water` (open-water boundary), `data:build-network` (canal graph +
routing). Each step writes to `data/raw/` or `data/processed/` and can also be
run on its own — see the `scripts` section of `package.json`.

Data pulled: **2026-09-23**.

## Sources

### City of Cape Coral GIS (ArcGIS REST)

Found via the public open-data portal at
[capecoral-capegis.opendata.arcgis.com](https://capecoral-capegis.opendata.arcgis.com),
which points at the City's live ArcGIS Server at `capeims.capecoral.gov`. No
API key needed. Real endpoint URLs, discovered by reading the portal's
`data.json` (DCAT feed) and each layer's own `?f=json` metadata:

| Layer | Endpoint | Records pulled | Geometry |
|---|---|---|---|
| Canals | `https://capeims.capecoral.gov/arcgis/rest/services/OpenData/PublicWorks/MapServer/11` | 960 | Polygon (canal footprint, **not** a centerline) |
| Bridges | `https://capeims.capecoral.gov/arcgis/rest/services/OpenData/PublicWorks/MapServer/0` | 160 | Polyline |
| Weirs | `https://capeims.capecoral.gov/arcgis/rest/services/OpenData/PublicWorks/MapServer/18` | 29 | Point |
| Channel Markers | `https://capeims.capecoral.gov/arcgis/rest/services/OpenData/Marine/MapServer/0` | 666 | Point |
| City Boundary | `https://capeims.capecoral.gov/arcgis/rest/services/OpenData/OpenData/MapServer/0` | 2 | Polygon |

Fields used:

- **Canals**: `NAME`, `WATER_TYPE` (`SALT`/`FRESH`), `NAV_SYST` (spreader system —
  `SW-A` through `SW-E` for saltwater, `FW-Unspecified` for freshwater), `Basin`.
  This one field already carries the spreader-system classification the app needs —
  no need to derive it separately.
- **Bridges**: `CANAL_NAME`, `VerticalClearance`, `Street`, `LocalName`, `Navigable`,
  `BRIDGE_NUMBER`. The layer also carries a full NBI bridge-inspection dataset
  (deck type, load rating, sufficiency rating, etc.) that this app doesn't use.
- **Weirs**: `CANAL`, `TYPE` (fixed/moveable), `WEIR_CREST`, `UPSTREAM_BASIN_NUMBER`,
  `DOWNSTREAM_BASIN_NUMBER`, `STRUCTURE_TYPE`. Confirmed (by construction — see
  below) that every weir sits between a SALT and a FRESH canal: the layer's own
  description says weirs exist "to maintain a separation of the fresh water
  canals from the salt water canals of the City."
- **Channel Markers**: `System`, `Color`, `NAVNumber`, `Depth`. Every record has a
  populated `Depth` value, but these are individual soundings at marker
  locations, not a canal-wide depth survey — there is no such survey in the
  public data. The app surfaces these as reference points, not canal depth.

There is **no dedicated layer** for the gulf-access spreader system as a
separate feature class, no canal depth survey, and no boat ramp / fuel layer —
those don't exist in the City's public GIS. Ramps/fuel come from OpenStreetMap
instead (below).

### OpenStreetMap (Overpass API)

`https://overpass-api.de/api/interpreter`, no key needed, rate-limited by
Overpass's own fair-use policy (the fetch script retries with backoff).

- **Boat ramps / marinas**: `leisure=slipway` and `leisure=marina` within the
  Cape Coral city boundary. 19 features (14 ramps, 3 marinas, 2 fuel points
  tagged `amenity=fuel`/`fuel:marine`/`shop=boat`).
- **Caloosahatchee River centerline**: `waterway=river` ways named
  "Caloosahatchee River" in a bounding box around Cape Coral. Used to build the
  open-water boundary (below) instead of hand-drawn coordinates.
- **Large water bodies**: `natural=water` and `natural=wetland` ways across
  Cape Coral's extent (queried in four quadrants — one citywide query reliably
  timed out server-side). 1,298 pulled, most of them individual canals OSM
  also traces; filtered down in the build step (below) to the ones that
  matter.

### Open-water boundary

There is no ready-made public polygon for "the Caloosahatchee River / Matlacha
Pass / Gulf of Mexico near Cape Coral." Built in `scripts/build-open-water.js`
from four pieces, unioned together:

1. **A fringe around the City's own real boundary polygon** — buffered
   outward ~450m, with the city interior subtracted, minus a hand-identified
   land pocket in the NE (Herons Glen golf course / Pine Shadows Airpark /
   wildlife-management land — not canal territory). This is the piece that
   actually guarantees coverage, and it's the most trustworthy geometry
   available since it's pulled straight from the City's own GIS rather than
   guessed.
2. **The Caloosahatchee River**: OSM's real river centerline, buffered to a
   ~1km channel width. Mostly redundant with #1 now but kept as an
   independent check and for a nicer river shape at low zoom. (An earlier
   version relied on this alone and overshot onto real land in North Fort
   Myers before the centerline was swapped in for hand-guessed coordinates.)
3. **Matlacha Pass / San Carlos Bay / the Gulf**: still hand-drawn, since no
   clean public polygon was found for that side. This is the one piece most
   worth a visual sanity check — see `debug-preview.html`.
4. **Coves and marshes inside the City boundary that connect to open
   water** (e.g. Four Mile Cove). Pulled from OSM, kept only if the polygon
   is at least 1.5 hectares, does NOT substantially overlap any of the City's
   own canal polygons (salt or fresh; if it does, it's just OSM's trace of the
   canal system itself), and touches water already known to be open, directly
   or through other accepted pieces. An earlier version skipped the last two
   tests and counted a 14-acre inland canal basin near SW 28th Terrace as
   open water, so a canal with 2 bridges and about 45 minutes to open water
   reported 0 miles. Fixed 2026-10-08.

This is an approximation for routing and display, **not a navigational
boundary**, and is clearly labeled as such in its own GeoJSON properties. One
known cosmetic loose end: piece #4's query pulled in a couple of large ponds
well outside city limits (Yucca Pens Preserve, north of the city) since a way
partly inside the query bbox is returned in full. Harmless for routing — no
canal is anywhere near there — but worth clipping tighter to the city
boundary before this ships.

## Known gaps and how they're handled

- **38 of 160 bridges have no recorded `VerticalClearance`** (or a `0` that
  means "not applicable/non-navigable," e.g. a culvert marked `Navigable: NO`).
  These are kept as `clearanceFt: null` ("not recorded") everywhere in the
  processed data and the app — never coerced to `0`.
- **1 canal record ("GLORIANA CANAL") and 1 bridge record have empty/blank
  geometry** in the source data. Both are skipped, logged, and excluded from
  the graph rather than crashing the pipeline.
- **36 canal names are reused across 2+ disconnected polygon segments**
  (e.g. two separate "ATLANTIC CANAL" features). Bridges are matched to the
  nearest same-named segment by geometry, not attached to all of them.
- **The canal polygons don't form one fully connected graph.** They were
  "created in the early '90s... from the inverse of parcels polygons" (per the
  layer's own description), which leaves real gaps — typically the width of a
  street right-of-way — between named canal segments that are actually the
  same waterway. Handled in `scripts/lib/graph.js`:
  1. Polygons that touch directly, or come within ~6m (a small digitization
     slop), are connected automatically.
  2. Wherever the City recorded a **bridge**, every canal within ~130m of it is
     treated as connected — a bridge is direct evidence of a real crossing,
     which is a more principled signal than just widening the snap tolerance
     everywhere (which would risk bridging gaps between canals that were never
     meant to connect).
  3. **Weirs** cut the edge between a SALT and a FRESH canal they sit next to —
     confirmed there are no SALT/FRESH canal pairs touching without a weir
     between them.

  After all of that: **298 of 630 saltwater canals** get full route detail
  (bridges in order, distance, lowest clearance, idle time). An earlier build
  showed 532, but that number was inflated: it counted inland canal basins as
  open water, which made routes too short or zero. 298 is the honest count.

  The other **332** (mostly the southeast, along the river) don't have a
  traceable path, but the City's own `NAV_SYST` field classifies every one of
  them as part of a named spreader system (`SW-A` through `SW-E`), so the app
  still says "yes, gulf access," sourced from that classification, and says
  plainly that the detailed route isn't available rather than guessing.
  `data/processed/network-summary.json` lists them by name. Closing this gap
  needs the real river-side openings of those canals traced.
- **10 of 29 weirs** sit near only one other canal within the search radius
  (rather than the two you'd expect — upstream and downstream) — usually
  because the "other side" is a different disconnected polygon segment of the
  *same* freshwater canal, which the weir-blocking logic correctly leaves
  alone since there's no edge between them to cut anyway.
- **Census geocoder has no CORS support** for browser calls (confirmed by
  testing directly), so the live in-app address search uses **Nominatim**
  instead (OpenStreetMap's geocoder), restricted to Cape Coral, rate-limited
  client-side per Nominatim's usage policy.

## Section 8 test addresses

Not yet run against the live network — see the main plan for the list Jami is
filling in. `scripts/build-network.js` output (`data/processed/routes.json`)
is keyed by each canal's ArcGIS `OBJECTID` (not name, since names repeat) and
is what the address-to-canal lookup and the test suite will both read from.

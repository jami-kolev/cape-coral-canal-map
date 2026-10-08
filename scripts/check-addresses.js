// Runs addresses through the same steps the app does: geocode with Nominatim,
// find the nearest canal outline, read its precomputed route. Prints one line
// per address so results can be eyeballed against what is known on the water.
// Usage: node scripts/check-addresses.js addresses.txt   (one address per line)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAX_DISTANCE_M = 150; // keep in step with MAX_CANAL_SEARCH_DISTANCE_METERS in public/js/config.js

// geo-utils.js is browser code that expects Leaflet's L.latLng; give it a minimal stand-in.
function latLng(lat, lng) {
  return {
    lat,
    lng,
    distanceTo(o) {
      const R = 6371008.8;
      const rad = Math.PI / 180;
      const dLat = (o.lat - lat) * rad;
      const dLng = (o.lng - lng) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(o.lat * rad) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },
  };
}
const sandbox = { L: { latLng }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/geo-utils.js'), 'utf8') + '\nthis.findNearestCanal = findNearestCanal;', sandbox);

const canals = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/canals.json'), 'utf8'));
const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/routes.json'), 'utf8'));

async function geocode(address) {
  const q = new URLSearchParams({ q: /cape coral/i.test(address) ? address : `${address}, Cape Coral, FL`, format: 'json', limit: '1' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { 'User-Agent': 'cape-coral-canal-map-check (thekolevgroup.com)' } });
  const json = await res.json();
  return json[0] ? { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) } : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Pass a text file with one address per line.');
  const addresses = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const address of addresses) {
    const pt = await geocode(address);
    await new Promise((r) => setTimeout(r, 1200)); // Nominatim allows about 1 request per second
    if (!pt) {
      console.log(`${address} | NOT FOUND`);
      continue;
    }
    const hit = sandbox.findNearestCanal(latLng(pt.lat, pt.lng), canals);
    if (!hit || hit.distanceMeters > MAX_DISTANCE_M) {
      console.log(`${address} | not on a mapped canal (nearest ${hit ? Math.round(hit.distanceMeters) + ' m' : 'none'}: ${hit && hit.feature.properties.name})`);
      continue;
    }
    const p = hit.feature.properties;
    const r = routes[p.id] || {};
    const kind = p.waterType === 'SALT' ? 'SALT ' + (p.navSyst || '') : 'FRESH ' + (p.basin || '');
    const detail = r.routeLine
      ? `${r.distanceMiles} mi, ~${r.idleTimeMinutes} min, ${r.bridges.length} bridge(s) [${r.bridges.map((b) => `${b.street} ${b.clearanceFt == null ? 'n/r' : b.clearanceFt}`).join('; ')}]`
      : p.waterType === 'SALT'
        ? 'gulf access per City, no traced route'
        : 'no boat route to the Gulf';
    console.log(`${address} | ${p.name} | ${kind} | ${detail}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

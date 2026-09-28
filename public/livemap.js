// Live-karta: GPX-spår, stationer och löparnas senast kända position. Kräver Leaflet + leaflet-gpx.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function initLiveMap(elId, { onNoGpx } = {}) {
  const map = L.map(elId).setView([62, 16], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap-bidragsgivare'
  }).addTo(map);

  let centered = false;
  new L.GPX('/api/gpx', {
    async: true,
    marker_options: { startIconUrl: null, endIconUrl: null, shadowUrl: null }
  }).on('loaded', (e) => {
    centered = true;
    map.fitBounds(e.target.getBounds(), { padding: [20, 20] });
  }).on('error', () => onNoGpx?.()).addTo(map);

  fetch('/api/stations').then(r => r.json()).then(stations => {
    for (const s of stations.filter(s => s.lat != null)) {
      L.circleMarker([s.lat, s.long], { radius: 8, color: s.typ === 'mal' ? '#c00' : '#333', fillColor: '#fff', fillOpacity: 1, weight: 3 })
        .bindTooltip(esc(s.namn)).addTo(map);
    }
  });

  const markers = new Map();
  async function refresh() {
    const positions = await fetch('/api/live-positions').then(r => r.json());
    const seen = new Set();
    for (const p of positions) {
      seen.add(p.runner_id);
      if (markers.has(p.runner_id)) {
        markers.get(p.runner_id).setLatLng([p.lat, p.long]);
      } else {
        const label = esc(p.namn || `#${p.runner_id}`);
        markers.set(p.runner_id, L.marker([p.lat, p.long]).bindTooltip(label, { permanent: true, direction: 'top' }).addTo(map));
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }
    }
    if (!centered && positions.length) {
      centered = true;
      map.setView([positions[0].lat, positions[0].long], 13);
    }
  }
  refresh();
  setInterval(refresh, 10000);
  return map;
}

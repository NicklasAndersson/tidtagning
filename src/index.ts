import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { accessKeys, verifyAccessJwt } from './access.ts';
// Bara kärnan + SVG-renderaren ur qrcode (ren JS, ingen canvas/PNG), så vi slipper extern QR-tjänst
import QRCode from 'qrcode/lib/core/qrcode.js';
import SvgRenderer from 'qrcode/lib/renderer/svg-tag.js';

type Bindings = { DB: D1Database; ASSETS: Fetcher; ADMIN_USER: string; ADMIN_PASS: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };

const app = new Hono<{ Bindings: Bindings }>();

// Samma QR-kod som funktionärerna skannar öppnas som en vanlig länk för publiken (krav 4.3).
// Statisk sida i public/guest.html återanvänds, den läser startnumret ur URL:en själv.
app.get('/l/:id', (c) => c.env.ASSETS.fetch(new Request(new URL('/guest.html', c.req.url))));

// QR-kod som SVG (vektor, skarp i alla utskriftsstorlekar). Oautentiserad men billig och cachebar.
app.get('/api/qr', (c) => {
  const data = c.req.query('data');
  if (!data || data.length > 300) return c.text('data krävs (max 300 tecken)', 400);
  const svg = SvgRenderer.render(QRCode.create(data, { errorCorrectionLevel: 'L' }), { margin: 2 });
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000, immutable' });
});

// Serverns klocka är referensen för alla tider; skannrarna mäter sin avvikelse mot den här
app.get('/api/time', (c) => c.json({ now: Date.now() }));

app.post('/api/scan', async (c) => {
  const { runnerId, stationId, timestamp, scannedBy, lat, long } = await c.req.json();
  if (!runnerId || !stationId || typeof timestamp !== 'number') {
    return c.json({ error: 'runnerId, stationId, timestamp krävs' }, 400);
  }
  // "Första tiden gäller" efter tidigaste tidsstämpel, inte efter vilken telefon som synkar först (flera
  // funktionärer offline på samma station). Skanningar före start (test av skannern) räknas bara om
  // inget efter start finns, så en provskanning aldrig låser ute den riktiga tiden.
  // Mjuk GPS-kontroll (krav 4.2): lat/long/scannedBy är valfria, skanningen går igenom utan dem
  await c.env.DB.prepare(
    'INSERT INTO scans (runner_id, station_id, timestamp, scanned_by, lat, long) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
    'ON CONFLICT(runner_id, station_id) DO UPDATE SET timestamp = excluded.timestamp, scanned_by = excluded.scanned_by, ' +
    'lat = excluded.lat, long = excluded.long ' +
    'WHERE (excluded.timestamp < ?7, excluded.timestamp) < (scans.timestamp < ?7, scans.timestamp)'
  ).bind(String(runnerId), String(stationId), timestamp, scannedBy ?? null, lat ?? null, long ?? null, await startTime(c.env.DB)).run();
  return c.json({ ok: true });
});

app.get('/api/scans', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT runner_id, station_id, timestamp FROM scans ORDER BY timestamp DESC LIMIT 200'
  ).all();
  return c.json(results);
});

// Funktionären skannar/öppnar sitt eget QR-kort en gång och hamnar låst på rätt station (krav 4.1/5.2)
app.get('/scan/:token', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT f.station_id, f.namn AS funktionar_namn, s.namn AS station_namn FROM funktionarer f ' +
    'JOIN stations s ON s.id = f.station_id WHERE f.token = ?'
  ).bind(c.req.param('token')).first<{ station_id: string; funktionar_namn: string; station_namn: string }>();
  if (!row) return c.text('Okänt funktionärskort', 404);
  const url = new URL('/scanner', c.req.url);
  url.searchParams.set('station', row.station_id);
  url.searchParams.set('stationName', row.station_namn);
  url.searchParams.set('scannedBy', row.funktionar_namn || row.station_namn);
  return c.redirect(url.toString());
});

app.get('/api/stations', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, namn, typ, lat, long, ordning FROM stations ORDER BY ordning, rowid').all();
  return c.json(results);
});

app.get('/api/race-settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT namn, start_time, logo IS NOT NULL AS has_logo FROM race_settings WHERE id = 1').first();
  return c.json(row);
});

// Loppets logga, lagras som data-URL (png/jpeg/webp/gif) och serveras som bild
app.get('/api/logo', async (c) => {
  const row = await c.env.DB.prepare('SELECT logo FROM race_settings WHERE id = 1').first<{ logo: string | null }>();
  const m = row?.logo?.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  if (!m) return c.text('Ingen logga uppladdad', 404);
  const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return c.body(bytes, 200, { 'Content-Type': m[1], 'Cache-Control': 'no-cache' });
});

// Banans GPX-spår för översiktskartan (krav 5.1)
app.get('/api/gpx', async (c) => {
  const row = await c.env.DB.prepare('SELECT gpx FROM race_settings WHERE id = 1').first<{ gpx: string | null }>();
  if (!row?.gpx) return c.text('Ingen GPX uppladdad', 404);
  return c.text(row.gpx, 200, { 'Content-Type': 'application/gpx+xml' });
});

// Senast kända position per löpare (krav 5.1). Officiell skanning placeras vid stationens fasta koordinater,
// funktionärens GPS används bara om stationen saknar koordinater. Gästrapporter använder gästens GPS.
app.get('/api/live-positions', async (c) => {
  const { results } = await c.env.DB.prepare(`
    WITH pos AS (
      SELECT s.runner_id, s.timestamp,
        CASE WHEN st.lat IS NOT NULL THEN st.lat ELSE s.lat END AS lat,
        CASE WHEN st.lat IS NOT NULL THEN st.long ELSE s.long END AS long
      FROM scans s LEFT JOIN stations st ON st.id = s.station_id
      UNION ALL
      SELECT runner_id, timestamp, lat, long FROM gast_rapporter
    ), known AS (SELECT * FROM pos WHERE lat IS NOT NULL AND long IS NOT NULL)
    SELECT p.namn, k.runner_id, k.lat, k.long, k.timestamp FROM known k
    JOIN (SELECT runner_id, MAX(timestamp) AS ts FROM known GROUP BY runner_id) latest
      ON latest.runner_id = k.runner_id AND latest.ts = k.timestamp
    LEFT JOIN participants p ON p.startnummer = k.runner_id
  `).all();
  return c.json(results);
});

async function startTime(db: D1Database) {
  const row = await db.prepare('SELECT start_time FROM race_settings WHERE id = 1').first<{ start_time: number | null }>();
  return row?.start_time ?? 0;
}

async function computeResults(db: D1Database) {
  const { results: participants } = await db.prepare(
    'SELECT startnummer, namn, klass FROM participants'
  ).all();
  // Provskanningar före start syns inte i resultaten (de ligger kvar i admin-vyn)
  const { results: scans } = await db.prepare(
    'SELECT runner_id, station_id, timestamp FROM scans WHERE timestamp >= ?'
  ).bind(await startTime(db)).all();

  const byRunner = new Map<string, { startnummer: string; namn: string; klass: string; known: boolean; times: Record<string, number> }>();
  for (const p of participants as any[]) {
    byRunner.set(p.startnummer, { startnummer: p.startnummer, namn: p.namn, klass: p.klass, known: true, times: {} });
  }
  for (const s of scans as any[]) {
    if (!byRunner.has(s.runner_id)) {
      byRunner.set(s.runner_id, { startnummer: s.runner_id, namn: `Okänd #${s.runner_id}`, klass: '', known: false, times: {} });
    }
    byRunner.get(s.runner_id)!.times[s.station_id] = s.timestamp;
  }
  return [...byRunner.values()];
}

// Publik resultatlista (krav 5.1): deltagare + alla mellantider, ingen inloggning krävs
app.get('/api/results', async (c) => c.json(await computeResults(c.env.DB)));

function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)
  );
}

type ArchiveData = {
  namn: string | null;
  archivedAt: number;
  startTime: number | null;
  gpx: string | null;
  logo: string | null;
  stations: { id: string; namn: string; typ: string; lat: number | null; long: number | null }[];
  results: Awaited<ReturnType<typeof computeResults>>;
  comments: { runner_id: string; timestamp: number; kommentar: string }[];
};

// Arkivets sida ritar sig själv i webbläsaren ur JSON-datan (tabell, karta, löparsidor), så filen är fristående
const ARCHIVE_SCRIPT = String.raw`
var D = JSON.parse(document.getElementById('data').textContent);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(t) {
  if (!D.startTime) return new Date(t).toLocaleTimeString('sv-SE');
  var s = Math.max(0, Math.round((t - D.startTime) / 1000));
  return Math.floor(s / 3600) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
}
var fin = D.stations.filter(function (s) { return s.typ === 'mal'; })[0];
var rows = D.results.slice().sort(function (a, b) {
  var at = fin && a.times[fin.id], bt = fin && b.times[fin.id];
  if (at && bt) return at - bt;
  if (at) return -1;
  if (bt) return 1;
  return a.namn.localeCompare(b.namn);
});
document.getElementById('head').innerHTML = '<th>Namn</th><th>Klass</th>' + D.stations.map(function (s) { return '<th>' + esc(s.namn) + '</th>'; }).join('');
document.getElementById('body').innerHTML = rows.map(function (r) {
  return '<tr><td><a href="#r-' + encodeURIComponent(r.startnummer) + '">' + esc(r.namn) + '</a></td><td>' + esc(r.klass) + '</td>' +
    D.stations.map(function (s) {
      var t = r.times[s.id];
      return '<td>' + (t ? (fin && s.id === fin.id ? '<b>' + fmt(t) + '</b>' : fmt(t)) : '') + '</td>';
    }).join('') + '</tr>';
}).join('');
document.getElementById('runners').innerHTML = rows.map(function (r) {
  var ev = D.stations.filter(function (s) { return r.times[s.id]; }).map(function (s) { return { t: r.times[s.id], html: esc(s.namn) }; })
    .concat(D.comments.filter(function (c) { return c.runner_id === r.startnummer; }).map(function (c) { return { t: c.timestamp, html: '<i>' + esc(c.kommentar) + '</i>' }; }))
    .sort(function (a, b) { return a.t - b.t; });
  return '<details id="r-' + encodeURIComponent(r.startnummer) + '"><summary>#' + esc(r.startnummer) + ' ' + esc(r.namn) + (r.klass ? ' (' + esc(r.klass) + ')' : '') + '</summary><ul>' +
    (ev.map(function (e) { return '<li>' + fmt(e.t) + ' – ' + e.html + '</li>'; }).join('') || '<li>Inga registrerade tider</li>') + '</ul></details>';
}).join('');
function openHash() { var el = location.hash && document.getElementById(location.hash.slice(1)); if (el && el.tagName === 'DETAILS') el.open = true; }
addEventListener('hashchange', openHash); openHash();
if (typeof L !== 'undefined') {
  var map = L.map('map'), pts = [];
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  if (D.gpx) {
    var track = [].map.call(new DOMParser().parseFromString(D.gpx, 'application/xml').getElementsByTagName('trkpt'), function (p) { return [+p.getAttribute('lat'), +p.getAttribute('lon')]; });
    if (track.length) { L.polyline(track, { color: '#1f6f4a', weight: 4 }).addTo(map); pts = pts.concat(track); }
  }
  D.stations.forEach(function (s) { if (s.lat != null && s.long != null) { L.marker([s.lat, s.long]).addTo(map).bindTooltip(s.namn); pts.push([s.lat, s.long]); } });
  if (pts.length) map.fitBounds(pts); else document.getElementById('map').hidden = true;
} else document.getElementById('map').hidden = true;
`;

// Fristående statisk HTML-sida (krav 4.4 "Komplett Statisk Export"): tider, mellantider, karta och löparsidor
// med publikkommentarer. Sparas i archives.html vid arkivering.
function renderArchiveHtml(d: ArchiveData) {
  const json = JSON.stringify({ ...d, logo: undefined }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(d.namn || 'Lopp')}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  body { font-family: sans-serif; margin: 1.5rem; max-width: 1100px; }
  #map { height: 400px; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; }
  details { border-bottom: 1px solid #ddd; padding: 0.4rem 0; }
  summary { cursor: pointer; font-weight: bold; }
  .table-wrap { overflow-x: auto; }
</style></head>
<body>
${d.logo ? `<img src="${escapeHtml(d.logo)}" alt="" style="max-height:5rem">` : ''}
<h1>${escapeHtml(d.namn || 'Lopp')}</h1>
<p>Arkiverat ${new Date(d.archivedAt).toISOString().slice(0, 10)}</p>
<div id="map"></div>
<div class="table-wrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table></div>
<h2>Löpare</h2>
<div id="runners"></div>
<script type="application/json" id="data">${json}</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>${ARCHIVE_SCRIPT}</script>
</body></html>`;
}

app.get('/api/participant/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT startnummer, namn, klass FROM participants WHERE startnummer = ?')
    .bind(c.req.param('id')).first();
  return c.json(row ?? { startnummer: c.req.param('id'), namn: null, klass: null });
});

// Gäströrelse (krav 4.3): oinloggat, påverkar aldrig officiella tider i "scans"
app.post('/api/guest-report', async (c) => {
  const { runnerId, timestamp, kommentar, lat, long } = await c.req.json();
  if (!runnerId || !timestamp) return c.json({ error: 'runnerId, timestamp krävs' }, 400);
  await c.env.DB.prepare(
    'INSERT INTO gast_rapporter (runner_id, timestamp, kommentar, lat, long) VALUES (?, ?, ?, ?, ?)'
  ).bind(runnerId, timestamp, kommentar ?? null, lat ?? null, long ?? null).run();
  return c.json({ ok: true });
});

app.get('/api/guest-reports/:runnerId', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT timestamp, kommentar FROM gast_rapporter WHERE runner_id = ? AND kommentar IS NOT NULL ORDER BY timestamp DESC'
  ).bind(c.req.param('runnerId')).all();
  return c.json(results);
});

// Arrangören delar ett gemensamt inloggningspar (enligt kravspec 3.1) — Basic Auth räcker för PoC-adminet.
app.use('/api/admin/*', async (c, next) => {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  // Utan Access-konfiguration (lokal utveckling, tester) gäller det gemensamma Basic Auth-paret
  if (!team || !aud) return basicAuth({ username: c.env.ADMIN_USER, password: c.env.ADMIN_PASS })(c, next);
  // Cloudflare Access (Google-inloggning) släpper in arrangörer; JWT:n verifieras här så att inte
  // workers.dev-adressen eller andra vägar förbi Access fungerar
  const token = c.req.header('Cf-Access-Jwt-Assertion') ?? '';
  const kid = (() => { try { return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).kid; } catch {} })();
  const who = token && await verifyAccessJwt(token, await accessKeys(team, kid), { aud, issuer: `https://${team}` });
  if (!who) return c.text('Unauthorized', 401);
  await next();
});

app.get('/api/admin/participants', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT startnummer, namn, klass FROM participants ORDER BY startnummer'
  ).all();
  return c.json(results);
});

app.put('/api/admin/participants/:startnummer', async (c) => {
  const startnummer = c.req.param('startnummer');
  const { namn, klass } = await c.req.json();
  if (!namn) return c.json({ error: 'namn krävs' }, 400);
  await c.env.DB.prepare(
    'INSERT INTO participants (startnummer, namn, klass) VALUES (?, ?, ?) ' +
    'ON CONFLICT(startnummer) DO UPDATE SET namn = excluded.namn, klass = excluded.klass'
  ).bind(startnummer, namn, klass ?? '').run();
  return c.json({ ok: true });
});

app.delete('/api/admin/participants/:startnummer', async (c) => {
  await c.env.DB.prepare('DELETE FROM participants WHERE startnummer = ?')
    .bind(c.req.param('startnummer')).run();
  return c.json({ ok: true });
});

// Startnummer som har skannats men saknar deltagare-rad ("Okänd deltagare" enligt krav 4.2)
app.get('/api/admin/unknown-runners', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT DISTINCT s.runner_id FROM scans s ' +
    'LEFT JOIN participants p ON p.startnummer = s.runner_id ' +
    'WHERE p.startnummer IS NULL'
  ).all();
  return c.json(results);
});

app.get('/api/admin/stations', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, namn, typ, lat, long, ordning FROM stations ORDER BY ordning, rowid').all();
  return c.json(results);
});

// Ny station: id genereras, utelämnad ordning läggs sist längs banan
app.post('/api/admin/stations', async (c) => {
  const { namn, typ, lat, long, ordning } = await c.req.json();
  if (!namn) return c.json({ error: 'namn krävs' }, 400);
  const id = crypto.randomUUID().slice(0, 8);
  await c.env.DB.prepare(
    'INSERT INTO stations (id, namn, typ, lat, long, ordning) ' +
    'VALUES (?, ?, ?, ?, ?, COALESCE(?, (SELECT IFNULL(MAX(ordning), 0) + 1 FROM stations)))'
  ).bind(id, namn, typ ?? 'checkpoint', lat ?? null, long ?? null, ordning ?? null).run();
  return c.json({ id });
});

app.put('/api/admin/stations/:id', async (c) => {
  const { namn, typ, lat, long, ordning } = await c.req.json();
  if (!namn) return c.json({ error: 'namn krävs' }, 400);
  // ponytail: tom position/ordning behåller gamla värden; för att rensa position, ta bort och skapa om stationen
  await c.env.DB.prepare(
    'UPDATE stations SET namn = ?, typ = ?, lat = COALESCE(?, lat), long = COALESCE(?, long), ordning = COALESCE(?, ordning) WHERE id = ?'
  ).bind(namn, typ ?? 'checkpoint', lat ?? null, long ?? null, ordning ?? null, c.req.param('id')).run();
  return c.json({ ok: true });
});

app.delete('/api/admin/stations/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM stations WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.get('/api/admin/funktionarer', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT f.token, f.namn, f.station_id, s.namn AS station_namn FROM funktionarer f ' +
    'JOIN stations s ON s.id = f.station_id ORDER BY s.namn'
  ).all();
  return c.json(results);
});

app.post('/api/admin/funktionarer', async (c) => {
  const { stationId, namn } = await c.req.json();
  if (!stationId) return c.json({ error: 'stationId krävs' }, 400);
  const token = crypto.randomUUID().slice(0, 8);
  await c.env.DB.prepare('INSERT INTO funktionarer (token, station_id, namn) VALUES (?, ?, ?)')
    .bind(token, stationId, namn ?? '').run();
  return c.json({ token });
});

app.delete('/api/admin/funktionarer/:token', async (c) => {
  await c.env.DB.prepare('DELETE FROM funktionarer WHERE token = ?').bind(c.req.param('token')).run();
  return c.json({ ok: true });
});

app.get('/api/admin/race-settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT namn, start_time FROM race_settings WHERE id = 1').first();
  return c.json(row);
});

// Admin-vy (krav 7): vem skannade, samt koordinater när de finns
app.get('/api/admin/scans', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT s.runner_id, p.namn, s.station_id, s.timestamp, s.scanned_by, s.lat, s.long FROM scans s ' +
    'LEFT JOIN participants p ON p.startnummer = s.runner_id ORDER BY s.timestamp DESC LIMIT 500'
  ).all();
  return c.json(results);
});

app.put('/api/admin/race-settings', async (c) => {
  const body = await c.req.json();
  if ('namn' in body) {
    await c.env.DB.prepare('UPDATE race_settings SET namn = ? WHERE id = 1').bind(body.namn).run();
  }
  if ('startTime' in body) {
    await c.env.DB.prepare('UPDATE race_settings SET start_time = ? WHERE id = 1').bind(body.startTime).run();
  }
  // "Starta nu"/"om X sekunder" räknas på serverns klocka, inte adminens dator
  if ('startInSeconds' in body) {
    await c.env.DB.prepare('UPDATE race_settings SET start_time = ? WHERE id = 1')
      .bind(Date.now() + Number(body.startInSeconds) * 1000).run();
  }
  if ('gpx' in body) {
    await c.env.DB.prepare('UPDATE race_settings SET gpx = ? WHERE id = 1').bind(body.gpx).run();
  }
  if ('logo' in body) {
    // null tar bort loggan; annars måste det vara en rasterbild-data-URL (ej SVG, som kan innehålla script) på högst ~400 kB
    const ok = body.logo === null || (typeof body.logo === 'string' && body.logo.length < 550_000 &&
      /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(body.logo));
    if (!ok) return c.json({ error: 'Ogiltig logga (png/jpg/webp/gif, max 400 kB)' }, 400);
    await c.env.DB.prepare('UPDATE race_settings SET logo = ? WHERE id = 1').bind(body.logo).run();
  }
  return c.json({ ok: true });
});

app.get('/api/admin/archives', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, namn, archived_at FROM archives ORDER BY archived_at DESC'
  ).all();
  return c.json(results);
});

// Arkivera & nollställ (krav 4.4): sparar en ögonblicksbild (inkl. nedladdningsbar HTML) med loppnamnet, sedan rensas allt aktivt data
app.post('/api/admin/reset', async (c) => {
  const settings = await c.env.DB.prepare('SELECT namn, logo, gpx, start_time FROM race_settings WHERE id = 1')
    .first<{ namn: string | null; logo: string | null; gpx: string | null; start_time: number | null }>();
  const { results: stations } = await c.env.DB.prepare('SELECT id, namn, typ, lat, long FROM stations ORDER BY ordning, rowid')
    .all<ArchiveData['stations'][number]>();
  const { results: comments } = await c.env.DB.prepare(
    'SELECT runner_id, timestamp, kommentar FROM gast_rapporter WHERE kommentar IS NOT NULL ORDER BY timestamp'
  ).all<ArchiveData['comments'][number]>();
  const results = await computeResults(c.env.DB);
  const archivedAt = Date.now();
  const html = renderArchiveHtml({
    namn: settings?.namn ?? null, archivedAt, startTime: settings?.start_time ?? null,
    gpx: settings?.gpx ?? null, logo: settings?.logo ?? null, stations, results, comments,
  });

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO archives (namn, archived_at, results_json, html) VALUES (?, ?, ?, ?)')
      .bind(settings?.namn ?? null, archivedAt, JSON.stringify(results), html),
    c.env.DB.prepare('DELETE FROM scans'),
    c.env.DB.prepare('DELETE FROM participants'),
    c.env.DB.prepare('DELETE FROM stations'),
    c.env.DB.prepare('DELETE FROM funktionarer'),
    c.env.DB.prepare('DELETE FROM gast_rapporter'),
    c.env.DB.prepare('UPDATE race_settings SET namn = NULL, start_time = NULL, gpx = NULL, logo = NULL WHERE id = 1'),
  ]);
  return c.json({ ok: true });
});

// Arkivet är en publik, läsbar länk (krav 4.4); ?download ger filen som nedladdning i stället
app.get('/archive/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT namn, html FROM archives WHERE id = ?')
    .bind(c.req.param('id')).first<{ namn: string | null; html: string }>();
  if (!row) return c.text('Okänt arkiv', 404);
  const filename = `${(row.namn || 'lopp').replace(/[^a-zA-Z0-9åäöÅÄÖ_-]+/g, '_')}.html`;
  if (c.req.query('download') !== undefined) c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.html(row.html);
});

export default app;

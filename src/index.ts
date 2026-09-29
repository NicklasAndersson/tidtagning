import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';

type Bindings = { DB: D1Database; ASSETS: Fetcher; ADMIN_USER: string; ADMIN_PASS: string };

const app = new Hono<{ Bindings: Bindings }>();

// Samma QR-kod som funktionärerna skannar öppnas som en vanlig länk för publiken (krav 4.3).
// Statisk sida i public/guest.html återanvänds, den läser startnumret ur URL:en själv.
app.get('/l/:id', (c) => c.env.ASSETS.fetch(new Request(new URL('/guest.html', c.req.url))));

app.post('/api/scan', async (c) => {
  const { runnerId, stationId, timestamp, scannedBy, lat, long } = await c.req.json();
  if (!runnerId || !stationId || !timestamp) {
    return c.json({ error: 'runnerId, stationId, timestamp krävs' }, 400);
  }
  // ponytail: "första tiden gäller" löses av PRIMARY KEY + INSERT OR IGNORE, ingen egen dedupe-logik
  // Mjuk GPS-kontroll (krav 4.2): lat/long/scannedBy är valfria, skanningen går igenom utan dem
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO scans (runner_id, station_id, timestamp, scanned_by, lat, long) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(runnerId, stationId, timestamp, scannedBy ?? null, lat ?? null, long ?? null).run();
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

async function computeResults(db: D1Database) {
  const { results: participants } = await db.prepare(
    'SELECT startnummer, namn, klass FROM participants'
  ).all();
  const { results: scans } = await db.prepare(
    'SELECT runner_id, station_id, timestamp FROM scans'
  ).all();

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

// Fristående statisk HTML-sida (krav 4.4 "Komplett Statisk Export"), sparas i archives.html vid arkivering
function renderArchiveHtml(
  namn: string | null,
  archivedAt: number,
  results: Awaited<ReturnType<typeof computeResults>>,
  stations: { id: string; namn: string; typ: string }[],
  logo: string | null
) {
  const finishId = stations.find((s) => s.typ === 'mal')?.id;
  const rows = [...results].sort((a, b) => {
    const at = finishId ? a.times[finishId] : undefined;
    const bt = finishId ? b.times[finishId] : undefined;
    if (at && bt) return at - bt;
    if (at) return -1;
    if (bt) return 1;
    return a.namn.localeCompare(b.namn);
  });

  const header = '<th>Namn</th><th>Klass</th>' + stations.map((s) => `<th>${escapeHtml(s.namn)}</th>`).join('');
  const body = rows.map((r) => {
    const cells = stations.map((s) => {
      const t = r.times[s.id];
      const cell = t ? new Date(t).toLocaleTimeString() : '';
      return s.id === finishId ? `<td><b>${cell}</b></td>` : `<td>${cell}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(r.namn)}</td><td>${escapeHtml(r.klass)}</td>${cells}</tr>`;
  }).join('');

  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><title>${escapeHtml(namn || 'Lopp')}</title>
<style>
  body { font-family: sans-serif; margin: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; }
</style></head>
<body>
${logo ? `<img src="${logo}" alt="" style="max-height:5rem">` : ''}
<h1>${escapeHtml(namn || 'Lopp')}</h1>
<p>Arkiverat ${new Date(archivedAt).toLocaleString()}</p>
<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>
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
app.use('/api/admin/*', async (c, next) =>
  basicAuth({ username: c.env.ADMIN_USER, password: c.env.ADMIN_PASS })(c, next)
);

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
  const settings = await c.env.DB.prepare('SELECT namn, logo FROM race_settings WHERE id = 1').first<{ namn: string | null; logo: string | null }>();
  const { results: stations } = await c.env.DB.prepare('SELECT id, namn, typ FROM stations ORDER BY ordning, rowid').all<{ id: string; namn: string; typ: string }>();
  const results = await computeResults(c.env.DB);
  const archivedAt = Date.now();
  const html = renderArchiveHtml(settings?.namn ?? null, archivedAt, results, stations, settings?.logo ?? null);

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

// Nedladdningsbar statisk export av ett arkiverat lopp (krav 4.4)
app.get('/archive/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT namn, html FROM archives WHERE id = ?')
    .bind(c.req.param('id')).first<{ namn: string | null; html: string }>();
  if (!row) return c.text('Okänt arkiv', 404);
  const filename = `${(row.namn || 'lopp').replace(/[^a-zA-Z0-9åäöÅÄÖ_-]+/g, '_')}.html`;
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.html(row.html);
});

export default app;

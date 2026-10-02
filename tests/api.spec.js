import { test, expect, BASE } from './helpers.js';

test('skanning: saknade fält och ogiltig tid avvisas', async ({ race }) => {
  expect((await race.scan('1', 'x')).status()).toBe(400);
  expect((await race.scan('', 1000)).status()).toBe(400);
  expect((await race.scan('1', 1000, '')).status()).toBe(400);
  expect(await race.scans()).toHaveLength(0);
});

test('första tiden gäller: tidigaste efter start vinner, provskanning före start byts ut', async ({ request, race }) => {
  await request.put('/api/admin/race-settings', { data: { startTime: 10_000 } });
  await race.scan('1', 5_000); // provskanning före start
  expect((await race.results()).find((r) => r.startnummer === '1')).toBeUndefined();
  await race.scan('1', 20_000);
  await race.scan('1', 15_000); // tidigare, synkad senare
  await race.scan('1', 18_000);
  await race.scan('1', 4_000); // ännu en provskanning, får inte ta över
  expect((await race.scanOf('1')).timestamp).toBe(15_000);
  expect((await race.results()).find((r) => r.startnummer === '1').times[race.finishId]).toBe(15_000);
});

test('utan starttid räknas alla skanningar och tidigast vinner', async ({ race }) => {
  await race.scan('2', 3_000);
  await race.scan('2', 1_000);
  expect((await race.scanOf('2')).timestamp).toBe(1_000);
});

test('samma löpare på olika stationer ger separata tider', async ({ request, race }) => {
  const cp = (await (await request.post('/api/admin/stations', { data: { namn: 'Km 5', lat: 59.2, long: 18.0 } })).json()).id;
  await race.scan('3', 1_000, cp);
  await race.scan('3', 2_000);
  expect((await race.results()).find((r) => r.startnummer === '3').times).toEqual({ [cp]: 1_000, [race.finishId]: 2_000 });
});

test('okänd löpare syns som "Okänd" och får namn i efterhand utan att tiden försvinner', async ({ request, race }) => {
  await race.scan('77', 5_000);
  expect((await (await request.get('/api/admin/unknown-runners')).json())).toEqual([{ runner_id: '77' }]);
  expect((await race.results()).find((r) => r.startnummer === '77')).toMatchObject({ namn: 'Okänd #77', known: false });

  await request.put('/api/admin/participants/77', { data: { namn: 'Kalle', klass: 'Herr' } });
  expect((await race.results()).find((r) => r.startnummer === '77'))
    .toMatchObject({ namn: 'Kalle', klass: 'Herr', known: true, times: { [race.finishId]: 5_000 } });
  expect((await (await request.get('/api/admin/unknown-runners')).json())).toEqual([]);
});

test('gästrapporter påverkar aldrig officiella tider men syns i tidslinjen', async ({ request, race }) => {
  await request.post('/api/guest-report', { data: { runnerId: '5', timestamp: 1_000, kommentar: 'Heja!' } });
  await request.post('/api/guest-report', { data: { runnerId: '5', timestamp: 2_000 } });
  expect(await race.scans()).toHaveLength(0);
  expect((await race.results()).find((r) => r.startnummer === '5')).toBeUndefined();
  expect(await (await request.get('/api/guest-reports/5')).json()).toEqual([{ timestamp: 1_000, kommentar: 'Heja!' }]);
  expect((await request.post('/api/guest-report', { data: { runnerId: '5' } })).status()).toBe(400);
});

test('livepositioner: stationens koordinater före funktionärens GPS, senaste händelsen vinner', async ({ request, race }) => {
  const utanPos = (await (await request.post('/api/admin/stations', { data: { namn: 'Utan pos' } })).json()).id;
  await race.scan('6', 1_000, utanPos, { lat: 1, long: 2 });
  let pos = (await (await request.get('/api/live-positions')).json()).find((p) => p.runner_id === '6');
  expect([pos.lat, pos.long]).toEqual([1, 2]);

  await race.scan('6', 2_000, race.finishId, { lat: 1, long: 2 }); // målet har egna koordinater
  pos = (await (await request.get('/api/live-positions')).json()).find((p) => p.runner_id === '6');
  expect([pos.lat, pos.long]).toEqual([59.3, 18.1]);

  await request.post('/api/guest-report', { data: { runnerId: '6', timestamp: 3_000, lat: 5, long: 6 } });
  pos = (await (await request.get('/api/live-positions')).json()).find((p) => p.runner_id === '6');
  expect([pos.lat, pos.long]).toEqual([5, 6]);
});

test('servertid och start räknad på servern', async ({ request }) => {
  const before = Date.now();
  const { now } = await (await request.get('/api/time')).json();
  expect(Math.abs(now - before)).toBeLessThan(5_000);

  await request.put('/api/admin/race-settings', { data: { startInSeconds: 60 } });
  const { start_time } = await (await request.get('/api/race-settings')).json();
  expect(start_time - now).toBeGreaterThan(55_000);
  expect(start_time - now).toBeLessThan(70_000);

  await request.put('/api/admin/race-settings', { data: { startTime: null } });
  expect((await (await request.get('/api/race-settings')).json()).start_time).toBeNull();
});

test('funktionärskort: rätt station och namn i länken, okänt kort ger 404', async ({ request, race }) => {
  const res = await request.get(`/scan/${race.token}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const url = new URL(res.headers().location);
  expect(url.pathname).toBe('/scanner');
  expect(Object.fromEntries(url.searchParams)).toEqual({ station: race.finishId, stationName: 'Mål', scannedBy: 'Anna', token: race.token });
  expect((await request.get('/scan/finnsinte', { maxRedirects: 0 })).status()).toBe(404);
});

test('admin kräver inloggning, publika API:er gör det inte', async ({ race }) => {
  // Vanlig fetch, eftersom Playwrights request-kontexter ärver inloggningen från configen
  const call = (path, init = {}) => fetch(BASE + path, init).then((r) => r.status);
  const wrong = { Authorization: 'Basic ' + btoa('test:fel') };
  for (const path of ['/api/admin/scans', '/api/admin/participants', '/api/admin/stations', '/api/admin/funktionarer']) {
    expect(await call(path), path).toBe(401);
    expect(await call(path, { headers: wrong }), path).toBe(401);
  }
  expect(await call('/api/admin/reset', { method: 'POST' })).toBe(401);
  expect(await call('/api/admin/race-settings', { method: 'PUT', body: '{"startInSeconds":0}' })).toBe(401);
  for (const path of ['/api/results', '/api/stations', '/api/race-settings', '/api/live-positions', '/api/time'])
    expect(await call(path), path).toBe(200);
  // Skanning kräver ett giltigt funktionärskort; adminlösenordet räcker inte
  const scan = (headers) => call('/api/scan', { method: 'POST', headers, body: JSON.stringify({ runnerId: '1', stationId: 'x', timestamp: 1 }) });
  expect(await scan()).toBe(401);
  expect(await scan({ Authorization: 'Bearer finnsinte' })).toBe(401);
  expect(await scan({ Authorization: 'Basic ' + btoa('test:test') })).toBe(401);
  expect(await scan({ Authorization: `Bearer ${race.token}` })).toBe(200);
});

test('QR-endpoint ger SVG och avvisar tomt eller för långt innehåll', async ({ request }) => {
  const res = await request.get(`/api/qr?data=${encodeURIComponent(BASE + '/l/1')}`);
  expect(res.headers()['content-type']).toBe('image/svg+xml');
  expect(await res.text()).toContain('<svg');
  expect((await request.get('/api/qr')).status()).toBe(400);
  expect((await request.get(`/api/qr?data=${'x'.repeat(301)}`)).status()).toBe(400);
});

test('stationer: ändring utan position behåller koordinaterna, ordning läggs sist', async ({ request, race }) => {
  const cp = (await (await request.post('/api/admin/stations', { data: { namn: 'Km 5' } })).json()).id;
  await request.put(`/api/admin/stations/${race.finishId}`, { data: { namn: 'Målet', typ: 'mal' } });
  const stations = await (await request.get('/api/stations')).json();
  expect(stations.map((s) => s.id)).toEqual([race.finishId, cp]);
  expect(stations[0]).toMatchObject({ namn: 'Målet', lat: 59.3, long: 18.1 });
});

test('arkivera: resultaten sparas med namn och allt aktivt nollställs', async ({ request, race }) => {
  await request.put('/api/admin/race-settings', { data: { namn: 'Vårruset', startTime: 1_000 } });
  await request.put('/api/admin/participants/9', { data: { namn: 'Stina <b>', klass: 'Dam' } });
  await race.scan('9', 5_000);
  await request.post('/api/admin/reset');

  const [archive] = await (await request.get('/api/admin/archives')).json();
  expect(archive.namn).toBe('Vårruset');
  const html = await (await request.get(`/archive/${archive.id}`)).text();
  expect(html).toContain('Vårruset');
  expect(html).toContain('Stina \\u003cb>'); // escapat i JSON-datan
  expect(html).toContain('Mål');

  expect((await request.delete(`/api/admin/archives/${archive.id}`)).ok()).toBe(true);
  expect((await (await request.get('/api/admin/archives')).json()).some((a) => a.id === archive.id)).toBe(false);
  expect((await request.get(`/archive/${archive.id}`)).status()).toBe(404);

  expect(await race.scans()).toHaveLength(0);
  expect(await (await request.get('/api/stations')).json()).toHaveLength(0);
  expect(await race.results()).toHaveLength(0);
  expect(await (await request.get('/api/race-settings')).json()).toMatchObject({ namn: null, start_time: null });
});

test('stopp: obeskannade markeras som gick inte i mål, sen måltid räknas ändå, återuppta behåller starttiden', async ({ request, race }) => {
  await request.put('/api/admin/participants/1', { data: { namn: 'A' } });
  await request.put('/api/admin/participants/2', { data: { namn: 'B' } });
  await request.put('/api/admin/participants/3', { data: { namn: 'C' } }); // kommer aldrig i mål, så ingen autostopp
  await request.put('/api/admin/race-settings', { data: { startTime: 1_000 } });
  await race.scan('1', 5_000);
  const settings = async () => (await request.get('/api/race-settings')).json();
  expect((await settings()).stop_time).toBeNull(); // alla är inte i mål än
  await request.put('/api/admin/race-settings', { data: { stop: true } });
  expect((await settings()).stop_time).toBeGreaterThan(0);
  const dnf = async (n) => (await race.results()).find((r) => r.startnummer === n).dnf;
  expect(await dnf('1')).toBe(false);
  expect(await dnf('2')).toBe(true);
  await race.scan('2', 9_000); // efter stopp: tiden räknas ändå
  expect(await dnf('2')).toBe(false);
  await request.put('/api/admin/race-settings', { data: { startTime: 2_000 } });
  expect((await settings()).stop_time).toBeGreaterThan(0); // ny starttid återupptar inte
  await request.put('/api/admin/race-settings', { data: { resume: true } });
  expect((await settings()).stop_time).toBeNull();
  expect((await settings()).start_time).toBe(2_000);
});

test('klockan stannar av sig själv när alla deltagare är i mål', async ({ request, race }) => {
  await request.put('/api/admin/participants/1', { data: { namn: 'A' } });
  await request.put('/api/admin/race-settings', { data: { startTime: 1_000 } });
  await race.scan('1', 7_000);
  expect((await (await request.get('/api/race-settings')).json()).stop_time).toBe(7_000);
});

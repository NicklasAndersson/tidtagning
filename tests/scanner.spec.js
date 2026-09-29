import { test, expect, BASE, openScanner, keypad, typeDigits } from './helpers.js';
import { writeQrVideo } from './fake-camera.js';

test('kameran läser QR och registrerar två löpare som står bredvid varandra', async ({ race, phone }, info) => {
  const video = info.outputPath('qr.y4m');
  writeQrVideo(video, [`${BASE}/l/11`, `${BASE}/l/12`]);
  const { page } = await phone({ video });
  await openScanner(page, race.token);
  await expect.poll(() => race.scanOf('11'), { timeout: 20_000 }).toBeTruthy();
  await expect.poll(() => race.scanOf('12'), { timeout: 20_000 }).toBeTruthy();
  expect((await race.scanOf('11')).scanned_by).toBe('Anna');
});

test('nekad kamera: manuell inmatning fungerar och synkas ändå', async ({ request, race, phone }) => {
  const { page } = await phone({ camera: false });
  await openScanner(page, race.token);
  await expect(page.locator('#status')).toContainText('Kamera ej tillgänglig');
  await keypad(page, '7');
  await expect.poll(() => race.scanOf('7')).toBeTruthy();
  await expect(page.locator('#status')).toContainText('allt synkat');
});

test('utan täckning: skanningen sparas lokalt och synkas när nätet kommer tillbaka', async ({ request, race, phone }) => {
  const { context, page } = await phone();
  await openScanner(page, race.token);
  await context.setOffline(true);
  const before = Date.now();
  await keypad(page, '9');
  await expect(page.locator('#status')).toContainText('1 ej synkade');
  await page.waitForTimeout(6000); // minst ett synkförsök medan offline
  expect(await race.scanOf('9')).toBeFalsy();

  await context.setOffline(false);
  await expect.poll(() => race.scanOf('9'), { timeout: 15_000 }).toBeTruthy();
  const s = await race.scanOf('9');
  expect(s.timestamp).toBeGreaterThanOrEqual(before - 1000); // tiden från skanningsögonblicket, inte synken
  expect(s.timestamp).toBeLessThan(before + 3000);
  await expect(page.locator('#status')).toContainText('allt synkat');
});

test('omladdning utan täckning: sidan startar från cache och skanningar synkas senare', async ({ request, race, phone }) => {
  const { context, page } = await phone();
  await openScanner(page, race.token);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // nu hämtas sidan via service workern och hamnar i cachen
  await expect(page.locator('#top b')).toHaveText('Mål');

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#top b')).toHaveText('Mål');
  await keypad(page, '21');
  await expect(page.locator('#status')).toContainText('1 ej synkade');

  await context.setOffline(false);
  await expect.poll(() => race.scanOf('21'), { timeout: 15_000 }).toBeTruthy();
});

test('flera telefoner offline på samma station: tidigaste tiden vinner oavsett synkordning', async ({ request, race, phone }) => {
  const a = await phone(), b = await phone();
  await openScanner(a.page, race.token);
  await openScanner(b.page, race.token);
  await a.context.setOffline(true);
  await b.context.setOffline(true);
  await keypad(a.page, '3');
  await a.page.waitForTimeout(1500);
  await keypad(b.page, '3');

  await b.context.setOffline(false); // den senare tiden når servern först
  await expect.poll(() => race.scanOf('3'), { timeout: 15_000 }).toBeTruthy();
  const late = (await race.scanOf('3')).timestamp;
  await a.context.setOffline(false);
  await expect.poll(async () => (await race.scanOf('3')).timestamp, { timeout: 15_000 }).toBeLessThan(late - 1000);
});

test('provskanning före start låser inte ute den riktiga tiden', async ({ request, race, phone }) => {
  await request.put('/api/admin/race-settings', { data: { startInSeconds: 3600 } });
  const { page } = await phone();
  await openScanner(page, race.token);
  await expect.poll(() => page.evaluate(() => raceStart)).toBeGreaterThan(0);
  await keypad(page, '5'); // test innan start
  await expect.poll(() => race.scanOf('5')).toBeTruthy();

  await request.put('/api/admin/race-settings', { data: { startInSeconds: 0 } });
  const start = (await (await request.get('/api/race-settings')).json()).start_time;
  await expect.poll(() => page.evaluate(() => raceStart), { timeout: 10_000 }).toBe(start);
  await page.waitForTimeout(50);
  await keypad(page, '5'); // riktig målgång
  await expect.poll(async () => (await race.scanOf('5')).timestamp, { timeout: 15_000 }).toBeGreaterThanOrEqual(start);
  const results = await (await request.get('/api/results')).json();
  expect(results.find((r) => r.startnummer === '5').times[race.finishId]).toBeGreaterThanOrEqual(start);
});

test('telefon med fel klocka: tiden räknas om till servertid', async ({ request, race, phone }) => {
  const { page } = await phone();
  await page.clock.setFixedTime(Date.now() - 3600_000); // telefonen går en timme efter
  await openScanner(page, race.token);
  await expect.poll(() => page.evaluate(() => clockOffset), { timeout: 10_000 }).toBeGreaterThan(3500_000);
  const now = Date.now();
  await keypad(page, '8');
  await expect.poll(() => race.scanOf('8'), { timeout: 15_000 }).toBeTruthy();
  expect(Math.abs((await race.scanOf('8')).timestamp - now)).toBeLessThan(5000);
});

test('samma löpare kvar i bild ger bara en registrering; funktionärskort ignoreras, okänd QR sparas ändå', async ({ race, phone }, info) => {
  const video = info.outputPath('qr.y4m');
  writeQrVideo(video, [`${BASE}/l/31`, `${BASE}/scan/${race.token}`, 'HEJ']);
  const { page } = await phone({ video });
  await openScanner(page, race.token);
  await expect.poll(() => race.scanOf('31'), { timeout: 20_000 }).toBeTruthy();
  await expect.poll(() => race.scanOf('HEJ'), { timeout: 20_000 }).toBeTruthy();
  const first = (await race.scanOf('31')).timestamp;
  await page.waitForTimeout(3000); // många bildrutor med samma kod
  expect((await race.scanOf('31')).timestamp).toBe(first);
  await expect(page.locator('#log div', { hasText: '#31 @' })).toHaveCount(1);
  expect((await race.scans()).some((s) => s.runner_id.includes('/scan/'))).toBe(false);
});

test('knappsatsen: radera, avbryt, tom registrering och max sex siffror', async ({ race, phone }) => {
  const { page } = await phone();
  await openScanner(page, race.token);
  await page.click('#manualBtn');
  await typeDigits(page, '1234567');
  await expect(page.locator('#keypadDisplay')).toHaveText('123456');
  await typeDigits(page, '⌫⌫');
  await expect(page.locator('#keypadDisplay')).toHaveText('1234');
  await page.click('#keypadCancel'); // avbryt registrerar inget
  await page.click('#manualBtn');
  await expect(page.locator('#keypadDisplay')).toHaveText('');
  await page.click('#keypadOk'); // tomt: ingenting händer, knappsatsen står kvar öppen
  await expect(page.locator('#keypad')).toHaveClass(/open/);
  await typeDigits(page, '42');
  await page.click('#keypadOk');
  await expect(page.locator('#keypad')).not.toHaveClass(/open/);
  await expect.poll(() => race.scanOf('42')).toBeTruthy();
  expect(await race.scans()).toHaveLength(1);
});

test('samma löpare två gånger manuellt: första tiden gäller', async ({ race, phone }) => {
  const { page } = await phone();
  await openScanner(page, race.token);
  await keypad(page, '4');
  await expect.poll(() => race.scanOf('4')).toBeTruthy();
  const first = (await race.scanOf('4')).timestamp;
  await keypad(page, '4');
  await expect(page.locator('#flash')).toHaveClass('gray');
  await page.waitForTimeout(1000);
  expect((await race.scanOf('4')).timestamp).toBe(first);
});

test('osynkade skanningar överlever att fliken stängs och synkas när skannern öppnas igen', async ({ race, phone }) => {
  const { context, page } = await phone();
  await openScanner(page, race.token);
  await context.setOffline(true);
  await keypad(page, '15');
  await expect(page.locator('#status')).toContainText('1 ej synkade');
  await page.close();

  await context.setOffline(false);
  const again = await context.newPage();
  await openScanner(again, race.token);
  await expect.poll(() => race.scanOf('15'), { timeout: 15_000 }).toBeTruthy();
});

test('serverfel vid synk: skanningen ligger kvar och skickas igen', async ({ race, phone }) => {
  const { page } = await phone();
  await openScanner(page, race.token);
  let failures = 0;
  await page.route('**/api/scan', (route) => (failures++ < 2 ? route.fulfill({ status: 500 }) : route.continue()));
  await keypad(page, '16');
  await expect(page.locator('#status')).toContainText('1 ej synkade');
  await expect.poll(() => race.scanOf('16'), { timeout: 20_000 }).toBeTruthy();
  expect(failures).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#status')).toContainText('allt synkat');
});

test('GPS-position och funktionärens namn sparas med skanningen', async ({ race, phone }) => {
  const { page } = await phone({ geolocation: { latitude: 57.7, longitude: 11.97 } });
  await openScanner(page, race.token);
  await page.waitForTimeout(500); // låt första positionen komma in
  await keypad(page, '17');
  await expect.poll(() => race.scanOf('17')).toBeTruthy();
  const s = await race.scanOf('17');
  expect([s.lat, s.long, s.scanned_by]).toEqual([57.7, 11.97, 'Anna']);
});

test('fri skanner utan funktionärskort väljer målet och varnar för okänd station', async ({ race, phone }) => {
  const { page } = await phone();
  await page.goto('/scanner');
  await expect(page.locator('#stationId')).toHaveValue(race.finishId);
  await expect(page.locator('#status')).not.toContainText('okänd station');
  await page.fill('#stationId', 'felstavad');
  await expect(page.locator('#status')).toContainText('okänd station');
});

test('funktionärskortet låser stationen', async ({ race, phone }) => {
  const { page } = await phone();
  await openScanner(page, race.token);
  await expect(page.locator('#stationId')).toHaveValue(race.finishId);
  await expect(page.locator('#stationId')).toHaveJSProperty('readOnly', true);
});

test('framstegsraden visar antal och vilka anmälda som saknas', async ({ request, race, phone }) => {
  for (const nr of ['1', '2', '3']) await request.put(`/api/admin/participants/${nr}`, { data: { namn: `Löpare ${nr}` } });
  const { page } = await phone();
  await openScanner(page, race.token);
  await keypad(page, '2');
  await expect(page.locator('#progress')).toContainText('(1/3 anmälda)', { timeout: 10_000 });
  await expect(page.locator('#progress')).toContainText('Saknas: #1, #3');
});

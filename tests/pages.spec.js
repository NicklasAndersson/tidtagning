import { test, expect } from './helpers.js';

// Start för en minut sedan: A i mål efter 50 s, B efter 30 s, C bara vid kontrollen, D har inte passerat något
async function seedRace(request, race) {
  const start = Date.now() - 60_000;
  await request.put('/api/admin/race-settings', { data: { namn: 'Testloppet', startTime: start } });
  const cp = (await (await request.post('/api/admin/stations', { data: { namn: 'Km 5', ordning: 0 } })).json()).id;
  for (const [nr, namn, klass] of [['1', 'Anna A', 'Dam'], ['2', 'Bertil B', 'Herr'], ['3', 'Cecilia C', 'Dam'], ['4', 'David D', 'Herr']])
    await request.put(`/api/admin/participants/${nr}`, { data: { namn, klass } });
  await race.scan('1', start + 20_000, cp);
  await race.scan('1', start + 50_000);
  await race.scan('2', start + 15_000, cp);
  await race.scan('2', start + 30_000);
  await race.scan('3', start + 25_000, cp);
  return { start, cp };
}

test('resultatlistan: tid sedan start, mål först i tidsordning, klassfilter', async ({ page, request, race }) => {
  await seedRace(request, race);
  await page.goto('/results');
  await expect(page.locator('#title')).toHaveText('Testloppet');
  const rows = page.locator('#body tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Bertil B');
  await expect(rows.nth(0)).toContainText('00:00:30');
  await expect(rows.nth(1)).toContainText('Anna A');
  await expect(rows.nth(1)).toContainText('00:00:50');
  await expect(rows.nth(1)).toContainText('00:00:20'); // mellantid vid kontrollen

  await page.selectOption('#klassFilter', 'Dam');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#body')).not.toContainText('Bertil');
});

test('resultatlistan visar nedräkning före start', async ({ page, request }) => {
  await request.put('/api/admin/race-settings', { data: { startInSeconds: 3600 } });
  await page.goto('/results');
  await expect(page.locator('#countdown')).toContainText(/Start om 00:59:\d\d/);
});

test('ledarlistan: placering för dem i mål, sedan längst kommen, och sammanfattning', async ({ page, request, race }) => {
  await seedRace(request, race);
  await page.goto('/');
  const rows = page.locator('#board tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('1.');
  await expect(rows.nth(0)).toContainText('Bertil B');
  await expect(rows.nth(0)).toContainText('I mål');
  await expect(rows.nth(1)).toContainText('2.');
  await expect(rows.nth(2)).toContainText('Cecilia C');
  await expect(rows.nth(2)).toContainText('Km 5');
  await expect(rows.nth(3)).toContainText('Ej passerat');
  await expect(page.locator('#summary')).toHaveText('4 deltagare · 1 på banan · 2 i mål');
  await expect(page.locator('#clockLabel')).toHaveText('Tid sedan start');
});

test('gästsidan: namn, officiella passager och hejarop i tidslinjen', async ({ page, request, race }) => {
  await seedRace(request, race);
  await page.goto('/l/1');
  await expect(page.locator('#namn')).toHaveText('Anna A');
  await expect(page.locator('#timeline')).toContainText('Passerade Km 5');
  await expect(page.locator('#timeline')).toContainText('Passerade Mål');
  await page.fill('#kommentar', 'Kör hårt!');
  await page.click('text=Skicka hejarop');
  await expect(page.locator('#status')).toHaveText('Tack för hejaropet!');
  await expect(page.locator('#timeline')).toContainText('Kör hårt!');
  expect((await race.results()).find((r) => r.startnummer === '1').times).toHaveProperty(race.finishId); // opåverkad
});

test('gästsidan för okänt nummer', async ({ page }) => {
  await page.goto('/l/999');
  await expect(page.locator('#namn')).toHaveText('Löpare #999');
  await expect(page.locator('#timeline')).toContainText('Inget har hänt än.');
});

test('admin: "Starta loppet nu" sätter starttid från servern', async ({ page, request }) => {
  await page.goto('/admin');
  const before = Date.now();
  await page.click('text=Starta loppet nu');
  await expect(page.locator('#countdown')).toContainText('Loppet startade');
  const { start_time } = await (await request.get('/api/race-settings')).json();
  expect(Math.abs(start_time - before)).toBeLessThan(5_000);
});

test('admin: okänt startnummer namnges och får behålla sin tid', async ({ page, race }) => {
  await race.scan('88', 5_000);
  await page.goto('/admin');
  await page.locator('#unknown li', { hasText: '#88' }).getByText('Namnge').click();
  await expect(page.locator('#pStart')).toHaveValue('88');
  await page.fill('#pNamn', 'Nora N');
  await page.click('button:text-is("Spara")');
  await expect(page.locator('#participantsTable')).toContainText('Nora N');
  await expect.poll(async () => (await race.results()).find((r) => r.startnummer === '88')?.namn).toBe('Nora N');
});

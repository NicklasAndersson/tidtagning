import { test as base, expect, chromium } from '@playwright/test';

export const BASE = 'http://localhost:8799';
export { expect };

// Varje test startar med en tom tävling som har en målstation och ett funktionärskort till den
export const test = base.extend({
  race: async ({ request }, use) => {
    await request.post('/api/admin/reset');
    const finishId = (await (await request.post('/api/admin/stations', { data: { namn: 'Mål', typ: 'mal', lat: 59.3, long: 18.1 } })).json()).id;
    const token = (await (await request.post('/api/admin/funktionarer', { data: { stationId: finishId, namn: 'Anna' } })).json()).token;
    const scans = async () => (await request.get('/api/admin/scans')).json();
    const scanOf = async (runnerId, stationId = finishId) => (await scans()).find((s) => s.runner_id === runnerId && s.station_id === stationId);
    const results = async () => (await request.get('/api/results')).json();
    const scan = (runnerId, timestamp, stationId = finishId, extra = {}) =>
      request.post('/api/scan', { data: { runnerId, stationId, timestamp, ...extra } });
    await use({ finishId, token, scans, scanOf, results, scan });
  },

  // Egen webbläsare per "telefon", eftersom den falska kamerans video bestäms när webbläsaren startar
  phone: async ({}, use) => {
    const browsers = [];
    await use(async ({ video, camera = true, geolocation } = {}) => {
      const args = camera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [];
      if (video) args.push(`--use-file-for-fake-video-capture=${video}`);
      const browser = await chromium.launch({ args });
      browsers.push(browser);
      const permissions = [...(camera ? ['camera'] : []), ...(geolocation ? ['geolocation'] : [])];
      const context = await browser.newContext({ baseURL: BASE, permissions, geolocation });
      return { context, page: await context.newPage() };
    });
    for (const b of browsers) await b.close();
  },
});

export async function openScanner(page, token) {
  await page.goto(`/scan/${token}`);
  await expect(page.locator('#top b')).toHaveText('Mål');
}

export async function typeDigits(page, digits) {
  for (const d of digits) await page.locator('#keypadGrid button').getByText(d, { exact: true }).click();
}

export async function keypad(page, nr) {
  await page.click('#manualBtn');
  await typeDigits(page, nr);
  await page.click('#keypadOk');
}

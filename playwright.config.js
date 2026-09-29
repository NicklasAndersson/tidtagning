import { defineConfig } from '@playwright/test';

// Kör mot en riktig lokal worker + D1 (tom databas varje körning), seriellt eftersom testerna delar databasen
export default defineConfig({
  testDir: 'tests',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://localhost:8799', httpCredentials: { username: 'test', password: 'test' } },
  webServer: {
    command: 'rm -rf .wrangler-test && wrangler d1 execute tidtagning --local --persist-to .wrangler-test --file=schema.sql' +
      ' && wrangler dev --local --persist-to .wrangler-test --port 8799 --var ADMIN_USER:test --var ADMIN_PASS:test',
    url: 'http://localhost:8799/api/stations',
    timeout: 60_000,
  },
});

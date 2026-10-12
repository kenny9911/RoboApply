// extension/playwright.config.ts — end-to-end test of the unpacked extension.
// Run with `npm --prefix extension run e2e` (builds dist/e2e first). Needs a
// local Chromium (`npx playwright install chromium`); no network: the form is
// a local fixture routed to a Greenhouse URL and the API is a local fake.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});

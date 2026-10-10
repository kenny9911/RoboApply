// extension/test/e2e/fill.spec.ts — the unpacked extension on a Greenhouse form.
//
// Chromium with --load-extension (launchPersistentContext). The application
// page is the saved Greenhouse fixture served at a real Greenhouse URL by
// request routing, so the manifest's content script matches it; the API is a
// local fake (fakeApi.ts). Asserts: fields are filled, the resume is attached,
// an AI draft reaches the page only after "Use this answer", and nothing is
// ever submitted or pressed on the employer's form (D1).

import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_ORIGIN, E2E_TOKEN, startFakeApi, type Recorded } from './fakeApi';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXT_DIR = join(HERE, '../../dist/e2e');
const FIXTURE = readFileSync(join(HERE, '../fixtures/greenhouse/classic.html'), 'utf8');
const FORM_URL = 'https://boards.greenhouse.io/exampleco/jobs/1001';

let context: BrowserContext;
let worker: Worker;
let userDir: string;
let requests: Recorded[];
let closeApi: () => Promise<void>;
const employerRequests: string[] = [];

test.beforeAll(async () => {
  const api = await startFakeApi();
  requests = api.requests;
  closeApi = () => new Promise((r) => api.server.close(() => r()));
  userDir = mkdtempSync(join(tmpdir(), 'ra-ext-e2e-'));
  context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // Pair the way the web app would (ARCHITECTURE.md §6.3): the token lands in chrome.storage.local.
  await worker.evaluate(
    async ({ token, origin }) => {
      await chrome.storage.local.set({ 'ra.auth': { token, apiOrigin: origin, pairedAt: new Date().toISOString() } });
    },
    { token: E2E_TOKEN, origin: E2E_ORIGIN },
  );
  await context.route('https://boards.greenhouse.io/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') employerRequests.push(`${req.method()} ${req.url()}`);
    if (req.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
    return route.fulfill({ status: 204, body: '' });
  });
});

test.afterAll(async () => {
  await context?.close();
  await closeApi?.();
  rmSync(userDir, { recursive: true, force: true });
});

test('fills the Greenhouse form, attaches the resume, and never submits', async () => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __submits: number; __pressed: number };
    w.__submits = 0;
    w.__pressed = 0;
    document.addEventListener('submit', () => w.__submits++, true);
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        if (t?.closest('button, input[type="submit"], input[type="button"]')) w.__pressed++;
      },
      true,
    );
  });
  await page.goto(FORM_URL);

  // Nothing is sent on page load: the launcher only.
  await page.waitForTimeout(500);
  expect(requests.filter((r) => r.path.includes('/autofill-runs'))).toHaveLength(0);

  await page.getByRole('button', { name: 'Open RoboApply to fill this form' }).click();
  await expect(page.getByText('Good fit')).toBeVisible();
  await expect(page.getByText('This is not your chance of getting hired.')).toBeVisible();
  await page.getByRole('button', { name: 'Fill this form' }).click();
  await expect(page.getByText(/fields filled\./)).toBeVisible();

  await expect(page.locator('#first_name')).toHaveValue('Avery');
  await expect(page.locator('#last_name')).toHaveValue('Lin');
  await expect(page.locator('#email')).toHaveValue('avery@example.test');
  await expect(page.locator('#job_application_answers_attributes_1_boolean_value')).toHaveValue('1');
  await expect(page.locator('#job_application_answers_attributes_2_boolean_value')).toHaveValue('0');
  expect(await page.locator('#resume_file').evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? null)).toBe('Avery_Lin_Resume.pdf');

  // An AI draft stays in the panel until the user clicks "Use this answer".
  const why = page.locator('li', { hasText: 'Why do you want to work at Example Co?' });
  await why.getByRole('button', { name: 'Write a draft' }).click();
  await expect(why.getByRole('textbox')).toHaveValue('I want to run a platform that small teams rely on.');
  await expect(page.locator('#job_application_answers_attributes_3_text_value')).toHaveValue('');
  await why.getByRole('button', { name: 'Use this answer' }).click();
  await expect(page.locator('#job_application_answers_attributes_3_text_value')).toHaveValue('I want to run a platform that small teams rely on.');

  await expect(page.getByText('Check the form, then submit it yourself.')).toBeVisible();
  await expect(page.getByText('Did you submit this application?')).toBeVisible();

  // D1: nothing was submitted or pressed on the employer's form.
  const counts = await page.evaluate(() => (window as unknown as { __submits: number; __pressed: number }));
  expect(counts.__submits).toBe(0);
  expect(counts.__pressed).toBe(0);
  expect(employerRequests).toEqual([]);

  const patches = requests.filter((r) => r.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0].body).toMatchObject({ outcome: 'partial' });
  expect((patches[0].body as { fieldsFilled: number }).fieldsFilled).toBeGreaterThan(0);
  expect((patches[0].body as { userMarkedSubmitted?: boolean }).userMarkedSubmitted).toBeUndefined();
  expect(requests.every((r) => r.auth === `Bearer ${E2E_TOKEN}`)).toBe(true);
});

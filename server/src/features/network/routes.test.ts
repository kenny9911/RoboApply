// @vitest-environment node
//
// WP-54 route tests: auth (401), the hiringContacts gate (404
// feature_disabled before the upload is read), the multipart import, the
// email lookup (404 when its flag is off, 501 provider_not_configured when
// on), drafts (201, credits, AI gate) and "there is no send route" (D1).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { flagEnvName, setFlagOverrideLoader } from '../../platform/flags.js';
import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createNetworkRouter } from './routes.js';
import { createNetworkFixture, jobRow } from './testkit.js';

const BASE = '/api/v1/roboapply/network';
const U = 'user_1';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

const CSV = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Lovelace,https://www.linkedin.com/in/ada,ada@x.example,Acme Analytics,Engineer,15 Mar 2021\n';

const kit = createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') });
const f = createNetworkFixture({ credits: kit.credits });
f.store.jobs.set('job_1', jobRow());
const passPhone: RequestHandler = (_req, _res, next) => next();
const auth = [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: U }))];

const envOn = { [flagEnvName('roboapply', 'hiringContacts')]: 'on', [flagEnvName('roboapply', 'contactEmailLookup')]: 'false' };
const envLookup = { [flagEnvName('roboapply', 'hiringContacts')]: 'on', [flagEnvName('roboapply', 'contactEmailLookup')]: 'true', CONTACT_EMAIL_PROVIDER: 'x' };
const envDeeplinks = { [flagEnvName('roboapply', 'hiringContacts')]: 'deeplinks_only' };

let on: RouteHarness;
let lookupOn: RouteHarness;
let deeplinks: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const mount = (env: Record<string, string>) => createNetworkRouter({ seekerAuth: auth, env }, { service: f.service, phoneGate: passPhone });
  on = await startRouteHarness({ mounts: [[BASE, mount(envOn)]] });
  lookupOn = await startRouteHarness({ mounts: [[BASE, mount(envLookup)]] });
  deeplinks = await startRouteHarness({ mounts: [[BASE, mount(envDeeplinks)]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), lookupOn.close(), deeplinks.close()]);
});

async function upload(h: RouteHarness, text: string, name = 'Connections.csv') {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), name);
  const res = await fetch(`${h.baseUrl}${BASE}/imports/linkedin-connections`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Env<{ rowCount: number; importedCount: number }> };
}

describe('network routes', () => {
  it('401 without a session', async () => {
    for (const [method, path] of [
      ['GET', '/jobs/job_1/connections'],
      ['POST', '/outreach-drafts'],
      ['DELETE', '/imports/linkedin-connections'],
    ] as const) {
      const res = await on.request(method, `${BASE}${path}`, { headers: { 'x-test-anon': '1' }, body: method === 'POST' ? {} : undefined });
      expect(res.status, path).toBe(401);
    }
  });

  it('GET /jobs/:id/connections → buckets, links, mode', async () => {
    const res = await on.request<Env<{ mode: string; searchLinks: unknown[] }>>('GET', `${BASE}/jobs/job_1/connections`);
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('on');
    const missing = await on.request<Env<unknown>>('GET', `${BASE}/jobs/nope/connections`);
    expect(missing.status).toBe(404);
  });

  it('POST /imports/linkedin-connections (multipart) → 201; no email kept', async () => {
    const res = await upload(on, CSV);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ rowCount: 1, importedCount: 1 });
    expect(JSON.stringify(f.store.contacts)).not.toContain('ada@x.example');
    const status = await on.request<Env<{ importedCount: number; importsToday: number; limitPerDay: number }>>('GET', `${BASE}/imports/linkedin-connections`);
    expect(status.body.data).toMatchObject({ importedCount: 1, importsToday: 1, limitPerDay: 3 });
  });

  it('422 for a missing file or a non-CSV upload', async () => {
    const empty = await fetch(`${on.baseUrl}${BASE}/imports/linkedin-connections`, { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(422);
    const pdf = await upload(on, '%PDF-1.4', 'resume.pdf');
    expect(pdf.status).toBe(422);
  });

  it('mode deeplinks_only: the import and contacts answer 404 feature_disabled; delete-all still works', async () => {
    const res = await upload(deeplinks, CSV);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    const contacts = await deeplinks.request<Env<unknown>>('GET', `${BASE}/contacts`);
    expect(contacts.status).toBe(404);
    const del = await deeplinks.request<Env<{ deleted: number }>>('DELETE', `${BASE}/imports/linkedin-connections`);
    expect(del.status).toBe(200);
  });

  it('contacts: POST 201, GET lists, DELETE', async () => {
    const created = await on.request<Env<{ id: string }>>('POST', `${BASE}/contacts`, { body: { fullName: 'Jo Bloggs', companyName: 'Acme' } });
    expect(created.status).toBe(201);
    const list = await on.request<Env<{ items: Array<{ id: string }> }>>('GET', `${BASE}/contacts`);
    expect(list.body.data.items.map((c) => c.id)).toContain(created.body.data.id);
    const bad = await on.request<Env<unknown>>('POST', `${BASE}/contacts`, { body: { fullName: 'x', companyName: 'y', email: 'x@y.z' } });
    expect(bad.status).toBe(422);
    const del = await on.request<Env<unknown>>('DELETE', `${BASE}/contacts/${created.body.data.id}`);
    expect(del.status).toBe(200);
  });

  it('lookup-email: 404 with its flag off, 501 provider_not_configured with it on', async () => {
    const off = await on.request<Env<unknown>>('POST', `${BASE}/contacts/c1/lookup-email`);
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    const res = await lookupOn.request<Env<unknown>>('POST', `${BASE}/contacts/c1/lookup-email`);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('provider_not_configured');
  });

  it('POST /outreach-drafts → 201 draft; PATCH, copied, sent; list by job', async () => {
    const res = await on.request<Env<{ id: string; body: string }>>('POST', `${BASE}/outreach-drafts`, {
      body: { jobId: 'job_1', channel: 'linkedin_note' },
      headers: { 'Idempotency-Key': 'r1' },
    });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const patched = await on.request<Env<{ body: string }>>('PATCH', `${BASE}/outreach-drafts/${id}`, { body: { body: 'Edited.' } });
    expect(patched.body.data.body).toBe('Edited.');
    expect((await on.request('POST', `${BASE}/outreach-drafts/${id}/copied`)).status).toBe(200);
    expect((await on.request('POST', `${BASE}/outreach-drafts/${id}/sent`)).status).toBe(200);
    const list = await on.request<Env<{ items: Array<{ id: string; markedSentAt: string | null }> }>>('GET', `${BASE}/outreach-drafts?jobId=job_1`);
    expect(list.body.data.items[0]).toMatchObject({ id, markedSentAt: expect.any(String) });
    const noFilter = await on.request<Env<unknown>>('GET', `${BASE}/outreach-drafts`);
    expect(noFilter.status).toBe(422);
  });

  it('503 ai_unavailable with AI off (zero model calls)', async () => {
    f.state.ai = false;
    const before = f.calls.length;
    const res = await on.request<Env<unknown>>('POST', `${BASE}/outreach-drafts`, { body: { jobId: 'job_1', channel: 'email' } });
    f.state.ai = true;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
    expect(f.calls.length).toBe(before);
  });

  it('D1: there is no send route', async () => {
    const res = await on.request('POST', `${BASE}/outreach-drafts/x/send`);
    expect(res.status).toBe(404);
    const router = createNetworkRouter({ seekerAuth: auth });
    const paths = (router as unknown as { stack: Array<{ route?: { path: string } }> }).stack.map((l) => l.route?.path ?? '');
    expect(paths.filter((p) => /\/send\b|deliver|submit/.test(p))).toEqual([]);
  });
});

// @vitest-environment node
//
// WP-38 route tests: the legacy /v2/tracker router (extended) and the new
// feature router mounted after it at the same base, as in production, over
// the fake Prisma (no network, no database).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const holder = vi.hoisted(() => ({ db: null as unknown, userId: 'u1' as string | null }));
vi.mock('../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: (_t, prop) => (holder.db as Record<string | symbol, unknown>)[prop] }),
}));
vi.mock('../../roboapply/v2/lib/raAuth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!holder.userId) return res.status(401).json({ error: 'unauthorized' });
    (req as Request & { user?: { id: string } }).user = { id: holder.userId };
    next();
  },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import legacyTrackerRouter from '../../roboapply/v2/routes/tracker.js';
import { createTrackerRouter, TRACKER_EXPORT_LIMIT_NAME, TRACKER_EXPORT_WINDOWS } from './routes.js';

const BASE = '/api/v1/roboapply/v2/tracker';
const RA = 'localhost:3621';
const GA = 'goapply.localhost:3621';
const DAY = 86_400_000;

function makeFake() {
  return createFakePrisma({
    timestampFields: ['createdAt', 'updatedAt', 'dateSaved'],
    defaults: { rATrackerEntry: { excitementStars: 0, deletedAt: null }, rATrackerEvent: { fromValue: null, toValue: null, payload: null } },
    seed: {
      rAJob: [
        { id: 'job1', title: 'Data Analyst', companyName: 'Acme', companyLogoUrl: null, location: null, workType: 'onsite', applyUrl: 'https://acme.example/1', closedAt: null, archivedAt: null, expiresAt: null, salaryMax: null, salaryCurrency: null },
      ],
    },
  });
}

const limiterCalls: string[] = [];
const limiter = (name: string, windows: readonly { limit: number; windowSec: number }[]): RequestHandler => (_req, _res, next) => {
  limiterCalls.push(`${name}:${windows.map((w) => `${w.limit}/${w.windowSec}`).join(',')}`);
  next();
};

let h: RouteHarness;
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

beforeAll(async () => {
  h = await startRouteHarness({
    env: {},
    mounts: [
      [BASE, legacyTrackerRouter],
      [BASE, createTrackerRouter({ seekerAuth: [fakeAuth(() => (holder.userId ? { id: holder.userId } : null))] }, { limiter })],
    ],
  });
});
afterAll(() => h.close());
beforeEach(() => {
  holder.db = makeFake();
  holder.userId = 'u1';
  limiterCalls.length = 0;
});

const fake = () => holder.db as ReturnType<typeof createFakePrisma>;

async function createEntry(body: Record<string, unknown>, host = RA) {
  const res = await h.request<{ entry: { id: string; status: string } }>('POST', BASE, { host, body });
  expect(res.status).toBe(201);
  return res.body.entry;
}

describe('legacy /v2/tracker (extended)', () => {
  it('PATCH writes an RATrackerEvent per change and keeps the legacy shape', async () => {
    const entry = await createEntry({ jobId: 'job1' });
    const res = await h.request<{ entry: Record<string, unknown> }>('PATCH', `${BASE}/${entry.id}`, {
      host: RA,
      body: { status: 'applied', interviewAt: '2026-10-20T15:00:00.000Z', unknownKey: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({ status: 'applied', interviewAt: '2026-10-20T15:00:00.000Z', outcome: null });
    expect(typeof res.body.entry.dateApplied).toBe('string');
    const kinds = fake()
      .$rows('rATrackerEvent')
      .map((e) => e.kind);
    expect(kinds).toEqual(['created', 'status', 'interview']);
  });

  it('records who ended it', async () => {
    const entry = await createEntry({ jobId: 'job1', status: 'applied' });
    const res = await h.request<{ entry: Record<string, unknown> }>('PATCH', `${BASE}/${entry.id}`, { host: RA, body: { outcome: 'job_pulled' } });
    expect(res.body.entry).toMatchObject({ status: 'closed', outcome: 'job_pulled' });
  });

  it('validates the status against the brand ladder (422)', async () => {
    const entry = await createEntry({ jobId: 'job1' });
    const ra = await h.request<{ error: string }>('PATCH', `${BASE}/${entry.id}`, { host: RA, body: { status: 'written_test' } });
    expect(ra.status).toBe(422);
    expect(ra.body.error).toBe('invalid_status');
    const bogus = await h.request('PATCH', `${BASE}/${entry.id}`, { host: RA, body: { status: 'submitted' } });
    expect(bogus.status).toBe(422);
    const ga = await h.request<{ entry: { status: string } }>('PATCH', `${BASE}/${entry.id}`, { host: GA, body: { status: 'written_test' } });
    expect(ga.status).toBe(200);
    expect(ga.body.entry.status).toBe('written_test');
  });

  it('lists with q, view=date, status counts and ignores unknown status filters', async () => {
    await createEntry({ jobId: 'job1', status: 'applied' });
    await createEntry({ externalSnapshot: { title: 'Engineer', companyName: 'Initech', applyUrl: null } });
    const res = await h.request<{ entries: Array<{ status: string }>; statusCounts: Record<string, number>; total: number }>(
      'GET',
      `${BASE}?q=initech&view=date&status=bogus`,
      { host: RA },
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.statusCounts).toMatchObject({ applied: 1, bookmarked: 1 });
  });

  it('keeps the legacy errors: 404, 409 duplicate, 422 missing job, 401', async () => {
    expect((await h.request('GET', `${BASE}/nope`, { host: RA })).status).toBe(404);
    await createEntry({ jobId: 'job1' });
    const dup = await h.request<{ error: string }>('POST', BASE, { host: RA, body: { jobId: 'job1' } });
    expect([dup.status, dup.body.error]).toEqual([409, 'duplicate_tracker_entry']);
    const missing = await h.request<{ error: string }>('POST', BASE, { host: RA, body: {} });
    expect([missing.status, missing.body.error]).toEqual([422, 'Missing jobId or externalSnapshot']);
    holder.userId = null;
    expect((await h.request('GET', BASE, { host: RA })).status).toBe(401);
  });
});

describe('new tracker paths', () => {
  it('GET /follow-ups reaches the feature router (not the legacy /:id) and returns facts', async () => {
    const entry = await createEntry({ jobId: 'job1', status: 'applied', dateApplied: new Date(Date.now() - 12 * DAY).toISOString() });
    const res = await h.request<Env<{ items: Array<{ entryId: string; reason: string }> }>>('GET', `${BASE}/follow-ups`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ entryId: entry.id, reason: 'no_reply_10d', companyName: 'Acme' })]);
  });

  it('GET /export.csv returns CSV behind the 5-a-day limit', async () => {
    await createEntry({ jobId: 'job1', status: 'applied' });
    const res = await h.request('GET', `${BASE}/export.csv`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="applications-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text).toContain('Acme');
    expect(limiterCalls).toEqual([`${TRACKER_EXPORT_LIMIT_NAME}:5/86400`]);
    expect(TRACKER_EXPORT_WINDOWS).toEqual([{ limit: 5, windowSec: 86400 }]);
  });

  it('events: add a note, then read the timeline', async () => {
    const entry = await createEntry({ jobId: 'job1' });
    const add = await h.request<Env<{ kind: string }>>('POST', `${BASE}/${entry.id}/events`, { host: RA, body: { note: 'Called the recruiter.' } });
    expect(add.status).toBe(201);
    expect(add.body.data.kind).toBe('note');
    const list = await h.request<Env<{ items: Array<{ kind: string }> }>>('GET', `${BASE}/${entry.id}/events`, { host: RA });
    expect(list.body.data.items.map((e) => e.kind).sort()).toEqual(['created', 'note']);
    const bad = await h.request<Env<unknown>>('POST', `${BASE}/${entry.id}/events`, { host: RA, body: { note: '' } });
    expect(bad.status).toBe(422);
  });

  it('artifacts and events 404 for another user’s entry; 401 without a session', async () => {
    const entry = await createEntry({ jobId: 'job1' });
    holder.userId = 'u2';
    const res = await h.request<Env<unknown>>('GET', `${BASE}/${entry.id}/artifacts`, { host: RA });
    expect([res.status, res.body.code]).toEqual([404, 'not_found']);
    holder.userId = null;
    expect((await h.request('GET', `${BASE}/follow-ups`, { host: RA })).status).toBe(401);
  });

  it('artifacts lists the files sent', async () => {
    const entry = await createEntry({ jobId: 'job1' });
    fake()
      .$rows('rAApplicationArtifact')
      .push({ id: 'a1', userId: 'u1', trackerEntryId: entry.id, kind: 'cover_letter', fileName: 'Letter.pdf', format: 'pdf', fileSha256: 'x', channel: 'extension', variantId: null, coverLetterId: 'cl1', createdAt: new Date() });
    const res = await h.request<Env<{ items: Array<{ fileName: string; via: string }> }>>('GET', `${BASE}/${entry.id}/artifacts`, { host: RA });
    expect(res.body.data.items).toEqual([expect.objectContaining({ fileName: 'Letter.pdf', via: 'extension', kind: 'cover_letter' })]);
  });
});

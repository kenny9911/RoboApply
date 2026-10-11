// @vitest-environment node
//
// Admin console routes (WP-74): admin only (401 without a session, 403 for a
// non-admin, on every route), the real `requireAdmin` behind a fake session,
// in-memory stores (no database, no network). Audit rows go to an in-memory
// RAAdminAuditLog store (admin, subject user, event, payload); the System
// panel's "Admin actions" view reads the same store.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => { throw new Error('tests must not reach Prisma'); } }),
}));

import { requireAdmin } from '../../../middleware/admin.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../../test/routeHarness.js';
import { createAdminConsoleRouter } from '../routes.js';
import type { AdminAuditStore, StoredAdminAuditRow } from '../audit.js';
import type { QueueStore } from '../queue.js';
import type { ReportsStore, ReportJobRow, DecisionRow } from '../reports.js';
import type { OverridesService } from '../overrides.js';
import type { ReferralModeration } from '../moderation.js';
import { KEEP_DECISION_HOLDS } from '../reports.js';
import { registerSourceAdapter, type JobSourceAdapter } from '../../jobs/ingest/index.js';
import { getCurrentBrandId } from '../../../platform/brand/index.js';
import { PROVIDER_STATES, type ProviderUsageRow } from '../contract.js';
import { fakeSystemData, fakeSystemStore, type FakeSystemData } from './fakes.js';

const ENV = { NODE_ENV: 'test', ALLOWED_BRANDS: 'roboapply,goapply' };

let harness: RouteHarness;
/** What the fake System store answers; a test may replace it (reset before each test). */
let systemData: FakeSystemData = fakeSystemData();
let who: HarnessUser | null = { id: 'admin1', role: 'admin' };
const audits: StoredAdminAuditRow[] = [];
let auditClock = Date.parse('2026-10-10T12:00:00Z');
const decisions: DecisionRow[] = [];
const jobUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
const overrideCalls: string[] = [];
const moderations: string[] = [];

const referrals: ReferralModeration = {
  find: async (id) => (id === 'rc1' ? { userId: 'u1', status: 'pending' } : null),
  moderate: async (moderatorId, id, body) => {
    moderations.push(`${moderatorId}:${id}:${body.decision}`);
    return { id, status: body.decision === 'approve' ? 'approved' : 'rejected' };
  },
};

const audit: AdminAuditStore = {
  record: async (row) => {
    auditClock += 1000;
    audits.push({ ...row, id: `al_${audits.length + 1}`, createdAt: new Date(auditClock) });
  },
  list: async (q) =>
    audits
      .filter((r) => (!q.eventType || r.eventType === q.eventType) && (!q.subjectUserId || r.subjectUserId === q.subjectUserId) && (!q.adminId || r.adminId === q.adminId))
      .filter((r) => !q.before || r.createdAt < q.before.createdAt || (r.createdAt.getTime() === q.before.createdAt.getTime() && r.id < q.before.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, q.take),
};

const job: ReportJobRow = {
  id: 'job1',
  title: 'Data analyst',
  companyName: 'Acme',
  market: 'intl',
  visibility: 'public',
  sourceName: 'Greenhouse',
  applyUrl: 'https://example.com/apply',
  closedAt: null,
  archivedAt: null,
  closeReason: null,
  fraudFlags: null,
};

const reports: ReportsStore = {
  reportedJobIds: async () => ['job1'],
  closedReportedJobIds: async () => [],
  flaggedIntlJobIds: async () => [],
  jobs: async () => [job],
  reports: async () => [{ jobId: 'job1', reasonCode: 'expired', note: 'Write to me at jane@example.com', createdAt: new Date('2026-10-09T10:00:00Z') }],
  decisions: async () => decisions,
  loadJob: async (id) => (id === 'job1' ? job : null),
  updateJob: async (id, data) => {
    jobUpdates.push({ id, data });
  },
  addDecision: async (row) => {
    decisions.push(row);
  },
};

const queue: QueueStore = {
  list: async () => [],
  find: async (id) => (id === 'w_dead' ? { id, status: 'dead', kind: 'job.enrich', brand: 'roboapply', userId: null } : id === 'w_done' ? { id, status: 'done', kind: 'job.enrich', brand: null, userId: null } : null),
  retry: async () => true,
};

const overrides: OverridesService = {
  listOverrides: async () => ({ items: [{ id: 'ov1', userId: 'u1', key: 'bucket:tailor', value: 5, reason: 'beta', adminId: 'admin1', expiresAt: null, createdAt: '2026-10-01T00:00:00.000Z' }], cursor: null }),
  createOverride: async (body, adminId) => {
    overrideCalls.push(`create:${body.key}`);
    return { id: 'ov2', userId: body.userId, key: body.key, value: body.value, reason: body.reason, adminId, expiresAt: body.expiresAt ?? null, createdAt: '2026-10-10T00:00:00.000Z' };
  },
  deleteOverride: async (id) => {
    overrideCalls.push(`delete:${id}`);
  },
};

beforeAll(async () => {
  harness = await startRouteHarness({
    env: ENV,
    mounts: [
      [
        '/admin',
        createAdminConsoleRouter({
          adminAuth: [fakeAuth(() => who), requireAdmin],
          env: ENV,
          now: () => new Date('2026-10-10T12:00:00Z'),
          system: fakeSystemStore(() => systemData),
          queue,
          reports,
          audit,
          overrides,
          referrals,
          costs: { costRows: async () => [{ day: '2026-10-09', sku: 'ra_copilot_turn', brand: 'roboapply', costUsd: 1.25, units: 0, rows: 3, unpricedRows: 0 }] },
          safety: { list: async () => [], verdictCounts: async () => [{ verdict: 'block', count: 2 }] },
          feedback: {
            list: async () => ({ items: [{ messageId: 'm2', threadId: 't1', userId: 'u1', value: 'down', note: 'Call me on +1 415 555 0100', createdAt: '2026-10-09T00:00:00.000Z' }], cursor: null }),
            context: async () => [{ id: 'm2', role: 'assistant', content: 'Here are jobs.' }],
            guardHits: async () => new Map([['m2', 1]]),
            userNames: async () => new Map(),
          },
        }),
      ],
    ],
  });
});
afterAll(() => harness.close());

beforeEach(() => {
  who = { id: 'admin1', role: 'admin' };
  systemData = fakeSystemData();
  audits.length = 0;
  decisions.length = 0;
  jobUpdates.length = 0;
  overrideCalls.length = 0;
  moderations.length = 0;
});

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/admin/system'],
  ['GET', '/admin/system/queue'],
  ['POST', '/admin/system/queue/w_dead/retry'],
  ['GET', '/admin/system/audit'],
  ['GET', '/admin/costs'],
  ['GET', '/admin/costs.csv'],
  ['GET', '/admin/safety'],
  ['GET', '/admin/reports'],
  ['POST', '/admin/reports/job1/resolve', { decision: 'close' }],
  ['GET', '/admin/overrides'],
  ['POST', '/admin/overrides', { userId: 'u1', key: 'bucket:tailor', value: 3, reason: 'support' }],
  ['DELETE', '/admin/overrides/ov1'],
  ['GET', '/admin/copilot-feedback'],
  ['POST', '/admin/referrals/rc1/moderate', { decision: 'approve' }],
];

describe('admin only', () => {
  it.each(ROUTES)('%s %s → 401 without a session', async (method, path, body) => {
    who = null;
    const res = await harness.request(method, path, { body });
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('%s %s → 403 for a signed-in non-admin', async (method, path, body) => {
    who = { id: 'u1', role: 'user' };
    const res = await harness.request(method, path, { body });
    expect(res.status).toBe(403);
    expect(audits).toEqual([]);
    expect(jobUpdates).toEqual([]);
    expect(overrideCalls).toEqual([]);
    expect(moderations).toEqual([]);
  });
});

describe('as an admin', () => {
  it('GET /system reads every served brand', async () => {
    const res = await harness.request<{ data: { brands: Array<{ brand: string }>; brandsServed: string[]; queue: { deadTotal: number } } }>('GET', '/admin/system');
    expect(res.status).toBe(200);
    expect(res.body.data.brands.map((b) => b.brand)).toEqual(['roboapply', 'goapply']);
    expect(res.body.data.brandsServed).toEqual(['roboapply', 'goapply']);
    expect(res.body.data.queue.deadTotal).toBe(3);
  });

  it('GET /system lists every provider of the served brands with its quota reading, with or without a call today (JI-1)', async () => {
    // Two search providers that are on (no key is read: the adapters are test doubles and never fetch).
    const on = (provider: 'activejobs' | 'jsearch'): JobSourceAdapter => ({
      provider,
      kind: 'search',
      markets: ['intl'],
      sourceBoards: [provider],
      isEnabled: () => true,
      supportsCountry: () => true,
      dailyCallLimit: () => null,
      fetch: async () => ({ jobs: [], calls: 0 }),
    });
    registerSourceAdapter(on('activejobs'), { replace: true });
    registerSourceAdapter(on('jsearch'), { replace: true });
    systemData = fakeSystemData({
      // jsearch made calls today (the default row); activejobs made none; one mainland counter exists.
      providers: [
        { provider: 'jsearch', calls: 20, jobsReturned: 400, jobsNew: 50, errors: 0 },
        { provider: 'activejobs:cn', calls: 2, jobsReturned: 30, jobsNew: 4, errors: 0 },
      ],
      quota: {
        activejobs: { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: '2026-10-27T12:00:00.000Z', state: 'exhausted', lastStatus: 429 },
        jsearch: { requestsLimit: 10_000, requestsRemaining: 9_773 },
      },
    });
    const res = await harness.request<{ data: { providers: ProviderUsageRow[]; alerts: Array<{ key: string; subject: string | null; state?: string; daysToReset?: number | null }> } }>('GET', '/admin/system');
    expect(res.status).toBe(200);
    const rows = res.body.data.providers;
    const of = (provider: string) => rows.find((r) => r.provider === provider)!;

    // The response shape: every row carries every field of the contract, and a known state.
    const FIELDS = ['provider', 'market', 'calls', 'limit', 'jobsReturned', 'jobsNew', 'errors', 'plan', 'requestsLimit', 'requestsRemaining', 'jobsLimit', 'jobsRemaining', 'resetAt', 'daysToReset', 'observedAt', 'costModel', 'state'];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(Object.keys(row).sort(), row.provider).toEqual([...FIELDS].sort());
      expect(PROVIDER_STATES).toContain(row.state);
      expect(['intl', 'cn']).toContain(row.market);
      expect(['free', 'per_job', 'per_request']).toContain(row.costModel);
    }

    // Dead since its monthly quota ran out, no call today: still listed, with plan, what is left and the days to reset.
    expect(of('activejobs')).toEqual({
      // The daily limit is what ingest may still call today: nothing, with 0 of 25 left.
      provider: 'activejobs', market: 'intl', calls: 0, limit: 0, jobsReturned: 0, jobsNew: 0, errors: 0,
      plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: null, jobsRemaining: null, resetAt: '2026-10-27T12:00:00.000Z', daysToReset: 17, observedAt: '2026-10-10T11:00:00.000Z',
      costModel: 'per_job', state: 'exhausted',
    });
    expect(of('jsearch')).toMatchObject({ market: 'intl', calls: 20, limit: 200, plan: null, requestsLimit: 10_000, requestsRemaining: 9_773, daysToReset: null, costModel: 'per_request', state: 'ok' });
    // The mainland counter is its own row; it shares the provider's one plan.
    expect(of('activejobs:cn')).toMatchObject({ market: 'cn', calls: 2, limit: 0, jobsReturned: 30, jobsNew: 4, plan: 'BASIC', requestsRemaining: 0, daysToReset: 17, costModel: 'per_job', state: 'exhausted' });
    // Both brands are served: the banks of both markets are listed, unmetered, with no quota fields.
    expect(of('bank_robohire')).toMatchObject({ market: 'intl', limit: null, plan: null, requestsLimit: null, daysToReset: null, observedAt: null, costModel: 'free' });
    expect(of('bank_gohire:cn')).toMatchObject({ market: 'cn', limit: null, plan: null, costModel: 'free' });
    expect(rows.map((r) => r.provider)).not.toContain('user_import');

    expect(res.body.data.alerts.filter((a) => a.key === 'provider_quota')).toEqual([
      { key: 'provider_quota', brand: null, subject: 'activejobs', value: 0, level: 0, state: 'exhausted', daysToReset: 17 },
      { key: 'provider_quota', brand: null, subject: 'activejobs:cn', value: 0, level: 0, state: 'exhausted', daysToReset: 17 },
    ]);

    // The same deployment with nothing recorded: the provider is listed as unknown, with no number made up.
    systemData = fakeSystemData({ providers: [] });
    const blank = await harness.request<{ data: { providers: ProviderUsageRow[] } }>('GET', '/admin/system?brand=goapply');
    expect(blank.body.data.providers.find((r) => r.provider === 'activejobs')).toEqual({
      provider: 'activejobs', market: 'intl', calls: 0, limit: 300, jobsReturned: 0, jobsNew: 0, errors: 0,
      plan: null, requestsLimit: null, requestsRemaining: null, jobsLimit: null, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: null,
      costModel: 'per_job', state: 'unknown',
    });
  });

  it('GET /system reports the same providers and sources from either brand\u2019s host', async () => {
    // A provider that answers "off" when it is asked as the mainland brand (it is never called for that market).
    const adapter = (isEnabled: () => boolean): JobSourceAdapter => ({ provider: 'jsearch', kind: 'search', markets: ['intl'], sourceBoards: ['jsearch'], isEnabled, supportsCountry: () => true, dailyCallLimit: () => null, fetch: async () => ({ jobs: [], calls: 0 }) });
    registerSourceAdapter(adapter(() => getCurrentBrandId() !== 'goapply'), { replace: true });
    type Body = { data: { providers: ProviderUsageRow[]; brands: Array<{ brand: string; sources: Array<{ provider: string; enabled: boolean; reason: string | null }> }>; alerts: unknown[] } };
    const from = async (host: string) => (await harness.request<Body>('GET', '/admin/system', { host })).body.data;
    const robo = await from('roboapply.localhost:3611');
    const go = await from('goapply.localhost:3621');
    expect(go.providers).toEqual(robo.providers);
    expect(go.alerts).toEqual(robo.alerts);
    expect(go.providers.find((r) => r.provider === 'jsearch')).toMatchObject({ market: 'intl', state: 'unknown' });
    const sourceOf = (data: Body['data']) => data.brands.find((b) => b.brand === 'roboapply')!.sources.find((x) => x.provider === 'jsearch');
    expect(sourceOf(go)).toMatchObject({ enabled: true, reason: null });
    expect(sourceOf(go)).toEqual(sourceOf(robo));
    registerSourceAdapter(adapter(() => true), { replace: true });
  });

  it('GET /system?brand= narrows to one brand; an unknown brand is a 422', async () => {
    const one = await harness.request<{ data: { brands: Array<{ brand: string }> } }>('GET', '/admin/system?brand=goapply');
    expect(one.body.data.brands.map((b) => b.brand)).toEqual(['goapply']);
    expect((await harness.request('GET', '/admin/system?brand=robohire')).status).toBe(422);
  });

  it('retries a dead item and audits it; a done item is a 409, a missing one 404', async () => {
    const ok = await harness.request<{ data: unknown }>('POST', '/admin/system/queue/w_dead/retry');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: 'w_dead', status: 'queued' });
    expect(audits).toEqual([expect.objectContaining({ adminId: 'admin1', subjectUserId: null, eventType: 'admin_work_item_retried', payload: { workItemId: 'w_dead', kind: 'job.enrich' } })]);
    expect((await harness.request('POST', '/admin/system/queue/w_done/retry')).status).toBe(409);
    expect((await harness.request('POST', '/admin/system/queue/nope/retry')).status).toBe(404);
  });

  it('GET /costs.csv is a formula-safe CSV download', async () => {
    const res = await harness.request('GET', '/admin/costs.csv?from=2026-10-01&to=2026-10-09');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toContain('costs-2026-10-01-to-2026-10-09.csv');
    expect(res.text.replace(/^﻿/, '').split('\n')[0]).toBe('day,sku,brand,platform,costUsd,units,rows,unpricedRows');
    expect(res.text).toContain('2026-10-09,ra_copilot_turn,roboapply,false,1.25,0,3,0');
  });

  it('GET /costs rejects a range over the cap', async () => {
    expect((await harness.request('GET', '/admin/costs?from=2026-01-01&to=2026-10-09')).status).toBe(422);
  });

  it('lists reports with redacted notes, closes a job and audits it', async () => {
    const list = await harness.request<{ data: { items: Array<{ id: string; notes: string[]; reasons: unknown }>; keepHolds: boolean } }>('GET', '/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.data.keepHolds).toBe(KEEP_DECISION_HOLDS);
    expect(list.body.data.items[0]!.id).toBe('job1');
    expect(list.body.data.items[0]!.notes[0]).not.toContain('jane@example.com');

    const res = await harness.request<{ data: unknown }>('POST', '/admin/reports/job1/resolve', { body: { decision: 'close', note: 'Posting expired' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'job1', state: 'closed', decision: 'close' });
    expect(jobUpdates).toEqual([{ id: 'job1', data: { closedAt: new Date('2026-10-10T12:00:00Z'), closeReason: 'reported' } }]);
    expect(decisions).toEqual([{ jobId: 'job1', decision: 'close', at: new Date('2026-10-10T12:00:00Z'), by: 'admin1', note: 'Posting expired', clearedRules: [] }]);
    expect(audits[0]).toMatchObject({ adminId: 'admin1', subjectUserId: null, eventType: 'admin_report_resolved', payload: { jobId: 'job1', decision: 'close' } });
  });

  it('rejects an unknown decision and a missing job', async () => {
    expect((await harness.request('POST', '/admin/reports/job1/resolve', { body: { decision: 'flag_fraud' } })).status).toBe(422);
    expect((await harness.request('POST', '/admin/reports/nope/resolve', { body: { decision: 'close' } })).status).toBe(404);
  });

  it('creates and deletes overrides through the credits service, auditing on the person', async () => {
    const created = await harness.request<{ data: { id: string } }>('POST', '/admin/overrides', { body: { userId: 'u1', key: 'bucket:tailor', value: 3, reason: 'support' } });
    expect(created.status).toBe(201);
    expect(created.body.data.id).toBe('ov2');
    const del = await harness.request('DELETE', '/admin/overrides/ov1?userId=u1');
    expect(del.status).toBe(204);
    expect(overrideCalls).toEqual(['create:bucket:tailor', 'delete:ov1']);
    expect(audits.map((a) => [a.adminId, a.subjectUserId, a.eventType])).toEqual([
      ['admin1', 'u1', 'admin_override_created'],
      ['admin1', 'u1', 'admin_override_deleted'],
    ]);
    expect(audits[1]!.payload).toMatchObject({ key: 'bucket:tailor', overrideId: 'ov1' });
  });

  it('rejects an override without a reason', async () => {
    expect((await harness.request('POST', '/admin/overrides', { body: { userId: 'u1', key: 'bucket:tailor', value: 3 } })).status).toBe(422);
  });

  it('GET /copilot-feedback redacts the note and carries guard hits', async () => {
    const res = await harness.request<{ data: { items: Array<{ note: string; guardHits: number | null; excerpt: unknown[] }> } }>('GET', '/admin/copilot-feedback?value=down');
    expect(res.status).toBe(200);
    const item = res.body.data.items[0]!;
    expect(item.note).not.toContain('555');
    expect(item.guardHits).toBe(1);
    expect(item.excerpt).toEqual([{ role: 'assistant', text: 'Here are jobs.' }]);
  });

  it('moderates a referral code through the WP-54 service and audits it on the person who shared it', async () => {
    const res = await harness.request<{ data: unknown }>('POST', '/admin/referrals/rc1/moderate', { body: { decision: 'reject', reason: 'paid_or_traded' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'rc1', status: 'rejected' });
    expect(moderations).toEqual(['admin1:rc1:reject']);
    expect(audits).toEqual([
      expect.objectContaining({
        adminId: 'admin1',
        subjectUserId: 'u1',
        eventType: 'admin_referral_moderated',
        payload: { referralCodeId: 'rc1', decision: 'reject', reason: 'paid_or_traded', before: { status: 'pending' }, after: { status: 'rejected' } },
      }),
    ]);
  });

  it('GET /system/audit lists the admin actions newest first, filtered by action or person, with redacted details', async () => {
    await harness.request('POST', '/admin/system/queue/w_dead/retry');
    await harness.request('POST', '/admin/overrides', { body: { userId: 'u1', key: 'bucket:tailor', value: 3, reason: 'asked by jane@example.com' } });
    type Row = { adminId: string; subjectUserId: string | null; eventType: string; details: string; createdAt: string };
    const all = await harness.request<{ data: { items: Row[]; cursor: string | null } }>('GET', '/admin/system/audit');
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((i) => i.eventType)).toEqual(['admin_override_created', 'admin_work_item_retried']);
    expect(all.body.data.cursor).toBeNull();
    const created = all.body.data.items[0]!;
    expect(created).toMatchObject({ adminId: 'admin1', subjectUserId: 'u1' });
    expect(created.details).toContain('key: bucket:tailor');
    expect(created.details).not.toContain('jane@example.com');
    const byEvent = await harness.request<{ data: { items: Row[] } }>('GET', '/admin/system/audit?eventType=admin_work_item_retried');
    expect(byEvent.body.data.items.map((i) => i.subjectUserId)).toEqual([null]);
    const byPerson = await harness.request<{ data: { items: Row[] } }>('GET', '/admin/system/audit?subjectUserId=u1');
    expect(byPerson.body.data.items.map((i) => i.eventType)).toEqual(['admin_override_created']);
  });

  it('a rejection without a reason is a 422 and changes nothing', async () => {
    expect((await harness.request('POST', '/admin/referrals/rc1/moderate', { body: { decision: 'reject' } })).status).toBe(422);
    expect(moderations).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('GET /overrides passes the cursor through and has no key filter', async () => {
    const res = await harness.request<{ data: { items: unknown[]; cursor: string | null } }>('GET', '/admin/overrides?userId=u1');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect((await harness.request('GET', '/admin/overrides?key=bucket:tailor')).status).toBe(200);
  });

  it('GET /safety returns readiness without secrets', async () => {
    const res = await harness.request<{ data: { readiness: Record<string, unknown>; last7d: unknown } }>('GET', '/admin/safety');
    expect(res.status).toBe(200);
    // `degraded` (PAR gate, PAR-2 request): a setting that cannot run fell back to the keyword list.
    expect(Object.keys(res.body.data.readiness).sort()).toEqual(['cn1Ready', 'degraded', 'keywordList', 'problems', 'provider', 'timeoutMs', 'usable']);
    expect(res.body.data.readiness.degraded).toBe(false);
    expect(res.body.data.last7d).toEqual([{ verdict: 'block', count: 2 }]);
  });
});

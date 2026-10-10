// @vitest-environment node
//
// Admin console routes (WP-74): admin only (401 without a session, 403 for a
// non-admin, on every route), the real `requireAdmin` behind a fake session,
// in-memory stores (no database, no network).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => { throw new Error('tests must not reach Prisma'); } }),
}));

import { requireAdmin } from '../../../middleware/admin.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../../test/routeHarness.js';
import { createAdminConsoleRouter } from '../routes.js';
import type { AuditStore } from '../audit.js';
import type { QueueStore } from '../queue.js';
import type { ReportsStore, ReportJobRow, DecisionRow } from '../reports.js';
import type { OverridesService } from '../overrides.js';
import type { ReferralModeration } from '../moderation.js';
import { fakeSystemStore } from './fakes.js';

const ENV = { NODE_ENV: 'test', ALLOWED_BRANDS: 'roboapply,goapply' };

let harness: RouteHarness;
let who: HarnessUser | null = { id: 'admin1', role: 'admin' };
const audits: Array<{ profile: string; event: string; payload: Record<string, unknown> }> = [];
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

const audit: AuditStore = {
  profileIdFor: async (userId) => (userId === 'admin1' ? 'sp_admin' : userId === 'u1' ? 'sp_u1' : null),
  write: async (profile, event, payload) => {
    audits.push({ profile, event, payload });
  },
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
          system: fakeSystemStore(),
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

  it('GET /system?brand= narrows to one brand; an unknown brand is a 422', async () => {
    const one = await harness.request<{ data: { brands: Array<{ brand: string }> } }>('GET', '/admin/system?brand=goapply');
    expect(one.body.data.brands.map((b) => b.brand)).toEqual(['goapply']);
    expect((await harness.request('GET', '/admin/system?brand=robohire')).status).toBe(422);
  });

  it('retries a dead item and audits it; a done item is a 409, a missing one 404', async () => {
    const ok = await harness.request<{ data: unknown }>('POST', '/admin/system/queue/w_dead/retry');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: 'w_dead', status: 'queued' });
    expect(audits).toEqual([{ profile: 'sp_admin', event: 'admin_work_item_retried', payload: expect.objectContaining({ workItemId: 'w_dead', adminId: 'admin1' }) }]);
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
    const list = await harness.request<{ data: { items: Array<{ id: string; notes: string[]; reasons: unknown }> } }>('GET', '/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]!.id).toBe('job1');
    expect(list.body.data.items[0]!.notes[0]).not.toContain('jane@example.com');

    const res = await harness.request<{ data: unknown }>('POST', '/admin/reports/job1/resolve', { body: { decision: 'close', note: 'Posting expired' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'job1', state: 'closed', decision: 'close' });
    expect(jobUpdates).toEqual([{ id: 'job1', data: { closedAt: new Date('2026-10-10T12:00:00Z'), closeReason: 'reported' } }]);
    expect(decisions).toHaveLength(1);
    expect(audits[0]).toMatchObject({ profile: 'sp_admin', event: 'admin_report_resolved' });
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
    expect(audits.map((a) => [a.profile, a.event])).toEqual([
      ['sp_u1', 'admin_override_created'],
      ['sp_u1', 'admin_override_deleted'],
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
      {
        profile: 'sp_u1',
        event: 'admin_referral_moderated',
        payload: expect.objectContaining({ referralCodeId: 'rc1', decision: 'reject', reason: 'paid_or_traded', before: { status: 'pending' }, after: { status: 'rejected' }, adminId: 'admin1' }),
      },
    ]);
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
    expect(Object.keys(res.body.data.readiness).sort()).toEqual(['cn1Ready', 'keywordList', 'problems', 'provider', 'timeoutMs', 'usable']);
    expect(res.body.data.last7d).toEqual([{ verdict: 'block', count: 2 }]);
  });
});

// @vitest-environment node
//
// WP-78 logged-out alert sends: only confirmed subscriptions, only when due,
// real totals, never a zero-job email, purge of unconfirmed and departed
// addresses, capability off → nothing, budget respected, public job links on both brands.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { createBudget } from '../../platform/queue/index.js';
import type { SendEmailResult } from '../../platform/email/EmailService.js';
import { createAnonAlertDigestTask, digestJobHref, toDigestJob } from './digest.js';
import type { AlertJobRow, AnonAlertRow } from './repo.js';
import { createMemoryVisitorAlertsRepo } from './testkit.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const NOW = new Date('2026-10-10T08:00:00.000Z');
const H = 3_600_000;

function sub(over: Partial<AnonAlertRow>): AnonAlertRow {
  return {
    id: 's1',
    brand: 'roboapply',
    email: 'a@example.com',
    emailHash: 'h',
    locale: 'en',
    filters: { q: 'Data analyst' },
    cadence: 'daily',
    status: 'confirmed',
    confirmedAt: new Date(NOW.getTime() - 48 * H),
    unsubscribedAt: null,
    lastSentAt: null,
    createdAt: new Date(NOW.getTime() - 48 * H),
    ...over,
  };
}

function job(id: string, hoursAgo: number, over: Partial<AlertJobRow> = {}): AlertJobRow & { firstSeenAt: Date } {
  return {
    id,
    title: 'Data Analyst',
    companyName: 'Acme',
    location: 'Taipei',
    locationCity: 'Taipei',
    workModel: 'onsite',
    salaryDisclosed: false,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryText: null,
    firstSeenAt: new Date(NOW.getTime() - hoursAgo * H),
    ...over,
  };
}

function setup(opts: { enabled?: boolean; result?: SendEmailResult } = {}) {
  const repo = createMemoryVisitorAlertsRepo(() => NOW);
  const send = vi.fn(async (_input: { brand: ProductBrand; to: string; locale: string; params: unknown }) => opts.result ?? ({ status: 'sent' } as SendEmailResult));
  const task = createAnonAlertDigestTask({
    repo,
    alertsEnabled: async () => opts.enabled ?? true,
    send,
    origin: (b) => (b.id === 'goapply' ? 'https://www.goapply.top' : 'https://www.roboapply.io'),
  });
  const run = (brand: ProductBrand = ROBO, budgetMs = 240_000) => task({ name: 'job-alerts', brand, now: NOW, budget: createBudget(budgetMs) });
  return { repo, send, run };
}

describe('anon alert digest', () => {
  it('sends nothing when jobs.alerts is off for the brand, but still purges (retention does not depend on the switch)', async () => {
    const { repo, send, run } = setup({ enabled: false });
    repo.rows.push(
      sub({}),
      sub({ id: 'old-pending', status: 'pending', createdAt: new Date(NOW.getTime() - 73 * H) }),
      sub({ id: 'gone', status: 'unsubscribed', unsubscribedAt: new Date(NOW.getTime() - 31 * 24 * H) }),
    );
    expect(await run()).toEqual({ skipped: 'disabled', purged: { pending: 1, unsubscribed: 1 } });
    expect(send).not.toHaveBeenCalled();
    expect(repo.rows.map((r) => r.id)).toEqual(['s1']);
  });

  it('answers no_work quickly when nothing is due (pending, unsubscribed, not yet due)', async () => {
    const { repo, send, run } = setup();
    repo.rows.push(
      sub({ id: 'p', status: 'pending', createdAt: new Date(NOW.getTime() - H) }),
      sub({ id: 'u', status: 'unsubscribed', unsubscribedAt: new Date(NOW.getTime() - H) }),
      sub({ id: 'recent', lastSentAt: new Date(NOW.getTime() - 2 * H) }),
      sub({ id: 'weekly', cadence: 'weekly', lastSentAt: new Date(NOW.getTime() - 3 * 24 * H) }),
    );
    expect(await run()).toMatchObject({ skipped: 'no_work' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends confirmed, due alerts with the real total and up to 10 jobs since the last email', async () => {
    const { repo, send, run } = setup();
    repo.rows.push(sub({ lastSentAt: new Date(NOW.getTime() - 25 * H) }));
    for (let i = 0; i < 12; i += 1) repo.jobs.push(job(`j${i}`, i + 1));
    repo.jobs.push(job('old', 30));
    const res = await run();
    expect(res).toMatchObject({ processed: 1, sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0]![0].params as { total: number; jobs: Array<{ id: string; href: string }>; search: string; signupUrl: string };
    expect(params.total).toBe(12);
    expect(params.jobs).toHaveLength(10);
    expect(params.jobs[0]!.id).toBe('j0');
    expect(params.jobs[0]!.href).toBe('https://www.roboapply.io/job/j0-data-analyst-acme?from=alert');
    expect(params.search).toBe('Data analyst');
    expect(params.signupUrl).toBe('https://www.roboapply.io/signup?from=alert');
    expect(repo.newJobsCalls[0]).toMatchObject({ market: 'intl', since: new Date(NOW.getTime() - 25 * H), take: 10, filters: { q: 'Data analyst' } });
    expect(repo.rows[0]!.lastSentAt).toEqual(NOW);
  });

  it('never sends a zero-job email; the window moves on', async () => {
    const { repo, send, run } = setup();
    repo.rows.push(sub({}));
    expect(await run()).toMatchObject({ empty: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(repo.rows[0]!.lastSentAt).toEqual(NOW);
  });

  it('keeps the window when sending failed; stops the run when no transport is configured', async () => {
    const failed = setup({ result: { status: 'failed', reason: 'boom' } });
    failed.repo.rows.push(sub({}));
    failed.repo.jobs.push(job('j1', 1));
    expect(await failed.run()).toMatchObject({ failed: 1 });
    expect(failed.repo.rows[0]!.lastSentAt).toBeNull();

    const none = setup({ result: { status: 'suppressed', reason: 'transport_not_configured' } });
    none.repo.rows.push(sub({ id: 'a' }), sub({ id: 'b' }));
    none.repo.jobs.push(job('j1', 1));
    expect(await none.run()).toMatchObject({ skipped: 'transport_not_configured' });
    expect(none.send).toHaveBeenCalledTimes(1);
    expect(none.repo.rows.every((r) => r.lastSentAt === null)).toBe(true);
  });

  it('purges unconfirmed rows after 72 h and departed addresses after 30 days', async () => {
    const { repo, run } = setup();
    repo.rows.push(
      sub({ id: 'old-pending', status: 'pending', createdAt: new Date(NOW.getTime() - 73 * H) }),
      sub({ id: 'new-pending', status: 'pending', createdAt: new Date(NOW.getTime() - 2 * H) }),
      sub({ id: 'gone', status: 'unsubscribed', unsubscribedAt: new Date(NOW.getTime() - 31 * 24 * H) }),
      sub({ id: 'left-recently', status: 'unsubscribed', unsubscribedAt: new Date(NOW.getTime() - 24 * H) }),
    );
    const res = await run();
    expect(res.purged).toEqual({ pending: 1, unsubscribed: 1 });
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['left-recently', 'new-pending']);
  });

  it('stops starting sends when the budget runs low', async () => {
    const { repo, send, run } = setup();
    repo.rows.push(sub({ id: 'a' }), sub({ id: 'b' }));
    repo.jobs.push(job('j1', 1));
    await run(ROBO, 1_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('both brands link the public job page, each on its own origin', () => {
    // A CJK title has no ASCII slug: the path is the id alone.
    expect(digestJobHref({ id: 'j1', title: '数据分析师', companyName: '某公司' }, GO, 'https://www.goapply.top')).toBe('https://www.goapply.top/job/j1?from=alert');
    expect(digestJobHref({ id: 'j2', title: 'Data Analyst', companyName: 'Bosch' }, GO, 'https://www.goapply.top')).toBe('https://www.goapply.top/job/j2-data-analyst-bosch?from=alert');
    expect(digestJobHref({ id: 'j2', title: 'Data Analyst', companyName: 'Bosch' }, ROBO, 'https://www.roboapply.io')).toBe('https://www.roboapply.io/job/j2-data-analyst-bosch?from=alert');
  });

  it('a GoApply digest is sent with public job links and the GoApply signup link', async () => {
    const { repo, send, run } = setup();
    repo.rows.push(sub({ id: 'cn1', brand: 'goapply', email: 'reader@example.cn', locale: 'zh', filters: {} }));
    repo.jobs.push(job('cnjob', 1, { title: '数据分析师', companyName: '示例科技' }));
    const res = await run(GO);
    expect(res).toMatchObject({ sent: 1 });
    const params = send.mock.calls[0]![0].params as { jobs: Array<{ href: string }>; signupUrl: string };
    expect(params.jobs[0]!.href).toBe('https://www.goapply.top/job/cnjob?from=alert');
    expect(params.signupUrl).toBe('https://www.goapply.top/signup?from=alert');
    expect(JSON.stringify(params)).not.toContain('next=%2Fjobs');
  });

  it('shows pay only as the posting lists it', () => {
    expect(toDigestJob(job('j', 1), ROBO, 'o').pay).toBeNull();
    expect(toDigestJob(job('j', 1, { salaryDisclosed: true, salaryMin: 1, salaryMax: 2, salaryCurrency: 'USD', salaryPeriod: 'year' }), ROBO, 'o').pay).toEqual({
      min: 1,
      max: 2,
      currency: 'USD',
      period: 'year',
      text: null,
    });
    expect(toDigestJob(job('j', 1, { salaryText: '15-25K·13薪' }), ROBO, 'o').pay?.text).toBe('15-25K·13薪');
    expect(toDigestJob(job('j', 1, { workModel: 'remote' }), ROBO, 'o').remote).toBe(true);
  });
});

// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
import { JobSearchQuota } from './quota.js';
import { getBrand } from '../platform/brand/registry.js';

afterEach(() => vi.unstubAllEnvs());
function store(counts: number[]) {
  const order: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => { order.push('lock'); }),
    apiUsageRecord: {
      count: vi.fn(async () => { order.push('count'); return counts.shift() ?? 0; }),
      create: vi.fn(async () => { order.push('reserve'); return { id: 'reservation' }; }),
      update: vi.fn(async () => ({})),
    },
    apiKey: { update: vi.fn(async () => ({})) },
  };
  return { tx, order, quota: new JobSearchQuota({ ...tx, $transaction: (fn: any) => fn(tx) } as never) };
}
describe('durable shared search quota', () => {
  it('locks before checking limits and reserves before returning to paid work', async () => {
    const { quota, tx, order } = store([0, 0, 0]);
    await expect(quota.reserve('user', 'key', 'request')).resolves.toBe('reservation');
    expect(order).toEqual(['lock', 'count', 'count', 'count', 'reserve']);
    expect(tx.apiUsageRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user', apiKeyId: 'key', statusCode: 102 }) }));
  });
  it.each([[100, 0, 0], [0, 10, 0], [0, 0, 250]])('rejects a reached owner/day, minute, or deployment cap (%s,%s,%s)', async (...counts) => {
    const { quota, tx } = store(counts);
    await expect(quota.reserve('user')).rejects.toMatchObject({ status: 429, retryAfter: expect.any(Number) });
    expect(tx.apiUsageRecord.create).not.toHaveBeenCalled();
  });
  it('fails closed when durable reservation storage is unavailable', async () => {
    const { quota, tx } = store([0, 0, 0]);
    tx.$queryRaw.mockRejectedValueOnce(new Error('offline'));
    await expect(quota.reserve('user')).rejects.toThrow('offline');
    expect(tx.apiUsageRecord.create).not.toHaveBeenCalled();
  });
  it.each(['JOB_SEARCH_USER_PER_MINUTE', 'JOB_SEARCH_USER_DAILY_LIMIT', 'JOB_SEARCH_GLOBAL_DAILY_LIMIT'])('honors an explicit zero %s budget', async (name) => {
    vi.stubEnv(name, '0');
    const { quota, tx } = store([0, 0, 0]);
    await expect(quota.reserve('user')).rejects.toMatchObject({ status: 429 });
    expect(tx.apiUsageRecord.create).not.toHaveBeenCalled();
  });
  it('records the actual response and retains usage for failed requests', async () => {
    const { quota, tx } = store([0, 0, 0]);
    await quota.finish('reservation', 503, 800, 'key');
    expect(tx.apiUsageRecord.update).toHaveBeenCalledWith({ where: { id: 'reservation' }, data: { statusCode: 503, durationMs: 800 } });
    expect(tx.apiKey.update).toHaveBeenCalled();
  });
});

describe('one deployment budget per brand (a shared database serves both)', () => {
  const GO = getBrand('goapply');
  const RA = getBrand('roboapply');
  type Row = { userId: string; brand: string };
  /** An in-memory usage table that answers the three counts by their `where`, as Prisma would. */
  function ledger(rows: Row[]) {
    const matches = (row: Row, where: { userId?: string; user?: { brand: string | { notIn: string[] } } }) => {
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      const brand = where.user?.brand;
      if (typeof brand === 'string') return row.brand === brand;
      if (brand) return !brand.notIn.includes(row.brand);
      return true;
    };
    const wheres: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => undefined),
      apiUsageRecord: {
        count: vi.fn(async ({ where }: { where: never }) => { wheres.push(where); return rows.filter((row) => matches(row, where)).length; }),
        create: vi.fn(async () => ({ id: 'reservation' })),
      },
    };
    return { tx, wheres, quota: new JobSearchQuota({ ...tx, $transaction: (fn: any) => fn(tx) } as never) };
  }
  const many = (count: number, brand: string) => Array.from({ length: count }, (_, i) => ({ userId: `${brand}-${i}`, brand }));

  it('250 GoApply reservations do not rate-limit a RoboApply user, and the reverse', async () => {
    const goapplyBusy = ledger(many(250, 'goapply'));
    await expect(goapplyBusy.quota.reserve('ra-user', undefined, 'request', RA)).resolves.toBe('reservation');
    await expect(goapplyBusy.quota.reserve('go-user', undefined, 'request', GO)).rejects.toMatchObject({ status: 429 });
    const roboapplyBusy = ledger(many(250, 'roboapply'));
    await expect(roboapplyBusy.quota.reserve('go-user', undefined, 'request', GO)).resolves.toBe('reservation');
    await expect(roboapplyBusy.quota.reserve('ra-user', undefined, 'request', RA)).rejects.toMatchObject({ status: 429 });
  });

  it('counts the deployment budget over the accounts of the brand only; the per-user counts are unchanged', async () => {
    const go = ledger([]);
    await go.quota.reserve('go-user', undefined, 'request', GO);
    expect(go.wheres[0]).toEqual({ endpoint: '/api/v1/job-search/search', userId: 'go-user', createdAt: { gte: expect.any(Date) } });
    expect(go.wheres[2]).toEqual({ endpoint: '/api/v1/job-search/search', createdAt: { gte: expect.any(Date) }, user: { brand: 'goapply' } });
    const ra = ledger([]);
    await ra.quota.reserve('ra-user', undefined, 'request', RA);
    // RoboApply's budget: every account that is not another brand's (an unknown stored brand is a RoboApply account).
    expect(ra.wheres[2]).toMatchObject({ user: { brand: { notIn: ['goapply'] } } });
  });

  it('an account with an unknown stored brand spends the RoboApply budget, never the GoApply one', async () => {
    const legacy = ledger(many(250, 'legacy'));
    await expect(legacy.quota.reserve('ra-user', undefined, 'request', RA)).rejects.toMatchObject({ status: 429 });
    await expect(legacy.quota.reserve('go-user', undefined, 'request', GO)).resolves.toBe('reservation');
  });

  it('GoApply reads its own limit when one is set and the shared one otherwise; RoboApply never reads the GoApply value', async () => {
    vi.stubEnv('JOB_SEARCH_GLOBAL_DAILY_LIMIT', '10');
    const shared = ledger(many(10, 'goapply'));
    await expect(shared.quota.reserve('go-user', undefined, 'request', GO)).rejects.toMatchObject({ status: 429 });
    vi.stubEnv('CN_JOB_SEARCH_GLOBAL_DAILY_LIMIT', '1000');
    const own = ledger(many(10, 'goapply'));
    await expect(own.quota.reserve('go-user', undefined, 'request', GO)).resolves.toBe('reservation');
    const roboapply = ledger(many(10, 'roboapply'));
    await expect(roboapply.quota.reserve('ra-user', undefined, 'request', RA)).rejects.toMatchObject({ status: 429 });
  });

  it('with no brand given the reservation is for the brand of the current request (RoboApply outside one)', async () => {
    const { quota, wheres } = ledger([]);
    await quota.reserve('user');
    expect(wheres[2]).toMatchObject({ user: { brand: { notIn: ['goapply'] } } });
  });
});

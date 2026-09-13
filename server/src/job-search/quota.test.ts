// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
import { JobSearchQuota } from './quota.js';

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

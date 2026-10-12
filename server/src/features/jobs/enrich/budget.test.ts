// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import type { RateLimitDb } from '../../../platform/ratelimit/index.js';
import { DEFAULT_ENRICH_DAILY_JOBS, createEnrichBudget, enrichBudgetKey, enrichDailyLimit } from './budget.js';

/** A counter store that behaves like the limiter's INSERT … ON CONFLICT … RETURNING. */
function counterDb() {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = `${String(values[0])}@${(values[1] as Date).toISOString()}`;
      const next = (counts.get(key) ?? 0) + Number(values[2]);
      counts.set(key, next);
      keys.push(String(values[0]));
      return [{ count: next }];
    },
    rARateCounter: {},
  } as unknown as RateLimitDb;
  return { db, keys };
}

describe('enrichment budget', () => {
  it('reads ENRICH_DAILY_JOBS with an 8,000 default', () => {
    expect(enrichDailyLimit({})).toBe(DEFAULT_ENRICH_DAILY_JOBS);
    expect(enrichDailyLimit({ ENRICH_DAILY_JOBS: '250' })).toBe(250);
    expect(enrichDailyLimit({ ENRICH_DAILY_JOBS: '0' })).toBe(0);
    expect(enrichDailyLimit({ ENRICH_DAILY_JOBS: 'lots' })).toBe(DEFAULT_ENRICH_DAILY_JOBS);
    expect(enrichDailyLimit({ ENRICH_DAILY_JOBS: '-3' })).toBe(DEFAULT_ENRICH_DAILY_JOBS);
  });

  it('allows the limit per market per UTC day, then refuses until the window resets', async () => {
    const { db, keys } = counterDb();
    const budget = createEnrichBudget({ db, env: { ENRICH_DAILY_JOBS: '2' } });
    const now = new Date('2026-10-10T18:00:00.000Z');
    expect((await budget('intl', now)).allowed).toBe(true);
    expect((await budget('intl', now)).allowed).toBe(true);
    const third = await budget('intl', now);
    expect(third).toEqual({ allowed: false, retryAfterSec: 6 * 3600, limit: 2 });
    // The other market has its own allowance.
    expect((await budget('cn', now)).allowed).toBe(true);
    // A new day starts a new window.
    expect((await budget('intl', new Date('2026-10-11T00:00:01.000Z'))).allowed).toBe(true);
    expect(keys[0]).toBe(`${enrichBudgetKey('intl')}:86400`);
    expect(keys).toContain(`${enrichBudgetKey('cn')}:86400`);
  });

  it('a zero budget disables model calls without touching the counter', async () => {
    const { db, keys } = counterDb();
    const result = await createEnrichBudget({ db, env: { ENRICH_DAILY_JOBS: '0' } })('intl', new Date('2026-10-10T23:00:00.000Z'));
    expect(result).toEqual({ allowed: false, retryAfterSec: 3600, limit: 0 });
    expect(keys).toEqual([]);
  });
});

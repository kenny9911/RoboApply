// @vitest-environment node
//
// Users list ordering (admin console → Users): every column sorts both ways,
// empty values stay last, and only the fixed expressions reach ORDER BY.
import { describe, expect, it, vi } from 'vitest';

const raw = vi.hoisted(() => vi.fn(async (_sql: string, ..._params: unknown[]) => [] as unknown[]));
vi.mock('../../../lib/prisma.js', () => ({ default: { $queryRawUnsafe: raw } }));
vi.mock('../../../platform/billing/stripeClient.js', () => ({ getStripe: () => null }));

const { OPERATIONS_USER_SORTS, getOperationsUsers, isOperationsUserSort, operationsUserOrder } = await import('./RAAdminOperationsService.js');

const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z'), tz: 'UTC' };

describe('operationsUserOrder', () => {
  it('defaults to the most recently active first', () => {
    expect(operationsUserOrder(undefined, undefined)).toBe(`GREATEST(e.last, l.last) DESC NULLS LAST, u."createdAt" DESC, u.id`);
  });

  it.each(Object.keys(OPERATIONS_USER_SORTS))('sorts by %s in both directions, empty values last', (key) => {
    const expr = OPERATIONS_USER_SORTS[key as keyof typeof OPERATIONS_USER_SORTS];
    expect(operationsUserOrder(key, 'asc')).toBe(`${expr} ASC NULLS LAST, u."createdAt" DESC, u.id`);
    expect(operationsUserOrder(key, 'desc')).toBe(`${expr} DESC NULLS LAST, u."createdAt" DESC, u.id`);
  });

  it('sorts a chosen column ascending when no direction is given', () => {
    expect(operationsUserOrder('email', undefined)).toMatch(/^LOWER\(u\."email"\) ASC/);
  });

  it('never puts request text into ORDER BY', () => {
    for (const evil of ['1; DROP TABLE "User"', 'email; --', 'constructor', '__proto__', 'toString']) {
      expect(isOperationsUserSort(evil)).toBe(false);
      expect(operationsUserOrder(evil, 'asc')).toBe(operationsUserOrder(undefined, 'asc'));
    }
  });

  it('orders onboarding by progress through the stages, done last', () => {
    expect(OPERATIONS_USER_SORTS.onboarding).toContain(`WHEN u."onboardingStep" = 'account' THEN 10`);
    expect(OPERATIONS_USER_SORTS.onboarding).toContain(`WHEN u."onboardingStep" = 'resume' THEN 60`);
    expect(OPERATIONS_USER_SORTS.onboarding).toMatch(/ELSE 100 END$/);
  });
});

describe('getOperationsUsers', () => {
  it('filters by brand, passes the search as a parameter and maps the new columns', async () => {
    raw.mockReset();
    raw.mockResolvedValueOnce([{ total: 1 }]);
    raw.mockResolvedValueOnce([{
      id: 'u1', email: 'jane@example.test', name: 'Jane', role: 'seeker', roles: ['seeker'], isActive: true, createdAt: new Date('2026-10-02T00:00:00Z'),
      brand: 'roboapply', region: 'us', tier: 'free', status: 'active', currency: null, amountMinor: null,
      seekerProfileId: 'sp1', onboardingStep: 'resume', deletedAt: null, logins: 2, features: 3, units: 0, cost: 0,
      lastLoginAt: null, lastActiveAt: null, resumes: 0,
    }]);
    const out = await getOperationsUsers({ range, brand: 'roboapply', q: "o'brien", sort: 'resumes', dir: 'asc', page: 1, pageSize: 25 });
    const [countSql, ...countParams] = raw.mock.calls[0]!;
    expect(countSql).toContain('u."brand" = $3');
    expect(countParams).toEqual([range.from, range.to, 'roboapply', "o'brien"]);
    const pageSql = raw.mock.calls[1]![0];
    expect(pageSql).toContain('ORDER BY COALESCE(r.n, 0) ASC NULLS LAST');
    expect(pageSql).toContain('"RAResumeVariant"');
    expect(out.rows[0]).toMatchObject({ userId: 'u1', brand: 'roboapply', onboardingStep: 'resume', resumes: 0, hasProfile: true, deleted: false, isAdmin: false });
  });

  it('reads an account without a profile as having no onboarding', async () => {
    raw.mockReset();
    raw.mockResolvedValueOnce([{ total: 1 }]);
    raw.mockResolvedValueOnce([{ id: 'a1', email: 'a@example.test', role: 'admin', roles: ['admin'], seekerProfileId: null, onboardingStep: null, resumes: 0 }]);
    const out = await getOperationsUsers({ range, page: 1, pageSize: 25 });
    expect(out.rows[0]).toMatchObject({ onboardingStep: null, hasProfile: false, isAdmin: true });
  });
});

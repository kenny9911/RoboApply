// @vitest-environment node
//
// WP-78 storage adapters over a fake Prisma: alert filters → RAJob where,
// the public-page predicate (ARCH §9.4) on every job an alert or the visitor
// list shows, token rows hold only a hash, due/purge queries.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { prismaStillPublic } from '../feed/publicRoutes.js';
import { createPrismaVisitorAlertsRepo, filtersWhere, prismaPublicJobIds } from './repo.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');

function fakeDb() {
  return {
    rAAnonAlertSubscription: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 's1', ...data })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 2 })),
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    rAAuthToken: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    rAJob: {
      findMany: vi.fn(async () => [{ id: 'a' }]),
      count: vi.fn(async () => 7),
    },
  };
}

describe('filtersWhere', () => {
  it('maps each filter; none → no condition', () => {
    expect(filtersWhere({})).toEqual([]);
    const w = filtersWhere({ q: 'Data', taxonomyIds: ['data_analyst'], locations: [{ label: 'Taipei', country: 'tw' }], workModels: ['remote'] });
    expect(w).toEqual([
      { OR: [{ title: { contains: 'Data', mode: 'insensitive' } }, { titleNormalized: { contains: 'data' } }] },
      { taxonomyIds: { hasSome: ['data_analyst'] } },
      { OR: [{ locationCity: { equals: 'Taipei', mode: 'insensitive' }, locationCountry: 'TW' }] },
      { workModel: { in: ['remote'] } },
    ]);
    expect(filtersWhere({ country: 'US' })).toEqual([{ OR: [{ locationCountry: 'US' }, { workModel: 'remote', remoteScope: { in: ['US', 'global'] } }] }]);
  });
});

describe('createPrismaVisitorAlertsRepo', () => {
  it('newJobs applies the public-page predicate, the window and the filters', async () => {
    const db = fakeDb();
    const repo = createPrismaVisitorAlertsRepo(db as never);
    const since = new Date(NOW.getTime() - 86_400_000);
    expect(await repo.newJobs({ market: 'intl', filters: { q: 'Nurse' }, since, now: NOW, take: 10 })).toEqual({ rows: [{ id: 'a' }], total: 7 });
    const args = (db.rAJob.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number; orderBy: unknown }])[0];
    expect(args.where).toMatchObject({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, publicDisplay: true });
    expect(args.where.AND).toEqual(expect.arrayContaining([{ firstSeenAt: { gt: since } }, filtersWhere({ q: 'Nurse' })[0]]));
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ firstSeenAt: 'desc' });
  });

  it('tokens store only the hash, kind anon_alert_confirm, no user', async () => {
    const db = fakeDb();
    const repo = createPrismaVisitorAlertsRepo(db as never);
    await repo.createToken({ brand: 'roboapply', tokenHash: 'h', subscriptionId: 's1', expiresAt: NOW });
    expect(db.rAAuthToken.create).toHaveBeenCalledWith({ data: { brand: 'roboapply', kind: 'anon_alert_confirm', tokenHash: 'h', payload: { subscriptionId: 's1' }, expiresAt: NOW } });
  });

  it('due reads confirmed rows per cadence; purge deletes stale pending and departed rows; unsubscribe counts', async () => {
    const db = fakeDb();
    const repo = createPrismaVisitorAlertsRepo(db as never);
    await repo.due('roboapply', { daily: NOW, weekly: NOW }, 50);
    const dueArgs = (db.rAAnonAlertSubscription.findMany.mock.calls[0] as unknown as [{ where: { status: string }; take: number }])[0];
    expect(dueArgs.where.status).toBe('confirmed');
    expect(dueArgs.take).toBe(50);
    expect(await repo.purge('roboapply', { pendingBefore: NOW, unsubscribedBefore: NOW })).toEqual({ pending: 1, unsubscribed: 1 });
    expect(await repo.unsubscribeByEmailHash('roboapply', 'h', NOW)).toBe(2);
    expect(db.rAAnonAlertSubscription.updateMany).toHaveBeenCalledWith({
      where: { brand: 'roboapply', emailHash: 'h', status: { in: ['pending', 'confirmed'] } },
      data: { status: 'unsubscribed', unsubscribedAt: NOW },
    });
  });
});

describe.each([
  ['prismaStillPublic (visitor list re-check)', prismaStillPublic],
  ['prismaPublicJobIds (assistant job cards re-check)', prismaPublicJobIds],
] as const)('%s', (_name, make) => {
  it('asks only for the given ids under the public-page predicate', async () => {
    const db = fakeDb();
    const check = make(db as never);
    expect(await check([], getBrand('roboapply'), NOW)).toEqual(new Set());
    expect(db.rAJob.findMany).not.toHaveBeenCalled();
    expect(await check(['a', 'b'], getBrand('roboapply'), NOW)).toEqual(new Set(['a']));
    const args = (db.rAJob.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(args.where).toMatchObject({ id: { in: ['a', 'b'] }, publicDisplay: true, market: 'intl' });
  });
});

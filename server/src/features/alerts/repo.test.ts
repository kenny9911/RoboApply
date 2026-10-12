// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../lib/prisma.js', () => ({
  get default() {
    return h.db;
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { defaultDeliverDeps } from './deliver.js';
import { createPrismaAlertsRepo } from './repo.js';

let fake: ReturnType<typeof createFakePrisma>;
beforeEach(() => {
  fake = createFakePrisma({
    seed: {
      rASearchProfile: [{ id: 'sp1', userId: 'u1', name: 'Search', alertInstantMax: 1, alertDigest: 'daily', alertLastInstantAt: null, alertLastDigestAt: null }],
      rATrackerEntry: [
        { id: 't1', userId: 'u1', status: 'applied', deletedAt: null, dateApplied: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-20T00:00:00Z') },
        { id: 't2', userId: 'u1', status: 'applied', deletedAt: null, dateApplied: new Date('2026-10-08T00:00:00Z'), updatedAt: new Date('2026-10-08T00:00:00Z') },
        { id: 't3', userId: 'u1', status: 'interviewing', deletedAt: null, dateApplied: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z') },
      ],
    },
    timestampFields: ['sentAt', 'createdAt'],
  });
  h.db = fake;
});

describe('Prisma alerts repo (claims and counts)', () => {
  it('claims an instant alert once: a second run with the old value loses', async () => {
    const repo = createPrismaAlertsRepo();
    const now = new Date('2026-10-10T12:00:00Z');
    expect(await repo.claimInstant('sp1', null, now)).toBe(true);
    expect(await repo.claimInstant('sp1', null, now)).toBe(false);
    expect(await repo.claimDigest('sp1', null, now)).toBe(true);
    expect(await repo.claimDigest('sp1', null, now)).toBe(false);
  });

  it('gives a claim back only while it still holds the claimed value', async () => {
    const repo = createPrismaAlertsRepo();
    const prev = new Date('2026-10-10T06:00:00Z');
    const now = new Date('2026-10-10T12:00:00Z');
    await fake.rASearchProfile.update({ where: { id: 'sp1' }, data: { alertLastInstantAt: prev, alertLastDigestAt: prev } });
    expect(await repo.claimInstant('sp1', prev, now)).toBe(true);
    await repo.releaseInstant('sp1', now, prev);
    expect((await fake.rASearchProfile.findUnique({ where: { id: 'sp1' } }))!.alertLastInstantAt).toEqual(prev);
    // another run claimed meanwhile: the release does nothing
    const later = new Date('2026-10-10T15:00:00Z');
    expect(await repo.claimDigest('sp1', prev, later)).toBe(true);
    await repo.releaseDigest('sp1', now, prev);
    expect((await fake.rASearchProfile.findUnique({ where: { id: 'sp1' } }))!.alertLastDigestAt).toEqual(later);
  });

  it('records deliveries and counts the instant ones since local midnight', async () => {
    const repo = createPrismaAlertsRepo();
    await repo.createDelivery({ userId: 'u1', searchProfileId: 'sp1', kind: 'instant', jobIds: ['a', 'b'] });
    await repo.createDelivery({ userId: 'u1', searchProfileId: 'sp1', kind: 'digest_daily', jobIds: ['c'] });
    const counts = await repo.instantCountsSince('u1', new Date(Date.now() - 60_000));
    expect(counts.total).toBe(1);
    expect(counts.byProfile.get('sp1')).toBe(1);
  });

  it('counts applications with no reply for 10 days (real count)', async () => {
    const repo = createPrismaAlertsRepo();
    expect(await repo.noReplyCount('u1', new Date('2026-10-10T12:00:00Z'))).toBe(1);
  });
});

describe('in-app mirror row', () => {
  it('writes a SeekerNotification with category, templateKey, params and deep link', async () => {
    const deps = defaultDeliverDeps(() => []);
    const row = await deps.createInApp({
      seekerProfileId: 'sp-u1',
      userId: 'u1',
      brand: 'roboapply',
      type: 'notify.job_alert_instant',
      category: 'alert',
      templateKey: 'notify.job_alert_instant',
      params: { search: 'S', jobs: [] },
      title: '2 new jobs',
      body: null,
      deepLink: '/jobs?from=alert',
      relatedEntityType: 'alert_delivery',
      relatedEntityId: 'd1',
    });
    const stored = await fake.seekerNotification.findUnique({ where: { id: row.id } });
    expect(stored).toMatchObject({ userId: 'u1', category: 'alert', templateKey: 'notify.job_alert_instant', deepLink: '/jobs?from=alert', title: '2 new jobs' });
    await deps.markEmailed(row.id, new Date('2026-10-10T12:00:00Z'));
    expect((await fake.seekerNotification.findUnique({ where: { id: row.id } }))!.emailSentAt).toEqual(new Date('2026-10-10T12:00:00Z'));
  });
});

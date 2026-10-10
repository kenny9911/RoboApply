// @vitest-environment node
//
// WP-32: the Prisma feed repo keeps the refill keyset id (windowEndsId) in the
// RAFeedSession.ranks JSON until SR-32-4 adds a column. Fake delegates only:
// no database.

import { describe, expect, it } from 'vitest';
import { FeedSessionRanksSchema } from './contract.js';
import { createPrismaFeedRepo, packRanks, unpackRanks } from './repo.js';

const entries = [{ jobId: 'j1', fit: 70, kind: 'pre' as const, rank: 61.2 }];

describe('ranks envelope', () => {
  it('packs entries with the boundary id and reads both the envelope and the older bare array', () => {
    expect(packRanks(entries, 'j400')).toEqual({ entries, windowEndsId: 'j400' });
    expect(unpackRanks({ entries, windowEndsId: 'j400' })).toEqual({ ranks: entries, windowEndsId: 'j400' });
    expect(unpackRanks(entries)).toEqual({ ranks: entries, windowEndsId: null });
    expect(unpackRanks(null)).toEqual({ ranks: [], windowEndsId: null });
    expect(FeedSessionRanksSchema.safeParse(packRanks(entries, null)).success).toBe(true);
    expect(FeedSessionRanksSchema.safeParse(entries).success).toBe(true);
  });

  it('createSession / getSession / updateSession round-trip windowEndsId through the ranks column', async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const db = {
      rAFeedSession: {
        async create({ data }: { data: Record<string, unknown> }) {
          expect(data).not.toHaveProperty('windowEndsId');
          const row = { ...data, id: 's1', createdAt: new Date('2026-10-10T12:00:00Z') };
          stored.set('s1', row);
          return row;
        },
        async findFirst({ where }: { where: { id: string } }) {
          return stored.get(where.id) ?? null;
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
          expect(data).not.toHaveProperty('windowEndsId');
          stored.set(where.id, { ...stored.get(where.id), ...data });
        },
      },
    };
    const repo = createPrismaFeedRepo(async () => db as never);
    const created = await repo.createSession({
      userId: 'u1',
      searchProfileId: 'sp1',
      profileVersion: 1,
      sort: 'newest',
      queryHash: 'h',
      jobIds: ['j1'],
      ranks: entries,
      totalEstimate: 400,
      windowEndsAt: new Date('2026-10-01T00:00:00Z'),
      windowEndsId: 'j400',
      expiresAt: new Date('2026-10-10T12:30:00Z'),
    });
    expect(created).toMatchObject({ ranks: entries, windowEndsId: 'j400' });
    expect(stored.get('s1')!.ranks).toEqual({ entries, windowEndsId: 'j400' });
    await repo.updateSession('s1', { jobIds: ['j1', 'j2'], ranks: entries, windowEndsAt: new Date('2026-09-01T00:00:00Z'), windowEndsId: null });
    expect(await repo.getSession('s1', 'u1')).toMatchObject({ jobIds: ['j1', 'j2'], ranks: entries, windowEndsId: null });
  });

  it.todo('SR-32-4: RAFeedSession.windowEndsId String? column: move the boundary id out of ranks and read either');
});

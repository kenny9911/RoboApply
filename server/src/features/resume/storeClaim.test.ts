// @vitest-environment node
//
// WP-22: the Prisma store's grant claim (the cross-instance guard behind the
// onboarding free check) takes a transaction-scoped advisory lock on
// (user, reason) before it reads RACreditGrant, inside one transaction, and
// the completion write of a check is conditional on the row still running.
// Prisma is mocked; nothing touches a database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${strings.join('?')}:${values.join(',')}`);
      return 1;
    }),
    rACreditGrant: {
      findFirst: vi.fn(async (_args: unknown) => {
        calls.push('find');
        return null as { id: string } | null;
      }),
    },
  };
  return {
    calls,
    tx,
    client: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, _opts?: unknown) => {
        calls.push('begin');
        const out = await fn(tx);
        calls.push('commit');
        return out;
      }),
      rAResumeGrade: {
        updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
        findUnique: vi.fn(async (_args: unknown) => ({ id: 'g1', status: 'done' })),
      },
    },
  };
});
vi.mock('../../lib/prisma.js', () => ({ default: db.client }));

import { createPrismaResumeCheckStore, grantClaimKey } from './store.js';

beforeEach(() => {
  db.calls.length = 0;
  vi.clearAllMocks();
});

describe('createPrismaResumeCheckStore().withGrantClaim', () => {
  it('locks (user, reason), then reads the grant, then runs fn — all in one transaction', async () => {
    const store = createPrismaResumeCheckStore();
    const value = await store.withGrantClaim('u1', 'onboarding_check', async (already) => {
      db.calls.push(`fn:${already}`);
      return { created: true, value: 'granted' };
    });
    expect(value).toBe('granted');
    expect(db.calls).toEqual([
      'begin',
      `lock:SELECT pg_advisory_xact_lock(hashtext(?)):${grantClaimKey('u1', 'onboarding_check')}`,
      'find',
      'fn:false',
      'commit',
    ]);
    expect(db.tx.rACreditGrant.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', reason: 'onboarding_check' }, select: { id: true } });
  });

  it('passes alreadyGranted=true when a grant with that reason exists', async () => {
    db.tx.rACreditGrant.findFirst.mockResolvedValueOnce({ id: 'gr_1' });
    const store = createPrismaResumeCheckStore();
    const seen: boolean[] = [];
    await store.withGrantClaim('u1', 'onboarding_check', async (already) => {
      seen.push(already);
      return { created: false, value: null };
    });
    expect(seen).toEqual([true]);
  });
});

describe('createPrismaResumeCheckStore().completeRunningGrade', () => {
  it('only updates a running row and returns null when a cancel won', async () => {
    const store = createPrismaResumeCheckStore();
    expect(await store.completeRunningGrade('g1', { status: 'done' })).toMatchObject({ id: 'g1' });
    expect(db.client.rAResumeGrade.updateMany).toHaveBeenCalledWith({ where: { id: 'g1', status: 'running' }, data: { status: 'done' } });
    db.client.rAResumeGrade.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.completeRunningGrade('g1', { status: 'done' })).toBeNull();
  });
});

// @vitest-environment node
//
// WP-73 Prisma adapter against a small fake of the three delegates it uses
// (no database): identity lookups by the 公众号 appid, single-use grant rows
// in RAAuthToken (written only inside a SERIALIZABLE transaction), pairing of
// the page's and WeChat's report of one acceptance, and the pushSentAt stamp.

import { describe, expect, it, vi } from 'vitest';
import { createPrismaNotifyCnRepo, GRANT_TTL_DAYS, MAX_LIVE_GRANTS, PAIR_WINDOW_MS, type NotifyCnDb } from './repo.js';

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const val = row[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as { gt?: Date; gte?: Date };
      if (op.gt) return val instanceof Date && val.getTime() > op.gt.getTime();
      if (op.gte) return val instanceof Date && val.getTime() >= op.gte.getTime();
      return true;
    }
    return val === v;
  });
}

function fakeDb(clock: () => Date = () => new Date(0)) {
  const tokens: Row[] = [];
  /** Grant rows may only be written inside a transaction (the cap and pairing must be atomic). */
  let inTx = false;
  const txOptions: unknown[] = [];
  const identities: Row[] = [
    { id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_mp', subject: 'openid_1', lastUsedAt: null },
    { id: 'i2', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid_web', lastUsedAt: null },
  ];
  const notifications: Row[] = [{ id: 'n1', pushSentAt: null }];
  let seq = 0;
  const db = {
    rAAuthIdentity: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => identities.find((r) => matches(r, where)) ?? null,
    },
    rAAuthToken: {
      count: async ({ where }: { where: Record<string, unknown> }) => tokens.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (!inTx) throw new Error('grant written outside a transaction');
        seq += 1;
        const row = { id: `t${seq}`, consumedAt: null, createdAt: new Date(clock().getTime() + seq), ...data } as Row;
        tokens.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!inTx) throw new Error('grant written outside a transaction');
        const row = tokens.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { id: row.id };
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        tokens
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
          .slice(0, take ?? Infinity),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = tokens.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    seekerNotification: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = notifications.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
  };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => {
    txOptions.push(opts);
    inTx = true;
    try {
      return await fn(db);
    } finally {
      inTx = false;
    }
  });
  Object.assign(db, { $transaction });
  return { db: db as unknown as NotifyCnDb, tokens, notifications, txOptions, $transaction };
}

const NOW = new Date('2026-10-10T00:00:00Z');

describe('createPrismaNotifyCnRepo', () => {
  it('finds the openid under the 公众号 appid only, and the user back from it', async () => {
    const f = fakeDb();
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    expect(await repo.mpOpenId('u1', 'goapply', 'wx_mp')).toBe('openid_1');
    expect(await repo.mpOpenId('u1', 'goapply', 'wx_mini')).toBeNull();
    expect(await repo.userForOpenId('openid_1', 'goapply', 'wx_mp')).toBe('u1');
    expect(await repo.userForOpenId('openid_web', 'goapply', 'wx_mp')).toBeNull();
  });

  it('stores grants as single-use tokens (kind per template, random hash, TTL) and caps them', async () => {
    const f = fakeDb();
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    const g = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', scene: 'campus_deadline' as const, eventId: 'ev1' };
    expect(await repo.addGrants('u1', 'goapply', [g, g], NOW)).toEqual({ deadline_reminder: 2 });
    expect(f.tokens[0]).toMatchObject({ userId: 'u1', brand: 'goapply', kind: 'wechat_sub:deadline_reminder', payload: { templateId: 'Tpl_1', scene: 'campus_deadline', eventId: 'ev1' } });
    expect(f.tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.tokens[0]!.tokenHash).not.toBe(f.tokens[1]!.tokenHash);
    expect((f.tokens[0]!.expiresAt as Date).getTime() - NOW.getTime()).toBe(GRANT_TTL_DAYS * 86_400_000);
    await repo.addGrants('u1', 'goapply', Array.from({ length: MAX_LIVE_GRANTS + 5 }, () => g), NOW);
    expect(f.tokens).toHaveLength(MAX_LIVE_GRANTS);
  });

  it('claims the oldest live grant once, releases and revokes', async () => {
    const f = fakeDb();
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    const g = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', scene: 'campus_deadline' as const };
    await repo.addGrants('u1', 'goapply', [g, { ...g, templateId: 'Tpl_2' }], NOW);
    const first = await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW);
    expect(first).toEqual({ id: 't1', templateId: 'Tpl_1' });
    await repo.releaseGrant(first!.id);
    expect((await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW))?.id).toBe('t1');
    expect(await repo.claimGrant('u1', 'goapply', 'report_ready', NOW)).toBeNull();
    // Expired grants are never claimed.
    expect(await repo.claimGrant('u1', 'goapply', 'deadline_reminder', new Date(NOW.getTime() + (GRANT_TTL_DAYS + 1) * 86_400_000))).toBeNull();
    expect(await repo.revokeGrants('u1', 'goapply', 'deadline_reminder', NOW)).toBe(1);
    expect(await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW)).toBeNull();
  });

  it('writes each grant in a SERIALIZABLE transaction and retries a lost serialization race', async () => {
    const f = fakeDb(() => NOW);
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    const g = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', scene: 'campus_deadline' as const };
    f.$transaction.mockRejectedValueOnce(Object.assign(new Error('could not serialize access'), { code: 'P2034' }));
    expect(await repo.addGrants('u1', 'goapply', [g], NOW)).toEqual({ deadline_reminder: 1 });
    expect(f.txOptions).toEqual([{ isolationLevel: 'Serializable' }]);
    expect(f.tokens).toHaveLength(1);
    // Any other failure is not swallowed.
    f.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.addGrants('u1', 'goapply', [g], NOW)).rejects.toThrow('db down');
  });

  it('pairs the page’s and WeChat’s report of one acceptance into one grant, within the window only', async () => {
    let now = NOW;
    const f = fakeDb(() => now);
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    const page = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', scene: 'campus_deadline' as const, eventId: 'ev1' };
    const wechat = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', source: 'wechat' as const };

    // WeChat first, then the page: one row, completed with what the page knows.
    expect(await repo.addGrants('u1', 'goapply', [wechat], now)).toEqual({ deadline_reminder: 1 });
    expect(await repo.addGrants('u1', 'goapply', [page], now)).toEqual({ deadline_reminder: 1 });
    expect(f.tokens).toHaveLength(1);
    expect(f.tokens[0]!.payload).toEqual({ templateId: 'Tpl_1', source: 'wechat', paired: true, scene: 'campus_deadline', eventId: 'ev1' });

    // The page first, then WeChat: one more row.
    await repo.addGrants('u1', 'goapply', [page], now);
    await repo.addGrants('u1', 'goapply', [wechat], now);
    expect(f.tokens).toHaveLength(2);
    expect(f.tokens[1]!.payload).toMatchObject({ source: 'client', paired: true });

    // The same WeChat report again (a retry) changes nothing.
    const retried = { ...wechat, dedupeKey: 'wx:o1:1700000000:Tpl_1' };
    await repo.addGrants('u1', 'goapply', [retried], now);
    expect(await repo.addGrants('u1', 'goapply', [retried], now)).toEqual({ deadline_reminder: 1 });
    expect(f.tokens).toHaveLength(3);
    f.tokens.pop();

    // A report outside the window is a new acceptance.
    await repo.addGrants('u1', 'goapply', [page], now);
    now = new Date(NOW.getTime() + PAIR_WINDOW_MS + 60_000);
    await repo.addGrants('u1', 'goapply', [wechat], now);
    expect(f.tokens).toHaveLength(4);
  });

  it('claims the grant given for the same event first, then the oldest', async () => {
    const f = fakeDb(() => NOW);
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    const g = { templateKey: 'deadline_reminder' as const, templateId: 'Tpl_1', scene: 'campus_deadline' as const };
    await repo.addGrants('u1', 'goapply', [{ ...g, eventId: 'evA' }, { ...g, eventId: 'evB' }], NOW);
    expect((await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW, 'evB'))?.id).toBe('t2');
    expect((await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW, 'evC'))?.id).toBe('t1');
    expect(await repo.claimGrant('u1', 'goapply', 'deadline_reminder', NOW, 'evA')).toBeNull();
  });

  it('stamps pushSentAt once', async () => {
    const f = fakeDb();
    const repo = createPrismaNotifyCnRepo(async () => f.db);
    await repo.markDelivered('n1', NOW);
    await repo.markDelivered('n1', new Date(NOW.getTime() + 1000));
    expect(f.notifications[0]!.pushSentAt).toEqual(NOW);
  });
});

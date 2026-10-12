// @vitest-environment node
//
// WP-57: the Prisma adapter keeps tool results in RAAuthToken rows of kind
// `tool_result` (raw ids never stored), keeps further ids as `tool_result_alias`
// rows found through the unique tokenHash index (no payload scans), scopes
// every query by kind and brand, and reads today's allowance from the
// limiter's own counter rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rAAuthToken: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  rARateCounter: { findUnique: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: db }));

import { TOOL_RESULT_ALIAS_KIND, TOOL_RESULT_TOKEN_KIND, createPrismaRateCounterReader, createPrismaToolsStore, hashResultId, newResultId, type ToolResultPayload } from './store.js';

const payload: ToolResultPayload = {
  v: 1,
  tool: 'resume_check',
  cacheKey: 'ck',
  report: { kind: 'resume_check', label: 'fair', counts: { urgent: 0, critical: 1, optional: 0 }, issues: [], rulesChecked: 10, profile: 'intl' },
  resume: { markdown: '# A', name: 'a' },
  visitorHash: 'vh',
};
const record = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  brand: 'roboapply',
  kind: TOOL_RESULT_TOKEN_KIND,
  tokenHash: 'h',
  payload,
  userId: null,
  expiresAt: new Date('2026-10-11T00:00:00Z'),
  consumedAt: null,
  createdAt: new Date('2026-10-10T00:00:00Z'),
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('result ids', () => {
  it('are 43 url-safe characters and stored only as a sha256', () => {
    const id = newResultId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newResultId()).not.toBe(id);
    expect(hashResultId(id)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createPrismaToolsStore', () => {
  const store = createPrismaToolsStore();

  it('finds a live cached row by brand, kind and the payload cache key', async () => {
    db.rAAuthToken.findFirst.mockResolvedValue(record());
    const now = new Date('2026-10-10T12:00:00Z');
    const row = await store.findByCacheKey('roboapply', 'ck', now);
    expect(row?.payload.cacheKey).toBe('ck');
    expect(db.rAAuthToken.findFirst.mock.calls[0]![0].where).toEqual({
      kind: 'tool_result',
      brand: 'roboapply',
      consumedAt: null,
      expiresAt: { gt: now },
      payload: { path: ['cacheKey'], equals: 'ck' },
    });
  });

  it('ignores rows of another kind, of another brand or with a foreign payload', async () => {
    db.rAAuthToken.findUnique.mockResolvedValueOnce(record({ kind: 'password_reset' }));
    expect(await store.findByTokenHash('roboapply', 'h')).toBeNull();
    db.rAAuthToken.findUnique.mockResolvedValueOnce(record({ payload: { foo: 1 } }));
    expect(await store.findByTokenHash('roboapply', 'h')).toBeNull();
    db.rAAuthToken.findUnique.mockResolvedValueOnce(record());
    expect(await store.findByTokenHash('goapply', 'h')).toBeNull();
    db.rAAuthToken.findUnique.mockResolvedValueOnce(record({ payload: { ...payload, visitorHash: undefined } }));
    expect(await store.findByTokenHash('roboapply', 'h')).toBeNull();
  });

  it('every lookup is by the unique tokenHash (then the row id): no scan of payload JSON', async () => {
    db.rAAuthToken.findUnique.mockResolvedValueOnce(null);
    expect(await store.findByTokenHash('roboapply', 'unknown')).toBeNull();
    expect(db.rAAuthToken.findUnique).toHaveBeenCalledTimes(1);
    expect(db.rAAuthToken.findUnique.mock.calls[0]![0].where).toEqual({ tokenHash: 'unknown' });
    expect(db.rAAuthToken.findFirst).not.toHaveBeenCalled();
  });

  it('an alias id resolves to its result row of the same brand', async () => {
    db.rAAuthToken.findUnique
      .mockResolvedValueOnce(record({ id: 'a1', kind: TOOL_RESULT_ALIAS_KIND, tokenHash: 'h2', payload: { v: 1, of: 't1' } }))
      .mockResolvedValueOnce(record());
    const row = await store.findByTokenHash('roboapply', 'h2');
    expect(row?.id).toBe('t1');
    expect(db.rAAuthToken.findUnique.mock.calls[1]![0].where).toEqual({ id: 't1' });
    db.rAAuthToken.findUnique.mockResolvedValueOnce(record({ kind: TOOL_RESULT_ALIAS_KIND, payload: { nope: true } }));
    expect(await store.findByTokenHash('roboapply', 'h3')).toBeNull();
  });

  it('addTokenAlias creates an alias row with the result row brand and expiry', async () => {
    db.rAAuthToken.create.mockResolvedValueOnce({ id: 'a1' });
    const expiresAt = new Date('2026-10-11T00:00:00Z');
    await store.addTokenAlias({ id: 't1', brand: 'roboapply', expiresAt }, 'h3');
    expect(db.rAAuthToken.create.mock.calls[0]![0].data).toEqual({
      kind: TOOL_RESULT_ALIAS_KIND,
      brand: 'roboapply',
      tokenHash: 'h3',
      payload: { v: 1, of: 't1' },
      expiresAt,
    });
    expect(db.rAAuthToken.update).not.toHaveBeenCalled();
  });

  it('creates with kind tool_result and no user', async () => {
    db.rAAuthToken.create.mockResolvedValue(record());
    await store.create({ brand: 'roboapply', tokenHash: 'h', payload, expiresAt: new Date('2026-10-11T00:00:00Z') });
    const data = db.rAAuthToken.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ kind: 'tool_result', brand: 'roboapply', tokenHash: 'h' });
    expect(data).not.toHaveProperty('userId');
  });

  it('claims atomically (only while unclaimed) and can undo it', async () => {
    db.rAAuthToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const now = new Date();
    expect(await store.markClaimed('t1', 'u1', now)).toBe(true);
    expect(await store.markClaimed('t1', 'u2', now)).toBe(false);
    expect(db.rAAuthToken.updateMany.mock.calls[0]![0]).toEqual({ where: { id: 't1', kind: 'tool_result', consumedAt: null }, data: { consumedAt: now, userId: 'u1' } });
    db.rAAuthToken.updateMany.mockResolvedValueOnce({ count: 1 });
    await store.unclaim('t1');
    expect(db.rAAuthToken.updateMany.mock.calls[2]![0].data).toEqual({ consumedAt: null, userId: null });
  });

  it('purges only this brand’s expired tool results and alias rows', async () => {
    db.rAAuthToken.deleteMany.mockResolvedValue({ count: 4 });
    const now = new Date();
    expect(await store.purgeExpired('goapply', now)).toBe(4);
    expect(db.rAAuthToken.deleteMany.mock.calls[0]![0]).toEqual({
      where: { kind: { in: ['tool_result', 'tool_result_alias'] }, brand: 'goapply', expiresAt: { lte: now } },
    });
  });
});

describe('createPrismaRateCounterReader', () => {
  it('reads each window row by its compound key (0 when absent)', async () => {
    db.rARateCounter.findUnique.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce(null);
    const w = new Date('2026-10-10T00:00:00Z');
    const out = await createPrismaRateCounterReader().counts([
      { key: 'rl:roboapply:publicToolsPerIp:ip:x:86400', windowStart: w },
      { key: 'other', windowStart: w },
    ]);
    expect(out).toEqual([2, 0]);
    expect(db.rARateCounter.findUnique.mock.calls[0]![0].where).toEqual({ key_windowStart: { key: 'rl:roboapply:publicToolsPerIp:ip:x:86400', windowStart: w } });
  });
});

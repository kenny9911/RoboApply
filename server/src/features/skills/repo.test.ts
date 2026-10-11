// @vitest-environment node
// MKT-2G item 1: the RASkill repo. The Prisma delegate is a fake; nothing
// reaches a database. The label vector is never read or written here.
import { describe, expect, it, vi } from 'vitest';

import { createMemorySkillRepo, createPrismaSkillRepo, type SkillRepo, type SkillWrite } from './repo.js';

const write = (over: Partial<SkillWrite> & { id: string }): SkillWrite => ({
  kind: 'hard',
  labelEn: over.id,
  labelZh: null,
  labelZhHant: null,
  aliases: [over.id],
  parentId: null,
  esco: null,
  onet: null,
  status: 'unreviewed',
  ...over,
});

function fakeDb(existing: Record<string, { aliases: string[] }> = {}) {
  const calls: Array<{ op: string; args: any }> = [];
  const record = (op: string, result: unknown) => vi.fn(async (args: any) => (calls.push({ op, args }), result));
  const rASkill = {
    findMany: record('findMany', []),
    findUnique: vi.fn(async (args: any) => (calls.push({ op: 'findUnique', args }), existing[args.where.id] ?? null)),
    upsert: vi.fn((args: any) => (calls.push({ op: 'upsert', args }), Promise.resolve({}))),
    createMany: record('createMany', { count: 2 }),
    update: record('update', {}),
    updateMany: record('updateMany', { count: 1 }),
  };
  const $transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));
  return { db: { rASkill, $transaction } as any, calls, $transaction };
}

describe('createPrismaSkillRepo', () => {
  it('imports no client until the first call, and reads named scalar columns only', async () => {
    const getDb = vi.fn();
    const { db, calls } = fakeDb();
    getDb.mockResolvedValue(db);
    const repo = createPrismaSkillRepo(getDb);
    expect(getDb).not.toHaveBeenCalled();
    await repo.list();
    await repo.listByMentions({ limit: 5, notStatus: 'dropped' });
    expect(getDb).toHaveBeenCalledTimes(2);
    const select = calls[0]!.args.select;
    expect(Object.keys(select).sort()).toEqual(['aliases', 'esco', 'id', 'kind', 'labelEn', 'labelZh', 'labelZhHant', 'mentionCount', 'onet', 'parentId', 'status']);
    expect(select.embedding).toBeUndefined();
    expect(calls[0]!.args.orderBy).toEqual({ id: 'asc' });
    expect(calls[1]!.args).toMatchObject({ where: { status: { not: 'dropped' } }, orderBy: [{ mentionCount: 'desc' }, { id: 'asc' }], take: 5 });
  });

  it('upsert replaces the scalar columns and keeps the mention count of an existing row', async () => {
    const { db, calls, $transaction } = fakeDb();
    const repo = createPrismaSkillRepo(async () => db);
    expect(await repo.upsert([write({ id: 'supabase', aliases: ['supabase', 'supabase'], mentionCount: 4 })])).toBe(1);
    expect($transaction).toHaveBeenCalledTimes(1);
    const { args } = calls.find((c) => c.op === 'upsert')!;
    expect(args.where).toEqual({ id: 'supabase' });
    expect(args.create).toMatchObject({ id: 'supabase', mentionCount: 4, aliases: ['supabase'], status: 'unreviewed' });
    expect(args.update.mentionCount).toBeUndefined();
    expect(args.update.id).toBeUndefined();
    expect(args.update.embedding).toBeUndefined();
    expect(await repo.upsert([])).toBe(0);
  });

  it('upsert writes a large sheet in transactions of 100 rows', async () => {
    const { db, $transaction } = fakeDb();
    const repo = createPrismaSkillRepo(async () => db);
    await repo.upsert(Array.from({ length: 250 }, (_, i) => write({ id: `skill_${i}` })));
    expect($transaction.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([100, 100, 50]);
  });

  it('createMissing never touches an existing row', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSkillRepo(async () => db);
    expect(await repo.createMissing([write({ id: 'a' }), write({ id: 'b', mentionCount: 1 })])).toBe(2);
    const { args } = calls.find((c) => c.op === 'createMany')!;
    expect(args.skipDuplicates).toBe(true);
    expect(args.data.map((d: any) => [d.id, d.mentionCount])).toEqual([['a', 0], ['b', 1]]);
  });

  it('addAliasKeys pushes only the keys the row lacks, and says when the row is missing', async () => {
    const { db, calls } = fakeDb({ postgresql: { aliases: ['postgresql', 'postgre'] } });
    const repo = createPrismaSkillRepo(async () => db);
    expect(await repo.addAliasKeys('postgresql', ['postgre', 'pgsql', 'pgsql', ''])).toBe(true);
    expect(calls.find((c) => c.op === 'update')!.args).toEqual({ where: { id: 'postgresql' }, data: { aliases: { push: ['pgsql'] } } });
    expect(await repo.addAliasKeys('postgresql', ['postgre'])).toBe(true);
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(await repo.addAliasKeys('missing', ['x'])).toBe(false);
  });

  it('incrementMentions and setExternalIds are one statement each', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSkillRepo(async () => db);
    await repo.incrementMentions(['a', 'b', 'a']);
    expect(calls.at(-1)!.args).toEqual({ where: { id: { in: ['a', 'b'] } }, data: { mentionCount: { increment: 1 } } });
    await repo.incrementMentions([]);
    await repo.setExternalIds('a', { esco: 'x:1' });
    expect(calls.at(-1)!.args).toEqual({ where: { id: 'a' }, data: { esco: 'x:1' } });
    const n = calls.length;
    await repo.setExternalIds('a', {});
    expect(calls).toHaveLength(n);
  });
});

describe('createMemorySkillRepo keeps the same contract', () => {
  it('behaves like the table for every call the tooling makes', async () => {
    const repo: SkillRepo = createMemorySkillRepo([write({ id: 'b', mentionCount: 3 }), write({ id: 'a', mentionCount: 9, status: 'dropped' })]);
    expect((await repo.list()).map((r) => r.id)).toEqual(['a', 'b']);
    expect((await repo.listByMentions({ limit: 5, notStatus: 'dropped' })).map((r) => r.id)).toEqual(['b']);

    await repo.upsert([write({ id: 'b', labelEn: 'B!', status: 'reviewed', mentionCount: 0 })]);
    expect((await repo.list()).find((r) => r.id === 'b')).toMatchObject({ labelEn: 'B!', status: 'reviewed', mentionCount: 3 });

    expect(await repo.createMissing([write({ id: 'b', labelEn: 'ignored' }), write({ id: 'c', mentionCount: 1 })])).toBe(1);
    expect((await repo.list()).find((r) => r.id === 'b')!.labelEn).toBe('B!');

    expect(await repo.addAliasKeys('c', ['c', 'cee'])).toBe(true);
    expect(await repo.addAliasKeys('zzz', ['x'])).toBe(false);
    await repo.incrementMentions(['c', 'c', 'b']);
    await repo.setExternalIds('c', { onet: 'o:1' });
    expect((await repo.list()).find((r) => r.id === 'c')).toMatchObject({ aliases: ['c', 'cee'], mentionCount: 2, onet: 'o:1', esco: null });
    // A caller cannot change a stored row through what `list` returned.
    (await repo.list())[0]!.aliases.push('leak');
    expect((await repo.list())[0]!.aliases).not.toContain('leak');
  });
});

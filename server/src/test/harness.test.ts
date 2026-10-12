// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFakePrisma, matchesWhere } from './fakePrisma.js';
import { createSqlRecorder, normalizeSql } from './sqlSnapshot.js';

describe('createFakePrisma', () => {
  it('supports CRUD with where operators, ordering, paging and select', async () => {
    const db = createFakePrisma({
      seed: {
        user: [
          { id: 'u1', email: 'a@x.test', brand: 'roboapply', createdAt: new Date('2026-01-01') },
          { id: 'u2', email: 'b@x.test', brand: 'goapply', createdAt: new Date('2026-02-01') },
        ],
      },
    });
    expect(await db.user.findUnique({ where: { id: 'u2' }, select: { email: true } })).toEqual({ email: 'b@x.test' });
    expect((await db.user.findMany({ where: { brand: { in: ['goapply'] } } })).map((u) => u!.id)).toEqual(['u2']);
    expect((await db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 1 }))[0]!.id).toBe('u2');
    expect(await db.user.count({ where: { createdAt: { gte: new Date('2026-01-15') } } })).toBe(1);
    const created = await db.user.create({ data: { email: 'c@x.test', brand: 'roboapply' } });
    expect(created).toMatchObject({ email: 'c@x.test', id: expect.any(String), createdAt: expect.any(Date) });
    await db.user.update({ where: { id: 'u1' }, data: { email: 'z@x.test' } });
    expect((await db.user.findFirst({ where: { email: { startsWith: 'z' } } }))!.id).toBe('u1');
    expect(await db.user.updateMany({ where: { brand: 'roboapply' }, data: { brand: 'x' } })).toEqual({ count: 2 });
    await db.user.upsert({ where: { id: 'u9' }, create: { id: 'u9', email: 'n@x.test' }, update: {} });
    expect(await db.user.count()).toBe(4);
    expect(await db.user.deleteMany({ where: { OR: [{ id: 'u9' }, { id: 'u2' }] } })).toEqual({ count: 2 });
    await expect(db.user.update({ where: { id: 'missing' }, data: {} })).rejects.toMatchObject({ code: 'P2025' });
  });

  it('supports increments, transactions and raw SQL recording', async () => {
    const db = createFakePrisma({ seed: { counter: [{ id: 'c', n: 1 }] } });
    await db.$transaction(async (tx) => {
      await (tx.counter as typeof db.counter).update({ where: { id: 'c' }, data: { n: { increment: 2 } } });
    });
    expect(db.$rows('counter')[0]!.n).toBe(3);
    const id = 'abc';
    const run = db.$queryRaw as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    await run`SELECT *
      FROM "RAWorkItem" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    expect(db.$sql.last()).toMatchObject({ text: 'SELECT * FROM "RAWorkItem" WHERE id = $1 FOR UPDATE SKIP LOCKED', values: ['abc'] });
  });

  it('matchesWhere handles null, NOT and compound unique inputs', () => {
    const row = { brand: 'goapply', phoneE164: '+8613800000000', deletedAt: null };
    expect(matchesWhere(row, { deletedAt: null })).toBe(true);
    expect(matchesWhere(row, { NOT: { brand: 'roboapply' } })).toBe(true);
    expect(matchesWhere(row, { brand_phoneE164: { brand: 'goapply', phoneE164: '+8613800000000' } })).toBe(true);
    expect(matchesWhere(row, { brand: { not: 'goapply' } })).toBe(false);
  });
});

describe('createSqlRecorder', () => {
  it('records Prisma.sql-shaped objects and unsafe strings, and returns queued results', async () => {
    const sql = createSqlRecorder({ results: [[{ id: 1 }]] });
    expect(await sql.client.$queryRaw({ strings: ['UPDATE t SET a = ', ' WHERE b = ', ''], values: [1, 2] })).toEqual([{ id: 1 }]);
    expect(sql.last()).toMatchObject({ text: 'UPDATE t SET a = $1 WHERE b = $2', values: [1, 2] });
    expect(await sql.client.$executeRawUnsafe('DELETE  FROM t WHERE id = $1', 'x')).toBe(0);
    expect(sql.texts()).toEqual(['UPDATE t SET a = $1 WHERE b = $2', 'DELETE FROM t WHERE id = $1']);
    expect(normalizeSql('  a \n  b ')).toBe('a b');
  });
});

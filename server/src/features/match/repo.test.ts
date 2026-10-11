// @vitest-environment node
// MKT-4G — the Prisma match repository: the statements this bundle added or changed, tested as text and
// parameters over a recording fake client. No database.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  executed: [] as Array<{ text: string; values: unknown[] }>,
  queried: [] as Array<{ text: string; values: unknown[] }>,
  executeResult: 1,
  findManyArgs: [] as unknown[],
}));

vi.mock('../../lib/prisma.js', () => {
  const record = (list: Array<{ text: string; values: unknown[] }>, sql: { strings: readonly string[]; values: readonly unknown[] }) => {
    list.push({ text: sql.strings.join('?').replace(/\s+/g, ' ').trim(), values: [...sql.values] });
  };
  return {
    default: {
      $executeRaw: vi.fn(async (sql: { strings: readonly string[]; values: readonly unknown[] }) => {
        record(db.executed, sql);
        return db.executeResult;
      }),
      $queryRaw: vi.fn(async (sql: { strings: readonly string[]; values: readonly unknown[] }) => {
        record(db.queried, sql);
        return [];
      }),
      rAJob: {
        findMany: vi.fn(async (args: unknown) => {
          db.findManyArgs.push(args);
          return [];
        }),
      },
      rAResumeVariant: { update: vi.fn() },
    },
  };
});

import prisma from '../../lib/prisma.js';
import { createPrismaMatchRepo } from './repo.js';
import type { StoredRequirementsDoc } from './scorerV4.js';

const DOC: StoredRequirementsDoc = {
  v: 1,
  contentHash: 'hash-1',
  model: 'test/model-a',
  extractedAt: '2026-10-10T08:00:00.000Z',
  items: [{ id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must' }],
};

beforeEach(() => {
  db.executed.length = 0;
  db.queried.length = 0;
  db.findManyArgs.length = 0;
  db.executeResult = 1;
});

describe('saveJobRequirements: the first writer wins', () => {
  it('is one guarded UPDATE of the one column: only a job that has no list for this text of the posting is written', async () => {
    const repo = createPrismaMatchRepo();
    expect(await repo.saveJobRequirements!('job1', DOC)).toBe(true);
    expect(db.executed).toHaveLength(1);
    // No list (SQL NULL or a JSON null), or a list of another text (its content hash is not this one, or it has none).
    expect(db.executed[0]!.text).toBe(
      `UPDATE "RAJob" SET "requirements" = ?::jsonb WHERE "id" = ? AND ("requirements" IS NULL OR "requirements" = 'null'::jsonb OR ("requirements"->>'contentHash') IS DISTINCT FROM ?)`,
    );
    expect(db.executed[0]!.values).toEqual([JSON.stringify(DOC), 'job1', 'hash-1']);
    // Nothing else of the row is touched, no row is read back, and no SELECT * is ever built.
    expect(db.executed[0]!.text).not.toMatch(/updatedAt|RETURNING|\*/);
    expect(db.queried).toHaveLength(0);
  });

  it('answers false when another writer was first for this text (no row matched the guard)', async () => {
    db.executeResult = 0;
    expect(await createPrismaMatchRepo().saveJobRequirements!('job1', DOC)).toBe(false);
  });
});

describe('what a list of fits reads', () => {
  it('no long text: neither the description parts nor the stored requirement lines are selected for a list', async () => {
    const repo = createPrismaMatchRepo();
    await repo.getFitJobs(['a', 'b']);
    const select = (db.findManyArgs[0] as { select: Record<string, unknown> }).select;
    for (const column of ['description', 'descriptionPlain', 'responsibilities', 'benefits', 'requirements']) expect(select, column).not.toHaveProperty(column);
    for (const column of ['id', 'title', 'skills', 'skillIds', 'contentHash', 'seniority', 'marketTags']) expect(select, column).toHaveProperty(column, true);
    // The single-job read holds the full row: the scorer needs the posting's text and its stored lines.
    await repo.getJobs(['a']);
    const full = (db.findManyArgs[1] as { select: Record<string, unknown> }).select;
    for (const column of ['description', 'descriptionPlain', 'qualifications', 'requirements']) expect(full, column).toHaveProperty(column, true);
  });
});

describe('calibration pairs of one scorer', () => {
  it('reads numbers only; with a prompt version only the rows that scorer wrote', async () => {
    const repo = createPrismaMatchRepo();
    const since = new Date('2026-09-01T00:00:00.000Z');
    await repo.listCalibrationPairs({ market: 'intl', since, limit: 500 });
    expect(db.queried[0]!.text).not.toContain('"promptVersion"');
    expect(db.queried[0]!.values).toEqual([since, 'intl', 500]);
    await repo.listCalibrationPairs({ market: 'cn', since, limit: 200, promptVersion: 'scorer_v4' });
    expect(db.queried[1]!.text).toContain('AND s."promptVersion" = ?');
    expect(db.queried[1]!.values).toEqual([since, 'cn', 'scorer_v4', 200]);
    for (const q of db.queried) {
      expect(q.text).toMatch(/^SELECT s\."score" AS "ai", s\."explanation"->'estimateAtScore' AS "estimateAtScore", s\."dimensions" AS "dimensions" FROM "RAJobMatchScore" s/);
      expect(q.text).not.toMatch(/SELECT \*|searchTsv/);
    }
  });
});

describe('the frozen copy of a variant fit', () => {
  it('is no longer written: the repository has no updateVariantCachedScore', () => {
    const repo = createPrismaMatchRepo();
    expect(repo.updateVariantCachedScore).toBeUndefined();
    expect((prisma as unknown as { rAResumeVariant: { update: ReturnType<typeof vi.fn> } }).rAResumeVariant.update).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
//
// The Prisma feed repo over fake delegates (no database):
//   - SR-32-4: the refill keyset id lives in RAFeedSession.windowEndsId; a
//     session written before the column (id inside the `ranks` JSON) still reads;
//   - WP-74: distinctReporters counts only reports newer than the job's latest
//     admin decision (RAJobReview, else the legacy `admin_review` interaction);
//   - WP-78: publicPageIds applies the SEO pages' public predicate;
//   - WP-35: the "Added by you" count;
//   - SM-4: the feed has no AI-score read of its own (fits come from match `getFits`);
//   - SM-12 (MKT-4F): RAUserAffinity.titleWeights is read and written, a row
//     without a usable value reads as an empty map; `impressionStates`; the
//     action job carries its normalized title and canonical skill ids; the
//     session rank entries may carry a same-role group and its folded postings,
//     or mark a first-window row the fit-tier view hid; `recordImpressions`
//     counts a job once per feed session.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FeedSessionRanksSchema, RANKING_FACTORS } from './contract.js';
import { createPrismaFeedRepo, latestDecisionAt, sessionFromRow, unpackRanks } from './repo.js';
import { FakeFeedRepo } from './testkit.js';

const entries = [{ jobId: 'j1', fit: 70, kind: 'pre' as const, rank: 61.2 }];

describe('feed session boundary id (SR-32-4)', () => {
  it('reads the bare array and the older envelope', () => {
    expect(unpackRanks({ entries, windowEndsId: 'j400' })).toEqual({ ranks: entries, windowEndsId: 'j400' });
    expect(unpackRanks(entries)).toEqual({ ranks: entries, windowEndsId: null });
    expect(unpackRanks(null)).toEqual({ ranks: [], windowEndsId: null });
    expect(FeedSessionRanksSchema.safeParse({ entries, windowEndsId: null }).success).toBe(true);
    expect(FeedSessionRanksSchema.safeParse(entries).success).toBe(true);
  });

  it('a rank entry may carry its same-role group and the postings folded into the card; nothing else', () => {
    const collapsed = [{ ...entries[0]!, g: '0123456789abcdef', also: ['j2', 'j3'] }, { jobId: 'j4', fit: null, kind: 'ai' as const, rank: 0 }];
    expect(FeedSessionRanksSchema.safeParse(collapsed).success).toBe(true);
    expect(unpackRanks(collapsed)).toEqual({ ranks: collapsed, windowEndsId: null });
    expect(FeedSessionRanksSchema.safeParse([{ ...entries[0]!, also: 'j2' }]).success).toBe(false);
    expect(FeedSessionRanksSchema.safeParse([{ ...entries[0]!, extra: 1 }]).success).toBe(false);
  });

  it('a rank entry may mark a first-window row the fit-tier view hid (not a card): `h: true`, never false', () => {
    const withHidden = [entries[0]!, { jobId: 'j9', fit: null, kind: 'pre' as const, rank: 0, h: true as const }];
    expect(FeedSessionRanksSchema.safeParse(withHidden).success).toBe(true);
    expect(unpackRanks(withHidden)).toEqual({ ranks: withHidden, windowEndsId: null });
    expect(FeedSessionRanksSchema.safeParse([{ ...entries[0]!, h: false }]).success).toBe(false);
  });

  it('SR-32-4: the boundary id is written to and read from RAFeedSession.windowEndsId; ranks is the bare array', async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const db = {
      rAFeedSession: {
        async create({ data }: { data: Record<string, unknown> }) {
          const row = { ...data, id: 's1', createdAt: new Date('2026-10-10T12:00:00Z') };
          stored.set('s1', row);
          return row;
        },
        async findFirst({ where }: { where: { id: string } }) {
          return stored.get(where.id) ?? null;
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
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
    expect(stored.get('s1')).toMatchObject({ ranks: entries, windowEndsId: 'j400' });
    await repo.updateSession('s1', { jobIds: ['j1', 'j2'], ranks: entries, windowEndsAt: new Date('2026-09-01T00:00:00Z'), windowEndsId: null });
    expect(stored.get('s1')).toMatchObject({ ranks: entries, windowEndsId: null });
    expect(await repo.getSession('s1', 'u1')).toMatchObject({ jobIds: ['j1', 'j2'], ranks: entries, windowEndsId: null });
  });

  it('a session written before the column (id in the ranks envelope, column null) keeps its boundary id; the column wins when set', async () => {
    const legacy = { id: 's0', userId: 'u1', ranks: { entries, windowEndsId: 'j399' }, windowEndsId: null };
    expect(sessionFromRow(legacy)).toMatchObject({ ranks: entries, windowEndsId: 'j399' });
    expect(sessionFromRow({ ...legacy, windowEndsId: 'j400' })).toMatchObject({ ranks: entries, windowEndsId: 'j400' });
    const repo = createPrismaFeedRepo(async () => ({ rAFeedSession: { findFirst: async () => legacy } }) as never);
    expect(await repo.getSession('s0', 'u1')).toMatchObject({ ranks: entries, windowEndsId: 'j399' });
  });
});

// ── distinctReporters (WP-74 "Keep") ────────────────────────────────────────

interface Interaction {
  jobId: string;
  userId: string;
  kind: string;
  reasonCode: string | null;
  createdAt: Date;
}

function reportsDb(interactions: Interaction[], reviews: Array<{ jobId: string; at: Date }>) {
  return {
    rAJobReview: {
      async findFirst({ where }: { where: { jobId: string } }) {
        const rows = reviews.filter((r) => r.jobId === where.jobId).sort((a, b) => b.at.getTime() - a.at.getTime());
        return rows[0] ?? null;
      },
    },
    rAJobInteraction: {
      async findFirst({ where }: { where: { jobId: string; kind: string } }) {
        const rows = interactions.filter((r) => r.jobId === where.jobId && r.kind === where.kind).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      },
      async findMany({ where }: { where: { jobId: string; kind: string; reasonCode: { in: string[] }; createdAt?: { gt: Date } } }) {
        const rows = interactions.filter(
          (r) =>
            r.jobId === where.jobId &&
            r.kind === where.kind &&
            where.reasonCode.in.includes(r.reasonCode ?? '') &&
            (!where.createdAt || r.createdAt.getTime() > where.createdAt.gt.getTime()),
        );
        return [...new Set(rows.map((r) => r.userId))].map((userId) => ({ userId }));
      },
    },
  };
}

const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const report = (userId: string, d: number, reasonCode = 'scam'): Interaction => ({ jobId: 'j1', userId, kind: 'report', reasonCode, createdAt: day(d) });
const REASONS = ['scam', 'expired'] as const;

describe('distinctReporters counts only reports newer than the latest admin decision', () => {
  it('no decision: every distinct reporter with a closing reason counts', async () => {
    const repo = createPrismaFeedRepo(async () => reportsDb([report('a', 1), report('b', 2), report('b', 3), report('c', 4, 'duplicate')], []) as never);
    expect(await repo.distinctReporters('j1', REASONS)).toBe(2);
  });

  it('a kept job (RAJobReview restore) with one new report stays open: the three earlier reports do not count', async () => {
    const interactions = [report('a', 1), report('b', 2), report('c', 3), report('d', 6)];
    const repo = createPrismaFeedRepo(async () => reportsDb(interactions, [{ jobId: 'j1', at: day(5) }]) as never);
    expect(await repo.distinctReporters('j1', REASONS)).toBe(1); // below FEED_LIMITS.reportCloseThreshold (3)
  });

  it('three new reporters after the decision count again', async () => {
    const interactions = [report('a', 1), report('b', 2), report('c', 3), report('d', 6), report('e', 7), report('a', 8)];
    const repo = createPrismaFeedRepo(async () => reportsDb(interactions, [{ jobId: 'j1', at: day(5) }]) as never);
    expect(await repo.distinctReporters('j1', REASONS)).toBe(3);
  });

  it('falls back to the newest admin_review interaction for decisions made before RAJobReview', async () => {
    const legacy: Interaction = { jobId: 'j1', userId: 'admin1', kind: 'admin_review', reasonCode: 'restore', createdAt: day(5) };
    const repo = createPrismaFeedRepo(async () => reportsDb([report('a', 1), report('b', 2), report('c', 3), legacy, report('d', 6)], []) as never);
    expect(await repo.distinctReporters('j1', REASONS)).toBe(1);
  });

  it('uses the newer of the two when both exist; a decision on another job changes nothing', async () => {
    expect(latestDecisionAt(day(5), day(7))).toEqual(day(7));
    expect(latestDecisionAt(day(7), day(5))).toEqual(day(7));
    expect(latestDecisionAt(null, day(5))).toEqual(day(5));
    expect(latestDecisionAt(null, null)).toBeNull();
    const repo = createPrismaFeedRepo(async () => reportsDb([report('a', 1), report('b', 2)], [{ jobId: 'other', at: day(9) }]) as never);
    expect(await repo.distinctReporters('j1', REASONS)).toBe(2);
  });
});

// ── publicPageIds (WP-78) ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** The Prisma `where` operators seo `basePublicWhere` uses. Anything else throws, so a new clause cannot pass unnoticed. */
function matches(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as Row[]).every((w) => matches(row, w))) return false;
    } else if (k === 'OR') {
      if (!(v as Row[]).some((w) => matches(row, w))) return false;
    } else if (k === 'NOT') {
      if (matches(row, v as Row)) return false;
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Row;
      const cell = row[k];
      for (const key of Object.keys(op)) {
        if (key === 'in') {
          if (!(op.in as unknown[]).includes(cell)) return false;
        } else if (key === 'not') {
          if (cell === op.not) return false;
        } else if (key === 'gt') {
          if (!(cell instanceof Date && cell.getTime() > (op.gt as Date).getTime())) return false;
        } else if (key === 'equals') {
          const eq = op.equals;
          // Prisma.AnyNull is a sentinel object: it matches a null cell.
          if (Array.isArray(eq) ? !(Array.isArray(cell) && cell.length === eq.length) : cell != null) return false;
        } else {
          throw new Error(`fake where: unsupported operator ${key} on ${k}`);
        }
      }
    } else if ((row[k] ?? null) !== v) {
      return false;
    }
  }
  return true;
}

const NOW = new Date('2026-10-10T12:00:00Z');
const job = (over: Row): Row => ({
  market: 'intl',
  visibility: 'public',
  isCanonical: true,
  archivedAt: null,
  closedAt: null,
  publicDisplay: true,
  sourceBoard: 'activejobs',
  expiresAt: null,
  fraudFlags: null,
  fromRecruiterBank: true,
  ...over,
});

describe('publicPageIds applies the public-page rules of the SEO pages', () => {
  const rows = [
    job({ id: 'valid' }),
    job({ id: 'archived', archivedAt: NOW }),
    job({ id: 'private', visibility: 'private', ownerUserId: 'u1' }),
    job({ id: 'no_display', publicDisplay: false }),
    job({ id: 'closed', closedAt: NOW }),
    job({ id: 'expired', expiresAt: new Date('2026-10-01T00:00:00Z') }),
    job({ id: 'flagged', fraudFlags: [{ rule: 'upfront_fee', evidence: 'pay a deposit', at: '2026-10-01' }] }),
    job({ id: 'cn_job', market: 'cn' }),
    // A recruiter-bank row whose bank has no posting page (no template is set here): on no public page.
    job({ id: 'held_bank', sourceBoard: 'robohire' }),
  ];
  const db = { rAJob: { findMany: async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id })) } };
  const repo = createPrismaFeedRepo(async () => db as never);

  it('one archived, one private, one non-publicDisplay and one valid job → only the valid one', async () => {
    expect([...(await repo.publicPageIds(['valid', 'archived', 'private', 'no_display'], 'intl', NOW))]).toEqual(['valid']);
  });

  it('closed, expired, fraud-flagged and other-market jobs are refused too; only asked ids are read', async () => {
    expect([...(await repo.publicPageIds(rows.map((r) => r.id as string), 'intl', NOW))]).toEqual(['valid']);
    expect([...(await repo.publicPageIds(['held_bank'], 'intl', NOW))]).toEqual([]);
    expect([...(await repo.publicPageIds(['archived'], 'intl', NOW))]).toEqual([]);
    expect([...(await repo.publicPageIds([], 'intl', NOW))]).toEqual([]);
  });
});

describe('importedCount ("Added by you")', () => {
  it("counts the user's own imports that are not archived: ownerUserId = me AND sourceBoard = 'user_import' AND archivedAt IS NULL", async () => {
    let seen: unknown;
    const db = {
      rAJob: {
        count: async ({ where }: { where: unknown }) => {
          seen = where;
          return 2;
        },
      },
    };
    expect(await createPrismaFeedRepo(async () => db as never).importedCount('u1', 'intl')).toBe(2);
    expect(seen).toEqual({ ownerUserId: 'u1', sourceBoard: 'user_import', market: 'intl', archivedAt: null });
  });
});

describe('the feed reads no AI score of its own (SM-4)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = (file: string) => readFileSync(path.join(here, file), 'utf8');

  it('FeedRepo has no aiScores: the Prisma repo and the fake expose none, and the repo never touches RAJobMatchScore', () => {
    const repo = createPrismaFeedRepo(async () => ({}) as never);
    expect(repo).not.toHaveProperty('aiScores');
    expect(new FakeFeedRepo()).not.toHaveProperty('aiScores');
    expect(source('repo.ts')).not.toMatch(/rAJobMatchScore|aiScores/);
    expect(source('FeedQueryService.ts')).not.toMatch(/aiScores|preScore\(|SCORER_PROMPT_VERSION/);
  });

  it('the old rule "AI score, else the estimate minus 5" is gone from the feed', () => {
    for (const file of ['ranking.ts', 'FeedQueryService.ts', 'contract.ts', 'items.ts', 'testkit.ts']) {
      expect(source(file), file).not.toMatch(/pre\s*[-−]\s*5|\bfitOf\b|minus 5/);
    }
    expect(RANKING_FACTORS.find((f) => f.key === 'fit')!.what).toBe('Fit score: the AI score when one exists, otherwise the quick estimate. Both are on the same scale. Until a market has enough scored jobs to line the two up, a job with an AI score is ranked halfway between its quick estimate and its AI score.');
  });
});

// ── Affinity title weights, impressions, the action job (SM-12) ─────────────

describe('RAUserAffinity.titleWeights (SM-12)', () => {
  function affinityDb(row: Record<string, unknown> | null) {
    const writes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const db = {
      rAUserAffinity: {
        findUnique: async () => row,
        upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          writes.push({ create: args.create, update: args.update });
        },
      },
    };
    return { repo: createPrismaFeedRepo(async () => db as never), writes };
  }
  const at = new Date('2026-10-10T12:00:00Z');

  it('reads the title map next to the other three', async () => {
    const { repo } = affinityDb({ userId: 'u1', taxonomyWeights: { sales_engineer: -0.25 }, companyWeights: {}, skillWeights: { sk_sql: 0.1 }, titleWeights: { 'sales engineer': -0.25 }, updatedAt: at });
    expect(await repo.getAffinity('u1')).toEqual({ taxonomy: { sales_engineer: -0.25 }, company: {}, skill: { sk_sql: 0.1 }, title: { 'sales engineer': -0.25 }, updatedAt: at });
  });

  it('a row with no title value (written before the column), a null or a malformed one reads as an empty map', async () => {
    for (const titleWeights of [undefined, null, 'x', [1], 7]) {
      const row: Record<string, unknown> = { userId: 'u1', taxonomyWeights: { a: 0.2 }, companyWeights: {}, skillWeights: {}, updatedAt: at };
      if (titleWeights !== undefined) row.titleWeights = titleWeights;
      const { repo } = affinityDb(row);
      expect((await repo.getAffinity('u1'))!.title).toEqual({});
    }
    // Entries that are not numbers are dropped, numbers are clamped to −1..1.
    const { repo } = affinityDb({ userId: 'u1', taxonomyWeights: {}, companyWeights: {}, skillWeights: {}, titleWeights: { a: -0.4, b: 'x', c: -9 }, updatedAt: at });
    expect((await repo.getAffinity('u1'))!.title).toEqual({ a: -0.4, c: -1 });
    expect(await affinityDb(null).repo.getAffinity('u1')).toBeNull();
  });

  it('writes the title map on create and on update; a state without one writes an empty map', async () => {
    const { repo, writes } = affinityDb(null);
    await repo.saveAffinity('u1', { taxonomy: { r: -0.25 }, company: {}, skill: {}, title: { 'sales engineer': -0.25 }, updatedAt: at });
    await repo.saveAffinity('u1', { taxonomy: { r: 0.1 }, company: {}, skill: {}, updatedAt: at });
    expect(writes[0]!.create).toEqual({ userId: 'u1', taxonomyWeights: { r: -0.25 }, companyWeights: {}, skillWeights: {}, titleWeights: { 'sales engineer': -0.25 } });
    expect(writes[0]!.update).toEqual({ taxonomyWeights: { r: -0.25 }, companyWeights: {}, skillWeights: {}, titleWeights: { 'sales engineer': -0.25 } });
    expect(writes[1]!.update).toMatchObject({ titleWeights: {} });
  });
});

describe('recordImpressions (one impression per job and feed session)', () => {
  const at = new Date('2026-10-10T12:00:30.000Z');
  const sessionStartedAt = new Date('2026-10-10T12:00:00.000Z');

  it('one statement: a new row counts 1; an existing row is raised only when it was last shown before the session started', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
        return 1;
      },
    };
    const repo = createPrismaFeedRepo(async () => db as never);
    await repo.recordImpressions('u1', ['j1', 'j2'], at, sessionStartedAt);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      'INSERT INTO "RAJobUserState" ("userId", "jobId", "impressions", "lastImpressionAt") ' +
        'SELECT ?, j.id, 1, ?::timestamp(3) FROM unnest(?::text[]) AS j(id) ' +
        'ON CONFLICT ("userId", "jobId") DO UPDATE ' +
        'SET "impressions" = "RAJobUserState"."impressions" + 1, "lastImpressionAt" = EXCLUDED."lastImpressionAt" ' +
        'WHERE "RAJobUserState"."lastImpressionAt" IS NULL OR "RAJobUserState"."lastImpressionAt" < ?::timestamp(3)',
    );
    expect(calls[0]!.values).toEqual(['u1', at, ['j1', 'j2'], sessionStartedAt]);
    // No job: no statement.
    await repo.recordImpressions('u1', [], at, sessionStartedAt);
    expect(calls).toHaveLength(1);
  });

  it('the stamp is never before the session\'s start, so a second batch of the same session cannot count again', async () => {
    const values: unknown[][] = [];
    const db = { $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => (values.push(v), 1) };
    const early = new Date(sessionStartedAt.getTime() - 500);
    await createPrismaFeedRepo(async () => db as never).recordImpressions('u1', ['j1'], early, sessionStartedAt);
    expect(values[0]).toEqual(['u1', sessionStartedAt, ['j1'], sessionStartedAt]);
  });

  it('the in-memory repo follows the same rule: two batches of one session count once, the next session counts again', async () => {
    const fake = new FakeFeedRepo();
    await fake.recordImpressions('u1', ['j1', 'j2'], at, sessionStartedAt);
    await fake.recordImpressions('u1', ['j1'], new Date(at.getTime() + 15_000), sessionStartedAt);
    await fake.recordImpressions('u1', ['j1'], new Date(at.getTime() + 30_000), sessionStartedAt);
    const read = async () => Object.fromEntries([...(await fake.impressionStates('u1', ['j1', 'j2']))].map(([id, st]) => [id, st.impressions]));
    expect(await read()).toEqual({ j1: 1, j2: 1 });
    const nextSession = new Date(at.getTime() + 3_600_000);
    await fake.recordImpressions('u1', ['j1'], new Date(nextSession.getTime() + 5_000), nextSession);
    expect(await read()).toEqual({ j1: 2, j2: 1 });
    // A row that exists without an impression (a hidden or opened job) counts its first one.
    fake.impressionRows.set('u1:j3', { impressions: 0, viewedAt: null });
    await fake.recordImpressions('u1', ['j3'], at, sessionStartedAt);
    expect((await fake.impressionStates('u1', ['j3'])).get('j3')).toEqual({ impressions: 1, viewedAt: null });
    // Another person's impressions are their own.
    expect((await fake.impressionStates('u2', ['j1'])).size).toBe(0);
  });
});

describe('impressionStates (seen and skipped)', () => {
  it('reads the impression counter and the opened date of the asked jobs, for this user, shown at least once', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const opened = new Date('2026-10-09T08:00:00Z');
    const db = {
      rAJobUserState: {
        findMany: async (args: Record<string, unknown>) => {
          seen.push(args);
          return [
            { jobId: 'j1', impressions: 5, viewedAt: null },
            { jobId: 'j2', impressions: 3, viewedAt: opened },
          ];
        },
      },
    };
    const repo = createPrismaFeedRepo(async () => db as never);
    const out = await repo.impressionStates('u1', ['j1', 'j2', 'j3']);
    expect([...out]).toEqual([
      ['j1', { impressions: 5, viewedAt: null }],
      ['j2', { impressions: 3, viewedAt: opened }],
    ]);
    expect(seen[0]).toEqual({ where: { userId: 'u1', jobId: { in: ['j1', 'j2', 'j3'] }, impressions: { gt: 0 } }, select: { jobId: true, impressions: true, viewedAt: true } });
    // No ids: no read.
    expect((await repo.impressionStates('u1', [])).size).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('the in-memory repo answers the same shape', async () => {
    const fake = new FakeFeedRepo();
    fake.impressionRows.set('u1:j1', { impressions: 4, viewedAt: null });
    fake.impressionRows.set('u2:j1', { impressions: 9, viewedAt: null });
    fake.impressionRows.set('u1:j2', { impressions: 0, viewedAt: null });
    expect([...(await fake.impressionStates('u1', ['j1', 'j2', 'j3']))]).toEqual([['j1', { impressions: 4, viewedAt: null }]]);
  });
});

describe('the job a hide or a save acts on', () => {
  it('carries its normalized title and its canonical skill ids (the title-level negative and the skill keys read them)', async () => {
    let select: Record<string, unknown> = {};
    const db = {
      rAJob: {
        findUnique: async (args: { select: Record<string, unknown> }) => {
          select = args.select;
          return null;
        },
      },
    };
    await createPrismaFeedRepo(async () => db as never).actionJob('j1');
    expect(select).toMatchObject({ title: true, titleNormalized: true, skills: true, skillIds: true, primaryTaxonomyId: true, companyNameNormalized: true });
    // Never a description, the search document or the tsvector.
    expect(Object.keys(select).some((k) => /description|searchDoc|searchTsv/.test(k))).toBe(false);
  });
});

// server/src/features/onboarding/repo.test.ts — the O6 candidate query (INT-08).
//
// The number onboarding tells the user ("N jobs at Good fit or better") is
// counted from these candidates, so the query must leave out what the job list
// leaves out: archived jobs, jobs closed after reports (they keep `archivedAt`
// null) and, on GoApply, fraud-flagged postings (R-17). No database: the query
// is captured and run over rows in memory.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => { throw new Error('tests must not reach Prisma'); } }),
}));

import { NOT_FRAUD_FLAGGED } from '../onboarding-cn/index.js';
import { CANDIDATE_NOT_FRAUD_FLAGGED, createPrismaOnboardingRepo, type CandidateQuery } from './repo.js';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const isJsonNull = (v: unknown) => ['DbNull', 'JsonNull'].includes((v as { constructor?: { name?: string } } | null)?.constructor?.name ?? '');

/** The few Prisma filters this query uses, enough to run it over rows. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('equals' in c) {
      if (isJsonNull(c.equals)) return value === null || value === undefined;
      if (Array.isArray(c.equals)) return Array.isArray(value) && value.length === c.equals.length;
      return value === c.equals;
    }
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('contains' in c) return typeof value === 'string' && value.includes(String(c.contains));
    if ('hasSome' in c) return Array.isArray(value) && (c.hasSome as unknown[]).some((x) => value.includes(x));
    throw new Error(`filter not modelled in this test: ${key} ${JSON.stringify(cond)}`);
  });
}

function repoOver(rows: Row[]) {
  const seen: Where[] = [];
  const db = {
    rAJob: {
      findMany: async (args: { where: Where; take: number }) => {
        seen.push(args.where);
        return rows.filter((r) => matches(r, args.where)).slice(0, args.take).map((r) => ({ id: r.id }));
      },
    },
  };
  return { repo: createPrismaOnboardingRepo(async () => db as never), seen };
}

const job = (over: Row): Row => ({
  market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, fraudFlags: null,
  titleNormalized: '产品经理', taxonomyIds: [], locationCountry: 'CN', locationCity: '上海', location: '上海', workModel: 'onsite',
  ...over,
});
const FLAG = [{ rule: 'training_loan', evidence: '需先交培训费', at: '2026-10-01T00:00:00Z' }];
const query = (over: Partial<CandidateQuery> = {}): CandidateQuery => ({ market: 'cn', taxonomyIds: [], titles: ['产品'], countries: [], includeRemote: false, limit: 50, ...over });

describe('the fraud rule', () => {
  it('is the same filter as the cn index count uses', () => {
    expect(CANDIDATE_NOT_FRAUD_FLAGGED).toEqual(NOT_FRAUD_FLAGGED);
  });
});

describe('findCandidates', () => {
  const rows = [
    job({ id: 'open' }),
    job({ id: 'open_empty_flags', fraudFlags: [] }),
    job({ id: 'closed_by_reports', closedAt: new Date('2026-10-05T00:00:00Z'), closeReason: 'reported' }),
    job({ id: 'flagged', fraudFlags: FLAG }),
    job({ id: 'archived', archivedAt: new Date('2026-10-05T00:00:00Z') }),
    job({ id: 'private', visibility: 'private' }),
    job({ id: 'duplicate', isCanonical: false }),
    job({ id: 'other_market', market: 'intl' }),
    job({ id: 'other_role', titleNormalized: '会计' }),
  ];

  it('GoApply: a closed job and a fraud-flagged job are never candidates, so they are never counted', async () => {
    const { repo, seen } = repoOver(rows);
    expect(await repo.findCandidates(query())).toEqual(['open', 'open_empty_flags']);
    expect(seen[0]).toMatchObject({ market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    // The same exclusion the cn index count uses (onboarding-cn/marketSnapshot.ts).
    expect(seen[0]!.AND).toContainEqual(NOT_FRAUD_FLAGGED);
  });

  it('GoApply: the city filter still applies on top', async () => {
    const { repo } = repoOver([...rows, job({ id: 'open_beijing', locationCity: '北京', location: '北京' })]);
    expect(await repo.findCandidates(query({ cities: ['北京'] }))).toEqual(['open_beijing']);
  });

  it('RoboApply: a closed job is never a candidate; the GoApply fraud rule is not added', async () => {
    const intl = (over: Row) => job({ market: 'intl', titleNormalized: 'product manager', locationCountry: 'US', locationCity: 'Austin', location: 'Austin, TX', ...over });
    const { repo, seen } = repoOver([
      intl({ id: 'open' }),
      intl({ id: 'closed_by_reports', closedAt: new Date('2026-10-05T00:00:00Z'), closeReason: 'reported' }),
      intl({ id: 'archived', archivedAt: new Date('2026-10-05T00:00:00Z') }),
      intl({ id: 'remote_elsewhere', locationCountry: 'CA', workModel: 'remote' }),
      intl({ id: 'elsewhere', locationCountry: 'CA' }),
    ]);
    expect(await repo.findCandidates(query({ market: 'intl', titles: ['product manager'], countries: ['US'], includeRemote: true }))).toEqual(['open', 'remote_elsewhere']);
    expect(seen[0]).toMatchObject({ market: 'intl', archivedAt: null, closedAt: null });
    expect(seen[0]!.AND).not.toContainEqual(NOT_FRAUD_FLAGGED);
  });

  it('no role to search for → nothing is read', async () => {
    const { repo, seen } = repoOver(rows);
    expect(await repo.findCandidates(query({ titles: [] }))).toEqual([]);
    expect(seen).toEqual([]);
  });
});

// @vitest-environment node
// WP-56: the Prisma repository and the "two evaluators must agree" rule of
// scope.ts, without a database.
//   1. `publicJobWhere` (what Prisma runs) and `matchesScope` (what the
//      in-memory repo and every route test use) select exactly the same rows,
//      over planted rows × every page scope. The `where` is evaluated by a
//      small interpreter with SQL NULL semantics (a comparison with NULL is
//      unknown, as in Postgres, so `not`/`in` never match a NULL column).
//   2. `createPrismaSeoRepo` sends the arguments Prisma expects (a fake db
//      records them): count/findMany carry the full public predicate, groupBy
//      orders by count with a bound, an empty provider list becomes `in: []`.

import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { createPrismaSeoRepo, type SeoPrismaDb } from './repo.js';
import { matchesScope, publicJobWhere, type JobScope, type ScopeContext, type ScopeRow } from './scope.js';
import { seoJob } from './testkit.js';

// ── A tiny interpreter for the subset of Prisma `where` the scope uses ──────

type Tri = boolean | null;
const and3 = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or3 = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not3 = (x: Tri): Tri => (x === null ? null : !x);

function cmp(a: unknown, b: unknown, insensitive = false): Tri {
  if (a === null || a === undefined) return null;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (insensitive && typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function evalField(value: unknown, filter: unknown): Tri {
  if (filter === null) return value === null || value === undefined;
  if (typeof filter !== 'object' || filter instanceof Date) return cmp(value, filter);
  const f = filter as Record<string, unknown>;
  const parts: Tri[] = [];
  const insensitive = f.mode === 'insensitive';
  for (const [op, arg] of Object.entries(f)) {
    switch (op) {
      case 'mode':
        break;
      case 'equals':
        if (arg === Prisma.AnyNull) parts.push(value === null || value === undefined);
        else if (Array.isArray(arg)) parts.push(Array.isArray(value) ? value.length === arg.length && arg.every((x, i) => value[i] === x) : value === null || value === undefined ? null : false);
        else parts.push(cmp(value, arg, insensitive));
        break;
      case 'not':
        parts.push(arg === null ? value !== null && value !== undefined : not3(cmp(value, arg, insensitive)));
        break;
      case 'in':
        parts.push(value === null || value === undefined ? null : (arg as unknown[]).includes(value));
        break;
      case 'gt':
        parts.push(value === null || value === undefined ? null : (value as Date).getTime() > (arg as Date).getTime());
        break;
      case 'gte':
        parts.push(value === null || value === undefined ? null : (value as Date).getTime() >= (arg as Date).getTime());
        break;
      case 'has':
        parts.push(Array.isArray(value) ? value.includes(arg) : null);
        break;
      default:
        throw new Error(`interpreter: unsupported filter op ${op}`);
    }
  }
  return and3(parts);
}

function evalWhere(where: Prisma.RAJobWhereInput, row: Record<string, unknown>): Tri {
  const parts: Tri[] = [];
  for (const [key, arg] of Object.entries(where)) {
    if (key === 'AND') parts.push(and3((arg as Prisma.RAJobWhereInput[]).map((w) => evalWhere(w, row))));
    else if (key === 'OR') parts.push(or3((arg as Prisma.RAJobWhereInput[]).map((w) => evalWhere(w, row))));
    else if (key === 'NOT') parts.push(not3(evalWhere(arg as Prisma.RAJobWhereInput, row)));
    else parts.push(evalField(row[key], arg));
  }
  return and3(parts);
}

const prismaSelects = (where: Prisma.RAJobWhereInput, row: ScopeRow) => evalWhere(where, row as unknown as Record<string, unknown>) === true;

// ── Planted rows: one per way a job can fail (or pass) each clause ─────────

const NOW = new Date('2026-10-10T00:00:00.000Z');
const backend = ['software_engineering', 'swe_backend', 'backend_engineer'];

const rows: ScopeRow[] = [
  seoJob(),
  seoJob({ market: 'cn' }),
  seoJob({ visibility: 'private' }),
  seoJob({ isCanonical: false }),
  seoJob({ archivedAt: new Date('2026-10-01') }),
  seoJob({ closedAt: new Date('2026-10-01') }),
  seoJob({ expiresAt: new Date('2026-10-09') }),
  seoJob({ expiresAt: new Date('2026-12-01') }),
  seoJob({ expiresAt: NOW }),
  seoJob({ sourceBoard: 'seed' }),
  seoJob({ fraudFlags: ['scam_phrase'] }),
  seoJob({ fraudFlags: [] }),
  seoJob({ publicDisplay: false }),
  seoJob({ fromRecruiterBank: false, sourceBoard: 'jsearch' }),
  seoJob({ fromRecruiterBank: false, sourceBoard: 'linkedin' }),
  seoJob({ taxonomyIds: ['data_science'] }),
  seoJob({ locationCity: 'TAIPEI' }),
  seoJob({ locationCity: '台北' }),
  seoJob({ locationCity: null }),
  seoJob({ locationCity: 'Hsinchu' }),
  seoJob({ locationCountry: 'US', locationCity: 'Austin' }),
  seoJob({ locationCountry: null, locationCity: null }),
  seoJob({ workModel: 'remote', remoteScope: null, locationCity: null }),
  seoJob({ workModel: 'remote', remoteScope: 'global', locationCity: null }),
  seoJob({ workModel: 'remote', remoteScope: 'US', locationCountry: null, locationCity: null }),
  seoJob({ workModel: 'remote', remoteScope: 'TW' }),
  seoJob({ workModel: 'hybrid' }),
  seoJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.', locationCountry: 'US', locationCity: 'Austin' }),
  seoJob({ sponsorship: 'offered', sponsorshipEvidence: '', locationCountry: 'US' }),
  seoJob({ sponsorship: 'offered', sponsorshipEvidence: null, locationCountry: 'US' }),
  seoJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'No sponsorship.', locationCountry: 'US' }),
  seoJob({ sponsorship: 'offered', sponsorshipEvidence: 'Visa support available.', workModel: 'remote', remoteScope: 'US', locationCountry: null }),
  seoJob({ seniority: 'intern_newgrad' }),
  seoJob({ seniority: 'entry' }),
  seoJob({ seniority: null }),
  seoJob({ employmentType: 'internship' }),
  seoJob({ employmentType: null }),
  seoJob({ employmentType: null, seniority: 'entry' }),
  seoJob({ taxonomyIds: backend, employmentType: 'internship', seniority: 'intern_newgrad', locationCountry: 'US', locationCity: 'Austin' }),
];

const scopes: Array<[string, JobScope]> = [
  ['all', {}],
  ['role', { taxonomyId: 'backend_engineer' }],
  ['role × city', { taxonomyId: 'backend_engineer', city: { names: ['taipei', '台北', '臺北'], country: 'TW' } }],
  ['country', { taxonomyId: 'backend_engineer', country: 'US' }],
  ['remote', { taxonomyId: 'backend_engineer', remote: true }],
  ['remote × country', { remote: true, country: 'US' }],
  ['sponsorship US', { taxonomyId: 'backend_engineer', sponsorshipCountry: 'US' }],
  ['sponsorship any', { sponsorshipOffered: true }],
  ['graduate', { taxonomyId: 'backend_engineer', seniority: ['intern_newgrad', 'entry'] }],
  ['internships', { internship: true }],
  ['entry level', { seniority: ['intern_newgrad', 'entry'], internship: false }],
];

const contexts: Array<[string, ScopeContext]> = [
  ['no providers listed', { market: 'intl', now: NOW, publicBoards: [], heldBanks: [] }],
  ['jsearch listed', { market: 'intl', now: NOW, publicBoards: ['jsearch'], heldBanks: [] }],
  ['cn market', { market: 'cn', now: NOW, publicBoards: [], heldBanks: [] }],
  // RoboHire has no posting page: its bank rows are on no public page (feed/sourceLine.ts `heldBankBoards`).
  ['robohire held', { market: 'intl', now: NOW, publicBoards: ['jsearch'], heldBanks: ['robohire'] }],
];

describe('publicJobWhere ≡ matchesScope (the two evaluators agree)', () => {
  for (const [ctxName, ctx] of contexts) {
    it.each(scopes)(`%s (${ctxName})`, (_name, scope) => {
      const where = publicJobWhere(scope, ctx);
      const viaPrisma = rows.filter((r) => prismaSelects(where, r)).map((r) => (r as unknown as { id: string }).id);
      const viaRow = rows.filter((r) => matchesScope(r, scope, ctx)).map((r) => (r as unknown as { id: string }).id);
      expect(viaPrisma).toEqual(viaRow);
    });
  }

  it('the grid is not vacuous: each evaluator keeps some rows and drops others', () => {
    const ctx = contexts[1]![1];
    const kept = rows.filter((r) => matchesScope(r, {}, ctx)).length;
    expect(kept).toBeGreaterThan(5);
    expect(kept).toBeLessThan(rows.length - 10);
    // The planted closed / flagged / private / unlisted-provider rows are never kept.
    for (const bad of [rows[2], rows[5], rows[10], rows[14]]) expect(matchesScope(bad!, {}, ctx)).toBe(false);
  });

  it('a recruiter-bank row whose bank has no posting page is kept by neither evaluator; a listed provider row still is', () => {
    const held = contexts[3]![1];
    const bank = rows[0]!;
    const provider = seoJob({ fromRecruiterBank: false, sourceBoard: 'jsearch' });
    expect(matchesScope(bank, {}, contexts[1]![1])).toBe(true);
    expect(matchesScope(bank, {}, held)).toBe(false);
    expect(prismaSelects(publicJobWhere({}, held), bank)).toBe(false);
    expect(matchesScope(provider, {}, held)).toBe(true);
    expect(prismaSelects(publicJobWhere({}, held), provider)).toBe(true);
    // Left out of the context, the rule is read from the environment (no bank has a page here).
    expect(matchesScope(bank, {}, { market: 'intl', now: NOW, publicBoards: [] })).toBe(false);
    expect(JSON.stringify(publicJobWhere({}, { market: 'intl', now: NOW, publicBoards: [] }).AND)).toContain('"NOT":{"fromRecruiterBank":true,"sourceBoard":{"in":["robohire","gohire"]}}');
  });
});

// ── createPrismaSeoRepo against a recording fake db ─────────────────────────

function fakeDb() {
  const calls: Array<{ op: string; args: any }> = [];
  const db: SeoPrismaDb = {
    rAJob: {
      count: async (args) => (calls.push({ op: 'count', args }), 7),
      findMany: async (args) => (calls.push({ op: 'findMany', args }), []),
      findUnique: async (args) => (calls.push({ op: 'findUnique', args }), null),
      groupBy: async (args: unknown) => (
        calls.push({ op: 'groupBy', args }),
        [
          { companyName: 'Acme', _count: { _all: 4 } },
          { companyName: null, _count: { _all: 2 } },
        ]
      ),
    },
    rASeoPage: {
      findMany: async (args) => (calls.push({ op: 'seoFindMany', args }), []),
      count: async (args) => (calls.push({ op: 'seoCount', args }), 0),
      upsert: async (args) => (calls.push({ op: 'seoUpsert', args }), {}),
    },
  };
  return { db, calls };
}

describe('createPrismaSeoRepo', () => {
  const ctx: ScopeContext = { market: 'intl', now: NOW, publicBoards: [], heldBanks: [] };
  const scope: JobScope = { taxonomyId: 'backend_engineer' };

  it('countJobs: the full public predicate plus the extra narrowing', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSeoRepo(db);
    await expect(repo.countJobs(scope, ctx, { firstSeenSince: new Date('2026-10-03'), payListed: true })).resolves.toBe(7);
    const where = calls[0]!.args.where as Prisma.RAJobWhereInput;
    expect(where).toMatchObject({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, publicDisplay: true, sourceBoard: { not: 'seed' } });
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] },
        { OR: [{ fraudFlags: { equals: Prisma.AnyNull } }, { fraudFlags: { equals: [] } }] },
        // Empty PUBLIC_DISPLAY_PROVIDERS → `in: []` (matches nothing), so only bank jobs remain.
        { OR: [{ fromRecruiterBank: true }, { sourceBoard: { in: [] } }] },
        { taxonomyIds: { has: 'backend_engineer' } },
        { firstSeenAt: { gte: new Date('2026-10-03') } },
        { salaryDisclosed: true },
      ]),
    );
  });

  it('topCompanies / groupCounts: groupBy by the keys, ordered by count, bounded, nameless groups dropped', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSeoRepo(db);
    await expect(repo.topCompanies(scope, ctx, 5)).resolves.toEqual([{ name: 'Acme', count: 4 }]);
    expect(calls[0]!.args).toMatchObject({ by: ['companyName'], _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: 5 });
    expect(calls[0]!.args.where).toEqual(publicJobWhere(scope, ctx));

    await repo.groupCounts(scope, ctx, ['locationCity', 'locationCountry'], 200);
    expect(calls[1]!.args).toMatchObject({ by: ['locationCity', 'locationCountry'], orderBy: { _count: { id: 'desc' } }, take: 200 });
  });

  it('listJobs: newest posted first with nulls last, bounded; the ticker orders by first seen', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSeoRepo(db);
    await repo.listJobs(scope, ctx, { limit: 20, order: 'posted' });
    await repo.listJobs({}, ctx, { limit: 10, order: 'firstSeen' });
    expect(calls[0]!.args).toMatchObject({ take: 20, orderBy: [{ postedAt: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'desc' }, { id: 'asc' }] });
    expect(calls[1]!.args).toMatchObject({ take: 10, orderBy: [{ firstSeenAt: 'desc' }, { id: 'asc' }] });
    expect(calls[1]!.args.where).toEqual(publicJobWhere({}, ctx));
  });

  it('listJobPage (sitemaps): the public predicate, ordered by id, paged', async () => {
    const { db, calls } = fakeDb();
    await createPrismaSeoRepo(db).listJobPage(ctx, { skip: 45_000, take: 45_000 });
    expect(calls[0]!.args).toMatchObject({ orderBy: { id: 'asc' }, skip: 45_000, take: 45_000 });
    expect(calls[0]!.args.where).toEqual(publicJobWhere({}, ctx));
  });

  it('findJob reads one row whatever its state (the service decides 404 vs 410)', async () => {
    const { db, calls } = fakeDb();
    await expect(createPrismaSeoRepo(db).findJob('job1')).resolves.toBeNull();
    expect(calls[0]!.args.where).toEqual({ id: 'job1' });
  });

  it('RASeoPage: brand-scoped reads; upsert on the brand × locale × type × slug key', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaSeoRepo(db);
    await repo.listSeoPages('roboapply', { indexableOnly: true });
    await repo.countSeoPages('roboapply', { indexableOnly: false });
    await repo.upsertSeoPage({
      brand: 'roboapply',
      locale: 'en',
      type: 'role',
      slug: 'backend-engineer',
      params: { role: 'backend_engineer' },
      title: 't',
      h1: 'h',
      intro: 'i',
      stats: {},
      jobCount: 21,
      indexable: true,
      lastBuiltAt: NOW,
    });
    expect(calls[0]!.args.where).toEqual({ brand: 'roboapply', indexable: true });
    expect(calls[1]!.args.where).toEqual({ brand: 'roboapply' });
    expect(calls[2]!.args.where).toEqual({ brand_locale_type_slug: { brand: 'roboapply', locale: 'en', type: 'role', slug: 'backend-engineer' } });
    expect(calls[2]!.args.update).toMatchObject({ jobCount: 21, indexable: true, lastBuiltAt: NOW });
  });
});

// @vitest-environment node
//
// The M1 data backfills (SM-2, SM-10) against a fake database object: no
// database, no queue, no model. Rows are SYNTHETIC.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ENRICH_VERSION, REMATCH_GENERATION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL, enrichDedupeKey, rematchDedupeKey } from '../enrich/index.js';
import { CLEARED_PAY, clearImplausiblePay, type PayDb } from './clearImplausiblePay.js';
import { rematchRoles, type BackfillMarket, type RematchDb, type RoleChange } from './rematchRoles.js';
import { BACKFILL_SAMPLE_SIZE, BACKFILL_USAGE, formatBackfillReport, parseBackfillArgs, runBackfill } from './run.js';

interface JobRow {
  id: string;
  market: string;
  isCanonical: boolean;
  archivedAt: Date | null;
  title: string;
  primaryTaxonomyId: string | null;
  taxonomyIds: string[];
  titleMatchScore: number | null;
  enrichVersion: number | null;
  enrichModel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryMonths: number | null;
  salaryText: string | null;
  salaryDisclosed: boolean;
}

function job(over: Partial<JobRow> & { id: string }): JobRow {
  return {
    market: 'intl',
    isCanonical: true,
    archivedAt: null,
    title: 'Backend Engineer',
    primaryTaxonomyId: 'backend_engineer',
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    titleMatchScore: null,
    enrichVersion: 1,
    enrichModel: 'openai/gpt-cheap',
    salaryMin: null,
    salaryMax: null,
    salaryAnnualMin: null,
    salaryAnnualMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMonths: null,
    salaryText: null,
    salaryDisclosed: false,
    ...over,
  };
}

const DESIGN = ['design', 'spatial_design', 'architect'];

/** A fake of the two Prisma calls the backfills make, over an in-memory table; a float column like the real one. */
function fakeDb(rows: JobRow[]) {
  const reads: Array<{ where: Record<string, unknown>; take: number }> = [];
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const matches = (r: JobRow, where: Record<string, unknown>) => {
    if (where.market !== undefined && r.market !== where.market) return false;
    if (where.isCanonical !== undefined && r.isCanonical !== where.isCanonical) return false;
    if (where.archivedAt === null && r.archivedAt !== null) return false;
    const id = where.id as { gt: string } | undefined;
    if (id && !(r.id > id.gt)) return false;
    if (where.OR && r.salaryMin === null && r.salaryMax === null) return false;
    return true;
  };
  const db = {
    rAJob: {
      findMany: async (args: { where: Record<string, unknown>; orderBy: { id: 'asc' }; take: number; select: Record<string, true> }) => {
        expect(args.orderBy).toEqual({ id: 'asc' });
        reads.push({ where: args.where, take: args.take });
        return rows
          .filter((r) => matches(r, args.where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, args.take)
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]])));
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === args.where.id)!;
        writes.push({ id: args.where.id, data: args.data });
        for (const [k, v] of Object.entries(args.data)) {
          const value = v && typeof v === 'object' && 'set' in (v as object) ? (v as { set: unknown }).set : v;
          // `titleMatchScore` is a 4-byte float in Postgres.
          (row as unknown as Record<string, unknown>)[k] = k === 'titleMatchScore' && typeof value === 'number' ? Math.fround(value) : value;
        }
        return { id: row.id };
      },
    },
  };
  return { db: db as unknown as RematchDb & PayDb, reads, writes, rows };
}

/** A fake queue with dedupe keys, as the command line wires it: stale rows share the key jobs-maintain uses. */
function fakeQueue() {
  const items = new Map<string, { jobId: string; force: boolean }>();
  const enqueue = vi.fn(async ({ jobId, stale }: { jobId: string; market: BackfillMarket; stale: boolean }) => {
    const key = stale ? enrichDedupeKey(jobId) : rematchDedupeKey(jobId);
    if (items.has(key)) return false;
    items.set(key, { jobId, force: !stale });
    return true;
  });
  return { items, enqueue };
}

const rematch = (h: ReturnType<typeof fakeDb>, q: ReturnType<typeof fakeQueue>, over: Partial<Parameters<typeof rematchRoles>[0]> = {}) =>
  rematchRoles({ market: 'intl', db: h.db, enqueue: q.enqueue, enrichVersion: ENRICH_VERSION, ...over });

describe('rematchRoles (SM-2)', () => {
  const NURSING = ['healthcare', 'clinical', 'nurse_practitioner'];
  const fixture = () => [
    // Filed under the building profession by the old one-word match; today's matcher says software architect, weakly.
    job({ id: 'a_java_architect', title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }),
    // The title names another role outright.
    job({ id: 'b_microservices', title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }),
    job({ id: 'c_landscape', title: 'Landscape Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }),
    job({ id: 'd_backend', title: 'Senior Backend Engineer' }),
    // Filed under school principals by the level word; the title names no role today.
    job({ id: 'e_principal', title: 'Principal Engineer', primaryTaxonomyId: 'education_administrator', taxonomyIds: ['education', 'education_support', 'education_administrator'] }),
    job({ id: 'f_no_role', title: 'Registered Nurse (Nights)', primaryTaxonomyId: null, taxonomyIds: [] }),
    // A weak match (0.883) against a role a model chose: nothing in the title retires it.
    job({ id: 'g_weak', title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: NURSING }),
    // Not live, or another market: never read.
    job({ id: 'x_archived', title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, archivedAt: new Date('2026-10-01T00:00:00.000Z') }),
    job({ id: 'y_duplicate', title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, isCanonical: false }),
    job({ id: 'z_cn', market: 'cn', title: '架构师', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }),
  ];

  it('a dry run counts and lists the changes and writes nothing', async () => {
    const h = fakeDb(fixture());
    const q = fakeQueue();
    const before = JSON.stringify(h.rows);
    const seen: RoleChange[] = [];
    const report = await rematch(h, q, { onChange: (c) => seen.push(c) });
    expect(report).toMatchObject({ task: 'rematch-roles', market: 'intl', apply: false, scanned: 7, scores: 6, moved: 3, cleared: 1, queued: 3, queuedNew: 0 });
    expect(report.changes.map((c) => [c.jobId, c.action, c.queued, c.from, c.to])).toEqual([
      ['a_java_architect', 'moved', true, 'architect', 'software_architect'],
      ['b_microservices', 'moved', false, 'architect', 'software_architect'],
      ['e_principal', 'cleared', true, 'education_administrator', null],
      ['f_no_role', 'moved', false, null, 'registered_nurse'],
      ['g_weak', 'kept', true, 'nurse_practitioner', 'nurse_practitioner'],
    ]);
    expect(seen).toEqual(report.changes);
    expect(report.changes[0]!.score).toBeLessThan(0.9);
    expect(report.changes[1]!.score).toBe(1);
    expect(report.changes[2]!.score).toBeNull();
    expect(h.writes).toEqual([]);
    expect(q.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(h.rows)).toBe(before);
  });

  it('--apply moves "Java Backend Architect" out of Design, queues a weak match without changing it, and stores every score', async () => {
    const h = fakeDb(fixture());
    const q = fakeQueue();
    const report = await rematch(h, q, { apply: true });
    expect(report).toMatchObject({ apply: true, scanned: 7, scores: 6, moved: 3, cleared: 1, queued: 3, queuedNew: 3 });
    const byId = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    // The title names the role outright: moved, nothing left to decide.
    expect(byId.b_microservices).toMatchObject({ primaryTaxonomyId: 'software_architect', taxonomyIds: ['software_engineering', 'swe_leadership', 'software_architect'], titleMatchScore: 1 });
    expect(byId.f_no_role).toMatchObject({ primaryTaxonomyId: 'registered_nurse', taxonomyIds: ['healthcare', 'clinical', 'registered_nurse'] });
    // "Java Backend Architect": the building role came from the retired one-word match. The row leaves the
    // design category for the role the title names today, and the model still gets the last word (under 0.9).
    expect(byId.a_java_architect).toMatchObject({ primaryTaxonomyId: 'software_architect', taxonomyIds: ['software_engineering', 'swe_leadership', 'software_architect'] });
    expect(byId.a_java_architect!.taxonomyIds).not.toContain('design');
    expect(byId.a_java_architect!.titleMatchScore).toBeGreaterThanOrEqual(0.85);
    expect(byId.a_java_architect!.titleMatchScore).toBeLessThan(0.9);
    // "Principal Engineer" is not a school principal and the title names no role: unknown, and queued.
    expect(byId.e_principal).toMatchObject({ primaryTaxonomyId: null, taxonomyIds: [], titleMatchScore: null });
    // A weak match against a role nothing retires: queued for the model, not changed.
    expect(byId.g_weak).toMatchObject({ primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: NURSING });
    expect(byId.g_weak!.titleMatchScore).toBeLessThan(0.9);
    expect(q.enqueue.mock.calls.map(([j]) => j)).toEqual([
      { jobId: 'a_java_architect', market: 'intl', stale: true },
      { jobId: 'e_principal', market: 'intl', stale: true },
      { jobId: 'g_weak', market: 'intl', stale: true },
    ]);
    // A row that was right keeps its role; only its score is written.
    expect(byId.c_landscape).toMatchObject({ primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, titleMatchScore: 1 });
    expect(h.writes.find((w) => w.id === 'c_landscape')!.data).toEqual({ titleMatchScore: 1 });
    expect(h.writes.find((w) => w.id === 'd_backend')!.data).toEqual({ titleMatchScore: 1 });
    // Rows that are not live, and the other market, are untouched.
    for (const id of ['x_archived', 'y_duplicate', 'z_cn']) expect(byId[id]).toMatchObject({ primaryTaxonomyId: 'architect', titleMatchScore: null });
  });

  it('a second --apply run changes nothing and queues nothing new', async () => {
    const h = fakeDb(fixture());
    const q = fakeQueue();
    await rematch(h, q, { apply: true });
    const after = JSON.stringify(h.rows);
    const writes = h.writes.length;
    const again = await rematch(h, q, { apply: true });
    expect(again).toMatchObject({ scanned: 7, scores: 0, moved: 0, cleared: 0, queued: 3, queuedNew: 0 });
    expect(h.writes).toHaveLength(writes);
    expect(JSON.stringify(h.rows)).toBe(after);
    expect(q.items.size).toBe(3);
  });

  it('a row still at an older version shares the work item jobs-maintain queues; a row at the current version gets one forced pass per rematch generation', async () => {
    const h = fakeDb([
      job({ id: 'stale', title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, enrichVersion: ENRICH_VERSION - 1 }),
      job({ id: 'never', title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, enrichVersion: null }),
      job({ id: 'current', title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, enrichVersion: ENRICH_VERSION }),
    ]);
    const q = fakeQueue();
    await rematch(h, q, { apply: true });
    expect([...q.items.entries()]).toEqual([
      [rematchDedupeKey('current'), { jobId: 'current', force: true }],
      [enrichDedupeKey('never'), { jobId: 'never', force: false }],
      [enrichDedupeKey('stale'), { jobId: 'stale', force: false }],
    ]);
    expect(rematchDedupeKey('current')).toBe(`job.enrich:current:v${ENRICH_VERSION}:${REMATCH_GENERATION}`);
    expect(REMATCH_GENERATION).toBe('rematch-v2');
  });

  it('never queues a second model call for a row whose role a model already decided at the current version', async () => {
    const weak = { title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: ['healthcare', 'clinical', 'nurse_practitioner'], enrichVersion: ENRICH_VERSION };
    const h = fakeDb([
      // jobs-maintain already re-enriched this row at the current version and a model picked its role.
      job({ id: 'a_model_ruled', ...weak, enrichModel: 'openai/gpt-cheap' }),
      // The last pass at this version was rules only (no model for the brand; or covered, no consent, a failed call): no model has ruled.
      job({ id: 'b_rules_only', ...weak, enrichModel: RULES_ONLY_MODEL }),
      job({ id: 'c_rules_checked', ...weak, enrichModel: RULES_CHECKED_MODEL }),
      // A model ruled, but this run changes the role (it came from the retired one-word match): the model is asked again.
      job({ id: 'd_role_changed', title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, enrichVersion: ENRICH_VERSION, enrichModel: 'openai/gpt-cheap' }),
      // An older version: the standard item jobs-maintain queues, whatever ran before.
      job({ id: 'e_stale', ...weak, enrichVersion: ENRICH_VERSION - 1, enrichModel: 'openai/gpt-cheap' }),
      // A title that decides needs no model at all.
      job({ id: 'f_decisive', title: 'Backend Engineer', enrichVersion: ENRICH_VERSION, enrichModel: 'openai/gpt-cheap' }),
    ]);
    const q = fakeQueue();
    const dry = await rematch(h, q);
    expect(dry).toMatchObject({ scanned: 6, queued: 4, decidedByModel: 1, queuedNew: 0 });
    expect(dry.changes.map((c) => c.jobId)).toEqual(['b_rules_only', 'c_rules_checked', 'd_role_changed', 'e_stale']);
    const report = await rematch(h, q, { apply: true });
    expect(report).toMatchObject({ scanned: 6, queued: 4, decidedByModel: 1, queuedNew: 4 });
    expect(q.enqueue.mock.calls.map(([j]) => [j.jobId, j.stale])).toEqual([
      ['b_rules_only', false],
      ['c_rules_checked', false],
      ['d_role_changed', false],
      ['e_stale', true],
    ]);
    expect(report.changes.find((c) => c.jobId === 'a_model_ruled')).toBeUndefined();
    // The row a model ruled on is still given its title score.
    expect(h.rows.find((r) => r.id === 'a_model_ruled')!.titleMatchScore).toBeCloseTo(0.883, 3);
    expect(formatBackfillReport(report)).toContain('Rows left alone because a model already decided their role at the current version: 1');

    // A re-run after the queue has forgotten its finished items (they are pruned after about a week) and the
    // model has ruled on every queued row: nothing is queued again.
    for (const r of h.rows) Object.assign(r, { enrichVersion: ENRICH_VERSION, enrichModel: 'openai/gpt-cheap' });
    const later = fakeQueue();
    const again = await rematch(h, later, { apply: true });
    expect(again).toMatchObject({ queued: 0, queuedNew: 0, decidedByModel: 5 });
    expect(later.enqueue).not.toHaveBeenCalled();
  });

  it('reads in keyset pages of 500 by id, and stops at --limit', async () => {
    const many = Array.from({ length: 1201 }, (_, i) => job({ id: `job_${String(i).padStart(5, '0')}`, titleMatchScore: 1 }));
    const h = fakeDb(many);
    const q = fakeQueue();
    const report = await rematch(h, q, { apply: true });
    expect(report).toMatchObject({ scanned: 1201, scores: 0, moved: 0, cleared: 0, queued: 0 });
    expect(h.reads.map((r) => r.take)).toEqual([500, 500, 500]);
    expect(h.reads.map((r) => (r.where.id as { gt: string } | undefined)?.gt)).toEqual([undefined, 'job_00499', 'job_00999']);
    for (const r of h.reads) expect(r.where).toMatchObject({ market: 'intl', isCanonical: true, archivedAt: null });
    expect(h.writes).toEqual([]);

    const limited = fakeDb(many);
    expect((await rematch(limited, q, { limit: 600 })).scanned).toBe(600);
    expect(limited.reads.map((r) => r.take)).toEqual([500, 100]);
    // An exact multiple of the page ends on an empty page.
    const exact = fakeDb(many.slice(0, 1000));
    expect((await rematch(exact, q)).scanned).toBe(1000);
    expect(exact.reads).toHaveLength(3);
  });

  it('works for the mainland market on its own rows', async () => {
    const h = fakeDb([
      job({ id: 'cn_1', market: 'cn', title: '前端研发工程师', primaryTaxonomyId: 'software_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'software_engineer'] }),
      job({ id: 'intl_1', title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }),
    ]);
    const q = fakeQueue();
    const report = await rematch(h, q, { market: 'cn', apply: true });
    expect(report).toMatchObject({ market: 'cn', scanned: 1, moved: 1 });
    expect(h.rows[0]).toMatchObject({ primaryTaxonomyId: 'frontend_engineer', taxonomyIds: ['software_engineering', 'swe_frontend', 'frontend_engineer'] });
    expect(h.rows[1]!.primaryTaxonomyId).toBe('architect');
  });

  it('leaves the stored software role of an "<X>开发工程师" title in place and asks the model', async () => {
    const SWE = ['software_engineering', 'swe_backend', 'software_engineer'];
    const titles = ['系统开发工程师', '中间件开发工程师', 'ERP开发工程师', '音视频开发工程师', '爬虫开发工程师'];
    const h = fakeDb([
      ...titles.map((title, i) => job({ id: `cn_${i}`, market: 'cn', title, primaryTaxonomyId: 'software_engineer', taxonomyIds: SWE })),
      // 研发工程师 names no discipline: with nothing else in the title the stored role goes, and the model decides.
      job({ id: 'cn_rd', market: 'cn', title: '光学研发工程师', primaryTaxonomyId: 'software_engineer', taxonomyIds: SWE }),
      // A specific role named in the title still wins outright.
      job({ id: 'cn_hw', market: 'cn', title: '硬件开发工程师', primaryTaxonomyId: 'software_engineer', taxonomyIds: SWE }),
    ]);
    const q = fakeQueue();
    const report = await rematch(h, q, { market: 'cn', apply: true });
    expect(report).toMatchObject({ scanned: 7, moved: 1, cleared: 1, queued: 6 });
    for (const row of h.rows.slice(0, titles.length)) {
      expect(row, row.title).toMatchObject({ primaryTaxonomyId: 'software_engineer', taxonomyIds: SWE });
      expect(row.titleMatchScore, row.title).toBeGreaterThanOrEqual(0.6);
      expect(row.titleMatchScore, row.title).toBeLessThan(0.9);
    }
    expect(report.changes.filter((c) => c.action === 'cleared').map((c) => c.title)).toEqual(['光学研发工程师']);
    expect(h.rows.find((r) => r.id === 'cn_hw')).toMatchObject({ primaryTaxonomyId: 'hardware_engineer', titleMatchScore: 1 });
  });
});

describe('clearImplausiblePay (SM-10)', () => {
  const fixture = () => [
    job({ id: 'a_absurd', salaryMin: 60_000_000, salaryMax: 60_000_000, salaryAnnualMin: 124_800_000_000 % 2_147_483_647, salaryAnnualMax: 124_800_000_000 % 2_147_483_647, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000,000 an hour', salaryDisclosed: true }),
    job({ id: 'b_fine', salaryMin: 120_000, salaryMax: 150_000, salaryAnnualMin: 120_000, salaryAnnualMax: 150_000, salaryCurrency: 'USD', salaryPeriod: 'year', salaryText: '$120,000 - $150,000 a year', salaryDisclosed: true }),
    job({ id: 'c_mixed', salaryMin: 20, salaryMax: 65_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$20 - $65,000', salaryDisclosed: true }),
    job({ id: 'd_words', salaryText: 'Competitive pay' }),
    job({ id: 'e_cn_month', salaryMin: 18_000, salaryMax: 28_000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMonths: 15, salaryText: '18-28K·15薪', salaryDisclosed: true }),
    job({ id: 'x_archived', salaryMin: 60_000_000, salaryMax: 60_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000,000 an hour', salaryDisclosed: true, archivedAt: new Date('2026-10-01T00:00:00.000Z') }),
    job({ id: 'z_cn', market: 'cn', salaryMin: 60_000_000, salaryMax: 60_000_000, salaryCurrency: 'CNY', salaryPeriod: 'hour', salaryText: '6000万/小时', salaryDisclosed: true }),
  ];

  it('a dry run counts the rows and writes nothing', async () => {
    const h = fakeDb(fixture());
    const before = JSON.stringify(h.rows);
    const report = await clearImplausiblePay({ market: 'intl', db: h.db });
    expect(report).toMatchObject({ task: 'clear-implausible-pay', market: 'intl', apply: false, scanned: 4, cleared: 2 });
    expect(report.changes.map((c) => c.jobId)).toEqual(['a_absurd', 'c_mixed']);
    expect(report.changes[0]).toEqual({ jobId: 'a_absurd', salaryMin: 60_000_000, salaryMax: 60_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000,000 an hour' });
    expect(h.writes).toEqual([]);
    expect(JSON.stringify(h.rows)).toBe(before);
    // Only rows that carry a figure are read at all.
    expect(h.reads[0]!.where).toMatchObject({ market: 'intl', archivedAt: null, OR: [{ salaryMin: { not: null } }, { salaryMax: { not: null } }] });
  });

  it('--apply clears the figures of "$60,000,000 an hour", marks pay as not disclosed and keeps the words', async () => {
    const h = fakeDb(fixture());
    const report = await clearImplausiblePay({ market: 'intl', db: h.db, apply: true });
    expect(report).toMatchObject({ apply: true, scanned: 4, cleared: 2 });
    const byId = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(byId.a_absurd).toMatchObject({ salaryMin: null, salaryMax: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryDisclosed: false, salaryText: '$60,000,000 an hour', salaryCurrency: 'USD', salaryPeriod: 'hour' });
    expect(byId.c_mixed).toMatchObject({ salaryMin: null, salaryMax: null, salaryDisclosed: false, salaryText: '$20 - $65,000' });
    expect(h.writes.map((w) => w.data)).toEqual([CLEARED_PAY, CLEARED_PAY]);
    expect(Object.keys(CLEARED_PAY).sort()).toEqual(['salaryAnnualMax', 'salaryAnnualMin', 'salaryDisclosed', 'salaryMax', 'salaryMin']);
    // Plausible pay, words without a figure, archived rows and the other market are untouched.
    expect(byId.b_fine).toMatchObject({ salaryMin: 120_000, salaryMax: 150_000, salaryDisclosed: true });
    expect(byId.e_cn_month).toMatchObject({ salaryMin: 18_000, salaryMax: 28_000, salaryDisclosed: true });
    expect(byId.x_archived).toMatchObject({ salaryMin: 60_000_000, salaryDisclosed: true });
    expect(byId.z_cn).toMatchObject({ salaryMin: 60_000_000, salaryDisclosed: true });

    // A second run finds nothing left to clear.
    const again = await clearImplausiblePay({ market: 'intl', db: h.db, apply: true });
    expect(again).toMatchObject({ scanned: 2, cleared: 0 });
    expect(h.writes).toHaveLength(2);
  });

  it('reads in keyset pages of 500 by id, and each market only sees its own rows', async () => {
    const many = Array.from({ length: 700 }, (_, i) => job({ id: `job_${String(i).padStart(5, '0')}`, salaryMin: 100_000, salaryMax: 120_000, salaryCurrency: 'USD', salaryPeriod: 'year', salaryDisclosed: true }));
    const h = fakeDb(many);
    expect(await clearImplausiblePay({ market: 'intl', db: h.db, apply: true })).toMatchObject({ scanned: 700, cleared: 0 });
    expect(h.reads.map((r) => r.take)).toEqual([500, 500]);
    expect((h.reads[1]!.where.id as { gt: string }).gt).toBe('job_00499');
    const cn = fakeDb(fixture());
    expect(await clearImplausiblePay({ market: 'cn', db: cn.db, apply: true })).toMatchObject({ scanned: 1, cleared: 1 });
    expect(cn.rows.find((r) => r.id === 'z_cn')).toMatchObject({ salaryMin: null, salaryDisclosed: false, salaryText: '6000万/小时' });
    expect(cn.rows.find((r) => r.id === 'a_absurd')!.salaryMin).toBe(60_000_000);
  });
});

describe('command line', () => {
  it('is a dry run unless --apply is given, and needs a task and a market', () => {
    expect(parseBackfillArgs(['rematch-roles', '--market', 'intl'])).toEqual({ task: 'rematch-roles', market: 'intl', apply: false, limit: null });
    expect(parseBackfillArgs(['--market', 'cn', 'clear-implausible-pay', '--apply', '--limit', '250'])).toEqual({ task: 'clear-implausible-pay', market: 'cn', apply: true, limit: 250 });
    for (const argv of [[], ['rematch-roles'], ['rematch-roles', '--market', 'tw'], ['drop-everything', '--market', 'intl'], ['rematch-roles', '--market', 'intl', '--limit', '0'], ['rematch-roles', '--market', 'intl', '--force'], ['rematch-roles', 'extra', '--market', 'intl']]) {
      expect(() => parseBackfillArgs(argv), argv.join(' ')).toThrow(BACKFILL_USAGE);
    }
    expect(BACKFILL_USAGE).toContain('Without --apply nothing is written');
  });

  it('runs the named task with the given database and queue', async () => {
    const h = fakeDb([
      job({ id: 'a', title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN, salaryMin: 60_000_000, salaryMax: 60_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000,000 an hour', salaryDisclosed: true }),
    ]);
    const q = fakeQueue();
    const deps = { db: h.db, enqueue: q.enqueue, enrichVersion: ENRICH_VERSION };
    expect(await runBackfill({ task: 'rematch-roles', market: 'intl', apply: false, limit: null }, deps)).toMatchObject({ task: 'rematch-roles', moved: 1 });
    expect(await runBackfill({ task: 'clear-implausible-pay', market: 'intl', apply: false, limit: null }, deps)).toMatchObject({ task: 'clear-implausible-pay', cleared: 1 });
    expect(h.writes).toEqual([]);
    await runBackfill({ task: 'rematch-roles', market: 'intl', apply: true, limit: null }, deps);
    await runBackfill({ task: 'clear-implausible-pay', market: 'intl', apply: true, limit: null }, deps);
    expect(h.rows[0]).toMatchObject({ primaryTaxonomyId: 'software_architect', salaryMin: null, salaryDisclosed: false, salaryText: '$60,000,000 an hour' });
  });

  it('prints the counts and at most 20 sample changes, and says when nothing was written', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => job({ id: `job_${String(i).padStart(2, '0')}`, title: 'Microservices Architect', primaryTaxonomyId: 'architect', taxonomyIds: DESIGN }));
    const dry = formatBackfillReport(await rematch(fakeDb(rows), fakeQueue()));
    expect(dry[0]).toBe('rematch-roles · market intl · DRY RUN: nothing was written');
    expect(dry).toContain('Rows read: 30');
    expect(dry).toContain('Roles would be moved to the role the title names: 30');
    expect(dry).toContain(`Sample changes (${BACKFILL_SAMPLE_SIZE} of 30):`);
    expect(dry.filter((l) => l.startsWith('  {'))).toHaveLength(20);
    expect(dry.find((l) => l.startsWith('  {'))).toBe('  {"jobId":"job_00","from":"architect","to":"software_architect","score":1} moved · Microservices Architect');
    // Rows whose role changes are listed before rows that are only queued.
    const mixed = formatBackfillReport(
      await rematch(
        fakeDb([
          job({ id: 'a', title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: ['healthcare', 'clinical', 'nurse_practitioner'] }),
          job({ id: 'b', title: 'Principal Engineer', primaryTaxonomyId: 'education_administrator', taxonomyIds: ['education', 'education_support', 'education_administrator'] }),
        ]),
        fakeQueue(),
      ),
    );
    expect(mixed).toContain('Roles would be removed (set by a one-word match that no longer exists; the title names no role): 1');
    expect(mixed).toContain('Rows would be queued for enrichment because the title does not decide (the model does): 2');
    expect(mixed.filter((l) => l.startsWith('  {'))).toEqual([
      '  {"jobId":"b","from":"education_administrator","to":null,"score":null} cleared, queued · Principal Engineer',
      '  {"jobId":"a","from":"nurse_practitioner","to":"nurse_practitioner","score":0.883} kept, queued · Registered Nurse - ICU',
    ]);
    expect(dry.at(-1)).toBe('Run again with --apply to write these changes.');

    const applied = formatBackfillReport(await rematch(fakeDb(rows), fakeQueue(), { apply: true }));
    expect(applied[0]).toBe('rematch-roles · market intl · APPLIED');
    expect(applied).toContain('Roles moved to the role the title names: 30');
    expect(applied.at(-1)).not.toContain('--apply');

    const pay = formatBackfillReport(
      await clearImplausiblePay({ market: 'intl', db: fakeDb([job({ id: 'a', salaryMin: 60_000_000, salaryMax: 60_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000,000 an hour', salaryDisclosed: true })]).db }),
    );
    expect(pay).toContain("Rows whose figures would be cleared (the posting's words are kept): 1");
    expect(pay.some((l) => l.includes('"salaryText":"$60,000,000 an hour"'))).toBe(true);
  });
});

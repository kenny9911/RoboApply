// @vitest-environment node
//
// WP-30: answers → search-profile filters and profile rows (pure), plus the
// D3 market snapshot (planted private row ignored, pay suppressed below 20).

import { describe, expect, it } from 'vitest';
import { FilterSetPatchSchema } from '../search/index.js';
import {
  basicsToFilters,
  confirmToFilters,
  defaultJobTypes,
  parsedResumeSkills,
  preferencesToFilters,
  seedSeniorityToLevels,
  sponsorshipToWorkAuth,
  titlesToTaxonomyIds,
} from './mapping.js';
import { computeSnapshot, createSnapshotLoader, payListedWhere, snapshotWhere, type SnapshotDb, type SnapshotRow } from './snapshot.js';

describe('basics → filters', () => {
  it('maps titles, job types, places, remote and sponsorship (a valid FilterSetPatch)', () => {
    const patch = basicsToFilters({
      jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }, { label: 'Platform tinkerer' }],
      jobTypes: ['full_time', 'contract'],
      countries: ['US', 'CA'],
      locations: [{ country: 'US', city: 'Austin', label: 'Austin, US' }],
      remoteOk: true,
      needsSponsorship: { US: 'yes', CA: 'not_sure' },
    });
    expect(patch).toEqual({
      taxonomyIds: ['backend_engineer'],
      titles: ['Platform tinkerer'],
      jobTypes: ['full_time', 'contract'],
      country: null,
      locations: [
        { label: 'Austin, US', city: 'Austin', country: 'US', radiusKm: 40 },
        { label: 'CA', country: 'CA', radiusKm: 0 },
      ],
      workModels: null,
      needsSponsorship: true,
    });
    expect(FilterSetPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('one country sets `country`; remote-anywhere alone is remote-only; unticking remote excludes it', () => {
    expect(basicsToFilters({ jobFunctions: [{ label: 'X' }], jobTypes: ['full_time'], countries: ['TW'] })).toMatchObject({ country: 'TW', workModels: null });
    expect(basicsToFilters({ jobFunctions: [{ label: 'X' }], jobTypes: ['full_time'], countries: ['REMOTE'] })).toMatchObject({ country: null, workModels: ['remote'], locations: null });
    expect(basicsToFilters({ jobFunctions: [{ label: 'X' }], jobTypes: ['full_time'], countries: ['GB'], remoteOk: false })).toMatchObject({ workModels: ['hybrid', 'onsite'] });
  });

  it('"Not sure" and unanswered sponsorship are not turned into an answer', () => {
    const base = { jobFunctions: [{ label: 'X' }], jobTypes: ['full_time' as const], countries: ['US'] };
    expect(basicsToFilters({ ...base, needsSponsorship: { US: 'not_sure' } }).needsSponsorship).toBeNull();
    expect(basicsToFilters({ ...base, needsSponsorship: { US: 'no' } }).needsSponsorship).toBe(false);
    expect(basicsToFilters(base).needsSponsorship).toBeNull();
  });

  it('is deterministic (re-submission writes the same patch)', () => {
    const b = { jobFunctions: [{ label: 'X' }], jobTypes: ['full_time' as const], countries: ['US'] };
    expect(basicsToFilters(b)).toEqual(basicsToFilters(b));
  });
});

describe('preferences and confirm → filters', () => {
  it('maps sizes to the filter buckets; Any size clears; pay floor kept as entered', () => {
    expect(preferencesToFilters({ companySizes: ['1-50', '10000+'], minPay: { amount: 90000, currency: 'USD', period: 'year' }, industries: ['Fintech'] })).toEqual({
      industries: ['Fintech'],
      skills: null,
      companySizes: ['1-10', '11-50', '5000+'],
      salaryMin: { amount: 90000, currency: 'USD', period: 'year' },
    });
    expect(preferencesToFilters({ companySizes: ['any', '51-200'] }).companySizes).toBeNull();
    expect(preferencesToFilters({ workModels: ['remote', 'hybrid'] }).workModels).toEqual(['remote', 'hybrid']);
    expect('workModels' in preferencesToFilters({ workModels: ['remote', 'hybrid', 'onsite'] })).toBe(false);
  });

  it('confirm maps levels and adds at most 3 extra titles to the O2 ones', () => {
    const answers = { basics: { jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }], jobTypes: ['full_time'], countries: ['US'] } } as never;
    expect(confirmToFilters({ experienceLevels: ['mid', 'director_plus'], extraFunctions: ['swe_backend', 'a', 'b', 'c'] }, answers)).toEqual({
      seniority: ['mid', 'director_exec'],
      taxonomyIds: ['backend_engineer', 'swe_backend', 'a', 'b'],
    });
    expect(confirmToFilters({ experienceLevels: ['internship'] }, {})).toEqual({ seniority: ['intern_newgrad'] });
  });
});

describe('profile rows and resume seed', () => {
  it('sponsorship answers update workAuth rows; not sure stays unknown', () => {
    expect(sponsorshipToWorkAuth({ US: 'yes', DE: 'not_sure' }, [{ country: 'US', authorized: true, sponsorship: null }])).toEqual([
      { country: 'US', authorized: true, sponsorship: 'now' },
      { country: 'DE', authorized: null, sponsorship: null },
    ]);
    expect(sponsorshipToWorkAuth({}, [])).toBeNull();
  });

  it('student pre-selects internship, everyone else full-time', () => {
    expect(defaultJobTypes('student')).toEqual(['internship']);
    expect(defaultJobTypes('recent_graduate')).toEqual(['full_time']);
  });

  it('seniority suggestions come from the title level, else the years', () => {
    expect(seedSeniorityToLevels('senior', 3)).toEqual(['senior']);
    expect(seedSeniorityToLevels('vp', null)).toEqual(['director_plus']);
    expect(seedSeniorityToLevels('ic', 1)).toEqual(['entry']);
    expect(seedSeniorityToLevels('ic', 3)).toEqual(['mid']);
    expect(seedSeniorityToLevels(null, null)).toEqual([]);
  });

  it('only confident taxonomy matches are suggested; skills are deduped and capped', () => {
    expect(titlesToTaxonomyIds(['Backend Engineer', 'Zxqv blorp'])).toEqual(['backend_engineer']);
    expect(parsedResumeSkills({ skills: ['Go', 'go', { name: 'SQL' }, 3] })).toEqual(['Go', 'SQL']);
    expect(parsedResumeSkills({ skills: { languages: ['Rust'], tools: ['Git'] } })).toEqual(['Rust', 'Git']);
    expect(parsedResumeSkills(null)).toEqual([]);
  });
});

// ── Market snapshot (D3) ────────────────────────────────────────────────

interface JobRow extends SnapshotRow {
  market: string;
  visibility: string;
  isCanonical: boolean;
  archivedAt: Date | null;
  taxonomyIds: string[];
  locationCountry: string | null;
  locationCity: string | null;
  postedAt: Date | null;
  createdAt: Date;
}

const NOW = new Date('2026-10-10T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    market: 'intl',
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    locationCountry: 'US',
    locationCity: 'Austin',
    postedAt: day(3),
    createdAt: day(3),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryDisclosed: false,
    skills: ['go', 'sql'],
    ...over,
  };
}

/** Evaluates exactly the `where` snapshotWhere builds. */
function matches(r: JobRow, w: ReturnType<typeof snapshotWhere>): boolean {
  if (r.market !== w.market || r.visibility !== w.visibility || r.isCanonical !== w.isCanonical || r.archivedAt !== null) return false;
  if (!r.taxonomyIds.includes(w.taxonomyIds.has)) return false;
  if (r.locationCountry !== w.locationCountry) return false;
  if ('locationCity' in w && w.locationCity && (r.locationCity ?? '').toLowerCase() !== w.locationCity.equals.toLowerCase()) return false;
  const since = (w.OR[0] as { postedAt: { gte: Date } }).postedAt.gte;
  return r.postedAt ? r.postedAt >= since : r.createdAt >= since;
}

function fakeDb(rows: JobRow[]): SnapshotDb & { calls: number } {
  const db = {
    calls: 0,
    rAJob: {
      async count({ where }: { where: ReturnType<typeof snapshotWhere> | ReturnType<typeof payListedWhere> }) {
        db.calls++;
        if ('AND' in where) {
          // payListedWhere: the base predicate plus "lists pay".
          return rows.filter(
            (r) =>
              matches(r, where.AND[0]) &&
              r.salaryDisclosed &&
              r.salaryCurrency !== null &&
              ['year', 'month', 'hour'].includes(r.salaryPeriod ?? '') &&
              (r.salaryMin !== null || r.salaryMax !== null),
          ).length;
        }
        return rows.filter((r) => matches(r, where)).length;
      },
      async findMany({ where, take }: { where: ReturnType<typeof snapshotWhere>; take: number }) {
        return rows.filter((r) => matches(r, where)).slice(0, take);
      },
    },
  };
  return db as SnapshotDb & { calls: number };
}

const paid = (n: number, over: Partial<JobRow> = {}) =>
  Array.from({ length: n }, (_, i) => job({ salaryDisclosed: true, salaryMin: 100_000 + i * 1000, salaryMax: 140_000 + i * 1000, salaryCurrency: 'USD', salaryPeriod: 'year', ...over }));

describe('market snapshot', () => {
  const q = { market: 'intl' as const, taxonomyId: 'backend_engineer', country: 'US' };

  it('ignores a planted private imported job, other markets, archived, duplicates and old rows', async () => {
    const rows = [
      job(),
      job({ visibility: 'private' }), // a user's import
      job({ market: 'cn' }),
      job({ archivedAt: day(1) }),
      job({ isCanonical: false }),
      job({ postedAt: day(45), createdAt: day(45) }),
      job({ postedAt: null, createdAt: day(2) }),
    ];
    const snap = await createSnapshotLoader(async () => fakeDb(rows), () => NOW)(q);
    expect(snap.jobCount).toEqual({ value: 2, source: 'index', sampleSize: 2, asOf: NOW.toISOString() });
    expect(snap.windowDays).toBe(30);
  });

  it('suppresses pay below 20 pay-listing rows and skills below N=20', async () => {
    const snap = await createSnapshotLoader(async () => fakeDb([...paid(19), ...Array.from({ length: 5 }, () => job())]), () => NOW)(q);
    expect(snap.jobCount.value).toBe(24);
    expect(snap.pay).toBeNull();
    expect(snap.topSkills.length).toBeGreaterThan(0); // N = 24 ≥ 20
    const small = computeSnapshot(5, paid(5), NOW);
    expect(small.pay).toBeNull();
    expect(small.topSkills).toEqual([]);
  });

  it('shows the middle of the listed ranges at ≥20 rows, never mixing currencies or periods', async () => {
    const rows = [...paid(20), ...paid(25, { salaryCurrency: 'CAD' }).slice(0, 5), ...paid(3, { salaryPeriod: 'hour', salaryMin: 50, salaryMax: 70 })];
    const snap = computeSnapshot(rows.length, rows, NOW);
    expect(snap.pay).toMatchObject({ currency: 'USD', period: 'year', sampleSize: 20, listedCount: 28, low: 109_500, high: 149_500, source: 'index' });
  });

  it('counts "pay listed on X" exactly when the loaded rows are capped below N', async () => {
    const rows = [...Array.from({ length: 10 }, () => job()), ...paid(25)];
    const snap = await createSnapshotLoader(async () => fakeDb(rows), () => NOW, 10)(q);
    expect(snap.jobCount.value).toBe(35);
    // Only 10 rows were loaded (none listing pay), so pay stays hidden, but X would not be undercounted.
    expect(snap.pay).toBeNull();
    const capped = await createSnapshotLoader(async () => fakeDb([...paid(25), ...Array.from({ length: 10 }, () => job())]), () => NOW, 22)(q);
    expect(capped.pay).toMatchObject({ sampleSize: 22, listedCount: 25 });
  });

  it('is cached for 6 hours', async () => {
    let t = NOW;
    const db = fakeDb([job()]);
    const load = createSnapshotLoader(async () => db, () => t);
    await load(q);
    await load(q);
    expect(db.calls).toBe(1);
    t = new Date(NOW.getTime() + 7 * 3600_000);
    await load(q);
    expect(db.calls).toBe(2);
  });
});

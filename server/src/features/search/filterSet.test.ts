// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CN_ONLY_FIELDS, FILTER_FIELDS, FilterSetV1Schema, INTL_ONLY_FIELDS, type FilterSet } from './contract.js';
import {
  FILTER_FIELD_SPECS,
  coerceFilterSet,
  diffFilterSets,
  filterSetKey,
  includesUndisclosedPay,
  isEmptyFilterSet,
  mergeFilterSet,
  normalizeFilterSet,
  parseFilterSet,
  parseFilterSetPatch,
} from './filterSet.js';

const INTL: FilterSet = {
  taxonomyIds: ['backend_engineer'],
  titles: ['Backend Engineer', 'Platform Engineer'],
  excludedTitles: ['Sales Engineer'],
  jobTypes: ['full_time', 'contract'],
  workModels: ['remote', 'hybrid'],
  country: 'US',
  locations: [{ label: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US', lat: 30.27, lng: -97.74, radiusKm: 40 }],
  seniority: ['mid', 'senior'],
  yearsRange: { min: 2, max: 8 },
  postedWithinDays: 7,
  salaryMin: { amount: 120000, currency: 'USD', period: 'year' },
  includeUndisclosedPay: false,
  needsSponsorship: true,
  excludeRequirements: ['clearance'],
  industries: ['Fintech'],
  excludedIndustries: ['Gaming'],
  skills: ['Go', 'PostgreSQL'],
  excludedSkills: ['PHP'],
  roleType: 'ic',
  companies: ['Stripe'],
  preferredCompanies: ['Ramp'],
  excludedCompanies: ['Acme Staffing'],
  companySizes: ['51-200', '201-1000'],
  excludeAgencies: true,
  recruiterJobsOnly: true,
  fitTier: 'good',
  q: 'payments',
};

const CN: FilterSet = {
  titles: ['后端开发工程师'],
  jobTypes: ['internship'],
  country: 'CN',
  locations: [{ label: '上海', city: '上海', country: 'CN', radiusKm: 0 }],
  salaryMin: { amount: 15000, currency: 'CNY', period: 'month' },
  employerTags: ['soe', 'hukou'],
  classYear: 2027,
  degree: ['bachelor', 'master'],
  employmentType: ['campus', 'internship'],
  internDays: { min: 3, max: 5 },
  dailyPay: { min: 200 },
  salaryMonthsMin: 13,
  hukouTag: true,
  schoolTiers: ['985', '211'],
  fitTier: 'all',
};

describe('FilterSet v1 contract', () => {
  it('round-trips every field through JSON (intl and cn)', () => {
    const intl = parseFilterSet(JSON.parse(JSON.stringify(INTL)), { market: 'intl' });
    expect(intl).toEqual({ ok: true, value: INTL, dropped: [] });
    const cn = parseFilterSet(JSON.parse(JSON.stringify(CN)), { market: 'cn' });
    expect(cn).toEqual({ ok: true, value: CN, dropped: [] });
    // Together the two fixtures exercise every schema field.
    expect(new Set([...Object.keys(INTL), ...Object.keys(CN)])).toEqual(new Set(FILTER_FIELDS));
  });

  it('accepts the empty set (absence means any)', () => {
    expect(parseFilterSet({}, { market: 'intl' })).toEqual({ ok: true, value: {}, dropped: [] });
    expect(isEmptyFilterSet({ titles: [], q: '  ' } as FilterSet)).toBe(true);
  });

  it('rejects unknown keys, bad enums, bad codes and inverted ranges', () => {
    const bad = [
      { nope: 1 },
      { jobTypes: ['freelance'] },
      { country: 'usa' },
      { locations: [{ label: 'X', radiusKm: 10 }] },
      { yearsRange: { min: 9, max: 2 } },
      { postedWithinDays: 2 },
      { salaryMin: { amount: 1, currency: 'usd', period: 'year' } },
      { companySizes: ['1–10'] },
      'not an object',
    ];
    for (const input of bad) {
      const r = parseFilterSet(input, { market: 'intl' });
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
  });

  it('accepts the task-plan shorthand names and renames them', () => {
    const r = parseFilterSet(
      { industriesInclude: ['AI / ML'], industriesExclude: ['Gaming'], includeOnlyCompanies: ['OpenAI'], companySize: ['11-50'] },
      { market: 'intl' },
    );
    expect(r).toEqual({ ok: true, dropped: [], value: { industries: ['AI / ML'], excludedIndustries: ['Gaming'], companies: ['OpenAI'], companySizes: ['11-50'] } });
  });

  it('drops the other market fields and reports them', () => {
    const r = parseFilterSet({ titles: ['x'], classYear: 2027, needsSponsorship: true }, { market: 'intl' });
    expect(r).toEqual({ ok: true, value: { titles: ['x'], needsSponsorship: true }, dropped: ['classYear'] });
    const c = parseFilterSet({ titles: ['x'], classYear: 2027, needsSponsorship: true }, { market: 'cn' });
    expect(c).toEqual({ ok: true, value: { titles: ['x'], classYear: 2027 }, dropped: ['needsSponsorship'] });
  });

  it('defaults includeUndisclosedPay to true', () => {
    expect(includesUndisclosedPay({})).toBe(true);
    expect(includesUndisclosedPay({ includeUndisclosedPay: false })).toBe(false);
  });
});

describe('coerceFilterSet (stored rows)', () => {
  it('keeps valid fields and drops the rest', () => {
    const r = coerceFilterSet({ titles: ['A'], jobTypes: ['bogus'], legacy: true, workModels: ['remote'] }, { market: 'intl' });
    expect(r.value).toEqual({ titles: ['A'], workModels: ['remote'] });
    expect(r.dropped.sort()).toEqual(['jobTypes', 'legacy']);
    expect(coerceFilterSet(null, { market: 'cn' })).toEqual({ value: {}, dropped: [] });
    expect(coerceFilterSet('x', { market: 'cn' }).dropped).toEqual(['<root>']);
  });
});

describe('normalize, merge, diff, key', () => {
  it('normalizes: trims, de-duplicates case-insensitively, drops empties, keeps order', () => {
    expect(normalizeFilterSet({ titles: [' Designer ', 'designer', 'PM'], skills: [], q: ' x ' })).toEqual({ titles: ['Designer', 'PM'], q: 'x' });
  });

  it('merges a patch: value replaces, null clears, absent keeps', () => {
    const patch = parseFilterSetPatch({ workModels: ['onsite'], salaryMin: null, industriesInclude: ['Climate'] });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const merged = mergeFilterSet(INTL, patch.value);
    expect(merged.workModels).toEqual(['onsite']);
    expect(merged.salaryMin).toBeUndefined();
    expect(merged.industries).toEqual(['Climate']);
    expect(merged.titles).toEqual(INTL.titles);
    expect(parseFilterSetPatch({ workModels: ['moon'] }).ok).toBe(false);
    expect(parseFilterSetPatch({ unknown: null }).ok).toBe(false);
  });

  it('diffs field by field (FilterDiff)', () => {
    const after: FilterSet = { ...INTL, excludedCompanies: ['Acme Staffing', 'Initech'], titles: ['Platform Engineer'], salaryMin: undefined, classYear: undefined, fitTier: 'great' };
    const changes = diffFilterSets(INTL, after);
    expect(changes).toEqual([
      { field: 'titles', kind: 'changed', addedItems: [], removedItems: ['Backend Engineer'] },
      { field: 'salaryMin', kind: 'removed', from: INTL.salaryMin, to: undefined },
      { field: 'excludedCompanies', kind: 'changed', addedItems: ['Initech'], removedItems: [] },
      { field: 'fitTier', kind: 'changed', from: 'good', to: 'great' },
    ]);
    expect(diffFilterSets({ titles: ['a', 'b'] }, { titles: ['b', 'a'] })).toEqual([]);
    expect(diffFilterSets({}, { skills: ['Go'] })).toEqual([{ field: 'skills', kind: 'added', addedItems: ['Go'], removedItems: [] }]);
  });

  it('gives a stable key independent of key order', () => {
    expect(filterSetKey({ q: 'a', titles: ['x'] })).toBe(filterSetKey({ titles: ['x'], q: 'a' }));
    expect(filterSetKey({ titles: ['x'] })).not.toBe(filterSetKey({ titles: ['y'] }));
  });
});

describe('field specs', () => {
  it('describes every schema field, with markets matching the market-only lists', () => {
    expect(Object.keys(FILTER_FIELD_SPECS).sort()).toEqual(Object.keys(FilterSetV1Schema.shape).sort());
    for (const f of FILTER_FIELDS) {
      const markets = FILTER_FIELD_SPECS[f].markets;
      if (CN_ONLY_FIELDS.includes(f)) expect(markets, f).toEqual(['cn']);
      else if (INTL_ONLY_FIELDS.includes(f)) expect(markets, f).toEqual(['intl']);
      else expect(markets, f).toEqual(['intl', 'cn']);
    }
    expect(FILTER_FIELD_SPECS.schoolTiers.predicate).toMatch(/never a ranking input/);
    expect(FILTER_FIELD_SPECS.recruiterJobsOnly.predicate).toMatch(/free on every plan/);
  });
});

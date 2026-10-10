import { describe, expect, it } from 'vitest';

import {
  CN_ONLY_FIELDS,
  FIELD_ORDER,
  INTL_ONLY_FIELDS,
  SCHOOL_TIERS,
  activeFilterCount,
  classYearOptions,
  diffFilters,
  distanceUnitFor,
  filtersKey,
  hiddenFieldsFor,
  isCountryWideLocation,
  mergePatch,
  normalizeFilters,
  onlyListedPay,
  patchBetween,
  radiusInUnit,
  sameFilters,
  sponsorshipCountry,
  workAuthWithSponsorship,
  type FilterSet,
} from './filterModel';
import { withoutUnchangedSearchKeys } from './keys';
import { localizedTaxonomyLabels, readableTaxonomyId } from './useFilterQueries';
import stagedTaxonomy from '../../i18n/staging/taxonomy.en.json';
import taxonomyV1 from '../../server/src/features/jobs/taxonomy/taxonomy.v1.json';

describe('field lists', () => {
  it('cover every FilterSet field once, with the market-only sets', () => {
    expect(new Set(FIELD_ORDER).size).toBe(FIELD_ORDER.length);
    expect(FIELD_ORDER).toContain('salaryMonthsMin');
    expect(CN_ONLY_FIELDS).toEqual(['employerTags', 'classYear', 'degree', 'employmentType', 'internDays', 'dailyPay', 'salaryMonthsMin', 'hukouTag', 'schoolTiers']);
    expect(hiddenFieldsFor('cn')).toEqual(INTL_ONLY_FIELDS);
    expect(hiddenFieldsFor('intl')).toEqual(CN_ONLY_FIELDS);
    expect([...SCHOOL_TIERS].sort()).toEqual(['211', '985', 'double_first_class']);
  });
});

describe('normalize / merge / patch / diff', () => {
  const base: FilterSet = { titles: ['Analyst', ' analyst ', 'BI'], skills: [], q: '  ', workModels: ['remote'] };

  it('normalizes: trims, de-duplicates case-insensitively, drops empties', () => {
    expect(normalizeFilters(base)).toEqual({ titles: ['Analyst', 'BI'], workModels: ['remote'] });
    expect(sameFilters(base, { workModels: ['remote'], titles: ['Analyst', 'BI'] })).toBe(true);
    expect(filtersKey({ a: 1, b: 2 } as never)).toBe(filtersKey({ b: 2, a: 1 } as never));
  });

  it('merges a patch (value replaces, null clears) and computes the patch between two sets', () => {
    const merged = mergePatch(base, { workModels: null, skills: ['SQL'] });
    expect(merged).toEqual({ titles: ['Analyst', 'BI'], skills: ['SQL'] });
    expect(patchBetween(base, merged)).toEqual({ workModels: null, skills: ['SQL'] });
    expect(patchBetween(merged, merged)).toEqual({});
  });

  it('diffs field by field with list additions and removals', () => {
    const changes = diffFilters(
      { titles: ['A', 'B'], salaryMin: { amount: 1, currency: 'USD', period: 'year' }, recruiterJobsOnly: true },
      { titles: ['B', 'C'], salaryMin: { amount: 2, currency: 'USD', period: 'year' }, excludedSkills: ['PHP'] },
    );
    expect(changes).toEqual([
      { field: 'titles', kind: 'changed', addedItems: ['C'], removedItems: ['A'] },
      { field: 'salaryMin', kind: 'changed', from: { amount: 1, currency: 'USD', period: 'year' }, to: { amount: 2, currency: 'USD', period: 'year' } },
      { field: 'excludedSkills', kind: 'added', addedItems: ['PHP'], removedItems: [] },
      { field: 'recruiterJobsOnly', kind: 'removed', from: true, to: undefined },
    ]);
    expect(diffFilters({ titles: ['A', 'B'] }, { titles: ['B', 'A'] })).toEqual([]);
  });

  it('counts narrowing filters only ("Only jobs that list pay" off by default)', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(onlyListedPay({})).toBe(false);
    expect(activeFilterCount({ includeUndisclosedPay: true, fitTier: 'great', preferredCompanies: ['X'], q: 'x' })).toBe(0);
    expect(activeFilterCount({ includeUndisclosedPay: false, titles: ['A', 'B'], recruiterJobsOnly: true })).toBe(3);
  });
});

describe('radius units by country', () => {
  it('uses miles in the US and UK, km elsewhere, with round steps', () => {
    expect(distanceUnitFor('US')).toBe('mi');
    expect(distanceUnitFor('gb')).toBe('mi');
    expect(distanceUnitFor('TW')).toBe('km');
    expect(distanceUnitFor(undefined)).toBe('km');
    expect([0, 8, 40, 80, 160].map((km) => radiusInUnit(km as 0, 'mi'))).toEqual([0, 5, 25, 50, 100]);
    expect(radiusInUnit(40, 'km')).toBe(40);
  });
});

describe('sponsorship (TW-09)', () => {
  it('asks about the filter country, else a location country, else the brand default', () => {
    expect(sponsorshipCountry({ country: 'tw' }, 'US')).toBe('TW');
    expect(sponsorshipCountry({ locations: [{ label: 'London', country: 'GB', radiusKm: 0 }] }, 'US')).toBe('GB');
    expect(sponsorshipCountry({}, 'US')).toBe('US');
  });

  it('updates only that country’s sponsorship answer and keeps `authorized`', () => {
    const entries = [{ country: 'US', authorized: false, sponsorship: 'later' as const }];
    expect(workAuthWithSponsorship(entries, 'us', true)).toEqual([{ country: 'US', authorized: false, sponsorship: 'now' }]);
    expect(workAuthWithSponsorship(entries, 'TW', false)).toEqual([...entries, { country: 'TW', authorized: null, sponsorship: 'no' }]);
  });
});

describe('class years and stale-draft guard', () => {
  it('offers last year through four years ahead', () => {
    expect(classYearOptions(new Date('2026-10-10'))).toEqual([2025, 2026, 2027, 2028, 2029, 2030]);
  });

  it('drops search-backed keys a preferences draft sends back unchanged', () => {
    const server = { roleTitles: ['A'], cities: ['X'], digest: 'daily' };
    expect(withoutUnchangedSearchKeys({ roleTitles: ['A'], cities: ['Y'], digest: 'weekly' }, server)).toEqual({ cities: ['Y'], digest: 'weekly' });
    expect(withoutUnchangedSearchKeys({ roleTitles: ['A'] }, null)).toEqual({ roleTitles: ['A'] });
  });
});

// FIX-3: job-function names in the UI language (the server's tree has English and Simplified Chinese only).
describe('localizedTaxonomyLabels', () => {
  const nodes = [
    { id: 'software_engineering', label: 'Software engineering' },
    { id: 'swe_backend', label: 'Backend and platform' },
    { id: 'data_scientist', label: 'Data scientist' },
    { id: 'ux_designer', label: 'UX designer' },
  ];
  const messages = {
    categories: { software_engineering: 'ソフトウェアエンジニアリング' },
    groups: { swe_backend: 'バックエンド／プラットフォーム' },
    roles: { data_scientist: 'データサイエンティスト', not_a_node: '—', ux_designer: '  ' },
  };

  it('takes the translated names where the bundle has them and the server name elsewhere', () => {
    const ja = localizedTaxonomyLabels(nodes, 'ja', messages);
    expect(ja.get('software_engineering')).toBe('ソフトウェアエンジニアリング');
    expect(ja.get('swe_backend')).toBe('バックエンド／プラットフォーム');
    expect(ja.get('data_scientist')).toBe('データサイエンティスト');
    expect(ja.get('ux_designer')).toBe('UX designer'); // an empty translation is not a name
    expect(ja.has('not_a_node')).toBe(false);
  });

  it('English and Simplified Chinese keep the server\'s own curated names', () => {
    expect(localizedTaxonomyLabels(nodes, 'en', messages).get('swe_backend')).toBe('Backend and platform');
    const zhNodes = [{ id: 'swe_backend', label: '后端与平台' }];
    expect(localizedTaxonomyLabels(zhNodes, 'zh', { groups: { swe_backend: 'Backend and platform' } }).get('swe_backend')).toBe('后端与平台');
    expect(localizedTaxonomyLabels(nodes, 'zh-TW', null).get('data_scientist')).toBe('Data scientist');
  });

  it('an id nobody has a name for is made readable, never shown raw', () => {
    expect(readableTaxonomyId('swe_backend')).toBe('Swe backend');
    expect(readableTaxonomyId('data_scientist')).toBe('Data scientist');
  });

  it('every role of the taxonomy is staged for translation, with the taxonomy\'s own English name', () => {
    const staged = (stagedTaxonomy as { taxonomy: { roles: Record<string, string> } }).taxonomy.roles;
    const roles = (taxonomyV1 as { nodes: Array<{ id: string; level: number; en: string }> }).nodes.filter((n) => n.level === 3);
    expect(Object.keys(staged).sort()).toEqual(roles.map((r) => r.id).sort());
    for (const r of roles) expect(staged[r.id], r.id).toBe(r.en);
  });
});

describe('country-wide locations', () => {
  it('a country with no city is the whole country; a city, or a label that is not the country, is not', () => {
    expect(isCountryWideLocation({ label: 'US', country: 'US', radiusKm: 0 })).toBe(true);
    expect(isCountryWideLocation({ label: 'United States', country: 'US', radiusKm: 40 })).toBe(true);
    expect(isCountryWideLocation({ label: 'Anywhere in United States', country: 'US', radiusKm: 0 })).toBe(true);
    expect(isCountryWideLocation({ label: 'Austin', country: 'US', radiusKm: 0 })).toBe(false);
    expect(isCountryWideLocation({ label: 'US', city: 'Austin', country: 'US', radiusKm: 0 })).toBe(false);
    expect(isCountryWideLocation({ label: 'US', country: 'US', lat: 1, lng: 2, radiusKm: 40 })).toBe(false);
    expect(isCountryWideLocation({ label: 'Berlin', radiusKm: 0 })).toBe(false);
  });

  it('diffFilters treats an off toggle as no filter (only includeUndisclosedPay: false filters)', () => {
    expect(diffFilters({}, { needsSponsorship: false, excludeAgencies: false })).toEqual([]);
    expect(diffFilters({}, { includeUndisclosedPay: false })).toEqual([{ field: 'includeUndisclosedPay', kind: 'added', from: undefined, to: false }]);
    expect(diffFilters({ needsSponsorship: true }, { needsSponsorship: false })).toEqual([{ field: 'needsSponsorship', kind: 'removed', from: true, to: undefined }]);
  });
});

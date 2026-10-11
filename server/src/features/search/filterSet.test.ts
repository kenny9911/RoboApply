// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diffForOps, type FilterOp } from '../copilot/tools/filters.js';
import type { CopilotAreas } from '../copilot/types.js';
import { WORK_SHIFTS } from '../jobs/normalize/index.js';
import { CN_ONLY_FIELDS, FILTER_FIELDS, FilterSetV1Schema, INTL_ONLY_FIELDS, TAIWAN_ONLY_FIELDS, TW_DISTRICTS_MAX, WORK_SHIFT_FILTERS, type FilterSet, type SearchProfileWire } from './contract.js';
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

/** A RoboApply search in Taiwan (JT-7): the two Taiwan-only fields live here. */
const TW: FilterSet = {
  titles: ['門市人員'],
  locations: [{ label: '新竹縣', city: '新竹縣', radiusKm: 40 }],
  twDistricts: ['新竹縣竹北市', '台北市信義區'],
  workShifts: ['rotating', 'night'],
};

describe('FilterSet v1 contract', () => {
  it('round-trips every field through JSON (intl, a search in Taiwan, and cn)', () => {
    const intl = parseFilterSet(JSON.parse(JSON.stringify(INTL)), { market: 'intl' });
    expect(intl).toEqual({ ok: true, value: INTL, dropped: [], droppedForPlace: [] });
    const tw = parseFilterSet(JSON.parse(JSON.stringify(TW)), { market: 'intl' });
    expect(tw).toEqual({ ok: true, value: TW, dropped: [], droppedForPlace: [] });
    const cn = parseFilterSet(JSON.parse(JSON.stringify(CN)), { market: 'cn' });
    expect(cn).toEqual({ ok: true, value: CN, dropped: [], droppedForPlace: [] });
    // Together the three fixtures exercise every schema field.
    expect(new Set([...Object.keys(INTL), ...Object.keys(TW), ...Object.keys(CN)])).toEqual(new Set(FILTER_FIELDS));
  });

  it('accepts the empty set (absence means any)', () => {
    expect(parseFilterSet({}, { market: 'intl' })).toEqual({ ok: true, value: {}, dropped: [], droppedForPlace: [] });
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
    expect(r).toEqual({ ok: true, dropped: [], droppedForPlace: [], value: { industries: ['AI / ML'], excludedIndustries: ['Gaming'], companies: ['OpenAI'], companySizes: ['11-50'] } });
  });

  it('drops the other market fields and reports them', () => {
    const r = parseFilterSet({ titles: ['x'], classYear: 2027, needsSponsorship: true }, { market: 'intl' });
    expect(r).toEqual({ ok: true, value: { titles: ['x'], needsSponsorship: true }, dropped: ['classYear'], droppedForPlace: [] });
    const c = parseFilterSet({ titles: ['x'], classYear: 2027, needsSponsorship: true }, { market: 'cn' });
    expect(c).toEqual({ ok: true, value: { titles: ['x'], classYear: 2027 }, dropped: ['needsSponsorship'], droppedForPlace: [] });
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
    expect(coerceFilterSet(null, { market: 'cn' })).toEqual({ value: {}, dropped: [], droppedForPlace: [] });
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

describe('MKT-5F JT-7: district and shift filters, for searches in Taiwan only', () => {
  const taipei = { label: '台北市', city: '台北市', radiusKm: 40 as const };

  it('the contract: both fields are RoboApply-only and Taiwan-only, and the shift values are the ones a job row can hold', () => {
    expect(TAIWAN_ONLY_FIELDS).toEqual(['twDistricts', 'workShifts']);
    for (const f of TAIWAN_ONLY_FIELDS) {
      expect(INTL_ONLY_FIELDS, f).toContain(f);
      expect(CN_ONLY_FIELDS, f).not.toContain(f);
      expect(FILTER_FIELD_SPECS[f]).toMatchObject({ section: 'basic', markets: ['intl'] });
      expect(FILTER_FIELD_SPECS[f].predicate).toMatch(/Taiwan searches only/);
      expect(FILTER_FIELD_SPECS[f].predicate).toMatch(/never passes/);
    }
    expect([...WORK_SHIFT_FILTERS]).toEqual([...WORK_SHIFTS]);
    expect(TW_DISTRICTS_MAX).toBe(20);
    // Appended after every earlier field, so the order of the earlier predicates is what it was.
    expect(FILTER_FIELDS.slice(-2)).toEqual(['twDistricts', 'workShifts']);
  });

  it('ACCEPT: a saved search in Taiwan keeps the two fields, through the strict parser and the stored-row reader', () => {
    const parsed = parseFilterSet({ locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['rotating'] }, { market: 'intl' });
    expect(parsed).toEqual({ ok: true, value: { locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['rotating'] }, dropped: [], droppedForPlace: [] });
    const stored = coerceFilterSet(JSON.parse(JSON.stringify(parsed.ok ? parsed.value : {})), { market: 'intl' });
    expect(stored).toEqual({ value: { locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['rotating'] }, dropped: [], droppedForPlace: [] });
    // By country alone, with no place.
    expect(parseFilterSet({ country: 'TW', twDistricts: ['新竹縣竹北市'], workShifts: ['day'] }, { market: 'intl' })).toEqual({ ok: true, value: { country: 'TW', twDistricts: ['新竹縣竹北市'], workShifts: ['day'] }, dropped: [], droppedForPlace: [] });
    // A place that says it is in Taiwan, or an English name of a Taiwanese city.
    for (const location of [{ label: 'Anywhere', country: 'TW', radiusKm: 0 as const }, { label: 'Taipei, Taiwan', city: 'Taipei, Taiwan', radiusKm: 40 as const }, { label: 'Hsinchu County', radiusKm: 8 as const }]) {
      const r = parseFilterSet({ locations: [location], workShifts: ['part_time'] }, { market: 'intl' });
      expect(r.ok && r.value.workShifts, location.label).toEqual(['part_time']);
    }
  });

  it('ACCEPT: coerced away for GoApply, whatever the search says', () => {
    const input = { country: 'TW', locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['rotating'], titles: ['x'] };
    expect(parseFilterSet(input, { market: 'cn' })).toEqual({ ok: true, value: { country: 'TW', locations: [taipei], titles: ['x'] }, dropped: ['twDistricts', 'workShifts'], droppedForPlace: [] });
    const stored = coerceFilterSet(input, { market: 'cn' });
    expect(stored.value).toEqual({ country: 'TW', locations: [taipei], titles: ['x'] });
    expect(stored.dropped).toEqual(['twDistricts', 'workShifts']);
    // GoApply never validates them either: a value that names no district is simply not kept.
    expect(parseFilterSet({ country: 'TW', twDistricts: ['不是一個區'] }, { market: 'cn' })).toEqual({ ok: true, value: { country: 'TW' }, dropped: ['twDistricts'], droppedForPlace: [] });
  });

  it('ACCEPT: ignored unless the search is in Taiwan: a United States search, a search with no place and a place that states another country drop both', () => {
    for (const search of [
      { country: 'US' },
      { country: 'US', locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', radiusKm: 40 }] },
      { locations: [{ label: 'Tokyo', radiusKm: 0 }] },
      { locations: [{ label: 'Taipei', country: 'US', radiusKm: 0 }] },
      {},
    ]) {
      const input = { ...search, titles: ['x'], twDistricts: ['台北市信義區'], workShifts: ['rotating'] };
      const parsed = parseFilterSet(input, { market: 'intl' });
      expect(parsed, JSON.stringify(search)).toEqual({ ok: true, value: { ...search, titles: ['x'] }, dropped: [], droppedForPlace: ['twDistricts', 'workShifts'] });
      const stored = coerceFilterSet(input, { market: 'intl' });
      expect(stored.value, JSON.stringify(search)).toEqual({ ...search, titles: ['x'] });
      expect(stored.dropped).toEqual([]);
      expect(stored.droppedForPlace).toEqual(['twDistricts', 'workShifts']);
      // Outside Taiwan the value is not even read: junk is dropped with the field, never an error.
      expect(parseFilterSet({ ...search, twDistricts: ['nowhere'] }, { market: 'intl' })).toEqual({ ok: true, value: search, dropped: [], droppedForPlace: ['twDistricts'] });
    }
  });

  it('removing Taiwan from a saved search takes the two fields with it (a patch goes through the same rule)', () => {
    const before: FilterSet = { country: 'TW', twDistricts: ['台北市信義區'], workShifts: ['night'], titles: ['x'] };
    const patch = parseFilterSetPatch({ country: 'US' });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    expect(parseFilterSet(mergeFilterSet(before, patch.value), { market: 'intl' })).toEqual({ ok: true, value: { country: 'US', titles: ['x'] }, dropped: [], droppedForPlace: ['twDistricts', 'workShifts'] });
    // And a patch can set and clear them like any other field.
    const set = parseFilterSetPatch({ twDistricts: ['新竹縣竹北市'], workShifts: null });
    expect(set.ok && mergeFilterSet(before, set.value)).toEqual({ country: 'TW', twDistricts: ['新竹縣竹北市'], titles: ['x'] });
  });

  it('review finding: `dropped` names fields of the other market only; a search that leaves Taiwan reports the two fields apart, so no caller reads it as "this site has no such filter"', () => {
    const tw: FilterSet = { locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['day'], needsSponsorship: true };
    const moved = parseFilterSet({ ...tw, locations: [{ label: 'Tokyo', radiusKm: 0 }] }, { market: 'intl' });
    expect(moved).toEqual({ ok: true, value: { locations: [{ label: 'Tokyo', radiusKm: 0 }], needsSponsorship: true }, dropped: [], droppedForPlace: ['twDistricts', 'workShifts'] });
    // GoApply: they are fields of the other market, whatever the place (the market rule runs first), and never both reports.
    for (const search of [{ locations: [taipei] }, { country: 'US' }]) {
      const cn = parseFilterSet({ ...search, twDistricts: ['台北市信義區'], workShifts: ['day'], needsSponsorship: true }, { market: 'cn' });
      expect(cn).toEqual({ ok: true, value: search, dropped: ['needsSponsorship', 'twDistricts', 'workShifts'], droppedForPlace: [] });
    }
    // A search in Taiwan reports nothing.
    expect(parseFilterSet(tw, { market: 'intl' })).toMatchObject({ ok: true, dropped: [], droppedForPlace: [] });
  });

  it('review finding: the Assistant can move a Taiwan search with a district and a shift out of Taiwan; the change list shows the two filters as removed', async () => {
    const counted: FilterSet[] = [];
    const areas = {
      countForFilters: async (_userId: string, filters: FilterSet) => {
        counted.push(filters);
        return { count: 7, capped: false };
      },
    } as unknown as CopilotAreas;
    const profile: SearchProfileWire = {
      id: 'sp_1',
      name: '',
      isDefault: true,
      isActive: true,
      version: 3,
      schemaVersion: 1,
      filters: { titles: ['門市人員'], locations: [taipei], twDistricts: ['台北市信義區'], workShifts: ['day'] },
      alertInstantMax: 0,
      alertDigest: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const tokyo = { label: 'Tokyo', radiusKm: 0 };
    const cases: Array<{ name: string; ops: FilterOp[]; place: Partial<FilterSet> }> = [
      { name: 'set locations to Tokyo', ops: [{ op: 'set', path: 'locations', value: [tokyo] }], place: { locations: [tokyo] } },
      { name: 'clear locations and set country US', ops: [{ op: 'set', path: 'locations', value: null }, { op: 'set', path: 'country', value: 'US' }], place: { country: 'US' } },
    ];
    for (const c of cases) {
      const res = await diffForOps(areas, 'u1', profile, c.ops, 'intl');
      expect(res.ok, c.name).toBe(true);
      if (!res.ok) continue;
      expect(res.diff.after, c.name).toEqual({ titles: ['門市人員'], ...c.place });
      const removed = res.diff.changes.filter((ch) => ch.kind === 'removed').map((ch) => ch.field);
      expect(removed, c.name).toEqual(expect.arrayContaining(['twDistricts', 'workShifts']));
      expect(res.diff.changes.find((ch) => ch.field === 'twDistricts'), c.name).toMatchObject({ kind: 'removed', removedItems: ['台北市信義區'] });
      expect(res.diff.changes.find((ch) => ch.field === 'workShifts'), c.name).toMatchObject({ kind: 'removed', removedItems: ['day'] });
      // The count after is taken for the search as it will be stored: without the two fields.
      expect(counted.at(-1), c.name).toEqual(res.diff.after);
    }
    // A change that keeps the search in Taiwan keeps both, and names neither as changed.
    const stays = await diffForOps(areas, 'u1', profile, [{ op: 'add', path: 'locations', value: { label: '新竹縣', city: '新竹縣', radiusKm: 40 } }], 'intl');
    expect(stays.ok && stays.diff.after.twDistricts).toEqual(['台北市信義區']);
    expect(stays.ok && stays.diff.changes.map((ch) => ch.field)).toEqual(['locations']);
    // A field of the OTHER market is still refused with the message that is true for it.
    const cnOnly = await diffForOps(areas, 'u1', profile, [{ op: 'set', path: 'classYear', value: 2027 }], 'intl');
    expect(cnOnly).toEqual({ ok: false, issues: [{ path: 'classYear', message: 'not available on this site' }] });
    // And on GoApply the two Taiwan fields are that: fields of the other market.
    const onCn = await diffForOps(areas, 'u1', { ...profile, filters: { titles: ['x'] } }, [{ op: 'set', path: 'workShifts', value: ['day'] }], 'cn');
    expect(onCn).toEqual({ ok: false, issues: [{ path: 'workShifts', message: 'not available on this site' }] });
  });

  it('a district is stored as <county><district> in the table\'s spelling; a bare name is completed only when one county alone has it', () => {
    const parsed = parseFilterSet({ country: 'TW', twDistricts: ['臺北市士林區', '竹北市', ' 台中市西屯區 ', '新竹縣竹北市', '臺北市士林區'] }, { market: 'intl' });
    expect(parsed).toEqual({ ok: true, value: { country: 'TW', twDistricts: ['台北市士林區', '新竹縣竹北市', '台中市西屯區'] }, dropped: [], droppedForPlace: [] });
  });

  it('a value that names no district of the table is refused by the strict parser, with its index; a stored row just loses it', () => {
    for (const bad of ['東區', '信義區', '台中市', '台中市不限', 'Neihu', '台北市某某區', '上海市静安区']) {
      const r = parseFilterSet({ country: 'TW', twDistricts: ['新竹縣竹北市', bad] }, { market: 'intl' });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.issues).toEqual([{ path: 'twDistricts.1', message: expect.stringContaining('not a district of Taiwan') }]);
      expect(coerceFilterSet({ country: 'TW', twDistricts: ['新竹縣竹北市', bad] }, { market: 'intl' })).toEqual({ value: { country: 'TW', twDistricts: ['新竹縣竹北市'] }, dropped: [], droppedForPlace: [] });
    }
    // Nothing valid left: the field goes, and the reader says so.
    expect(coerceFilterSet({ country: 'TW', twDistricts: ['東區', 'Neihu'], workShifts: ['day'] }, { market: 'intl' })).toEqual({ value: { country: 'TW', workShifts: ['day'] }, dropped: ['twDistricts'], droppedForPlace: [] });
  });

  it('refuses a shift that is not one of the five, more than 20 districts, and anything that is not a list of names', () => {
    for (const bad of [
      { country: 'TW', workShifts: ['graveyard'] },
      { country: 'TW', workShifts: ['日班'] },
      { country: 'TW', workShifts: 'night' },
      { country: 'TW', workShifts: ['day', 'evening', 'night', 'rotating', 'part_time', 'day'] },
      { country: 'TW', twDistricts: '新竹縣竹北市' },
      { country: 'TW', twDistricts: [7] },
      { country: 'TW', twDistricts: ['區'.repeat(41)] },
      { country: 'TW', twDistricts: Array.from({ length: 21 }, () => '新竹縣竹北市') },
    ]) {
      expect(parseFilterSet(bad, { market: 'intl' }).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    // The stored-row reader keeps the field that is valid and drops the one that is not.
    expect(coerceFilterSet({ country: 'TW', workShifts: ['graveyard'], twDistricts: ['新竹縣竹北市'] }, { market: 'intl' })).toEqual({ value: { country: 'TW', twDistricts: ['新竹縣竹北市'] }, dropped: ['workShifts'], droppedForPlace: [] });
    expect(parseFilterSet({ country: 'TW', workShifts: ['day', 'evening', 'night', 'rotating', 'part_time'] }, { market: 'intl' }).ok).toBe(true);
  });

  it('diffs and keys them like any other list field', () => {
    const a: FilterSet = { country: 'TW', twDistricts: ['新竹縣竹北市'], workShifts: ['day'] };
    const b: FilterSet = { country: 'TW', twDistricts: ['新竹縣竹北市', '台北市信義區'], workShifts: ['night'] };
    expect(diffFilterSets(a, b)).toEqual([
      { field: 'twDistricts', kind: 'changed', addedItems: ['台北市信義區'], removedItems: [] },
      { field: 'workShifts', kind: 'changed', addedItems: ['night'], removedItems: ['day'] },
    ]);
    expect(filterSetKey(a)).not.toBe(filterSetKey(b));
    expect(filterSetKey(a)).toBe(filterSetKey({ workShifts: ['day'], twDistricts: ['新竹縣竹北市'], country: 'TW' }));
  });
});

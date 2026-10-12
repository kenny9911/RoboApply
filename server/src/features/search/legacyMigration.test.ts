// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FILTER_FIELDS } from './contract.js';
import {
  LEGACY_GOAL_KEYS,
  LEGACY_PREFERENCE_KEYS,
  LEGACY_SAVED_SEARCH_KEYS,
  buildLegacyProfiles,
  filterSetFromLegacyGoal,
  filterSetFromSavedSearch,
} from './legacyMigration.js';

const OPTS = { market: 'intl' as const, currency: 'USD' };

describe('legacy key coverage', () => {
  it('records a disposition for every legacy key, and every mapped target is a FilterSet field', () => {
    for (const table of [LEGACY_PREFERENCE_KEYS, LEGACY_GOAL_KEYS, LEGACY_SAVED_SEARCH_KEYS]) {
      for (const [key, d] of Object.entries(table)) {
        if (d.action === 'mapped') expect(FILTER_FIELDS, key).toContain(d.to);
        else expect(d.note.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('drops the dead agent knobs (ARCH §2.8)', () => {
    for (const k of ['aggressiveness', 'matchThreshold', 'dailyCap', 'quietStart', 'quietEnd', 'autoDecline', 'autoSchedule'] as const) {
      expect(LEGACY_PREFERENCE_KEYS[k].action, k).toBe('dropped');
    }
  });

  it('maps the ARCH migration keys', () => {
    const expected = {
      roleTitles: 'titles',
      workModes: 'workModels',
      cities: 'locations',
      salaryMinK: 'salaryMin',
      employmentTypes: 'jobTypes',
      industriesTarget: 'industries',
      industriesAvoid: 'excludedIndustries',
      targetCompanies: 'preferredCompanies',
      blockedCompanies: 'excludedCompanies',
    } as const;
    for (const [k, to] of Object.entries(expected)) expect(LEGACY_PREFERENCE_KEYS[k as keyof typeof LEGACY_PREFERENCE_KEYS]).toMatchObject({ action: 'mapped', to });
  });
});

describe('filterSetFromLegacyGoal', () => {
  it('migrates a full goal and blob', () => {
    const fs = filterSetFromLegacyGoal(
      {
        targetTitle: 'Senior Backend Engineer',
        targetSalaryMin: 100000,
        targetSalaryCurrency: 'usd',
        preferredLocations: { countries: ['us'], cities: ['Denver'], remoteOk: true, hybridOk: false },
        preferredWorkType: 'onsite',
        seniority: 'senior',
        preferencesBlob: {
          roleTitles: ['Platform Engineer', 'senior backend engineer'],
          workModes: { remote: true, hybrid: true, onsite: false },
          cities: ['Austin'],
          salaryMinK: 150,
          salaryMaxK: 200,
          salaryPeriod: 'year',
          employmentTypes: ['full_time', 'gig'],
          companyStages: { seed: true },
          companySizes: ['11–50', '5000+', 'huge'],
          industriesTarget: ['Fintech'],
          industriesAvoid: ['Gaming'],
          targetCompanies: ['Stripe'],
          blockedCompanies: ['Initech'],
          workAuth: 'Needs H-1B sponsorship',
          aggressiveness: 'aggressive',
          dailyCap: 50,
        },
      },
      OPTS,
    );
    expect(fs).toEqual({
      titles: ['Senior Backend Engineer', 'Platform Engineer'],
      workModels: ['remote', 'hybrid'],
      country: 'US',
      locations: [
        { label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 },
        { label: 'Denver', city: 'Denver', country: 'US', radiusKm: 40 },
      ],
      salaryMin: { amount: 150000, currency: 'USD', period: 'year' },
      jobTypes: ['full_time'],
      companySizes: ['11-50', '5000+'],
      industries: ['Fintech'],
      excludedIndustries: ['Gaming'],
      preferredCompanies: ['Stripe'],
      excludedCompanies: ['Initech'],
      seniority: ['senior'],
    });
    // D3: sponsorship is never inferred from free text.
    expect(fs.needsSponsorship).toBeUndefined();
  });

  it('falls back to the goal columns without a blob', () => {
    expect(
      filterSetFromLegacyGoal(
        { targetTitle: 'Engineering Manager', targetSalaryMin: 90000, targetSalaryCurrency: null, preferredWorkType: 'onsite', preferredLocations: { remoteOk: true }, seniority: 'manager' },
        OPTS,
      ),
    ).toEqual({
      titles: ['Engineering Manager'],
      workModels: ['remote', 'onsite'],
      salaryMin: { amount: 90000, currency: 'USD', period: 'year' },
      roleType: 'manager',
    });
  });

  it('treats all-on or all-off work modes as "any" and leaves country unset for several countries', () => {
    const fs = filterSetFromLegacyGoal(
      { targetTitle: '', preferredLocations: { countries: ['US', 'CA'], cities: ['Toronto'] }, preferencesBlob: { workModes: { remote: true, hybrid: true, onsite: true } } },
      OPTS,
    );
    expect(fs).toEqual({ locations: [{ label: 'Toronto', city: 'Toronto', radiusKm: 40 }] });
    expect(filterSetFromLegacyGoal(null, OPTS)).toEqual({});
  });

  it('uses the brand currency and monthly period for GoApply', () => {
    const fs = filterSetFromLegacyGoal({ targetTitle: '产品经理', preferencesBlob: { salaryMinK: 15, salaryPeriod: 'month' } }, { market: 'cn', currency: 'CNY' });
    expect(fs).toEqual({ titles: ['产品经理'], salaryMin: { amount: 15000, currency: 'CNY', period: 'month' } });
  });
});

describe('filterSetFromSavedSearch', () => {
  it('maps every SearchQuery key', () => {
    expect(
      filterSetFromSavedSearch(
        { q: 'react', location: 'Berlin', workType: 'remote', salaryMin: 70000, salaryCurrency: 'eur', datePosted: '7d', sortBy: 'recent', employmentType: 'contract' },
        OPTS,
      ),
    ).toEqual({
      q: 'react',
      locations: [{ label: 'Berlin', radiusKm: 40 }],
      workModels: ['remote'],
      salaryMin: { amount: 70000, currency: 'EUR', period: 'year' },
      postedWithinDays: 7,
      jobTypes: ['contract'],
    });
    expect(filterSetFromSavedSearch({ datePosted: 'any', workType: 'space' }, OPTS)).toEqual({});
    expect(filterSetFromSavedSearch(null, OPTS)).toEqual({});
  });
});

describe('buildLegacyProfiles', () => {
  it('creates exactly one default+active profile, then one per saved search (oldest first)', () => {
    const profiles = buildLegacyProfiles({
      goal: { targetTitle: 'Designer' },
      savedSearches: [
        { id: 's2', name: 'Later', query: { q: 'b' }, createdAt: new Date('2026-02-01') },
        { id: 's1', name: ' Earlier ', query: { q: 'a' }, createdAt: new Date('2026-01-01') },
      ],
      ...OPTS,
    });
    expect(profiles.map((p) => [p.name, p.isDefault, p.isActive, p.source])).toEqual([
      ['Designer', true, true, 'goal'],
      ['Earlier', false, false, 'saved_search:s1'],
      ['Later', false, false, 'saved_search:s2'],
    ]);
  });

  it('creates an unnamed empty default when there is nothing to migrate', () => {
    expect(buildLegacyProfiles({ goal: null, savedSearches: [], ...OPTS })).toEqual([{ name: '', isDefault: true, isActive: true, filters: {}, source: 'goal' }]);
  });
});

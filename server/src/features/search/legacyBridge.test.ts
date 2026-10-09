// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FilterSet } from './contract.js';
import { SEARCH_BACKED_PREFERENCE_KEYS, preferencePatchToFilterPatch, projectFiltersToPreferences } from './legacyBridge.js';
import { LEGACY_PREFERENCE_KEYS } from './legacyMigration.js';
import { mergeFilterSet } from './filterSet.js';

const FS: FilterSet = {
  titles: ['Data Analyst'],
  workModels: ['remote'],
  locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', radiusKm: 80 }],
  salaryMin: { amount: 90000, currency: 'USD', period: 'year' },
  jobTypes: ['full_time'],
  companySizes: ['51-200'],
  industries: ['Fintech'],
  excludedIndustries: ['Gaming'],
  preferredCompanies: ['Ramp'],
  excludedCompanies: ['Acme Staffing'],
};
const CTX = { current: FS, currency: 'USD', blockedBefore: ['Acme Staffing'] };

describe('projectFiltersToPreferences', () => {
  it('says the filters in the legacy keys', () => {
    expect(projectFiltersToPreferences(FS)).toEqual({
      roleTitles: ['Data Analyst'],
      workModes: { remote: true, hybrid: false, onsite: false },
      cities: ['Austin'],
      salaryMinK: 90,
      salaryPeriod: 'year',
      employmentTypes: ['full_time'],
      companyStages: { seed: false, seriesA: false, seriesB: false, seriesC: false, late: false, public: false },
      companySizes: ['51–200'],
      industriesTarget: ['Fintech'],
      industriesAvoid: ['Gaming'],
      targetCompanies: ['Ramp'],
    });
  });

  it('projects an empty set as "any": every work mode on, no pay floor', () => {
    expect(projectFiltersToPreferences({})).toMatchObject({ roleTitles: [], workModes: { remote: true, hybrid: true, onsite: true }, salaryMinK: 0 });
  });

  it('covers exactly the mapped legacy keys that the blob no longer stores', () => {
    for (const k of SEARCH_BACKED_PREFERENCE_KEYS) {
      expect(['mapped', 'dropped'], k).toContain(LEGACY_PREFERENCE_KEYS[k].action);
    }
  });
});

describe('preferencePatchToFilterPatch', () => {
  it('changes nothing when the client sends the projection back (Settings sends its whole draft)', () => {
    const projected = projectFiltersToPreferences(FS);
    expect(preferencePatchToFilterPatch({ ...projected, blockedCompanies: ['Acme Staffing'], digest: 'weekly' }, CTX)).toBeNull();
  });

  it('maps each changed key to its filter and clears emptied ones', () => {
    const patch = preferencePatchToFilterPatch(
      {
        roleTitles: ['BI Analyst'],
        workModes: { hybrid: true },
        cities: ['austin', 'Denver'],
        salaryMinK: 100,
        employmentTypes: ['contract', 'gig'],
        companySizes: ['1–10', 'huge'],
        industriesTarget: [],
        industriesAvoid: ['Gaming', 'Ads'],
        targetCompanies: ['Ramp', 'Mercury'],
        companyStages: { seed: true },
      },
      CTX,
    );
    expect(patch).toEqual({
      titles: ['BI Analyst'],
      workModels: ['remote', 'hybrid'],
      locations: [FS.locations![0], { label: 'Denver', city: 'Denver', radiusKm: 40 }],
      salaryMin: { amount: 100000, currency: 'USD', period: 'year' },
      jobTypes: ['contract'],
      companySizes: ['1-10'],
      industries: null,
      excludedIndustries: ['Gaming', 'Ads'],
      preferredCompanies: ['Ramp', 'Mercury'],
    });
  });

  it('treats every / no work mode as "any" and a zero pay floor as none', () => {
    expect(preferencePatchToFilterPatch({ workModes: { hybrid: true, onsite: true } }, CTX)).toEqual({ workModels: null });
    expect(preferencePatchToFilterPatch({ salaryMinK: 0 }, CTX)).toEqual({ salaryMin: null });
    expect(preferencePatchToFilterPatch({ salaryPeriod: 'month' }, CTX)).toEqual({ salaryMin: { amount: 90000, currency: 'USD', period: 'month' } });
    expect(preferencePatchToFilterPatch({ salaryMinK: 30 }, { ...CTX, current: {}, currency: 'CNY' })).toEqual({
      salaryMin: { amount: 30000, currency: 'CNY', period: 'year' },
    });
  });

  it('mirrors blocked-company additions and removals into excludedCompanies', () => {
    const add = preferencePatchToFilterPatch({ blockedCompanies: ['Acme Staffing', 'Initech'] }, CTX);
    expect(add).toEqual({ excludedCompanies: ['Acme Staffing', 'Initech'] });
    const remove = preferencePatchToFilterPatch({ blockedCompanies: [] }, CTX);
    expect(remove).toEqual({ excludedCompanies: null });
    expect(mergeFilterSet(FS, remove!)).not.toHaveProperty('excludedCompanies');
    // A company excluded from the drawer (not via the blocklist) survives a blocklist removal.
    const both = preferencePatchToFilterPatch({ blockedCompanies: [] }, { ...CTX, current: { excludedCompanies: ['Acme Staffing', 'Globex'] } });
    expect(both).toEqual({ excludedCompanies: ['Globex'] });
  });
});

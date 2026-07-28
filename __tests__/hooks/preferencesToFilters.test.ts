// __tests__/hooks/preferencesToFilters.test.ts
//
// The retrieval wire. Until this shipped, /jobs called
// `search.run({ sortBy:'match_desc', limit })` and nothing else, so every
// preference in the product was inert — a user who said "remote only, backend"
// saw the same list as everyone else.
//
// These tests exist because the failure mode of getting this wrong is SILENT:
// `RAJobIndexService` treats a present filter as a hard constraint (`location`
// is a substring match, `workType`/`employmentType` are equality, `salaryMin`
// compares against the job's salaryMax), so a filter we send on a guess does
// not gently bias the ranking — it deletes rows, and the user just sees fewer
// jobs with no way to know why.

import { describe, it, expect } from 'vitest';

import { preferencesToFilters } from '../../hooks/useTodayMatches';
import type { RAPreferences } from '../../lib/api/v2';

/** Only the fields the wire reads; the rest of RAPreferences is irrelevant. */
function prefs(partial: Partial<RAPreferences>): RAPreferences {
  return {
    roleTitles: [],
    workModes: { remote: false, hybrid: false, onsite: false },
    cities: [],
    salaryMinK: 0,
    salaryMaxK: 0,
    ...partial,
  } as unknown as RAPreferences;
}

describe('preferencesToFilters', () => {
  it('sends nothing when the user has stated nothing', () => {
    // Absence must mean UNFILTERED, not zero. A fresh account should get the
    // whole index ranked by fit, never an empty screen.
    expect(preferencesToFilters(prefs({}))).toEqual({});
    expect(preferencesToFilters(undefined)).toEqual({});
  });

  it('filters by role only when the user narrowed to exactly one', () => {
    // `q` is a single needle — it cannot express OR. Sending one of three
    // stated titles would delete the other two, so multi-role preferences are
    // left to the scorer, which weighs title and level at 35 and ranks rather
    // than excludes.
    expect(preferencesToFilters(prefs({ roleTitles: ['Backend Engineer'] })).q)
      .toBe('Backend Engineer');
    expect(
      preferencesToFilters(prefs({ roleTitles: ['Senior PM', 'Lead PM', 'Group PM'] })).q,
    ).toBeUndefined();
  });

  it('filters by work mode only when exactly one is on', () => {
    expect(
      preferencesToFilters(
        prefs({ workModes: { remote: true, hybrid: false, onsite: false } }),
      ).workType,
    ).toBe('remote');

    // All three on is the DEFAULT and means "no preference". Sending one of
    // them would silently hide two thirds of the index.
    expect(
      preferencesToFilters(
        prefs({ workModes: { remote: true, hybrid: true, onsite: true } }),
      ).workType,
    ).toBeUndefined();
  });

  it('never sends a location the user did not narrow to', () => {
    expect(
      preferencesToFilters(prefs({ cities: ['Berlin'] })).location,
    ).toBe('Berlin');
    expect(
      preferencesToFilters(prefs({ cities: ['Berlin', 'Munich', 'Remote · EU'] })).location,
    ).toBeUndefined();
  });

  it('drops the location filter when the user wants remote', () => {
    // The canonical harm case: someone in Bangalore searching for remote EU/US
    // work. `location` is a substring match against the posting's location
    // text, so pairing a home city with a remote search returns nothing.
    const out = preferencesToFilters(
      prefs({
        cities: ['Bangalore'],
        workModes: { remote: true, hybrid: false, onsite: false },
      }),
    );
    expect(out.location).toBeUndefined();
    expect(out.workType).toBe('remote');
  });

  it('never sends a salary floor', () => {
    // The server applies it as `salaryMax >= salaryMin`, and in Prisma a `gte`
    // does not match NULL — so a stated floor removes every posting that does
    // not publish a salary, which is most of them. The user would not get
    // well-paid jobs, they would get the small subset that advertises a range.
    // Pay is scored instead, where an absent figure degrades gracefully.
    const out = preferencesToFilters(prefs({ salaryMinK: 180, salaryMaxK: 230 }));
    expect(out.salaryMin).toBeUndefined();
    expect(out).toEqual({});
  });

  it('ignores blank and whitespace-only entries', () => {
    expect(preferencesToFilters(prefs({ roleTitles: ['   '] })).q).toBeUndefined();
    expect(preferencesToFilters(prefs({ cities: ['  '] })).location).toBeUndefined();
  });
});

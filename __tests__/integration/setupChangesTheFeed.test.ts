// __tests__/integration/setupChangesTheFeed.test.ts
//
// The chain, end to end: what a user confirms in setup must change which jobs
// they are shown. Every link in it has been broken at some point:
//
//   ConfirmStep  → onboarding.confirm   (drops edits if the draft MERGES — F2)
//                → preferences store    (writes nowhere the feed reads)
//                → usePreferences()
//                → preferencesToFilters (the wire that did not exist at all)
//                → search.run(filters)  (accepted filters nobody sent)
//
// Unit tests cover the ends. This covers the seam, because the failure mode is
// silent: every piece passes its own test, the app builds, the gates are green,
// and the user still gets the same list of jobs no matter what they say.

import { describe, it, expect, beforeEach } from 'vitest';

import { stubApi, resetRaV2Stub } from '../../lib/stub/raV2.stub';
import { preferencesToFilters } from '../../hooks/useTodayMatches';

async function confirmSetup(draft: Parameters<typeof stubApi.onboarding.confirm>[0]['draft']) {
  const boot = await stubApi.onboarding.bootstrap({
    resumeVariantId: (await stubApi.resumes.list()).resumes[0].id,
  });
  await stubApi.onboarding.confirm({ sessionId: boot.sessionId, draft });
  const { preferences } = await stubApi.preferences.get();
  return preferences;
}

describe('setup → preferences → filters → feed', () => {
  beforeEach(() => resetRaV2Stub());

  it('a single stated role becomes the search keyword', async () => {
    const prefs = await confirmSetup({ targetRoles: ['Backend Engineer'] });
    expect(prefs.roleTitles).toEqual(['Backend Engineer']);
    expect(preferencesToFilters(prefs).q).toBe('Backend Engineer');
  });

  it('choosing remote only becomes a workType filter', async () => {
    const prefs = await confirmSetup({ workModes: ['remote'] });
    expect(prefs.workModes).toMatchObject({ remote: true, hybrid: false, onsite: false });
    expect(preferencesToFilters(prefs).workType).toBe('remote');
  });

  it('REMOVING every role survives the round trip (fix F2)', async () => {
    // The core interaction of the confirm screen is deleting a seeded chip.
    // `mergeDraft` unions arrays, so under a merge the removed role comes back
    // and the user's edit is silently discarded — they would see jobs for a
    // title they explicitly rejected.
    await confirmSetup({ targetRoles: ['Backend Engineer', 'Platform Engineer'] });
    const after = await confirmSetup({ targetRoles: [] });
    expect(after.roleTitles).toEqual([]);
    expect(preferencesToFilters(after).q).toBeUndefined();
  });

  it('never sends a home city as a filter when the user wants remote', async () => {
    // The Bangalore case: a city read from a resume header, paired with a
    // remote search, is a substring match that returns nothing.
    const prefs = await confirmSetup({
      workModes: ['remote'],
      locations: { cities: ['Bangalore'], countries: [] },
    });
    const filters = preferencesToFilters(prefs);
    expect(filters.workType).toBe('remote');
    expect(filters.location).toBeUndefined();
  });

  it('a confirmed search actually narrows the feed', async () => {
    // The whole point. Compare the unfiltered feed against the confirmed one:
    // if setup changes nothing about what comes back, it is theatre.
    const before = await stubApi.search.run({ sortBy: 'match_desc', limit: 50 });
    const prefs = await confirmSetup({ workModes: ['onsite'] });
    const after = await stubApi.search.run({
      sortBy: 'match_desc',
      limit: 50,
      ...preferencesToFilters(prefs),
    });

    expect(after.jobs.length).toBeLessThan(before.jobs.length);
    expect(after.jobs.every((j) => j.workType === 'onsite')).toBe(true);
  });

  it('a brand-new user with no stated preferences still gets the whole index (fix F1)', async () => {
    // Absence must mean unfiltered, never zero. This is the user onboarding
    // exists to serve, and an empty first screen is the one outcome that
    // cannot be recovered from.
    const { preferences } = await stubApi.preferences.get();
    const virgin = { ...preferences, roleTitles: [], cities: [], salaryMinK: 0,
      workModes: { remote: false, hybrid: false, onsite: false } };
    expect(preferencesToFilters(virgin)).toEqual({});

    const feed = await stubApi.search.run({ sortBy: 'match_desc', limit: 50 });
    expect(feed.jobs.length).toBeGreaterThan(0);
    // And none of them has a score yet — which is exactly the state any score
    // floor would have rendered as an empty screen.
    expect(feed.jobs.every((j) => j.matchScoreCached === null)).toBe(true);
  });
});

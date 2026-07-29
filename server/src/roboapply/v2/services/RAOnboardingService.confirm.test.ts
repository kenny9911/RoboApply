// backend/src/roboapply/v2/services/RAOnboardingService.confirm.test.ts
//
// THE WIRING TEST FOR FIX F2, and it exists because the unit tests around it
// both passed while the wiring was wrong.
//
// `raResumeSeed.test.ts` proves `replaceDraft()` removes a chip. `SetupPanel`
// proves the client SUBMITS the removal. Neither proves that `confirm()` calls
// `replaceDraft` rather than `mergeDraft` — and swapping that one identifier
// back leaves the entire suite green. That is the whole bug: `mergeDraft`
// unions arrays, so the user taps × on "QA Lead", presses submit, gets a
// success response, and "QA Lead" is still in the preferences that drive their
// feed. No error, no warning, nothing on screen that differs.
//
// So this asserts on the two writes that actually leave the service — the
// preferences patch (which `preferencesToFilters()` turns into search filters)
// and the persisted session draft — rather than on any intermediate value.
//
// Run: npx vitest run server/src/roboapply/v2/services/RAOnboardingService.confirm.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock every I/O seam BEFORE importing the service ──────────────────────

const SESSION = {
  id: 'sess_1',
  userId: 'user_1',
  status: 'active',
  resumeVariantId: 'var_1',
  // What the deterministic seed read off the resume. "QA Lead" is the chip the
  // user is about to remove; `employmentTypes` is the field the client never
  // renders unless touched, and so never submits.
  draftPreferences: {
    targetRoles: ['Senior Product Manager', 'QA Lead'],
    employmentTypes: ['full-time'],
    locations: { cities: ['Austin'] },
  },
  chips: null,
};

const findUniqueSession = vi.fn(async () => ({ ...SESSION }));
const updateSession = vi.fn(async (args: any) => args);
const findUniqueGoal = vi.fn(async () => ({ preferencesBlob: { onboarding: { autoOpens: 2 } } }));
const findFirstVariant = vi.fn(async () => ({ id: 'var_1', isPrimary: true }));

vi.mock('../../../lib/prisma.js', () => ({
  default: {
    rAOnboardingSession: {
      findUnique: (...a: any[]) => findUniqueSession(...(a as [])),
      update: (...a: any[]) => updateSession(...(a as [any])),
    },
    rACareerGoal: { findUnique: (...a: any[]) => findUniqueGoal(...(a as [])) },
    rAResumeVariant: { findFirst: (...a: any[]) => findFirstVariant(...(a as [])) },
  },
}));

const goalUpsert = vi.fn(async () => ({ targetTitle: 'Senior Product Manager' }));
const goalGet = vi.fn(async () => ({ targetTitle: 'Senior Product Manager' }));
vi.mock('./RACareerGoalService.js', () => ({
  raCareerGoalService: {
    upsert: (...a: any[]) => goalUpsert(...(a as [])),
    // Only the already-completed (idempotent re-POST) path reads this.
    get: (...a: any[]) => goalGet(...(a as [])),
  },
}));

const prefsUpdate = vi.fn(async (_userId: string, patch: any) => ({ preferences: patch }));
const prefsGet = vi.fn(async () => ({ preferences: {}, options: {} }));
// PARTIAL mock: `RA_PREFERENCE_OPTIONS` is re-exported from here and backs the
// canonical industry/stage/size tables inside `raOnboardingDraft`. Those tables
// are real logic this test wants exercised, not a seam to stub out — only the
// service object is replaced.
vi.mock('./RAPreferencesService.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  raPreferencesService: {
    update: (...a: any[]) => prefsUpdate(...(a as [string, any])),
    get: (...a: any[]) => prefsGet(...(a as [])),
  },
}));

const setPrimary = vi.fn(async () => ({}));
vi.mock('./RAResumeService.js', () => ({
  raResumeService: { setPrimary: (...a: any[]) => setPrimary(...(a as [])) },
}));

vi.mock('../../../lib/matchBilling.js', () => ({ writeDeductionLog: vi.fn(async () => undefined) }));
vi.mock('../../../lib/deductionCost.js', () => ({
  costPatchFromTally: () => ({ platformCostUsd: 0, metadata: {} }),
}));

// Import AFTER the mocks are registered.
const { raOnboardingService } = await import('./RAOnboardingService.js');

/** The COMPLETE post-edit state the confirm screen submits: "QA Lead" removed,
 *  the seeded city cleared, Remote turned on. `employmentTypes` is absent
 *  because the user never touched that group. */
const SUBMITTED = {
  targetRoles: ['Senior Product Manager'],
  workModes: ['remote' as const],
  locations: { cities: [], countries: [], remoteOk: true },
  targetCompanies: [],
};

describe('RAOnboardingService.confirm — the submitted draft REPLACES the seed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueSession.mockResolvedValue({ ...SESSION });
    findUniqueGoal.mockResolvedValue({ preferencesBlob: { onboarding: { autoOpens: 2 } } });
    findFirstVariant.mockResolvedValue({ id: 'var_1', isPrimary: true });
    prefsUpdate.mockImplementation(async (_u: string, patch: any) => ({ preferences: patch }));
  });

  it('drops a removed chip from the preferences that drive the feed', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    expect(prefsUpdate).toHaveBeenCalledTimes(1);
    const patch = prefsUpdate.mock.calls[0]![1];

    // The assertion the whole fix is for. Under `mergeDraft` this reads
    // ['Senior Product Manager', 'QA Lead'] and the suite still goes green.
    expect(patch.roleTitles).toEqual(['Senior Product Manager']);
    expect(patch.roleTitles).not.toContain('QA Lead');
  });

  it('clears the seeded city when the user declined it', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    // `cities` is a substring filter — a city the user did not state empties
    // the feed for a remote seeker, so "I removed it" has to survive.
    expect(prefsUpdate.mock.calls[0]![1].cities).toEqual([]);
  });

  it('leaves a field the client never submitted untouched', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    // Absent key ≠ cleared key: the confirm screen only renders
    // `employmentTypes` once touched, and a client that never showed a control
    // must not be able to erase what the resume said.
    expect(prefsUpdate.mock.calls[0]![1].employmentTypes).toEqual(['full-time']);
  });

  it('translates the confirmed work mode into the single-mode filter', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    expect(prefsUpdate.mock.calls[0]![1].workModes).toEqual({
      remote: true,
      hybrid: false,
      onsite: false,
    });
  });

  it('persists the replaced draft on the session, not the union', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    expect(updateSession).toHaveBeenCalledTimes(1);
    const data = updateSession.mock.calls[0]![0].data;
    expect(data.status).toBe('completed');
    expect(data.draftPreferences.targetRoles).toEqual(['Senior Product Manager']);
  });

  it('preserves the auto-open counter it did not author', async () => {
    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    // The `onboarding` key is written wholesale, so a careless spread here
    // would reset `autoOpens` to zero and hand the user two fresh automatic
    // showings of a panel they just finished.
    const patch = prefsUpdate.mock.calls[0]![1];
    expect(patch.onboarding.autoOpens).toBe(2);
    expect(patch.onboarding.completedSteps).toEqual(['resume', 'preferences']);
    expect(typeof patch.onboarding.completedAt).toBe('string');
  });

  it('never sends a salary floor, however the draft got one', async () => {
    // A stated floor is applied as `salaryMax >= min`, and a Prisma `gte` does
    // not match NULL — so it deletes every posting without a published range.
    // It may be STORED (Settings shows it); it must never reach the filters.
    findUniqueSession.mockResolvedValue({
      ...SESSION,
      draftPreferences: { ...SESSION.draftPreferences, salary: { min: 180000, currency: 'USD' } },
    });

    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    const patch = prefsUpdate.mock.calls[0]![1];
    expect(patch.salaryMinK).toBe(180); // stored…
    // …and preferencesToFilters() is what refuses to send it. Guarded there by
    // __tests__/hooks/preferencesToFilters.test.ts; noted here so a future
    // reader does not "fix" the omission by adding a filter.
  });

  it('is idempotent — a double tap does not re-run the writes', async () => {
    findUniqueSession.mockResolvedValue({ ...SESSION, status: 'completed' });

    await raOnboardingService.confirm('user_1', 'sess_1', SUBMITTED, undefined, 'en');

    expect(prefsUpdate).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(prefsGet).toHaveBeenCalled();
  });
});

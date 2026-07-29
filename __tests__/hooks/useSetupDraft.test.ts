// The step-2 draft reducer, and the body it posts to POST /onboarding/confirm.
//
// This is the file that guards the single most breakable promise in the flow:
// REMOVING A SEEDED CHIP MUST ACTUALLY REMOVE IT. The server's `mergeDraft`
// unions array fields, so a partial update cannot express a removal — only a
// complete replacement can, and only if the client actually sends the key. The
// asymmetry in `toConfirmDraft` (always-send vs. send-only-if-touched) is not a
// style choice; each half exists to stop a specific silent data loss.

import { describe, it, expect } from 'vitest';

import {
  draftStateFromSession,
  emptyDraftState,
  setupDraftReducer,
  toConfirmDraft,
  type SetupDraftState,
} from '../../hooks/useSetup';
import type { OnboardingSetupState } from '../../lib/api/v2/types';

const SESSION: OnboardingSetupState = {
  sessionId: 'obs_1',
  returning: false,
  resumeVariant: { id: 'rv_1', name: 'Master Resume' },
  ingestRows: [],
  draft: {
    targetRoles: ['Senior Product Manager', 'QA Lead'],
    seniority: 'senior',
    employmentTypes: ['full_time'],
    industriesTarget: ['Healthtech'],
    locations: { cities: ['San Francisco'], countries: ['United States'] },
  },
  fieldMeta: {
    targetRoles: { source: 'resume', confidence: 0.8 },
    locations: { source: 'inferred', confidence: 0.5 },
  },
  proposedFields: ['locations'],
  evidence: { roles: ['Senior Product Manager'], years: 8, city: 'San Francisco' },
  thin: false,
  enrichmentPending: false,
};

function seeded(): SetupDraftState {
  return draftStateFromSession(SESSION);
}

describe('draftStateFromSession', () => {
  it('applies the seeded roles as real values', () => {
    expect(seeded().targetRoles).toEqual(['Senior Product Manager', 'QA Lead']);
  });

  it('does NOT apply a field listed in proposedFields', () => {
    // The resume says San Francisco. `location` is a substring filter, so
    // asserting it would empty the feed for someone looking remote — the city
    // is a question, not an answer, and reaches the screen as an unselected
    // suggestion chip instead.
    expect(seeded().cities).toEqual([]);
  });

  it('carries countries through even though nothing on screen edits them', () => {
    expect(seeded().countries).toEqual(['United States']);
  });

  it('starts with nothing touched', () => {
    expect(seeded().touched).toEqual([]);
  });
});

describe('setupDraftReducer', () => {
  it('removes a seeded chip', () => {
    const next = setupDraftReducer(seeded(), {
      type: 'remove',
      field: 'targetRoles',
      value: 'QA Lead',
    });
    expect(next.targetRoles).toEqual(['Senior Product Manager']);
    expect(next.touched).toContain('targetRoles');
  });

  it('removing the LAST chip leaves an empty list, not the seed', () => {
    let state = seeded();
    for (const role of ['Senior Product Manager', 'QA Lead']) {
      state = setupDraftReducer(state, { type: 'remove', field: 'targetRoles', value: role });
    }
    expect(state.targetRoles).toEqual([]);
    // …and the confirm body carries the empty array, which is the ONLY thing
    // the server accepts as "clear this".
    expect(toConfirmDraft(state).targetRoles).toEqual([]);
  });

  it('adds trimmed values and refuses blanks and case-insensitive duplicates', () => {
    let state = setupDraftReducer(seeded(), {
      type: 'add',
      field: 'targetRoles',
      value: '  Group Product Manager  ',
    });
    expect(state.targetRoles).toContain('Group Product Manager');
    state = setupDraftReducer(state, { type: 'add', field: 'targetRoles', value: '   ' });
    state = setupDraftReducer(state, {
      type: 'add',
      field: 'targetRoles',
      value: 'group product manager',
    });
    expect(state.targetRoles.filter((r) => /group product manager/i.test(r))).toHaveLength(1);
  });

  it('toggles work modes on and off', () => {
    let state = setupDraftReducer(seeded(), { type: 'toggle', field: 'workModes', value: 'remote' });
    expect(state.workModes).toEqual(['remote']);
    state = setupDraftReducer(state, { type: 'toggle', field: 'workModes', value: 'remote' });
    expect(state.workModes).toEqual([]);
    expect(state.touched).toContain('workModes');
  });

  it('re-hydrates from a late enrichment without stomping an edit in flight', () => {
    // Thin resume: the deterministic seed found no roles, the model landed some
    // 1.5 s later — but by then the user had already typed one and removed the
    // seeded industry. Their edits outrank the seed.
    const thin: OnboardingSetupState = {
      ...SESSION,
      thin: true,
      draft: { ...SESSION.draft, targetRoles: [] },
    };
    let state = draftStateFromSession(thin);
    state = setupDraftReducer(state, {
      type: 'add',
      field: 'targetRoles',
      value: 'Support Engineer',
    });
    state = setupDraftReducer(state, {
      type: 'remove',
      field: 'industriesTarget',
      value: 'Healthtech',
    });

    const enriched: OnboardingSetupState = {
      ...thin,
      draft: {
        ...thin.draft,
        targetRoles: ['Technical Support Specialist'],
        industriesTarget: ['Healthtech', 'Fintech'],
      },
      enrichmentPending: false,
    };
    const after = setupDraftReducer(state, {
      type: 'hydrate',
      state: enriched,
      preserveTouched: true,
    });
    expect(after.targetRoles).toEqual(['Support Engineer']);
    expect(after.industriesTarget).toEqual([]);
  });
});

describe('toConfirmDraft', () => {
  it('always sends the four fields the user can see and edit', () => {
    const body = toConfirmDraft(seeded());
    expect(body).toHaveProperty('targetRoles');
    expect(body).toHaveProperty('workModes');
    expect(body).toHaveProperty('locations');
    expect(body).toHaveProperty('targetCompanies');
  });

  it('sends `locations` explicitly even when the proposed city was declined', () => {
    // Omitting it would leave the server holding the seeded city and confirm it
    // at 1.0 — the silent search inversion the suggestion chip exists to stop.
    expect(toConfirmDraft(seeded()).locations).toEqual({
      cities: [],
      countries: ['United States'],
      remoteOk: false,
    });
  });

  it('derives remoteOk from the Remote pill rather than asking twice', () => {
    const state = setupDraftReducer(seeded(), {
      type: 'toggle',
      field: 'workModes',
      value: 'remote',
    });
    expect(toConfirmDraft(state).locations?.remoteOk).toBe(true);
  });

  it('OMITS employmentTypes and industriesTarget while they are untouched', () => {
    // Both are seeded, and `industriesTarget` is the one field the parallel LLM
    // seed contributes — it can land after bootstrap returned. An absent key is
    // left untouched by the server; sending our stale snapshot would delete it.
    const body = toConfirmDraft(seeded());
    expect(body).not.toHaveProperty('employmentTypes');
    expect(body).not.toHaveProperty('industriesTarget');
  });

  it('sends them the moment the user edits them', () => {
    const state = setupDraftReducer(seeded(), {
      type: 'toggleEmployment',
      value: 'contract',
    });
    expect(toConfirmDraft(state).employmentTypes).toEqual(['full_time', 'contract']);
  });

  it('never sends salary', () => {
    expect(toConfirmDraft(seeded())).not.toHaveProperty('salary');
    expect(toConfirmDraft(emptyDraftState())).not.toHaveProperty('salary');
  });
});

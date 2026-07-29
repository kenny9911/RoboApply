// formatDraftField — value rendering for the notes receipt on step 2.
//
// Moved from __tests__/components/PreferenceTray.test.tsx. The tray died with
// the onboarding chat (it existed to SUPPRESS values an assistant had not yet
// confirmed, a concept the confirm screen replaces outright); the formatter
// did not, so its cases move rather than disappear. The three "unconfirmed
// field" cases are gone with the concept, and `draftFromPreferences` is new.

import { describe, it, expect } from 'vitest';

import {
  draftFromPreferences,
  formatDraftFieldValue,
} from '../../components/v3/setup/formatDraftField';
import type {
  OnboardingDraftPreferences,
  RAPreferences,
} from '../../lib/api/v2/types';

const DRAFT: OnboardingDraftPreferences = {
  targetRoles: ['Senior Backend Engineer', 'Platform Engineer'],
  workModes: ['remote', 'hybrid'],
  salary: { min: 150000, currency: 'USD', period: 'year' },
  locations: { cities: ['Lisbon'], countries: ['Portugal'] },
  dealbreakers: ['agencies'],
};

/** Stand-in for `t('values.*')` — the real bundle localizes these. */
const tValue = (v: string) => (v === 'remote' ? 'Remote' : v === 'hybrid' ? 'Hybrid' : v);

describe('formatDraftFieldValue', () => {
  it('joins list fields', () => {
    expect(formatDraftFieldValue(DRAFT, 'targetRoles', tValue)).toBe(
      'Senior Backend Engineer · Platform Engineer',
    );
  });

  it('localizes closed-enum members and passes free text through', () => {
    expect(formatDraftFieldValue(DRAFT, 'workModes', tValue)).toBe('Remote · Hybrid');
    expect(formatDraftFieldValue(DRAFT, 'dealbreakers', tValue)).toBe('agencies');
  });

  it('renders a one-sided salary range without inventing the other side', () => {
    expect(formatDraftFieldValue(DRAFT, 'salary', tValue)).toBe('USD 150,000+ / year');
    expect(
      formatDraftFieldValue({ salary: { max: 90000 } }, 'salary', tValue),
    ).toBe('≤90,000');
  });

  it('merges cities and countries into one places line', () => {
    expect(formatDraftFieldValue(DRAFT, 'locations', tValue)).toBe('Lisbon · Portugal');
  });

  it('returns null for an absent or empty field, so it renders nothing', () => {
    expect(formatDraftFieldValue(DRAFT, 'mustHaves', tValue)).toBeNull();
    expect(formatDraftFieldValue({ targetRoles: [] }, 'targetRoles', tValue)).toBeNull();
    expect(formatDraftFieldValue({ salary: {} }, 'salary', tValue)).toBeNull();
    expect(formatDraftFieldValue(DRAFT, 'nonsense', tValue)).toBeNull();
  });
});

describe('draftFromPreferences', () => {
  const PREFS = {
    roleTitles: ['Product Manager'],
    workModes: { remote: true, hybrid: false, onsite: false },
    cities: ['Berlin'],
    industriesTarget: ['Healthtech'],
    industriesAvoid: [],
    companyStages: { seed: true, seriesA: false },
    companySizes: ['51–200'],
    targetCompanies: ['Figma'],
    mustHaves: [],
    dealbreakers: ['defense'],
  } as unknown as RAPreferences;

  it('reads the PERSISTED preferences back in draft shape', () => {
    const draft = draftFromPreferences(PREFS);
    expect(draft.targetRoles).toEqual(['Product Manager']);
    expect(draft.dealbreakers).toEqual(['defense']);
    expect(draft.targetCompanies).toEqual(['Figma']);
  });

  it('turns the work-mode record into the draft list, remote flag included', () => {
    const draft = draftFromPreferences(PREFS);
    expect(draft.workModes).toEqual(['remote']);
    expect(draft.locations).toEqual({ cities: ['Berlin'], remoteOk: true });
  });

  it('keeps only the company stages that are switched on', () => {
    expect(draftFromPreferences(PREFS).companyStages).toEqual(['seed']);
  });
});

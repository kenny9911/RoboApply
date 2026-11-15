// The start flow's form model: what a resume fills in, what is missing, and
// the step bodies. The bodies are checked against the server's own schemas
// (the contract is unchanged; the web builds what the long screens build).

import { describe, expect, it } from 'vitest';

import { BasicsStepSchema, ConfirmStepSchema, ResumeStepSchema, SituationStepSchema } from '../../../../server/src/features/onboarding/contract';
import { levelsForSeekerType } from '../steps/ConfirmStep';
import {
  answersFor,
  blankForm,
  hasMatchedTitles,
  missingFields,
  seekerTypeForLevels,
  suggestedLevels,
  suggestedTitles,
  titlesAreAiSuggested,
  withSuggestions,
  type ExpressForm,
} from './model';

const NAMES = new Map([
  ['backend_engineer', 'Backend engineer'],
  ['data_engineer', 'Data engineer'],
]);
const filled = (over: Partial<ExpressForm> = {}): ExpressForm => ({ ...blankForm({ country: 'GB' }), titles: [{ label: 'Ops wrangler' }], levels: ['mid'], ...over });

describe('the form before anything is known', () => {
  it('full-time, as soon as possible, remote included, the visitor\'s country when the server knows it', () => {
    expect(blankForm({ country: 'GB' })).toEqual({ titles: [], levels: [], countries: ['GB'], cities: [], remoteOk: true, sponsorship: {}, jobTypes: ['full_time'], timing: 'asap', seekerType: null });
    expect(blankForm({ country: null }).countries).toEqual([]);
    expect(blankForm(undefined).countries).toEqual([]);
  });
});

describe('what a resume fills in', () => {
  it('titles the server matched to the role list, by their name; else the resume\'s own titles; at most 3, no repeats', () => {
    const s = { suggestedTaxonomyIds: ['backend_engineer', 'data_engineer', 'backend_engineer'], profileDraft: { targetRoles: ['Senior Backend Engineer'] } };
    expect(suggestedTitles(s, NAMES)).toEqual([
      { taxonomyId: 'backend_engineer', label: 'Backend engineer' },
      { taxonomyId: 'data_engineer', label: 'Data engineer' },
    ]);
    expect(hasMatchedTitles(s)).toBe(true);
    // The role list could not be loaded (no names): the resume's wording, never a raw id.
    expect(suggestedTitles(s, new Map())).toEqual([{ label: 'Senior Backend Engineer' }]);
    expect(suggestedTitles({ suggestedTaxonomyIds: [], profileDraft: { targetRoles: [' One ', 'two', 'ONE', 'three', 'four'] } }, NAMES)).toEqual([{ label: 'One' }, { label: 'two' }, { label: 'three' }]);
    expect(hasMatchedTitles({ suggestedTaxonomyIds: [] })).toBe(false);
  });

  it('reads untyped JSON defensively: wrong shapes suggest nothing', () => {
    for (const s of [null, undefined, {}, { suggestedTaxonomyIds: 'x', suggestedSeniority: 7, profileDraft: null }, { profileDraft: { targetRoles: [1, null, ''] } }]) {
      expect(suggestedTitles(s as never, NAMES)).toEqual([]);
      expect(suggestedLevels(s as never)).toEqual([]);
      expect(titlesAreAiSuggested(s as never)).toBe(false);
    }
  });

  it('levels, in the list\'s order, ignoring anything that is not a level', () => {
    expect(suggestedLevels({ suggestedSeniority: ['lead_staff', 'senior', 'wizard'] })).toEqual(['senior', 'lead_staff']);
  });

  it('only fields the resume speaks to are replaced', () => {
    const form = filled({ jobTypes: ['contract'], countries: ['DE'], timing: 'just_looking' });
    const next = withSuggestions(form, { suggestedSeniority: ['senior'], suggestedTaxonomyIds: [], profileDraft: { targetRoles: [] } }, NAMES);
    expect(next).toEqual({ ...form, levels: ['senior'] });
    expect(withSuggestions(form, null, NAMES)).toEqual(form);
  });
});

describe('the seeker type that goes with the levels', () => {
  it('only a single Internship or Entry level says student or recent graduate', () => {
    expect(seekerTypeForLevels(['internship'])).toBe('student');
    expect(seekerTypeForLevels(['entry'])).toBe('recent_graduate');
    expect(seekerTypeForLevels(['internship', 'entry'])).toBe('experienced');
    expect(seekerTypeForLevels(['mid'])).toBe('experienced');
    expect(seekerTypeForLevels([])).toBe('experienced');
  });

  it('is the reverse of the long flow\'s rule (seeker type → the level it pre-selects)', () => {
    for (const type of ['student', 'recent_graduate'] as const) expect(seekerTypeForLevels(levelsForSeekerType(type))).toBe(type);
  });
});

describe('what is missing', () => {
  it('titles, levels, a place and a job type, in the order of the screen', () => {
    expect(missingFields(blankForm({ country: null }))).toEqual(['titles', 'levels', 'countries']);
    expect(missingFields(filled())).toEqual([]);
    expect(missingFields(filled({ jobTypes: [], titles: [] }))).toEqual(['titles', 'jobTypes']);
  });
});

describe('the step bodies', () => {
  it('are accepted by the server\'s schemas, with and without a resume', () => {
    const form = filled({
      titles: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }, { label: 'Ops wrangler' }],
      countries: ['GB', 'REMOTE'],
      cities: [{ country: 'GB', city: 'Leeds', label: 'Leeds, United Kingdom' }],
      sponsorship: { GB: 'not_sure' },
    });
    for (const resume of ['rv1', null]) {
      const a = answersFor(form, resume);
      expect(SituationStepSchema.safeParse(a.situation).success).toBe(true);
      expect(BasicsStepSchema.safeParse(a.basics).success).toBe(true);
      expect(ResumeStepSchema.safeParse(a.resumeVariantId ? { resumeVariantId: a.resumeVariantId } : { skip: true }).success).toBe(true);
      expect(ConfirmStepSchema.safeParse(a.confirm).success).toBe(true);
    }
    expect(answersFor(form, 'rv1')).toEqual({
      situation: { timing: 'asap', seekerType: 'experienced' },
      basics: {
        jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }, { label: 'Ops wrangler' }],
        jobTypes: ['full_time'],
        countries: ['GB', 'REMOTE'],
        locations: [{ country: 'GB', city: 'Leeds', label: 'Leeds, United Kingdom' }],
        remoteOk: true,
        needsSponsorship: { GB: 'not_sure' },
      },
      resumeVariantId: 'rv1',
      confirm: { experienceLevels: ['mid'], alertFrequency: 'daily' },
    });
  });

  it('cities and work-permit answers of a country that is no longer chosen are left out', () => {
    const form = filled({ countries: ['DE'], cities: [{ country: 'GB', city: 'Leeds', label: 'Leeds, United Kingdom' }], sponsorship: { GB: 'yes', DE: 'no' } });
    expect(answersFor(form, null).basics).toEqual({ jobFunctions: [{ label: 'Ops wrangler' }], jobTypes: ['full_time'], countries: ['DE'], remoteOk: true, needsSponsorship: { DE: 'no' } });
  });

  it('the seeker type the user picked wins over the one the levels say', () => {
    expect(answersFor(filled({ levels: ['internship'] }), null).situation.seekerType).toBe('student');
    expect(answersFor(filled({ levels: ['internship'], seekerType: 'career_change' }), null).situation.seekerType).toBe('career_change');
  });
});

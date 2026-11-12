// components/features/onboarding/express/model.ts — the start flow's one form:
// its values, how a resume fills them in, what is missing, and the step bodies
// "Find my jobs" saves. Pure (no React, no requests).
//
// The bodies are the ones the long screens send (situation, basics, confirm):
// the server contract is unchanged.

import type { ExpressAnswers } from '../../../../hooks/onboarding/useExpressOnboarding';
import { EXPERIENCE_LEVELS, JOB_TYPES, LIMITS, SEEKER_TYPES, SPONSORSHIP_ANSWERS, TIMINGS } from '../options';
import type { PickedTitle } from '../steps/TitlePicker';

export type Level = (typeof EXPERIENCE_LEVELS)[number];
export type JobType = (typeof JOB_TYPES)[number];
export type Timing = (typeof TIMINGS)[number];
export type SeekerType = (typeof SEEKER_TYPES)[number];
export type Sponsorship = (typeof SPONSORSHIP_ANSWERS)[number];

export interface CityRow {
  country: string;
  city: string;
  label: string;
}

export interface ExpressForm {
  titles: PickedTitle[];
  levels: Level[];
  countries: string[];
  cities: CityRow[];
  remoteOk: boolean;
  /** Per country; only countries the user answered for. */
  sponsorship: Record<string, Sponsorship>;
  jobTypes: JobType[];
  timing: Timing;
  /** What the user picked under "Which describes you best?"; null = follow the levels (`seekerTypeForLevels`). */
  seekerType: SeekerType | null;
}

/** The form before anything is known: full-time, as soon as possible, the visitor's country when the server knows it. */
export function blankForm(defaults: { country?: string | null } | null | undefined): ExpressForm {
  return {
    titles: [],
    levels: [],
    countries: defaults?.country ? [defaults.country] : [],
    cities: [],
    remoteOk: true,
    sponsorship: {},
    jobTypes: ['full_time'],
    timing: 'asap',
    seekerType: null,
  };
}

/** What POST /onboarding/resume answered (untyped JSON on the wire, so every field is checked). */
export interface ResumeSuggestions {
  resumeVariantId?: unknown;
  suggestedSeniority?: unknown;
  suggestedTaxonomyIds?: unknown;
  profileDraft?: { targetRoles?: unknown; aiSuggested?: unknown } | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/**
 * Job titles from the resume, at most 3. Titles the server matched to the
 * role list come first, by their name in the reader's language (`labels`,
 * the taxonomy names); when none is matched or named, the titles as the
 * resume words them. Same rule as the search itself (it uses the matched ids
 * when there are any, else the resume's own titles).
 */
export function suggestedTitles(s: ResumeSuggestions | null | undefined, labels: ReadonlyMap<string, string>): PickedTitle[] {
  if (!s) return [];
  const named: PickedTitle[] = [];
  for (const id of strings(s.suggestedTaxonomyIds)) {
    const label = labels.get(id);
    if (label && !named.some((t) => t.taxonomyId === id)) named.push({ taxonomyId: id, label });
  }
  if (named.length) return named.slice(0, LIMITS.titles);
  const own: PickedTitle[] = [];
  for (const raw of strings(s.profileDraft?.targetRoles)) {
    const label = raw.trim().slice(0, 120);
    if (!own.some((t) => t.label.toLowerCase() === label.toLowerCase())) own.push({ label });
  }
  return own.slice(0, LIMITS.titles);
}

/** True when the server matched resume titles to the role list (their names are needed to show them). */
export function hasMatchedTitles(s: ResumeSuggestions | null | undefined): boolean {
  return strings(s?.suggestedTaxonomyIds).length > 0;
}

/** Experience levels the resume suggests, in the list's order. */
export function suggestedLevels(s: ResumeSuggestions | null | undefined): Level[] {
  const got = new Set(strings(s?.suggestedSeniority));
  return EXPERIENCE_LEVELS.filter((l) => got.has(l));
}

/** True when the titles came from an AI reading of the resume (they are labelled as such). */
export function titlesAreAiSuggested(s: ResumeSuggestions | null | undefined): boolean {
  return s?.profileDraft?.aiSuggested === true;
}

/**
 * The form with a resume's suggestions filled in. Only the titles and the
 * levels come from a resume; a field the resume says nothing about keeps what
 * the form already has.
 */
export function withSuggestions(form: ExpressForm, s: ResumeSuggestions | null | undefined, labels: ReadonlyMap<string, string>): ExpressForm {
  const titles = suggestedTitles(s, labels);
  const levels = suggestedLevels(s);
  return { ...form, ...(titles.length ? { titles } : {}), ...(levels.length ? { levels } : {}) };
}

/**
 * The seeker type that goes with the chosen levels (the reverse of the long
 * flow's "Student → Internship, Recent graduate → Entry level"): only a single
 * Internship or Entry level says it; anything else is an experienced
 * professional. The user can pick another under "Which describes you best?".
 */
export function seekerTypeForLevels(levels: readonly Level[]): SeekerType {
  if (levels.length === 1 && levels[0] === 'internship') return 'student';
  if (levels.length === 1 && levels[0] === 'entry') return 'recent_graduate';
  return 'experienced';
}

/** The fields "Find my jobs" needs, in the order they are on the screen. */
export const REQUIRED_FIELDS = ['titles', 'levels', 'countries', 'jobTypes'] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** Required fields that are still empty, in screen order. */
export function missingFields(form: ExpressForm): RequiredField[] {
  return REQUIRED_FIELDS.filter((f) => form[f].length === 0);
}

/** Toggle a value in a multi-select list. */
export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * The step bodies for these answers. `basics` is built as the long "What job
 * do you want next?" screen builds it: cities and work-permit answers only for
 * countries that are still selected, and left out when there are none.
 */
export function answersFor(form: ExpressForm, resumeVariantId: string | null): ExpressAnswers {
  const real = form.countries.filter((c) => c !== 'REMOTE');
  const locations = form.cities.filter((c) => form.countries.includes(c.country));
  const needs = Object.fromEntries(Object.entries(form.sponsorship).filter(([c]) => real.includes(c)));
  return {
    situation: { timing: form.timing, seekerType: form.seekerType ?? seekerTypeForLevels(form.levels) },
    basics: {
      jobFunctions: form.titles.map((t) => (t.taxonomyId ? { taxonomyId: t.taxonomyId, label: t.label } : { label: t.label })),
      jobTypes: form.jobTypes,
      countries: form.countries,
      ...(locations.length ? { locations } : {}),
      remoteOk: form.remoteOk,
      ...(Object.keys(needs).length ? { needsSponsorship: needs } : {}),
    },
    resumeVariantId,
    // New jobs by email once a day is the long flow's default too; the screen says so.
    confirm: { experienceLevels: form.levels, alertFrequency: 'daily' },
  };
}

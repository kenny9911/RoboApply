// server/src/features/onboarding/mapping.ts — answers → the stores they feed (WP-30).
//
// Pure. Each step's answers become a FilterSetPatch on the user's default
// search profile (the one preference store, WP-20), plus a few profile
// fields. A patch replaces the fields it names (or clears them with null), so
// re-submitting the same answers writes the same profile: idempotent.
//
// Honesty: nothing here invents a value. A country the user did not pick is
// not added; "Not sure" about sponsorship is not turned into yes or no; a
// resume title that does not match the taxonomy stays a free-text title.

import type { FilterSetPatch } from '../search/index.js';
import { bestTaxonomyMatch } from '../jobs/taxonomy/index.js';
import type {
  BasicsStepSchema,
  ConfirmStepSchema,
  ONBOARDING_EXPERIENCE_LEVELS,
  OnboardingAnswers,
  PreferencesStepSchema,
} from './contract.js';
import type { z } from 'zod';

type Basics = z.infer<typeof BasicsStepSchema>;
type Preferences = z.infer<typeof PreferencesStepSchema>;
type Confirm = z.infer<typeof ConfirmStepSchema>;
type ExperienceLevel = (typeof ONBOARDING_EXPERIENCE_LEVELS)[number];

/** O7 levels → FilterSet seniority. */
export const LEVEL_TO_SENIORITY: Readonly<Record<ExperienceLevel, 'intern_newgrad' | 'entry' | 'mid' | 'senior' | 'lead_staff' | 'director_exec'>> = {
  internship: 'intern_newgrad',
  entry: 'entry',
  mid: 'mid',
  senior: 'senior',
  lead_staff: 'lead_staff',
  director_plus: 'director_exec',
};

/**
 * O4 company sizes → FilterSet buckets. The onboarding buckets are wider than
 * the filter's; each maps to the filter buckets it covers. "Any size" clears.
 */
export const COMPANY_SIZE_TO_FILTER: Readonly<Record<string, readonly ('1-10' | '11-50' | '51-200' | '201-1000' | '1001-5000' | '5000+')[]>> = {
  '1-50': ['1-10', '11-50'],
  '51-200': ['51-200'],
  '201-1000': ['201-1000'],
  '1001-10000': ['1001-5000', '5000+'],
  '10000+': ['5000+'],
};

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * The fields of `body` that are valid on their own (used by Skip: "Skip keeps
 * whatever was entered"). An empty or invalid field is dropped; the rest stay.
 */
export function validFieldsOf(schema: z.ZodObject, body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const value = (body as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const res = (field as z.ZodType).safeParse(value);
    if (res.success && res.data !== undefined) out[key] = res.data;
  }
  return out;
}


/**
 * O2 → filters. One country sets `country`; picked cities become location rows.
 *
 * Takes the full answers or the valid subset a skipped O2 kept: a field the
 * user did not answer is left out of the patch (the filter keeps its value),
 * so "Skip" with only countries chosen still narrows the search by country.
 * With every required field present the patch is the same as before.
 */
export function basicsToFilters(b: Partial<Basics>): FilterSetPatch {
  const patch: FilterSetPatch = {};
  if (b.jobFunctions) {
    const taxonomyIds = uniq(b.jobFunctions.map((f) => f.taxonomyId).filter((x): x is string => !!x));
    const titles = uniq(b.jobFunctions.filter((f) => !f.taxonomyId).map((f) => f.label.trim()));
    patch.taxonomyIds = taxonomyIds.length ? taxonomyIds : null;
    patch.titles = titles.length ? titles : null;
  }
  if (b.jobTypes) patch.jobTypes = uniq(b.jobTypes);
  if (b.countries) {
    const countries = uniq(b.countries.filter((c) => c !== 'REMOTE'));
    const cityRows = (b.locations ?? []).filter((l) => l.city && l.country !== 'REMOTE');
    // "Anywhere in {country}" is the country itself, never a location row:
    // a row with no city and radius 0 reads as "same city" and matched no
    // on-site job. With ONE country `country` already says it, so no row is
    // written. With several, `country` cannot hold them (it is one code), so
    // each city-less country stays a whole-country row (no city, no radius to
    // search); the feed reads such a row as "anywhere in that country".
    const single = countries.length === 1;
    const locations = [
      ...cityRows.map((l) => ({ label: l.label || l.city!, city: l.city!, country: l.country, radiusKm: 40 as const })),
      ...(single ? [] : countries.filter((c) => !cityRows.some((l) => l.country === c)).map((c) => ({ label: c, country: c, radiusKm: 0 as const }))),
    ];
    patch.country = countries.length === 1 ? countries[0] : null;
    patch.locations = locations.length ? locations : null;
  }
  if (b.countries || b.remoteOk !== undefined) {
    const countries = (b.countries ?? []).filter((c) => c !== 'REMOTE');
    const remoteAnywhere = (b.countries ?? []).includes('REMOTE');
    let workModels: FilterSetPatch['workModels'] = null;
    if (remoteAnywhere && countries.length === 0) workModels = ['remote'];
    else if (b.remoteOk === false) workModels = ['hybrid', 'onsite'];
    patch.workModels = workModels;
  }
  if (b.countries || b.needsSponsorship) {
    const answers = Object.values(b.needsSponsorship ?? {});
    patch.needsSponsorship = answers.includes('yes') ? true : answers.length > 0 && answers.every((a) => a === 'no') ? false : null;
  }
  return patch;
}

/** O4 → filters (explore branch). Missing fields clear (all optional; "Any size" = no filter). */
export function preferencesToFilters(p: Preferences): FilterSetPatch {
  const sizes = (p.companySizes ?? []).filter((s) => s !== 'any');
  const mapped = p.companySizes?.includes('any') ? [] : uniq(sizes.flatMap((s) => COMPANY_SIZE_TO_FILTER[s] ?? []));
  const models = uniq(p.workModels ?? []);
  return {
    industries: p.industries?.length ? uniq(p.industries) : null,
    skills: p.skills?.length ? uniq(p.skills.map((s) => s.trim())) : null,
    companySizes: mapped.length ? mapped : null,
    salaryMin: p.minPay ?? null,
    // All three (or none) = no restriction; basics may have set remote-only, so only override when chosen here.
    ...(models.length > 0 && models.length < 3 ? { workModels: models } : {}),
  };
}

/** O7 → filters. Extra titles are added to the O2 ones (≤3 added). */
export function confirmToFilters(c: Confirm, answers: OnboardingAnswers): FilterSetPatch {
  const basics = answers.basics;
  const base = uniq((basics?.jobFunctions ?? []).map((f) => f.taxonomyId).filter((x): x is string => !!x));
  const extra = uniq(c.extraFunctions ?? []).slice(0, 3);
  const taxonomyIds = uniq([...base, ...extra]);
  return {
    seniority: uniq(c.experienceLevels.map((l) => LEVEL_TO_SENIORITY[l])),
    ...(extra.length ? { taxonomyIds } : {}),
  };
}

/** O2 sponsorship → RAProfile.workAuth rows ("Not sure" stays unknown; ruling C18). */
export function sponsorshipToWorkAuth(
  needs: Record<string, 'yes' | 'no' | 'not_sure'> | undefined,
  existing: Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null; permit?: unknown }>,
): Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null; permit?: unknown }> | null {
  const entries = Object.entries(needs ?? {}).filter(([c]) => /^[A-Z]{2}$/.test(c));
  if (!entries.length) return null;
  const out = existing.map((r) => ({ ...r }));
  for (const [country, answer] of entries) {
    const sponsorship = answer === 'yes' ? 'now' : answer === 'no' ? 'no' : null;
    const row = out.find((r) => r.country === country);
    if (row) row.sponsorship = sponsorship;
    else out.push({ country, authorized: null, sponsorship });
  }
  return out;
}

/** O1 seeker type → the job types O2 pre-selects (PRODUCT O1 rules). */
export function defaultJobTypes(seekerType: string | undefined): Array<'full_time' | 'internship'> {
  if (seekerType === 'student') return ['internship'];
  return ['full_time'];
}

// ── Resume seed → O7 suggestions ───────────────────────────────────────────

/** Legacy seed seniority (RACareerGoal vocabulary) → O7 levels. */
export function seedSeniorityToLevels(seniority: string | null | undefined, years: number | null | undefined): ExperienceLevel[] {
  switch (seniority) {
    case 'senior':
      return ['senior'];
    case 'staff':
    case 'principal':
      return ['lead_staff'];
    case 'manager':
      return ['senior', 'lead_staff'];
    case 'director':
    case 'vp':
    case 'cxo':
      return ['director_plus'];
    default:
      break;
  }
  if (typeof years !== 'number' || !Number.isFinite(years)) return [];
  if (years < 2) return ['entry'];
  if (years < 5) return ['mid'];
  return ['senior'];
}

/** Resume titles → taxonomy ids (only confident matches; the rest are not guessed). */
export function titlesToTaxonomyIds(titles: readonly string[], minScore = 0.6): string[] {
  const out: string[] = [];
  for (const t of titles) {
    const m = bestTaxonomyMatch(t, minScore);
    if (m && !out.includes(m.id)) out.push(m.id);
  }
  return out;
}

/** Skills listed on the parsed resume (strings or grouped), deduped, ≤15. */
export function parsedResumeSkills(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const s = (parsed as { skills?: unknown }).skills;
  let raw: unknown[] = [];
  if (Array.isArray(s)) raw = s;
  else if (s && typeof s === 'object') raw = Object.values(s).flatMap((v) => (Array.isArray(v) ? v : []));
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { name?: unknown }).name : null;
    if (typeof name !== 'string') continue;
    const clean = name.trim();
    if (clean && clean.length <= 60 && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
    if (out.length >= 15) break;
  }
  return out;
}

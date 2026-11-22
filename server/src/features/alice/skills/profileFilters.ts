// server/src/features/alice/skills/profileFilters.ts — a job profile → the saved search it drives.
//
// Deterministic and pure: the same profile always writes the same filters, so
// the search and the profile cannot drift (the filters are derived again on
// every save). The feed's filters are strict (a job that lacks the field is
// dropped), so only the fields a posting reliably states become filters:
//
//   titles (the feed maps them onto its role taxonomy as well), seniority,
//   work setting (one or two settings; all three = no restriction), places
//   (only those with a country: no geography is invented; the onboarding
//   rule for whole countries), a pay floor (undisclosed pay stays in),
//   contract types, the companies the person named (never Alice's examples)
//   as "Companies you want to work at" (a boost, never a filter), companies
//   to avoid, visa sponsorship (RoboApply only).
//
// Industries, company kind and size, and skills rank instead: they go into
// the relevance text the Job scout ranks by (`relevanceText`), because a
// company record often has no industry or size and the filter would drop it.
// The market's own rules run last (`coerceFilterSet`): a field the market does
// not have is dropped.

import type { Market } from '../../../platform/brand/registry.js';
import { coerceFilterSet, type FilterLocation, type FilterSet } from '../../search/index.js';
import type { AliceBrief, AliceJobProfile, AlicePlace } from '../contract.js';

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/** Places → `country` and `locations` (the onboarding rule: one country is the country itself, never a row). */
export function placesToFilters(places: readonly AlicePlace[]): Pick<FilterSet, 'country' | 'locations'> {
  const countries = uniq(places.map((p) => p.country).filter((c): c is string => !!c));
  const cityRows: FilterLocation[] = places
    .filter((p): p is AlicePlace & { city: string; country: string } => !!p.city && !!p.country)
    .map((p) => ({ label: p.label.slice(0, 160), city: p.city, country: p.country, radiusKm: 40 }));
  const wholeCountries: FilterLocation[] =
    countries.length > 1 ? countries.filter((c) => !cityRows.some((r) => r.country === c)).map((c) => ({ label: c, country: c, radiusKm: 0 })) : [];
  const locations = [...cityRows, ...wholeCountries].slice(0, 20);
  return {
    ...(countries.length === 1 ? { country: countries[0] } : {}),
    ...(locations.length ? { locations } : {}),
  };
}

export function filtersFromProfile(profile: AliceJobProfile, brief: AliceBrief, market: Market): FilterSet {
  const titles = (profile.searchTitles.length ? profile.searchTitles : profile.titles).slice(0, 30);
  const places = profile.places.length ? profile.places : brief.places;
  const workModels = profile.workModels.length ? profile.workModels : brief.workModels;
  const jobTypes = profile.jobTypes.length ? profile.jobTypes : brief.jobTypes;
  // Only the companies the person named become their "Companies you want to work at"; Alice's examples stay in the profile (D3).
  const preferred = uniq(profile.companies.filter((c) => c.source === 'you').map((c) => c.name)).slice(0, 50);
  const avoid = uniq(brief.avoidCompanies).slice(0, 200);
  const raw: Record<string, unknown> = {
    ...(titles.length ? { titles } : {}),
    ...(profile.levels.length ? { seniority: profile.levels } : {}),
    ...(workModels.length > 0 && workModels.length < 3 ? { workModels } : {}),
    ...placesToFilters(places),
    ...(profile.pay ? { salaryMin: { amount: profile.pay.amount, currency: profile.pay.currency, period: profile.pay.period } } : {}),
    ...(jobTypes.length ? { jobTypes } : {}),
    ...(preferred.length ? { preferredCompanies: preferred } : {}),
    ...(avoid.length ? { excludedCompanies: avoid } : {}),
    ...(market === 'intl' && brief.needsSponsorship === true ? { needsSponsorship: true } : {}),
  };
  return coerceFilterSet(raw, { market }).value;
}

/** The feed refuses (never cuts) a longer text to rank by (feed contract FEED_RELEVANCE_MAX_CHARS). */
export const RELEVANCE_MAX_CHARS = 240;

/** The words the Job scout ranks by: the profile's titles, industries, skills and headline, cut at a word to ≤ 240 chars. */
export function relevanceText(profile: AliceJobProfile): string {
  const parts = [profile.searchTitles.length ? profile.searchTitles.join(', ') : profile.titles.join(', '), profile.industries.join(', '), profile.skills.join(', '), profile.headline];
  const text = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('. ');
  if (text.length <= RELEVANCE_MAX_CHARS) return text;
  const cut = text.slice(0, RELEVANCE_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > 80 ? cut.slice(0, space) : cut).trim();
}

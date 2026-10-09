// server/src/features/match/preScore.ts
//
// The deterministic pre-score (ARCHITECTURE.md §4.7; TASK_PLAN.md WP-18). Pure
// functions, no I/O, about 0.1 ms per job; the feed pre-scores every
// retrieved candidate with it, and it is the "Quick estimate" whenever the AI
// score is not available (GoApply without AI consent, the daily cap, no
// resume, a failed model call).
//
//   title_level  taxonomy overlap × seniority factor × stated eligibility
//                (same role or inside the user's target group = 1.0, same
//                group 0.6, same category 0.3; seniority 0 levels apart = 1,
//                1 = 0.7, 2 = 0.3, else 0, unknown 0.8). A stated degree
//                requirement (and, on GoApply, a stated 届别) the user does
//                not meet halves it. School tier is NEVER an input (C15).
//   skills       |job ∩ user| / min(|job|, 10)
//   industry     the employer's industries ∩ the user's past employers' industries
//   logistics    location / pay / visa, each met | not met | not stated;
//                deterministic and also used by the AI score (never a constant)
//   career_path  not stated in the pre-score (the AI score judges it)
//
// A `not_stated` component drops out and the remaining weights renormalize.
// With nothing to compare at all the score is null ("—"), never 0.

import { bestTaxonomyMatch, taxonomyAncestors, getTaxonomyNode } from '../jobs/taxonomy/index.js';
import { SENIORITY_LEVELS, type FilterLocation, type SalaryMin } from '../search/index.js';
import {
  type MatchDimension,
  type MatchDimensionKey,
  type MatchEvidence,
  type MatchTiers,
  type MatchWeights,
  type PreScoreResult,
} from './contract.js';
import { tierFor } from './config.js';

// ── Inputs ────────────────────────────────────────────────────────────────

export const DEGREE_LEVELS = ['none', 'associate', 'bachelor', 'master', 'phd'] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];
const DEGREE_RANK: Record<DegreeLevel, number> = { none: 0, associate: 1, bachelor: 2, master: 3, phd: 4 };

export function isDegreeLevel(v: unknown): v is DegreeLevel {
  return typeof v === 'string' && (DEGREE_LEVELS as readonly string[]).includes(v);
}

/** The posting fields the pre-score reads (an RAJob projection). */
export interface MatchJob {
  id: string;
  market: string;
  title: string;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  seniority: string | null;
  skills: string[];
  /** `[{ skill, kind, required }]` from enrichment. */
  skillsDetail: Array<{ skill: string; kind?: string; required: boolean }> | null;
  educationLevel: DegreeLevel | null;
  workModel: string | null;
  remoteScope: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  geoLat: number | null;
  geoLng: number | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryCurrency: string | null;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  /** From the employer's RACompany row (sourced); empty when unknown. */
  companyIndustries: string[];
  /** GoApply 届别 the posting states (marketTags `class_year:<yyyy>`), with its quote. */
  classYears: number[];
  classYearQuote: string | null;
}

/** What the pre-score knows about the user (built by context.ts; no sensitive fields). */
export interface MatchUser {
  userId: string;
  market: string;
  targetTaxonomyIds: string[];
  targetTitles: string[];
  targetSeniority: string[];
  /** Profile skills ∪ the primary resume's parsed skills (display form). */
  skills: string[];
  /**
   * The resume text, normalized (`normalizeText`), when the user has one. A
   * posting skill the parsed skill list missed still counts as shown when the
   * resume body mentions it — the same rule as the keyword check.
   */
  resumeTextNorm?: string | null;
  /** Industries of the user's past employers, from our company records. */
  employerIndustries: string[];
  locations: FilterLocation[];
  country: string | null;
  workModels: string[];
  salaryMin: SalaryMin | null;
  /** The search-profile answer; per-country `workAuth` wins when it covers the job's country. */
  needsSponsorship: boolean | null;
  workAuth: Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null }>;
  highestDegree: DegreeLevel | null;
  /** The user's own words for it (e.g. "MSc Computer Science"), for display. */
  highestDegreeLabel: string | null;
  /** GoApply 届别 (graduation class). */
  classYear: number | null;
  recentTitle: string | null;
  yearsExperience: number | null;
  searchProfileVersion: number | null;
}

export interface PreScoreConfig {
  weights: MatchWeights;
  tiers: MatchTiers;
}

// ── Small helpers ─────────────────────────────────────────────────────────

/** Comparison key for a skill: NFKC, lower case, no spaces/dots/dashes ("Node.js" = "nodejs"). */
export function skillKey(skill: string): string {
  return skill.normalize('NFKC').toLowerCase().replace(/[\s._\-/]+/g, '');
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `textNorm` (normalized) mention `term`? Whole word for Latin terms, substring otherwise. */
export function mentions(textNorm: string, term: string): boolean {
  const t = normalizeText(term).trim();
  if (!t) return false;
  if (/^[\p{Script=Latin}\p{N}\s.+#/&'-]+$/u.test(t)) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}+#])`, 'u').test(textNorm);
  }
  return textNorm.includes(t);
}

/**
 * Does the user show `term`? Their skill list (profile ∪ parsed resume), or a
 * whole-word mention in the resume text. One rule for the score, the fit
 * card and the keyword check, so they never disagree about the same skill.
 */
export function userShows(user: Pick<MatchUser, 'skills' | 'resumeTextNorm'>, term: string, skillSet?: Set<string>): boolean {
  const set = skillSet ?? new Set(user.skills.map(skillKey));
  return set.has(skillKey(term)) || (!!user.resumeTextNorm && mentions(user.resumeTextNorm, term));
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function ev(text: string, source: 'resume' | 'posting', ref: string): MatchEvidence {
  return { text, source, ref };
}

function dim(key: MatchDimensionKey, weights: MatchWeights, score: number | null, evidence: MatchEvidence[] = []): MatchDimension {
  return {
    key,
    weight: weights[key],
    score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
    status: score === null ? 'not_stated' : 'scored',
    evidence,
  };
}

/** Weighted sum over the scored components; weights renormalize; null when none is scored. */
export function combineDimensions(dimensions: MatchDimension[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const d of dimensions) {
    if (d.status !== 'scored' || d.score === null || d.weight <= 0) continue;
    sum += d.weight * d.score;
    weight += d.weight;
  }
  if (weight === 0) return null;
  return Math.round(sum / weight);
}

// ── title_level ───────────────────────────────────────────────────────────

/** Overlap of a user target node with a job node (0..1). */
export function taxonomyOverlap(target: string, jobNode: string): number {
  const jobChain = taxonomyAncestors(jobNode).map((n) => n.id);
  if (!jobChain.length || !getTaxonomyNode(target)) return 0;
  // The job sits at or under what the user asked for: an exact fit at the user's granularity.
  if (jobChain.includes(target)) return 1;
  const targetChain = taxonomyAncestors(target);
  let deepestCommon = 0;
  for (const n of targetChain) if (jobChain.includes(n.id)) deepestCommon = Math.max(deepestCommon, n.level);
  if (deepestCommon >= 2) return 0.6;
  if (deepestCommon === 1) return 0.3;
  return 0;
}

function deepestNodes(ids: string[]): string[] {
  const nodes = ids.map((id) => getTaxonomyNode(id)).filter((n): n is NonNullable<typeof n> => !!n);
  if (!nodes.length) return [];
  const max = Math.max(...nodes.map((n) => n.level));
  return nodes.filter((n) => n.level === max).map((n) => n.id);
}

function jobNodes(job: MatchJob): string[] {
  if (job.primaryTaxonomyId && getTaxonomyNode(job.primaryTaxonomyId)) return [job.primaryTaxonomyId];
  const fromIds = deepestNodes(job.taxonomyIds);
  if (fromIds.length) return fromIds;
  const m = job.title ? bestTaxonomyMatch(job.title) : null;
  return m ? [m.id] : [];
}

function userTargets(user: MatchUser): string[] {
  const ids = user.targetTaxonomyIds.filter((id) => !!getTaxonomyNode(id));
  if (ids.length) return ids;
  const fromTitles = user.targetTitles.map((t) => bestTaxonomyMatch(t)?.id).filter((x): x is string => !!x);
  if (fromTitles.length) return [...new Set(fromTitles)];
  const recent = user.recentTitle ? bestTaxonomyMatch(user.recentTitle)?.id : null;
  return recent ? [recent] : [];
}

const SENIORITY_ORDER = SENIORITY_LEVELS as readonly string[];

/** 0 levels apart = 1, 1 = 0.7, 2 = 0.3, else 0; unknown on either side = 0.8. */
export function seniorityFactor(targets: string[], jobSeniority: string | null): number {
  const j = jobSeniority ? SENIORITY_ORDER.indexOf(jobSeniority) : -1;
  const ts = targets.map((t) => SENIORITY_ORDER.indexOf(t)).filter((i) => i >= 0);
  if (j < 0 || ts.length === 0) return 0.8;
  const distance = Math.min(...ts.map((t) => Math.abs(t - j)));
  return distance === 0 ? 1 : distance === 1 ? 0.7 : distance === 2 ? 0.3 : 0;
}

/** Best overlap between the user's targets and the job's role (null when either side is unknown). */
export function titleOverlap(user: MatchUser, job: MatchJob): number | null {
  const targets = userTargets(user);
  const nodes = jobNodes(job);
  if (!targets.length || !nodes.length) return null;
  let best = 0;
  for (const t of targets) for (const n of nodes) best = Math.max(best, taxonomyOverlap(t, n));
  return best;
}

export function degreeMeets(user: DegreeLevel | null, required: DegreeLevel | null): boolean | null {
  if (!required || required === 'none') return null;
  if (!user) return null;
  return DEGREE_RANK[user] >= DEGREE_RANK[required];
}

export function titleLevelDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const overlap = titleOverlap(user, job);
  if (overlap === null) return dim('title_level', weights, null);
  const evidence: MatchEvidence[] = [ev(job.title, 'posting', 'title')];
  if (job.seniority) evidence.push(ev(job.seniority, 'posting', 'seniority'));
  let factor = seniorityFactor(user.targetSeniority, job.seniority);
  // Eligibility the posting states (F-MATCH-01: education inside "title and level";
  // GoApply: 届别/学历). Never school tier.
  if (degreeMeets(user.highestDegree, job.educationLevel) === false) {
    factor *= 0.5;
    evidence.push(ev(job.educationLevel!, 'posting', 'education_required'));
  }
  if (job.market === 'cn' && job.classYears.length && user.classYear !== null && !job.classYears.includes(user.classYear)) {
    factor *= 0.5;
    evidence.push(ev(job.classYearQuote ?? job.classYears.join(', '), 'posting', 'class_year'));
  }
  return dim('title_level', weights, 100 * overlap * factor, evidence.slice(0, 3));
}

// ── skills ────────────────────────────────────────────────────────────────

/** The posting's skills, required ones first (display form, de-duplicated). */
export function jobSkillList(job: MatchJob): Array<{ skill: string; required: boolean }> {
  const detail = (job.skillsDetail ?? []).filter((s) => s && typeof s.skill === 'string' && s.skill.trim());
  const fromDetail = detail.map((s) => ({ skill: s.skill.trim(), required: s.required === true }));
  const fromList = job.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => ({ skill: s.trim(), required: false }));
  const merged = uniqueBy([...fromDetail.filter((s) => s.required), ...fromDetail, ...fromList], (s) => skillKey(s.skill));
  return merged;
}

export function splitSkills(user: MatchUser, job: MatchJob): { aligned: string[]; missing: string[]; missingRequired: string[] } {
  const have = new Set(user.skills.map(skillKey));
  const aligned: string[] = [];
  const missing: string[] = [];
  const missingRequired: string[] = [];
  for (const s of jobSkillList(job)) {
    if (userShows(user, s.skill, have)) aligned.push(s.skill);
    else {
      missing.push(s.skill);
      if (s.required) missingRequired.push(s.skill);
    }
  }
  return { aligned, missing, missingRequired };
}

export function skillsDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const total = jobSkillList(job).length;
  if (total === 0) return dim('skills', weights, null);
  const { aligned, missing, missingRequired } = splitSkills(user, job);
  const score = Math.min(1, aligned.length / Math.min(total, 10)) * 100;
  const evidence = [
    ...aligned.slice(0, 2).map((s) => ev(s, 'resume', 'skill_have')),
    ...(missingRequired.length ? missingRequired : missing).slice(0, 1).map((s) => ev(s, 'posting', 'skill_missing')),
  ];
  return dim('skills', weights, score, evidence);
}

// ── industry ──────────────────────────────────────────────────────────────

export function industryDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const jobInd = job.companyIndustries.map((i) => i.trim()).filter(Boolean);
  const userInd = new Set(user.employerIndustries.map((i) => i.trim().toLowerCase()).filter(Boolean));
  if (!jobInd.length || !userInd.size) return dim('industry', weights, null);
  const shared = jobInd.filter((i) => userInd.has(i.toLowerCase()));
  return dim('industry', weights, shared.length ? 100 : 0, [ev(shared[0] ?? jobInd[0]!, 'posting', 'industry')]);
}

// ── logistics (deterministic; shared with the AI score) ──────────────────

export type CheckResult = 'met' | 'not_met' | 'not_stated';

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const eqi = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

function userCountries(user: MatchUser): string[] {
  const out = new Set<string>();
  if (user.country) out.add(user.country.toUpperCase());
  for (const l of user.locations) if (l.country) out.add(l.country.toUpperCase());
  return [...out];
}

export function locationCheck(user: MatchUser, job: MatchJob): CheckResult {
  const wantsRemoteOnly = user.workModels.length > 0 && user.workModels.every((m) => m === 'remote');
  const countries = userCountries(user);
  if (!user.locations.length && !user.workModels.length && !countries.length) return 'not_stated';
  if (job.workModel === 'remote') {
    if (user.workModels.length && !user.workModels.includes('remote')) return 'not_met';
    const scope = job.remoteScope?.toUpperCase() ?? null;
    if (scope && scope !== 'GLOBAL' && countries.length) return countries.includes(scope) ? 'met' : 'not_met';
    return user.workModels.includes('remote') || !scope || scope === 'GLOBAL' ? 'met' : 'not_stated';
  }
  if (wantsRemoteOnly && job.workModel) return 'not_met';
  if (!job.locationCity && !job.locationCountry && job.geoLat === null) return 'not_stated';
  if (user.locations.length) {
    for (const l of user.locations) {
      if (l.lat !== undefined && l.lng !== undefined && job.geoLat !== null && job.geoLng !== null && l.radiusKm > 0) {
        if (haversineKm(l.lat, l.lng, job.geoLat, job.geoLng) <= l.radiusKm) return 'met';
        continue;
      }
      const countryOk = !l.country || !job.locationCountry || eqi(l.country, job.locationCountry);
      if (l.city && eqi(l.city, job.locationCity) && countryOk) return 'met';
      if (!l.city && l.country && eqi(l.country, job.locationCountry)) return 'met';
    }
    return 'not_met';
  }
  if (countries.length && job.locationCountry) return countries.includes(job.locationCountry.toUpperCase()) ? 'met' : 'not_met';
  return 'not_stated';
}

const PERIOD_FACTOR: Record<string, number> = { year: 1, month: 12, hour: 2080 };

/** Pay: the job's annual max (or min) ≥ the user's annualized minimum, same currency. */
export function payCheck(user: MatchUser, job: MatchJob): CheckResult {
  if (!user.salaryMin) return 'not_stated';
  const jobTop = job.salaryAnnualMax ?? job.salaryAnnualMin;
  if (jobTop === null || jobTop === undefined || !job.salaryCurrency) return 'not_stated';
  if (job.salaryCurrency.toUpperCase() !== user.salaryMin.currency.toUpperCase()) return 'not_stated';
  const userMin = user.salaryMin.amount * (PERIOD_FACTOR[user.salaryMin.period] ?? 1);
  return jobTop >= userMin ? 'met' : 'not_met';
}

/** Does the user need sponsorship for this job's country? (TW-09: per-country answers win.) */
export function needsSponsorshipFor(user: MatchUser, job: MatchJob): boolean | null {
  const country = (job.locationCountry ?? (job.remoteScope && job.remoteScope.length === 2 ? job.remoteScope : null))?.toUpperCase();
  const entry = country ? user.workAuth.find((w) => w.country.toUpperCase() === country) : undefined;
  if (entry) {
    if (entry.sponsorship === 'now' || entry.sponsorship === 'later') return true;
    if (entry.sponsorship === 'no' || entry.authorized === true) return false;
  }
  return user.needsSponsorship;
}

/** Visa: only when the user needs sponsorship (never inferred from silence). Null = not applicable. */
export function visaCheck(user: MatchUser, job: MatchJob): CheckResult | null {
  if (job.market === 'cn') return null;
  if (needsSponsorshipFor(user, job) !== true) return null;
  if (job.sponsorship === 'offered') return 'met';
  if (job.sponsorship === 'not_offered') return 'not_met';
  return 'not_stated';
}

export interface LogisticsChecks {
  location: CheckResult;
  pay: CheckResult;
  visa: CheckResult | null;
}

export function logisticsChecks(user: MatchUser, job: MatchJob): LogisticsChecks {
  return { location: locationCheck(user, job), pay: payCheck(user, job), visa: visaCheck(user, job) };
}

function payText(job: MatchJob): string {
  const cur = job.salaryCurrency ?? '';
  const lo = job.salaryAnnualMin;
  const hi = job.salaryAnnualMax;
  const range = lo !== null && hi !== null && lo !== hi ? `${lo}–${hi}` : String(hi ?? lo ?? '');
  return `${cur} ${range}`.trim();
}

export function logisticsDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const c = logisticsChecks(user, job);
  const stated = [c.location, c.pay, c.visa].filter((x): x is 'met' | 'not_met' => x === 'met' || x === 'not_met');
  if (!stated.length) return dim('logistics', weights, null);
  const met = stated.filter((x) => x === 'met').length;
  const evidence: MatchEvidence[] = [];
  const where = job.workModel === 'remote' ? (job.location ?? 'remote') : job.location ?? [job.locationCity, job.locationCountry].filter(Boolean).join(', ');
  if (c.location !== 'not_stated' && where) evidence.push(ev(where, 'posting', c.location === 'met' ? 'location_met' : 'location_not_met'));
  if (c.pay !== 'not_stated') evidence.push(ev(payText(job), 'posting', c.pay === 'met' ? 'pay_met' : 'pay_not_met'));
  if (c.visa === 'met' || c.visa === 'not_met') {
    // Only the post's own words are quoted; with no quote the line says so without one
    // (the `sponsorship` enum is a schema value, never shown as a quote).
    evidence.push(ev(job.sponsorshipEvidence?.trim() ?? '', 'posting', c.visa === 'met' ? 'visa_offered' : 'visa_not_offered'));
  }
  return dim('logistics', weights, (100 * met) / stated.length, evidence);
}

// ── The pre-score ─────────────────────────────────────────────────────────

/** The five components of the pre-score (career_path is never stated here). */
export function preScoreDimensions(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension[] {
  return [
    titleLevelDimension(user, job, weights),
    skillsDimension(user, job, weights),
    industryDimension(user, job, weights),
    logisticsDimension(user, job, weights),
    dim('career_path', weights, null),
  ];
}

/** One overlap and one gap for a card, from real fields only. */
export function overlapAndGap(user: MatchUser, job: MatchJob): { topOverlap: string | null; topGap: string | null } {
  const { aligned, missing, missingRequired } = splitSkills(user, job);
  return { topOverlap: aligned[0] ?? null, topGap: missingRequired[0] ?? missing[0] ?? null };
}

export function preScore(user: MatchUser, job: MatchJob, config: PreScoreConfig): PreScoreResult {
  const dimensions = preScoreDimensions(user, job, config.weights);
  const score = combineDimensions(dimensions);
  return { jobId: job.id, score, tier: tierFor(score, config.tiers), kind: 'pre', dimensions, ...overlapAndGap(user, job) };
}

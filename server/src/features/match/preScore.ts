// server/src/features/match/preScore.ts
//
// The quick estimate, version 2 (MARKET_STRATEGY 2.2, 2.4; SM-3). Pure
// functions, no I/O, about 0.1 ms per job. It is what every surface shows when
// no AI score exists for the job (fit.ts assembles the fit), and it answers the
// same question as the AI score with less information, saying how sure it is.
//
//   title_level  role overlap × level factor × stated eligibility. The role is
//                the one the person's own record shows (`evidenceRoleIds`: the
//                two most recent titles and a headline that names a role),
//                graded same role 1.0, same group 0.6, same category 0.3. The
//                level is the resume's (most recent title, else years of
//                experience), 0 levels apart = 1, 1 = 0.7, 2 = 0.3, else 0,
//                unknown 0.8. Neither is ever read from the saved search:
//                editing the Role or Level chips moves no fit (invariant I3).
//                A stated degree requirement (and, on GoApply, a stated 届别)
//                the person does not meet halves it. School tier is NEVER an
//                input (C15); an age limit in a posting is never read.
//   skills       hard skills only: Σ weight shown / Σ weight listed over the
//                first 10 (required 1, preferred 0.5). Soft skills are shown
//                and never counted.
//   industry     the employer's industries ∩ the person's past employers' industries
//   logistics    location / pay / visa, each met | not met | not stated. A
//                location or pay check that is met only because the saved
//                search filters on it says nothing new: when every stated
//                check is like that the part is not compared (it counts at
//                its prior like any part that cannot be compared), and its
//                evidence line says so. An offered sponsorship is always a
//                fact of the posting: "I need sponsorship" only removes
//                postings that say no.
//   career_path  never stated in the estimate (the AI score judges it)
//
// Priors, not renormalisation. A component that cannot be compared contributes
// its PRIOR (the long-run mean of that component over AI scores) at its full
// weight, so a posting that says little cannot score high by saying little:
// total = Σ weight × (score or prior) / Σ weight. A posting with no skills, a
// perfect title and logistics really met gives 64.8.
//
// Honesty limits stay as a second guard (FIX-3; D3):
//   · Neither the role nor the skills could be compared → no score at all
//     (null, "—"): location, pay and industry say nothing about the work.
//   · Only one of the two could be compared → never Great.
//   · Under half of the comparable weight was compared → Possible at most.
//   · The job is two or more levels away from the resume's level (an
//     internship for a senior engineer) → Possible at most.
//   · The posting states under 60% of the rubric → never Great, and the
//     confidence is low (invariant I4).
//
// Coverage and confidence. `coverage` is the share of the rubric weight backed
// by stated evidence on both sides (career_path never counts; a logistics part
// met only through the person's own filters is not compared). High from 0.75,
// medium from 0.5, low below; low also when the posting states under 60% of
// the rubric or the level is only an onboarding answer.

import { seniorityFromTitle, taxonomyIdsForTitle } from '../jobs/normalize/index.js';
import { taxonomyAncestors, getTaxonomyNode } from '../jobs/taxonomy/index.js';
import { SENIORITY_LEVELS, type FilterLocation, type SalaryMin } from '../search/index.js';
import {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_MATCH_PRIORS,
  POSTING_COVERAGE_MIN,
  type ConfidenceReason,
  type EstimateResult,
  type FitConfidence,
  type MatchDimension,
  type MatchDimensionKey,
  type MatchEvidence,
  type MatchPriors,
  type MatchTiers,
  type MatchWeights,
} from './contract.js';
import { tierFor } from './config.js';
import { dedupeTerms, displayTerm, isEverydayWord, showingTerms, termKey, termParts, titleShows } from './terms.js';

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
  /**
   * The pay as the posting writes it ("18-28K·15薪", "$90k–$110k a year").
   * Shown as the pay evidence instead of the annualized figures the check
   * compares with, which the posting never states.
   */
  payAsPosted?: string | null;
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
  /**
   * The Role, Title and Level chips of the saved search: what the person says
   * they are looking for. Passed to the AI scorer as the stated target and
   * shown by the keyword check; NOT inputs of the estimate (invariant I3).
   */
  targetTaxonomyIds: string[];
  targetTitles: string[];
  targetSeniority: string[];
  /**
   * The roles the person's own record shows, as taxonomy ids: their two most
   * recent experience titles and a headline that names a role (context.ts).
   * The only role input of the estimate. Absent (a hand-built user): derived
   * here from `recentTitle`.
   */
  evidenceRoleIds?: string[];
  /**
   * The level the resume shows (context.ts). When absent it is derived here
   * from `recentTitle` and `yearsExperience` (`resumeSeniority`).
   */
  resumeSeniority?: string | null;
  /**
   * Where that level comes from: the person's record, or (no resume and no
   * experience on file) the onboarding answer, which makes the confidence low.
   */
  levelSource?: 'record' | 'onboarding' | null;
  /** False when the person has no resume on file (MatchService sets it). */
  hasResume?: boolean;
  /**
   * Which logistics answers the saved search filters on (context.ts). A check
   * met only through such a filter adds no information. Absent (a hand-built
   * user): location when `locations`, `workModels` or `country` is set, pay
   * when `salaryMin` is set. There is no visa entry: the sponsorship filter
   * only removes postings that say no, so "this posting offers sponsorship"
   * is never guaranteed by it.
   */
  hardFilters?: { location: boolean; pay: boolean };
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
  /** What a not-stated component contributes (config `getMatchPriors`; the starting priors when absent). */
  priors?: MatchPriors;
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

/** What the check reads about the user: their skills, the resume text, and (for a practice a title shows) the latest title. */
export type ShownSource = Pick<MatchUser, 'skills' | 'resumeTextNorm'> & { recentTitle?: string | null };

/** The term itself, or its singular / plural ("REST APIs" on the post, "REST API" on the resume). */
function spellings(term: string): string[] {
  const t = term.trim();
  const out = [t];
  const m = t.match(/^(.*?)([A-Za-z]+)$/);
  if (m) {
    const [, head, last] = m as unknown as [string, string, string];
    if (/s$/i.test(last) && last.length > 3) out.push(`${head}${last.replace(/ies$/i, 'y').replace(/s$/i, '')}`);
    else out.push(`${head}${last}s`);
  }
  return [...new Set(out)];
}

/** Is `term` in the person's own skill list (profile ∪ parsed resume)? */
function inSkillList(user: ShownSource, term: string, skillSet: Set<string>): boolean {
  if (skillSet.has(skillKey(term))) return true;
  const key = termKey(term);
  return user.skills.some((s) => termKey(s) === key);
}

function literallyShown(user: ShownSource, term: string, skillSet: Set<string>): boolean {
  if (inSkillList(user, term, skillSet)) return true;
  // One character ("C", "R") says nothing in lower-cased prose ("Series C"): the skill list only.
  if ([...term.trim()].length < 2) return false;
  return !!user.resumeTextNorm && spellings(term).some((v) => mentions(user.resumeTextNorm!, v));
}

/**
 * Does the user show `term`, and by what? `via` is null when the resume or
 * the skill list names the term itself; otherwise it is the named technology
 * (or the title) that shows it: a post asking for "relational databases" is
 * met by a resume that lists PostgreSQL, "software engineering" by a Software
 * Engineer. Only specific → general (terms.ts); the caller can say which.
 *
 * A named technology that is also an everyday word (rest, excel, swift,
 * react, oracle…) shows the broader term only from the skill list: "handed
 * the rest of the migration" is not REST, and "Account manager at Oracle" is
 * not a database. Its unmistakable forms ("REST API", "Oracle Database")
 * count from the text like any other name.
 */
export function shownVia(user: ShownSource, term: string, skillSet?: Set<string>): { shown: boolean; via: string | null } {
  const set = skillSet ?? new Set(user.skills.map(skillKey));
  if (literallyShown(user, term, set)) return { shown: true, via: null };
  for (const specific of showingTerms(term)) {
    const named = isEverydayWord(specific) ? inSkillList(user, specific, set) : literallyShown(user, specific, set);
    if (named) return { shown: true, via: displayTerm(specific) };
  }
  if (titleShows(user.recentTitle, term)) return { shown: true, via: user.recentTitle!.trim() };
  // "TypeScript/Node.js" is shown by a resume that shows each of the two.
  const parts = termParts(term);
  if (parts.length > 1 && parts.every((p) => shownVia(user, p, set).shown)) return { shown: true, via: null };
  return { shown: false, via: null };
}

/**
 * Does the user show `term`? Their skill list (profile ∪ parsed resume), a
 * whole-word mention in the resume text, or a named technology that shows it
 * (`shownVia`). One rule for the score, the fit card and the keyword check,
 * so they never disagree about the same skill.
 */
export function userShows(user: ShownSource, term: string, skillSet?: Set<string>): boolean {
  return shownVia(user, term, skillSet).shown;
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

/**
 * The estimate's total: every component at its FULL weight, a not-stated one
 * at its prior. total = Σ weight × (score or prior) / Σ weight, rounded. Null
 * only when every weight is 0.
 */
export function combineWithPriors(dimensions: MatchDimension[], priors: MatchPriors = DEFAULT_MATCH_PRIORS): number | null {
  let sum = 0;
  let weight = 0;
  for (const d of dimensions) {
    if (d.weight <= 0) continue;
    const value = d.status === 'scored' && d.score !== null ? d.score : priors[d.key];
    sum += d.weight * value;
    weight += d.weight;
  }
  if (weight === 0) return null;
  return Math.round(sum / weight);
}

/**
 * The AI score's total: the weighted sum over the scored components, weights
 * renormalised; null when none is scored. (The estimate uses
 * `combineWithPriors`; scorer v4 replaces this arithmetic.)
 */
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
  const fromTitle = roleIdOfTitle(job.title);
  return fromTitle ? [fromTitle] : [];
}

/**
 * The taxonomy role a title names, or null ("Teacher" → school_teacher). The
 * same rule that places a posting's title at ingest (`taxonomyIdsForTitle`),
 * so a person's title and a posting's title land on the same node: a Taiwan
 * title (資深後端工程師, 資料分析師) is folded to the vocabulary the role tree
 * carries, for the match only.
 */
export function roleIdOfTitle(title: string | null | undefined): string | null {
  const t = typeof title === 'string' ? title.trim() : '';
  return t ? taxonomyIdsForTitle(t).primary : null;
}

/**
 * The roles the person's record shows: `evidenceRoleIds` when context.ts built
 * the user, else the role their most recent title names. Never the saved
 * search (targetTaxonomyIds, targetTitles): a job inside the Role filter is
 * not a fit because it passed the filter.
 */
export function evidenceRoles(user: Pick<MatchUser, 'evidenceRoleIds' | 'recentTitle'>): string[] {
  if (user.evidenceRoleIds !== undefined) return [...new Set(user.evidenceRoleIds.filter((id) => !!getTaxonomyNode(id)))];
  const recent = roleIdOfTitle(user.recentTitle);
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

/**
 * The level a resume shows: the level its most recent title states ("Senior
 * Software Engineer", "Engineering Intern"), else the band the years of
 * (non-internship) experience imply. Null when the resume shows neither.
 */
export function resumeSeniority(recentTitle: string | null | undefined, yearsExperience: number | null | undefined): string | null {
  const stated = recentTitle ? seniorityFromTitle(recentTitle) : null;
  if (stated) return stated;
  if (yearsExperience === null || yearsExperience === undefined || !Number.isFinite(yearsExperience) || yearsExperience < 0) return null;
  if (yearsExperience < 1) return 'intern_newgrad';
  if (yearsExperience < 3) return 'entry';
  if (yearsExperience < 6) return 'mid';
  if (yearsExperience < 10) return 'senior';
  return 'lead_staff';
}

/** The user's own level for scoring: the resume's, never the search's Level chips. */
export function userLevel(user: Pick<MatchUser, 'resumeSeniority' | 'recentTitle' | 'yearsExperience'>): string | null {
  return user.resumeSeniority !== undefined ? user.resumeSeniority : resumeSeniority(user.recentTitle, user.yearsExperience);
}

/** Levels between the resume and the job (0 = same); null when either side is unknown. */
export function levelGap(user: Pick<MatchUser, 'resumeSeniority' | 'recentTitle' | 'yearsExperience'>, jobSeniority: string | null): number | null {
  const mine = userLevel(user);
  const u = mine ? SENIORITY_ORDER.indexOf(mine) : -1;
  const j = jobSeniority ? SENIORITY_ORDER.indexOf(jobSeniority) : -1;
  return u < 0 || j < 0 ? null : Math.abs(u - j);
}

/**
 * Best overlap between the roles the person's record shows and the job's role
 * (same role 1.0, same group 0.6, same category 0.3, else 0); null when either
 * side is unknown. The saved search is not read.
 */
export function titleOverlap(user: Pick<MatchUser, 'evidenceRoleIds' | 'recentTitle'>, job: MatchJob): number | null {
  const roles = evidenceRoles(user);
  const nodes = jobNodes(job);
  if (!roles.length || !nodes.length) return null;
  let best = 0;
  for (const t of roles) for (const n of nodes) best = Math.max(best, taxonomyOverlap(t, n));
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
  const mine = userLevel(user);
  let factor = seniorityFactor(mine ? [mine] : [], job.seniority);
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

export interface JobSkill {
  skill: string;
  required: boolean;
  /** `soft` only when enrichment marked it so (`skillsDetail.kind`); a skill with no detail entry counts as hard. */
  kind: 'hard' | 'soft';
}

/**
 * The posting's skills, required ones first, one entry per thing and in the
 * spelling a reader expects (terms.ts: "typescript/node.js" is dropped next
 * to "TypeScript" and "Node.js"; "go" is written "Go").
 */
export function jobSkillList(job: MatchJob): JobSkill[] {
  const detail = (job.skillsDetail ?? []).filter((s) => s && typeof s.skill === 'string' && s.skill.trim());
  const kindOf = new Map<string, JobSkill['kind']>();
  for (const s of detail) {
    const key = skillKey(s.skill);
    if (!kindOf.has(key)) kindOf.set(key, s.kind === 'soft' ? 'soft' : 'hard');
  }
  const kind = (skill: string): JobSkill['kind'] => kindOf.get(skillKey(skill)) ?? 'hard';
  const fromDetail = detail.map((s) => ({ skill: s.skill.trim(), required: s.required === true, kind: kind(s.skill) }));
  const fromList = job.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => ({ skill: s.trim(), required: false, kind: kind(s) }));
  const merged = uniqueBy([...fromDetail.filter((s) => s.required), ...fromDetail, ...fromList], (s) => skillKey(s.skill));
  return dedupeTerms(merged, (s) => s.skill).map((s) => ({ skill: displayTerm(s.skill), required: s.required, kind: s.kind }));
}

/** The skills that are compared and counted: everything the posting lists that is not a soft skill. */
export function hardSkillList(job: MatchJob): JobSkill[] {
  return jobSkillList(job).filter((s) => s.kind !== 'soft');
}

/** Hard skills counted by the number: the first this many, required ones first. */
export const SKILLS_COUNTED_MAX = 10;
const skillWeight = (s: Pick<JobSkill, 'required'>): number => (s.required ? 1 : 0.5);

/**
 * The posting's hard skills the person shows and the ones they do not, plus
 * the soft skills it names (`softSkills`: shown on the card, never compared
 * and never part of the number).
 */
export function splitSkills(user: MatchUser, job: MatchJob): { aligned: string[]; missing: string[]; missingRequired: string[]; softSkills: string[] } {
  const have = new Set(user.skills.map(skillKey));
  const aligned: string[] = [];
  const missing: string[] = [];
  const missingRequired: string[] = [];
  const softSkills: string[] = [];
  for (const s of jobSkillList(job)) {
    if (s.kind === 'soft') softSkills.push(s.skill);
    else if (userShows(user, s.skill, have)) aligned.push(s.skill);
    else {
      missing.push(s.skill);
      if (s.required) missingRequired.push(s.skill);
    }
  }
  return { aligned, missing, missingRequired, softSkills };
}

/**
 * 100 × Σ weight shown / Σ weight listed, over the first 10 hard skills
 * (required 1, preferred 0.5). Not stated when the posting lists no hard skill.
 */
export function skillsDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const counted = hardSkillList(job).slice(0, SKILLS_COUNTED_MAX);
  if (!counted.length) return dim('skills', weights, null);
  const have = new Set(user.skills.map(skillKey));
  let shown = 0;
  let listed = 0;
  for (const s of counted) {
    listed += skillWeight(s);
    if (userShows(user, s.skill, have)) shown += skillWeight(s);
  }
  const { aligned, missing, missingRequired } = splitSkills(user, job);
  const evidence = [
    ...aligned.slice(0, 2).map((s) => ev(s, 'resume', 'skill_have')),
    ...(missingRequired.length ? missingRequired : missing).slice(0, 1).map((s) => ev(s, 'posting', 'skill_missing')),
  ];
  return dim('skills', weights, (100 * shown) / listed, evidence);
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
  // The posting's own words first: "18-28K·15薪" is what it says, "CNY 270000–420000" is our arithmetic.
  if (job.payAsPosted?.trim()) return job.payAsPosted.trim();
  const cur = job.salaryCurrency ?? '';
  const lo = job.salaryAnnualMin;
  const hi = job.salaryAnnualMax;
  const range = lo !== null && hi !== null && lo !== hi ? `${lo}–${hi}` : String(hi ?? lo ?? '');
  return `${cur} ${range}`.trim();
}

function logisticsEvidence(c: LogisticsChecks, job: MatchJob): MatchEvidence[] {
  const evidence: MatchEvidence[] = [];
  const where = job.workModel === 'remote' ? (job.location ?? 'remote') : job.location ?? [job.locationCity, job.locationCountry].filter(Boolean).join(', ');
  if (c.location !== 'not_stated' && where) evidence.push(ev(where, 'posting', c.location === 'met' ? 'location_met' : 'location_not_met'));
  if (c.pay !== 'not_stated') evidence.push(ev(payText(job), 'posting', c.pay === 'met' ? 'pay_met' : 'pay_not_met'));
  if (c.visa === 'met' || c.visa === 'not_met') {
    // Only the post's own words are quoted; with no quote the line says so without one
    // (the `sponsorship` enum is a schema value, never shown as a quote).
    evidence.push(ev(job.sponsorshipEvidence?.trim() ?? '', 'posting', c.visa === 'met' ? 'visa_offered' : 'visa_not_offered'));
  }
  return evidence;
}

/**
 * Location, pay and visa as facts: 100 × met / stated. The form the AI score
 * uses (its total keeps today's arithmetic). The estimate reads
 * `logisticsForEstimate`.
 */
export function logisticsDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const c = logisticsChecks(user, job);
  const stated = [c.location, c.pay, c.visa].filter((x): x is 'met' | 'not_met' => x === 'met' || x === 'not_met');
  if (!stated.length) return dim('logistics', weights, null);
  const met = stated.filter((x) => x === 'met').length;
  return dim('logistics', weights, (100 * met) / stated.length, logisticsEvidence(c, job));
}

/** Evidence ref of a logistics part that is not compared because the person's own filters guarantee every stated check. */
export const LOGISTICS_BY_FILTERS_REF = 'logistics_by_your_filters';

/** Is this the logistics part of an estimate that only repeats the person's own filters (no information of its own)? */
export function isByFilters(dimension: Pick<MatchDimension, 'key' | 'evidence'>): boolean {
  return dimension.key === 'logistics' && dimension.evidence.some((e) => e.ref === LOGISTICS_BY_FILTERS_REF);
}

/** Which logistics answers the person's saved search filters on (see `MatchUser.hardFilters`). */
export function hardFiltersOf(user: MatchUser): { location: boolean; pay: boolean } {
  if (user.hardFilters) return { location: user.hardFilters.location, pay: user.hardFilters.pay };
  return {
    location: user.locations.length > 0 || user.workModels.length > 0 || !!user.country,
    pay: !!user.salaryMin,
  };
}

/**
 * Logistics for the estimate. A `not_met` check is a real penalty, as in
 * `logisticsDimension`. A location or pay check that is met only because the
 * saved search makes that field a hard filter carries no information: when
 * every stated check is met and each is filter-guaranteed, the part is NOT
 * COMPARED (`byFilters`). It is returned as not stated, so the total counts it
 * at the logistics prior like any part that cannot be compared, coverage and
 * the honesty limits leave it out, and no surface shows a number nobody
 * measured. Its one evidence line (ref `logistics_by_your_filters`) quotes the
 * posting's place and pay words the filters already guaranteed.
 *
 * The visa check is never filter-guaranteed: the "I need sponsorship" filter
 * (feed/sql.ts) removes only postings that say they do not sponsor, so a
 * posting that says it does is a fact of the posting.
 *
 * The rule reads the person and the job only, never the surface the job was
 * opened from, so every surface gets the same number.
 */
export function logisticsForEstimate(user: MatchUser, job: MatchJob, weights: MatchWeights): { dimension: MatchDimension; byFilters: boolean } {
  const c = logisticsChecks(user, job);
  const hard = hardFiltersOf(user);
  const checks: Array<{ result: CheckResult | null; guaranteed: boolean }> = [
    { result: c.location, guaranteed: hard.location },
    { result: c.pay, guaranteed: hard.pay },
    { result: c.visa, guaranteed: false },
  ];
  const stated = checks.filter((x) => x.result === 'met' || x.result === 'not_met');
  if (!stated.length) return { dimension: dim('logistics', weights, null), byFilters: false };
  const met = stated.filter((x) => x.result === 'met').length;
  const evidence = logisticsEvidence(c, job);
  if (met === stated.length && stated.every((x) => x.guaranteed)) {
    // The posting's own place and pay words; with none to quote the part is a plain not-stated one (never an empty line).
    const words = evidence.map((e) => e.text.trim()).filter(Boolean).join(' · ');
    return { dimension: dim('logistics', weights, null, words ? [ev(words, 'posting', LOGISTICS_BY_FILTERS_REF)] : []), byFilters: true };
  }
  return { dimension: dim('logistics', weights, (100 * met) / stated.length, evidence), byFilters: false };
}

// ── The estimate ──────────────────────────────────────────────────────────

/** The five components of the estimate (career_path is never stated here). */
export function preScoreDimensions(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension[] {
  return [
    titleLevelDimension(user, job, weights),
    skillsDimension(user, job, weights),
    industryDimension(user, job, weights),
    logisticsForEstimate(user, job, weights).dimension,
    dim('career_path', weights, null),
  ];
}

/** One overlap and one gap for a card, from real fields only. */
export function overlapAndGap(user: MatchUser, job: MatchJob): { topOverlap: string | null; topGap: string | null } {
  const { aligned, missing, missingRequired } = splitSkills(user, job);
  return { topOverlap: aligned[0] ?? null, topGap: missingRequired[0] ?? missing[0] ?? null };
}

/**
 * The most a quick estimate may claim for what was actually compared (see the
 * header): null = no score at all, else an upper limit for the total. A part
 * that is not stated was not compared (a logistics part met only through the
 * person's filters is one).
 */
export function preScoreLimit(dimensions: MatchDimension[], gap: number | null, tiers: MatchTiers): number | null {
  const backed = (d: MatchDimension) => d.status === 'scored' && d.score !== null && d.weight > 0;
  const scored = (key: MatchDimensionKey) => dimensions.some((d) => d.key === key && backed(d));
  const role = scored('title_level');
  const skills = scored('skills');
  // Location, pay and industry alone say nothing about the work itself.
  if (!role && !skills) return null;
  let limit = 100;
  if (!role || !skills) limit = Math.min(limit, tiers.great - 1);
  // career_path is never stated in the estimate, so it is not part of what could have been compared.
  const comparable = dimensions.filter((d) => d.key !== 'career_path' && d.weight > 0);
  const total = comparable.reduce((sum, d) => sum + d.weight, 0);
  const compared = comparable.filter(backed).reduce((sum, d) => sum + d.weight, 0);
  if (total > 0 && compared / total < 0.5) limit = Math.min(limit, tiers.good - 1);
  if (gap !== null && gap >= 2) limit = Math.min(limit, tiers.good - 1);
  return Math.max(0, limit);
}

const EPS = 1e-9;

/**
 * Share of the rubric weight backed by stated evidence on BOTH sides, 0–1:
 * the weights of the scored parts over all weights. career_path never counts
 * for an estimate; a logistics part met only through the person's own filters
 * is not scored, so it does not count either.
 */
export function coverageOf(dimensions: MatchDimension[]): number {
  const total = dimensions.reduce((sum, d) => sum + Math.max(0, d.weight), 0);
  if (total <= 0) return 0;
  const backed = dimensions
    .filter((d) => d.key !== 'career_path' && d.status === 'scored' && d.score !== null && d.weight > 0)
    .reduce((sum, d) => sum + d.weight, 0);
  return backed / total;
}

/** What the posting itself states, part by part. */
export function postingStates(job: MatchJob): { role: boolean; level: boolean; skills: boolean; industry: boolean; logistics: boolean } {
  const paid = job.salaryAnnualMin !== null || job.salaryAnnualMax !== null || !!job.payAsPosted?.trim();
  const placed = !!job.locationCity || !!job.locationCountry || job.geoLat !== null || !!job.workModel;
  return {
    role: jobNodes(job).length > 0,
    level: !!job.seniority && SENIORITY_ORDER.includes(job.seniority),
    skills: hardSkillList(job).length > 0,
    industry: job.companyIndustries.some((i) => i.trim()),
    logistics: placed || paid,
  };
}

/**
 * Share of the rubric weight the POSTING states, 0–1: its role and level
 * (title_level; half of it when a role is placed but no level is stated, none
 * without a role), its hard skills, the employer's industry, and a location or
 * pay. career_path is the person's side and is left out of the denominator.
 * A job with no skills and no level therefore states under 60% whatever else
 * it says (invariant I4).
 */
export function postingCoverageOf(job: MatchJob, weights: MatchWeights): number {
  const total = weights.title_level + weights.skills + weights.industry + weights.logistics;
  if (total <= 0) return 0;
  const st = postingStates(job);
  const stated =
    weights.title_level * (st.role ? (st.level ? 1 : 0.5) : 0) +
    (st.skills ? weights.skills : 0) +
    (st.industry ? weights.industry : 0) +
    (st.logistics ? weights.logistics : 0);
  return stated / total;
}

/** High from 0.75, medium from 0.5, low below; always low when `forcedLow` (a thin posting, an onboarding-only level). */
export function confidenceFor(coverage: number, forcedLow = false): FitConfidence {
  if (forcedLow || coverage < CONFIDENCE_THRESHOLDS.medium - EPS) return 'low';
  return coverage >= CONFIDENCE_THRESHOLDS.high - EPS ? 'high' : 'medium';
}

/** The first reason that applies to a low-confidence estimate, in the published order. */
export function confidenceReasonFor(user: Pick<MatchUser, 'evidenceRoleIds' | 'recentTitle' | 'hasResume'>, job: MatchJob): ConfidenceReason {
  const st = postingStates(job);
  if (!st.skills) return 'no_skills_listed';
  if (!st.level) return 'no_level_stated';
  if (!evidenceRoles(user).length) return 'no_role_evidence';
  if (user.hasResume === false) return 'no_resume';
  return 'few_details';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function preScore(user: MatchUser, job: MatchJob, config: PreScoreConfig): EstimateResult {
  const priors = config.priors ?? DEFAULT_MATCH_PRIORS;
  const dimensions = preScoreDimensions(user, job, config.weights);
  const combined = combineWithPriors(dimensions, priors);
  const coverage = coverageOf(dimensions);
  const postingCoverage = postingCoverageOf(job, config.weights);
  const thin = postingCoverage < POSTING_COVERAGE_MIN - EPS;
  let limit = preScoreLimit(dimensions, levelGap(user, job.seniority), config.tiers);
  // I4: a posting that states under 60% of the rubric is never Great.
  if (limit !== null && thin) limit = Math.min(limit, config.tiers.great - 1);
  const score = combined === null || limit === null ? null : Math.min(combined, limit);
  const confidence = confidenceFor(coverage, thin || user.levelSource === 'onboarding');
  const split = splitSkills(user, job);
  return {
    jobId: job.id,
    score,
    tier: tierFor(score, config.tiers),
    kind: 'pre',
    dimensions,
    topOverlap: split.aligned[0] ?? null,
    topGap: split.missingRequired[0] ?? split.missing[0] ?? null,
    coverage: round3(coverage),
    confidence,
    confidenceReason: confidence === 'low' ? confidenceReasonFor(user, job) : null,
    postingCoverage: round3(postingCoverage),
    softSkills: split.softSkills,
    limit,
  };
}

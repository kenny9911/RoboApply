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
//   skills       hard canonical skills only: Σ weight × credit / Σ weight over
//                the first 10 (required 1, preferred 0.5). A posting written
//                by enrichment v3 carries a canonical skill id per skill
//                (features/skills): the person's own ids decide, shown counts
//                the whole weight, a more specific skill that shows a broader
//                one (PostgreSQL for "relational databases") counts half, and
//                a skill nobody has reviewed is shown and never counted. Such
//                a posting's `skillsDetail` is its list of skills, one entry
//                per skill; `skills` keeps every spelling for search, and a
//                second spelling is never a second skill. A skill with no id
//                (every skill of a posting that has not been re-enriched, and
//                a string enrichment could not map) is compared by its
//                string, exactly as before (terms.ts): the number, its
//                evidence lines and the card's overlap and gap of such a
//                posting do not move until it is re-enriched. A reviewed
//                skill whose only trace in the resume is an abbreviation with
//                another reading ("500 ml" for Machine learning) is neither
//                claimed nor denied. Soft skills are shown and never counted.
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
import { EVERYDAY_WORDS, aliasKey, current as currentVocabulary, evidenceFor, isListOnlyWord, skillIdsInText, userSkillIds, type SkillSnapshot } from '../skills/index.js';
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
  /**
   * `[{ skill, kind, required, skillId, via }]` from enrichment. `skillId` is
   * the canonical skill (RASkill) enrichment v3 mapped the string to; absent
   * or null on a row it has not written yet. `via` says how the id was found
   * when enrichment stores it: `embedding` is a machine guess (the nearest
   * skill by vector), not a name the vocabulary knows.
   */
  skillsDetail: Array<{ skill: string; kind?: string; required: boolean; skillId?: string | null; via?: string | null }> | null;
  /**
   * RAJob.skillIds: the canonical ids of the posting's hard skills and
   * certificates. Empty or absent on a row enrichment v3 has not written yet:
   * such a posting is compared by its strings.
   */
  skillIds?: string[];
  /**
   * RAJob.lang, the language of the posting's text when it is known: 'en',
   * 'zh-Hans', 'zh-Hant', 'ja', 'ko' or 'other' (features/retrieval/lang.ts).
   * An English or Chinese posting is labelled in its own language when the
   * reader's is not known (`labelLocaleFor`); any other value says nothing
   * about labels, which exist in English and two Chinese scripts only.
   */
  lang?: string | null;
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
  /**
   * The language this request reads skill labels in ('en', 'zh', 'zh-TW', …).
   * Absent: the posting's own language, else the market's (`labelLocaleFor`).
   */
  locale?: string | null;
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

/**
 * A letter or digit that continues a word written with spaces. A Chinese,
 * Japanese or Korean character does not: those scripts write no spaces, so
 * "使用Go开发" names Go and "熟悉Java和Python" names both.
 */
const WORD_CHAR = String.raw`(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])`;

/** Does `textNorm` (normalized) mention `term`? Whole word for Latin terms, substring otherwise. */
export function mentions(textNorm: string, term: string): boolean {
  const t = normalizeText(term).trim();
  // The term's own characters must be in the text for either rule to find it: most skills of a posting are not in a
  // given resume, and this answers for them without building a pattern.
  if (!t || !textNorm.includes(t)) return false;
  if (/^[\p{Script=Latin}\p{N}\s.+#/&'-]+$/u.test(t)) {
    return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(t)}(?!${WORD_CHAR}|[+#])`, 'u').test(textNorm);
  }
  return true;
}

/** What the check reads about the user: their skills, the resume text, and (for a practice a title shows) the latest title. */
export type ShownSource = Pick<MatchUser, 'skills' | 'resumeTextNorm'> & { recentTitle?: string | null; locale?: string | null };

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
 * Does the user show the bare `term` (a term the model picked, a skill of the
 * competitiveness report)? Their skill list (profile ∪ parsed resume), a
 * whole-word mention in the resume text, a named technology that shows it
 * (`shownVia`), or, when the vocabulary knows the term as a reviewed skill,
 * the person's canonical skills (`termCheck`). A skill of a posting is asked
 * through `jobSkillCheck` (the number and the card) and `listedSkillCheck`
 * (the keyword check).
 */
export function userShows(user: ShownSource, term: string, skillSet?: Set<string>): boolean {
  const state = termCheck(user, term, { skillSet }).state;
  return state === 'shown' || state === 'related';
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
  if (classYearExcluded(user, job)) {
    factor *= 0.5;
    evidence.push(ev(job.classYearQuote ?? job.classYears.join(', '), 'posting', 'class_year'));
  }
  return dim('title_level', weights, 100 * overlap * factor, evidence.slice(0, 3));
}

// ── skills ────────────────────────────────────────────────────────────────

/**
 * One skill a posting asks for.
 *
 * `skillId` is the canonical skill the posting's own record carries
 * (enrichment v3 writes it into `skillsDetail`), resolved through the
 * vocabulary so an id that was merged into another skill is that skill. It is
 * null on a posting that has not been re-enriched: nothing here looks a string
 * up to make one, so such a posting keeps the number it had. (A string is
 * looked up only to find which stored entry it is another spelling of.)
 */
export interface JobSkill {
  /**
   * As it is shown: the vocabulary's label in the reader's language when the
   * skill is reviewed, else the posting's own string in its usual spelling.
   */
  skill: string;
  skillId: string | null;
  required: boolean;
  /** `soft`: shown, never compared. A certificate is compared like a hard skill. */
  kind: 'hard' | 'soft';
  /** The posting's own string for it (the first when it lists the skill under two spellings). */
  term: string;
  /** Every other string the posting writes the skill as ("postgres" next to "PostgreSQL"). Absent when there is none. */
  also?: string[];
  /**
   * The id is a machine guess: every spelling of the skill reached it through
   * the nearest vector (`via: 'embedding'`), none through a name the
   * vocabulary knows. A guessed skill is shown and never compared: nothing may
   * say "not in your resume" about a skill nobody matched by name.
   */
  guessed?: boolean;
}

/** Every string the posting writes a skill as, its own first. */
export function postingStringsOf(skill: Pick<JobSkill, 'term' | 'also'>): string[] {
  return skill.also?.length ? [skill.term, ...skill.also] : [skill.term];
}

/** How enrichment says an id was found by the nearest vector (features/skills `CanonicalSkill.via`). */
export const SKILL_VIA_EMBEDDING = 'embedding';

type SkillDetailEntry = NonNullable<MatchJob['skillsDetail']>[number];
const hasSkillId = (s: SkillDetailEntry | null | undefined): boolean => !!s && typeof s.skillId === 'string' && !!s.skillId.trim();

/**
 * Was the posting's skill record written by enrichment v3 (the pass that maps
 * each string to a canonical skill)? True when it carries an id, and also
 * when an entry says HOW it was mapped (`via`): enrichment v3 writes `via` on
 * every entry, `'none'` included, so a row it wrote in which no skill is in
 * the vocabulary (a nursing posting against a vocabulary of software skills)
 * is still known to be mapped. Without that, such a row could not be told
 * from one enrichment never wrote, and the keyword check answered "not in
 * your resume" by the string rule for skills nobody has reviewed.
 *
 * When false, every skill of the posting is compared by its string. The
 * keyword check reads this to decide what it lists: for a mapped row, its
 * reviewed skills only (an unmapped string is neither claimed nor denied).
 */
export function carriesSkillIds(job: Pick<MatchJob, 'skillIds' | 'skillsDetail'>): boolean {
  if (job.skillIds?.some((id) => typeof id === 'string' && id.trim())) return true;
  return !!job.skillsDetail?.some((s) => hasSkillId(s) || (!!s && typeof s.via === 'string' && !!s.via.trim()));
}

/**
 * GoApply 届别 (graduation class), the one eligibility rule of that kind: the
 * posting states the classes it hires, the profile states one, and it is not
 * among them. False outside GoApply, and whenever either side states none.
 * Read by the estimate (`titleLevelDimension`) and by scorer v4
 * (`classYearEligibility`), so the two cannot disagree about a person.
 */
export function classYearExcluded(user: Pick<MatchUser, 'classYear'>, job: Pick<MatchJob, 'market' | 'classYears'>): boolean {
  return job.market === 'cn' && job.classYears.length > 0 && user.classYear !== null && !job.classYears.includes(user.classYear);
}

/**
 * The language skill labels are written in: the request's when the caller
 * knows it, else the posting's own when it is English or Chinese (a
 * Traditional Chinese posting is labelled in Traditional Chinese whoever
 * reads it), else the market's. `RAJob.lang` also holds 'ja', 'ko' and
 * 'other' (a short or mixed text): none of them names a language a label
 * exists in, so the market decides. Taiwan never gets a Simplified label: the
 * vocabulary answers the Traditional one or the English one (features/skills
 * `label`).
 */
export function labelLocaleFor(job: Pick<MatchJob, 'market' | 'lang'>, user?: Pick<ShownSource, 'locale'> | null): string {
  const own = user?.locale?.trim();
  if (own) return own;
  const lang = job.lang?.trim() ?? '';
  if (/^(en|zh)(-|$)/i.test(lang)) return lang;
  return job.market === 'cn' ? 'zh' : 'en';
}

/** The id as the vocabulary holds it now: itself, or the skill an older id was merged into. */
function canonicalSkillId(vocabulary: SkillSnapshot, id: string): string {
  if (vocabulary.kindOf(id) !== null) return id;
  return vocabulary.idOf(id) ?? id;
}

/** What a memo of a job's skills was computed from: the same arrays, of the same length (an edit of either starts over). */
interface JobSkillInputs {
  vocabulary: SkillSnapshot;
  skills: readonly string[];
  skillsLength: number;
  detail: MatchJob['skillsDetail'];
  detailLength: number;
  skillIds: MatchJob['skillIds'];
}
const jobInputs = (job: MatchJob, vocabulary: SkillSnapshot): JobSkillInputs => ({
  vocabulary,
  skills: job.skills,
  skillsLength: job.skills.length,
  detail: job.skillsDetail,
  detailLength: job.skillsDetail?.length ?? 0,
  skillIds: job.skillIds,
});
const sameJobInputs = (a: JobSkillInputs, b: JobSkillInputs): boolean =>
  a.vocabulary === b.vocabulary && a.skills === b.skills && a.skillsLength === b.skillsLength && a.detail === b.detail && a.detailLength === b.detailLength && a.skillIds === b.skillIds;

interface JobSkillCache {
  inputs: JobSkillInputs;
  byLocale: Map<string, JobSkill[]>;
}
const JOB_SKILLS = new WeakMap<object, JobSkillCache>();

/**
 * The posting's skills, required ones first, one entry per thing and in the
 * spelling a reader expects.
 *
 *   · A posting written by enrichment v3 (its `skillsDetail` carries ids):
 *     `skillsDetail` IS the list, one entry per skill, and `skills` holds
 *     every spelling for search. A string of `skills` with no entry of its own
 *     is another spelling of one of them ("postgres" next to the PostgreSQL
 *     entry, "communication skills" next to the soft Communication entry): it
 *     joins the entry whose skill the vocabulary says it names, and is never a
 *     skill of its own.
 *   · A skill listed twice under one canonical id ("Postgres", "PostgreSQL")
 *     is one entry, labelled with the vocabulary's label for `locale`.
 *   · Strings without an id are de-duplicated as before (terms.ts:
 *     "typescript/node.js" is dropped next to "TypeScript" and "Node.js";
 *     "go" is written "Go").
 *
 * For a posting that carries no ids the list is what it always was.
 */
export function jobSkillList(job: MatchJob, locale?: string | null): JobSkill[] {
  const vocabulary = currentVocabulary();
  const lang = locale?.trim() || labelLocaleFor(job);
  const inputs = jobInputs(job, vocabulary);
  let cache = JOB_SKILLS.get(job);
  if (!cache || !sameJobInputs(cache.inputs, inputs)) {
    cache = { inputs, byLocale: new Map() };
    JOB_SKILLS.set(job, cache);
  }
  const hit = cache.byLocale.get(lang);
  if (hit) return [...hit];

  const detail = (job.skillsDetail ?? []).filter((s) => s && typeof s.skill === 'string' && s.skill.trim());
  const kindOf = new Map<string, JobSkill['kind']>();
  const idOf = new Map<string, string>();
  const guessedKeys = new Set<string>();
  for (const s of detail) {
    const key = skillKey(s.skill);
    if (!kindOf.has(key)) kindOf.set(key, s.kind === 'soft' ? 'soft' : 'hard');
    if (!idOf.has(key) && hasSkillId(s)) {
      idOf.set(key, canonicalSkillId(vocabulary, s.skillId!.trim()));
      if (s.via === SKILL_VIA_EMBEDDING) guessedKeys.add(key);
    }
  }
  const entry = (skill: string, required: boolean) => ({
    term: skill.trim(),
    required,
    kind: kindOf.get(skillKey(skill)) ?? ('hard' as JobSkill['kind']),
    skillId: idOf.get(skillKey(skill)) ?? null,
    guessed: guessedKeys.has(skillKey(skill)),
  });
  const fromDetail = detail.map((s) => entry(s.skill, s.required === true));
  const listed = job.skills.filter((s) => typeof s === 'string' && s.trim());
  // Enrichment v3 writes one `skillsDetail` entry per skill and keeps every spelling in `skills`: there the detail is
  // the list. Without ids in the detail (a posting not yet re-enriched) every string of `skills` is a skill, as before.
  const detailIsList = idOf.size > 0;
  const fromList = detailIsList ? [] : listed.map((s) => entry(s, false));
  const merged = uniqueBy([...fromDetail.filter((s) => s.required), ...fromDetail, ...fromList], (s) => skillKey(s.term));

  const out: JobSkill[] = [];
  const byId = new Map<string, JobSkill>();
  // The vocabulary's label for a reviewed skill; an empty label means "show the posting's own string" (features/skills `label`).
  const labelOf = (id: string, term: string): string => vocabulary.label(id, lang) || displayTerm(term);
  /** One more spelling of a skill already listed. `named`: the vocabulary knows the spelling as a name of the skill. */
  const addSpelling = (twin: JobSkill, spelling: string, named: boolean): void => {
    const known = new Set(postingStringsOf(twin).map(skillKey));
    if (!known.has(skillKey(spelling))) twin.also = [...(twin.also ?? []), spelling.trim()];
    // A guess only while no spelling is a name the vocabulary knows.
    if (twin.guessed && named) {
      delete twin.guessed;
      if (vocabulary.reviewed(twin.skillId!)) twin.skill = labelOf(twin.skillId!, spelling);
    }
  };
  for (const s of dedupeTerms(merged, (x) => x.term)) {
    const twin = s.skillId ? byId.get(s.skillId) : undefined;
    if (twin) {
      // The same skill under another spelling: one entry, required when either spelling is.
      twin.required ||= s.required;
      addSpelling(twin, s.term, !s.guessed);
      continue;
    }
    const reviewed = !!s.skillId && vocabulary.reviewed(s.skillId);
    const item: JobSkill = {
      // A guess keeps the posting's own words: the label of the guessed skill would state the guess as a fact.
      skill: reviewed && !s.guessed ? labelOf(s.skillId!, s.term) : displayTerm(s.term),
      skillId: s.skillId,
      required: s.required,
      // The vocabulary's kind wins for a reviewed skill; a certificate is compared like a hard skill.
      kind: reviewed ? (vocabulary.kindOf(s.skillId!) === 'soft' ? 'soft' : 'hard') : s.kind,
      term: s.term,
      ...(s.guessed ? { guessed: true } : {}),
    };
    if (s.skillId) byId.set(s.skillId, item);
    out.push(item);
  }
  if (detailIsList) {
    // The other spellings `skills` keeps. One the vocabulary cannot place on an entry stays out: enrichment stored it
    // as a spelling of one of them, and counting it again would ask for the same skill twice.
    const own = new Set(detail.map((s) => skillKey(s.skill)));
    for (const spelling of listed) {
      if (own.has(skillKey(spelling))) continue;
      const id = vocabulary.idOf(spelling);
      const twin = id ? byId.get(id) : undefined;
      if (twin) addSpelling(twin, spelling, true);
    }
  }
  cache.byLocale.set(lang, out);
  return [...out];
}

/** The skills that are shown as asked for: everything the posting lists that is not a soft skill (reviewed or not). */
export function hardSkillList(job: MatchJob, locale?: string | null): JobSkill[] {
  return jobSkillList(job, locale).filter((s) => s.kind !== 'soft');
}

/** Hard skills counted by the number: the first this many, required ones first. */
export const SKILLS_COUNTED_MAX = 10;
const skillWeight = (s: Pick<JobSkill, 'required'>): number => (s.required ? 1 : 0.5);
/** A more specific skill that shows the broader one the posting asks for counts this share of the skill's weight. */
export const RELATED_SKILL_CREDIT = 0.5;

// ── What the person's record says about a skill ───────────────────────────

/**
 * `unscored`: nothing is claimed and nothing is denied. A skill nobody has
 * reviewed, or a reviewed one whose only trace in the resume is a word with
 * another reading ("CPA" as cost per acquisition, "ml" as millilitres).
 */
export type SkillState = 'shown' | 'related' | 'not_shown' | 'unscored';

export interface SkillCheck {
  state: SkillState;
  /** For `related`: what the person shows that counted, as a label (a skill, or the title that shows the practice). */
  via: string | null;
}

const SHOWN: SkillCheck = { state: 'shown', via: null };
const NOT_SHOWN: SkillCheck = { state: 'not_shown', via: null };
const UNSCORED: SkillCheck = { state: 'unscored', via: null };

/** The keys of terms.ts EVERYDAY_WORDS ("rails" and "rail" are one key). */
const EVERYDAY_KEYS: ReadonlySet<string> = new Set([...EVERYDAY_WORDS].map((w) => termKey(w)));

/**
 * Is this name of a skill an abbreviation with another reading (features/skills
 * keys.ts: ML, PS, node, TS, AI, CPA, or three letters or fewer that nobody has
 * cleared)? A sentence that holds one ("500 ml of saline", "PS: available at
 * once", "a 5-node cluster") says nothing about the skill. A full word that is
 * also an ordinary one (Go, React, Excel) is not an abbreviation: the string
 * rule always read it from a sentence, and so does this one.
 */
export function isAmbiguousAbbreviation(name: string): boolean {
  const w = name.normalize('NFKC').trim().toLowerCase();
  if (!w || isEverydayWord(w) || EVERYDAY_KEYS.has(aliasKey(w))) return false;
  return isListOnlyWord(w);
}

/**
 * How a text names a skill that a plain reading of it does not find: under
 * names that are also something else.
 */
export interface AmbiguousTrace {
  /** A name that is no abbreviation is among them: a full word with another reading ("Go"), or a spelling the scan reads differently ("C#"). */
  word: boolean;
  /** The abbreviations with another reading the text holds, as comparison keys ("ml", "ps", "node"). */
  abbreviations: ReadonlySet<string>;
}

/** The names the vocabulary has for `id` that the text writes (whole word; substring for Chinese). */
function namesInText(vocabulary: SkillSnapshot, id: string, textNorm: string): string[] {
  const record = vocabulary.record(id);
  if (!record) return [];
  const out: string[] = [];
  for (const name of [record.labelEn, record.labelZh, record.labelZhHant, ...record.aliases]) {
    if (!name || [...name.trim()].length < 2) continue;
    if (spellings(name).some((v) => mentions(textNorm, v))) out.push(name);
  }
  return out;
}

/** How `textNorm` (normalized) names the skill, each find confirmed by the name as it is written (`mentions`: "net revenue" is not .NET); null when it does not. */
export function ambiguousTraceOf(vocabulary: SkillSnapshot, id: string, textNorm: string): AmbiguousTrace | null {
  const names = namesInText(vocabulary, id, textNorm);
  if (!names.length) return null;
  const abbreviations = names.filter(isAmbiguousAbbreviation);
  return { word: abbreviations.length < names.length, abbreviations: new Set(abbreviations.map(aliasKey)) };
}

/**
 * Does such a trace show the skill, for a posting that writes the skill as
 * `postingStrings`? A full word does. An abbreviation with another reading
 * does only when the posting itself writes the skill that way (it asks for
 * "ML" and the resume says "ML": what the string rule always counted).
 */
function traceShows(trace: AmbiguousTrace, postingStrings: readonly string[]): boolean {
  return trace.word || postingStrings.some((s) => trace.abbreviations.has(aliasKey(s)));
}

/**
 * Does this piece of text show the reviewed skill `id`, for a posting that
 * writes it as `postingStrings`? The rule `jobSkillCheck` applies to the whole
 * resume, for one sentence: the keyword check quotes only a sentence that
 * passes it. A certificate is never shown by a word with another reading.
 */
export function textShowsSkill(vocabulary: SkillSnapshot, id: string, text: string, postingStrings: readonly string[]): boolean {
  if (skillIdsInText(text, { vocabulary }).includes(id)) return true;
  if (vocabulary.kindOf(id) === 'certification') return false;
  const trace = ambiguousTraceOf(vocabulary, id, normalizeText(text));
  return !!trace && traceShows(trace, postingStrings);
}

interface PersonSkills {
  vocabulary: SkillSnapshot;
  skills: readonly string[];
  skillsLength: number;
  text: string | null | undefined;
  /** `userSkillIds`: listed skills, and reviewed skills the resume text names (an everyday word only from the list). */
  ids: ReadonlySet<string>;
  /** Skills the resume text names that `ids` leaves out because the name is also an ordinary word or a short abbreviation, with how it names them. */
  traces: ReadonlyMap<string, AmbiguousTrace>;
}
const PERSON_SKILLS = new WeakMap<object, PersonSkills>();

function personSkills(user: ShownSource): PersonSkills {
  const vocabulary = currentVocabulary();
  const hit = PERSON_SKILLS.get(user);
  if (hit && hit.vocabulary === vocabulary && hit.skills === user.skills && hit.skillsLength === user.skills.length && hit.text === user.resumeTextNorm) return hit;
  const text = user.resumeTextNorm;
  const ids = new Set(userSkillIds(user.skills, text, vocabulary));
  const traces = new Map<string, AmbiguousTrace>();
  if (text) {
    // The question "does the resume say X?" may read a name that is also an ordinary word ("built services in Go"),
    // which a list of the person's skills must not collect. Each such find is confirmed by the name as it is
    // written, the whole-word rule of `mentions`, so "net revenue" is not .NET.
    for (const id of skillIdsInText(text, { vocabulary, listOnlyWords: true })) {
      if (ids.has(id)) continue;
      const trace = ambiguousTraceOf(vocabulary, id, text);
      if (trace) traces.set(id, trace);
    }
  }
  const made: PersonSkills = { vocabulary, skills: user.skills, skillsLength: user.skills.length, text, ids, traces };
  PERSON_SKILLS.set(user, made);
  return made;
}

/**
 * The person's canonical skills: the ids of their listed skills plus every
 * reviewed skill one of whose names appears as a whole word in the resume (a
 * name that is also an everyday word counts from the skill list only).
 * Computed once per person object and vocabulary.
 */
export function userSkillIdSet(user: ShownSource): ReadonlySet<string> {
  return personSkills(user).ids;
}

/**
 * What the person's canonical skills say about one reviewed skill, which the
 * posting writes as `postingStrings`.
 *
 *   shown      the skill is among the person's ids, or the resume names it
 *              under a full word that is also an ordinary one ("Go", "React",
 *              "Excel": the string rule always read those), or under the very
 *              abbreviation the posting writes;
 *   related    a more specific skill of theirs shows it, or their title does;
 *   unscored   none of that, and the resume holds a name of the skill with
 *              another reading ("500 ml" for Machine learning, "Cut CPA by
 *              20%" for the licence; a certificate is never shown by such a
 *              word): neither claimed nor denied;
 *   not_shown  no trace at all.
 */
function canonicalCheck(user: ShownSource, id: string, postingStrings: readonly string[], locale: string, vocabulary: SkillSnapshot): SkillCheck {
  const person = personSkills(user);
  if (person.ids.has(id)) return SHOWN;
  const trace = person.traces.get(id);
  if (trace && vocabulary.kindOf(id) !== 'certification' && traceShows(trace, postingStrings)) return SHOWN;
  const evidence = evidenceFor(id, person.ids, vocabulary);
  if (evidence.state === 'related' && evidence.via) return { state: 'related', via: vocabulary.label(evidence.via, locale) || vocabulary.label(evidence.via, 'en') || evidence.via };
  if (evidence.state === 'unscored') return UNSCORED;
  // A practice the person's own title shows ("software engineering" for a Software Engineer).
  if (postingStrings.some((term) => titleShows(user.recentTitle, term))) return { state: 'related', via: user.recentTitle!.trim() };
  return trace ? UNSCORED : NOT_SHOWN;
}

/** The string rule (terms.ts): named itself, or shown by a named technology or the title. */
function literalCheck(user: ShownSource, term: string, skillSet?: Set<string>): SkillCheck {
  const r = shownVia(user, term, skillSet);
  if (!r.shown) return NOT_SHOWN;
  return r.via ? { state: 'related', via: r.via } : SHOWN;
}

/**
 * The better of the string rule's answer for `term` and, when the vocabulary
 * holds `id` as a reviewed hard skill or certificate, what the person's
 * canonical skills say about it. `unscored` only when neither finds the skill
 * and the resume holds a name of it with another reading.
 */
function withVocabulary(user: ShownSource, term: string, literal: SkillCheck, id: string | null, locale?: string | null): SkillCheck {
  if (literal.state === 'shown') return literal;
  const vocabulary = currentVocabulary();
  if (!id || !vocabulary.reviewed(id) || vocabulary.kindOf(id) === 'soft') return literal;
  const canonical = canonicalCheck(user, id, [term], locale?.trim() || user.locale?.trim() || 'en', vocabulary);
  if (canonical.state === 'shown') return canonical;
  if (literal.state === 'related') return literal;
  return canonical.state === 'not_shown' ? literal : canonical;
}

/**
 * What the person's record says about a bare term (a model-picked keyword, a
 * skill of the competitiveness report): the string rule first, then, when the
 * vocabulary knows the term as a reviewed hard skill or certificate, the
 * person's canonical skills. The better of the two answers: a term is never
 * called not shown while either rule finds it. Never `unscored`: a caller that
 * must answer yes or no gets `not_shown` for a trace with another reading.
 */
export function termCheck(user: ShownSource, term: string, options: { skillSet?: Set<string>; locale?: string | null } = {}): SkillCheck {
  const check = withVocabulary(user, term, literalCheck(user, term, options.skillSet), currentVocabulary().idOf(term), options.locale);
  return check.state === 'unscored' ? NOT_SHOWN : check;
}

/**
 * What the keyword check says about a skill or keyword the posting's record
 * carries no id for (a posting enrichment v3 has not written yet), which the
 * vocabulary knows as `id` (null: it does not). The string rule, then the
 * person's canonical skills: the check must not tell a person they lack a
 * skill they list under its other name. This is wider than the number and the
 * card of such a posting, which stay on the string rule (`jobSkillCheck`).
 * `unscored`: nothing may be said (see `canonicalCheck`).
 */
export function listedSkillCheck(user: ShownSource, term: string, id: string | null, options: { skillSet?: Set<string>; locale?: string | null } = {}): SkillCheck {
  return withVocabulary(user, term, literalCheck(user, term, options.skillSet), id, options.locale);
}

/** Is a skill that carries an id compared by it? A reviewed skill the vocabulary matched by name; never a guess. */
function isCompared(skill: JobSkill, vocabulary: SkillSnapshot): skill is JobSkill & { skillId: string } {
  return !!skill.skillId && !skill.guessed && vocabulary.reviewed(skill.skillId);
}

export interface JobSkillCheck extends SkillCheck {
  /**
   * The share of the skill's weight the number counts: 1, 0.5 or 0. Null when
   * the skill is not counted at all (neither numerator nor denominator).
   */
  credit: number | null;
}

/**
 * How one hard skill of a posting is compared: the state and the credit come
 * from one answer, so the number, its evidence lines and the card never
 * disagree about a skill. The skill's own record decides the rule:
 *
 *   a reviewed id       the person's canonical skills (`canonicalCheck`):
 *                       shown 1, related 0.5, not shown 0; `unscored` (not
 *                       counted) when the resume's only trace of the skill is
 *                       a word with another reading;
 *   any other id        `unscored`: a skill nobody has reviewed, an id the
 *                       vocabulary does not hold and an id that is only a
 *                       machine guess (`guessed`) are shown on the card and
 *                       never counted;
 *   no id               the string rule, exactly as before (shown, or shown
 *                       by a named technology: 1; else 0), for the state and
 *                       the credit alike. This is every skill of a posting
 *                       that has not been re-enriched, and a string
 *                       enrichment could not map: such a posting keeps the
 *                       estimate it had, words and number. The vocabulary is
 *                       not asked here; the keyword check asks it
 *                       (`listedSkillCheck`).
 */
export function jobSkillCheck(user: ShownSource, skill: JobSkill, options: { locale: string; skillSet?: Set<string> }): JobSkillCheck {
  if (skill.skillId) {
    const vocabulary = currentVocabulary();
    if (!isCompared(skill, vocabulary)) return { ...UNSCORED, credit: null };
    const check = canonicalCheck(user, skill.skillId, postingStringsOf(skill), options.locale, vocabulary);
    const credit = check.state === 'shown' ? 1 : check.state === 'related' ? RELATED_SKILL_CREDIT : check.state === 'not_shown' ? 0 : null;
    return { ...check, credit };
  }
  const literal = literalCheck(user, skill.skill, options.skillSet);
  return { ...literal, credit: literal.state === 'not_shown' ? 0 : 1 };
}

/** Is this skill part of the number? Never a soft skill; one that carries an id only when it is compared by it. */
function isCounted(skill: JobSkill, vocabulary: SkillSnapshot): boolean {
  if (skill.kind === 'soft') return false;
  return !skill.skillId || isCompared(skill, vocabulary);
}

export interface SkillSplit {
  /** Hard skills the person shows, the related ones included, in the posting's order. */
  aligned: string[];
  /** The part of `aligned` that is shown by a more specific skill or by the title, not by the skill itself. */
  related: string[];
  missing: string[];
  missingRequired: string[];
  /** Soft skills the posting names: shown on the card, never compared and never part of the number. */
  softSkills: string[];
  /**
   * Skills nothing is said about, so neither aligned nor missing: one nobody
   * has reviewed that the resume does not name, and a reviewed one whose only
   * trace in the resume is a word with another reading.
   */
  unchecked: string[];
}

/** What a memo of a split was computed from; any other input starts over. */
interface SplitInputs {
  job: JobSkillInputs;
  locale: string;
  skills: readonly string[];
  skillsLength: number;
  text: string | null | undefined;
  recentTitle: string | null | undefined;
}
const sameSplitInputs = (a: SplitInputs, b: SplitInputs): boolean =>
  sameJobInputs(a.job, b.job) && a.locale === b.locale && a.skills === b.skills && a.skillsLength === b.skillsLength && a.text === b.text && a.recentTitle === b.recentTitle;

const SPLITS = new WeakMap<object, WeakMap<object, { inputs: SplitInputs; split: SkillSplit }>>();

const copySplit = (s: SkillSplit): SkillSplit => ({
  aligned: [...s.aligned],
  related: [...s.related],
  missing: [...s.missing],
  missingRequired: [...s.missingRequired],
  softSkills: [...s.softSkills],
  unchecked: [...s.unchecked],
});

/**
 * The posting's hard skills the person shows and the ones they do not, plus
 * the soft skills it names. Each skill is listed once, under its usual
 * spelling, and by the answer that sets its share of the number
 * (`jobSkillCheck`). A skill that is not compared by id (nobody has reviewed
 * it, or its id is a guess) is `aligned` when the resume names its string and
 * `unchecked` otherwise: nothing says "missing" about it. A reviewed skill the
 * check withholds (a certificate behind "Cut CPA by 20%") is `unchecked`: the
 * string rule may not claim what the check declined to.
 */
export function splitSkills(user: MatchUser, job: MatchJob): SkillSplit {
  const vocabulary = currentVocabulary();
  const locale = labelLocaleFor(job, user);
  let perUser = SPLITS.get(job);
  if (!perUser) {
    perUser = new WeakMap();
    SPLITS.set(job, perUser);
  }
  const inputs: SplitInputs = { job: jobInputs(job, vocabulary), locale, skills: user.skills, skillsLength: user.skills.length, text: user.resumeTextNorm, recentTitle: user.recentTitle };
  const hit = perUser.get(user);
  if (hit && sameSplitInputs(hit.inputs, inputs)) return copySplit(hit.split);

  const have = new Set(user.skills.map(skillKey));
  const split: SkillSplit = { aligned: [], related: [], missing: [], missingRequired: [], softSkills: [], unchecked: [] };
  for (const s of jobSkillList(job, locale)) {
    if (s.kind === 'soft') {
      split.softSkills.push(s.skill);
      continue;
    }
    const check = jobSkillCheck(user, s, { locale, skillSet: have });
    if (check.state === 'shown') split.aligned.push(s.skill);
    else if (check.state === 'related') {
      split.aligned.push(s.skill);
      split.related.push(s.skill);
    } else if (check.state === 'not_shown') {
      split.missing.push(s.skill);
      if (s.required) split.missingRequired.push(s.skill);
    } else if (!isCompared(s, vocabulary) && shownVia(user, s.term, have).shown) split.aligned.push(s.skill);
    else split.unchecked.push(s.skill);
  }
  perUser.set(user, { inputs, split });
  return copySplit(split);
}

/**
 * 100 × Σ weight × credit / Σ weight, over the first 10 counted skills
 * (required 1, preferred 0.5; shown 1, related 0.5). Not stated when the
 * posting lists no skill that can be counted.
 */
export function skillsDimension(user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension {
  const vocabulary = currentVocabulary();
  const locale = labelLocaleFor(job, user);
  const counted = jobSkillList(job, locale)
    .filter((s) => isCounted(s, vocabulary))
    .slice(0, SKILLS_COUNTED_MAX);
  if (!counted.length) return dim('skills', weights, null);
  const have = new Set(user.skills.map(skillKey));
  let shown = 0;
  let listed = 0;
  for (const s of counted) {
    const { credit } = jobSkillCheck(user, s, { locale, skillSet: have });
    if (credit === null) continue;
    listed += skillWeight(s);
    shown += skillWeight(s) * credit;
  }
  if (listed === 0) return dim('skills', weights, null);
  const { aligned, related, missing, missingRequired } = splitSkills(user, job);
  // The skills the resume names itself first; a related one only when fewer than two of those exist.
  const direct = aligned.filter((s) => !related.includes(s));
  const evidence = [
    ...direct.slice(0, 2).map((s) => ev(s, 'resume', 'skill_have')),
    ...related.slice(0, Math.max(0, 2 - direct.length)).map((s) => ev(s, 'resume', 'skill_related')),
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

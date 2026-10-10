// server/src/features/match/competitiveness.ts
//
// "You and what employers ask" (PRODUCT F-MATCH-04; TASK_PLAN.md WP-77) — the
// pure part: no I/O, no model. Given the user's side of the pre-score and the
// newest posts of one saved search, it counts
//
//   - per post, whether the user meets each requirement the post STATES
//     (degree level, minimum years, skills marked required); a requirement
//     the post does not state never counts as a miss, and one the user's
//     profile/resume does not show is "unknown", never a miss;
//   - the most requested skills ("asked for in X of Y posts"; the feed's
//     skills-check rule: skills marked required, else the listed skills);
//   - "Broaden your search" options from the feed's real removal counts.
//
// D3: every comparative number carries `{ value, source: 'index', sampleSize,
// asOf, method }`; an aggregate over fewer than MIN_SAMPLE (20) posts is null,
// and a sample under 20 posts suppresses the whole comparison. There is no
// applicant data: nothing here ranks the user against other people.

import { createHash } from 'node:crypto';

import { MIN_SAMPLE } from '../../platform/http.js';
import { stableStringify } from '../search/index.js';
import type { FeedCountResult, LimitingFilter } from '../feed/index.js';
import {
  COMPETITIVENESS_LIMITS,
  type BroadenOption,
  type CompetitivenessReport,
  type CompetitivenessReportBody,
  type CompetitivenessRequirement,
  type CompetitivenessSkill,
  type ReportShare,
  type ReportSourced,
  type RequirementKey,
} from './contract.js';
import { degreeMeets, jobSkillList, skillKey, userShows, type DegreeLevel, type MatchJob, type MatchUser } from './preScore.js';

export type RequirementStatus = 'met' | 'not_met' | 'not_stated' | 'unknown';

/** A post as the report reads it: the pre-score projection plus the stated minimum years. */
export interface ReportPost extends MatchJob {
  minYears: number | null;
}

export interface PostEvaluation {
  jobId: string;
  degree: RequirementStatus;
  years: RequirementStatus;
  skills: RequirementStatus;
  /** Every stated requirement met (`met`), one missed (`not_met`), none stated, or not checkable. */
  overall: RequirementStatus;
  /** The skills the post asks for (display form, de-duplicated). */
  asked: string[];
}

const REQUIREMENT_KEYS: readonly RequirementKey[] = ['degree', 'years', 'skills'];

/**
 * Fields "Broaden your search" never offers to remove: the role itself
 * (titles, role ids, keywords, country), view-only settings, and answers about
 * eligibility or explicit blocks the user set (sponsorship need, clearance /
 * citizens-only, school tier, 届别, the GoApply 学历 and 可落户 answers, hiding
 * agency posts, excluded companies / titles / industries / skills). Removing
 * those would show posts the user said they cannot or do not want to apply to.
 */
export const BROADEN_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'taxonomyIds',
  'titles',
  'q',
  'country',
  'fitTier',
  'preferredCompanies',
  'needsSponsorship',
  'excludeRequirements',
  'schoolTiers',
  'classYear',
  'excludedCompanies',
  'excludedTitles',
  'excludedIndustries',
  'excludedSkills',
  'excludeAgencies',
  'degree',
  'hukouTag',
]);

// ── Per post ──────────────────────────────────────────────────────────────

/** The skills a post asks for: those it marks required, else every listed skill (feed skills-check rule). */
export function askedSkills(job: Pick<MatchJob, 'skills' | 'skillsDetail'>): string[] {
  const list = jobSkillList(job as MatchJob);
  const required = list.filter((s) => s.required);
  return (required.length ? required : list).map((s) => s.skill);
}

function userKnowsSkills(user: Pick<MatchUser, 'skills' | 'resumeTextNorm'>): boolean {
  return user.skills.length > 0 || !!user.resumeTextNorm;
}

export function evaluatePost(user: MatchUser, job: ReportPost, skillSet: Set<string> = new Set(user.skills.map(skillKey))): PostEvaluation {
  const req = job.educationLevel && job.educationLevel !== 'none' ? job.educationLevel : null;
  const degree: RequirementStatus = !req ? 'not_stated' : user.highestDegree === null ? 'unknown' : degreeMeets(user.highestDegree, req) ? 'met' : 'not_met';

  const minYears = typeof job.minYears === 'number' && job.minYears > 0 ? job.minYears : null;
  const years: RequirementStatus =
    minYears === null ? 'not_stated' : user.yearsExperience === null ? 'unknown' : user.yearsExperience >= minYears ? 'met' : 'not_met';

  const required = jobSkillList(job).filter((s) => s.required);
  const skills: RequirementStatus = !required.length
    ? 'not_stated'
    : !userKnowsSkills(user)
      ? 'unknown'
      : required.every((s) => userShows(user, s.skill, skillSet))
        ? 'met'
        : 'not_met';

  const all = [degree, years, skills];
  const overall: RequirementStatus = all.includes('not_met')
    ? 'not_met'
    : all.includes('unknown')
      ? 'unknown'
      : all.every((s) => s === 'not_stated')
        ? 'not_stated'
        : 'met';
  return { jobId: job.id, degree, years, skills, overall, asked: askedSkills(job) };
}

// ── Aggregates ────────────────────────────────────────────────────────────

function share(met: number, checked: number, asOf: string): ReportShare | null {
  if (checked < MIN_SAMPLE) return null;
  return { value: Math.round((met / checked) * 1000) / 1000, met, sampleSize: checked, source: 'index', asOf, method: 'newest_posts_sample' };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

const DEGREE_ORDER: readonly DegreeLevel[] = ['associate', 'bachelor', 'master', 'phd'];

function requirementRow(
  key: RequirementKey,
  user: MatchUser,
  posts: ReportPost[],
  evals: PostEvaluation[],
  asOf: string,
): CompetitivenessRequirement {
  const statuses = evals.map((e) => e[key]);
  const stated = statuses.filter((s) => s !== 'not_stated').length;
  const met = statuses.filter((s) => s === 'met').length;
  const checked = met + statuses.filter((s) => s === 'not_met').length;
  const youKnown = key === 'degree' ? user.highestDegree !== null : key === 'years' ? user.yearsExperience !== null : userKnowsSkills(user);
  const yours = key === 'degree' ? user.highestDegree : key === 'years' ? user.yearsExperience : youKnown ? user.skills.length : null;

  let typical: CompetitivenessRequirement['typical'] = null;
  if (stated >= MIN_SAMPLE && key === 'years') {
    const asked = posts.map((p) => p.minYears).filter((y): y is number => typeof y === 'number' && y > 0);
    const m = median(asked);
    if (m !== null) typical = { value: m, source: 'index', sampleSize: asked.length, asOf, method: 'newest_posts_sample' };
  }
  if (stated >= MIN_SAMPLE && key === 'degree') {
    const counts = new Map<DegreeLevel, number>();
    for (const p of posts) if (p.educationLevel && p.educationLevel !== 'none') counts.set(p.educationLevel, (counts.get(p.educationLevel) ?? 0) + 1);
    // Most common; a tie goes to the lower level (the less demanding reading).
    const best = DEGREE_ORDER.filter((d) => counts.has(d)).sort((a, b) => counts.get(b)! - counts.get(a)! || DEGREE_ORDER.indexOf(a) - DEGREE_ORDER.indexOf(b))[0];
    if (best) typical = { value: best, count: counts.get(best)!, source: 'index', sampleSize: stated, asOf, method: 'newest_posts_sample' };
  }
  return { key, stated, share: youKnown ? share(met, checked, asOf) : null, youKnown, yours, typical };
}

export function topSkills(user: MatchUser, evals: PostEvaluation[], asOf: string, limit: number = COMPETITIVENESS_LIMITS.fullSkills): CompetitivenessSkill[] {
  const n = evals.length;
  if (n < MIN_SAMPLE) return [];
  const tally = new Map<string, { skill: string; count: number }>();
  for (const e of evals) {
    const seen = new Set<string>();
    for (const s of e.asked) {
      const k = skillKey(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const t = tally.get(k) ?? { skill: s, count: 0 };
      t.count += 1;
      tally.set(k, t);
    }
  }
  const skillSet = new Set(user.skills.map(skillKey));
  return [...tally.values()]
    .filter((t) => t.count >= COMPETITIVENESS_LIMITS.skillMinPosts)
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
    .slice(0, limit)
    .map((t) => ({
      skill: t.skill,
      askedIn: { value: t.count, sampleSize: n, source: 'index' as const, asOf, method: 'newest_posts_sample' as const },
      youHave: userShows(user, t.skill, skillSet),
    }));
}

/**
 * "Broaden your search" options. The feed's removal gain is
 * `min(relaxed, cap) − min(search, cap)`, so it is only exact while the
 * relaxed count stays under the cap: an option is `capped` ("+N or more")
 * when the search's count plus the gain reaches the cap, when the search
 * itself is capped, or when the search's count is unknown (`total` null).
 */
export function broadenOptions(
  limiting: LimitingFilter[],
  asOf: string,
  countCap: number,
  total: FeedCountResult | null,
  limit: number = COMPETITIVENESS_LIMITS.fullBroaden,
): BroadenOption[] {
  const base = total && typeof total.count === 'number' ? total.count : null;
  const lowerBound = (gain: number) => base === null || !!total?.capped || base + gain >= countCap;
  return limiting
    .filter((l) => !BROADEN_EXCLUDED_FIELDS.has(l.field) && Number.isFinite(l.removalGain) && l.removalGain > 0)
    .sort((a, b) => b.removalGain - a.removalGain || a.field.localeCompare(b.field))
    .slice(0, limit)
    .map((l) => ({
      field: l.field,
      value: l.value,
      patch: { [l.field]: null },
      extraJobs: { value: l.removalGain, source: 'index' as const, asOf, method: 'filter_removal_count' as const },
      capped: lowerBound(l.removalGain),
    }));
}

export interface BuildReportInput {
  user: MatchUser;
  /** The sample, newest first (already restricted to posts the user may see on this brand). */
  posts: ReportPost[];
  profile: { id: string; name: string; version: number };
  total: FeedCountResult | null;
  limiting: LimitingFilter[];
  now: Date;
  sampleMax?: number;
  countCap?: number;
}

/** The persisted report body. Pure. */
export function buildReportBody(input: BuildReportInput): CompetitivenessReportBody {
  const asOf = input.now.toISOString();
  const skillSet = new Set(input.user.skills.map(skillKey));
  const evals = input.posts.map((p) => evaluatePost(input.user, p, skillSet));
  const size = input.posts.length;
  const suppressed = size < MIN_SAMPLE ? ('too_few_posts' as const) : null;
  const metAll = evals.filter((e) => e.overall === 'met').length;
  const checked = metAll + evals.filter((e) => e.overall === 'not_met').length;
  const countCap = input.countCap ?? 5000;
  const total =
    input.total && typeof input.total.count === 'number'
      ? { value: input.total.count, source: 'index' as const, asOf, method: 'search_count' as const }
      : null;
  return {
    schemaVersion: 1,
    searchProfileId: input.profile.id,
    searchProfileName: input.profile.name,
    searchProfileVersion: input.profile.version,
    asOf,
    sample: { size, maxSize: input.sampleMax ?? COMPETITIVENESS_LIMITS.sampleMax, method: 'newest_posts_sample' },
    total,
    totalCapped: !!input.total?.capped,
    suppressed,
    meetsRequirements: suppressed ? null : share(metAll, checked, asOf),
    overall: {
      checked,
      notStated: evals.filter((e) => e.overall === 'not_stated').length,
      unknown: evals.filter((e) => e.overall === 'unknown').length,
    },
    requirements: suppressed ? [] : REQUIREMENT_KEYS.map((k) => requirementRow(k, input.user, input.posts, evals, asOf)),
    topSkills: suppressed ? [] : topSkills(input.user, evals, asOf),
    broaden: broadenOptions(input.limiting, asOf, countCap, input.total),
  };
}

// ── Inputs hash, view, stored rows ────────────────────────────────────────

/**
 * Same search version, same filters and the same user inputs (degree, years,
 * skills, resume text) on the same UTC day → the same report; reused free.
 */
export function reportInputHash(input: { profile: { id: string; version: number; filters: unknown }; user: MatchUser; now: Date }): string {
  const u = input.user;
  const resume = u.resumeTextNorm ? createHash('sha256').update(u.resumeTextNorm).digest('hex') : null;
  return createHash('sha256')
    .update(
      stableStringify({
        v: 1,
        p: input.profile.id,
        pv: input.profile.version,
        f: input.profile.filters,
        d: u.highestDegree,
        y: u.yearsExperience,
        s: [...new Set(u.skills.map(skillKey))].sort(),
        r: resume,
        day: input.now.toISOString().slice(0, 10),
      }),
    )
    .digest('hex');
}

/** What the plan shows: the full lists with `competitivenessFull`, else the first few. */
export function toReportView(
  stored: { id: string; createdAt: Date; body: CompetitivenessReportBody },
  opts: { full: boolean; upgradable: boolean; charged: boolean; stale: boolean; reused?: boolean },
): CompetitivenessReport {
  const L = COMPETITIVENESS_LIMITS;
  const skillLimit = opts.full ? L.fullSkills : L.freeSkills;
  const broadenLimit = opts.full ? L.fullBroaden : L.freeBroaden;
  const { body } = stored;
  return {
    ...body,
    topSkills: body.topSkills.slice(0, skillLimit),
    broaden: body.broaden.slice(0, broadenLimit),
    hiddenSkills: Math.max(0, body.topSkills.length - skillLimit),
    hiddenBroaden: Math.max(0, body.broaden.length - broadenLimit),
    id: stored.id,
    createdAt: stored.createdAt.toISOString(),
    stale: opts.stale,
    full: opts.full,
    upgradable: !opts.full && opts.upgradable,
    charged: opts.charged,
    reused: opts.reused === true,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A stored `RAFitReport.report` read back; null for a row this version cannot read. */
export function parseStoredReport(v: unknown): CompetitivenessReportBody | null {
  if (!isRecord(v) || v.schemaVersion !== 1) return null;
  if (typeof v.searchProfileId !== 'string' || typeof v.searchProfileVersion !== 'number' || !isRecord(v.sample)) return null;
  if (!Array.isArray(v.requirements) || !Array.isArray(v.topSkills) || !Array.isArray(v.broaden) || !isRecord(v.overall)) return null;
  return v as unknown as CompetitivenessReportBody;
}

export type { ReportSourced };

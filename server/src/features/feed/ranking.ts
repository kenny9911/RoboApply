// server/src/features/feed/ranking.ts — in-process ranking (WP-32; ARCH §4.8, PRODUCT F-FEED-02/14).
//
//   fit        = ai ?? (pre − 5)                       verified scores are preferred
//   freshness  = 100 · e^(−ageHours / 72)
//   affinity   = 0–100 from the user's own actions (affinity.ts), 50 neutral
//   sourceQuality = 0–100: pay listed, known application system, real posting date, detailed description
//   Recommended rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality + goal adjustment
//                      + skills boost (only when skills is the only narrowing filter)
//   Sponsorship first: with "I need visa sponsorship", jobs whose posting
//   mentions sponsorship lead under every sort (ORDERING_RULES).
//
// No boost for recruiter-bank jobs: `fromRecruiterBank` is a filter only and
// appears nowhere below (a test pins this). Company scatter: at most 2 per
// company in any 20 consecutive items (Recommended and Best fit). Every
// factor is listed on /help/ranking (contract RANKING_FACTORS).

import type { FitTierKey, MatchTiers, PreScoreResult } from '../match/index.js';
import { normalizeSkills } from '../jobs/normalize/index.js';
import { SENIORITY_LEVELS, type FilterSet } from '../search/index.js';
import { affinityKeys, affinityScore, type AffinityState } from './affinity.js';
import { FEED_LIMITS, GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS, type FeedSort, type FitBadge } from './contract.js';
import { ANNUAL_FACTOR, annualFloor } from './sql.js';
import { statedApplyClose, type FeedJobRow } from './types.js';

const SKILLS_BOOST_POINTS = ORDERING_RULES.find((r) => r.key === 'skills_boost')!.points;

const W = Object.fromEntries(RANKING_FACTORS.map((f) => [f.key, f.weight])) as Record<(typeof RANKING_FACTORS)[number]['key'], number>;

/** A cached AI score for (user, job, current resume). */
export interface AiScore {
  score: number;
  tier: FitTierKey | null;
}

export interface Candidate {
  row: FeedJobRow;
  /** What the card shows (null = nothing comparable, or personalisation off). */
  badge: FitBadge | null;
  /** Ranking fit: ai ?? pre − 5 (null when neither). */
  fit: number | null;
  rank: number;
}

/** fit = ai ?? (pre − 5), floored at 0. */
export function fitOf(ai: number | null | undefined, pre: number | null | undefined): number | null {
  if (typeof ai === 'number') return ai;
  if (typeof pre === 'number') return Math.max(0, pre - 5);
  return null;
}

export function tierOf(score: number, tiers: MatchTiers): FitTierKey {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

/** The card's fit: the AI score when cached, else the deterministic quick estimate. */
export function fitBadge(pre: PreScoreResult | null, ai: AiScore | null, tiers: MatchTiers): FitBadge | null {
  const topGap = pre?.topGap ?? null;
  const topOverlap = pre?.topOverlap ?? null;
  if (ai) return { tier: ai.tier ?? tierOf(ai.score, tiers), score: ai.score, kind: 'ai', topGap, topOverlap };
  if (pre && typeof pre.score === 'number') return { tier: pre.tier ?? tierOf(pre.score, tiers), score: pre.score, kind: 'pre', topGap, topOverlap };
  return null;
}

/** 100 · e^(−ageHours/72); a job with no date counts from when we first saw it. */
export function freshness(postedAt: Date | null, firstSeenAt: Date | null, now: Date): number {
  const at = postedAt ?? firstSeenAt;
  if (!at) return 0;
  const hours = Math.max(0, (now.getTime() - at.getTime()) / 3_600_000);
  return 100 * Math.exp(-hours / FEED_LIMITS.freshnessHalfLifeHours);
}

/** Posting completeness, 0–100 (25 each). Independent of where the job came from. */
export function sourceQuality(row: Pick<FeedJobRow, 'salaryDisclosed' | 'atsType' | 'postedAt' | 'postedAtEstimated' | 'descriptionLength'>): number {
  let q = 0;
  if (row.salaryDisclosed) q += 25;
  if (row.atsType && row.atsType !== 'other') q += 25;
  if (row.postedAt && !row.postedAtEstimated) q += 25;
  if ((row.descriptionLength ?? 0) >= 600) q += 25;
  return q;
}

const MANAGER_TITLE = /\b(manager|head of|director|vp|vice president|chief|lead)\b|经理|經理|主管|总监|總監|负责人|負責人/i;
const LEVEL_RANK = new Map<string, number>(SENIORITY_LEVELS.map((l, i) => [l, i]));

export interface GoalContext {
  goal: string | null;
  filters: FilterSet;
}

/** Points the user's onboarding goal adds (GOAL_ADJUSTMENTS); 0 when the job lacks the field. */
export function goalAdjustment(row: Pick<FeedJobRow, 'roleType' | 'title' | 'seniority' | 'salaryDisclosed' | 'salaryCurrency' | 'salaryAnnualMax' | 'salaryAnnualMin' | 'workModel'>, ctx: GoalContext): number {
  const goal = ctx.goal as keyof typeof GOAL_ADJUSTMENTS | null;
  if (!goal || !(goal in GOAL_ADJUSTMENTS)) return 0;
  const points = GOAL_ADJUSTMENTS[goal].points;
  switch (goal) {
    case 'management':
      return row.roleType === 'manager' || (row.roleType !== 'ic' && MANAGER_TITLE.test(row.title)) ? points : 0;
    case 'higher_pay': {
      const min = ctx.filters.salaryMin;
      const listed = row.salaryAnnualMax ?? row.salaryAnnualMin;
      if (!min || !row.salaryDisclosed || listed === null || row.salaryCurrency !== min.currency) return 0;
      return listed > annualFloor(min) ? points : 0;
    }
    case 'more_senior': {
      const job = row.seniority ? LEVEL_RANK.get(row.seniority) : undefined;
      const mine = (ctx.filters.seniority ?? []).map((l) => LEVEL_RANK.get(l)).filter((n): n is number => n !== undefined);
      if (job === undefined || !mine.length) return 0;
      return job > Math.min(...mine) ? points : 0;
    }
    case 'flexibility':
      return row.workModel === 'remote' || row.workModel === 'hybrid' ? points : 0;
    default:
      return 0;
  }
}

export interface RankContext {
  now: Date;
  affinity: AffinityState;
  preferredCompanyKeys: ReadonlySet<string>;
  goal: GoalContext;
  /** Normalized chosen skills when skills is the only narrowing filter (ORDERING_RULES skills_boost); else absent. */
  skillsBoost?: ReadonlySet<string> | null;
}

/** Up to 10 points: the share of the chosen skills the job asks for. */
export function skillsBoost(row: Pick<FeedJobRow, 'skills'>, chosen: ReadonlySet<string> | null | undefined): number {
  if (!chosen?.size) return 0;
  const job = new Set(normalizeSkills(row.skills ?? []));
  let hit = 0;
  for (const s of chosen) if (job.has(s)) hit += 1;
  return Math.round(((SKILLS_BOOST_POINTS * hit) / chosen.size) * 1000) / 1000;
}

/** The Recommended rank of one candidate (unknown fit contributes 0). */
export function recommendedRank(row: FeedJobRow, fit: number | null, ctx: RankContext): number {
  const fresh = freshness(row.postedAt, row.firstSeenAt, ctx.now);
  const aff = affinityScore(ctx.affinity, affinityKeys(row), ctx.preferredCompanyKeys);
  const quality = sourceQuality(row);
  const rank =
    W.fit * (fit ?? 0) + W.freshness * fresh + W.affinity * aff + W.source_quality * quality + goalAdjustment(row, ctx.goal) + skillsBoost(row, ctx.skillsBoost);
  return Math.round(rank * 1000) / 1000;
}

/** The posting mentions sponsorship as offered, in its own words (F-FILT-02). */
export function mentionsSponsorship(row: Pick<FeedJobRow, 'sponsorship' | 'sponsorshipEvidence'>): boolean {
  return row.sponsorship === 'offered' && !!row.sponsorshipEvidence?.trim();
}

/**
 * "I need visa sponsorship": jobs that mention sponsorship first, the order
 * within each group unchanged (stable). A no-op otherwise.
 */
export function sponsorshipFirst<T extends { row: Pick<FeedJobRow, 'sponsorship' | 'sponsorshipEvidence'> }>(items: T[], on: boolean): { first: T[]; rest: T[] } {
  if (!on) return { first: [], rest: items };
  const first: T[] = [];
  const rest: T[] = [];
  for (const c of items) (mentionsSponsorship(c.row) ? first : rest).push(c);
  return { first, rest };
}

const time = (d: Date | null) => (d ? d.getTime() : -Infinity);

/** Annual listed pay for "Highest pay" (pay-listed jobs first; the user's currency first). */
function annualPay(row: FeedJobRow): number | null {
  if (!row.salaryDisclosed) return null;
  const a = row.salaryAnnualMax ?? row.salaryAnnualMin;
  if (a !== null) return a;
  const v = row.salaryMax ?? row.salaryMin;
  return v === null ? null : v * (ANNUAL_FACTOR[row.salaryPeriod ?? 'year'] ?? 1);
}

/**
 * Sort candidates in place for a sort (ties: newest, then id). `deadline`:
 * a stated upcoming 网申 close date first (soonest first; `today` is the
 * China date), then every other job newest first.
 */
export function sortCandidates(cands: Candidate[], sort: FeedSort, opts: { currency: string | null; today?: string } = { currency: null }): Candidate[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const closes = new Map<string, string | null>();
  const closeOf = (c: Candidate) => {
    if (!closes.has(c.row.id)) {
      const st = statedApplyClose(c.row.marketTags, today);
      closes.set(c.row.id, st?.upcoming ? st.date : null);
    }
    return closes.get(c.row.id)!;
  };
  const byNewest = (a: Candidate, b: Candidate) => time(b.row.postedAt) - time(a.row.postedAt) || (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0);
  const cmp: Record<FeedSort, (a: Candidate, b: Candidate) => number> = {
    recommended: (a, b) => b.rank - a.rank || byNewest(a, b),
    newest: byNewest,
    best_fit: (a, b) => (b.fit ?? -1) - (a.fit ?? -1) || byNewest(a, b),
    highest_pay: (a, b) => {
      const pa = annualPay(a.row);
      const pb = annualPay(b.row);
      if ((pa === null) !== (pb === null)) return pa === null ? 1 : -1;
      if (opts.currency) {
        const ca = a.row.salaryCurrency === opts.currency;
        const cb = b.row.salaryCurrency === opts.currency;
        if (ca !== cb) return ca ? -1 : 1;
      }
      return (pb ?? 0) - (pa ?? 0) || byNewest(a, b);
    },
    deadline: (a, b) => {
      const ea = closeOf(a);
      const eb = closeOf(b);
      if (ea === eb) return byNewest(a, b);
      if (ea === null) return 1;
      if (eb === null) return -1;
      return ea < eb ? -1 : 1;
    },
  };
  return cands.sort(cmp[sort]);
}

/**
 * At most `max` items of one company in any `window` consecutive items,
 * keeping rank order otherwise. `head` is the tail of the list already shown
 * (a session refill continues the same rule across the seam). When nothing
 * else is left, the remaining items follow in order.
 */
export function scatterByCompany<T>(items: T[], keyOf: (t: T) => string, opts: { max?: number; window?: number; head?: T[] } = {}): T[] {
  const max = opts.max ?? FEED_LIMITS.companyMaxPerWindow;
  const window = opts.window ?? FEED_LIMITS.companyWindow;
  const head = (opts.head ?? []).slice(-(window - 1));
  const placed: T[] = [];
  const remaining = [...items];
  const recentCount = (key: string) => {
    const tail = [...head, ...placed].slice(-(window - 1));
    return tail.filter((t) => keyOf(t) === key).length;
  };
  while (remaining.length) {
    const idx = remaining.findIndex((t) => recentCount(keyOf(t)) < max);
    if (idx === -1) {
      placed.push(...remaining.splice(0));
      break;
    }
    placed.push(remaining.splice(idx, 1)[0]!);
  }
  return placed;
}

/** Fit-tier view filter: keep jobs at or above the tier; unscored jobs pass (F-FILT-05). */
export function passesTier(badge: FitBadge | null, view: 'all' | 'good' | 'great' | undefined, tiers: MatchTiers): boolean {
  if (!view || view === 'all' || !badge) return true;
  return badge.score >= (view === 'great' ? tiers.great : tiers.good);
}

/** Company key for scatter (normalized name, else the display name). */
export function companyKeyOf(c: Candidate): string {
  return c.row.companyNameNormalized || c.row.companyName.toLowerCase();
}


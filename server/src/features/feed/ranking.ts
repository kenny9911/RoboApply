// server/src/features/feed/ranking.ts — in-process ranking (WP-32; ARCH §4.8, PRODUCT F-FEED-02/14).
//
//   fit        = one scale for every row (`fitForRank`; MARKET_STRATEGY 2.4):
//                · the market has a calibration map → the AI score when there
//                  is one, else the estimate mapped onto the AI scale;
//                · until then → the v2 estimate, plus half of (AI − estimate)
//                  for a row that has an AI score.
//                A scored and an unscored row of equal quality therefore get
//                the same input: scoring a job never pushes it below jobs
//                nobody has read.
//   freshness  = 100 · (0.7·e^(−h / 48) + 0.3·e^(−h / 336)) (rankingText.ts FRESHNESS_CURVE):
//                steep for two days, a slow tail over two weeks; a job its
//                source stopped listing counts from when it was last seen
//   affinity   = 0–100 from the user's own actions (affinity.ts), 50 neutral
//   sourceQuality = 0–100: pay listed, known application system, real posting date, detailed description
//   Recommended rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality + goal adjustment
//                      + skills boost (only when skills is the only narrowing filter)
//                      − seen and skipped (shown on 3+ visits, never opened: 5 / 7.5 / 10)
//   Sponsorship first: with "I need visa sponsorship", jobs whose posting
//   mentions sponsorship lead under every sort (ORDERING_RULES).
//   Same role, several places: one card per (company, title), the best ranked;
//   the other places are attached to it, at most ten a card (`collapseSameRole`).
//
// Retrieval is fused before any of this (`fuseByReciprocalRank`: recency,
// lexical and dense legs, score Σ 1 / (60 + rank), cap 400). The fused position
// is kept on the candidate (`retrievalRank`) and only breaks ties: under every
// sort it comes after the posting date and before the id.
//
// The card's fit and the ranking input come from the same `Fit` (match/fit.ts
// `getFits`), so the number on the card, the session ranks and "Why this job"
// agree.
//
// No boost for recruiter-bank jobs: `fromRecruiterBank` is a filter only and
// appears nowhere below (a test pins this). Company scatter: at most 2 per
// company in any 20 consecutive items (Recommended and Best fit). Every
// factor is listed on /help/ranking (contract RANKING_FACTORS).

import { toWireKind, type Fit, type MatchTiers } from '../match/index.js';
import { normalizeSkills, payPlausible } from '../jobs/normalize/index.js';
import { SENIORITY_LEVELS, type FilterSet } from '../search/index.js';
import { affinityKeys, affinityScore, type AffinityState } from './affinity.js';
import { FEED_LIMITS, GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS, type FeedSort, type FitBadge } from './contract.js';
import { FRESHNESS_CURVE, SEEN_SKIPPED } from './rankingText.js';
import { ANNUAL_FACTOR, annualFloor } from './sql.js';
import { statedApplyClose, type FeedJobRow } from './types.js';

const SKILLS_BOOST_POINTS = ORDERING_RULES.find((r) => r.key === 'skills_boost')!.points;

const W = Object.fromEntries(RANKING_FACTORS.map((f) => [f.key, f.weight])) as Record<(typeof RANKING_FACTORS)[number]['key'], number>;

export interface Candidate {
  row: FeedJobRow;
  /** What the card shows (null = nothing comparable, or personalisation off). */
  badge: FitBadge | null;
  /** The ranking input, on one scale for scored and unscored rows (`fitForRank`); null when nothing is comparable. */
  fit: number | null;
  rank: number;
  /**
   * 0-based position in the fused retrieval order (`fuseByReciprocalRank`).
   * Absent for a row of an older refill window or of a single-statement list:
   * it then sorts after every row that has one, when everything else ties.
   */
  retrievalRank?: number;
}

/** Before a market has a calibration map, a scored row moves this share of the way from its estimate to its AI score. */
export const RANK_BLEND_AI_SHARE = 0.5;

const clampScore = (n: number) => Math.max(0, Math.min(100, n));
const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The fit a row is ranked on, 0–100 (null when it has neither number).
 *   · With the market's calibration map: the AI score when there is one,
 *     else `map(estimate)`.
 *   · Without one: the v2 estimate, plus half of (AI − estimate) for a row
 *     that has an AI score.
 * `estimate` is the v2 estimate on its own scale for the same person and job,
 * also for a row that has an AI score.
 */
export function fitForRank(input: { ai?: number | null; estimate?: number | null; map?: ((estimate: number) => number) | null }): number | null {
  const ai = num(input.ai);
  const estimate = num(input.estimate);
  if (input.map) {
    if (ai !== null) return clampScore(ai);
    return estimate === null ? null : clampScore(input.map(estimate));
  }
  if (estimate === null) return ai === null ? null : clampScore(ai);
  if (ai === null) return clampScore(estimate);
  return clampScore(estimate + RANK_BLEND_AI_SHARE * (ai - estimate));
}

/** The ranking input of a fit (see `fitForRank`). */
export function rankFitOf(fit: Fit | null | undefined, map?: ((estimate: number) => number) | null): number | null {
  if (!fit) return null;
  return fitForRank({ ai: fit.kind === 'ai' ? fit.score : null, estimate: fit.estimateScore, map });
}

export function tierOf(score: number, tiers: MatchTiers): FitBadge['tier'] {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

/** The card's fit, from the one `Fit` every surface reads; null when nothing could be compared. */
export function fitBadge(fit: Fit | null | undefined): FitBadge | null {
  if (!fit || fit.score === null || fit.tier === null) return null;
  return {
    tier: fit.tier,
    score: fit.score,
    kind: toWireKind(fit.kind),
    topGap: fit.topGap,
    topOverlap: fit.topOverlap,
    confidence: fit.confidence,
    confidenceReason: fit.confidenceReason,
  };
}

const HOUR_MS = 3_600_000;

/**
 * 100 · (0.7·e^(−h/48) + 0.3·e^(−h/336)): steep for two days, a slow tail over
 * two weeks (FRESHNESS_CURVE). `h` is the hours since the posting date; a job
 * with no date counts from when we first saw it. When the source has stopped
 * listing the job (`lastSeenAt` older than 48 hours), `h` is the larger of that
 * and the hours since it was last seen: a post nobody lists any more is never
 * fresher than the time since it was last seen.
 *
 * What that last rule does on rows ingest writes: almost nothing. `lastSeenAt`
 * is never before `firstSeenAt`, and a posting date is at most one day after
 * the fetch (jobs/normalize `resolvePostedAt`), so the hours since a job was
 * last seen exceed its posting age by a day at most. The rule is built as
 * specified (MKT-4F item 5) and the published texts name it; whether it should
 * have a real effect, or go, is an open question for the owner (handoff MKT-4F,
 * Requests, Owner 1).
 */
export function freshness(postedAt: Date | null, firstSeenAt: Date | null, now: Date, lastSeenAt: Date | null = null): number {
  const at = postedAt ?? firstSeenAt;
  if (!at) return 0;
  let hours = Math.max(0, (now.getTime() - at.getTime()) / HOUR_MS);
  if (lastSeenAt) {
    const unseen = (now.getTime() - lastSeenAt.getTime()) / HOUR_MS;
    if (unseen > FRESHNESS_CURVE.staleAfterHours) hours = Math.max(hours, unseen);
  }
  const { fastHours, slowHours, fastShare } = FRESHNESS_CURVE;
  return 100 * (fastShare * Math.exp(-hours / fastHours) + (1 - fastShare) * Math.exp(-hours / slowHours));
}

/**
 * Rank points a job loses for being shown and never opened (ORDERING_RULES
 * `seen_skipped`): 5 at three impressions, 7.5 at four, 10 from five on.
 */
export function seenSkippedPenalty(impressions: number | null | undefined): number {
  const n = typeof impressions === 'number' && Number.isFinite(impressions) ? Math.floor(impressions) : 0;
  if (n < SEEN_SKIPPED.fromImpressions) return 0;
  const points = SEEN_SKIPPED.points;
  return points[Math.min(points.length - 1, n - SEEN_SKIPPED.fromImpressions)]!;
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
  /**
   * Impressions of the jobs the person was shown and never opened, by job id
   * (ORDERING_RULES seen_skipped). Absent: nothing is taken away.
   */
  seenSkipped?: ReadonlyMap<string, number> | null;
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
  const fresh = freshness(row.postedAt, row.firstSeenAt, ctx.now, row.lastSeenAt);
  const aff = affinityScore(ctx.affinity, affinityKeys(row), ctx.preferredCompanyKeys);
  const quality = sourceQuality(row);
  const rank =
    W.fit * (fit ?? 0) +
    W.freshness * fresh +
    W.affinity * aff +
    W.source_quality * quality +
    goalAdjustment(row, ctx.goal) +
    skillsBoost(row, ctx.skillsBoost) -
    seenSkippedPenalty(ctx.seenSkipped?.get(row.id));
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
export function annualPay(row: Pick<FeedJobRow, 'salaryDisclosed' | 'salaryAnnualMax' | 'salaryAnnualMin' | 'salaryMax' | 'salaryMin' | 'salaryPeriod' | 'salaryCurrency' | 'salaryMonths'>): number | null {
  if (!row.salaryDisclosed) return null;
  // A figure that cannot be pay (a posting typo) is not "the highest pay": it sorts with jobs that list none.
  if (!payPlausible({ min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, months: row.salaryMonths })) return null;
  const a = row.salaryAnnualMax ?? row.salaryAnnualMin;
  if (a !== null) return a;
  const v = row.salaryMax ?? row.salaryMin;
  return v === null ? null : v * (ANNUAL_FACTOR[row.salaryPeriod ?? 'year'] ?? 1);
}

/**
 * Sort candidates in place for a sort (ties: newest, then the fused retrieval
 * position, then id). `deadline`:
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
  // Ties: newest, then the fused retrieval position (a row without one last), then id.
  const fused = (c: Candidate) => c.retrievalRank ?? Number.POSITIVE_INFINITY;
  const byNewest = (a: Candidate, b: Candidate) => {
    const dt = time(b.row.postedAt) - time(a.row.postedAt);
    if (dt) return dt;
    const fa = fused(a);
    const fb = fused(b);
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0;
  };
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

const TIER_RANK: Record<FitBadge['tier'], number> = { unlikely: 0, possible: 1, good: 2, great: 3 };

/**
 * Fit-tier view filter ("Good or better", "Great"): keep jobs at or above the
 * tier.
 *   · A job with an AI score is judged by the TIER ITS CARD SHOWS. That tier
 *     moves only 3 points past an edge (hysteresis, match/fit.ts), so it can
 *     differ from the tier of the number; the view follows the card, never the
 *     other way round: a card that says Good is not listed under Great, and a
 *     card that says Great is.
 *   · A job with only the quick estimate passes when the estimate reaches the
 *     threshold AND its confidence is not low: an estimate we are not sure
 *     about is left out of the Good and Great views (MARKET_STRATEGY 2.4).
 *   · A job with no fit at all passes (F-FILT-05).
 */
export function passesTier(badge: FitBadge | null, view: 'all' | 'good' | 'great' | undefined, tiers: MatchTiers): boolean {
  if (!view || view === 'all' || !badge) return true;
  if (badge.kind === 'ai') return TIER_RANK[badge.tier] >= TIER_RANK[view];
  if (badge.score < (view === 'great' ? tiers.great : tiers.good)) return false;
  return badge.confidence !== 'low';
}

/** Company key for scatter (normalized name, else the display name). */
export function companyKeyOf(c: Candidate): string {
  return c.row.companyNameNormalized || c.row.companyName.toLowerCase();
}

// ── Fusion of the retrieval legs ──────────────────────────────────────────

export interface FusedRow {
  id: string;
  /** Σ over the legs that returned the row of 1 / (k + rank in that leg), rank counted from 1. */
  score: number;
}

/**
 * Reciprocal rank fusion (MARKET_STRATEGY 2.1 point 3): every leg is a list
 * of ids, best first. A row scores Σ 1 / (k + rank) over the legs that
 * returned it, so a row two legs agree on outranks a row one leg returned at
 * the same positions. Order: score, then `newer` (the caller's "newest first"
 * comparison), then the id descending, the same last tie-break as the SQL.
 * The result is cut at `cap`. A leg may be empty or missing.
 */
export function fuseByReciprocalRank(
  legs: ReadonlyArray<readonly string[] | null | undefined>,
  opts: { k?: number; cap?: number; newer?: (a: string, b: string) => number } = {},
): FusedRow[] {
  const k = opts.k ?? FEED_LIMITS.rrfK;
  const cap = opts.cap ?? FEED_LIMITS.retrievalLimit;
  const score = new Map<string, number>();
  for (const leg of legs) {
    if (!leg) continue;
    const seen = new Set<string>();
    let rank = 0;
    for (const id of leg) {
      // A leg that lists a row twice counts its first position only.
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  const out: FusedRow[] = [...score].map(([id, s]) => ({ id, score: s }));
  out.sort((a, b) => b.score - a.score || (opts.newer ? opts.newer(a.id, b.id) : 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, Math.max(0, cap));
}

// ── Same role, several places ─────────────────────────────────────────────

/** The place a card names (items.ts prints the same field). */
export function placeOf(row: Pick<FeedJobRow, 'location' | 'locationCity'>): string | null {
  const place = (row.location ?? row.locationCity ?? '').trim();
  return place || null;
}

/** The comparison key of a place: two postings name the same place when their keys are equal. */
export const placeKey = (place: string | null | undefined): string => (place ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The (company, title) group of a public posting: its market, normalized
 * company name and normalized title, all present. Null for a row that is
 * never folded: a user's own import, or a row missing either name.
 */
export function sameRoleKey(row: Pick<FeedJobRow, 'market' | 'visibility' | 'companyNameNormalized' | 'titleNormalized'>): string | null {
  if (row.visibility !== 'public') return null;
  const company = (row.companyNameNormalized ?? '').trim();
  const title = (row.titleNormalized ?? '').trim();
  if (!company || !title) return null;
  return `${row.market}\u0000${company}\u0000${title}`;
}

export interface SameRoleCollapse<T> {
  /** The cards, in the order given. */
  cards: T[];
  /** Card job id → the candidates folded into it, best ranked first. */
  also: Map<string, T[]>;
}

/** A (company, title) group that has a card: the card, the places it covers, and how many postings it holds besides its own. */
export interface SameRoleGroup {
  cardId: string;
  /** Place keys of the card and of the postings folded into it. */
  places: Set<string>;
  /** Postings folded into the card so far (absent: none). */
  folded?: number;
}

/**
 * One card per (company, title): `items` is in rank order, so the first row
 * of a group is its card. A later row of the group is folded into that card
 * when it names a place the card and the rows already folded do not; a row
 * for the same place, or with no place, stays a card of its own, so "also in
 * N more locations" is never said of the same city twice.
 *
 * A card holds at most `maxFolded` other postings (what it can name and link,
 * `FeedItem.alsoIn.jobIds`). The next place of the role then becomes a card of
 * its own and takes the places after it, so a posting is never folded away
 * where its card could not name it.
 *
 * `taken` carries the cards made earlier that a row may still join (a session
 * refill: the cards not sent yet): group key → the card's job id, the places
 * it already covers and how many postings it already holds.
 */
export function collapseSameRole<T extends { row: FeedJobRow }>(items: readonly T[], taken: Map<string, SameRoleGroup> = new Map(), maxFolded = Number.POSITIVE_INFINITY): SameRoleCollapse<T> {
  const cards: T[] = [];
  const also = new Map<string, T[]>();
  for (const item of items) {
    const key = sameRoleKey(item.row);
    const place = placeKey(placeOf(item.row));
    const group = key ? taken.get(key) : undefined;
    if (!key || !group) {
      cards.push(item);
      if (key) taken.set(key, { cardId: item.row.id, places: new Set(place ? [place] : []), folded: 0 });
      continue;
    }
    if (!place || group.places.has(place)) {
      cards.push(item);
      continue;
    }
    if ((group.folded ?? 0) >= maxFolded) {
      // The card is full: this place starts the role's next card, and later places join that one.
      cards.push(item);
      taken.set(key, { cardId: item.row.id, places: new Set([place]), folded: 0 });
      continue;
    }
    group.places.add(place);
    group.folded = (group.folded ?? 0) + 1;
    const list = also.get(group.cardId) ?? [];
    list.push(item);
    also.set(group.cardId, list);
  }
  return { cards, also };
}

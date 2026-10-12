// server/src/features/alerts/selection.ts
//
// Pure rules for job alerts (PRODUCT §7.2, ARCHITECTURE.md §8.2, TASK_PLAN.md
// WP-39a acceptance):
//   - only new canonical jobs (the candidate query), never hidden, Not
//     interested, already tracked or already sent for this search;
//   - fit at Possible or better on THE fit (match/fit.ts `getFits`: the stored
//     AI score when there is one, else the quick estimate; an unknown score is
//     not a fit). A quick estimate with low confidence never counts above
//     Possible: it still alerts, but it is ORDERED with the Possible fits and
//     never ahead of a fit that earned its tier. The card keeps the fit's own
//     score, tier and kind (strategy 2.2 I1: an alert shows what the feed card
//     and the job page show for the same person and job), and its kind is what
//     tells the reader it is a quick estimate;
//   - never a zero-job send;
//   - instant alerts: the saved search's own frequency, capped by the plan
//     (`instant_alerts` entitlement: Free 1 a day), at least 3 h apart.

import type { FitSnapshot } from '../match/contract.js';
import { ALERT_POLICY } from './contract.js';
import { startOfLocalDay } from './time.js';

export type AlertTier = 'great' | 'good' | 'possible';
export type AlertFitKind = 'ai' | 'estimate';

/** One job's fit as the alert selection reads it (`scoredFromFits` in service.ts builds it from a `Fit`). */
export interface ScoredJob {
  jobId: string;
  score: number | null;
  tier: 'great' | 'good' | 'possible' | 'unlikely' | null;
  topGap: string | null;
  /** `ai`: a stored AI fit. `estimate` (also when absent): the quick estimate. */
  kind?: AlertFitKind;
  /** How much the fit rests on. Absent: not known, read as not low. */
  confidence?: 'high' | 'medium' | 'low';
  /** The copy that travels with the message (I6). */
  snapshot?: FitSnapshot | null;
}

export interface PickedJob {
  jobId: string;
  score: number;
  /** The fit's own tier: what the alert shows, the same as every other surface (I1). */
  tier: AlertTier;
  /**
   * True for a quick estimate with low confidence whose tier is above Possible:
   * it is ordered as a Possible fit (`alertTierOf`). Ordering only: the card
   * still shows `tier`.
   */
  lowered: boolean;
  gap: string | null;
  kind: AlertFitKind;
  /** What the fit was when the alert was built: kind, versions and time. Null only for a caller that sent none. */
  fit: FitSnapshot | null;
}

export interface SelectionResult {
  picked: PickedJob[];
  /** Every qualifying job among the candidates (picked included). */
  qualifying: number;
}

export function isAlertTier(tier: ScoredJob['tier']): tier is AlertTier {
  return tier === 'great' || tier === 'good' || tier === 'possible';
}

const TIER_RANK: Record<AlertTier, number> = { great: 3, good: 2, possible: 1 };

/**
 * The tier this fit COUNTS AS when an alert chooses and orders its jobs: a
 * quick estimate with low confidence is never above Possible. Null: not a fit
 * to alert on. It is not what the card shows (that is the fit's own tier).
 */
export function alertTierOf(s: Pick<ScoredJob, 'tier' | 'kind' | 'confidence'>): AlertTier | null {
  if (!isAlertTier(s.tier)) return null;
  return s.kind !== 'ai' && s.confidence === 'low' ? 'possible' : s.tier;
}

/**
 * Pick up to `limit` jobs: candidates (newest first) minus `excluded`, with a
 * known fit at Possible or better. Order: the tier the fit counts as
 * (`alertTierOf`) first; inside it a thin estimate that was counted lower
 * after the fits that earned the tier; then the score; then an AI fit before
 * an estimate; then the newest-first order. Each picked job carries the fit's
 * own score, tier and kind.
 */
export function selectAlertJobs(input: {
  candidateIds: readonly string[];
  excluded: ReadonlySet<string>;
  scores: readonly ScoredJob[];
  limit: number;
}): SelectionResult {
  const byId = new Map(input.scores.map((s) => [s.jobId, s]));
  const order = new Map(input.candidateIds.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const qualifying: PickedJob[] = [];
  /** The tier each job is ordered by (below the fit's own for a low-confidence estimate). */
  const countsAs = new Map<string, AlertTier>();
  for (const id of input.candidateIds) {
    if (seen.has(id) || input.excluded.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    if (!s || s.score === null || !Number.isFinite(s.score) || !isAlertTier(s.tier)) continue;
    const counted = alertTierOf(s);
    if (!counted) continue;
    countsAs.set(id, counted);
    qualifying.push({ jobId: id, score: s.score, tier: s.tier, lowered: counted !== s.tier, gap: s.topGap, kind: s.kind === 'ai' ? 'ai' : 'estimate', fit: s.snapshot ?? null });
  }
  const aiFirst = (p: PickedJob) => (p.kind === 'ai' ? 0 : 1);
  const rank = (p: PickedJob) => TIER_RANK[countsAs.get(p.jobId)!];
  qualifying.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      Number(a.lowered) - Number(b.lowered) ||
      b.score - a.score ||
      aiFirst(a) - aiFirst(b) ||
      order.get(a.jobId)! - order.get(b.jobId)!,
  );
  return { picked: qualifying.slice(0, Math.max(0, input.limit)), qualifying: qualifying.length };
}

export type InstantBlock = 'off' | 'profile_cap' | 'plan_cap' | 'spacing';

/**
 * Whether one more instant alert may go out for this saved search now.
 * `profileMax` is the search's own frequency (0, 1, 2, 5, 100); `planMax` the
 * `instant_alerts` entitlement (Free 1, Pro 100). Counts are for the user's
 * current local day.
 */
export function instantAllowance(input: {
  profileMax: number;
  planMax: number;
  sentTodayForProfile: number;
  sentTodayForUser: number;
  lastInstantAt: Date | null;
  now: Date;
}): { allowed: true } | { allowed: false; reason: InstantBlock } {
  const profileMax = Math.max(0, Math.floor(input.profileMax || 0));
  const planMax = Math.max(0, Math.floor(input.planMax || 0));
  if (profileMax === 0 || planMax === 0) return { allowed: false, reason: 'off' };
  if (input.sentTodayForProfile >= profileMax) return { allowed: false, reason: 'profile_cap' };
  if (input.sentTodayForUser >= planMax) return { allowed: false, reason: 'plan_cap' };
  if (input.lastInstantAt && input.now.getTime() - input.lastInstantAt.getTime() < ALERT_POLICY.minSpacingHours * 3_600_000) {
    return { allowed: false, reason: 'spacing' };
  }
  return { allowed: true };
}

export const INSTANT_MAX_JOBS = 5;
export const DIGEST_MAX_JOBS = { daily: 10, weekly: 15 } as const;
/** How far back an instant alert looks for new jobs (ARCH §8.2: posted within 24 h). */
export const INSTANT_LOOKBACK_MS = 24 * 3_600_000;
/** Digest lookback when no digest was ever sent. */
export const DIGEST_LOOKBACK_MS = { daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000 } as const;

/** Start of the "new since" window for an instant alert. */
export function instantSince(lastInstantAt: Date | null, now: Date): Date {
  const floor = new Date(now.getTime() - INSTANT_LOOKBACK_MS);
  return lastInstantAt && lastInstantAt > floor ? lastInstantAt : floor;
}

/**
 * Start of the "new since" window for a digest.
 *   - daily: never before the start of yesterday in the person's time zone,
 *     so the "since yesterday" copy is always true (after days with nothing to
 *     send, the older jobs were already looked at and did not fit);
 *   - weekly: never more than 7 days back ("this week").
 */
export function digestSince(cadence: 'daily' | 'weekly', lastDigestAt: Date | null, now: Date, timeZone = 'UTC'): Date {
  const fallback = new Date(now.getTime() - DIGEST_LOOKBACK_MS[cadence]);
  const floor =
    cadence === 'daily'
      ? startOfLocalDay(new Date(startOfLocalDay(now, timeZone).getTime() - 1), timeZone)
      : new Date(now.getTime() - DIGEST_LOOKBACK_MS.weekly);
  const since = lastDigestAt ?? fallback;
  return since > floor ? since : floor;
}

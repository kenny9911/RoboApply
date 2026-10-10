// server/src/features/alerts/service.ts
//
// The `job-alerts` cron (every 15 min, per brand; ARCHITECTURE.md §8.2,
// PRODUCT §7.2). For each saved search with alerts on:
//   - instant: the search's frequency, capped by the plan (`instant_alerts`:
//     Free 1 a day), ≥ 3 h apart, up to 5 new jobs at Possible or better;
//   - digest: daily from 08:00 local, weekly on Monday from 08:00 local, up to
//     10 / 15 new jobs plus the real number of others (weekly: the tracker's
//     "no reply for 10 days" count);
//   - nothing in quiet hours (21:00–08:00 local, or the person's own), never
//     a zero-job send, each send recorded in `RAAlertDelivery` and mirrored
//     in-app (then email and the registered channels). When an email carried
//     the alert, its `RAEmailLog` id is stored on the delivery (`emailLogId`).
// GoApply sends alerts only when `jobs.alerts` is on (R-14: recruitment-info
// mode ≠ off); the candidate seam (`deps.candidates`, candidates.ts) and the
// card reader apply the mode again, so no posting leaks if the flag and the
// mode ever disagree. No LLM call is made here: fit is the deterministic pre-score.

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CronResult, CronTask } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import type { AlertJobCard, AlertJobPay } from '../../platform/email/templates/notify/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import type { AlertCandidateSource } from './candidates.js';
import type { DeliverOutcome, NotifyMessage } from './deliver.js';
import type { PreferenceFacts, PreferencesRepo } from './preferences.js';
import type { AlertProfileRow, AlertsRepo, JobCardRow, Recipient } from './repo.js';
import {
  DIGEST_MAX_JOBS,
  INSTANT_LOOKBACK_MS,
  INSTANT_MAX_JOBS,
  digestSince,
  instantAllowance,
  instantSince,
  selectAlertJobs,
  type PickedJob,
  type ScoredJob,
} from './selection.js';
import { digestDue, inQuietHours, parseDigestCadence, startOfLocalDay, type DigestCadence } from './time.js';

export interface JobAlertsDeps {
  repo: AlertsRepo;
  /**
   * Where instant alerts and digests take their candidate jobs from: the one
   * selection seam (candidates.ts). Production wraps the source in the
   * recruitment-info mode gate; join J4 points the source at the feed.
   */
  candidates: AlertCandidateSource;
  prefs: PreferencesRepo;
  /** Deterministic pre-score (`matchService.preScoreMany`); runs inside the brand context. */
  preScore(userId: string, jobIds: string[]): Promise<ScoredJob[]>;
  /** `instant_alerts` entitlement (Free 1, Pro 100). */
  planInstantMax(userId: string, brand: ProductBrand): Promise<number>;
  deliver(msg: NotifyMessage): Promise<DeliverOutcome>;
  /** `jobs.alerts` capability for the brand. */
  alertsEnabled(brand: ProductBrand): boolean;
}

/** Saved searches read per page. */
export const ALERT_PAGE_SIZE = 200;
/** Candidates scanned per instant alert / digest. */
export const INSTANT_CANDIDATES = 100;
export const DIGEST_CANDIDATES = 300;
/** Stop starting a new saved search when this much budget is left. */
const RESERVE_MS = 5_000;

export interface AlertRunStats {
  profiles: number;
  instantSent: number;
  digestSent: number;
  quiet: number;
  noJobs: number;
  capped: number;
  errors: number;
}

export function jobCard(row: JobCardRow, pick: PickedJob, deliveryId: string): AlertJobCard {
  const pay: AlertJobPay | null = row.salaryDisclosed
    ? { min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, text: row.salaryText }
    : row.salaryText
      ? { min: null, max: null, currency: null, period: null, text: row.salaryText }
      : null;
  return {
    id: row.id,
    title: row.title,
    company: row.companyName,
    place: row.location || row.locationCity || null,
    remote: row.workModel === 'remote',
    pay,
    tier: pick.tier,
    gap: pick.gap,
    href: `/jobs/${encodeURIComponent(row.id)}?from=alert&imp=${encodeURIComponent(deliveryId)}`,
  };
}

function searchName(row: AlertProfileRow): string {
  return (row.name || '').trim().slice(0, 80) || '—';
}

export function createJobAlertsTask(getDeps: () => JobAlertsDeps | Promise<JobAlertsDeps>): CronTask {
  return async (ctx): Promise<CronResult> => {
    const brand = ctx.brand;
    const deps = await getDeps();
    if (!deps.alertsEnabled(brand)) return { skipped: 'disabled' };
    const now = ctx.now;
    const stats: AlertRunStats = { profiles: 0, instantSent: 0, digestSent: 0, quiet: 0, noJobs: 0, capped: 0, errors: 0 };

    const factsCache = new Map<string, PreferenceFacts | null>();
    const planCache = new Map<string, number>();
    const countsCache = new Map<string, { total: number; byProfile: Map<string, number> }>();

    const facts = async (userId: string) => {
      if (!factsCache.has(userId)) factsCache.set(userId, await deps.prefs.load(userId));
      return factsCache.get(userId) ?? null;
    };

    async function sendBatch(
      row: AlertProfileRow,
      recipient: Recipient,
      prefs: PreferenceFacts,
      kind: 'instant' | 'digest_daily' | 'digest_weekly',
      picked: PickedJob[],
      extra: { moreCount?: number | null; noReplyCount?: number | null },
      onRecorded?: () => void,
    ): Promise<boolean> {
      const rows = new Map((await deps.repo.jobCards(picked.map((p) => p.jobId))).map((r) => [r.id, r]));
      const present = picked.filter((p) => rows.has(p.jobId));
      if (!present.length) return false; // jobs vanished between the query and now: never a zero-job send
      const delivery = await deps.repo.createDelivery({ userId: row.userId, searchProfileId: row.id, kind, jobIds: present.map((p) => p.jobId) });
      onRecorded?.();
      const cards = present.map((p) => jobCard(rows.get(p.jobId)!, p, delivery.id));
      const search = searchName(row);
      const instant = kind === 'instant';
      const params: Record<string, unknown> = instant
        ? { search, jobs: cards }
        : { search, cadence: kind === 'digest_weekly' ? 'weekly' : 'daily', jobs: cards, moreCount: extra.moreCount ?? null, noReplyCount: extra.noReplyCount ?? null };
      const outcome = await deps.deliver({
        recipient,
        kind: instant ? 'instant' : kind === 'digest_weekly' ? 'digest_weekly' : 'digest_daily',
        category: 'alert',
        templateKey: instant ? NOTIFY_TEMPLATES.jobAlertInstant : NOTIFY_TEMPLATES.jobAlertDigest,
        params,
        href: '/jobs?from=alert',
        relatedEntity: { type: 'alert_delivery', id: delivery.id },
        prefs: prefs.prefs,
      });
      // Link the delivery to its email (none when email was off, gated or skipped). Never fails the send.
      const emailLogId = outcome?.email?.logId;
      if (emailLogId) {
        await deps.repo
          .setDeliveryEmailLog(delivery.id, emailLogId)
          .catch((e: unknown) => logger.warn('ALERTS', 'could not link the delivery to its email log', { deliveryId: delivery.id, error: e instanceof Error ? e.message : String(e) }));
      }
      return true;
    }

    async function scoredSelection(row: AlertProfileRow, ids: string[], limit: number) {
      if (!ids.length) return { picked: [] as PickedJob[], qualifying: 0 };
      const excluded = await deps.repo.excludedJobIds({ userId: row.userId, searchProfileId: row.id, jobIds: ids });
      const remaining = ids.filter((id) => !excluded.has(id));
      if (!remaining.length) return { picked: [] as PickedJob[], qualifying: 0 };
      const scores = await deps.preScore(row.userId, remaining);
      return selectAlertJobs({ candidateIds: remaining, excluded, scores, limit });
    }

    async function instant(row: AlertProfileRow, recipient: Recipient, prefs: PreferenceFacts): Promise<void> {
      if (!(row.alertInstantMax > 0)) return;
      const dayStart = startOfLocalDay(now, prefs.timeZone);
      let counts = countsCache.get(row.userId);
      if (!counts) {
        counts = await deps.repo.instantCountsSince(row.userId, dayStart);
        countsCache.set(row.userId, counts);
      }
      let planMax = planCache.get(row.userId);
      if (planMax === undefined) {
        planMax = await deps.planInstantMax(row.userId, brand);
        planCache.set(row.userId, planMax);
      }
      const allowance = instantAllowance({
        profileMax: row.alertInstantMax,
        planMax,
        sentTodayForProfile: counts.byProfile.get(row.id) ?? 0,
        sentTodayForUser: counts.total,
        lastInstantAt: row.alertLastInstantAt,
        now,
      });
      if (!allowance.allowed) {
        if (allowance.reason !== 'spacing' && allowance.reason !== 'off') stats.capped += 1;
        return;
      }
      const cands = await deps.candidates({
        searchProfileId: row.id,
        userId: row.userId,
        market: brand.market,
        filters: row.filters,
        since: instantSince(row.alertLastInstantAt, now),
        postedSince: new Date(now.getTime() - INSTANT_LOOKBACK_MS),
        limit: INSTANT_CANDIDATES,
      });
      const sel = await scoredSelection(row, cands.ids, INSTANT_MAX_JOBS);
      if (!sel.picked.length) {
        stats.noJobs += 1;
        return;
      }
      const previous = row.alertLastInstantAt;
      if (!(await deps.repo.claimInstant(row.id, previous, now))) return; // another run took it
      const sent = await withClaim(
        (onRecorded) => sendBatch(row, recipient, prefs, 'instant', sel.picked, {}, onRecorded),
        () => deps.repo.releaseInstant(row.id, now, previous),
      );
      if (sent) {
        stats.instantSent += 1;
        counts.total += 1;
        counts.byProfile.set(row.id, (counts.byProfile.get(row.id) ?? 0) + 1);
      }
    }

    /**
     * Run a send under a claim. When nothing was recorded (no jobs left, or a
     * failure before the RAAlertDelivery row), the claim is given back so the
     * jobs found now can still alert on a later run. Once the delivery row
     * exists its jobs are excluded from later sends, so the claim stays.
     */
    async function withClaim(send: (onRecorded: () => void) => Promise<boolean>, release: () => Promise<void>): Promise<boolean> {
      let recorded = false;
      const giveBack = () => release().catch((e: unknown) => logger.warn('ALERTS', 'claim release failed', { error: e instanceof Error ? e.message : String(e) }));
      try {
        const ok = await send(() => {
          recorded = true;
        });
        if (!ok) await giveBack();
        return ok;
      } catch (err) {
        if (!recorded) await giveBack();
        throw err;
      }
    }

    async function digest(row: AlertProfileRow, recipient: Recipient, prefs: PreferenceFacts): Promise<void> {
      const cadence: DigestCadence | null = parseDigestCadence(row.alertDigest);
      if (!cadence || !digestDue(cadence, now, prefs.timeZone, row.alertLastDigestAt)) return;
      const cands = await deps.candidates({
        searchProfileId: row.id,
        userId: row.userId,
        market: brand.market,
        filters: row.filters,
        since: digestSince(cadence, row.alertLastDigestAt, now, prefs.timeZone),
        postedSince: null,
        limit: DIGEST_CANDIDATES,
      });
      const sel = await scoredSelection(row, cands.ids, DIGEST_MAX_JOBS[cadence]);
      if (!sel.picked.length) {
        stats.noJobs += 1;
        return;
      }
      // The total ("{N} new jobs fit") and "{N} others" only when N is exact (the
      // candidate scan was not cut off); null makes the email count-free.
      const moreCount = cands.truncated ? null : sel.qualifying - sel.picked.length;
      const noReplyCount = cadence === 'weekly' ? await deps.repo.noReplyCount(row.userId, now) : null;
      const previous = row.alertLastDigestAt;
      if (!(await deps.repo.claimDigest(row.id, previous, now))) return;
      const sent = await withClaim(
        (onRecorded) => sendBatch(row, recipient, prefs, cadence === 'weekly' ? 'digest_weekly' : 'digest_daily', sel.picked, { moreCount, noReplyCount }, onRecorded),
        () => deps.repo.releaseDigest(row.id, now, previous),
      );
      if (sent) stats.digestSent += 1;
    }

    let afterId: string | null = null;
    for (;;) {
      if (ctx.budget.exhausted(RESERVE_MS)) break;
      const rows = await deps.repo.dueProfiles({ brandId: brand.id, now, afterId, limit: ALERT_PAGE_SIZE });
      if (!rows.length) break;
      afterId = rows[rows.length - 1]!.id;
      const recipients = await deps.repo.recipients([...new Set(rows.map((r) => r.userId))]);
      for (const row of rows) {
        if (ctx.budget.exhausted(RESERVE_MS)) break;
        stats.profiles += 1;
        try {
          const recipient = recipients.get(row.userId);
          if (!recipient || recipient.brand !== brand.id) continue;
          const prefs = await facts(row.userId);
          if (!prefs) continue;
          if (inQuietHours(now, prefs.timeZone, prefs.quietHours)) {
            stats.quiet += 1;
            continue;
          }
          await instant(row, recipient, prefs);
          await digest(row, recipient, prefs);
        } catch (err) {
          stats.errors += 1;
          logger.warn('ALERTS', 'saved search alert failed', { searchProfileId: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (rows.length < ALERT_PAGE_SIZE) break;
    }

    if (!stats.profiles) return { skipped: 'no_work', processed: 0 };
    return { processed: stats.profiles, ...stats };
  };
}

/** Production wiring (lazy so importing the cron module opens no pool). */
export async function defaultJobAlertsDeps(): Promise<JobAlertsDeps> {
  const [{ createPrismaAlertsRepo }, { modeGatedCandidates }, { createPrismaPreferencesRepo }, { matchService }, { entitlementService }, { isEnabledForBrand }, deliverMod, idx] =
    await Promise.all([
      import('./repo.js'),
      import('./candidates.js'),
      import('./preferences.js'),
      import('../match/index.js'),
      import('../../platform/credits/index.js'),
      import('../../platform/flags.js'),
      import('./deliver.js'),
      import('./index.js'),
    ]);
  const deliverDeps = deliverMod.defaultDeliverDeps((b) => idx.deliveryChannels(b.id));
  const repo = createPrismaAlertsRepo();
  return {
    repo,
    // J4: replace the source with `(q) => feedService.alertCandidates(q.searchProfileId, { since: q.since, limit: q.limit })`
    // (INT-05); keep the gate around it.
    candidates: modeGatedCandidates((q) => repo.candidateJobIds(q)),
    prefs: createPrismaPreferencesRepo(),
    preScore: async (userId, jobIds) =>
      (await matchService.preScoreMany(userId, jobIds)).map((r) => ({ jobId: r.jobId, score: r.score, tier: r.tier, topGap: r.topGap })),
    planInstantMax: async (userId, b) => (await entitlementService.resolve(userId, { brand: b.id })).entitlements.instant_alerts,
    deliver: (msg) => deliverMod.deliverMessage(msg, deliverDeps),
    alertsEnabled: (b) => isEnabledForBrand('jobs.alerts', b),
  };
}


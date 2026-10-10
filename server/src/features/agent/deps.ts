// server/src/features/agent/deps.ts — the seams Ready to apply calls (WP-52).
//
// Every other area is reached through its public `index.ts` only (TASK_PLAN
// §2.1 rule 4), imported lazily so loading this router opens no pool and pulls
// no model client. Tests replace any of these (`createAgentService(deps)`).
//
// D1: none of these calls an employer endpoint. The only outbound effects are
// our own services (tracker, tailoring, letters, credits, queue, notices).

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { BucketUsage } from '../../platform/credits/index.js';
import type { FeedItem, FeedSort } from '../feed/index.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import type { ApplyClickResponse } from '../jobs/detail/index.js';
import type { TailorSessionView } from '../resume/index.js';
import type { ApplyMark } from '../tracker/index.js';
import type { NotifyUserInput, NotifyUserResult } from '../alerts/index.js';
import { AGENT_WORK_KINDS } from './kinds.js';
import type { AgentDb } from './store.js';

export interface PreparePayload {
  queueItemId: string;
  userId: string;
  /** 1-based preparation attempt (idempotency keys and the kit history use it). */
  attempt: number;
  /** The `ready_kits` reservation to commit (success) or release (failure); null for a revision. */
  reservationId: string | null;
  /** 'all' = a new kit; 'resume' = revise the resume only. */
  part: 'all' | 'resume';
  instruction?: string;
}

export interface CreditUsageLine {
  remaining: number;
  window: 'day' | 'week' | 'month';
  resetsAt: Date;
  cap: number;
}

export interface AgentDeps {
  getDb(): Promise<AgentDb>;
  now(): Date;
  brand(): ProductBrand;
  /** AI for this user: consent (`aiAllowed`) AND the brand's text model (R-13). */
  aiAvailable(userId: string): Promise<boolean>;
  flag(key: 'jobs.feed' | 'extension', userId: string): Promise<boolean>;
  /** GoApply: a WeChat account binds a phone before any AI step (403 phone_binding_required). */
  assertPhoneBound(userId: string): Promise<void>;
  /** R-14: drop GoApply third-party postings in mode `off` (other markets unchanged). */
  visibleJobs<T extends { market: string; visibility: string; ownerUserId: string | null }>(jobs: T[], userId: string): Promise<T[]>;

  /**
   * The user has a connected (not revoked) extension device on this brand.
   * Default: `hasConnectedDevice(userId, brand)` from extension/index.ts
   * (swapped in at the Wave 4 gate).
   */
  extensionConnected(userId: string, brand: string): Promise<boolean>;

  profileMissing(userId: string): Promise<Array<{ key: string; label: string }>>;
  profileName(userId: string): Promise<{ firstName: string | null; lastName: string | null } | null>;

  feedPreview(userId: string, input: { filters?: Partial<FilterSet>; sort?: FeedSort; limit: number }): Promise<FeedItem[]>;
  activeSearch(userId: string): Promise<SearchProfileWire>;
  patchSearch(userId: string, id: string, version: number, patch: unknown): Promise<SearchProfileWire>;
  /** True when `overrides` change the effective filters of `base`. */
  filtersDiffer(base: FilterSet, overrides: Record<string, unknown>, market: 'intl' | 'cn'): Promise<boolean>;

  recordApplyClick(userId: string, jobId: string): Promise<ApplyClickResponse>;
  /** Undo the apply-click move; `reverted` is false when the tracker still says Applied (too old, or moved since). */
  undoApplyClick(userId: string, jobId: string): Promise<{ reverted: boolean }>;
  markApplied(userId: string, jobId: string, via: 'agent_open' | 'extension'): Promise<ApplyMark>;
  /** Undo exactly the move `mark` names; `reverted` is false when that move is no longer the newest one. */
  undoMarkApplied(userId: string, jobId: string, mark: ApplyMark): Promise<{ reverted: boolean }>;

  tailor(userId: string, input: { baseVariantId: string; jobId: string; idempotencyKey: string; instruction?: string }): Promise<TailorSessionView>;
  finalizeTailor(userId: string, sessionId: string): Promise<TailorSessionView>;
  tailorSession(userId: string, sessionId: string): Promise<TailorSessionView | null>;
  unverifiedClaims(variantId: string): Promise<number>;

  createLetter(userId: string, input: { jobId: string; resumeVariantId: string }, idempotencyKey: string): Promise<{ id: string }>;
  rewriteLetter(userId: string, letterId: string, instruction: string): Promise<{ id: string }>;
  regenerateLetter(userId: string, letterId: string, idempotencyKey: string): Promise<{ id: string }>;
  attachLetter(userId: string, letterId: string, trackerEntryId: string): Promise<void>;

  creditUsage(userId: string): Promise<{ lines: Partial<Record<'tailor' | 'cover_letter' | 'ready_kits', CreditUsageLine>>; upgradable: boolean }>;
  reserveKit(userId: string, idempotencyKey: string, refId: string): Promise<{ id: string; replayed: boolean }>;
  commitKit(reservationId: string, refId: string): Promise<void>;
  releaseKit(reservationId: string, reason: string): Promise<void>;

  enqueuePrepare(payload: PreparePayload, dedupeKey: string): Promise<void>;
  /** Start a short drain after the response (Vercel `waitUntil`); the queue-drain cron covers the rest. */
  kickPrepare(): void;
  notify(input: NotifyUserInput): Promise<NotifyUserResult>;
}

/** Tracker stages before Applied (jobs/detail PRE_APPLY_STATUSES; not exported from its index). */
const PRE_APPLY_TRACKER_STATUSES: ReadonlySet<string> = new Set(['bookmarked', 'applying']);

const db = async (): Promise<AgentDb> => (await import('../../lib/prisma.js')).default;

function usageLine(u: BucketUsage | undefined): CreditUsageLine | undefined {
  if (!u) return undefined;
  return { remaining: u.remaining + u.grantRemaining, window: u.window, resetsAt: u.resetsAt, cap: u.cap };
}

export function defaultAgentDeps(): AgentDeps {
  return {
    getDb: db,
    now: () => new Date(),
    // Resolved per call: the request's (or the cron/worker `runWithBrand`) brand.
    brand: () => getCurrentBrandOrDefault(),
    async aiAvailable(userId) {
      const [{ aiAllowed }, { isEnabled }] = await Promise.all([import('../../platform/consent/aiAllowed.js'), import('../../platform/flags.js')]);
      if (!(await aiAllowed(userId))) return false;
      return isEnabled('ai.text', { userId });
    },
    async flag(key, userId) {
      const { isEnabled } = await import('../../platform/flags.js');
      return isEnabled(key, { userId });
    },
    async assertPhoneBound(userId) {
      const { assertPhoneBound } = await import('../auth-cn/index.js');
      await assertPhoneBound(userId);
    },
    async visibleJobs(jobs, userId) {
      const { filterCnPostings } = await import('../cn/jobs/index.js');
      return filterCnPostings(jobs, userId);
    },
    async extensionConnected(userId, brand) {
      const { hasConnectedDevice } = await import('../extension/index.js');
      return hasConnectedDevice(userId, brand);
    },
    async profileMissing(userId) {
      const { profileService } = await import('../profile/index.js');
      const { missing } = await profileService.completeness(userId);
      return missing.map((m) => ({ key: m.key, label: m.label }));
    },
    async profileName(userId) {
      const { profileService } = await import('../profile/index.js');
      const p = await profileService.get(userId);
      return { firstName: p.firstName ?? null, lastName: p.lastName ?? null };
    },
    async feedPreview(userId, input) {
      const { feedService } = await import('../feed/index.js');
      return feedService.preview(userId, input);
    },
    async activeSearch(userId) {
      const { searchProfileService } = await import('../search/index.js');
      return searchProfileService.getActive(userId);
    },
    async patchSearch(userId, id, version, patch) {
      const { searchProfileService, searchErrorToHttpError } = await import('../search/index.js');
      try {
        return await searchProfileService.patchFilters(userId, id, version, patch);
      } catch (err) {
        throw searchErrorToHttpError(err) ?? err;
      }
    },
    async filtersDiffer(base, overrides, market) {
      const { normalizeFilterSet, parseFilterSet, stableStringify } = await import('../search/index.js');
      if (!overrides || Object.keys(overrides).length === 0) return false;
      const merged = parseFilterSet({ ...base, ...overrides }, { market });
      if (!merged.ok) return true;
      const a = stableStringify(normalizeFilterSet(base));
      const b = stableStringify(normalizeFilterSet(merged.value));
      return a !== b;
    },
    async recordApplyClick(userId, jobId) {
      const { jobDetailService } = await import('../jobs/detail/index.js');
      return jobDetailService.recordApplyClick(userId, jobId);
    },
    async undoApplyClick(userId, jobId) {
      const { jobDetailService } = await import('../jobs/detail/index.js');
      const { tracker } = await jobDetailService.undoApplied(userId, jobId);
      // Reverted when the tracker is back before Applied (null: the click had created the entry, now removed).
      // A tracker still at Applied, or moved on (e.g. Interviewing), was not reverted.
      return { reverted: tracker === null || PRE_APPLY_TRACKER_STATUSES.has(tracker.status) };
    },
    async markApplied(userId, jobId, via) {
      const { trackerService } = await import('../tracker/index.js');
      return trackerService.markApplied(userId, jobId, via);
    },
    async undoMarkApplied(userId, jobId, mark) {
      const { trackerService } = await import('../tracker/index.js');
      const { undone } = await trackerService.undoApplied(userId, jobId, { mark });
      return { reverted: undone };
    },
    async tailor(userId, input) {
      const resume = await import('../resume/index.js');
      if (!input.instruction) {
        return resume.resumeSuiteService.createTailorSession(userId, {
          baseVariantId: input.baseVariantId,
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          mode: 'fast',
        });
      }
      return resume.getTailorService().create(
        userId,
        {
          baseVariantId: input.baseVariantId,
          jobId: input.jobId,
          mode: 'fast',
          sections: [...resume.TAILOR_SECTIONS],
          keywords: [],
          experienceDepth: 'quick',
          customPrompt: input.instruction,
        },
        { idempotencyKey: input.idempotencyKey },
      );
    },
    async finalizeTailor(userId, sessionId) {
      const { getTailorService } = await import('../resume/index.js');
      return getTailorService().finalize(userId, sessionId);
    },
    async tailorSession(userId, sessionId) {
      const { getTailorService } = await import('../resume/index.js');
      try {
        return await getTailorService().get(userId, sessionId);
      } catch {
        return null;
      }
    },
    async unverifiedClaims(variantId) {
      const { unverifiedClaimsCount } = await import('../resume/index.js');
      return unverifiedClaimsCount(variantId);
    },
    async createLetter(userId, input, idempotencyKey) {
      const { coverLetterService } = await import('../coverletter/index.js');
      return coverLetterService.createLetter(userId, input, idempotencyKey);
    },
    async rewriteLetter(userId, letterId, instruction) {
      const { getCoverLetterService } = await import('../coverletter/index.js');
      return (await getCoverLetterService()).rewrite(userId, letterId, instruction);
    },
    async regenerateLetter(userId, letterId, idempotencyKey) {
      const { getCoverLetterService } = await import('../coverletter/index.js');
      return (await getCoverLetterService()).regenerate(userId, letterId, {}, { idempotencyKey });
    },
    async attachLetter(userId, letterId, trackerEntryId) {
      const { coverLetterService } = await import('../coverletter/index.js');
      await coverLetterService.attach(userId, letterId, trackerEntryId);
    },
    async creditUsage(userId) {
      const { creditService, entitlementService } = await import('../../platform/credits/index.js');
      const ent = await entitlementService.resolve(userId);
      const usage = await creditService.usage(userId, { entitlements: ent });
      const by = new Map(usage.map((u) => [u.bucket, u]));
      return {
        lines: { tailor: usageLine(by.get('tailor')), cover_letter: usageLine(by.get('cover_letter')), ready_kits: usageLine(by.get('ready_kits')) },
        upgradable: ent.planProfile === 'free' && ent.proSellable,
      };
    },
    async reserveKit(userId, idempotencyKey, refId) {
      const { creditService } = await import('../../platform/credits/index.js');
      const r = await creditService.reserve({ userId, bucket: 'ready_kits', idempotencyKey, refType: 'agent_kit', refId });
      return { id: r.id, replayed: r.replayed };
    },
    async commitKit(reservationId, refId) {
      const { creditService } = await import('../../platform/credits/index.js');
      await creditService.commit(reservationId, { refId });
    },
    async releaseKit(reservationId, reason) {
      const { creditService } = await import('../../platform/credits/index.js');
      await creditService.release(reservationId, reason);
    },
    async enqueuePrepare(payload, dedupeKey) {
      const { enqueue } = await import('../../platform/queue/index.js');
      await enqueue(AGENT_WORK_KINDS.agentPrepare, payload, { dedupeKey, userId: payload.userId, maxAttempts: 2 });
    },
    kickPrepare() {
      void import('../../platform/queue/index.js').then(({ kickDrain }) => kickDrain([AGENT_WORK_KINDS.agentPrepare])).catch(() => undefined);
    },
    async notify(input) {
      const { notifyUser } = await import('../alerts/index.js');
      return notifyUser(input);
    },
  };
}

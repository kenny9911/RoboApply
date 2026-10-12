// server/src/features/growth/service.ts — first-party events, attribution and
// the getting-started checklist (TASK_PLAN.md WP-23).
//
//   ingestEvents        POST /api/v1/public/events (registry-checked, rate limited,
//                       linked to an anonId/account only where the consent rules allow)
//   recordAttribution   WP-10 signup: firstTouch once, lastTouch on later visits;
//                       links the visitor's earlier anonId events to the account;
//                       marketing fields only with `linkAllowed: true`; an invite
//                       code (`ref` / `inviteCode`) attaches the account to its
//                       inviter (WP-60, referrals.ts)
//   deleteEventsForUser WP-10 account wipe: rows by userId and by linked anonIds
//   markChecklistStep   WP-34 save, WP-36a tailor finalize, WP-43 completed practice;
//                       the only path that completes a step or grants the reward
//   getChecklist / dismissChecklist   the seeker card (routes.ts)
//   pruneProductEvents  retention (≈13 months), for WP-13's schedule
//
// Every dependency is injectable; tests never touch a database or the network.

import type prismaClient from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { BrandId, Market } from '../../platform/brand/index.js';
import { HttpError } from '../../platform/http.js';
import { consumeRateLimit, rateLimitKey, rateLimitWindows, type RateLimitResult, type RateWindow } from '../../platform/ratelimit/index.js';
import type { PracticeGrantReason, PracticeGrantResult } from '../../platform/credits/index.js';
import { logger } from '../../services/LoggerService.js';
import { functionalTouch, sanitizeTouch } from './attribution.js';
import { normalizeReferralCode } from './referralCodes.js';
import type { RawSignals } from './referralRisk.js';
import type { AttachResult } from './referrals.js';
import { STEP_FIELD, resolvePrismaChecklistStore, type ChecklistRow, type ChecklistStore } from './checklistStore.js';
import {
  CHECKLIST_REWARD,
  CHECKLIST_STEPS,
  isChecklistStep,
  type ChecklistState,
  type ChecklistStep,
  type ChecklistView,
  type EventsBatchResponse,
  type Touch,
} from './contract.js';
import {
  ANON_ID_RE,
  EVENT_RETENTION_DAYS,
  EVENTS_PER_IP_KEY,
  analyticsLinkAllowed,
  eventTime,
  isProductEventName,
  sanitizeEventPath,
  sanitizeEventProps,
  type AnalyticsConsentChoice,
} from './events.js';

type PrismaClientLike = typeof prismaClient;
export type GrowthDb = Pick<PrismaClientLike, 'rAProductEvent' | 'rAAttribution'>;

/** Idempotency key of the checklist reward grant (one per user, ever). */
export const CHECKLIST_REWARD_KEY = 'checklist_complete';

export interface IngestContext {
  brand: BrandId;
  market: Market;
  /** Session user (optionalAuth), or null. */
  userId: string | null;
  /** Edge country header, or null. */
  country: string | null;
  /** The visitor's analytics choice cookie, or null. */
  consent: AnalyticsConsentChoice | null;
  /** Client IP: every batch counts against a per-IP ceiling. */
  ip: string;
}

export interface EventsBatchInput {
  anonId?: string;
  sessionId?: string;
  events: Array<{ name: string; props?: Record<string, unknown>; path?: string; at: string }>;
}

export interface GrowthServiceDeps {
  /** Prisma (default: the shared client, loaded lazily). */
  db?: GrowthDb | (() => Promise<GrowthDb>);
  /** Checklist store; `null` = unavailable. Default: the Prisma store when the model exists (SR-23-1). */
  checklistStore?: ChecklistStore | null | (() => Promise<ChecklistStore | null>);
  grantPracticeCredit?: (userId: string, reason: PracticeGrantReason, idempotencyKey: string) => Promise<PracticeGrantResult>;
  consumeRateLimit?: (options: { key: string; windows: readonly RateWindow[]; cost: number }) => Promise<RateLimitResult>;
  /** Invite friends (WP-60): attach a new account to the invite code it signed up with. Default: referrals.ts. */
  attachReferral?: (inviteeUserId: string, code: string, options: { signals?: RawSignals }) => Promise<AttachResult>;
  now?: () => Date;
}

export interface RecordAttributionOptions {
  /** The visitor's `ra_anon` id (from `analyticsIdentity`), linked to the account. */
  anonId?: string;
  /** Update `lastTouch` only (a later visit). */
  lastTouchOnly?: boolean;
  /**
   * May the marketing fields (`from`, `utm*`, `alert`, `landingPath`) be
   * stored and the anonId linked? Pass `analyticsIdentity(req, market).linkAllowed`.
   * Default false: only the functional fields (ref, inviteCode, jobId,
   * action) are kept and no anonId is linked.
   */
  linkAllowed?: boolean;
  /**
   * The signup request's IP, User-Agent and `ra_anon` id (WP-60's invite
   * risk check; hashed before storage, kept 30 days). Pass
   * `{ ip: clientIp(req), userAgent, deviceId: req.cookies.ra_anon }`.
   */
  signals?: RawSignals;
}

export interface GrowthService {
  ingestEvents(body: EventsBatchInput, ctx: IngestContext): Promise<EventsBatchResponse>;
  markChecklistStep(userId: string, step: ChecklistStep): Promise<ChecklistState>;
  getChecklist(userId: string): Promise<ChecklistView>;
  dismissChecklist(userId: string): Promise<ChecklistView>;
  recordAttribution(userId: string, touch: Touch, options?: RecordAttributionOptions): Promise<void>;
  deleteEventsForUser(userId: string): Promise<{ deleted: number }>;
  pruneProductEvents(options?: { now?: Date; retentionDays?: number }): Promise<{ deleted: number }>;
}

const EMPTY_STEPS = (): Record<ChecklistStep, boolean> => ({ tailor: false, practice: false, save_job: false });

export function checklistStateFromRow(row: ChecklistRow | null): ChecklistState {
  const steps = EMPTY_STEPS();
  for (const step of CHECKLIST_STEPS) steps[step] = !!row?.[STEP_FIELD[step]];
  return { steps, rewarded: !!row?.rewardedAt, dismissed: !!row?.dismissedAt };
}

function toView(state: ChecklistState): ChecklistView {
  return { ...state, reward: { bucket: CHECKLIST_REWARD.bucket, credits: CHECKLIST_REWARD.credits } };
}

function cleanSessionId(value: string | undefined): string | null {
  if (!value) return null;
  const s = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s.length >= 8 ? s : null;
}

export function createGrowthService(deps: GrowthServiceDeps = {}): GrowthService {
  const now = deps.now ?? (() => new Date());

  async function db(): Promise<GrowthDb> {
    if (typeof deps.db === 'function') return deps.db();
    if (deps.db) return deps.db;
    return (await import('../../lib/prisma.js')).default;
  }

  let storeResolved = false;
  let storeCache: ChecklistStore | null = null;
  async function checklistStore(): Promise<ChecklistStore | null> {
    if (deps.checklistStore === null) return null;
    if (typeof deps.checklistStore === 'function') return deps.checklistStore();
    if (deps.checklistStore) return deps.checklistStore;
    if (!storeResolved) {
      storeResolved = true;
      storeCache = resolvePrismaChecklistStore((await import('../../lib/prisma.js')).default);
      if (!storeCache) {
        logger.warn('GROWTH', 'getting-started checklist store unavailable (schema request SR-23-1 not applied); steps are not recorded');
      }
    }
    return storeCache;
  }

  async function grant(userId: string): Promise<PracticeGrantResult> {
    if (deps.grantPracticeCredit) return deps.grantPracticeCredit(userId, 'checklist_complete', CHECKLIST_REWARD_KEY);
    const credits = await import('../../platform/credits/index.js');
    return credits.grantPracticeCredit(userId, 'checklist_complete', CHECKLIST_REWARD_KEY);
  }

  async function consume(key: string, windows: readonly RateWindow[], cost: number): Promise<RateLimitResult> {
    if (deps.consumeRateLimit) return deps.consumeRateLimit({ key, windows, cost });
    return consumeRateLimit({ key, windows, cost });
  }

  /** Throws `rate_limited` when over; fails open (logged) when the counter itself fails. */
  async function enforce(key: string, windows: readonly RateWindow[], cost: number): Promise<void> {
    let limit: RateLimitResult;
    try {
      limit = await consume(key, windows, cost);
    } catch (err) {
      // Fail open: analytics must never break a page, and the batch cap still bounds one request.
      logger.warn('GROWTH', 'events rate limit check failed (open)', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!limit.allowed) {
      throw new HttpError('rate_limited', undefined, { retryAfterSec: limit.retryAfterSec }, { 'Retry-After': String(limit.retryAfterSec) });
    }
  }

  async function attach(userId: string, code: string, signals: RawSignals | undefined): Promise<void> {
    try {
      const fn = deps.attachReferral ?? (await import('./referrals.js')).referralServiceImpl.attachFromSignup;
      const result = await fn(userId, code, { signals });
      if (result.status !== 'created') logger.info('GROWTH', 'invite code not attached', { userId, result });
    } catch (err) {
      logger.warn('GROWTH', 'invite attach failed', { userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function linkAnonEvents(d: GrowthDb, userId: string, anonId: string): Promise<void> {
    await d.rAProductEvent.updateMany({ where: { anonId, userId: null }, data: { userId } });
  }

  return {
    async ingestEvents(body, ctx) {
      const linkAllowed = analyticsLinkAllowed({ market: ctx.market, country: ctx.country, consent: ctx.consent });
      const anonId = linkAllowed && body.anonId && ANON_ID_RE.test(body.anonId) ? body.anonId : null;
      const userId = linkAllowed ? ctx.userId : null;
      // Before consent the session id is an in-memory, per-page-load value
      // (never stored on the device), so it groups one visit and nothing more.
      const sessionId = cleanSessionId(body.sessionId);

      // 120 events/min per anonId (ARCH §3.10), or per IP when there is none.
      // The anonId is chosen by the client, so every batch also counts
      // against a per-IP ceiling: rotating anonIds cannot lift the limit.
      const cost = body.events.length;
      if (anonId) {
        await enforce(rateLimitKey('eventsPerAnon', 'id', anonId, ctx.brand), rateLimitWindows('eventsPerAnon'), cost);
        await enforce(rateLimitKey(EVENTS_PER_IP_KEY, 'ip', ctx.ip, ctx.brand), rateLimitWindows(EVENTS_PER_IP_KEY), cost);
      } else {
        await enforce(rateLimitKey('eventsPerAnon', 'ip', ctx.ip, ctx.brand), rateLimitWindows('eventsPerAnon'), cost);
      }

      const at = now();
      const rows: Prisma.RAProductEventCreateManyInput[] = [];
      let rejected = 0;
      for (const ev of body.events) {
        if (!isProductEventName(ev.name)) {
          rejected += 1;
          continue;
        }
        const props = sanitizeEventProps(ev.name, ev.props);
        const withSession = sessionId ? { ...(props ?? {}), sessionId } : props;
        rows.push({
          brand: ctx.brand,
          userId,
          anonId,
          name: ev.name,
          props: (withSession ?? undefined) as Prisma.InputJsonValue | undefined,
          path: sanitizeEventPath(ev.path),
          createdAt: eventTime(ev.at, at),
        });
      }
      if (rows.length) await (await db()).rAProductEvent.createMany({ data: rows });
      return { accepted: rows.length, rejected };
    },

    async markChecklistStep(userId, step) {
      if (!isChecklistStep(step)) throw new HttpError('invalid_request', `Unknown checklist step "${String(step)}".`);
      const store = await checklistStore();
      if (!store) return checklistStateFromRow(null);
      await store.stamp(userId, STEP_FIELD[step], now());
      const row = await store.get(userId);
      const state = checklistStateFromRow(row);
      const allDone = CHECKLIST_STEPS.every((s) => state.steps[s]);
      if (!allDone || state.rewarded) return state;

      // Deterministic reward, once per user: the ledger key makes a retry (or a
      // concurrent call) a no-op; `rewardedAt` is stamped only after the grant
      // is known to exist, so a failed grant is retried by the next call.
      const result = await grant(userId);
      if (result.status === 'granted' || result.status === 'already_granted') {
        await store.stamp(userId, 'rewardedAt', now());
        return { ...state, rewarded: true };
      }
      logger.warn('GROWTH', 'checklist reward not granted yet', { userId, status: result.status });
      return state;
    },

    async getChecklist(userId) {
      const store = await checklistStore();
      if (!store) throw new HttpError('feature_disabled');
      return toView(checklistStateFromRow(await store.get(userId)));
    },

    async dismissChecklist(userId) {
      const store = await checklistStore();
      if (!store) throw new HttpError('feature_disabled');
      await store.stamp(userId, 'dismissedAt', now());
      return toView(checklistStateFromRow(await store.get(userId)));
    },

    async recordAttribution(userId, touch, options = {}) {
      // Without linking allowed (no consent in the EEA/UK/CH, or the caller
      // did not say) only the functional fields are stored, and no anonId.
      const linkAllowed = options.linkAllowed === true;
      const at = now();
      const sanitized = sanitizeTouch(touch, at);
      const clean = linkAllowed ? sanitized : functionalTouch(sanitized, at);
      if (!clean) return;
      // Invite friends (WP-60): the signup carried an invite code (`?ref=` or
      // `?invite=`). Functional, so it is read whatever the analytics choice.
      // Only at signup (not on later visits); never breaks the signup.
      // The first of `ref` / `inviteCode` that reads as a code wins, so a
      // marketing `ref=newsletter` never hides a real `invite=<code>`.
      const inviteCode = [clean.ref, clean.inviteCode].find((c) => normalizeReferralCode(c) !== null);
      if (inviteCode && !options.lastTouchOnly) await attach(userId, inviteCode, options.signals);
      const anonId = linkAllowed && options.anonId && ANON_ID_RE.test(options.anonId) ? options.anonId : null;
      const d = await db();
      const existing = await d.rAAttribution.findUnique({ where: { userId }, select: { userId: true, anonId: true } });
      const json = clean as unknown as Prisma.InputJsonValue;

      if (options.lastTouchOnly) {
        // A later visit: only lastTouch moves. Without a signup row there is
        // nothing to update (first touch is captured at signup only).
        if (existing) await d.rAAttribution.update({ where: { userId }, data: { lastTouch: json } });
        return;
      }
      if (existing) {
        // Captured once at signup; never overwritten. Fill a missing anonId only.
        if (!existing.anonId && anonId) {
          await d.rAAttribution.update({ where: { userId }, data: { anonId } });
          await linkAnonEvents(d, userId, anonId);
        }
        return;
      }
      try {
        await d.rAAttribution.create({ data: { userId, anonId, firstTouch: json } });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002') return; // a concurrent signup call won
        throw err;
      }
      if (anonId) await linkAnonEvents(d, userId, anonId);
    },

    async deleteEventsForUser(userId) {
      // Call BEFORE the user's RAAttribution row is deleted: the linked anonId is read from it.
      const d = await db();
      const anonIds = new Set<string>();
      const attribution = await d.rAAttribution.findUnique({ where: { userId }, select: { anonId: true } });
      if (attribution?.anonId) anonIds.add(attribution.anonId);
      const linked = await d.rAProductEvent.findMany({
        where: { userId, anonId: { not: null } },
        select: { anonId: true },
        distinct: ['anonId'],
      });
      for (const row of linked) if (row.anonId) anonIds.add(row.anonId);
      // The anonId branch covers only rows not linked to an account: on a
      // shared browser another person's signed-in rows can carry the same
      // anonId, and they are not this user's to delete.
      const where: Prisma.RAProductEventWhereInput = anonIds.size
        ? { OR: [{ userId }, { anonId: { in: [...anonIds] }, userId: null }] }
        : { userId };
      const { count } = await d.rAProductEvent.deleteMany({ where });
      return { deleted: count };
    },

    async pruneProductEvents(options = {}) {
      const days = options.retentionDays ?? EVENT_RETENTION_DAYS;
      const cutoff = new Date((options.now ?? now()).getTime() - days * 24 * 60 * 60 * 1000);
      const { count } = await (await db()).rAProductEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return { deleted: count };
    },
  };
}

export const growthServiceImpl: GrowthService = createGrowthService();

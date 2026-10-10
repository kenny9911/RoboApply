// server/src/features/growth/referrals.ts — invite friends (F-GROW-01;
// TASK_PLAN.md WP-60; PRODUCT_PLAN.md §5.22).
//
// Life of a referral:
//   1. The inviter opens /invite. `getInvites` creates their code once
//      (RAReferralCode) — only after their own account is verified, so
//      throwaway accounts cannot hand out links.
//   2. A friend opens /r/<code> and signs up; the link carries `?ref=<code>`
//      and WP-10's signup passes it to `recordAttribution`, which calls
//      `attachFromSignup`. A self-invite, an account of the other brand, an
//      account older than 24 h or a link with a code nobody owns creates
//      nothing; the same person under another address (same normalized email)
//      is stored as `rejected`. Otherwise an RAReferral `pending` row and one
//      `growth.referralRisk` work item are created.
//   3. `evaluateReferral` (the worker, plus the friend's own activity and the
//      `checkReferralFor` seam) waits until the friend is verified (email
//      confirmed, Google/LINE/WeChat sign-in, or a verified phone) and has
//      finished setup (SeekerProfile.onboardingStep = 'done'). Then the risk
//      check runs (referralRisk.ts). With no stored signals for the inviter or
//      the friend it waits (up to 7 days after signup) for them to use the
//      product, then holds. A score ≥ 50 → `held` for review. Otherwise the
//      row is CLAIMED first (`qualifiedAt` set while still `pending`; only one
//      caller wins), and only the winner grants: both get 1 practice credit
//      (`grantPracticeCredit`, reason `referral`, idempotent keys) and the row
//      becomes `rewarded`, or `qualified` when the inviter already has 10
//      rewards this calendar year (the friend still gets theirs). A concurrent
//      hold can therefore never be overwritten by a reward, and a reward that
//      was claimed is finished by any later call (the keys keep it single).
//   4. Staff approve or reject held rewards (`reviewReferral`, admin router).
//      Approval claims the row back to `pending` before granting, so a
//      concurrent reject cannot land after credits were given.
//
// Brands: only brands in INVITE_SIGNUP_WIRED_BRANDS run the programme (every
// sign-up path there passes the code). GoApply's phone/WeChat sign-ups do not
// yet (request R-60-3), so GoApply answers `not_available` and attaches nothing.
//
// Rewards are practice credits (R-07: the practice bucket lives in
// mockCreditService, granted through platform/credits `grantPracticeCredit`),
// never cash. Every dependency is injectable; tests touch no database.

import type prismaClient from '../../lib/prisma.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { brandEnv } from '../../platform/brand/brandEnv.js';
import { getBrand, isBrandId, type BrandId } from '../../platform/brand/registry.js';
import type { PracticeGrantReason, PracticeGrantResult } from '../../platform/credits/index.js';
import type { EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { HttpError } from '../../platform/http.js';
import { classifyEmailDomain } from '../../lib/emailDomainPolicy.js';
import { logger } from '../../services/LoggerService.js';
import { referralRewardEmail, type ReferralRewardParams } from '../../platform/email/templates/growth/index.js';
import {
  INVITE_REWARD_CAP_PER_YEAR,
  INVITE_VIEW_STATUS,
  REFERRAL_HOLD_SCORE,
  REFERRAL_REWARD,
  inviteSignupWired,
  type HeldReferralView,
  type InvitesResponse,
  type ReferralStatus,
} from './contract.js';
import { generateReferralCode, invitePath, normalizeReferralCode } from './referralCodes.js';
import {
  RISK_WEIGHTS,
  SIGNAL_RETENTION_DAYS,
  SIGNAL_WINDOW_MS,
  hashSignals,
  normalizeEmailForReferral,
  scoreReferralRisk,
  type RawSignals,
  type RiskResult,
} from './referralRisk.js';
import { resolvePrismaSignalStore, type ReferralSignalStore } from './referralSignalStore.js';

type PrismaClientLike = typeof prismaClient;
export type ReferralDb = Pick<PrismaClientLike, 'rAReferralCode' | 'rAReferral' | 'user' | 'seekerProfile' | 'rAAuthIdentity'>;

/** Queue kind of the qualification + risk check (the stub name FND-3 reserved). */
export const REFERRAL_WORK_KIND = 'growth.referralRisk';
/** Queue kind of the 30-day signal deletion (workers.ts); queued whenever a signal row is stored. */
export const SIGNAL_PRUNE_WORK_KIND = 'growth.referralSignalPrune';
/** Only accounts created this recently can be attached to an invite. */
export const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The friend's own activity records signals for this long after signup. */
export const INVITEE_SIGNAL_DAYS = 7;
/** First qualification check after signup. */
export const FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;
/** A grant still being written is looked at again after this long. */
export const RETRY_CHECK_DELAY_MS = 5 * 60 * 1000;

const FINAL: ReadonlySet<ReferralStatus> = new Set(['rewarded', 'qualified', 'rejected']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** The first prune runs a little after the first row expires. */
const SIGNAL_PRUNE_SLACK_MS = 60 * 60 * 1000;

export type AttachResult =
  | { status: 'created'; referralId: string }
  | { status: 'rejected'; referralId: string; reason: 'same_person' }
  | { status: 'skipped'; reason: 'invalid_code' | 'unknown_code' | 'self' | 'other_brand' | 'not_new' | 'exists' | 'no_user' | 'disabled' };

export type EvaluateOutcome =
  | 'not_found'
  | 'done'
  | 'waiting'
  | 'held'
  | 'rewarded'
  | 'qualified'
  | 'rejected'
  /** A grant is being written by another call; try again shortly. */
  | 'retry';

export interface ReferralServiceDeps {
  db?: ReferralDb | (() => Promise<ReferralDb>);
  /** `null` = unavailable (SR-60-1 pending). Default: the Prisma store when the model exists. */
  signalStore?: ReferralSignalStore | null | (() => Promise<ReferralSignalStore | null>);
  grantPracticeCredit?: (userId: string, reason: PracticeGrantReason, idempotencyKey: string, options?: { credits?: number }) => Promise<PracticeGrantResult>;
  enqueue?: (kind: string, payload: unknown, options?: EnqueueOptions) => Promise<EnqueuedItem | unknown>;
  sendEmail?: (input: SendEmailInput<ReferralRewardParams>) => Promise<SendEmailResult>;
  /** Is the `invites` capability on for this brand? Default: platform/flags. */
  invitesEnabled?: (brand: BrandId) => Promise<boolean>;
  isDisposableEmail?: (email: string) => boolean;
  randomBytes?: (n: number) => Uint8Array;
  env?: EnvSource;
  now?: () => Date;
}

export interface ReferralService {
  getInvites(userId: string, ctx: { brand: BrandId; signals?: RawSignals }): Promise<InvitesResponse>;
  noteShared(userId: string, ctx: { brand: BrandId; signals?: RawSignals }): Promise<void>;
  attachFromSignup(inviteeUserId: string, rawCode: unknown, options?: { signals?: RawSignals }): Promise<AttachResult>;
  /**
   * A signed-in visit (GET /growth/checklist, GET /invites). A friend with a
   * fresh pending invite: store signals and check it. An inviter with friends
   * still pending: store signals so the check has their side. Never throws.
   */
  noteActivity(userId: string, ctx: { brand: BrandId; signals?: RawSignals }): Promise<void>;
  evaluateReferral(referralId: string, options?: { approved?: boolean }): Promise<EvaluateOutcome>;
  /** Seam for verification / onboarding completion: check the user's referral now. Never throws. */
  checkReferralFor(inviteeUserId: string): Promise<EvaluateOutcome | null>;
  listHeld(brand: BrandId, options?: { limit?: number }): Promise<HeldReferralView[]>;
  reviewReferral(referralId: string, decision: 'approve' | 'reject', brand: BrandId): Promise<{ id: string; status: ReferralStatus }>;
  /** Delete signals older than 30 days; `nextAt` = when the oldest remaining row expires (null = none left). */
  pruneSignals(options?: { now?: Date }): Promise<{ deleted: number; nextAt: Date | null }>;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Start of the UTC calendar year of `at`. */
export function yearStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
}

/** The brand's public origin for links (`CANONICAL_ORIGIN` / `CN_CANONICAL_ORIGIN`, else the registry). */
export function inviteOrigin(brandId: BrandId, env: EnvSource = process.env): string {
  const brand = getBrand(brandId);
  return (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
}

export function createReferralService(deps: ReferralServiceDeps = {}): ReferralService {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;

  async function db(): Promise<ReferralDb> {
    if (typeof deps.db === 'function') return deps.db();
    if (deps.db) return deps.db;
    return (await import('../../lib/prisma.js')).default;
  }

  let storeResolved = false;
  let storeCache: ReferralSignalStore | null = null;
  async function signalStore(): Promise<ReferralSignalStore | null> {
    if (deps.signalStore === null) return null;
    if (typeof deps.signalStore === 'function') return deps.signalStore();
    if (deps.signalStore) return deps.signalStore;
    if (!storeResolved) {
      storeResolved = true;
      storeCache = resolvePrismaSignalStore((await import('../../lib/prisma.js')).default);
      if (!storeCache) logger.warn('GROWTH', 'referral signal store unavailable (schema request SR-60-1 not applied); qualified invites are held for review');
    }
    return storeCache;
  }

  async function grant(userId: string, key: string): Promise<PracticeGrantResult> {
    if (deps.grantPracticeCredit) return deps.grantPracticeCredit(userId, 'referral', key, { credits: REFERRAL_REWARD.credits });
    const credits = await import('../../platform/credits/index.js');
    return credits.grantPracticeCredit(userId, 'referral', key, { credits: REFERRAL_REWARD.credits });
  }

  async function enqueueWork(kind: string, payload: unknown, options: EnqueueOptions): Promise<void> {
    if (deps.enqueue) await deps.enqueue(kind, payload, options);
    else await (await import('../../platform/queue/index.js')).enqueue(kind, payload, options);
  }

  async function enqueueCheck(referralId: string, brand: BrandId, userId: string, delayMs: number): Promise<void> {
    const options: EnqueueOptions = { dedupeKey: `growth.referral:${referralId}`, delayMs, brand, userId, onConflict: 'requeue' };
    try {
      await enqueueWork(REFERRAL_WORK_KIND, { referralId }, options);
    } catch (err) {
      // The friend's own activity and the inviter's page still check it.
      logger.warn('GROWTH', 'referral check not queued', { referralId, error: errText(err) });
    }
  }

  /**
   * Keep one prune item per brand queued while signal rows exist (it re-queues
   * itself until none are left), so deletion after 30 days never depends on
   * referral work. A queued item is left as it is; a finished one is re-queued.
   */
  async function schedulePrune(brand: BrandId): Promise<void> {
    const delayMs = SIGNAL_RETENTION_DAYS * DAY_MS + SIGNAL_PRUNE_SLACK_MS;
    try {
      await enqueueWork(SIGNAL_PRUNE_WORK_KIND, {}, { dedupeKey: `${SIGNAL_PRUNE_WORK_KIND}:${brand}`, delayMs, brand, onConflict: 'requeue' });
    } catch (err) {
      logger.warn('GROWTH', 'referral signal prune not queued', { brand, error: errText(err) });
    }
  }

  async function invitesEnabled(brand: BrandId): Promise<boolean> {
    if (deps.invitesEnabled) return deps.invitesEnabled(brand);
    const flags = await import('../../platform/flags.js');
    return flags.isEnabled('invites', { userId: null, brand: getBrand(brand), env });
  }

  function disposable(email: string | null | undefined): boolean {
    if (!email) return false;
    if (deps.isDisposableEmail) return deps.isDisposableEmail(email);
    return disposableDefault(email);
  }

  async function record(userId: string, brand: BrandId, raw: RawSignals | undefined): Promise<void> {
    if (!raw) return;
    try {
      const store = await signalStore();
      const signals = hashSignals(raw, env);
      if (!store || !signals) return;
      if (await store.record({ userId, brand, signals, at: now() })) await schedulePrune(brand);
    } catch (err) {
      logger.warn('GROWTH', 'referral signal not stored', { userId, error: errText(err) });
    }
  }

  /** Verified = confirmed email (not a placeholder), a verified phone, or an SSO identity. */
  async function isVerified(d: ReferralDb, userId: string): Promise<{ exists: boolean; verified: boolean; email: string | null }> {
    const u = await d.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, emailIsPlaceholder: true, phoneVerifiedAt: true } });
    if (!u) return { exists: false, verified: false, email: null };
    if ((u.emailVerified && !u.emailIsPlaceholder) || u.phoneVerifiedAt) return { exists: true, verified: true, email: u.email };
    const sso = await d.rAAuthIdentity.count({ where: { userId } });
    return { exists: true, verified: sso > 0, email: u.email };
  }

  async function ensureCode(d: ReferralDb, userId: string, brand: BrandId): Promise<string> {
    const existing = await d.rAReferralCode.findUnique({ where: { userId }, select: { code: true } });
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateReferralCode(deps.randomBytes);
      try {
        await d.rAReferralCode.create({ data: { userId, brand, code } });
        return code;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either a concurrent request created this user's code, or the code collided.
        const raced = await d.rAReferralCode.findUnique({ where: { userId }, select: { code: true } });
        if (raced) return raced.code;
      }
    }
    throw new HttpError('internal_error', 'Could not create an invite code.');
  }

  async function rewardsThisYear(d: ReferralDb, inviterUserId: string, at: Date): Promise<number> {
    return d.rAReferral.count({ where: { inviterUserId, status: 'rewarded', rewardedAt: { gte: yearStart(at) } } });
  }

  async function notify(userId: string, brand: BrandId, role: ReferralRewardParams['role']): Promise<void> {
    try {
      const d = await db();
      const u = await d.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!u?.email) return;
      const p = await d.seekerProfile.findUnique({ where: { userId }, select: { locale: true } });
      const input: SendEmailInput<ReferralRewardParams> = {
        template: referralRewardEmail,
        to: u.email,
        userId,
        locale: p?.locale ?? null,
        brand,
        params: { role, credits: REFERRAL_REWARD.credits },
      };
      if (deps.sendEmail) await deps.sendEmail(input);
      else await (await import('../../platform/email/index.js')).sendEmail(input);
    } catch (err) {
      logger.warn('GROWTH', 'referral reward email not sent', { userId, error: errText(err) });
    }
  }

  async function assessRisk(
    d: ReferralDb,
    r: { id: string; inviterUserId: string; inviteeUserId: string; createdAt: Date },
  ): Promise<RiskResult> {
    const store = await signalStore();
    const since = new Date(now().getTime() - SIGNAL_RETENTION_DAYS * DAY_MS);
    let rows: Awaited<ReturnType<ReferralSignalStore['forUsers']>> = [];
    let available = !!store;
    if (store) {
      try {
        rows = await store.forUsers([r.inviterUserId, r.inviteeUserId], since);
      } catch (err) {
        available = false;
        logger.warn('GROWTH', 'referral signals unreadable; holding', { referralId: r.id, error: errText(err) });
      }
    }
    const invitee = await d.user.findUnique({ where: { id: r.inviteeUserId }, select: { email: true, emailIsPlaceholder: true } });
    const burst = await d.rAReferral.count({
      where: {
        inviterUserId: r.inviterUserId,
        createdAt: { gte: new Date(r.createdAt.getTime() - SIGNAL_WINDOW_MS), lte: new Date(r.createdAt.getTime() + SIGNAL_WINDOW_MS) },
      },
    });
    return scoreReferralRisk({
      inviterSignals: rows.filter((s) => s.userId === r.inviterUserId),
      inviteeSignals: rows.filter((s) => s.userId === r.inviteeUserId),
      signalsAvailable: available,
      inviteeEmailDisposable: !invitee?.emailIsPlaceholder && disposable(invitee?.email),
      signupsOnLinkWithin24h: burst,
    });
  }

  async function qualified(d: ReferralDb, inviteeUserId: string): Promise<boolean> {
    const v = await isVerified(d, inviteeUserId);
    if (!v.verified) return false;
    const p = await d.seekerProfile.findUnique({ where: { userId: inviteeUserId }, select: { onboardingStep: true } });
    return p?.onboardingStep === 'done';
  }

  /** granted/already_granted → ok; in_progress → retry; no_profile → gone (permanent); failed → throw (transient: retried). */
  function settle(result: PracticeGrantResult): 'ok' | 'retry' | 'gone' {
    if (result.status === 'granted' || result.status === 'already_granted') return 'ok';
    if (result.status === 'in_progress') return 'retry';
    if (result.status === 'no_profile') return 'gone';
    throw new Error(`referral credit not granted (${result.status})`);
  }

  /** Hold only because a side has no stored signals yet, and the friend is still new: wait for them to use the product. */
  function waitForSignals(risk: RiskResult, createdAt: Date, at: Date): boolean {
    if (!risk.reasons.includes('signals_missing')) return false;
    if (risk.score - RISK_WEIGHTS.signals_missing >= REFERRAL_HOLD_SCORE) return false;
    return at.getTime() - createdAt.getTime() < INVITEE_SIGNAL_DAYS * DAY_MS;
  }

  type ClaimedReferral = { id: string; brand: string; inviterUserId: string; inviteeUserId: string };

  /** The row is claimed for a reward (pending with qualifiedAt set): grant both sides and finish. */
  async function grantClaimed(d: ReferralDb, r: ClaimedReferral, at: Date): Promise<EvaluateOutcome> {
    const brand: BrandId = isBrandId(r.brand) ? r.brand : 'roboapply';
    const retryLater = async (): Promise<EvaluateOutcome> => {
      await enqueueCheck(r.id, brand, r.inviteeUserId, RETRY_CHECK_DELAY_MS);
      return 'retry';
    };

    // The friend's credit: once per friend account, whatever the inviter's cap.
    const inviteeGrant = await grant(r.inviteeUserId, `referral_invitee:${r.inviteeUserId}`);
    const invitee = settle(inviteeGrant);
    if (invitee === 'retry') return retryLater();
    if (invitee === 'gone') {
      // The friend's profile is gone (account deleted or never set up): nothing to give either side.
      const { count } = await d.rAReferral.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'rejected', riskReasons: ['invitee_no_profile'] },
      });
      logger.warn('GROWTH', 'referral not counted: the friend has no profile', { referralId: r.id });
      return count > 0 ? 'rejected' : 'done';
    }

    // The inviter's credit: up to the yearly cap.
    let final: 'rewarded' | 'qualified' = 'qualified';
    let inviterGrant: PracticeGrantResult | null = null;
    if ((await rewardsThisYear(d, r.inviterUserId, at)) < INVITE_REWARD_CAP_PER_YEAR) {
      inviterGrant = await grant(r.inviterUserId, `referral_inviter:${r.id}`);
      const inviter = settle(inviterGrant);
      if (inviter === 'retry') return retryLater();
      if (inviter === 'gone') logger.warn('GROWTH', "referral: the inviter has no profile; only the friend's credit was granted", { referralId: r.id });
      else final = 'rewarded';
    }
    const { count } = await d.rAReferral.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: final, rewardedAt: final === 'rewarded' ? at : null },
    });
    if (count === 0) return 'done';
    logger.info('GROWTH', 'referral reward granted', { referralId: r.id, status: final });
    if (inviteeGrant.status === 'granted') await notify(r.inviteeUserId, brand, 'invitee');
    if (final === 'rewarded' && inviterGrant?.status === 'granted') await notify(r.inviterUserId, brand, 'inviter');
    return final;
  }

  const service: ReferralService = {
    async getInvites(userId, ctx) {
      const d = await db();
      const at = now();
      const year = at.getUTCFullYear();
      const reward = { bucket: REFERRAL_REWARD.bucket, credits: REFERRAL_REWARD.credits };
      const v = await isVerified(d, userId);
      const referrals = await d.rAReferral.findMany({
        where: { inviterUserId: userId },
        select: { id: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const invites = referrals.map((r) => ({
        status: INVITE_VIEW_STATUS[(r.status as ReferralStatus) in INVITE_VIEW_STATUS ? (r.status as ReferralStatus) : 'pending'],
        at: r.createdAt.toISOString(),
      }));
      const rewards = { granted: await rewardsThisYear(d, userId, at), capPerYear: INVITE_REWARD_CAP_PER_YEAR, year };
      if (!inviteSignupWired(ctx.brand)) return { eligibility: 'not_available', code: null, path: null, link: null, reward, invites, rewards };
      if (!v.verified) return { eligibility: 'verify_account', code: null, path: null, link: null, reward, invites, rewards };
      await record(userId, ctx.brand, ctx.signals);
      const code = await ensureCode(d, userId, ctx.brand);
      const path = invitePath(code);
      return { eligibility: 'ok', code, path, link: `${inviteOrigin(ctx.brand, env)}${path}`, reward, invites, rewards };
    },

    async noteShared(userId, ctx) {
      await record(userId, ctx.brand, ctx.signals);
    },

    async attachFromSignup(inviteeUserId, rawCode, options = {}) {
      const code = normalizeReferralCode(rawCode);
      if (!code) return { status: 'skipped', reason: 'invalid_code' };
      const d = await db();
      const owner = await d.rAReferralCode.findUnique({ where: { code }, select: { userId: true, brand: true } });
      if (!owner) return { status: 'skipped', reason: 'unknown_code' };
      if (owner.userId === inviteeUserId) return { status: 'skipped', reason: 'self' };
      const invitee = await d.user.findUnique({ where: { id: inviteeUserId }, select: { email: true, brand: true, createdAt: true } });
      if (!invitee) return { status: 'skipped', reason: 'no_user' };
      if (invitee.brand !== owner.brand || !isBrandId(owner.brand)) return { status: 'skipped', reason: 'other_brand' };
      const brand = owner.brand;
      if (now().getTime() - invitee.createdAt.getTime() > NEW_ACCOUNT_WINDOW_MS) return { status: 'skipped', reason: 'not_new' };
      if (!inviteSignupWired(brand) || !(await invitesEnabled(brand))) return { status: 'skipped', reason: 'disabled' };
      const existing = await d.rAReferral.findUnique({ where: { inviteeUserId }, select: { id: true } });
      if (existing) return { status: 'skipped', reason: 'exists' };

      const inviter = await d.user.findUnique({ where: { id: owner.userId }, select: { email: true } });
      const a = normalizeEmailForReferral(inviter?.email);
      const samePerson = !!a && a === normalizeEmailForReferral(invitee.email);
      let referralId: string;
      try {
        const row = await d.rAReferral.create({
          data: {
            brand,
            inviterUserId: owner.userId,
            inviteeUserId,
            status: samePerson ? 'rejected' : 'pending',
            riskReasons: samePerson ? ['same_person'] : [],
          },
          select: { id: true },
        });
        referralId = row.id;
      } catch (err) {
        if (isUniqueViolation(err)) return { status: 'skipped', reason: 'exists' };
        throw err;
      }
      if (samePerson) return { status: 'rejected', referralId, reason: 'same_person' };
      await record(inviteeUserId, brand, options.signals);
      await enqueueCheck(referralId, brand, inviteeUserId, FIRST_CHECK_DELAY_MS);
      return { status: 'created', referralId };
    },

    async noteActivity(userId, ctx) {
      try {
        const d = await db();
        const r = await d.rAReferral.findUnique({ where: { inviteeUserId: userId }, select: { id: true, status: true, createdAt: true } });
        if (r && r.status === 'pending') {
          if (now().getTime() - r.createdAt.getTime() <= INVITEE_SIGNAL_DAYS * DAY_MS) await record(userId, ctx.brand, ctx.signals);
          await service.evaluateReferral(r.id);
        }
        // An inviter whose friends are still being checked: note this browser too.
        const waiting = await d.rAReferral.count({ where: { inviterUserId: userId, status: 'pending' } });
        if (waiting > 0) await record(userId, ctx.brand, ctx.signals);
      } catch (err) {
        logger.warn('GROWTH', 'referral activity check failed', { userId, error: errText(err) });
      }
    },

    async evaluateReferral(referralId, options = {}) {
      const d = await db();
      const r = await d.rAReferral.findUnique({
        where: { id: referralId },
        select: { id: true, brand: true, inviterUserId: true, inviteeUserId: true, status: true, qualifiedAt: true, createdAt: true },
      });
      if (!r) return 'not_found';
      const status = r.status as ReferralStatus;
      if (FINAL.has(status)) return 'done';
      const at = now();

      if (status === 'held') {
        if (!options.approved) return 'done';
        // Staff approved: claim the row back to `pending` (qualifiedAt stays
        // set) before any credit, so a concurrent reject cannot land after it.
        const { count } = await d.rAReferral.updateMany({ where: { id: r.id, status: 'held' }, data: { status: 'pending', qualifiedAt: r.qualifiedAt ?? at } });
        if (count === 0) return 'done';
      } else if (!r.qualifiedAt) {
        // Pending and not decided yet.
        if (!(await qualified(d, r.inviteeUserId))) return 'waiting';
        const risk = await assessRisk(d, r);
        if (risk.hold && waitForSignals(risk, r.createdAt, at)) return 'waiting';
        if (risk.hold) {
          const { count } = await d.rAReferral.updateMany({
            where: { id: r.id, status: 'pending', qualifiedAt: null },
            data: { status: 'held', riskScore: risk.score, riskReasons: risk.reasons, qualifiedAt: at },
          });
          if (count > 0) logger.info('GROWTH', 'referral held for review', { referralId: r.id, score: risk.score, reasons: risk.reasons });
          return count > 0 ? 'held' : 'done';
        }
        // Claim before granting: only the caller whose update lands grants.
        const { count } = await d.rAReferral.updateMany({
          where: { id: r.id, status: 'pending', qualifiedAt: null },
          data: { qualifiedAt: at, riskScore: risk.score, riskReasons: risk.reasons },
        });
        if (count === 0) return 'done';
      }
      // Pending with qualifiedAt set = claimed for a reward (by this call or an
      // earlier one that did not finish): grant, idempotently, and finish.
      return grantClaimed(d, r, at);
    },

    async checkReferralFor(inviteeUserId) {
      try {
        const d = await db();
        const r = await d.rAReferral.findUnique({ where: { inviteeUserId }, select: { id: true } });
        if (!r) return null;
        return await service.evaluateReferral(r.id);
      } catch (err) {
        logger.warn('GROWTH', 'referral check failed', { inviteeUserId, error: errText(err) });
        return null;
      }
    },

    async listHeld(brand, options = {}) {
      const d = await db();
      const rows = await d.rAReferral.findMany({
        where: { brand, status: 'held' },
        select: { id: true, brand: true, inviterUserId: true, inviteeUserId: true, riskScore: true, riskReasons: true, createdAt: true, qualifiedAt: true },
        orderBy: { createdAt: 'asc' },
        take: Math.min(Math.max(options.limit ?? 100, 1), 200),
      });
      return rows.map((r) => ({
        id: r.id,
        brand: r.brand,
        inviterUserId: r.inviterUserId,
        inviteeUserId: r.inviteeUserId,
        riskScore: r.riskScore,
        riskReasons: r.riskReasons,
        signedUpAt: r.createdAt.toISOString(),
        qualifiedAt: r.qualifiedAt ? r.qualifiedAt.toISOString() : null,
      }));
    },

    async reviewReferral(referralId, decision, brand) {
      const d = await db();
      const r = await d.rAReferral.findUnique({ where: { id: referralId }, select: { id: true, brand: true, status: true } });
      if (!r || r.brand !== brand) throw new HttpError('not_found', 'No such referral.');
      if (r.status !== 'held') throw new HttpError('conflict', 'Only held referrals can be reviewed.', { status: r.status });
      if (decision === 'reject') {
        const { count } = await d.rAReferral.updateMany({ where: { id: r.id, status: 'held' }, data: { status: 'rejected' } });
        if (count === 0) throw new HttpError('conflict', 'This referral was already reviewed.');
        return { id: r.id, status: 'rejected' };
      }
      let outcome: EvaluateOutcome;
      try {
        outcome = await service.evaluateReferral(r.id, { approved: true });
      } catch (err) {
        // Approved and claimed, but a credit could not be written: the worker finishes it.
        logger.warn('GROWTH', 'approved referral reward not written yet', { referralId: r.id, error: errText(err) });
        const row = await d.rAReferral.findUnique({ where: { id: r.id }, select: { inviteeUserId: true } });
        if (row) await enqueueCheck(r.id, brand, row.inviteeUserId, RETRY_CHECK_DELAY_MS);
        throw new HttpError('conflict', 'Approved. The credits could not be added yet; they are retried automatically.');
      }
      if (outcome === 'retry') throw new HttpError('conflict', 'Approved. The credits are still being added; this finishes on its own.');
      const after = await d.rAReferral.findUnique({ where: { id: r.id }, select: { status: true } });
      return { id: r.id, status: (after?.status ?? r.status) as ReferralStatus };
    },

    async pruneSignals(options = {}) {
      const store = await signalStore();
      if (!store) return { deleted: 0, nextAt: null };
      const retention = SIGNAL_RETENTION_DAYS * DAY_MS;
      const deleted = await store.prune(new Date((options.now ?? now()).getTime() - retention));
      const oldest = await store.oldestAt();
      return { deleted, nextAt: oldest ? new Date(oldest.getTime() + retention) : null };
    },
  };
  return service;
}

// ── Disposable inboxes (the same lists signup uses) ──────────────────────

function disposableDefault(email: string): boolean {
  return classifyEmailDomain(email).reason === 'disposable';
}

export const referralServiceImpl: ReferralService = createReferralService();

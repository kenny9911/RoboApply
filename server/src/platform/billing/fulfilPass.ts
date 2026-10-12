// server/src/platform/billing/fulfilPass.ts
//
// `fulfilPass(order)` — the one fulfilment path for every CN rail (Alipay
// today, WeChat Pay from WP-62). ARCHITECTURE.md §7.4; TASK_PLAN.md WP-21a.
//
// Given a paid order number it:
//   1. checks the order exists (`AlipayOrder`, which records any CN-rail
//      order) and that the paid amount matches what we asked for;
//   2. claims the order (pending → completed) — a conditional update, so a
//      replayed or concurrent notify finds it completed and does nothing;
//   3. in the same transaction activates the pass: tier 'pro', the plan key,
//      interval 'pass', `currentPeriodEnd` = (the later of now and the end of
//      a live pass) + the pass length — buying again ("续费") extends;
//      practice packs change no subscription;
//   4. grants practice credits: the pass's allowance (grantForPlan) or the
//      pack's credits (idempotent per order). A replayed notify re-runs the
//      grant safely (pack key / pass period guard), so a crash between the
//      claim and the grant heals on the provider's next notify.
//   5. tells the buyer on WeChat when a GoApply WeChat Pay order is fulfilled
//      (`payment_success` 订阅通知 through features/notify-cn). Only on the
//      run that claimed the order, so a replayed notify sends nothing; a
//      failed or skipped notice never fails the fulfilment.
// Legacy orders (`ra_starter` / `ra_growth`, RoboApply Alipay monthly
// passes from before the clone) are honoured the old way: 30 days.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { parseBrandId, type BrandId } from '../brand/registry.js';
import { PLAN_DEFINITIONS, isLegacyPlanKey, isPlanKey, type PlanDefinition } from './planCatalog.js';
import { grantPracticePack } from './packs.js';

export type FulfilDb = Pick<ExtendedPrismaClient, '$transaction' | 'alipayOrder' | 'seekerProfile' | 'seekerSubscription'>;

export interface PassOrderRef {
  /** Our order number (AlipayOrder.outTradeNo). */
  outTradeNo: string;
  channel: 'alipay' | 'wechatpay';
  /** What the provider says was paid, minor units; null when it did not say. */
  paidAmountMinor?: number | null;
  transactionId?: string | null;
}

export type FulfilStatus = 'fulfilled' | 'already_fulfilled' | 'not_found' | 'amount_mismatch' | 'unknown_plan';

export interface FulfilResult {
  status: FulfilStatus;
  orderId?: string;
  userId?: string;
  planKey?: string;
  brand?: BrandId;
  periodEnd?: Date | null;
  /** False when the order was paid but the user has no seeker profile to attach it to. */
  activated?: boolean;
}

export interface FulfilDeps {
  getDb?: () => Promise<FulfilDb>;
  now?: () => Date;
  grantPlan?: (input: {
    userId: string;
    tier: 'pro' | 'starter' | 'growth';
    credits?: number;
    source: string;
    currentPeriodEnd: Date | null;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /** Period-guarded plan grant (mockCreditService.grantForPlanIfNewPeriod); used on replays. */
  grantPlanIfNewPeriod?: (input: {
    userId: string;
    tier: 'pro' | 'starter' | 'growth';
    credits?: number;
    periodStart: Date;
    currentPeriodEnd: Date | null;
    source: string;
    force: false;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
  grantPack?: (input: { userId: string; credits: number; idempotencyKey: string; purchasedAt: Date }) => Promise<unknown>;
  invalidate?: (userId: string) => void;
  /**
   * The "payment received" WeChat notice for a fulfilled GoApply WeChat Pay
   * order (default: `notifyCnService().sendNotice`, which skips quietly when
   * WeChat notices are off, the person is not linked or gave no permission).
   */
  notifyPaid?: (notice: PaidNotice) => Promise<unknown>;
}

/** What the `payment_success` notice is filled from: the order's own facts (D3). */
export interface PaidNotice {
  userId: string;
  template: 'payment_success';
  params: { planName: string; amountFen: number; paidAt: string; orderNo: string };
  /** Where the message opens. */
  href: string;
  /** One permission per order: the notice spends the grant given for this order first. */
  eventId: string;
}

/** Where the "payment received" notice opens. */
export const PAID_NOTICE_HREF = '/settings/billing';

const DAY_MS = 86_400_000;
const LEGACY_PASS_DAYS = 30;

const defaultGetDb = async (): Promise<FulfilDb> => (await import('../../lib/prisma.js')).default;

const defaultGrantPlan: NonNullable<FulfilDeps['grantPlan']> = async (input) => {
  const { grantForPlan } = await import('../../lib/mockCreditService.js');
  await grantForPlan({ ...input, reason: 'grant_purchase' });
};

const defaultGrantPlanIfNewPeriod: NonNullable<FulfilDeps['grantPlanIfNewPeriod']> = async (input) => {
  const { grantForPlanIfNewPeriod } = await import('../../lib/mockCreditService.js');
  return grantForPlanIfNewPeriod(input);
};

const defaultNotifyPaid: NonNullable<FulfilDeps['notifyPaid']> = async (notice) => {
  const { notifyCnService } = await import('../../features/notify-cn/index.js');
  return notifyCnService().sendNotice(notice);
};

const defaultInvalidate = (userId: string): void => {
  void import('../credits/EntitlementService.js').then((m) => m.entitlementService.invalidate(userId)).catch(() => {});
};

function definitionFor(brand: BrandId, planKey: string): PlanDefinition | null {
  if (!isPlanKey(planKey)) return null;
  return PLAN_DEFINITIONS[brand].find((d) => d.key === planKey) ?? null;
}

export async function fulfilPass(order: PassOrderRef, deps: FulfilDeps = {}): Promise<FulfilResult> {
  const db = await (deps.getDb ?? defaultGetDb)();
  const now = (deps.now ?? (() => new Date()))();
  const grantPlan = deps.grantPlan ?? defaultGrantPlan;
  const grantPlanIfNewPeriod = deps.grantPlanIfNewPeriod ?? defaultGrantPlanIfNewPeriod;
  const grantPack = deps.grantPack ?? ((input) => grantPracticePack(input));
  const invalidate = deps.invalidate ?? defaultInvalidate;
  const notifyPaid = deps.notifyPaid ?? defaultNotifyPaid;

  const row = await db.alipayOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
  if (!row || !row.tier.startsWith('ra_')) return { status: 'not_found' };

  const brand: BrandId = parseBrandId(row.brand) ?? 'roboapply';
  const planKey = row.planKey ?? row.tier.slice('ra_'.length);
  const legacy = isLegacyPlanKey(planKey);
  const def = legacy ? null : definitionFor(brand, planKey);
  if (!legacy && (!def || (def.kind !== 'pass' && def.kind !== 'pack'))) {
    logger.error('RA_BILLING', 'fulfilPass: order has no pass or pack plan', { outTradeNo: order.outTradeNo, planKey, brand });
    return { status: 'unknown_plan', orderId: row.id, planKey };
  }

  const expected = row.amountMinor ?? Math.round(row.amount * 100);
  if (order.paidAmountMinor !== null && order.paidAmountMinor !== undefined && order.paidAmountMinor !== expected) {
    logger.error('RA_BILLING', 'fulfilPass: paid amount does not match the order', {
      outTradeNo: order.outTradeNo,
      expected,
      paid: order.paidAmountMinor,
    });
    return { status: 'amount_mismatch', orderId: row.id, userId: row.userId, planKey };
  }

  const tx = await db.$transaction(async (t) => {
    const claim = await t.alipayOrder.updateMany({
      where: { outTradeNo: order.outTradeNo, status: { not: 'completed' } },
      data: {
        status: 'completed',
        completedAt: now,
        ...(order.channel === 'wechatpay' && order.transactionId ? { wxTransactionId: order.transactionId } : {}),
      },
    });
    if (claim.count !== 1) return { claimed: false as const };

    if (def?.kind === 'pack') return { claimed: true as const, activated: true, periodEnd: null };

    const profile = await t.seekerProfile.findUnique({ where: { userId: row.userId }, select: { id: true } });
    if (!profile) {
      logger.warn('RA_BILLING', 'fulfilPass: no seeker profile', { userId: row.userId, outTradeNo: order.outTradeNo });
      return { claimed: true as const, activated: false, periodEnd: null };
    }
    const current = await t.seekerSubscription.findUnique({
      where: { seekerProfileId: profile.id },
      select: { tier: true, planKey: true, status: true, currentPeriodEnd: true, startedAt: true },
    });
    const amountMinor = expected;

    if (legacy) {
      const periodEnd = new Date(now.getTime() + LEGACY_PASS_DAYS * DAY_MS);
      const data = {
        tier: planKey as 'starter' | 'growth',
        status: 'active',
        market: 'cn',
        currency: 'CNY',
        amountMinor,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        startedAt: now,
        rail: order.channel,
        planKey,
        interval: 'pass',
      };
      await t.seekerSubscription.upsert({
        where: { seekerProfileId: profile.id },
        update: data,
        create: { seekerProfileId: profile.id, ...data },
      });
      return { claimed: true as const, activated: true, periodEnd };
    }

    // A pass: extend from the end of a live pass, else start now.
    const liveEnd =
      current && String(current.tier) === 'pro' && current.status === 'active' && current.currentPeriodEnd && current.currentPeriodEnd > now
        ? current.currentPeriodEnd
        : null;
    const base = liveEnd ?? now;
    const periodEnd = new Date(base.getTime() + (def!.passDays ?? 0) * DAY_MS);
    const data = {
      tier: 'pro' as const,
      status: 'active',
      brand,
      planKey,
      interval: 'pass',
      rail: order.channel,
      market: brand === 'goapply' ? 'cn' : 'other',
      currency: 'CNY',
      amountMinor,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      startedAt: liveEnd ? (current?.startedAt ?? now) : now,
    };
    await t.seekerSubscription.upsert({
      where: { seekerProfileId: profile.id },
      update: data,
      create: { seekerProfileId: profile.id, ...data },
    });
    return { claimed: true as const, activated: true, periodEnd };
  });

  if (!tx.claimed) {
    // A replayed notify. Re-run the grant in case the first run stopped between
    // the claim and the grant: packs through their idempotency key, passes
    // through the period guard (periodStart = when the order was completed, so
    // a grant that did happen — renewedAt ≥ completedAt — is skipped).
    const fresh = await db.alipayOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
    const completedAt = fresh?.completedAt ?? row.completedAt ?? null;
    if (def?.kind === 'pack' && def.practice) {
      await grantPack({ userId: row.userId, credits: def.practice.credits, idempotencyKey: `order:${row.id}`, purchasedAt: completedAt ?? now });
    } else if (completedAt) {
      const profile = await db.seekerProfile.findUnique({ where: { userId: row.userId }, select: { id: true } });
      const sub = profile
        ? await db.seekerSubscription.findUnique({ where: { seekerProfileId: profile.id }, select: { planKey: true, currentPeriodEnd: true } })
        : null;
      // Only while this order's plan is still the one running.
      if (sub && sub.planKey === planKey && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
        try {
          await grantPlanIfNewPeriod({
            userId: row.userId,
            tier: legacy ? (planKey as 'starter' | 'growth') : 'pro',
            credits: legacy ? undefined : (def?.practice?.credits ?? 0),
            periodStart: completedAt,
            currentPeriodEnd: sub.currentPeriodEnd,
            source: order.channel,
            force: false,
            metadata: { outTradeNo: order.outTradeNo, planKey, amountMinor: expected, replay: true },
          });
        } catch (err) {
          logger.error('RA_BILLING', 'fulfilPass: replay grant failed', { outTradeNo: order.outTradeNo, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { status: 'already_fulfilled', orderId: row.id, userId: row.userId, planKey, brand };
  }

  try {
    if (def?.kind === 'pack' && def.practice) {
      await grantPack({ userId: row.userId, credits: def.practice.credits, idempotencyKey: `order:${row.id}`, purchasedAt: now });
    } else if (tx.activated) {
      await grantPlan({
        userId: row.userId,
        tier: legacy ? (planKey as 'starter' | 'growth') : 'pro',
        credits: legacy ? undefined : (def?.practice?.credits ?? 0),
        source: order.channel,
        currentPeriodEnd: tx.periodEnd,
        metadata: { outTradeNo: order.outTradeNo, planKey, amountMinor: expected },
      });
    }
  } catch (err) {
    logger.error('RA_BILLING', 'fulfilPass: credit grant failed', {
      outTradeNo: order.outTradeNo,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  invalidate(row.userId);
  logger.info('RA_BILLING', 'pass fulfilled', { outTradeNo: order.outTradeNo, userId: row.userId, planKey, brand, channel: order.channel });
  // WeChat notices exist on GoApply only, and only a WeChat Pay buyer was
  // asked for the permission at checkout. This is the run that claimed the
  // order, so each order sends at most once.
  if (order.channel === 'wechatpay' && brand === 'goapply' && def) {
    try {
      await notifyPaid({
        userId: row.userId,
        template: 'payment_success',
        params: { planName: def.defaultLabel, amountFen: expected, paidAt: now.toISOString(), orderNo: order.outTradeNo },
        href: PAID_NOTICE_HREF,
        eventId: order.outTradeNo,
      });
    } catch (err) {
      logger.warn('RA_BILLING', 'fulfilPass: payment notice failed', {
        outTradeNo: order.outTradeNo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    status: 'fulfilled',
    orderId: row.id,
    userId: row.userId,
    planKey,
    brand,
    periodEnd: tx.periodEnd,
    activated: tx.activated,
  };
}

/** Mark a pending CN order closed (provider says the trade closed unpaid). */
export async function closePendingOrder(outTradeNo: string, deps: { getDb?: () => Promise<FulfilDb> } = {}): Promise<boolean> {
  const db = await (deps.getDb ?? defaultGetDb)();
  const res = await db.alipayOrder.updateMany({ where: { outTradeNo, status: 'pending' }, data: { status: 'closed' } });
  return res.count === 1;
}

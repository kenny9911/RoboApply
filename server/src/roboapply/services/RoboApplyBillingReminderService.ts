// backend/src/roboapply/services/RoboApplyBillingReminderService.ts
//
// Two lifecycle email sweeps for RoboApply billing:
//   1. runRenewalReminderSweep — T-5d before a paid plan's monthly period ends.
//      Stripe subs say "renews automatically"; CN/Alipay passes say "expires —
//      renew now". Always sent (transactional), deduped per (sub, periodEnd).
//   2. runFridayNudgeSweep — weekly "prep for next week's interviews" engagement
//      nudge to users with credits / an active plan. Honors weeklyNudgeOptOut,
//      deduped per (user, ISO week).
//
// Both are best-effort and idempotent via Notification.dedupKey (a unique
// constraint → P2002 on a repeat = already sent). Driven by RoboApplyCronService.

import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { emailService } from '../../services/EmailService.js';
import { getBalance } from '../../lib/mockCreditService.js';
import { isPaidMockPlan } from '../../lib/mockInterviewPlans.js';
import { renderRenewalEmail, renderFridayNudgeEmail, type RoboEmailLocale } from '../lib/billingEmails.js';

// RoboApply mock-interview paid plans ONLY. Deliberately excludes the legacy
// premium / premium_plus seeker tiers — those are deprecated for the mock
// product and must not receive Starter/Growth billing emails.
const RA_PAID_TIERS = ['starter', 'growth'];

function roboApplyBaseUrl(): string {
  return process.env.NEXT_PUBLIC_ROBOAPPLY_URL || process.env.ROBOAPPLY_URL || 'https://roboapply.robohire.io';
}
function fromHeader(): string {
  return process.env.ROBOAPPLY_EMAIL_FROM || 'RoboApply <noreply@updates.robohire.io>';
}

function resolveEmailLocale(locale: string | null | undefined, market: string | null | undefined): RoboEmailLocale {
  const l = (locale ?? '').trim();
  if (l === 'en' || l === 'zh' || l === 'zh-TW' || l === 'ja') return l;
  const m = (market ?? '').trim().toLowerCase();
  if (m === 'cn') return 'zh';
  if (m === 'tw') return 'zh-TW';
  if (m === 'jp') return 'ja';
  return 'en';
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Claim a dedupKey by inserting a Notification row. Returns the row id when
 *  newly claimed, or null when a row already exists (P2002). */
async function claimDedup(input: {
  dedupKey: string;
  userId: string;
  type: string;
  title: string;
}): Promise<string | null> {
  try {
    const row = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        dedupKey: input.dedupKey,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err: any) {
    if (err?.code === 'P2002') return null; // already sent
    throw err;
  }
}

async function markEmailSent(notificationId: string): Promise<void> {
  await prisma.notification.update({ where: { id: notificationId }, data: { emailSent: true } }).catch(() => {});
}

export interface SweepResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

// ─── 1. Renewal reminder (T-5d) ───────────────────────────────────────────────

export async function runRenewalReminderSweep(opts: { now?: Date } = {}): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!emailService.isConfigured) {
    logger.info('RA_BILLING_REMINDER', 'renewal sweep skipped — email not configured');
    return result;
  }
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

  const subs = await prisma.seekerSubscription.findMany({
    where: {
      status: { in: ['active', 'trialing'] },
      tier: { in: RA_PAID_TIERS as never },
      currentPeriodEnd: { gte: windowStart, lt: windowEnd },
    },
    select: {
      id: true,
      tier: true,
      currency: true,
      stripeSubscriptionId: true,
      currentPeriodEnd: true,
      seekerProfile: {
        select: { locale: true, market: true, user: { select: { id: true, email: true, name: true } } },
      },
    },
    take: 5000,
  });

  for (const sub of subs) {
    result.scanned++;
    const user = sub.seekerProfile?.user;
    if (!user?.email || !sub.currentPeriodEnd) {
      result.skipped++;
      continue;
    }
    const periodEndIso = sub.currentPeriodEnd.toISOString();
    const dedupKey = `ra_renewal_reminder:${sub.id}:${periodEndIso.slice(0, 10)}`;
    let notifId: string | null;
    try {
      notifId = await claimDedup({ dedupKey, userId: user.id, type: 'ra_renewal_reminder', title: 'RoboApply renewal reminder' });
    } catch (err) {
      logger.warn('RA_BILLING_REMINDER', 'renewal dedup claim failed', { subId: sub.id, error: err instanceof Error ? err.message : String(err) });
      result.failed++;
      continue;
    }
    if (!notifId) {
      result.skipped++;
      continue;
    }

    try {
      const tier = String(sub.tier);
      const planLabel = tier === 'growth' || tier === 'premium_plus' ? 'Growth' : 'Starter';
      const manualRenewal = isPaidMockPlan(tier) && !sub.stripeSubscriptionId && sub.currency === 'CNY';
      const locale = resolveEmailLocale(sub.seekerProfile?.locale, sub.seekerProfile?.market);
      const balance = await getBalance(user.id);
      const ctaUrl = `${roboApplyBaseUrl()}/account?billing=${manualRenewal ? 'renew' : 'manage'}`;
      const { subject, html } = renderRenewalEmail({
        locale,
        planLabel,
        periodEndIso,
        manualRenewal,
        credits: balance.credits,
        ctaUrl,
      });
      const ok = await emailService.send({ to: user.email, subject, html, from: fromHeader() });
      if (ok) {
        await markEmailSent(notifId);
        result.sent++;
      } else {
        result.failed++;
      }
    } catch (err) {
      logger.warn('RA_BILLING_REMINDER', 'renewal send failed', { subId: sub.id, error: err instanceof Error ? err.message : String(err) });
      result.failed++;
    }
  }

  logger.info('RA_BILLING_REMINDER', 'renewal sweep complete', { ...result });
  return result;
}

// ─── 2. Friday "prep for next week" nudge ─────────────────────────────────────

export async function runFridayNudgeSweep(opts: { now?: Date } = {}): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!emailService.isConfigured) {
    logger.info('RA_BILLING_REMINDER', 'friday nudge sweep skipped — email not configured');
    return result;
  }
  const now = opts.now ?? new Date();
  const week = isoWeek(now);

  // Engaged users: an active paid plan OR a positive credit balance. Opt-outs and
  // soft-deleted profiles are excluded.
  const subs = await prisma.seekerSubscription.findMany({
    where: {
      OR: [{ tier: { in: RA_PAID_TIERS as never }, status: 'active' }, { mockCredits: { gt: 0 } }],
      seekerProfile: { weeklyNudgeOptOut: false, deletedAt: null },
    },
    select: {
      mockCredits: true,
      seekerProfile: {
        select: { locale: true, market: true, user: { select: { id: true, email: true, name: true } } },
      },
    },
    take: 5000,
  });

  for (const sub of subs) {
    result.scanned++;
    const user = sub.seekerProfile?.user;
    if (!user?.email) {
      result.skipped++;
      continue;
    }
    const dedupKey = `ra_friday_nudge:${user.id}:${week}`;
    let notifId: string | null;
    try {
      notifId = await claimDedup({ dedupKey, userId: user.id, type: 'ra_friday_nudge', title: 'RoboApply weekly prep' });
    } catch (err) {
      logger.warn('RA_BILLING_REMINDER', 'nudge dedup claim failed', { userId: user.id, error: err instanceof Error ? err.message : String(err) });
      result.failed++;
      continue;
    }
    if (!notifId) {
      result.skipped++;
      continue;
    }

    try {
      const locale = resolveEmailLocale(sub.seekerProfile?.locale, sub.seekerProfile?.market);
      const { subject, html } = renderFridayNudgeEmail({
        locale,
        name: user.name,
        credits: sub.mockCredits ?? 0,
        startUrl: `${roboApplyBaseUrl()}/mock-interview`,
        accountUrl: `${roboApplyBaseUrl()}/account`,
      });
      const ok = await emailService.send({ to: user.email, subject, html, from: fromHeader() });
      if (ok) {
        await markEmailSent(notifId);
        result.sent++;
      } else {
        result.failed++;
      }
    } catch (err) {
      logger.warn('RA_BILLING_REMINDER', 'nudge send failed', { userId: user.id, error: err instanceof Error ? err.message : String(err) });
      result.failed++;
    }
  }

  logger.info('RA_BILLING_REMINDER', 'friday nudge sweep complete', { week, ...result });
  return result;
}

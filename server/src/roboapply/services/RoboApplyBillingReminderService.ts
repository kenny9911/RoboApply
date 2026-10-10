// server/src/roboapply/services/RoboApplyBillingReminderService.ts
//
// Billing reminder sweeps (PRODUCT_PLAN.md §6.3, §6.5; ARCHITECTURE.md §7.4;
// TASK_PLAN.md WP-21a). Brand-aware, sent through the platform email service
// (template `billing.renewal_reminder` / `billing.annual_reminder`), so every
// send is logged in RAEmailLog (X-31: reminders are sent AND logged).
//
//   runRenewalReminderSweep (daily cron `billing-renewal-reminder`):
//     - auto-renewing plans: 5 days before a monthly/quarterly renewal,
//       2 days before a weekly one (cancelled plans get nothing — they won't
//       renew);
//     - passes that end without renewing: GoApply 30/90-day passes 3 days
//       before they end ("续费" reminder), the old RoboApply Alipay monthly
//       passes 5 days before; 7-day passes get none (nothing renews and a
//       reminder would only be a sales nudge);
//     - an annual reminder for subscriptions that have run over 12 months,
//       once per year of the subscription.
//   Each send is claimed once through Notification.dedupKey (unique); a send
//   that fails releases its claim so the next daily run retries while the
//   plan is still inside its reminder window.
//
//   The weekly practice nudge that used to live here is gone: it was
//   promotional, so its successor is sent by the lifecycle mail under "Tips
//   and reminders" (default off for EEA/UK/CH/CA visitors and GoApply).

import prisma, { type ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { sendEmail as platformSendEmail } from '../../platform/email/index.js';
import '../../platform/email/templates/billing/index.js';
import { parseBrandId, type BrandId } from '../../platform/brand/registry.js';
import { planDefinitionFor } from '../../platform/billing/index.js';

export type ReminderDb = Pick<ExtendedPrismaClient, 'seekerSubscription' | 'seekerProfile' | 'user' | 'notification'>;

export interface ReminderDeps {
  db?: ReminderDb;
  sendEmail?: typeof platformSendEmail;
  now?: Date;
}

export interface SweepResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
/** Auto-renewing plans: days before renewal (PRODUCT §6.5). */
export const RENEWAL_LEAD_DAYS = { week: 2, month: 5, quarter: 5 } as const;
/** GoApply passes (PRODUCT §6.3: 3 days before expiry) and old RoboApply Alipay passes (5, unchanged). */
export const PASS_LEAD_DAYS = { goapply: 3, legacy: 5 } as const;
const PAID_TIERS = ['pro', 'starter', 'growth'];
const SCAN_LIMIT = 5000;

interface Candidate {
  id: string;
  seekerProfileId: string;
  tier: string;
  planKey: string | null;
  interval: string | null;
  brand: string | null;
  currency: string | null;
  amountMinor: number | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  startedAt: Date | null;
}

interface Recipient {
  userId: string;
  email: string;
  locale: string | null;
  brand: BrandId;
}

export type ReminderKind = { kind: 'auto'; leadDays: number } | { kind: 'pass'; leadDays: number } | null;

/** Which reminder (if any) a live paid row gets, and how many days ahead. */
export function reminderFor(sub: Pick<Candidate, 'tier' | 'planKey' | 'interval' | 'brand' | 'currency' | 'stripeSubscriptionId'>): ReminderKind {
  if (sub.stripeSubscriptionId) {
    const interval = sub.interval === 'week' || sub.interval === 'quarter' ? sub.interval : 'month';
    return { kind: 'auto', leadDays: RENEWAL_LEAD_DAYS[interval] };
  }
  if (sub.tier === 'starter' || sub.tier === 'growth') {
    // Old RoboApply Alipay monthly passes, honoured until they expire.
    return sub.currency === 'CNY' ? { kind: 'pass', leadDays: PASS_LEAD_DAYS.legacy } : null;
  }
  const brand = parseBrandId(sub.brand) ?? 'roboapply';
  const def = planDefinitionFor(brand, sub.planKey);
  if (brand === 'goapply' && def?.kind === 'pass' && (def.passDays ?? 0) >= 30) return { kind: 'pass', leadDays: PASS_LEAD_DAYS.goapply };
  return null;
}

async function loadRecipients(db: ReminderDb, subs: Candidate[]): Promise<Map<string, Recipient>> {
  const profileIds = [...new Set(subs.map((s) => s.seekerProfileId))];
  const out = new Map<string, Recipient>();
  if (!profileIds.length) return out;
  const profiles = await db.seekerProfile.findMany({
    where: { id: { in: profileIds }, deletedAt: null },
    select: { id: true, userId: true, locale: true },
  });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(profiles.map((p) => p.userId))] } },
    select: { id: true, email: true, brand: true },
  });
  const byUser = new Map(users.map((u) => [u.id, u]));
  for (const p of profiles) {
    const u = byUser.get(p.userId);
    if (!u?.email) continue;
    out.set(p.id, { userId: u.id, email: u.email, locale: p.locale ?? null, brand: parseBrandId(u.brand) ?? 'roboapply' });
  }
  return out;
}

async function claim(db: ReminderDb, dedupKey: string, userId: string, type: string, title: string): Promise<string | null> {
  try {
    const row = await db.notification.create({ data: { userId, type, title, dedupKey }, select: { id: true } });
    return row.id;
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return null;
    throw err;
  }
}

async function release(db: ReminderDb, id: string): Promise<void> {
  await db.notification.delete({ where: { id } }).catch(() => {});
}

async function markSent(db: ReminderDb, id: string): Promise<void> {
  await db.notification.update({ where: { id }, data: { emailSent: true } }).catch(() => {});
}

async function deliver(
  db: ReminderDb,
  send: typeof platformSendEmail,
  claimInput: { dedupKey: string; type: string; title: string },
  recipient: Recipient,
  email: { template: string; brand: BrandId; params: Record<string, unknown> },
  result: SweepResult,
): Promise<void> {
  let claimId: string | null;
  try {
    claimId = await claim(db, claimInput.dedupKey, recipient.userId, claimInput.type, claimInput.title);
  } catch (err) {
    logger.warn('RA_BILLING_REMINDER', 'dedup claim failed', { key: claimInput.dedupKey, error: err instanceof Error ? err.message : String(err) });
    result.failed++;
    return;
  }
  if (!claimId) {
    result.skipped++;
    return;
  }
  try {
    const res = await send({ template: email.template, to: recipient.email, userId: recipient.userId, locale: recipient.locale, brand: email.brand, params: email.params });
    if (res.status === 'sent') {
      await markSent(db, claimId);
      result.sent++;
    } else if (res.status === 'suppressed') {
      // Placeholder address, no transport on this brand: nothing to retry.
      result.skipped++;
    } else {
      await release(db, claimId);
      result.failed++;
    }
  } catch (err) {
    await release(db, claimId);
    logger.warn('RA_BILLING_REMINDER', 'send failed', { key: claimInput.dedupKey, error: err instanceof Error ? err.message : String(err) });
    result.failed++;
  }
}

const CANDIDATE_SELECT = {
  id: true,
  seekerProfileId: true,
  tier: true,
  planKey: true,
  interval: true,
  brand: true,
  currency: true,
  amountMinor: true,
  stripeSubscriptionId: true,
  currentPeriodEnd: true,
  startedAt: true,
} as const;

function toCandidate(r: Record<string, unknown>): Candidate {
  return {
    id: String(r.id),
    seekerProfileId: String(r.seekerProfileId),
    tier: String(r.tier),
    planKey: (r.planKey as string | null) ?? null,
    interval: (r.interval as string | null) ?? null,
    brand: (r.brand as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    amountMinor: (r.amountMinor as number | null) ?? null,
    stripeSubscriptionId: (r.stripeSubscriptionId as string | null) ?? null,
    currentPeriodEnd: (r.currentPeriodEnd as Date | null) ?? null,
    startedAt: (r.startedAt as Date | null) ?? null,
  };
}

// ─── Renewal + pass-expiry reminders, and the annual reminder ────────────────

export async function runRenewalReminderSweep(opts: ReminderDeps = {}): Promise<SweepResult & { annual: SweepResult }> {
  const db = opts.db ?? prisma;
  const send = opts.sendEmail ?? platformSendEmail;
  const now = opts.now ?? new Date();
  const result: SweepResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

  const maxLead = Math.max(...Object.values(RENEWAL_LEAD_DAYS), ...Object.values(PASS_LEAD_DAYS));
  const rows = await db.seekerSubscription.findMany({
    where: {
      status: { in: ['active', 'trialing'] },
      tier: { in: PAID_TIERS as never },
      cancelAtPeriodEnd: false,
      currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + maxLead * DAY_MS) },
    },
    select: CANDIDATE_SELECT,
    take: SCAN_LIMIT,
  });
  const subs = rows.map((r) => toCandidate(r as unknown as Record<string, unknown>));
  const recipients = await loadRecipients(db, subs);

  for (const sub of subs) {
    result.scanned++;
    const kind = reminderFor(sub);
    const recipient = recipients.get(sub.seekerProfileId);
    if (!kind || !recipient || !sub.currentPeriodEnd) {
      result.skipped++;
      continue;
    }
    if (sub.currentPeriodEnd.getTime() - now.getTime() > kind.leadDays * DAY_MS) {
      result.skipped++;
      continue;
    }
    const periodEndIso = sub.currentPeriodEnd.toISOString();
    await deliver(
      db,
      send,
      { dedupKey: `ra_renewal_reminder:${sub.id}:${periodEndIso.slice(0, 10)}`, type: 'ra_renewal_reminder', title: 'Renewal reminder' },
      recipient,
      {
        template: 'billing.renewal_reminder',
        brand: parseBrandId(sub.brand) ?? recipient.brand,
        params: {
          planKey: sub.planKey && sub.tier === 'pro' ? sub.planKey : sub.tier,
          date: periodEndIso,
          amountMinor: sub.amountMinor,
          currency: sub.currency,
          interval: sub.interval,
          manual: kind.kind === 'pass',
        },
      },
      result,
    );
  }

  const annual = await runAnnualReminderSweep({ db, sendEmail: send, now });
  logger.info('RA_BILLING_REMINDER', 'renewal sweep complete', { ...result, annual });
  return { ...result, annual };
}

/** Subscriptions running for over 12 months: one reminder per year of the subscription. */
export async function runAnnualReminderSweep(opts: ReminderDeps = {}): Promise<SweepResult> {
  const db = opts.db ?? prisma;
  const send = opts.sendEmail ?? platformSendEmail;
  const now = opts.now ?? new Date();
  const result: SweepResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  const rows = await db.seekerSubscription.findMany({
    where: {
      status: { in: ['active', 'trialing'] },
      tier: { in: PAID_TIERS as never },
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: { not: null },
      startedAt: { lte: new Date(now.getTime() - YEAR_MS) },
    },
    select: CANDIDATE_SELECT,
    take: SCAN_LIMIT,
  });
  const subs = rows.map((r) => toCandidate(r as unknown as Record<string, unknown>));
  const recipients = await loadRecipients(db, subs);
  for (const sub of subs) {
    result.scanned++;
    const recipient = recipients.get(sub.seekerProfileId);
    if (!recipient || !sub.startedAt) {
      result.skipped++;
      continue;
    }
    const years = Math.floor((now.getTime() - sub.startedAt.getTime()) / YEAR_MS);
    if (years < 1) {
      result.skipped++;
      continue;
    }
    await deliver(
      db,
      send,
      { dedupKey: `ra_annual_reminder:${sub.id}:${years}`, type: 'ra_annual_reminder', title: 'Annual subscription reminder' },
      recipient,
      {
        template: 'billing.annual_reminder',
        brand: parseBrandId(sub.brand) ?? recipient.brand,
        params: {
          planKey: sub.planKey && sub.tier === 'pro' ? sub.planKey : sub.tier,
          startedAt: sub.startedAt.toISOString(),
          nextRenewal: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
          amountMinor: sub.amountMinor,
          currency: sub.currency,
          interval: sub.interval,
        },
      },
      result,
    );
  }
  return result;
}

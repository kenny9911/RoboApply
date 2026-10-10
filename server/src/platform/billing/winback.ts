// server/src/platform/billing/winback.ts
//
// The one winback email (PRODUCT_PLAN.md F-BILL-06; TASK_PLAN.md WP-79):
// 30 days after an auto-renewing plan ENDED (churn, not the click on Cancel),
// one plain email that says the account and its work are still there and,
// when Pro is on sale, what it costs. Rules:
//   - only with a live `marketing_email` consent, and only through the email
//     preference gate (category 'marketing', one-click unsubscribe);
//   - one per person, ever: any earlier `billing.winback` log row (sent,
//     failed or suppressed) means never again;
//   - no discount, no countdown, no personalised offer (F-BILL-10 SKIP);
//   - only for a Stripe subscription that was paid at least once (see
//     createWinbackSweep), never for a one-time pass (passes end by design);
//   - never to someone whose plan is live again or whose account is disabled
//     or deleted.
//
// Runs as a reminder producer (hourly `reminders`; INT registers it, see the
// WP-79 handoff). Rows ended 30–37 days ago are considered, so a missed day
// is caught up; the email log keeps it to one.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../brand/brandEnv.js';
import type { ProductBrand } from '../brand/registry.js';
import { button, heading, paragraph } from '../email/templates/_shell.js';
import { defineEmailTemplate } from '../email/templates/registry.js';
import type { CronContext, CronResult, CronTask } from '../queue/runForBudget.js';
import { getPlan } from './planCatalog.js';

export const WINBACK_TEMPLATE = 'billing.winback';
export const WINBACK_AFTER_DAYS = 30;
/** Catch-up window after day 30. */
export const WINBACK_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const BATCH = 100;

export interface WinbackEmailParams {
  /** The day the plan ended. */
  endedOn: Date;
  /** Formatted Pro Monthly price, or null when it is not on sale. */
  price: string | null;
}

export const winbackEmail = defineEmailTemplate<WinbackEmailParams>({
  key: WINBACK_TEMPLATE,
  category: 'marketing',
  render: ({ t, params, origin }) => {
    const url = `${origin}/pricing`;
    const lines = [
      t('accountV2.winback.body', { date: params.endedOn }),
      ...(params.price ? [t('accountV2.winback.price', { price: params.price, period: t('billing.periods.month') })] : []),
    ];
    return {
      subject: t('accountV2.winback.subject'),
      preheader: t('accountV2.winback.preheader'),
      bodyHtml:
        heading(t('accountV2.winback.heading')) +
        lines.map(paragraph).join('') +
        button(t('accountV2.winback.cta'), url) +
        paragraph(t('accountV2.winback.once')),
      bodyText: [t('accountV2.winback.heading'), ...lines, url, t('accountV2.winback.once')].join('\n\n'),
    };
  },
});

export type WinbackDb = Pick<ExtendedPrismaClient, 'seekerSubscription' | 'rAEmailLog' | 'mockInterviewCreditLedger'>;

export interface WinbackDeps {
  db: () => Promise<WinbackDb>;
  env: () => EnvSource;
  hasMarketingConsent: (userId: string) => Promise<boolean>;
  sendEmail: (input: { to: string; userId: string; locale: string | null; brand: ProductBrand; params: WinbackEmailParams }) => Promise<{ status: string }>;
}

export function defaultWinbackDeps(): WinbackDeps {
  return {
    db: async () => (await import('../../lib/prisma.js')).default,
    env: () => process.env,
    hasMarketingConsent: async (userId) => {
      const { hasLiveConsent } = await import('../consent/index.js');
      return hasLiveConsent(userId, 'marketing_email');
    },
    sendEmail: async ({ to, userId, locale, brand, params }) => {
      const { sendEmail } = await import('../email/index.js');
      return sendEmail({ template: winbackEmail, to, userId, locale, brand: brand.id, params });
    },
  };
}

/** Pro Monthly's price in the buyer's locale, or null when it is not on sale (never a made-up number). */
export function winbackPrice(brand: ProductBrand, locale: string | null, env: EnvSource): string | null {
  const plan = getPlan(brand.id, 'pro_monthly', env);
  if (!plan?.sellable || plan.amountMinor === null) return null;
  const amount = plan.amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale ?? 'en', {
      style: 'currency',
      currency: plan.currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${plan.currency} ${amount}`;
  }
}

/** Ledger reasons that mean Stripe charged for a subscription period. */
const PAID_REASONS = ['grant_purchase', 'grant_renewal'];

interface WinbackRow {
  id: string;
  canceledAt: Date | null;
  stripeSubscriptionId: string | null;
  seekerProfile: { userId: string; locale: string | null; deletedAt: Date | null; user: { email: string; isActive: boolean } | null } | null;
}

/**
 * Who churned: a Stripe subscription row that is now `canceled`.
 *
 * After a plan ends the billing webhook rewrites the row to tier 'free',
 * planKey 'free' and interval null, so the old plan cannot be read from it.
 * Two facts that survive are used instead:
 *   - `stripeSubscriptionId` is set: passes and Alipay/WeChat plans never
 *     carry one (a pass clears it), so this is an auto-renewing Stripe plan;
 *   - a Stripe credit grant for that subscription id exists in the practice
 *     credit ledger: the webhook grants only for a paid-up period, so this
 *     means the plan was paid at least once. A checkout that never paid
 *     (`incomplete_expired`, which the webhook also stores as `canceled`)
 *     has no such row and is not churn.
 *
 * The window is read page by page with a (canceledAt, id) cursor, so rows
 * that are skipped (no consent, already emailed, deleted) never hide later
 * rows from the sweep.
 */
export function createWinbackSweep(deps: WinbackDeps = defaultWinbackDeps()): CronTask {
  return async (ctx: CronContext): Promise<CronResult> => {
    const db = await deps.db();
    const env = deps.env();
    const to = new Date(ctx.now.getTime() - WINBACK_AFTER_DAYS * DAY_MS);
    const from = new Date(to.getTime() - WINBACK_WINDOW_DAYS * DAY_MS);
    let cursor: { canceledAt: Date; id: string } | null = null;
    let scanned = 0;
    let sent = 0;
    let skipped = 0;
    let complete = false;

    while (!ctx.budget.exhausted(2_000)) {
      const rows: WinbackRow[] = await db.seekerSubscription.findMany({
        where: {
          brand: ctx.brand.id,
          status: 'canceled',
          stripeSubscriptionId: { not: null },
          canceledAt: { gte: from, lt: to },
          ...(cursor
            ? { OR: [{ canceledAt: { gt: cursor.canceledAt } }, { canceledAt: cursor.canceledAt, id: { gt: cursor.id } }] }
            : {}),
        },
        orderBy: [{ canceledAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: {
          id: true,
          canceledAt: true,
          stripeSubscriptionId: true,
          seekerProfile: {
            select: { userId: true, locale: true, deletedAt: true, user: { select: { email: true, isActive: true } } },
          },
        },
      });
      if (rows.length === 0) {
        complete = true;
        break;
      }
      scanned += rows.length;
      const last = rows[rows.length - 1]!;
      cursor = last.canceledAt ? { canceledAt: last.canceledAt, id: last.id } : null;

      const candidates = rows.filter(
        (r) => r.canceledAt && r.stripeSubscriptionId && r.seekerProfile?.user && !r.seekerProfile.deletedAt && r.seekerProfile.user.isActive !== false,
      );
      skipped += rows.length - candidates.length;
      const userIds = [...new Set(candidates.map((r) => r.seekerProfile!.userId))];
      const [logRows, paidRows] =
        userIds.length === 0
          ? [[], []]
          : await Promise.all([
              db.rAEmailLog.findMany({ where: { userId: { in: userIds }, template: WINBACK_TEMPLATE }, select: { userId: true } }),
              db.mockInterviewCreditLedger.findMany({
                where: { userId: { in: userIds }, source: 'stripe', reason: { in: PAID_REASONS } },
                select: { userId: true, metadata: true },
              }),
            ]);
      const emailed = new Set(logRows.map((l) => l.userId).filter((id): id is string => !!id));
      const paid = new Set(
        paidRows.map((l) => {
          const meta = l.metadata as Record<string, unknown> | null;
          return typeof meta?.stripeSubscriptionId === 'string' ? `${l.userId}:${meta.stripeSubscriptionId}` : '';
        }),
      );

      for (const row of candidates) {
        if (ctx.budget.exhausted(2_000)) break;
        const profile = row.seekerProfile!;
        const user = profile.user!;
        if (emailed.has(profile.userId) || !paid.has(`${profile.userId}:${row.stripeSubscriptionId}`)) {
          skipped += 1;
          continue;
        }
        if (!(await deps.hasMarketingConsent(profile.userId))) {
          skipped += 1;
          continue;
        }
        // One per person even if two of their rows sit in the window.
        emailed.add(profile.userId);
        try {
          const res = await deps.sendEmail({
            to: user.email,
            userId: profile.userId,
            locale: profile.locale ?? null,
            brand: ctx.brand,
            params: { endedOn: row.canceledAt!, price: winbackPrice(ctx.brand, profile.locale ?? null, env) },
          });
          if (res.status === 'sent') sent += 1;
          else skipped += 1;
        } catch (err) {
          skipped += 1;
          logger.warn('RA_BILLING', 'winback email failed', { userId: profile.userId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (rows.length < BATCH || !cursor) {
        complete = true;
        break;
      }
    }
    if (scanned === 0 && complete) return { skipped: 'no_work', processed: 0 };
    return { processed: sent, skippedRows: skipped, scanned, ...(complete ? {} : { more: true }) };
  };
}

/** The production sweep (register as a reminder producer named 'winback'). */
export const runWinbackSweep: CronTask = (ctx) => createWinbackSweep()(ctx);

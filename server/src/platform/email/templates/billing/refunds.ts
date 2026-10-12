// server/src/platform/email/templates/billing/refunds.ts
//
// Refund and withdrawal emails (MARKET_STRATEGY.md §5.1 event table, "Reverse
// entitlements, mail"; requirements ST-4 and ST-9). Both are transactional:
// they are about the person's own money, so they go out without a marketing
// opt-in and carry no unsubscribe link. Strings live in
// server/src/i18n/email/staging/billingRefunds.en.json
// (`billingRefunds.refundIssued.*`, `billingRefunds.withdrawalConfirmed.*`: a
// staging file holds exactly the namespace it is named after); plan names and
// the footer line are the shared `billing.*` ones. Amounts and dates are
// formatted here from the real refund, never from copy.
//
//   billing.refund_issued          a refund reached the charge (the Stripe
//                                  `charge.refunded` webhook, so a refund made
//                                  in the Dashboard sends it too): the amount,
//                                  where the money goes, and whether the plan
//                                  or the credits changed
//   billing.withdrawal_confirmed   the automatic confirmation of a statutory
//                                  withdrawal (Directive (EU) 2023/2673): what
//                                  was withdrawn, when we received it, the
//                                  refund amount, and that the purchase ended
//
// Neither mail names a date by which the money arrives: the bank decides.
//
// Imported by platform/billing/stripeRefunds.ts, so the templates are
// registered wherever a refund can be recorded.

import { button, heading, paragraph } from '../_shell.js';
import { defineEmailTemplate, type TemplateContext } from '../registry.js';
import { formatDateTime, formatPrice, planName } from './index.js';

function manageUrl(ctx: TemplateContext<unknown>): string {
  return `${ctx.origin}/settings/billing`;
}

function isPack(planKey: string): boolean {
  return planKey.startsWith('practice_pack_');
}

function isPass(planKey: string): boolean {
  return planKey.endsWith('_pass');
}

// ── Refund issued ────────────────────────────────────────────────────────

export interface RefundIssuedParams {
  planKey: string;
  /** The amount of this refund, minor units. */
  amountMinor: number;
  currency: string;
  /** The whole charge is refunded now (by this refund alone, or as the last of several). */
  full: boolean;
  /**
   * `full` only: earlier refunds already returned part of the charge, so
   * `amountMinor` is the rest and not everything that was paid.
   */
  completesEarlierRefunds: boolean;
  /** The refund took the paid time (or the unused pack credits) off the account. */
  accessEnded: boolean;
}

export const refundIssuedEmail = defineEmailTemplate<RefundIssuedParams>({
  key: 'billing.refund_issued',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const plan = planName(t, params.planKey);
    const amount = formatPrice(params.amountMinor, params.currency, t);
    // "The full amount you paid" is only true of a refund that is the whole charge by itself.
    const bodyKey = !params.full
      ? 'billingRefunds.refundIssued.bodyPartial'
      : params.completesEarlierRefunds
        ? 'billingRefunds.refundIssued.bodyRest'
        : 'billingRefunds.refundIssued.bodyFull';
    const body = t(bodyKey, { amount, plan });
    const method = t('billingRefunds.refundIssued.method');
    // A partial refund changes nothing. A full one says what it took away, and
    // says nothing about access when there was nothing left to take.
    const access = !params.full
      ? t('billingRefunds.refundIssued.accessUnchanged')
      : params.accessEnded
        ? t(isPack(params.planKey) ? 'billingRefunds.refundIssued.accessEndedPack' : 'billingRefunds.refundIssued.accessEndedPlan')
        : null;
    const url = manageUrl(ctx);
    const cta = t('billingRefunds.refundIssued.cta');
    const title = t('billingRefunds.refundIssued.heading');
    return {
      subject: t('billingRefunds.refundIssued.subject', { amount }),
      preheader: body,
      bodyHtml: heading(title) + paragraph(body) + paragraph(method) + (access ? paragraph(access) : '') + button(cta, url),
      bodyText: [title, '', body, method, ...(access ? [access] : []), '', `${cta}: ${url}`].join('\n'),
      reasonText: t('billing.footer'),
    };
  },
});

// ── Withdrawal confirmed ─────────────────────────────────────────────────

export interface WithdrawalConfirmedParams {
  planKey: string;
  /** The refund the withdrawal gives, minor units (0 when the paid period was used up). */
  amountMinor: number;
  currency: string;
  /** ISO time we received the withdrawal. */
  withdrawnAt: string;
}

export const withdrawalConfirmedEmail = defineEmailTemplate<WithdrawalConfirmedParams>({
  key: 'billing.withdrawal_confirmed',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const plan = planName(t, params.planKey);
    const body = t('billingRefunds.withdrawalConfirmed.body', { plan });
    const received = t('billingRefunds.withdrawalConfirmed.received', { at: formatDateTime(params.withdrawnAt, t) });
    const refund =
      params.amountMinor > 0
        ? t('billingRefunds.withdrawalConfirmed.refund', { amount: formatPrice(params.amountMinor, params.currency, t) })
        : t('billingRefunds.withdrawalConfirmed.refundNone');
    const ended = t(
      isPack(params.planKey)
        ? 'billingRefunds.withdrawalConfirmed.endedPack'
        : isPass(params.planKey)
          ? 'billingRefunds.withdrawalConfirmed.endedPass'
          : 'billingRefunds.withdrawalConfirmed.endedSubscription',
    );
    const url = manageUrl(ctx);
    const cta = t('billingRefunds.withdrawalConfirmed.cta');
    const title = t('billingRefunds.withdrawalConfirmed.heading');
    return {
      subject: t('billingRefunds.withdrawalConfirmed.subject'),
      preheader: body,
      bodyHtml: heading(title) + paragraph(body) + paragraph(received) + paragraph(refund) + paragraph(ended) + button(cta, url),
      bodyText: [title, '', body, received, refund, ended, '', `${cta}: ${url}`].join('\n'),
      reasonText: t('billing.footer'),
    };
  },
});

export const BILLING_REFUND_EMAIL_TEMPLATES = [refundIssuedEmail.key, withdrawalConfirmedEmail.key] as const;

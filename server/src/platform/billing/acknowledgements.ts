// server/src/platform/billing/acknowledgements.ts
//
// Checkout acknowledgements (PRODUCT_PLAN.md §6.3, F-BILL-08; ARCHITECTURE.md
// §7.4; TASK_PLAN.md WP-21a):
//
//   - every auto-renewing plan needs an UNTICKED box the user ticks:
//     "I agree this renews automatically every {period} at {price} until I
//     cancel" → consent record `auto_renew_ack` (kept 3 years);
//   - EU/UK/TW checkouts add the withdrawal waiver: "Start now: I understand
//     I lose my right of withdrawal once I use paid features" → consent record
//     `withdrawal_waiver`. Without it, a full refund is due within 14 days
//     (refunds.ts).
//
// The records go to SeekerConsentRecord with the English prose version and a
// sha256 of the exact sentence (prices filled in), so we can show later which
// sentence was agreed to. The page renders the localized sentence (WP-21b).

import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import type { CatalogPlan } from './planCatalog.js';

/** Prose version stored with every acknowledgement record. */
export const CHECKOUT_ACK_PROSE_VERSION = 'billing-ack-2026-10-10';

/** EU member states (ISO-3166 alpha-2). */
export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const;
/** EEA states outside the EU follow the same consumer-rights directive. */
const EEA_EXTRA = ['IS', 'LI', 'NO'] as const;

/**
 * Every billing country with a statutory right of withdrawal that we honour
 * (MARKET_STRATEGY.md §4.4): the EU 27, the three EEA states outside it, the
 * United Kingdom and Taiwan. The one list: the plan sheet shows the waiver
 * box for these countries, the refund rules read them through
 * `withdrawalRegion`, and the web keeps its copy equal to this.
 */
export const WITHDRAWAL_COUNTRIES = [...EU_COUNTRIES, ...EEA_EXTRA, 'GB', 'TW'] as const;
export type WithdrawalCountry = (typeof WITHDRAWAL_COUNTRIES)[number];

export type WithdrawalRegion = 'eu' | 'uk' | 'tw';

/** The withdrawal-right region for a billing country, or null when none applies. */
export function withdrawalRegion(country: string | null | undefined): WithdrawalRegion | null {
  const c = (country ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c === 'GB' || c === 'UK') return 'uk';
  if (c === 'TW') return 'tw';
  if ((EU_COUNTRIES as readonly string[]).includes(c) || (EEA_EXTRA as readonly string[]).includes(c)) return 'eu';
  return null;
}

/** Whether the plan sheet shows the withdrawal-waiver box for this country. */
export function showsWithdrawalWaiver(country: string | null | undefined): boolean {
  return withdrawalRegion(country) !== null;
}

const PERIOD_WORD: Record<string, string> = { week: 'week', month: 'month', quarter: '3 months' };

function formatAmount(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2);
  return currency === 'USD' ? `$${major}` : currency === 'CNY' ? `¥${major}` : `${major} ${currency}`;
}

/**
 * The price the buyer is charged, as the acknowledgement names it. Usually the
 * catalog plan itself; a Taiwan buyer on a TWD price passes that amount and
 * currency instead (so `currency` is wider than the brand's base currency).
 */
export type AckPricedPlan = Pick<CatalogPlan, 'interval' | 'amountMinor'> & { currency: string };

/** The canonical English sentence for the auto-renewal acknowledgement, prices filled in. */
export function autoRenewAckSentence(plan: AckPricedPlan): string {
  const period = PERIOD_WORD[plan.interval ?? ''] ?? String(plan.interval ?? '');
  const price = plan.amountMinor === null ? '—' : formatAmount(plan.amountMinor, plan.currency);
  return `I agree this renews automatically every ${period} at ${price} until I cancel`;
}

export const WITHDRAWAL_WAIVER_SENTENCE = 'Start now: I understand I lose my right of withdrawal once I use paid features';

export function proseHash(sentence: string): string {
  return createHash('sha256').update(sentence, 'utf8').digest('hex');
}

export interface CheckoutAcknowledgementInput {
  seekerProfileId: string;
  /** The plan at the price that is charged (see `AckPricedPlan`). */
  plan: Pick<CatalogPlan, 'requiresAutoRenewAck'> & AckPricedPlan;
  autoRenewAck: boolean;
  withdrawalWaiver: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export type ConsentDb = Pick<ExtendedPrismaClient, 'seekerConsentRecord'>;

export interface RecordedAcknowledgements {
  autoRenewAck: { recorded: boolean; proseHash: string | null };
  withdrawalWaiver: { recorded: boolean; proseHash: string | null };
}

/**
 * Write the acknowledgement records for a checkout. The caller has already
 * refused an auto-renewing plan without `autoRenewAck` (see
 * `assertCheckoutAcknowledgements`). Records are written before the payment
 * page opens; a user who abandons checkout leaves an unused record, which is
 * harmless and proves what was shown.
 */
export async function recordCheckoutAcknowledgements(db: ConsentDb, input: CheckoutAcknowledgementInput): Promise<RecordedAcknowledgements> {
  const out: RecordedAcknowledgements = {
    autoRenewAck: { recorded: false, proseHash: null },
    withdrawalWaiver: { recorded: false, proseHash: null },
  };
  const base = {
    seekerProfileId: input.seekerProfileId,
    granted: true,
    ipAddress: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
    proseVersion: CHECKOUT_ACK_PROSE_VERSION,
  };
  if (input.plan.requiresAutoRenewAck && input.autoRenewAck) {
    const hash = proseHash(autoRenewAckSentence(input.plan));
    await db.seekerConsentRecord.create({ data: { ...base, consentType: 'auto_renew_ack', proseHash: hash } });
    out.autoRenewAck = { recorded: true, proseHash: hash };
  }
  if (input.withdrawalWaiver) {
    const hash = proseHash(WITHDRAWAL_WAIVER_SENTENCE);
    await db.seekerConsentRecord.create({ data: { ...base, consentType: 'withdrawal_waiver', proseHash: hash } });
    out.withdrawalWaiver = { recorded: true, proseHash: hash };
  }
  return out;
}

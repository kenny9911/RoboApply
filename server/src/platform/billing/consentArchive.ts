// server/src/platform/billing/consentArchive.ts
//
// Checkout acknowledgements that outlive the account (requirement ST-9
// "consent retention"; docs/jobright-clone/market/MARKET_STRATEGY.md §4.4
// "Renewal": the acknowledgement is "kept until the later of 3 years after
// consent and 1 year after the subscription ends", California AB 2863).
//
// The records themselves are SeekerConsentRecord rows of type
// `auto_renew_ack`, `withdrawal_waiver` and `cn_pay_terms_ack`. They belong to
// the seeker profile, so they go when the account purge deletes the User row:
// 30 days after a deletion request (15 on GoApply), which can be years short
// of that period. Right before it deletes, the purge therefore copies a
// MINIMAL proof of each record into RABillingConsentArchive:
//
//   what was agreed to   the type, the hash and the version of the sentence,
//                        and when;
//   whose it was         the user id, a sha256 of the lower-cased email and
//                        the payment customer id (no relation: the account is
//                        gone);
//   until when           `retainUntil`, after which compliance-daily deletes
//                        the row (features/compliance/retention.ts, rule
//                        `billing_consent_archive`).
//
// Never the IP address, the user agent or the email in clear: they are not
// even read here. The hash of the sentence is the proof. A record whose period
// is already over is not copied.
//
// The table is unique on (userId, consentType, consentedAt) and the rows are
// written with `createMany({ skipDuplicates: true })`, so a purge that runs
// twice (a retry after a failed delete, two overlapping sweeps) writes each
// acknowledgement once. Nothing here deletes anything.

import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { parseBrandId, type BrandId } from '../brand/registry.js';

/** Consent types that record a purchase term the buyer accepted (checkout, plan switch, "Keep my plan", the mainland payment terms). */
export const BILLING_CONSENT_TYPES = ['auto_renew_ack', 'withdrawal_waiver', 'cn_pay_terms_ack'] as const;
export type BillingConsentType = (typeof BILLING_CONSENT_TYPES)[number];

/** Kept at least this long after the acknowledgement was given. */
export const BILLING_CONSENT_KEEP_YEARS = 3;
/** And at least this long after the subscription ended, when that is later. */
export const BILLING_CONSENT_KEEP_AFTER_END_YEARS = 1;

/**
 * `date` plus whole calendar years (UTC). These are minimum periods, so a
 * 29 February lands on 1 March of a common year: a day late, never a day early.
 */
function addYears(date: Date, years: number): Date {
  const out = new Date(date.getTime());
  out.setUTCFullYear(date.getUTCFullYear() + years);
  return out;
}

/**
 * Until when the proof of one acknowledgement is kept: the later of
 * `consentedAt` + 3 years and the end of the subscription + 1 year. A
 * subscription with no known end is counted from `now`: it ends, at the
 * latest for us, with the account that is being deleted.
 */
export function billingConsentRetainUntil(consentedAt: Date, subscriptionEndedAt: Date | null, now: Date = new Date()): Date {
  const afterConsent = addYears(consentedAt, BILLING_CONSENT_KEEP_YEARS);
  const afterEnd = addYears(subscriptionEndedAt ?? now, BILLING_CONSENT_KEEP_AFTER_END_YEARS);
  return afterConsent.getTime() >= afterEnd.getTime() ? afterConsent : afterEnd;
}

/** The email as it is kept: sha256 of the trimmed, lower-cased address (hex). */
export function billingConsentEmailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/** What the archive reads of a consent record. The IP address and the user agent are not part of it. */
export interface BillingConsentRecord {
  consentType: string;
  proseHash: string | null;
  proseVersion: string | null;
  createdAt: Date;
}

/** What the archive reads of the plan row. */
export interface BillingConsentSubscription {
  canceledAt: Date | null;
  currentPeriodEnd: Date | null;
  stripeCustomerId: string | null;
}

/** One RABillingConsentArchive row (the columns this module writes). */
export interface BillingConsentArchiveRow {
  userId: string;
  emailHash: string;
  brand: BrandId;
  consentType: string;
  proseHash: string | null;
  proseVersion: string | null;
  consentedAt: Date;
  subscriptionEndedAt: Date | null;
  stripeCustomerId: string | null;
  retainUntil: Date;
}

/**
 * When the plan ended, if it has: the moment it was ended for good
 * (`canceledAt`), or a paid period that is over. Null while it still runs, or
 * when there never was one.
 */
export function subscriptionEndedAt(subscription: Pick<BillingConsentSubscription, 'canceledAt' | 'currentPeriodEnd'> | null, now: Date): Date | null {
  if (!subscription) return null;
  if (subscription.canceledAt) return subscription.canceledAt;
  const periodEnd = subscription.currentPeriodEnd;
  return periodEnd && periodEnd.getTime() <= now.getTime() ? periodEnd : null;
}

/**
 * The archive rows for one account: one per billing acknowledgement whose
 * period is not over yet. Pure.
 *
 * A plan that is still paid for when the account is deleted has not ended:
 * its year is counted from the end of the paid period (or from `now`, when
 * that is later), and `subscriptionEndedAt` stays null on the row.
 *
 * `endedAt` is for a caller that ended the subscription itself a moment ago
 * (the account purge ends one that still runs at the payment provider): the
 * plan row does not say so yet, so the caller states the instant. A row that
 * already carries its own end keeps it.
 */
export function billingConsentArchiveRows(input: {
  userId: string;
  email: string;
  brand: BrandId;
  records: readonly BillingConsentRecord[];
  subscription: BillingConsentSubscription | null;
  now: Date;
  endedAt?: Date | null;
}): { rows: BillingConsentArchiveRow[]; expired: number } {
  const { now, subscription } = input;
  const endedAt = subscription?.canceledAt ?? input.endedAt ?? subscriptionEndedAt(subscription, now);
  const paidUntil = subscription?.currentPeriodEnd ?? null;
  const endsAt = endedAt ?? (paidUntil && paidUntil.getTime() > now.getTime() ? paidUntil : null);
  const emailHash = billingConsentEmailHash(input.email);
  const rows: BillingConsentArchiveRow[] = [];
  let expired = 0;
  for (const record of input.records) {
    if (!(BILLING_CONSENT_TYPES as readonly string[]).includes(record.consentType)) continue;
    const retainUntil = billingConsentRetainUntil(record.createdAt, endsAt, now);
    if (retainUntil.getTime() <= now.getTime()) {
      expired += 1;
      continue;
    }
    rows.push({
      userId: input.userId,
      emailHash,
      brand: input.brand,
      consentType: record.consentType,
      proseHash: record.proseHash ?? null,
      proseVersion: record.proseVersion ?? null,
      consentedAt: record.createdAt,
      subscriptionEndedAt: endedAt,
      stripeCustomerId: subscription?.stripeCustomerId ?? null,
      retainUntil,
    });
  }
  return { rows, expired };
}

export type ConsentArchiveDb = Pick<ExtendedPrismaClient, 'user' | 'seekerProfile' | 'seekerSubscription' | 'seekerConsentRecord' | 'rABillingConsentArchive'>;

export interface ConsentArchiveOutcome {
  /** Billing acknowledgements found on the account. */
  records: number;
  /** Rows written by THIS call (0 when an earlier run already wrote them). */
  archived: number;
  /** Acknowledgements whose period is already over: not copied. */
  expired: number;
}

/**
 * Copy the account's billing acknowledgements into the archive. Call it
 * before the account is deleted, and let a failure stop the deletion: once
 * the User row is gone the records cannot be read again.
 *
 * Safe to run twice and by two runs at once (the unique key and
 * `skipDuplicates`). An account without a profile or without billing
 * acknowledgements writes nothing.
 *
 * `options.subscriptionEndedAt`: the caller ended the subscription at this
 * instant and the plan row does not say so yet (see `billingConsentArchiveRows`).
 */
export async function archiveBillingConsents(
  db: ConsentArchiveDb,
  userId: string,
  now: Date = new Date(),
  options: { subscriptionEndedAt?: Date | null } = {},
): Promise<ConsentArchiveOutcome> {
  const none: ConsentArchiveOutcome = { records: 0, archived: 0, expired: 0 };
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, brand: true } });
  if (!user) return none;
  const profile = await db.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) return none;
  // Only what the proof needs. `ipAddress` and `userAgent` are never selected.
  const records = await db.seekerConsentRecord.findMany({
    where: { seekerProfileId: profile.id, consentType: { in: [...BILLING_CONSENT_TYPES] }, granted: true },
    select: { consentType: true, proseHash: true, proseVersion: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (records.length === 0) return none;
  const subscription = await db.seekerSubscription.findUnique({
    where: { seekerProfileId: profile.id },
    select: { canceledAt: true, currentPeriodEnd: true, stripeCustomerId: true },
  });
  const { rows, expired } = billingConsentArchiveRows({
    userId: user.id,
    email: user.email,
    brand: parseBrandId(user.brand) ?? 'roboapply',
    records,
    subscription,
    now,
    endedAt: options.subscriptionEndedAt ?? null,
  });
  if (rows.length === 0) return { records: records.length, archived: 0, expired };
  const written = await db.rABillingConsentArchive.createMany({ data: rows, skipDuplicates: true });
  return { records: records.length, archived: written.count, expired };
}

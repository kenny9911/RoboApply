// @vitest-environment node
//
// Checkout acknowledgements that outlive the account (ST-9 "consent
// retention"; MARKET_STRATEGY §4.4 "Renewal", California AB 2863): the date
// rule, the mapping of a consent record to its minimal proof, and the write
// that a second run does not repeat. In-memory Prisma; no database.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createFakePrisma } from '../../test/fakePrisma.js';
import {
  BILLING_CONSENT_KEEP_AFTER_END_YEARS,
  BILLING_CONSENT_KEEP_YEARS,
  BILLING_CONSENT_TYPES,
  archiveBillingConsents,
  billingConsentArchiveRows,
  billingConsentEmailHash,
  billingConsentRetainUntil,
  subscriptionEndedAt,
  type ConsentArchiveDb,
} from './consentArchive.js';

const NOW = new Date('2026-10-10T05:00:00.000Z');
/** `NOW` moved by whole calendar months (negative = earlier). */
const months = (n: number) => {
  const d = new Date(NOW.getTime());
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};

describe('billingConsentRetainUntil: the later of 3 years after consent and 1 year after the subscription ends', () => {
  it('the two periods are the ones the strategy names', () => {
    expect([BILLING_CONSENT_KEEP_YEARS, BILLING_CONSENT_KEEP_AFTER_END_YEARS]).toEqual([3, 1]);
    expect(BILLING_CONSENT_TYPES).toEqual(['auto_renew_ack', 'withdrawal_waiver', 'cn_pay_terms_ack']);
  });

  it('consented 30 months ago and the subscription ends with the account today: kept until month 42', () => {
    // 3 years after consent would be month 36; one year after the end is later.
    expect(billingConsentRetainUntil(months(-30), null, NOW)).toEqual(months(12));
    expect(months(12).getTime() - months(-30).getTime()).toBeGreaterThan(41 * 30 * 86_400_000);
  });

  it('consented 4 years ago, subscription ended 2 years ago: both periods are over', () => {
    const until = billingConsentRetainUntil(months(-48), months(-24), NOW);
    expect(until).toEqual(months(-12));
    expect(until.getTime()).toBeLessThan(NOW.getTime());
  });

  it('a recent consent on a plan that ended long ago is kept its 3 years', () => {
    expect(billingConsentRetainUntil(months(-2), months(-1), NOW)).toEqual(months(34));
  });

  it('an old consent on a plan that ended last month is kept one year after that end', () => {
    expect(billingConsentRetainUntil(months(-40), months(-1), NOW)).toEqual(months(11));
  });

  it('calendar years in UTC; a 29 February is a day late in a common year, never a day early', () => {
    expect(billingConsentRetainUntil(new Date('2024-02-29T12:00:00.000Z'), new Date('2024-03-01T00:00:00.000Z'), NOW).toISOString()).toBe('2027-03-01T12:00:00.000Z');
    expect(billingConsentRetainUntil(new Date('2025-12-31T23:59:59.999Z'), null, new Date('2026-01-01T00:00:00.000Z')).toISOString()).toBe('2028-12-31T23:59:59.999Z');
  });
});

describe('subscriptionEndedAt', () => {
  it('the moment it was ended for good, or a paid period that is over; null while it runs or when there is none', () => {
    expect(subscriptionEndedAt(null, NOW)).toBeNull();
    expect(subscriptionEndedAt({ canceledAt: months(-3), currentPeriodEnd: months(-4) }, NOW)).toEqual(months(-3));
    expect(subscriptionEndedAt({ canceledAt: null, currentPeriodEnd: months(-4) }, NOW)).toEqual(months(-4));
    expect(subscriptionEndedAt({ canceledAt: null, currentPeriodEnd: NOW }, NOW)).toEqual(NOW);
    expect(subscriptionEndedAt({ canceledAt: null, currentPeriodEnd: months(1) }, NOW)).toBeNull();
    expect(subscriptionEndedAt({ canceledAt: null, currentPeriodEnd: null }, NOW)).toBeNull();
  });
});

describe('billingConsentArchiveRows (the mapping)', () => {
  const base = { userId: 'u_1', email: '  Buyer@Example.TEST ', brand: 'roboapply' as const, now: NOW };
  const record = (over: Partial<{ consentType: string; proseHash: string | null; proseVersion: string | null; createdAt: Date }> = {}) => ({
    consentType: 'auto_renew_ack',
    proseHash: 'a'.repeat(64),
    proseVersion: 'billing-ack-2026-10-10',
    createdAt: months(-30),
    ...over,
  });

  it('one row per acknowledgement: what was agreed to, whose it was, until when', () => {
    const { rows, expired } = billingConsentArchiveRows({
      ...base,
      records: [record(), record({ consentType: 'withdrawal_waiver', proseHash: 'b'.repeat(64), createdAt: months(-2) })],
      subscription: { canceledAt: null, currentPeriodEnd: null, stripeCustomerId: 'cus_1' },
    });
    expect(expired).toBe(0);
    expect(rows).toEqual([
      {
        userId: 'u_1',
        emailHash: createHash('sha256').update('buyer@example.test').digest('hex'),
        brand: 'roboapply',
        consentType: 'auto_renew_ack',
        proseHash: 'a'.repeat(64),
        proseVersion: 'billing-ack-2026-10-10',
        consentedAt: months(-30),
        subscriptionEndedAt: null,
        stripeCustomerId: 'cus_1',
        retainUntil: months(12),
      },
      expect.objectContaining({ consentType: 'withdrawal_waiver', proseHash: 'b'.repeat(64), consentedAt: months(-2), retainUntil: months(34) }),
    ]);
  });

  it('the row holds no IP address, no user agent and no email in clear', () => {
    const withExtras = { ...record(), ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0', id: 'c_1', seekerProfileId: 'sp_1', granted: true };
    const { rows } = billingConsentArchiveRows({ ...base, records: [withExtras], subscription: null });
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['brand', 'consentType', 'consentedAt', 'emailHash', 'proseHash', 'proseVersion', 'retainUntil', 'stripeCustomerId', 'subscriptionEndedAt', 'userId'].sort(),
    );
    const text = JSON.stringify(rows);
    for (const secret of ['203.0.113.9', 'Mozilla', 'example.test', 'Buyer', 'buyer']) expect(text).not.toContain(secret);
    expect(rows[0]!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    // The hash ignores case and outer spaces, so the same address always gives the same value.
    expect(billingConsentEmailHash('BUYER@example.test')).toBe(rows[0]!.emailHash);
  });

  it('an acknowledgement whose period is over is not copied', () => {
    const { rows, expired } = billingConsentArchiveRows({
      ...base,
      records: [record({ createdAt: months(-48) }), record({ consentType: 'withdrawal_waiver', createdAt: months(-48) })],
      subscription: { canceledAt: months(-24), currentPeriodEnd: months(-24), stripeCustomerId: 'cus_1' },
    });
    expect(rows).toEqual([]);
    expect(expired).toBe(2);
  });

  it('the end of the subscription is the one the plan row shows: ended for good, or a paid period that is over', () => {
    const one = (subscription: Parameters<typeof billingConsentArchiveRows>[0]['subscription']) =>
      billingConsentArchiveRows({ ...base, records: [record({ createdAt: months(-40) })], subscription }).rows[0]!;
    expect(one({ canceledAt: months(-3), currentPeriodEnd: months(-3), stripeCustomerId: null })).toMatchObject({ subscriptionEndedAt: months(-3), retainUntil: months(9) });
    expect(one({ canceledAt: null, currentPeriodEnd: months(-6), stripeCustomerId: null })).toMatchObject({ subscriptionEndedAt: months(-6), retainUntil: months(6) });
  });

  it('a plan that is still paid for has not ended: its year runs from the end of the paid period, and the row says "not ended"', () => {
    const { rows } = billingConsentArchiveRows({
      ...base,
      records: [record({ createdAt: months(-40) })],
      subscription: { canceledAt: null, currentPeriodEnd: months(2), stripeCustomerId: 'cus_1' },
    });
    expect(rows[0]).toMatchObject({ subscriptionEndedAt: null, retainUntil: months(14) });
  });

  it('a subscription the caller ended a moment ago ended then: the row says so, though the plan row still shows a paid period', () => {
    const one = (subscription: Parameters<typeof billingConsentArchiveRows>[0]['subscription'], endedAt: Date | null) =>
      billingConsentArchiveRows({ ...base, records: [record({ createdAt: months(-40) })], subscription, endedAt }).rows[0]!;
    // Still paid for two more months, and ended now by the caller (the account purge).
    expect(one({ canceledAt: null, currentPeriodEnd: months(2), stripeCustomerId: 'cus_1' }, NOW)).toMatchObject({ subscriptionEndedAt: NOW, retainUntil: months(12) });
    // Past due: the unpaid period's date is not the end, the caller's instant is.
    expect(one({ canceledAt: null, currentPeriodEnd: months(-1), stripeCustomerId: 'cus_1' }, NOW)).toMatchObject({ subscriptionEndedAt: NOW, retainUntil: months(12) });
    // A row that already carries its own end keeps it.
    expect(one({ canceledAt: months(-3), currentPeriodEnd: months(-3), stripeCustomerId: 'cus_1' }, NOW)).toMatchObject({ subscriptionEndedAt: months(-3), retainUntil: months(9) });
    // No instant stated: as before.
    expect(one({ canceledAt: null, currentPeriodEnd: months(2), stripeCustomerId: 'cus_1' }, null)).toMatchObject({ subscriptionEndedAt: null, retainUntil: months(14) });
  });

  it('GoApply: the payment-terms acknowledgement of a pass, with no Stripe customer', () => {
    const { rows } = billingConsentArchiveRows({
      ...base,
      brand: 'goapply',
      records: [record({ consentType: 'cn_pay_terms_ack', proseVersion: 'cn-pay-terms-v1', createdAt: months(-1) })],
      subscription: { canceledAt: null, currentPeriodEnd: NOW, stripeCustomerId: null },
    });
    expect(rows[0]).toMatchObject({ brand: 'goapply', consentType: 'cn_pay_terms_ack', proseVersion: 'cn-pay-terms-v1', stripeCustomerId: null, retainUntil: months(35) });
  });

  it('any other consent type is not a billing acknowledgement and is left out', () => {
    const { rows, expired } = billingConsentArchiveRows({ ...base, records: [record({ consentType: 'marketing_email' }), record({ consentType: 'ai_assistance' })], subscription: null });
    expect(rows).toEqual([]);
    expect(expired).toBe(0);
  });
});

// ── The write ─────────────────────────────────────────────────────────────

/**
 * In-memory Prisma whose archive table has the real key: unique on
 * (userId, consentType, consentedAt). A plain create of a duplicate throws
 * P2002, as the database does; `skipDuplicates` leaves it out.
 */
function fakeDb() {
  const db = createFakePrisma();
  const table = db.rABillingConsentArchive;
  const keyOf = (r: Record<string, unknown>) => `${r.userId}|${r.consentType}|${(r.consentedAt as Date).getTime()}`;
  const writes: Array<{ rows: number; skipDuplicates: boolean }> = [];
  table.createMany = async (args) => {
    const list = (Array.isArray(args.data) ? args.data : [args.data]) as Array<Record<string, unknown>>;
    writes.push({ rows: list.length, skipDuplicates: args.skipDuplicates === true });
    let count = 0;
    for (const data of list) {
      if (db.$rows('rABillingConsentArchive').some((r) => keyOf(r) === keyOf(data))) {
        if (args.skipDuplicates) continue;
        throw Object.assign(new Error('Unique constraint failed on (userId, consentType, consentedAt)'), { code: 'P2002' });
      }
      await table.create({ data });
      count += 1;
    }
    return { count };
  };
  return { db, writes };
}

async function seedAccount(db: ReturnType<typeof createFakePrisma>, over: { brand?: string; subscription?: Record<string, unknown> | null } = {}) {
  await db.user.create({ data: { id: 'u_1', email: 'Buyer@Example.test', brand: over.brand ?? 'roboapply' } });
  await db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1' } });
  if (over.subscription !== null) {
    await db.seekerSubscription.create({
      data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', stripeCustomerId: 'cus_1', canceledAt: null, currentPeriodEnd: null, ...(over.subscription ?? {}) },
    });
  }
}

const consent = (over: Record<string, unknown> = {}) => ({
  seekerProfileId: 'sp_1',
  consentType: 'auto_renew_ack',
  granted: true,
  ipAddress: '203.0.113.9',
  userAgent: 'Mozilla/5.0',
  proseHash: 'a'.repeat(64),
  proseVersion: 'billing-ack-2026-10-10',
  createdAt: months(-30),
  ...over,
});

describe('archiveBillingConsents', () => {
  const as = (db: ReturnType<typeof createFakePrisma>) => db as unknown as ConsentArchiveDb;

  it('writes one row per billing acknowledgement of the account, with the hash of the email and no IP or user agent', async () => {
    const { db } = fakeDb();
    await seedAccount(db);
    await db.seekerConsentRecord.create({ data: consent() });
    await db.seekerConsentRecord.create({ data: consent({ consentType: 'withdrawal_waiver', proseHash: 'b'.repeat(64), createdAt: months(-29) }) });
    // Not billing acknowledgements, a refusal, and another account's record: none of them is copied.
    await db.seekerConsentRecord.create({ data: consent({ consentType: 'marketing_email' }) });
    await db.seekerConsentRecord.create({ data: consent({ granted: false, createdAt: months(-28) }) });
    await db.seekerConsentRecord.create({ data: consent({ seekerProfileId: 'sp_other', createdAt: months(-27) }) });

    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toEqual({ records: 2, archived: 2, expired: 0 });
    const rows = db.$rows('rABillingConsentArchive');
    expect(rows.map((r) => [r.consentType, r.proseHash, (r.consentedAt as Date).toISOString(), (r.retainUntil as Date).toISOString()])).toEqual([
      ['auto_renew_ack', 'a'.repeat(64), months(-30).toISOString(), months(12).toISOString()],
      ['withdrawal_waiver', 'b'.repeat(64), months(-29).toISOString(), months(12).toISOString()],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ userId: 'u_1', brand: 'roboapply', emailHash: billingConsentEmailHash('buyer@example.test'), stripeCustomerId: 'cus_1', subscriptionEndedAt: null, proseVersion: 'billing-ack-2026-10-10' });
      expect(row).not.toHaveProperty('ipAddress');
      expect(row).not.toHaveProperty('userAgent');
      expect(row).not.toHaveProperty('email');
    }
    expect(JSON.stringify(rows)).not.toMatch(/203\.0\.113\.9|Mozilla|example\.test/i);
  });

  it('running it twice writes the rows once (the unique key and skipDuplicates), also when two runs overlap', async () => {
    const { db, writes } = fakeDb();
    await seedAccount(db);
    await db.seekerConsentRecord.create({ data: consent() });
    await db.seekerConsentRecord.create({ data: consent({ consentType: 'withdrawal_waiver', createdAt: months(-29) }) });
    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toMatchObject({ archived: 2 });
    // A later run (a retry after the delete failed) and two overlapping runs.
    expect(await archiveBillingConsents(as(db), 'u_1', new Date(NOW.getTime() + 86_400_000))).toEqual({ records: 2, archived: 0, expired: 0 });
    const both = await Promise.all([archiveBillingConsents(as(db), 'u_1', NOW), archiveBillingConsents(as(db), 'u_1', NOW)]);
    expect(both.map((o) => o.archived)).toEqual([0, 0]);
    expect(db.$rows('rABillingConsentArchive')).toHaveLength(2);
    // Every write asked the database to skip what is already there: a plain create would have thrown P2002.
    expect(writes.every((w) => w.skipDuplicates)).toBe(true);
    // The rows of the first run stand: a later run does not move `retainUntil`.
    expect(db.$rows('rABillingConsentArchive').map((r) => (r.retainUntil as Date).toISOString())).toEqual([months(12).toISOString(), months(12).toISOString()]);
  });

  it('consented 4 years ago on a subscription that ended 2 years ago: no row is left', async () => {
    const { db, writes } = fakeDb();
    await seedAccount(db, { subscription: { status: 'canceled', canceledAt: months(-24), currentPeriodEnd: months(-24) } });
    await db.seekerConsentRecord.create({ data: consent({ createdAt: months(-48) }) });
    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toEqual({ records: 1, archived: 0, expired: 1 });
    expect(db.$rows('rABillingConsentArchive')).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('the subscription end on the row and the year after it come from the plan row', async () => {
    const { db } = fakeDb();
    await seedAccount(db, { subscription: { status: 'canceled', canceledAt: months(-3), currentPeriodEnd: months(-3) } });
    await db.seekerConsentRecord.create({ data: consent({ createdAt: months(-40) }) });
    await archiveBillingConsents(as(db), 'u_1', NOW);
    expect(db.$rows('rABillingConsentArchive')[0]).toMatchObject({ subscriptionEndedAt: months(-3), retainUntil: months(9) });
  });

  it('a caller that ended the subscription itself states the instant; without it the plan row decides', async () => {
    const { db } = fakeDb();
    await seedAccount(db, { subscription: { currentPeriodEnd: months(2) } });
    await db.seekerConsentRecord.create({ data: consent({ createdAt: months(-40) }) });
    await archiveBillingConsents(as(db), 'u_1', NOW, { subscriptionEndedAt: NOW });
    expect(db.$rows('rABillingConsentArchive')[0]).toMatchObject({ subscriptionEndedAt: NOW, retainUntil: months(12) });

    const other = fakeDb().db;
    await seedAccount(other, { subscription: { currentPeriodEnd: months(2) } });
    await other.seekerConsentRecord.create({ data: consent({ createdAt: months(-40) }) });
    await archiveBillingConsents(as(other), 'u_1', NOW, { subscriptionEndedAt: null });
    expect(other.$rows('rABillingConsentArchive')[0]).toMatchObject({ subscriptionEndedAt: null, retainUntil: months(14) });
  });

  it('a GoApply account is archived under its own brand', async () => {
    const { db } = fakeDb();
    await seedAccount(db, { brand: 'goapply', subscription: { stripeCustomerId: null, currentPeriodEnd: months(-1) } });
    await db.seekerConsentRecord.create({ data: consent({ consentType: 'cn_pay_terms_ack', proseVersion: 'cn-pay-terms-v1', createdAt: months(-2) }) });
    await archiveBillingConsents(as(db), 'u_1', NOW);
    expect(db.$rows('rABillingConsentArchive')[0]).toMatchObject({ brand: 'goapply', consentType: 'cn_pay_terms_ack', stripeCustomerId: null, subscriptionEndedAt: months(-1), retainUntil: months(34) });
  });

  it('an account with no plan row is still archived; one with no profile, no records or no user writes nothing', async () => {
    const { db, writes } = fakeDb();
    expect(await archiveBillingConsents(as(db), 'ghost', NOW)).toEqual({ records: 0, archived: 0, expired: 0 });
    await db.user.create({ data: { id: 'u_1', email: 'buyer@example.test', brand: 'roboapply' } });
    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toEqual({ records: 0, archived: 0, expired: 0 });
    await db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1' } });
    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toEqual({ records: 0, archived: 0, expired: 0 });
    expect(writes).toEqual([]);
    await db.seekerConsentRecord.create({ data: consent({ createdAt: months(-1) }) });
    expect(await archiveBillingConsents(as(db), 'u_1', NOW)).toEqual({ records: 1, archived: 1, expired: 0 });
    expect(db.$rows('rABillingConsentArchive')[0]).toMatchObject({ stripeCustomerId: null, subscriptionEndedAt: null, retainUntil: months(35) });
  });

  it('never asks the database for the IP address or the user agent of a record', async () => {
    const { db } = fakeDb();
    await seedAccount(db);
    const selects: unknown[] = [];
    const findMany = db.seekerConsentRecord.findMany;
    db.seekerConsentRecord.findMany = async (args = {}) => {
      selects.push(args.select);
      return findMany(args);
    };
    await db.seekerConsentRecord.create({ data: consent() });
    await archiveBillingConsents(as(db), 'u_1', NOW);
    expect(selects).toEqual([{ consentType: true, proseHash: true, proseVersion: true, createdAt: true }]);
  });
});

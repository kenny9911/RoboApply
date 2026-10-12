// @vitest-environment node
//
// ST-9 "consent retention" (MARKET_STRATEGY §4.4 "Renewal", California AB
// 2863): the account purge copies a minimal proof of the checkout
// acknowledgements into RABillingConsentArchive BEFORE it deletes the account,
// because the records themselves cascade away with the User row. The rule and
// the mapping are platform/billing/consentArchive.ts (consentArchive.test.ts);
// this file holds the purge's side: the order, a run that repeats, and what
// happens when the copy cannot be written.
//
// "After the subscription ends" needs the subscription to end: closing an
// account only soft-closes the profile, so the purge also ends a subscription
// that still runs at the payment provider before it deletes the plan row, the
// only pointer to it (second block below). In-memory Prisma, as in the other
// purge tests, and a fake Stripe client installed in the one client factory;
// no storage, no network.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma();
  h.db = db;
  return { default: db, prisma: db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../interview-engine/storage/r2Storage.js', () => ({
  interviewR2Storage: { isConfigured: () => true, deleteSessionArtifacts: vi.fn(async () => ({ attempted: 0, failed: 0 })) },
}));
vi.mock('../../services/ResumeOriginalFileStorageService.js', () => ({
  resumeOriginalFileStorageService: { deleteFile: vi.fn(async () => true), providerOfKey: () => 's3' },
}));
vi.mock('../../features/growth/index.js', () => ({ growthService: { deleteEventsForUser: vi.fn(async () => ({ deleted: 0 })) } }));
vi.mock('../../features/auth/tokens.js', () => ({ purgeAuthTokens: vi.fn(async () => 0) }));

import type { createFakePrisma } from '../../test/fakePrisma.js';
import { billingConsentEmailHash } from '../../platform/billing/consentArchive.js';
import { setStripeClientForTests } from '../../platform/billing/stripeClient.js';
import { purgeAccountNow, runAccountPurgeSweep, setArtifactStorageDeleter } from './SeekerAccountPurgeService.js';

type Fake = ReturnType<typeof createFakePrisma>;
type Row = Record<string, unknown>;
const db = (): Fake => h.db as Fake;

/** The run of the purge sweep. */
const NOW = new Date('2026-10-10T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
/** `NOW` moved by whole calendar months (negative = earlier). */
const months = (n: number) => {
  const d = new Date(NOW.getTime());
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};

const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'seekerConsentRecord', 'rABillingConsentArchive', 'rABillingRefund', 'rAOnboardingSession', 'rAWorkItem', 'rAApplicationArtifact', 'interviewSession', 'rAResumeVariant'];

/** Every database write of the purge that matters here, in order. */
const order: string[] = [];
/** Make the next `user.deleteMany` fail (the purge is then retried by the next run). */
const failUserDelete = { times: 0 };
/** Make the archive write fail. */
const failArchive = { on: false };

/**
 * The fake does not model the schema, so two things of the real database are
 * put in by hand: the archive's unique key (userId, consentType, consentedAt;
 * a plain create of a duplicate would throw P2002), and the cascade from User
 * to its profile, plan row and consent records.
 */
function installSchema(): void {
  const archive = db().rABillingConsentArchive;
  const keyOf = (r: Row) => `${r.userId}|${r.consentType}|${(r.consentedAt as Date).getTime()}`;
  const insert = archive.create.bind(archive);
  archive.createMany = async (args) => {
    order.push('archive.createMany');
    if (failArchive.on) throw new Error('database unavailable');
    const list = (Array.isArray(args.data) ? args.data : [args.data]) as Row[];
    let count = 0;
    for (const data of list) {
      if (db().$rows('rABillingConsentArchive').some((r) => keyOf(r) === keyOf(data))) {
        if (args.skipDuplicates) continue;
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      await insert({ data });
      count += 1;
    }
    return { count };
  };

  const users = db().user;
  const deleteUsers = users.deleteMany.bind(users);
  users.deleteMany = async (args = {}) => {
    order.push('user.deleteMany');
    if (failUserDelete.times > 0) {
      failUserDelete.times -= 1;
      throw new Error('deadlock detected');
    }
    const id = (args.where as { id: string }).id;
    const res = await deleteUsers(args);
    if (res.count === 0) return res;
    const profiles = db().$rows('seekerProfile').filter((r) => r.userId === id).map((r) => r.id);
    const drop = (table: string, keep: (r: Row) => boolean) => {
      const rows = db().$rows(table);
      const kept = rows.filter(keep);
      rows.length = 0;
      rows.push(...kept);
    };
    drop('seekerProfile', (r) => r.userId !== id);
    drop('seekerSubscription', (r) => !profiles.includes(r.seekerProfileId));
    drop('seekerConsentRecord', (r) => !profiles.includes(r.seekerProfileId));
    return res;
  };

  const sessions = db().rAOnboardingSession;
  const deleteSessions = sessions.deleteMany.bind(sessions);
  sessions.deleteMany = async (args = {}) => {
    order.push('rAOnboardingSession.deleteMany');
    return deleteSessions(args);
  };
}

/** A closed seeker account with a plan row. The profile row carries the `user` the sweep selects through the relation. */
async function closedAccount(id: string, over: { brand?: 'roboapply' | 'goapply'; deletedDaysAgo?: number; subscription?: Row } = {}): Promise<void> {
  const brand = over.brand ?? 'roboapply';
  const user = { id, email: `${id.toUpperCase()}@Example.test`, role: 'seeker', roles: ['seeker'], brand };
  await db().user.create({ data: user });
  await db().seekerProfile.create({ data: { id: `sp_${id}`, userId: id, deletedAt: daysAgo(over.deletedDaysAgo ?? 31), user } });
  await db().seekerSubscription.create({
    data: { id: `row_${id}`, seekerProfileId: `sp_${id}`, tier: 'pro', status: 'active', stripeCustomerId: brand === 'roboapply' ? `cus_${id}` : null, canceledAt: null, currentPeriodEnd: null, ...(over.subscription ?? {}) },
  });
  await db().rAOnboardingSession.create({ data: { id: `ob_${id}`, userId: id } });
}

async function consent(userId: string, over: Row = {}): Promise<void> {
  await db().seekerConsentRecord.create({
    data: {
      seekerProfileId: `sp_${userId}`,
      consentType: 'auto_renew_ack',
      granted: true,
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      proseHash: 'a'.repeat(64),
      proseVersion: 'billing-ack-2026-10-10',
      createdAt: months(-30),
      ...over,
    },
  });
}

const archiveRows = () => db().$rows('rABillingConsentArchive');

// ── The fake Stripe account ───────────────────────────────────────────────

/** What Stripe holds: subscription id → status. A subscription that is not here does not exist there. */
const atStripe = new Map<string, string>();
/** Stripe cannot be reached. */
const stripeDown = { on: false };
const stripeError = (over: Row) => Object.assign(new Error(String(over.message ?? 'stripe error')), over);
const stripe = {
  subscriptions: {
    cancel: vi.fn(async (id: string, _params: Row, _opts: { idempotencyKey: string }) => {
      order.push('stripe.subscriptions.cancel');
      if (stripeDown.on) throw stripeError({ type: 'StripeConnectionError', message: 'socket hang up' });
      const status = atStripe.get(id);
      if (!status) throw stripeError({ code: 'resource_missing', statusCode: 404, message: `No such subscription: '${id}'` });
      if (status === 'canceled') throw stripeError({ type: 'StripeInvalidRequestError', message: 'This subscription is already canceled.' });
      atStripe.set(id, 'canceled');
      return { id, status: 'canceled' };
    }),
    retrieve: vi.fn(async (id: string) => {
      if (stripeDown.on) throw stripeError({ type: 'StripeConnectionError', message: 'socket hang up' });
      const status = atStripe.get(id);
      if (!status) throw stripeError({ code: 'resource_missing', statusCode: 404, message: `No such subscription: '${id}'` });
      return { id, status };
    }),
  },
};
const cancelCalls = () => stripe.subscriptions.cancel.mock.calls.map((c) => [c[0], c[2]]);

// Once: the delegates are the same objects for the whole file.
beforeAll(installSchema);

beforeEach(() => {
  for (const t of TABLES) db().$rows(t).length = 0;
  order.length = 0;
  failUserDelete.times = 0;
  failArchive.on = false;
  setArtifactStorageDeleter(null);
  atStripe.clear();
  stripeDown.on = false;
  stripe.subscriptions.cancel.mockClear();
  stripe.subscriptions.retrieve.mockClear();
  setStripeClientForTests(stripe as never);
});

afterAll(() => {
  setStripeClientForTests(undefined);
});

describe('the account purge keeps the proof of checkout acknowledgements (ST-9)', () => {
  it('copies them before it deletes anything; the records go with the account, the proof stays', async () => {
    await closedAccount('gone');
    await consent('gone');
    await consent('gone', { consentType: 'withdrawal_waiver', proseHash: 'b'.repeat(64), createdAt: months(-29) });
    await closedAccount('open', { deletedDaysAgo: 2 });
    await consent('open');

    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 1, blocked: 0, failed: 0, billingConsentsArchived: 2 });
    // The copy comes first: once the User row is gone the records cannot be read again.
    // (The plan row names no Stripe subscription, so nothing is asked of Stripe.)
    expect(order).toEqual(['archive.createMany', 'rAOnboardingSession.deleteMany', 'user.deleteMany']);

    expect(db().$rows('user').map((u) => u.id)).toEqual(['open']);
    expect(db().$rows('seekerConsentRecord').map((r) => r.seekerProfileId)).toEqual(['sp_open']);
    expect(archiveRows().map((r) => [r.userId, r.consentType, r.proseHash])).toEqual([
      ['gone', 'auto_renew_ack', 'a'.repeat(64)],
      ['gone', 'withdrawal_waiver', 'b'.repeat(64)],
    ]);
    expect(archiveRows()[0]).toMatchObject({
      brand: 'roboapply',
      emailHash: billingConsentEmailHash('gone@example.test'),
      proseVersion: 'billing-ack-2026-10-10',
      consentedAt: months(-30),
      subscriptionEndedAt: null,
      stripeCustomerId: 'cus_gone',
    });
  });

  it('a subscriber who consented 30 months ago keeps a row until month 42: one year after the subscription ends with the account', async () => {
    await closedAccount('gone');
    await consent('gone', { createdAt: months(-30) });
    await runAccountPurgeSweep({ now: NOW });
    // 3 years after consent would be month 36 (6 months from now); a year after the end is later.
    expect(archiveRows().map((r) => r.retainUntil)).toEqual([months(12)]);
  });

  it('one who consented 4 years ago and whose subscription ended 2 years ago leaves no row', async () => {
    await closedAccount('gone', { subscription: { status: 'canceled', canceledAt: months(-24), currentPeriodEnd: months(-24) } });
    await consent('gone', { createdAt: months(-48) });
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 1, billingConsentsArchived: 0 });
    expect(archiveRows()).toEqual([]);
    expect(db().$rows('user')).toEqual([]);
  });

  it('the row holds no IP address, no user agent and no email in clear', async () => {
    await closedAccount('gone');
    await consent('gone');
    await runAccountPurgeSweep({ now: NOW });
    const row = archiveRows()[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ['brand', 'consentType', 'consentedAt', 'createdAt', 'emailHash', 'id', 'proseHash', 'proseVersion', 'retainUntil', 'stripeCustomerId', 'subscriptionEndedAt', 'updatedAt', 'userId'].sort(),
    );
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113\.9|Mozilla|example\.test/i);
    expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('running the purge twice writes the rows once: a run whose delete failed is finished by the next one', async () => {
    await closedAccount('gone');
    await consent('gone');
    await consent('gone', { consentType: 'withdrawal_waiver', createdAt: months(-29) });
    failUserDelete.times = 1;

    const first = await runAccountPurgeSweep({ now: NOW });
    expect(first).toMatchObject({ purged: 0, failed: 1 });
    expect(db().$rows('user')).toHaveLength(1);
    expect(archiveRows()).toHaveLength(2);
    const firstRun = archiveRows().map((r) => ({ ...r }));

    // The next nightly run: the same account again, a day later.
    const second = await runAccountPurgeSweep({ now: new Date(NOW.getTime() + 86_400_000) });
    expect(second).toMatchObject({ purged: 1, failed: 0, billingConsentsArchived: 0 });
    expect(db().$rows('user')).toEqual([]);
    // Each acknowledgement once, exactly as the first run wrote it.
    expect(archiveRows()).toEqual(firstRun);
    expect(order.filter((o) => o === 'archive.createMany')).toHaveLength(2);
  });

  it('a purge that is blocked by a file it could not delete copies nothing yet', async () => {
    await closedAccount('gone');
    await consent('gone');
    await db().rAApplicationArtifact.create({ data: { id: 'art_1', userId: 'gone', storageKey: 'artifacts/gone.pdf' } });
    setArtifactStorageDeleter(async () => false);
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 0, blocked: 1, billingConsentsArchived: 0 });
    expect(order).toEqual([]);
    expect(archiveRows()).toEqual([]);
    // Once the file is gone the account is purged and the proof is written.
    setArtifactStorageDeleter(async () => true);
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 1, billingConsentsArchived: 1 });
    expect(archiveRows()).toHaveLength(1);
  });

  it('when the proof cannot be written the account is not deleted, and nothing of it is', async () => {
    await closedAccount('gone');
    await consent('gone');
    failArchive.on = true;
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 0, failed: 1, billingConsentsArchived: 0 });
    expect(order).toEqual(['archive.createMany']);
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('rAOnboardingSession')).toHaveLength(1);
    expect(db().$rows('seekerConsentRecord')).toHaveLength(1);
    // The next run, with the database back, finishes it.
    failArchive.on = false;
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 1, failed: 0, billingConsentsArchived: 1 });
  });

  it('an account without a billing acknowledgement is purged as before, with no archive write', async () => {
    await closedAccount('gone');
    await consent('gone', { consentType: 'marketing_email' });
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 1, billingConsentsArchived: 0 });
    expect(order).toEqual(['rAOnboardingSession.deleteMany', 'user.deleteMany']);
    expect(archiveRows()).toEqual([]);
  });

  it('GoApply: the payment-terms acknowledgement of a pass is kept under its own brand, by the sweep and by the immediate purge', async () => {
    await closedAccount('cn', { brand: 'goapply', deletedDaysAgo: 16, subscription: { currentPeriodEnd: months(-1) } });
    await consent('cn', { consentType: 'cn_pay_terms_ack', proseVersion: 'cn-pay-terms-v1', createdAt: months(-2) });
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 1, billingConsentsArchived: 1 });
    expect(archiveRows()[0]).toMatchObject({ userId: 'cn', brand: 'goapply', consentType: 'cn_pay_terms_ack', stripeCustomerId: null, subscriptionEndedAt: months(-1), retainUntil: months(34) });

    // The statutory purge (a withdrawn cross-border consent) takes the same path, without the waiting period.
    await closedAccount('cn2', { brand: 'goapply', deletedDaysAgo: 0 });
    await consent('cn2', { consentType: 'cn_pay_terms_ack', createdAt: new Date(Date.now() - 86_400_000) });
    expect(await purgeAccountNow('cn2')).toEqual({ blocked: false });
    expect(db().$rows('user')).toEqual([]);
    expect(archiveRows().map((r) => [r.userId, r.brand, r.consentType])).toEqual([
      ['cn', 'goapply', 'cn_pay_terms_ack'],
      ['cn2', 'goapply', 'cn_pay_terms_ack'],
    ]);
  });
});

describe('the account purge ends a subscription that still runs at the payment provider', () => {
  /** A closed RoboApply account whose monthly plan was never cancelled: paid until two months from now. */
  async function subscriber(id = 'gone', over: Row = {}): Promise<void> {
    await closedAccount(id, { subscription: { brand: 'roboapply', stripeSubscriptionId: `sub_${id}`, currentPeriodEnd: months(2), ...over } });
    atStripe.set(`sub_${id}`, 'active');
  }

  it('ends it at once, under its own idempotency key, before the proof is copied and before anything is deleted', async () => {
    await subscriber();
    await consent('gone');
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 1, blocked: 0, failed: 0, subscriptionsEnded: 1, billingConsentsArchived: 1 });
    expect(order).toEqual(['stripe.subscriptions.cancel', 'archive.createMany', 'rAOnboardingSession.deleteMany', 'user.deleteMany']);
    expect(cancelCalls()).toEqual([['sub_gone', { idempotencyKey: 'purge:sub_gone' }]]);
    expect(atStripe.get('sub_gone')).toBe('canceled');
    expect(db().$rows('user')).toEqual([]);
    // The subscription ended now, so the year after its end is counted from now, not from a period it will never finish.
    expect(archiveRows()[0]).toMatchObject({ subscriptionEndedAt: NOW, retainUntil: months(12), stripeCustomerId: 'cus_gone' });
  });

  it('without that step the proof would count from the paid period: a row the purge did not have to end keeps that reading', async () => {
    // Cancelled by the buyer at period end before the account was closed: Stripe ended it, and the row says so.
    await closedAccount('gone', { subscription: { brand: 'roboapply', stripeSubscriptionId: 'sub_gone', status: 'canceled', canceledAt: months(-1), currentPeriodEnd: months(-1) } });
    atStripe.set('sub_gone', 'canceled');
    await consent('gone');
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 1, subscriptionsEnded: 0 });
    // A row that says it ended is not asked about at Stripe.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(archiveRows()[0]).toMatchObject({ subscriptionEndedAt: months(-1), retainUntil: months(11) });
  });

  it('when Stripe cannot be reached the account is kept, with nothing copied and nothing deleted; the next run finishes it', async () => {
    await subscriber();
    await consent('gone');
    stripeDown.on = true;
    const first = await runAccountPurgeSweep({ now: NOW });
    expect(first).toMatchObject({ purged: 0, blocked: 1, failed: 0, subscriptionsEnded: 0, billingConsentsArchived: 0 });
    expect(order).toEqual(['stripe.subscriptions.cancel']);
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('seekerSubscription')).toHaveLength(1);
    expect(db().$rows('rAOnboardingSession')).toHaveLength(1);
    expect(archiveRows()).toEqual([]);

    stripeDown.on = false;
    const next = new Date(NOW.getTime() + 86_400_000);
    expect(await runAccountPurgeSweep({ now: next })).toMatchObject({ purged: 1, blocked: 0, subscriptionsEnded: 1 });
    expect(cancelCalls()).toEqual([
      ['sub_gone', { idempotencyKey: 'purge:sub_gone' }],
      ['sub_gone', { idempotencyKey: 'purge:sub_gone' }],
    ]);
    expect(archiveRows()[0]).toMatchObject({ subscriptionEndedAt: next });
  });

  it('where card payments are not set up the account is kept too: the plan row is the only pointer to the subscription', async () => {
    await subscriber();
    setStripeClientForTests(null);
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 0, blocked: 1, subscriptionsEnded: 0 });
    expect(await purgeAccountNow('gone')).toEqual({ blocked: true, reason: 'stripe_not_configured' });
    expect(db().$rows('user')).toHaveLength(1);
    expect(order).toEqual([]);
  });

  it('a subscription Stripe already reports as cancelled, and one it does not know, hold nothing up', async () => {
    await subscriber('late');
    atStripe.set('sub_late', 'canceled');
    await subscriber('foreign');
    atStripe.delete('sub_foreign');
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 2, blocked: 0, subscriptionsEnded: 0 });
    expect(db().$rows('user')).toEqual([]);
  });

  it('a subscription that is not cancelled and cannot be cancelled keeps the account for the next run', async () => {
    await subscriber();
    stripe.subscriptions.cancel.mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', message: 'An unknown error occurred' }));
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 0, blocked: 1 });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_gone');
    expect(db().$rows('user')).toHaveLength(1);
  });

  it('a past-due and a cancel-at-period-end subscription still run: both are ended', async () => {
    await subscriber('late', { status: 'past_due', currentPeriodEnd: months(-1) });
    await consent('late');
    await subscriber('leaving', { cancelAtPeriodEnd: true });
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 2, subscriptionsEnded: 2 });
    expect(cancelCalls().map((c) => c[0]).sort()).toEqual(['sub_late', 'sub_leaving']);
    // Past due: Stripe was still retrying the charge, so the end is now, not the unpaid period's date.
    expect(archiveRows()[0]).toMatchObject({ userId: 'late', subscriptionEndedAt: NOW });
  });

  it('a run whose delete failed after the subscription was ended is finished by the next one, with the proof as first written', async () => {
    await subscriber();
    await consent('gone');
    failUserDelete.times = 1;
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 0, failed: 1 });
    const firstRun = archiveRows().map((r) => ({ ...r }));
    expect(firstRun[0]).toMatchObject({ subscriptionEndedAt: NOW });

    const second = await runAccountPurgeSweep({ now: new Date(NOW.getTime() + 86_400_000) });
    // Stripe says "already cancelled" this time: nothing was ended by this run, and nothing is held up.
    expect(second).toMatchObject({ purged: 1, failed: 0, subscriptionsEnded: 0, billingConsentsArchived: 0 });
    expect(cancelCalls()).toHaveLength(2);
    expect(archiveRows()).toEqual(firstRun);
    expect(db().$rows('user')).toEqual([]);
  });

  it('a file that cannot be deleted blocks the purge before Stripe is asked for anything', async () => {
    await subscriber();
    await db().rAApplicationArtifact.create({ data: { id: 'art_1', userId: 'gone', storageKey: 'artifacts/gone.pdf' } });
    setArtifactStorageDeleter(async () => false);
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 0, blocked: 1, subscriptionsEnded: 0 });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(atStripe.get('sub_gone')).toBe('active');
  });

  it('GoApply never reaches Stripe: neither a GoApply account nor a GoApply plan row makes the purge ask', async () => {
    await closedAccount('cn', { brand: 'goapply', deletedDaysAgo: 16, subscription: { brand: 'goapply', stripeSubscriptionId: 'sub_cn', currentPeriodEnd: months(1) } });
    await closedAccount('mixed', { subscription: { brand: 'goapply', stripeSubscriptionId: 'sub_mixed', currentPeriodEnd: months(1) } });
    setStripeClientForTests(null);
    expect(await runAccountPurgeSweep({ now: NOW })).toMatchObject({ purged: 2, blocked: 0, subscriptionsEnded: 0 });
    setStripeClientForTests(stripe as never);
    await closedAccount('cn2', { brand: 'goapply', deletedDaysAgo: 0, subscription: { stripeSubscriptionId: 'sub_cn2' } });
    expect(await purgeAccountNow('cn2')).toEqual({ blocked: false });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('the immediate purge ends it as well', async () => {
    await subscriber('now', {});
    await db().seekerProfile.updateMany({ where: { userId: 'now' }, data: { deletedAt: new Date() } });
    expect(await purgeAccountNow('now')).toEqual({ blocked: false });
    expect(cancelCalls()).toEqual([['sub_now', { idempotencyKey: 'purge:sub_now' }]]);
    expect(db().$rows('user')).toEqual([]);
  });
});

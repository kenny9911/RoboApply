// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestContext } from '../../lib/requestContext.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { hasSellableProPlan } from '../billing/planCatalog.js';
import { DEFAULT_CREDIT_CATALOG } from './catalog.js';
import {
  createEntitlementService,
  createPrismaEntitlementSource,
  liveSubscription,
  resolveEntitlementsFrom,
  type AccountSnapshot,
  type EntitlementOverrideRow,
  type ResolveInput,
} from './EntitlementService.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const FUTURE = new Date('2026-11-10T00:00:00Z');
const PAST = new Date('2026-10-01T00:00:00Z');

function input(account: AccountSnapshot | null, overrides: EntitlementOverrideRow[] = [], extra: Partial<ResolveInput> = {}): ResolveInput {
  return {
    userId: 'u1',
    account,
    overrides,
    catalogFor: (brand) => DEFAULT_CREDIT_CATALOG[brand],
    now: NOW,
    fallbackBrand: 'roboapply',
    proSellable: () => true,
    ...extra,
  };
}

const sub = (s: Partial<NonNullable<AccountSnapshot['subscription']>>): AccountSnapshot['subscription'] => ({
  tier: 'free',
  planKey: null,
  status: 'active',
  interval: null,
  currentPeriodEnd: null,
  ...s,
});

describe('resolution order: catalog → plan → override', () => {
  it('gives the Free column with no subscription', () => {
    const r = resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: 'Asia/Taipei', subscription: null }));
    expect(r.planProfile).toBe('free');
    expect(r.planKey).toBe('free');
    expect(r.buckets.tailor).toMatchObject({ cap: 2, window: 'day', proCap: 50, source: 'catalog' });
    expect(r.entitlements.saved_searches).toBe(1);
    expect(r.timezone).toBe('Asia/Taipei');
    expect(r.market).toBe('intl');
  });

  it('gives the Pro column for a live Pro plan', () => {
    const r = resolveEntitlementsFrom(
      input({ brand: 'roboapply', timezone: null, subscription: sub({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', currentPeriodEnd: FUTURE }) }),
    );
    expect(r.planProfile).toBe('pro');
    expect(r.planKey).toBe('pro_monthly');
    expect(r.buckets.tailor.cap).toBe(50);
    expect(r.buckets.competitiveness).toMatchObject({ cap: 3, window: 'day' });
    expect(r.entitlements).toEqual({ saved_searches: 10, instant_alerts: 100, competitivenessFull: true });
    expect(r.periodEnd).toEqual(FUTURE);
    expect(r.timezone).toBe('UTC'); // brand default
  });

  it('drops to Free when the period ended or the status is not active (past_due keeps Pro while Stripe retries)', () => {
    expect(resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ planKey: 'pro_monthly', currentPeriodEnd: PAST }) })).planProfile).toBe('free');
    expect(
      resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ planKey: 'pro_monthly', status: 'past_due', currentPeriodEnd: FUTURE }) })).planProfile,
    ).toBe('pro');
    for (const status of ['unpaid', 'canceled', 'incomplete']) {
      expect(
        resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ planKey: 'pro_monthly', status, currentPeriodEnd: FUTURE }) })).planProfile,
      ).toBe('free');
    }
    expect(resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ planKey: 'pro_monthly', currentPeriodEnd: null }) })).planProfile).toBe('free');
    expect(liveSubscription(sub({ status: 'trialing', currentPeriodEnd: FUTURE }), NOW)).toBe(true);
  });

  it('grandfathers starter/growth with Free-tier limits', () => {
    const r = resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ tier: 'growth', planKey: 'growth', currentPeriodEnd: FUTURE }) }));
    expect(r.planProfile).toBe('free');
    expect(r.legacyPlan).toBe(true);
    expect(r.planKey).toBe('growth');
  });

  it('uses the user brand (GoApply catalog, Shanghai time) over the request brand', () => {
    const r = resolveEntitlementsFrom(input({ brand: 'goapply', timezone: null, subscription: null }));
    expect(r.brand).toBe('goapply');
    expect(r.buckets.tailor.cap).toBe(3);
    expect(r.timezone).toBe('Asia/Shanghai');
    const unknown = resolveEntitlementsFrom(input({ brand: 'weird', timezone: null, subscription: null }, [], { fallbackBrand: 'goapply' }));
    expect(unknown.brand).toBe('goapply');
  });

  it('applies the newest live override and ignores expired or malformed ones', () => {
    const rows: EntitlementOverrideRow[] = [
      { key: 'bucket:tailor', value: 7, expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'bucket:tailor', value: 9, expiresAt: null, createdAt: new Date('2026-10-05') },
      { key: 'bucket:rewrite', value: 99, expiresAt: PAST, createdAt: new Date('2026-09-01') },
      { key: 'bucket:outreach', value: 'unlimited', expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'bucket:ready_kits', value: { cap: 6, window: 'week' }, expiresAt: FUTURE, createdAt: new Date('2026-10-01') },
      { key: 'bucket:contact_lookup', value: 5, expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'entitlement:saved_searches', value: 4, expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'entitlement:competitivenessFull', value: true, expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'entitlement:instant_alerts', value: true, expiresAt: null, createdAt: new Date('2026-10-01') },
      { key: 'flag:coaching', value: true, expiresAt: null, createdAt: new Date('2026-10-01') },
    ];
    const r = resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: null }, rows));
    expect(r.buckets.tailor).toMatchObject({ cap: 9, source: 'override' });
    expect(r.buckets.rewrite.cap).toBe(20);
    expect(r.buckets.outreach.cap).toBe(3);
    expect(r.buckets.ready_kits).toMatchObject({ cap: 6, window: 'week' });
    expect(r.buckets.contact_lookup.cap).toBe(0);
    expect(r.entitlements).toEqual({ saved_searches: 4, instant_alerts: 1, competitivenessFull: true });
    expect(r.appliedOverrides.sort()).toEqual(['bucket:ready_kits', 'bucket:tailor', 'entitlement:competitivenessFull', 'entitlement:saved_searches']);
  });

  it('reports whether a Pro plan can be bought', () => {
    expect(resolveEntitlementsFrom(input(null, [], { proSellable: () => false })).proSellable).toBe(false);
  });
});

describe('createEntitlementService', () => {
  it('reads the account through Prisma and memoizes per request', async () => {
    const fake = createFakePrisma({
      seed: {
        user: [{ id: 'u1', brand: 'roboapply' }],
        rAEntitlementOverride: [{ id: 'o1', userId: 'u1', key: 'bucket:tailor', value: 5, expiresAt: null, createdAt: new Date('2026-10-01') }],
      },
    });
    let accountLoads = 0;
    const prismaSource = createPrismaEntitlementSource(async () => fake as never);
    const svc = createEntitlementService({
      source: {
        // fakePrisma does not model nested selects, so the account loader is counted here.
        loadAccount: async () => {
          accountLoads += 1;
          return { brand: 'roboapply', timezone: null, subscription: null };
        },
        loadOverrides: (id) => prismaSource.loadOverrides(id),
      },
      loadCatalog: async (brand) => DEFAULT_CREDIT_CATALOG[brand],
      proSellable: () => true,
      now: () => NOW,
    });
    await withRequestContext('req-1', async () => {
      const a = await svc.resolve('u1');
      const b = await svc.resolve('u1');
      expect(a).toBe(b);
      expect(a.buckets.tailor.cap).toBe(5);
    });
    await withRequestContext('req-2', () => svc.resolve('u1'));
    expect(accountLoads).toBe(2);
    svc.invalidate('u1');
    await withRequestContext('req-2', () => svc.resolve('u1'));
    expect(accountLoads).toBe(3);
  });

  it('does not memoize outside a request', async () => {
    let loads = 0;
    const svc = createEntitlementService({
      source: { loadAccount: async () => (loads++, null), loadOverrides: async () => [] },
      loadCatalog: async (brand) => DEFAULT_CREDIT_CATALOG[brand],
      proSellable: () => false,
    });
    await svc.resolve('u1', { brand: 'goapply' });
    const r = await svc.resolve('u1', { brand: 'goapply' });
    expect(loads).toBe(2);
    expect(r.brand).toBe('goapply');
  });
});

describe('`upgradable` follows what can be paid for now, not the catalog alone (default proSellable)', () => {
  const PAY_ENV = [
    'ALIPAY_CALLBACK_SECRET',
    'CN_PAYMENTS_ENABLED',
    'CN_PAYMENT_REQUIRE_ENTITY',
    'CN_PAYMENT_COLLECTING_ENTITY',
    'CN_PRICE_PRO_MONTHLY_FEN',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_PRO_MONTHLY',
    'STRIPE_PRICE_PRO_MONTHLY_CENTS',
    'STRIPE_PRICE_PRO_WEEKLY',
    'STRIPE_PRICE_PRO_QUARTERLY',
    'STRIPE_PRICE_PRO_WEEK_PASS',
    'ALLOWED_BRANDS',
    'BRAND_LOCK',
  ];
  const upgradableOn = async (brand: 'goapply' | 'roboapply', env: Record<string, string>) => {
    for (const k of PAY_ENV) vi.stubEnv(k, '');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const svc = createEntitlementService({
      source: { loadAccount: async () => ({ brand, timezone: null, subscription: null }), loadOverrides: async () => [] },
      loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
      now: () => NOW,
    });
    const ent = await svc.resolve('u1', { brand });
    // What summary.ts and the 402 body call `upgradable`.
    return ent.planProfile === 'free' && ent.proSellable;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GoApply: plans are on sale by default, but there is no "Get Pro" until a rail can charge', async () => {
    expect(hasSellableProPlan('goapply', {})).toBe(true);
    // No rail credential: a credit wall must not offer a purchase that cannot be made.
    expect(await upgradableOn('goapply', {})).toBe(false);
    expect(await upgradableOn('goapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret' })).toBe(true);
    // The kill switch and the opt-in entity gate both close it again.
    expect(await upgradableOn('goapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret', CN_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(await upgradableOn('goapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret', CN_PAYMENT_REQUIRE_ENTITY: 'true' })).toBe(false);
    expect(await upgradableOn('goapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret', CN_PAYMENT_REQUIRE_ENTITY: 'true', CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.' })).toBe(true);
    // Stripe credentials never open GoApply.
    expect(await upgradableOn('goapply', { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
  });

  it('RoboApply with a configured price and a Stripe key is unchanged (upgradable); without a price or without the key it is not', async () => {
    const PRICE = { STRIPE_PRICE_PRO_MONTHLY: 'price_monthly_x', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' };
    expect(hasSellableProPlan('roboapply', PRICE)).toBe(true);
    expect(await upgradableOn('roboapply', { STRIPE_SECRET_KEY: 'sk_test_x', ...PRICE })).toBe(true);
    expect(await upgradableOn('roboapply', { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
    expect(await upgradableOn('roboapply', PRICE)).toBe(false);
    // Alipay credentials never open RoboApply.
    expect(await upgradableOn('roboapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret', ...PRICE })).toBe(false);
  });
});

describe('cancel at period end (INT-02: the summary carries it)', () => {
  it('is true only for a live plan the user cancelled', () => {
    const live = (over: Partial<NonNullable<AccountSnapshot['subscription']>> = {}) =>
      resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: sub({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', currentPeriodEnd: FUTURE, ...over }) }));
    expect(live({ cancelAtPeriodEnd: true })).toMatchObject({ planProfile: 'pro', cancelAtPeriodEnd: true, periodEnd: FUTURE });
    expect(live({ cancelAtPeriodEnd: false }).cancelAtPeriodEnd).toBe(false);
    expect(live().cancelAtPeriodEnd).toBe(false);
    expect(live({ cancelAtPeriodEnd: null }).cancelAtPeriodEnd).toBe(false);
    // Ended, or never paid: the flag on the row says nothing about a running plan.
    expect(live({ cancelAtPeriodEnd: true, currentPeriodEnd: PAST })).toMatchObject({ planProfile: 'free', cancelAtPeriodEnd: false });
    expect(live({ cancelAtPeriodEnd: true, status: 'canceled' }).cancelAtPeriodEnd).toBe(false);
    expect(resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: null })).cancelAtPeriodEnd).toBe(false);
  });

  it('a legacy practice plan that was cancelled reads the same way', () => {
    const r = resolveEntitlementsFrom(
      input({ brand: 'roboapply', timezone: null, subscription: sub({ tier: 'starter', planKey: null, interval: 'month', currentPeriodEnd: FUTURE, cancelAtPeriodEnd: true }) }),
    );
    expect(r).toMatchObject({ legacyPlan: true, cancelAtPeriodEnd: true });
  });

  it('the Prisma source selects the column and passes it on', async () => {
    const selects: unknown[] = [];
    const row = (cancelAtPeriodEnd: boolean) => ({
      brand: 'roboapply',
      seekerProfile: { timezone: 'UTC', subscription: { tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: FUTURE, cancelAtPeriodEnd } },
    });
    let cancelled = true;
    const db = {
      user: {
        findUnique: async (args: { select: unknown }) => {
          selects.push(args.select);
          return row(cancelled);
        },
      },
      rAEntitlementOverride: { findMany: async () => [] },
    };
    const source = createPrismaEntitlementSource(async () => db as never);
    expect((await source.loadAccount('u1'))?.subscription).toMatchObject({ planKey: 'pro_monthly', cancelAtPeriodEnd: true });
    cancelled = false;
    expect((await source.loadAccount('u1'))?.subscription?.cancelAtPeriodEnd).toBe(false);
    expect(JSON.stringify(selects[0])).toContain('"cancelAtPeriodEnd":true');
  });

  it('every bucket knows the Pro column\'s cap and window', () => {
    const r = resolveEntitlementsFrom(input({ brand: 'roboapply', timezone: null, subscription: null }));
    expect(r.buckets.ready_kits).toMatchObject({ cap: 3, window: 'week', proCap: 30, proWindow: 'week' });
    expect(r.buckets.competitiveness).toMatchObject({ cap: 1, window: 'week', proCap: 3, proWindow: 'day' });
  });
});

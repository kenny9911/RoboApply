// @vitest-environment node
//
// ST-7 (MARKET_STRATEGY §5.1 "Portal", M-16): the Stripe customer portal runs
// on a configuration this code creates: found by a hash of the settings we
// want, created once, never the account's default. Fake billingPortal only;
// nothing reaches Stripe.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../brand/registry.js';
import {
  PORTAL_CONFIG_HASH_LENGTH,
  desiredPortalConfiguration,
  desiredPortalSettings,
  ensurePortalConfiguration,
  portalConfigHash,
  resetStripePortalCacheForTests,
} from './stripePortal.js';

const ROBOAPPLY = getBrand('roboapply');
const GOAPPLY = getBrand('goapply');
const ENV = {};

/** A fake Stripe account: the portal configurations it holds, and every call made to it. */
function fakeStripe(held: Array<Record<string, any>> = []) {
  const state = { held: [...held], seq: 0 };
  const list = vi.fn(async (params: { active?: boolean; limit?: number; starting_after?: string }) => {
    const rows = state.held.filter((c) => (params.active === undefined ? true : c.active === params.active));
    const from = params.starting_after ? rows.findIndex((c) => c.id === params.starting_after) + 1 : 0;
    const page = rows.slice(from, from + (params.limit ?? 10));
    return { data: page, has_more: from + page.length < rows.length };
  });
  const create = vi.fn(async (params: Record<string, any>, _opts?: { idempotencyKey?: string }) => {
    const created = { ...params, id: `bpc_new_${++state.seq}`, active: true, is_default: false };
    state.held.push(created);
    return created;
  });
  const update = vi.fn();
  const client = { billingPortal: { configurations: { list, create, update }, sessions: { create: vi.fn() } } };
  return { client: client as never, list, create, update, state };
}

beforeEach(() => {
  resetStripePortalCacheForTests();
});

describe('the configuration we want', () => {
  const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);

  it('has our privacy and terms pages in business_profile, on the app origin', () => {
    expect(desired.business_profile).toEqual({
      privacy_policy_url: 'https://www.roboapply.io/legal/privacy',
      terms_of_service_url: 'https://www.roboapply.io/legal/terms',
    });
    // The origin follows the deployment (a preview or a local run), never a host written here.
    const local = desiredPortalConfiguration(ROBOAPPLY, { NEXT_PUBLIC_ROBOAPPLY_URL: 'http://localhost:3621/' });
    expect(local.business_profile).toEqual({ privacy_policy_url: 'http://localhost:3621/legal/privacy', terms_of_service_url: 'http://localhost:3621/legal/terms' });
  });

  it('offers invoices, payment method, customer details with tax id, and cancel at period end with a reason', () => {
    const f = desired.features!;
    expect(f.invoice_history).toEqual({ enabled: true });
    expect(f.payment_method_update).toEqual({ enabled: true });
    expect(f.customer_update).toEqual({ enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] });
    expect(f.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true } });
    expect((f.subscription_cancel!.cancellation_reason!.options as string[]).length).toBeGreaterThan(0);
  });

  it('has subscription update OFF: plan changes stay in the app, where the renewal acknowledgement is recorded', () => {
    expect(desired.features!.subscription_update).toEqual({ enabled: false });
  });

  it('is marked as ours with a 16-hex hash of the settings', () => {
    expect(desired.metadata).toEqual({ product: 'roboapply', configHash: portalConfigHash(desiredPortalSettings(ROBOAPPLY, ENV)) });
    expect(desired.metadata!.configHash).toMatch(new RegExp(`^[0-9a-f]{${PORTAL_CONFIG_HASH_LENGTH}}$`));
    expect(PORTAL_CONFIG_HASH_LENGTH).toBe(16);
  });

  it('the hash is stable for the same settings and different for any changed setting', () => {
    const base = desiredPortalSettings(ROBOAPPLY, ENV);
    expect(portalConfigHash(desiredPortalSettings(ROBOAPPLY, ENV))).toBe(portalConfigHash(base));
    // Key order does not matter.
    const reordered = { features: { ...Object.fromEntries(Object.entries(base.features!).reverse()) }, business_profile: base.business_profile };
    expect(portalConfigHash(reordered as never)).toBe(portalConfigHash(base));
    const changed = [
      desiredPortalSettings(ROBOAPPLY, { NEXT_PUBLIC_ROBOAPPLY_URL: 'https://staging.roboapply.io' }),
      { ...base, features: { ...base.features!, subscription_update: { enabled: true } } },
      { ...base, features: { ...base.features!, subscription_cancel: { ...base.features!.subscription_cancel!, mode: 'immediately' } } },
      { ...base, features: { ...base.features!, customer_update: { enabled: true, allowed_updates: ['email'] } } },
    ];
    const hashes = new Set(changed.map((c) => portalConfigHash(c as never)));
    expect(hashes.size).toBe(changed.length);
    expect(hashes.has(portalConfigHash(base))).toBe(false);
  });
});

describe('ensurePortalConfiguration', () => {
  it('an account without our configuration: created once, under portalcfg:<hash>, with the desired settings', async () => {
    const s = fakeStripe();
    const id = await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV);
    expect(id).toBe('bpc_new_1');
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.list).toHaveBeenCalledWith({ active: true, limit: 100 });
    expect(s.create).toHaveBeenCalledTimes(1);
    const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);
    expect(s.create).toHaveBeenCalledWith(desired, { idempotencyKey: `portalcfg:${desired.metadata!.configHash}` });
  });

  it('a second call in the same process makes no Stripe call', async () => {
    const s = fakeStripe();
    const first = await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV);
    s.list.mockClear();
    s.create.mockClear();
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe(first);
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe(first);
    expect(s.list).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });

  it('two calls at the same moment create one configuration', async () => {
    const s = fakeStripe();
    const [a, b] = await Promise.all([ensurePortalConfiguration(s.client, ROBOAPPLY, ENV), ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)]);
    expect(a).toBe(b);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.list).toHaveBeenCalledTimes(1);
  });

  it('a cold process finds the existing configuration by its hash and creates nothing', async () => {
    const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);
    const s = fakeStripe([{ id: 'bpc_existing', active: true, is_default: false, metadata: { ...desired.metadata } }]);
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe('bpc_existing');
    expect(s.create).not.toHaveBeenCalled();
    // A "restart": the memory is gone, Stripe still holds it.
    resetStripePortalCacheForTests();
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe('bpc_existing');
    expect(s.create).not.toHaveBeenCalled();
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it('never picks the account default, another product\'s configuration, or one of ours with another hash', async () => {
    const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);
    const s = fakeStripe([
      { id: 'bpc_default', active: true, is_default: true, metadata: {} },
      { id: 'bpc_other_product', active: true, is_default: false, metadata: { product: 'robohire', configHash: desired.metadata!.configHash } },
      { id: 'bpc_ours_old', active: true, is_default: false, metadata: { product: 'roboapply', configHash: '0000000000000000' } },
    ]);
    const id = await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV);
    expect(id).toBe('bpc_new_1');
    expect(s.create).toHaveBeenCalledTimes(1);
    // Nothing that was there is changed.
    expect(s.update).not.toHaveBeenCalled();
    expect(s.state.held.map((c) => c.id)).toEqual(['bpc_default', 'bpc_other_product', 'bpc_ours_old', 'bpc_new_1']);
  });

  it('a changed desired object creates a new configuration and leaves the old one', async () => {
    const s = fakeStripe();
    const first = await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV);
    // The settings change (here: the origin the legal links point at).
    const second = await ensurePortalConfiguration(s.client, ROBOAPPLY, { NEXT_PUBLIC_ROBOAPPLY_URL: 'https://staging.roboapply.io' });
    expect(second).not.toBe(first);
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(s.update).not.toHaveBeenCalled();
    expect(s.state.held.map((c) => [c.id, c.active])).toEqual([
      [first, true],
      [second, true],
    ]);
    // Each is remembered under its own hash.
    s.list.mockClear();
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe(first);
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, { NEXT_PUBLIC_ROBOAPPLY_URL: 'https://staging.roboapply.io' })).toBe(second);
    expect(s.list).not.toHaveBeenCalled();
  });

  it('an archived configuration with our hash is not reused', async () => {
    const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);
    const s = fakeStripe([{ id: 'bpc_archived', active: false, is_default: false, metadata: { ...desired.metadata } }]);
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe('bpc_new_1');
  });

  it('reads further pages of a busy shared account before it creates', async () => {
    const desired = desiredPortalConfiguration(ROBOAPPLY, ENV);
    const others = Array.from({ length: 130 }, (_, i) => ({ id: `bpc_o_${i}`, active: true, is_default: false, metadata: { product: 'robohire' } }));
    const s = fakeStripe([...others, { id: 'bpc_ours', active: true, is_default: false, metadata: { ...desired.metadata } }]);
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe('bpc_ours');
    expect(s.list).toHaveBeenCalledTimes(2);
    expect(s.list).toHaveBeenLastCalledWith({ active: true, limit: 100, starting_after: 'bpc_o_99' });
    expect(s.create).not.toHaveBeenCalled();
  });

  it('a Stripe failure is thrown and not remembered: the next call tries again', async () => {
    const s = fakeStripe();
    s.list.mockRejectedValueOnce(new Error('stripe down'));
    await expect(ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).rejects.toThrow('stripe down');
    expect(await ensurePortalConfiguration(s.client, ROBOAPPLY, ENV)).toBe('bpc_new_1');
  });

  it('each Stripe client (one key, so one account and mode) has its own memory', async () => {
    const test = fakeStripe();
    const live = fakeStripe();
    await ensurePortalConfiguration(test.client, ROBOAPPLY, ENV);
    await ensurePortalConfiguration(live.client, ROBOAPPLY, ENV);
    expect(test.create).toHaveBeenCalledTimes(1);
    expect(live.create).toHaveBeenCalledTimes(1);
  });

  it('rule A11: GoApply never gets a portal configuration, and Stripe is not called', async () => {
    const s = fakeStripe();
    await expect(ensurePortalConfiguration(s.client, GOAPPLY, ENV)).rejects.toMatchObject({ code: 'rail_not_allowed' });
    expect(s.list).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });
});

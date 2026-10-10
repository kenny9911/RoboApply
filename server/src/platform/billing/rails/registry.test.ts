// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../brand/registry.js';
import { availableRails, getRegisteredRail, railAvailable, registerRail, resolveRail, unregisterRail } from './index.js';
import type { PaymentRailImpl } from './types.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  // The Alipay rail's own credential. No master switch and no worker URL (D5).
  ALIPAY_CALLBACK_SECRET: 's3cret',
  // WeChat Pay still needs the merchant set and an entity that matches it.
  CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
  WECHATPAY_MCH_ID: 'm',
  WECHATPAY_APP_ID: 'a',
  WECHATPAY_API_V3_KEY: '0123456789abcdef0123456789abcdef',
  WECHATPAY_MCH_CERT_SERIAL: 's',
  WECHATPAY_MCH_PRIVATE_KEY: 'p',
  WECHATPAY_PUBLIC_KEY: 'pub',
  WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
  WECHATPAY_MERCHANT_ENTITY: 'Example Collecting Co.',
};

function fakeWechat(configured = true): PaymentRailImpl {
  return {
    id: 'wechatpay',
    isConfigured: () => configured,
    createCheckout: vi.fn(async () => ({ kind: 'qr' as const, qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', orderId: 'GAORDER_1' })),
  };
}

afterEach(() => unregisterRail('wechatpay'));

describe('rail lock (brand decides; ?region= never does)', () => {
  it('registers the built-in Stripe and Alipay rails on import', () => {
    expect(getRegisteredRail('stripe')?.id).toBe('stripe');
    expect(getRegisteredRail('alipay')?.id).toBe('alipay');
  });

  it('GoApply never resolves to Stripe', () => {
    expect(() => resolveRail(go, 'stripe', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_allowed' }));
    expect(resolveRail(go, null, ENV).id).toBe('alipay');
    expect(availableRails(go, ENV)).not.toContain('stripe');
  });

  it('RoboApply never resolves to Alipay for a new purchase', () => {
    expect(() => resolveRail(robo, 'alipay', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_allowed' }));
    expect(resolveRail(robo, null, ENV).id).toBe('stripe');
    expect(availableRails(robo, ENV)).toEqual(['stripe']);
  });

  it('an unconfigured rail is refused (Stripe key missing; the CN kill switch; no callback secret; the entity hard gate)', () => {
    expect(() => resolveRail(robo, null, { ...ENV, STRIPE_SECRET_KEY: '' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(() => resolveRail(go, 'alipay', { ...ENV, CN_PAYMENTS_ENABLED: 'false' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(() => resolveRail(go, 'alipay', { ...ENV, ALIPAY_CALLBACK_SECRET: '' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(() => resolveRail(go, null, {})).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    // The collecting entity is not a gate any more (D5) ...
    expect(railAvailable(go, 'alipay', { ...ENV, CN_PAYMENT_COLLECTING_ENTITY: '' })).toBe(true);
    // ... unless the operator asks for it.
    expect(railAvailable(go, 'alipay', { ...ENV, CN_PAYMENT_COLLECTING_ENTITY: '', CN_PAYMENT_REQUIRE_ENTITY: 'true' })).toBe(false);
    expect(railAvailable(go, 'alipay', { ...ENV, CN_PAYMENT_REQUIRE_ENTITY: 'true' })).toBe(true);
  });

  it('the Alipay rail opens with the callback secret alone (D6; MARKET_STRATEGY AL-2)', () => {
    const only = { ALIPAY_CALLBACK_SECRET: 's3cret' };
    expect(railAvailable(go, 'alipay', only)).toBe(true);
    expect(availableRails(go, only)).toEqual(['alipay']);
    expect(resolveRail(go, null, only).id).toBe('alipay');
    expect(resolveRail(go, 'alipay', only).id).toBe('alipay');
    // No master switch, no worker URL, no entity, no price variable was needed.
    expect(railAvailable(go, 'alipay', {})).toBe(false);
    expect(availableRails(go, {})).toEqual([]);
    // The secret never opens Alipay for RoboApply.
    expect(availableRails(robo, only)).toEqual([]);
  });

  it('WeChat Pay is not available until a later wave registers it', () => {
    expect(() => resolveRail(go, 'wechatpay', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_registered' }));
  });
});

describe('registerRail (WP-62 extension point)', () => {
  it('a registered fake rail is resolved and used', async () => {
    const rail = fakeWechat();
    registerRail('wechatpay', rail);
    const resolved = resolveRail(go, 'wechatpay', ENV);
    expect(resolved).toBe(rail);
    expect(availableRails(go, ENV)).toEqual(['alipay', 'wechatpay']);
    await expect(resolved.createCheckout({} as never)).resolves.toMatchObject({ kind: 'qr' });
  });

  it('a registered rail that reports itself unconfigured is skipped', () => {
    registerRail('wechatpay', fakeWechat(false));
    expect(() => resolveRail(go, 'wechatpay', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
  });

  it('Alipay first: a purchase that names no rail gets Alipay, with WeChat Pay ready or not', () => {
    // WeChat Pay registered and ready: both are offered, Alipay is the default.
    registerRail('wechatpay', fakeWechat());
    expect(availableRails(go, ENV)).toEqual(['alipay', 'wechatpay']);
    expect(resolveRail(go, null, ENV).id).toBe('alipay');
    expect(resolveRail(go, undefined, ENV).id).toBe('alipay');
    // WeChat Pay registered but not ready (merchant credentials absent, or the entity does not match):
    // Alipay alone is offered and still takes the purchase.
    registerRail('wechatpay', fakeWechat(false));
    expect(availableRails(go, ENV)).toEqual(['alipay']);
    expect(resolveRail(go, null, ENV).id).toBe('alipay');
    const noMerchant = { ALIPAY_CALLBACK_SECRET: 's3cret' };
    registerRail('wechatpay', fakeWechat());
    expect(availableRails(go, noMerchant)).toEqual(['alipay']);
    expect(resolveRail(go, null, noMerchant).id).toBe('alipay');
  });

  it('falls through to WeChat Pay only when Alipay cannot charge', () => {
    const rail = fakeWechat();
    registerRail('wechatpay', rail);
    const noAlipay = { ...ENV, ALIPAY_CALLBACK_SECRET: '' };
    expect(availableRails(go, noAlipay)).toEqual(['wechatpay']);
    expect(resolveRail(go, null, noAlipay)).toBe(rail);
    // Neither can charge: no rail, and the kill switch closes both.
    expect(() => resolveRail(go, null, { ...ENV, CN_PAYMENTS_ENABLED: 'false' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(availableRails(go, { ...ENV, CN_PAYMENTS_ENABLED: 'false' })).toEqual([]);
  });

  it('refuses an implementation registered under another id', () => {
    expect(() => registerRail('wechatpay', { ...fakeWechat(), id: 'alipay' })).toThrow(/does not match/);
  });

  it('still never lets RoboApply use a CN rail, registered or not', () => {
    registerRail('wechatpay', fakeWechat());
    expect(() => resolveRail(robo, 'wechatpay', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_allowed' }));
  });
});

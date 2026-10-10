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
  CN_PAYMENTS_ENABLED: 'true',
  ALIPAY_API_URL: 'https://pay.example.test/create',
  ALIPAY_CALLBACK_SECRET: 's3cret',
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

  it('an unconfigured rail is refused (Stripe key missing; CN payments off; no collecting entity)', () => {
    expect(() => resolveRail(robo, null, { ...ENV, STRIPE_SECRET_KEY: '' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(() => resolveRail(go, 'alipay', { ...ENV, CN_PAYMENTS_ENABLED: 'false' })).toThrow(expect.objectContaining({ code: 'rail_not_configured' }));
    expect(railAvailable(go, 'alipay', { ...ENV, CN_PAYMENT_COLLECTING_ENTITY: '' })).toBe(false);
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

  it('refuses an implementation registered under another id', () => {
    expect(() => registerRail('wechatpay', { ...fakeWechat(), id: 'alipay' })).toThrow(/does not match/);
  });

  it('still never lets RoboApply use a CN rail, registered or not', () => {
    registerRail('wechatpay', fakeWechat());
    expect(() => resolveRail(robo, 'wechatpay', ENV)).toThrow(expect.objectContaining({ code: 'rail_not_allowed' }));
  });
});

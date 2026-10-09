// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findProfile: vi.fn(),
  createOrder: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  default: {
    seekerProfile: { findUnique: mocks.findProfile },
    alipayOrder: { create: mocks.createOrder },
  },
}));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../lib/mockInterviewPlans.js', () => ({
  getMockPlanCatalog: async () => ({ plans: { starter: { cnyMinor: 1900 } } }),
}));
vi.mock('../../lib/mockCreditService.js', () => ({}));
vi.mock('../../lib/rateCard.js', () => ({}));

import { createAlipayOrder } from './RoboApplyBillingService.js';

async function checkoutPayload() {
  await createAlipayOrder({
    userId: 'test-seeker',
    name: 'Test Seeker',
    email: 'seeker@example.com',
    tier: 'starter',
  });
  return JSON.parse(mocks.fetch.mock.calls[0][1].body) as {
    notify_url: string;
    total_amount: number;
    out_trade_no: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BACKEND_URL', undefined);
  vi.stubEnv('ALIPAY_CALLBACK_SECRET', undefined);
  vi.stubEnv('ALIPAY_API_URL', 'https://payments.example.com/create');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.findProfile.mockResolvedValue({ id: 'test-profile', subscription: null });
  mocks.createOrder.mockResolvedValue({ id: 'test-order' });
  mocks.fetch.mockResolvedValue({
    text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://payments.example.com/pay' } }),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Alipay checkout callback destination', () => {
  it('sends new orders to the standalone RoboApply API by default', async () => {
    const payload = await checkoutPayload();

    expect(payload.notify_url).toBe('https://www.roboapply.io/api/v1/roboapply/billing/alipay/callback');
    expect(payload.total_amount).toBe(19);
    expect(mocks.createOrder).toHaveBeenCalledWith({
      data: expect.objectContaining({ outTradeNo: payload.out_trade_no, tier: 'ra_starter', status: 'pending' }),
    });
  });

  it.each(['https://callback.example.com', 'https://callback.example.com/'])(
    'honors an explicit callback backend (%s) without a double slash',
    async (baseUrl) => {
      vi.stubEnv('BACKEND_URL', baseUrl);

      expect((await checkoutPayload()).notify_url).toBe(
        'https://callback.example.com/api/v1/roboapply/billing/alipay/callback',
      );
    },
  );

  it('preserves and encodes the callback secret on the corrected URL', async () => {
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', 'test+secret&with?symbols');
    const url = new URL((await checkoutPayload()).notify_url);

    expect(url.origin).toBe('https://www.roboapply.io');
    expect([...url.searchParams]).toEqual([['cb', 'test+secret&with?symbols']]);
  });
});

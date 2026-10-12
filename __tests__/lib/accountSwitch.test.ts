// The legacy → Pro switch seam between the WP-21b plan sheet (quote / confirm
// with an opaque quoteId) and WP-21a's single `POST /billing/switch` endpoint.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({ roboApi: { post, get: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import { accountApi, parseQuoteId } from '../../lib/api/account';

beforeEach(() => post.mockReset());

describe('accountApi.switchQuote / switchConfirm', () => {
  it('quotes through POST /billing/switch without confirm and maps the server quote', async () => {
    post.mockResolvedValueOnce({
      quote: { planKey: 'pro_monthly', currency: 'usd', amountDueTodayMinor: 1234, newRenewalPriceMinor: 2499, nextRenewalDate: '2026-11-10T00:00:00.000Z', prorationDate: 1791590400 },
    });
    const q = await accountApi.switchQuote({ planKey: 'pro_monthly' });
    expect(post).toHaveBeenCalledWith('/api/v1/roboapply/billing/switch', { planKey: 'pro_monthly' });
    expect(q).toEqual({
      quoteId: 'pro_monthly:1791590400',
      planKey: 'pro_monthly',
      currency: 'usd',
      amountDueTodayMinor: 1234,
      renewalAmountMinor: 2499,
      nextRenewalAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it('confirms with the plan key, proration date and acknowledgements the server requires', async () => {
    post.mockResolvedValueOnce({ switched: true, planKey: 'pro_monthly' });
    const res = await accountApi.switchConfirm({ quoteId: 'pro_monthly:1791590400', autoRenewAck: true, withdrawalWaiver: false });
    expect(post).toHaveBeenCalledWith('/api/v1/roboapply/billing/switch', {
      planKey: 'pro_monthly',
      confirm: true,
      prorationDate: 1791590400,
      autoRenewAck: true,
      withdrawalWaiver: false,
    });
    expect(res).toEqual({ status: 'switched', planKey: 'pro_monthly', nextRenewalAt: null });
  });

  it('refuses a malformed quote id without calling the server', async () => {
    await expect(accountApi.switchConfirm({ quoteId: 'garbage', autoRenewAck: true })).rejects.toThrow('Invalid switch quote id');
    expect(() => parseQuoteId(':123')).toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

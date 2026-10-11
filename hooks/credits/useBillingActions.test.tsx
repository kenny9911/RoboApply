// The checkout attempt key (ST-2, web half; MARKET_STRATEGY §5.1): a UUID per
// attempt, the same for a repeated request, new when the request changes or
// the attempt is renewed, and handed to the API wrapper beside the body.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const account = vi.hoisted(() => ({ checkoutPlan: vi.fn(), alipayCheckoutPlan: vi.fn() }));
vi.mock('../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));

import { CHECKOUT_ATTEMPT_KEY_PATTERN } from '../../lib/api/account';
import { newAttemptKey, useCheckoutAttempt, usePlanCheckout } from './useBillingActions';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('newAttemptKey', () => {
  it('is a version 4 UUID the server accepts as an Idempotency-Key', () => {
    const keys = Array.from({ length: 50 }, () => newAttemptKey());
    for (const key of keys) {
      expect(key).toMatch(UUID_V4);
      expect(key).toMatch(CHECKOUT_ATTEMPT_KEY_PATTERN);
    }
    expect(new Set(keys).size).toBe(50);
  });

  it('uses crypto.randomUUID when the browser has it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() });
    expect(newAttemptKey()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('builds the same shape without randomUUID (a page not served over HTTPS), and without Web Crypto at all', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const fromValues = newAttemptKey();
    expect(fromValues).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    vi.stubGlobal('crypto', undefined);
    const a = newAttemptKey();
    const b = newAttemptKey();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });
});

describe('useCheckoutAttempt', () => {
  const body = { rail: 'stripe', planKey: 'pro_monthly', autoRenewAck: true, next: '/settings/billing/return?plan=pro_monthly' };

  it('the same request keeps its key across clicks and re-renders', () => {
    const { result, rerender } = renderHook(() => useCheckoutAttempt());
    const first = result.current.keyFor(body);
    expect(first).toMatch(UUID_V4);
    expect(result.current.keyFor({ ...body })).toBe(first);
    rerender();
    expect(result.current.keyFor(body)).toBe(first);
  });

  it('a request with other content gets a new key (the provider refuses a repeated key with other parameters)', () => {
    const { result } = renderHook(() => useCheckoutAttempt());
    const first = result.current.keyFor(body);
    const otherPlan = result.current.keyFor({ ...body, planKey: 'pro_quarterly' });
    expect(otherPlan).not.toBe(first);
    const otherBox = result.current.keyFor({ ...body, planKey: 'pro_quarterly', withdrawalWaiver: true });
    expect(otherBox).not.toBe(otherPlan);
    // A changed return address (the practice balance moved) is other content too.
    expect(result.current.keyFor({ ...body, planKey: 'pro_quarterly', withdrawalWaiver: true, next: '/x' })).not.toBe(otherBox);
    // And back to the first content is a new attempt, not the first key again.
    expect(result.current.keyFor(body)).not.toBe(first);
  });

  it('renew() starts a new attempt for the same request', () => {
    const { result } = renderHook(() => useCheckoutAttempt());
    const first = result.current.keyFor(body);
    act(() => result.current.renew());
    const second = result.current.keyFor(body);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
    expect(result.current.keyFor(body)).toBe(second);
  });

  it('each mounted sheet has its own attempt, and the returned object is stable', () => {
    const a = renderHook(() => useCheckoutAttempt());
    const b = renderHook(() => useCheckoutAttempt());
    expect(a.result.current.keyFor(body)).not.toBe(b.result.current.keyFor(body));
    const before = a.result.current;
    a.rerender();
    expect(a.result.current).toBe(before);
    expect(a.result.current.renew).toBe(before.renew);
  });
});

describe('usePlanCheckout', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
  );
  const KEY = '3f2b8c1e-6a4d-4f0b-9c2e-7d1a5b8e9f00';

  it('hands the attempt key to the Stripe wrapper beside the body, never inside it', async () => {
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/s', orderId: 'cs_1', rail: 'stripe' });
    const { result } = renderHook(() => usePlanCheckout(), { wrapper });
    act(() => result.current.mutate({ rail: 'stripe', planKey: 'pro_monthly', autoRenewAck: true, attemptKey: KEY }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(account.checkoutPlan).toHaveBeenCalledWith({ planKey: 'pro_monthly', autoRenewAck: true }, { attemptKey: KEY });
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
  });

  it('the Alipay wrapper gets it too', async () => {
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const { result } = renderHook(() => usePlanCheckout(), { wrapper });
    act(() => result.current.mutate({ rail: 'alipay', planKey: 'pro_week_pass', attemptKey: KEY }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(account.alipayCheckoutPlan).toHaveBeenCalledWith({ planKey: 'pro_week_pass' }, { attemptKey: KEY });
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });
});

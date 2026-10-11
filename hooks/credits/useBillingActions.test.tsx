// The checkout attempt key (ST-2, web half; MARKET_STRATEGY §5.1): a UUID per
// attempt, the same for a repeated request, new when the request changes or
// the attempt is renewed, and handed to the API wrapper beside the body.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const account = vi.hoisted(() => ({ checkoutPlan: vi.fn(), alipayCheckoutPlan: vi.fn(), portal: vi.fn(), resumeSubscription: vi.fn(), switchConfirm: vi.fn() }));
vi.mock('../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));

import { CHECKOUT_ATTEMPT_KEY_PATTERN } from '../../lib/api/account';
import { CREDITS_QUERY_KEY } from '../shared/useCredits';
import { PLANS_QUERY_KEY } from './usePlans';
import { RoboApiError } from '../../lib/api/client';
import { RESUME_NOTHING_CODE, RESUME_REREAD_WAIT_MS, newAttemptKey, useCheckoutAttempt, useConfirmSwitch, usePaymentPortal, usePlanCheckout, useResumeSubscription } from './useBillingActions';

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

  it('a page restored from the back-forward cache starts a new attempt; an ordinary pageshow does not', () => {
    const { result, unmount } = renderHook(() => useCheckoutAttempt());
    const first = result.current.keyFor(body);
    const show = (persisted: boolean) => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      act(() => {
        window.dispatchEvent(event);
      });
    };
    // The first load of a page also fires pageshow, with persisted false.
    show(false);
    expect(result.current.keyFor(body)).toBe(first);
    // Back from the payment page: the browser shows the kept page without mounting it again.
    show(true);
    const second = result.current.keyFor(body);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
    expect(result.current.keyFor(body)).toBe(second);
    // The listener goes with the sheet.
    unmount();
    expect(() => show(true)).not.toThrow();
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

describe('usePaymentPortal / useResumeSubscription / useConfirmSwitch (subscription lifecycle)', () => {
  function setup() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const invalidated = () => invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey)).sort();
    return { wrapper, invalidated };
  }
  // What cancel invalidates: the summary, the plans, the billing plan and the profile.
  const BILLING_KEYS = [JSON.stringify(CREDITS_QUERY_KEY), JSON.stringify(PLANS_QUERY_KEY), JSON.stringify(['account', 'plan']), JSON.stringify(['account', 'profile'])].sort();

  it('the portal with a flow passes it on; without one the wrapper is called with nothing', async () => {
    account.portal.mockResolvedValue({ url: 'https://billing.stripe.test/s' });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePaymentPortal(), { wrapper });
    act(() => result.current.mutate({ flow: 'payment_method_update' }));
    await waitFor(() => expect(account.portal).toHaveBeenCalledTimes(1));
    expect(account.portal).toHaveBeenLastCalledWith({ flow: 'payment_method_update' });
    act(() => result.current.mutate());
    await waitFor(() => expect(account.portal).toHaveBeenCalledTimes(2));
    expect(account.portal).toHaveBeenLastCalledWith();
    act(() => result.current.mutate({}));
    await waitFor(() => expect(account.portal).toHaveBeenCalledTimes(3));
    expect(account.portal).toHaveBeenLastCalledWith();
  });

  it('resume invalidates the same queries as cancel, on success', async () => {
    account.resumeSubscription.mockResolvedValue({ status: 'resumed', planKey: 'pro_monthly', renewsAt: null });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(account.resumeSubscription).toHaveBeenCalledWith();
    expect(invalidated()).toEqual(BILLING_KEYS);
  });

  it('a refused resume reads the state again too (the page was behind the server)', async () => {
    account.resumeSubscription.mockRejectedValue(new Error('nothing_to_resume'));
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidated()).toEqual(BILLING_KEYS);
  });

  // 409 nothing_to_resume covers "the plan ended" and "the plan already renews
  // again". The page words it from the state read after the refusal, so the
  // call does not show its answer before that read has answered.
  describe('409 nothing_to_resume waits for the billing state to be read again', () => {
    const nothing = () => new RoboApiError('failed', { code: RESUME_NOTHING_CODE, status: 409, payload: { success: false, code: RESUME_NOTHING_CODE } });
    function withSummaryQuery(read: () => Promise<unknown>) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      return renderHook(() => ({ summary: useQuery({ queryKey: CREDITS_QUERY_KEY, queryFn: read }), resume: useResumeSubscription() }), { wrapper });
    }

    it('the error is shown only after the summary has answered again', async () => {
      let release: (v: string) => void = () => undefined;
      const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('cancelled');
      account.resumeSubscription.mockRejectedValue(nothing());
      const { result } = withSummaryQuery(read);
      await waitFor(() => expect(result.current.summary.data).toBe('cancelled'));
      read.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
      act(() => result.current.resume.mutate());
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      // Refused by the server, but the state is still being read: no answer yet.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.resume.isPending).toBe(true);
      expect(result.current.resume.isError).toBe(false);
      await act(async () => release('renews'));
      await waitFor(() => expect(result.current.resume.isError).toBe(true));
      expect(result.current.summary.data).toBe('renews');
    });

    it('a state read that fails does not hold the answer back', async () => {
      const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('cancelled').mockRejectedValue(new Error('offline'));
      account.resumeSubscription.mockRejectedValue(nothing());
      const { result } = withSummaryQuery(read);
      await waitFor(() => expect(result.current.summary.data).toBe('cancelled'));
      act(() => result.current.resume.mutate());
      await waitFor(() => expect(result.current.resume.isError).toBe(true));
      expect(read).toHaveBeenCalledTimes(2);
      expect(result.current.summary.data).toBe('cancelled');
    });

    it('a state read that never answers holds it for RESUME_REREAD_WAIT_MS at most', async () => {
      vi.useFakeTimers();
      try {
        const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('cancelled');
        account.resumeSubscription.mockRejectedValue(nothing());
        const { result } = withSummaryQuery(read);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.summary.data).toBe('cancelled');
        read.mockImplementation(() => new Promise<string>(() => undefined));
        act(() => result.current.resume.mutate());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(RESUME_REREAD_WAIT_MS - 1);
        });
        expect(result.current.resume.isPending).toBe(true);
        // The wait ends at RESUME_REREAD_WAIT_MS; one more tick delivers the answer to the hook.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2);
        });
        expect(result.current.resume.isError).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('any other refusal answers at once; the state is read in the background', async () => {
      let release: (v: string) => void = () => undefined;
      const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('cancelled');
      account.resumeSubscription.mockRejectedValue(new RoboApiError('failed', { code: 'payment_provider_error', status: 502, payload: { success: false, code: 'payment_provider_error' } }));
      const { result } = withSummaryQuery(read);
      await waitFor(() => expect(result.current.summary.data).toBe('cancelled'));
      read.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
      act(() => result.current.resume.mutate());
      await waitFor(() => expect(result.current.resume.isError).toBe(true));
      expect(read).toHaveBeenCalledTimes(2);
      expect(result.current.summary.data).toBe('cancelled');
      await act(async () => release('cancelled'));
    });
  });

  it('a switch that needs the bank is an answer, not an error: the state is read again and the plan is whatever the server says', async () => {
    account.switchConfirm.mockResolvedValue({ status: 'requires_action', planKey: 'pro_quarterly', hostedInvoiceUrl: null });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useConfirmSwitch(), { wrapper });
    act(() => result.current.mutate({ quoteId: 'pro_quarterly:1791590400', autoRenewAck: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'requires_action', planKey: 'pro_quarterly', hostedInvoiceUrl: null });
    expect(invalidated()).toEqual(BILLING_KEYS);
  });
});

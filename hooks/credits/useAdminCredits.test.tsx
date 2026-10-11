// hooks/credits/useAdminCredits — the re-reads around an admin refund (MKT-4C;
// MARKET_STRATEGY §4.4 "How a refund is executed"). A refund through Stripe is
// written to our records by Stripe's event, a moment after the refund call
// answers, so the list and the refund check are read again at once and after
// `ADMIN_REFUND_REREAD_DELAYS_MS`, whatever the call answered.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const billing = vi.hoisted(() => ({ issueRefund: vi.fn() }));
vi.mock('../../lib/api/adminBilling', async (orig) => {
  const real = await orig<typeof import('../../lib/api/adminBilling')>();
  return { ...real, adminBillingApi: { ...real.adminBillingApi, ...billing } };
});

import { RoboApiError } from '../../lib/api/client';
import { REFUND_ATTEMPT_KEY_PATTERN } from '../../lib/api/adminBilling';
import { ADMIN_REFUND_REREAD_DELAYS_MS, adminCreditsKeys, useIssueRefund, useRefundAttempts, useRereadUserBilling } from './useAdminCredits';

const BODY = { userId: ' u_42 ', target: { invoiceId: 'in_1PabcDEF2345' }, reason: 'Charged twice', attemptKey: '3f2b8c1e-6a4d-4f0b-9c2e-7d1a5b8e9f00' };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  /** The query keys read again so far, in order. */
  const reads = () => invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  return { client, wrapper, reads };
}
const key = (k: readonly unknown[]) => JSON.stringify(k);
const ONE_READ = [key(adminCreditsKeys.refunds('u_42')), key(adminCreditsKeys.refundQuote('u_42'))];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  billing.issueRefund.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useIssueRefund: the list and the refund check are read again after the refund', () => {
  it('at once, after 3 s and after 10 s, for the user of the refund (trimmed), and then no more', async () => {
    billing.issueRefund.mockResolvedValue({ refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true });
    const { wrapper, reads } = setup();
    const { result } = renderHook(() => useIssueRefund(), { wrapper });
    expect(ADMIN_REFUND_REREAD_DELAYS_MS).toEqual([3000, 10_000]);
    act(() => result.current.mutate(BODY));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reads()).toEqual(ONE_READ);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2900);
    });
    expect(reads()).toEqual(ONE_READ);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(reads()).toEqual([...ONE_READ, ...ONE_READ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(reads()).toEqual([...ONE_READ, ...ONE_READ, ...ONE_READ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(reads()).toHaveLength(6);
  });

  it('the same after a refusal: an unclear failure may be a refund that was made', async () => {
    billing.issueRefund.mockRejectedValue(new RoboApiError('bad gateway', { code: 'payment_provider_error', status: 502 }));
    const { wrapper, reads } = setup();
    const { result } = renderHook(() => useIssueRefund(), { wrapper });
    act(() => result.current.mutate(BODY));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(reads()).toEqual(ONE_READ);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads()).toEqual([...ONE_READ, ...ONE_READ, ...ONE_READ]);
  });

  it('leaving the form with a re-read still due does it then, once, so what is cached about that user is not taken for current', async () => {
    billing.issueRefund.mockResolvedValue({ refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true });
    const { wrapper, reads } = setup();
    const { result, unmount } = renderHook(() => useIssueRefund(), { wrapper });
    act(() => result.current.mutate(BODY));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reads()).toEqual(ONE_READ);
    unmount();
    expect(reads()).toEqual([...ONE_READ, ...ONE_READ]);
    // The timers are gone with the form.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads()).toHaveLength(4);
  });

  it('nothing is read again by mounting or unmounting the hook', () => {
    const { wrapper, reads } = setup();
    const { unmount } = renderHook(() => useIssueRefund(), { wrapper });
    unmount();
    expect(reads()).toEqual([]);
    expect(billing.issueRefund).not.toHaveBeenCalled();
  });
});

describe('useRereadUserBilling', () => {
  it('reads the refund check, the refunds and the mainland orders of that user again, and of no other user', () => {
    const { wrapper, reads } = setup();
    const { result } = renderHook(() => useRereadUserBilling(), { wrapper });
    act(() => result.current('u_42'));
    expect(reads()).toEqual([key(adminCreditsKeys.refundQuote('u_42')), key(adminCreditsKeys.refunds('u_42')), key(adminCreditsKeys.cnOrders('u_42'))]);
    expect(reads().join()).not.toContain('u_7');
  });
});

// A refund call that failed unclearly may have moved the money. Sent again with the same key the server answers
// with the refund already made; with a new key it refunds a second time. So only a completed refund ends a key.
describe('useRefundAttempts: one key per movement of money, kept until that movement is completed', () => {
  const invoice = { invoiceId: 'in_1PabcDEF2345' };
  const ten = { userId: 'u_42', target: invoice, amountMinor: 1000 };

  it('the same user, charge and amount keep their key across uses and re-renders; the key is one the server accepts', () => {
    const { result, rerender } = renderHook(() => useRefundAttempts());
    const first = result.current.keyFor(ten);
    expect(first).toMatch(REFUND_ATTEMPT_KEY_PATTERN);
    rerender();
    expect(result.current.keyFor({ ...ten })).toBe(first);
    // The same user typed with spaces around the id is the same user.
    expect(result.current.keyFor({ ...ten, userId: ' u_42 ' })).toBe(first);
  });

  it('another amount, "everything", another charge or another user is another movement', () => {
    const { result } = renderHook(() => useRefundAttempts());
    const keys = [
      result.current.keyFor(ten),
      result.current.keyFor({ ...ten, amountMinor: 1200 }),
      result.current.keyFor({ ...ten, amountMinor: null }),
      result.current.keyFor({ ...ten, target: { invoiceId: 'in_1PotherCHARGE99' } }),
      // An invoice and a checkout session are different charges even if their ids ever read alike.
      result.current.keyFor({ ...ten, target: { checkoutSessionId: 'in_1PabcDEF2345' } }),
      result.current.keyFor({ ...ten, userId: 'u_7' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a detour keeps every key: back to the first amount is the first key', () => {
    const { result } = renderHook(() => useRefundAttempts());
    const first = result.current.keyFor(ten);
    const other = result.current.keyFor({ ...ten, amountMinor: 1200 });
    expect(result.current.keyFor(ten)).toBe(first);
    expect(result.current.keyFor({ ...ten, amountMinor: 1200 })).toBe(other);
  });

  it('a completed movement gets a new key the next time; the others keep theirs', () => {
    const { result } = renderHook(() => useRefundAttempts());
    const first = result.current.keyFor(ten);
    const other = result.current.keyFor({ ...ten, amountMinor: 1200 });
    result.current.complete(ten);
    const second = result.current.keyFor(ten);
    expect(second).not.toBe(first);
    expect(second).toMatch(REFUND_ATTEMPT_KEY_PATTERN);
    expect(result.current.keyFor({ ...ten, amountMinor: 1200 })).toBe(other);
  });

  it('a page restored from the back-forward cache keeps its keys (unlike a checkout attempt)', () => {
    const { result } = renderHook(() => useRefundAttempts());
    const first = result.current.keyFor(ten);
    const event = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.keyFor(ten)).toBe(first);
  });

  it('each mounted form has its own keys, and the returned object is stable', () => {
    const a = renderHook(() => useRefundAttempts());
    const b = renderHook(() => useRefundAttempts());
    expect(a.result.current.keyFor(ten)).not.toBe(b.result.current.keyFor(ten));
    const before = a.result.current;
    a.rerender();
    expect(a.result.current).toBe(before);
  });
});

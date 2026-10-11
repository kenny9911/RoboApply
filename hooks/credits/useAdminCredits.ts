'use client';

// hooks/credits/useAdminCredits.ts — /admin/credits (WP-21b UI; API WP-21a,
// admin only): the caps override (AppConfig credits.catalog.v1), per-user
// entitlement overrides, the TWD reference rate and the TW revenue monitor.
// Market wave M4 (MKT-4C; server MKT-4B): a user's refund quote, refunds,
// withdrawals and disputes, the refund through Stripe, the manual refund
// record of a mainland order, the practice-session cost and the state of the
// Stripe rail (also read by the admin System panel).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  adminCreateOverride,
  adminDeleteOverride,
  adminGetCreditCatalog,
  adminGetFxReference,
  adminGetTwRevenue,
  adminListOverrides,
  adminPutCreditCatalog,
  adminPutFxReference,
  type CreditOverrideView,
} from '../../lib/api/credits';
import { getRefundQuote, type RefundQuoteResponse } from '../../lib/api/admin';
import {
  adminBillingApi,
  type AdminRefundBody,
  type AdminRefundResult,
  type AdminRefundsPage,
  type CnOrderRow,
  type CnRefundBody,
  type CnRefundResult,
  type PracticeCostResponse,
  type StripeHealth,
} from '../../lib/api/adminBilling';
import type { In, Items, Out } from '../../lib/api/contracts/wire';
import type * as C from '../../lib/api/contracts/credits';
import { shouldRetryCredits } from '../shared/useCredits';
import { newAttemptKey } from './useBillingActions';

export const adminCreditsKeys = {
  all: ['admin', 'credits'] as const,
  catalog: () => ['admin', 'credits', 'catalog'] as const,
  overrides: (userId?: string) => ['admin', 'credits', 'overrides', userId ?? null] as const,
  fx: () => ['admin', 'credits', 'fx'] as const,
  twRevenue: () => ['admin', 'credits', 'twRevenue'] as const,
  // The key the admin console's own refund check uses (hooks/useAdmin.ts `useRefundQuote`): one cache for one fact.
  refundQuote: (userId: string | null) => ['admin', 'console', 'refundQuote', userId] as const,
  refunds: (userId: string | null) => ['admin', 'credits', 'refunds', userId] as const,
  cnOrders: (userId: string | null) => ['admin', 'credits', 'cnOrders', userId] as const,
  practiceCost: () => ['admin', 'credits', 'practiceCost'] as const,
  stripeHealth: () => ['admin', 'credits', 'stripeHealth'] as const,
};

type CatalogOut = Out<typeof C.PutCatalogBodySchema>;
type FxOut = Out<typeof C.PutFxReferenceBodySchema>;

export function useAdminCreditCatalog(): UseQueryResult<CatalogOut> {
  return useQuery<CatalogOut>({
    queryKey: adminCreditsKeys.catalog(),
    queryFn: ({ signal }) => adminGetCreditCatalog({ signal }),
    retry: shouldRetryCredits,
  });
}

export function useSaveCreditCatalog(): UseMutationResult<CatalogOut, Error, In<typeof C.PutCatalogBodySchema>> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof C.PutCatalogBodySchema>) => adminPutCreditCatalog(body),
    onSuccess: (data) => qc.setQueryData(adminCreditsKeys.catalog(), data),
  });
}

export function useAdminOverrides(userId?: string): UseQueryResult<Items<CreditOverrideView>> {
  return useQuery<Items<CreditOverrideView>>({
    queryKey: adminCreditsKeys.overrides(userId),
    queryFn: ({ signal }) => adminListOverrides(userId ? { userId } : undefined, { signal }),
    retry: shouldRetryCredits,
  });
}

export function useCreateOverride(): UseMutationResult<CreditOverrideView, Error, In<typeof C.CreateOverrideBodySchema>> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof C.CreateOverrideBodySchema>) => adminCreateOverride(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'credits', 'overrides'] }),
  });
}

export function useDeleteOverride(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminDeleteOverride(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'credits', 'overrides'] }),
  });
}

export function useAdminFxReference(): UseQueryResult<FxOut | null> {
  return useQuery<FxOut | null>({
    queryKey: adminCreditsKeys.fx(),
    queryFn: ({ signal }) => adminGetFxReference({ signal }),
    retry: shouldRetryCredits,
  });
}

export function useSaveFxReference(): UseMutationResult<FxOut, Error, In<typeof C.PutFxReferenceBodySchema>> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof C.PutFxReferenceBodySchema>) => adminPutFxReference(body),
    onSuccess: (data) => {
      qc.setQueryData(adminCreditsKeys.fx(), data);
      // The plan sheet's TWD line reads the same rate through /billing/plans.
      void qc.invalidateQueries({ queryKey: ['credits', 'plans'] });
    },
  });
}

export function useTwRevenue(): UseQueryResult<C.TwRevenueResponse> {
  return useQuery<C.TwRevenueResponse>({
    queryKey: adminCreditsKeys.twRevenue(),
    queryFn: ({ signal }) => adminGetTwRevenue({ signal }),
    retry: shouldRetryCredits,
  });
}

// ── Refunds (ST-4), the manual mainland record (AL-7) ──────────────────────

/** The published refund rules applied to the user's latest charge (a quote; nothing changes). */
export function useAdminRefundQuote(userId: string | null): UseQueryResult<RefundQuoteResponse> {
  return useQuery<RefundQuoteResponse>({
    queryKey: adminCreditsKeys.refundQuote(userId),
    queryFn: ({ signal }) => getRefundQuote(userId!, { signal }),
    enabled: !!userId,
    retry: false,
  });
}

/** A user's refunds, withdrawals, disputes and manual mainland records, newest first, a page at a time. */
export function useAdminRefunds(userId: string | null): UseInfiniteQueryResult<InfiniteData<AdminRefundsPage, string | null>, Error> {
  return useInfiniteQuery<AdminRefundsPage, Error, InfiniteData<AdminRefundsPage, string | null>, ReturnType<typeof adminCreditsKeys.refunds>, string | null>({
    queryKey: adminCreditsKeys.refunds(userId),
    queryFn: ({ pageParam, signal }) => adminBillingApi.listRefunds(userId!, pageParam, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled: !!userId,
    retry: shouldRetryCredits,
  });
}

/**
 * Read everything the console shows about one user again: the refund check,
 * the refunds and the mainland orders. For "Show" pressed on the user already
 * on screen and for the list's own Refresh button: the forms keep what was
 * typed (and a refund its attempt key), only the facts are read again.
 */
export function useRereadUserBilling(): (userId: string) => void {
  const qc = useQueryClient();
  return useCallback(
    (userId: string) => {
      void qc.invalidateQueries({ queryKey: adminCreditsKeys.refundQuote(userId) });
      void qc.invalidateQueries({ queryKey: adminCreditsKeys.refunds(userId) });
      void qc.invalidateQueries({ queryKey: adminCreditsKeys.cnOrders(userId) });
    },
    [qc],
  );
}

/** What one refund moves: whose money, on which charge, how much (null: everything that can still be refunded). */
export interface RefundMovement {
  userId: string;
  target: AdminRefundBody['target'];
  amountMinor: number | null;
}

export interface RefundAttempts {
  /** The attempt key of this movement: made on first use, the same on every later use until `complete`. */
  keyFor: (movement: RefundMovement) => string;
  /** The movement was refunded: the next refund of the same amount on the same charge is a new decision. */
  complete: (movement: RefundMovement) => void;
}

/**
 * The attempt keys of one refund form (MARKET_STRATEGY §5.1 "Refunds and
 * disputes"; waveM2-carryover MKT-4C.2b). A key names ONE movement of money:
 * this user, this charge, this amount. It is kept until that movement is
 * completed, because a refund call that failed unclearly (the answer was
 * lost) may have moved the money: sent again with the same key, the server
 * answers with the refund already made; sent with a new key, it refunds a
 * second time. So nothing but a completed refund ends a key:
 *
 *   - not a retry, and not a reworded reason (the reason says why, not what
 *     money moves);
 *   - not a detour: try 10.00, try 12.00, go back to 10.00, and 10.00 still
 *     carries its first key;
 *   - not a page restored from the browser's back-forward cache.
 *
 * After `complete` the same movement gets a new key, so two equal partial
 * refunds of one payment are two refunds. The keys live with the mounted
 * form: another user, or a reload, starts with none.
 */
export function useRefundAttempts(): RefundAttempts {
  const keys = useRef(new Map<string, string>());
  const idOf = (m: RefundMovement) => JSON.stringify([m.userId.trim(), 'invoiceId' in m.target ? ['invoice', m.target.invoiceId] : ['session', m.target.checkoutSessionId], m.amountMinor]);
  const keyFor = useCallback((movement: RefundMovement) => {
    const id = idOf(movement);
    let key = keys.current.get(id);
    if (!key) {
      key = newAttemptKey();
      keys.current.set(id, key);
    }
    return key;
  }, []);
  const complete = useCallback((movement: RefundMovement) => {
    keys.current.delete(idOf(movement));
  }, []);
  return useMemo(() => ({ keyFor, complete }), [keyFor, complete]);
}

/**
 * A refund through Stripe is written to our records by the payment provider's
 * notice, a moment AFTER the refund call answers. So the list and the refund
 * check are read again when the call settles and then after these delays:
 * the row of the refund just made then shows by itself, and after an unclear
 * failure "check the list before you try again" has a list that can answer.
 */
export const ADMIN_REFUND_REREAD_DELAYS_MS: readonly number[] = [3000, 10_000];

/**
 * Refund a charge through Stripe. Access does not change here: the payment
 * provider's event does that, so only the list of refunds and the quote are
 * read again (also after a refusal: the page may be behind the server), at
 * once and after `ADMIN_REFUND_REREAD_DELAYS_MS`.
 */
export function useIssueRefund(): UseMutationResult<AdminRefundResult, Error, AdminRefundBody> {
  const qc = useQueryClient();
  const pending = useRef<Array<{ timer: ReturnType<typeof setTimeout>; userId: string }>>([]);
  const invalidate = useCallback(
    (userId: string) => {
      void qc.invalidateQueries({ queryKey: adminCreditsKeys.refunds(userId) });
      void qc.invalidateQueries({ queryKey: adminCreditsKeys.refundQuote(userId) });
    },
    [qc],
  );
  // Leaving the form (another user, another page) with a re-read still due: do it now, so what is cached about that
  // user is not taken for current when staff come back to it.
  useEffect(
    () => () => {
      const due = pending.current;
      pending.current = [];
      for (const { timer } of due) clearTimeout(timer);
      for (const userId of new Set(due.map((d) => d.userId))) invalidate(userId);
    },
    [invalidate],
  );
  const reread = (userId: string) => {
    invalidate(userId);
    for (const ms of ADMIN_REFUND_REREAD_DELAYS_MS) {
      const entry = {
        userId,
        timer: setTimeout(() => {
          pending.current = pending.current.filter((p) => p !== entry);
          invalidate(userId);
        }, ms),
      };
      pending.current.push(entry);
    }
  };
  return useMutation({
    mutationFn: (body: AdminRefundBody) => adminBillingApi.issueRefund(body),
    onSuccess: (_res, body) => reread(body.userId.trim()),
    onError: (_err, body) => reread(body.userId.trim()),
  });
}

/** A user's completed mainland orders with their refund marker. */
export function useCnOrders(userId: string | null): UseQueryResult<{ items: CnOrderRow[] }> {
  return useQuery<{ items: CnOrderRow[] }>({
    queryKey: adminCreditsKeys.cnOrders(userId),
    queryFn: ({ signal }) => adminBillingApi.listCnOrders(userId!, { signal }),
    enabled: !!userId,
    retry: shouldRetryCredits,
  });
}

export interface RecordCnRefundVars extends CnRefundBody {
  userId: string;
  orderId: string;
}

/** Record that a mainland order's money was returned by hand. The orders and the refunds are read again either way. */
export function useRecordCnRefund(): UseMutationResult<CnRefundResult, Error, RecordCnRefundVars> {
  const qc = useQueryClient();
  const reread = (userId: string) => {
    void qc.invalidateQueries({ queryKey: adminCreditsKeys.cnOrders(userId) });
    void qc.invalidateQueries({ queryKey: adminCreditsKeys.refunds(userId) });
    void qc.invalidateQueries({ queryKey: adminCreditsKeys.refundQuote(userId) });
  };
  return useMutation({
    mutationFn: ({ userId: _userId, orderId, ...body }: RecordCnRefundVars) => adminBillingApi.recordCnRefund(orderId, body),
    onSuccess: (_res, v) => reread(v.userId),
    onError: (_err, v) => reread(v.userId),
  });
}

// ── Practice-session cost (PC-5) and the Stripe rail (ST-3) ────────────────

export function usePracticeCost(): UseQueryResult<PracticeCostResponse> {
  return useQuery<PracticeCostResponse>({
    queryKey: adminCreditsKeys.practiceCost(),
    queryFn: ({ signal }) => adminBillingApi.practiceCost({ signal }),
    retry: shouldRetryCredits,
  });
}

/** Key mode, guard, webhook secrets and the events the webhook endpoint does not send. Never a secret. */
export function useStripeHealth(options: { enabled?: boolean } = {}): UseQueryResult<StripeHealth> {
  return useQuery<StripeHealth>({
    queryKey: adminCreditsKeys.stripeHealth(),
    queryFn: ({ signal }) => adminBillingApi.stripeHealth({ signal }),
    retry: shouldRetryCredits,
    enabled: options.enabled ?? true,
  });
}

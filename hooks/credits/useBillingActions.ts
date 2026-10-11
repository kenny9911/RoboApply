'use client';

// hooks/credits/useBillingActions.ts — the billing mutations behind the plan
// sheet, the quote sheet and the cancel button (WP-21b; server WP-21a).
//
//   useCancelSubscription()  POST /credits/cancel — one click, no survey first
//   useCancelSurvey()        POST /credits/cancel/survey — the optional reason, after
//                            the cancel; never the cancel endpoint again
//   usePlanCheckout()        POST /billing/checkout | /billing/alipay {planKey, acks}
//                            → the contract's CheckoutResponse (`kind`: redirect | qr | jsapi)
//                            with the attempt key as the `Idempotency-Key` header
//   useCheckoutAttempt()     one key per checkout attempt (a UUID): the same
//                            key for a double click, a new one whenever the
//                            request changes, after a failed call and each
//                            time the plan sheet opens
//   useSwitchQuote()         POST /billing/switch without `confirm` (nothing charged)
//   useConfirmSwitch()       POST /billing/switch with `confirm` (charges now)
//
// Every success invalidates the credit summary and the legacy plan so the
// page shows the server's new state (never an optimistic plan change).

import { useCallback, useMemo, useRef } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import {
  accountApi,
  type PlanCheckoutBody,
  type PlanCheckoutResponse,
  type SwitchConfirmBody,
  type SwitchConfirmResponse,
  type SwitchQuote,
  type SwitchQuoteBody,
} from '../../lib/api/account';
import { cancelSubscription, sendCancelSurvey } from '../../lib/api/credits';
import type { CancelResponse, CancelSurveyReason } from '../../lib/api/contracts/credits';
import { CREDITS_QUERY_KEY } from '../shared/useCredits';
import { PLANS_QUERY_KEY } from './usePlans';

function useInvalidateBilling(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: PLANS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ['account', 'plan'] });
    void qc.invalidateQueries({ queryKey: ['account', 'profile'] });
  };
}

export function useCancelSubscription(): UseMutationResult<CancelResponse, Error, void> {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => cancelSubscription({}),
    onSuccess: invalidate,
  });
}

export interface CancelSurveyVars {
  reason?: CancelSurveyReason;
  note?: string;
}

/**
 * The optional "why did you cancel?" answer, sent after the cancel completed.
 * It goes to its own record-only endpoint, never back through the cancel call.
 */
export function useCancelSurvey(): UseMutationResult<void, Error, CancelSurveyVars> {
  return useMutation({
    mutationFn: (v: CancelSurveyVars) => sendCancelSurvey({ reason: v.reason, note: v.note?.trim() || undefined }),
  });
}

export interface PlanCheckoutVars extends PlanCheckoutBody {
  rail: 'stripe' | 'alipay';
  /** This attempt's key (`useCheckoutAttempt`), sent as the `Idempotency-Key` header. */
  attemptKey: string;
}

export function usePlanCheckout(): UseMutationResult<PlanCheckoutResponse, Error, PlanCheckoutVars> {
  return useMutation({
    mutationFn: ({ rail, attemptKey, ...body }: PlanCheckoutVars) =>
      rail === 'alipay' ? accountApi.alipayCheckoutPlan(body, { attemptKey }) : accountApi.checkoutPlan(body, { attemptKey }),
  });
}

/**
 * A new attempt key: a version 4 UUID. `crypto.randomUUID` exists only in a
 * secure context, so a page served over plain HTTP on a LAN address builds
 * the same shape from `getRandomValues`; with no Web Crypto at all it falls
 * back to `Math.random` (the key separates one buyer's own attempts, the
 * server adds the user and the plan: it is not a secret).
 */
export function newAttemptKey(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export interface CheckoutAttempt {
  /**
   * The key for a request with this content. The same content keeps the key
   * (a double click sends one key); different content gets a new one, because
   * the payment provider refuses a repeated key with different parameters.
   */
  keyFor: (content: unknown) => string;
  /** Start a new attempt: the next request gets a new key. */
  renew: () => void;
}

/**
 * One checkout attempt per mounted plan sheet (MARKET_STRATEGY §5.1
 * "Idempotency keys"). The key is made when the sheet mounts, so reopening
 * the sheet is a new attempt; the sheet calls `renew` when the buyer changes
 * the plan or an acknowledgement box, and after a checkout call fails.
 */
export function useCheckoutAttempt(): CheckoutAttempt {
  const state = useRef<{ key: string; content: string | null } | null>(null);
  if (state.current === null) state.current = { key: newAttemptKey(), content: null };
  const renew = useCallback(() => {
    state.current = { key: newAttemptKey(), content: null };
  }, []);
  const keyFor = useCallback((content: unknown) => {
    const serialised = JSON.stringify(content ?? null);
    const current = state.current!;
    if (current.content !== null && current.content !== serialised) {
      state.current = { key: newAttemptKey(), content: serialised };
      return state.current.key;
    }
    current.content = serialised;
    return current.key;
  }, []);
  return useMemo(() => ({ keyFor, renew }), [keyFor, renew]);
}

/**
 * The page to send the browser to after checkout, or null when this answer
 * is not a redirect. Only `kind: 'redirect'` carries a page address; a `qr`
 * answer's `qrCodeUrl` is the content of a payment code (a `weixin://` link),
 * never somewhere to navigate or an image to load.
 */
export function checkoutRedirectUrl(res: PlanCheckoutResponse | null | undefined): string | null {
  if (!res || res.kind !== 'redirect') return null;
  return typeof res.url === 'string' && /^https?:\/\//i.test(res.url) ? res.url : null;
}

export function useSwitchQuote(): UseMutationResult<SwitchQuote, Error, SwitchQuoteBody> {
  return useMutation({ mutationFn: (body: SwitchQuoteBody) => accountApi.switchQuote(body) });
}

export function useConfirmSwitch(): UseMutationResult<SwitchConfirmResponse, Error, SwitchConfirmBody> {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (body: SwitchConfirmBody) => accountApi.switchConfirm(body),
    onSuccess: invalidate,
  });
}

export function usePaymentPortal(): UseMutationResult<{ url: string }, Error, void> {
  return useMutation({ mutationFn: () => accountApi.portal() });
}

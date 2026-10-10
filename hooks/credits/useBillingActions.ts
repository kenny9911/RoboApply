'use client';

// hooks/credits/useBillingActions.ts — the billing mutations behind the plan
// sheet, the quote sheet and the cancel button (WP-21b; server WP-21a).
//
//   useCancelSubscription()  POST /credits/cancel — one click, no survey first
//   useCancelSurvey()        POST /credits/cancel/survey — the optional reason, after
//                            the cancel; never the cancel endpoint again
//   usePlanCheckout()        POST /billing/checkout | /billing/alipay {planKey, acks}
//                            → the contract's CheckoutResponse (`kind`: redirect | qr | jsapi)
//   useSwitchQuote()         POST /billing/switch without `confirm` (nothing charged)
//   useConfirmSwitch()       POST /billing/switch with `confirm` (charges now)
//
// Every success invalidates the credit summary and the legacy plan so the
// page shows the server's new state (never an optimistic plan change).

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
}

export function usePlanCheckout(): UseMutationResult<PlanCheckoutResponse, Error, PlanCheckoutVars> {
  return useMutation({
    mutationFn: ({ rail, ...body }: PlanCheckoutVars) =>
      rail === 'alipay' ? accountApi.alipayCheckoutPlan(body) : accountApi.checkoutPlan(body),
  });
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

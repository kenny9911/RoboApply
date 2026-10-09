'use client';

// hooks/credits/usePublicCancel.ts — the /cancel page without signing in
// (PRODUCT F-BILL-03; §312k BGB): email → one-time link (30 min) → confirm.
//
// The request step always "succeeds" from the visitor's point of view: the
// server answers 204 whether or not the email has a subscription, so the page
// never reveals who is a customer.

import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { confirmPublicCancel, requestPublicCancel } from '../../lib/api/credits';
import type { CancelResponse } from '../../lib/api/contracts/credits';

export function useRequestCancelLink(): UseMutationResult<void, Error, { email: string }> {
  return useMutation({ mutationFn: (body: { email: string }) => requestPublicCancel({ email: body.email.trim().toLowerCase() }) });
}

export function useConfirmPublicCancel(): UseMutationResult<CancelResponse, Error, { token: string }> {
  return useMutation({ mutationFn: (body: { token: string }) => confirmPublicCancel(body) });
}

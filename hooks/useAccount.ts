'use client';

// hooks/useAccount.ts
//
// TanStack Query bindings for the /account page (profile · billing · usage ·
// security · danger zone). All calls route through `accountApi` (lib/api/
// account.ts). Query keys namespaced `['account', …]`. Mirrors the
// hooks/useActivity.ts style: small surface, queries + mutations, invalidate
// the affected keys on success.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { accountApi } from '../lib/api/account';
import type {
  AccountProfile,
  AccountUsageParams,
  AccountUsageResponse,
  BillingHistoryResponse,
  BillingPlanResponse,
  CancelPlanResponse,
  ChangePasswordBody,
  CreditsResponse,
  DeleteAccountResponse,
  PurchasableTier,
  SignOutAllResponse,
  StripeRedirect,
  UpdateNameResponse,
} from '../lib/api/account';

// ─────────────────────────────────────────────────────────────────────
// Query keys
// ─────────────────────────────────────────────────────────────────────

export const accountKeys = {
  all: ['account'] as const,
  profile: () => ['account', 'profile'] as const,
  plan: (region?: string | null) => ['account', 'plan', region ?? null] as const,
  credits: () => ['account', 'credits'] as const,
  history: () => ['account', 'billing', 'history'] as const,
  usage: (params?: AccountUsageParams) =>
    ['account', 'usage', params?.from ?? null, params?.to ?? null, params?.tz ?? null] as const,
};

// ─────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────

export function useAccountProfile(): UseQueryResult<AccountProfile, Error> {
  return useQuery({
    queryKey: accountKeys.profile(),
    queryFn: () => accountApi.profile(),
  });
}

export function useBillingPlan(region?: 'cn' | 'other' | null): UseQueryResult<BillingPlanResponse, Error> {
  return useQuery({
    queryKey: accountKeys.plan(region),
    queryFn: () => accountApi.plan(region ?? undefined),
  });
}

export function useCredits(): UseQueryResult<CreditsResponse, Error> {
  return useQuery({
    queryKey: accountKeys.credits(),
    queryFn: () => accountApi.credits(),
  });
}

export function useBillingHistory(): UseQueryResult<BillingHistoryResponse, Error> {
  return useQuery({
    queryKey: accountKeys.history(),
    queryFn: () => accountApi.history(),
  });
}

export function useAccountUsage(
  params?: AccountUsageParams,
): UseQueryResult<AccountUsageResponse, Error> {
  return useQuery({
    queryKey: accountKeys.usage(params),
    queryFn: () => accountApi.usage(params),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────

export function useUpdateName(): UseMutationResult<UpdateNameResponse, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => accountApi.updateName(name),
    onSuccess: (res) => {
      // Optimistically patch the cached profile so the header updates without
      // a refetch round-trip.
      qc.setQueryData<AccountProfile>(accountKeys.profile(), (prev) =>
        prev ? { ...prev, name: res.name } : prev,
      );
    },
  });
}

export function useChangePassword(): UseMutationResult<
  { ok: true },
  Error,
  ChangePasswordBody
> {
  return useMutation({
    mutationFn: (body: ChangePasswordBody) => accountApi.changePassword(body),
  });
}

export function useSignOutAll(): UseMutationResult<SignOutAllResponse, Error, void> {
  return useMutation({
    mutationFn: () => accountApi.signOutAll(),
  });
}

export function useDeleteAccount(): UseMutationResult<
  DeleteAccountResponse,
  Error,
  string
> {
  return useMutation({
    mutationFn: (confirmEmail: string) => accountApi.deleteAccount(confirmEmail),
  });
}

export interface CheckoutVars {
  tier: PurchasableTier;
  /** Same-origin relative path to return to after a SUCCESSFUL payment. */
  next?: string;
  /** Same-origin relative path to return to if the user CANCELS Stripe checkout.
   *  Omit to keep the signup default (/choose-plan). In-app /plans passes /plans
   *  so a cancelled upgrade returns to the page it started on. */
  cancelNext?: string;
}

export function useCheckout(): UseMutationResult<StripeRedirect, Error, CheckoutVars> {
  return useMutation({
    mutationFn: (v: CheckoutVars) => accountApi.checkout(v.tier, v.next, v.cancelNext),
  });
}

export function useAlipayCheckout(): UseMutationResult<StripeRedirect, Error, CheckoutVars> {
  return useMutation({
    mutationFn: (v: CheckoutVars) => accountApi.alipayCheckout(v.tier, v.next),
  });
}

export function usePortal(): UseMutationResult<StripeRedirect, Error, void> {
  return useMutation({
    mutationFn: () => accountApi.portal(),
  });
}

export function useCancelPlan(): UseMutationResult<CancelPlanResponse, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => accountApi.cancel(),
    onSuccess: () => {
      // Prefix match → invalidates every region variant (['account','plan',*]).
      qc.invalidateQueries({ queryKey: ['account', 'plan'] });
      qc.invalidateQueries({ queryKey: accountKeys.credits() });
      qc.invalidateQueries({ queryKey: accountKeys.profile() });
    },
  });
}

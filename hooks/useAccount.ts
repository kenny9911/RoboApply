'use client';

// hooks/useAccount.ts
//
// TanStack Query bindings for the account API (profile · plan · practice
// credits · invoices · security · danger zone). All calls route through
// `accountApi` (lib/api/account.ts). Query keys namespaced `['account', …]`.
//
// The legacy checkout hooks (useCheckout, useAlipayCheckout, usePortal,
// useCancelPlan) were deleted by INT-12: checkout, the billing portal and
// cancel live in hooks/credits (usePlanCheckout, useBillingActions,
// useCancelSubscription; WP-21b). `useBillingPlan` stays: PlanBadge,
// QuarterlySuggestion and useSubscriptionState read it.

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
  ChangePasswordBody,
  CreditsResponse,
  DeleteAccountResponse,
  SignOutAllResponse,
  UpdateNameResponse,
  WipeDataResponse,
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

export function useBillingPlan(
  region?: 'cn' | 'other' | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<BillingPlanResponse, Error> {
  return useQuery({
    queryKey: accountKeys.plan(region),
    queryFn: () => accountApi.plan(region ?? undefined),
    enabled: options.enabled ?? true,
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

/** Clear application data only (match history / queue / activity / pipeline).
 *  The account + résumés survive and the user stays signed in, so on success we
 *  just invalidate every V2/V3 data cache (tracker, matches, activity, queue,
 *  pipeline board, …) so the now-empty state repaints — no sign-out/redirect. */
export function useWipeData(): UseMutationResult<WipeDataResponse, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => accountApi.wipeData(),
    onSuccess: () => {
      // Prefix-invalidate the two RoboApply candidate namespaces — covers
      // ['v2','tracker'|'home'], ['v3','today'|'activity'|'queue'|'pipeline'].
      qc.invalidateQueries({ queryKey: ['v2'] });
      qc.invalidateQueries({ queryKey: ['v3'] });
    },
  });
}

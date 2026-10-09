'use client';

// hooks/credits/useAdminCredits.ts — /admin/credits (WP-21b UI; API WP-21a,
// admin only): the caps override (AppConfig credits.catalog.v1), per-user
// entitlement overrides, the TWD reference rate and the TW revenue monitor.

import {
  useMutation,
  useQuery,
  useQueryClient,
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
import type { In, Items, Out } from '../../lib/api/contracts/wire';
import type * as C from '../../lib/api/contracts/credits';
import { shouldRetryCredits } from '../shared/useCredits';

export const adminCreditsKeys = {
  all: ['admin', 'credits'] as const,
  catalog: () => ['admin', 'credits', 'catalog'] as const,
  overrides: (userId?: string) => ['admin', 'credits', 'overrides', userId ?? null] as const,
  fx: () => ['admin', 'credits', 'fx'] as const,
  twRevenue: () => ['admin', 'credits', 'twRevenue'] as const,
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

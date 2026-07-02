'use client';

// hooks/useIntegrations.ts
//
// TanStack Query bindings for the V3 Integrations surface (Route 10 §
// Integrations). All calls route through `raV2Api.integrations.*`. Query keys
// namespaced `['v3', 'integrations', …]`.
//
// Surface:
//   - useIntegrations()              GET  integrations.list
//   - useConnectIntegration()        POST integrations.connect (flips on)
//   - useDisconnectIntegration()     POST integrations.disconnect (flips off)

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  IntegrationResponse,
  IntegrationsListResponse,
  RAIntegrationProvider,
} from '../lib/api/v2';

export const integrationKeys = {
  all: ['v3', 'integrations'] as const,
  list: () => ['v3', 'integrations', 'list'] as const,
};

export function useIntegrations(): UseQueryResult<
  IntegrationsListResponse,
  Error
> {
  return useQuery({
    queryKey: integrationKeys.list(),
    queryFn: () => raV2Api.integrations.list(),
  });
}

export function useConnectIntegration(): UseMutationResult<
  IntegrationResponse,
  Error,
  RAIntegrationProvider
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: RAIntegrationProvider) =>
      raV2Api.integrations.connect(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });
}

export function useDisconnectIntegration(): UseMutationResult<
  IntegrationResponse,
  Error,
  RAIntegrationProvider
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: RAIntegrationProvider) =>
      raV2Api.integrations.disconnect(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });
}

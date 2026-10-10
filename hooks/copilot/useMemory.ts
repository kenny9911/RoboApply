'use client';

// hooks/copilot/useMemory.ts — what the Assistant remembers (WP-51;
// F-ORION-09 cn "long-term memory with explicit consent" + delete).
//
// Memory facts are stored only after the user confirms a `memory_add` card
// (a proposal). On GoApply nothing is stored without the `copilot_memory`
// consent (PIPL; ARCHITECTURE.md §5.3): `useMemoryConsent()` says whether it
// is needed and granted, and `grant()` records it with the exact prose
// version the user was shown. RoboApply does not need the consent.

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { deleteMemory, listMemory } from '../../lib/api/copilot';
import { getConsents, recordConsent } from '../../lib/api/compliance';
import type { ConsentCatalogItem } from '../../lib/api/contracts/compliance';
import type { MemoryFactView } from '../../lib/api/contracts/copilot';
import type { Items } from '../../lib/api/contracts/wire';
import { useBrand } from '../../lib/brand';
import { consentsKey, copilotKeys } from './keys';

export const MEMORY_CONSENT_TYPE = 'copilot_memory';

export function useMemory(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: copilotKeys.memory(),
    queryFn: ({ signal }) => listMemory({ signal }),
    enabled: options.enabled ?? true,
    retry: false,
    select: (data: Items<MemoryFactView>) => data.items,
  });
}

/** Delete one remembered fact (optimistic). */
export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: copilotKeys.memory() });
      const prev = qc.getQueryData<Items<MemoryFactView>>(copilotKeys.memory());
      if (prev) qc.setQueryData<Items<MemoryFactView>>(copilotKeys.memory(), { ...prev, items: prev.items.filter((f) => f.id !== id) });
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(copilotKeys.memory(), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: copilotKeys.memory() }),
  });
}

export interface MemoryConsent {
  /** True on GoApply: memory needs the `copilot_memory` consent. */
  required: boolean;
  /** The consent's catalog row (exact prose + version), when loaded. */
  item: ConsentCatalogItem | null;
  /** Granted now (always true where not required). Null while unknown. */
  granted: boolean | null;
  loading: boolean;
  error: boolean;
  saving: boolean;
  /** Record the user's answer with the prose version they saw. Resolves true on success. */
  set: (granted: boolean) => Promise<boolean>;
}

export function useMemoryConsent(): MemoryConsent {
  const brand = useBrand();
  const locale = useLocale();
  const qc = useQueryClient();
  const required = brand.market === 'cn';

  const consents = useQuery({
    queryKey: consentsKey(locale),
    queryFn: ({ signal }) => getConsents({ locale }, { signal }),
    enabled: required,
    retry: false,
  });
  const item = consents.data?.items.find((c) => c.type === MEMORY_CONSENT_TYPE) ?? null;

  const save = useMutation({
    mutationFn: (granted: boolean) => {
      if (!item) return Promise.reject(new Error('consent_unavailable'));
      return recordConsent({ type: item.type, granted, proseVersion: item.proseVersion, locale });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['compliance', 'consents'] }),
  });

  const set = useCallback(
    async (granted: boolean) => {
      try {
        await save.mutateAsync(granted);
        return true;
      } catch {
        return false;
      }
    },
    [save],
  );

  if (!required) {
    return { required: false, item: null, granted: true, loading: false, error: false, saving: false, set: async () => true };
  }
  return {
    required: true,
    item,
    granted: item ? item.granted === true : null,
    loading: consents.isLoading,
    error: consents.isError || (consents.isSuccess && !item),
    saving: save.isPending,
    set,
  };
}

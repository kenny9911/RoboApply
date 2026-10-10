'use client';

// hooks/extension/useSensitiveFillConsent.ts — the in-context
// `autofill_sensitive` consent (WP-13 catalog): only with it does the
// extension receive the stored equal-opportunity / GoApply sensitive answers.
// The prose, its version and the current state come from the compliance API;
// the box starts unticked unless the user granted it before.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getConsents, recordConsent } from '../../lib/api/compliance';
import type { ConsentCatalogItem } from '../../lib/api/contracts/compliance';

export const SENSITIVE_FILL_CONSENT = 'autofill_sensitive';
const KEY = ['extension', 'consent', SENSITIVE_FILL_CONSENT] as const;

export function useSensitiveFillConsent(options: { enabled?: boolean; locale?: string } = {}) {
  const qc = useQueryClient();
  const query = useQuery<ConsentCatalogItem | null>({
    queryKey: [...KEY, options.locale ?? null],
    queryFn: async ({ signal }) => {
      const res = await getConsents(options.locale ? { locale: options.locale } : undefined, { signal });
      return res.items.find((i) => i.type === SENSITIVE_FILL_CONSENT) ?? null;
    },
    staleTime: 5 * 60_000,
    retry: false,
    enabled: options.enabled ?? true,
  });
  const save = useMutation({
    mutationFn: async (granted: boolean) => {
      const item = query.data;
      if (!item) throw new Error('consent not loaded');
      return recordConsent({ type: item.type, granted, proseVersion: item.proseVersion, ...(options.locale ? { locale: options.locale } : {}) });
    },
    onSuccess: (res) => {
      qc.setQueryData<ConsentCatalogItem | null>([...KEY, options.locale ?? null], (prev) => (prev ? { ...prev, granted: res.granted, answeredAt: res.at } : prev));
    },
  });
  return { item: query.data ?? null, isLoading: query.isLoading, save };
}

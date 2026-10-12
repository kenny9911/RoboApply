'use client';

// hooks/copilot/useThreads.ts — the saved Assistant chats (WP-51; F-ORION-01
// "threads persisted", which Jobright does not have).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { archiveThread, listThreads } from '../../lib/api/copilot';
import type { ThreadView } from '../../lib/api/contracts/copilot';
import type { Items } from '../../lib/api/contracts/wire';
import { copilotKeys } from './keys';

export function useThreads(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: copilotKeys.threads(),
    queryFn: ({ signal }) => listThreads({ signal }),
    enabled: options.enabled ?? true,
    retry: false,
    staleTime: 30_000,
    select: (data: Items<ThreadView>) => [...data.items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
  });
}

/** Remove (archive) a chat. The list drops it at once and comes back on failure. */
export function useArchiveThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveThread(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: copilotKeys.threads() });
      const prev = qc.getQueryData<Items<ThreadView>>(copilotKeys.threads());
      if (prev) qc.setQueryData<Items<ThreadView>>(copilotKeys.threads(), { ...prev, items: prev.items.filter((t) => t.id !== id) });
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(copilotKeys.threads(), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: copilotKeys.threads() }),
  });
}

'use client';

// hooks/useCrossBankDiscover.ts
//
// TanStack Query wrapper around `raV2Api.discover.run` — the cross-bank
// job-search agent team (searches the RoboHire + GoHire banks). Because a run
// also materializes matched jobs into the candidate's RAJob index, a successful
// run invalidates the home + search feeds so the freshly-ingested jobs appear
// there too.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type { DiscoverRunBody, CrossBankDiscoverResponse } from '../lib/api/v2';

/** Run one cross-bank discovery round. Mutation (it has DB side effects +
 *  real LLM cost); the caller renders result.recommended / result.explore. */
export function useCrossBankDiscover() {
  const qc = useQueryClient();
  return useMutation<CrossBankDiscoverResponse, Error, DiscoverRunBody | void>({
    mutationFn: (body) => raV2Api.discover.run(body ?? undefined),
    onSuccess: () => {
      // Newly materialized RAJob rows now live in the shared feed.
      void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'search'] });
    },
  });
}

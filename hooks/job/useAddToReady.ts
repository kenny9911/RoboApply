'use client';

// hooks/job/useAddToReady.ts — "Add to Ready to apply" from the job page
// (PRODUCT F-JOB-03/06; flag `agent`). Adds the job to the user's list; the
// kit is prepared there and the user opens the application themselves (D1).

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { addToQueue } from '../../lib/api/agent';
import { apiErrorCode } from '../../lib/api/contracts/wire';

export type AddToReadyStatus = 'idle' | 'adding' | 'added' | 'full' | 'error';

export function useAddToReady(jobId: string): { status: AddToReadyStatus; add: () => Promise<void> } {
  const client = useQueryClient();
  const [status, setStatus] = useState<AddToReadyStatus>('idle');
  const add = useCallback(async () => {
    setStatus('adding');
    try {
      await addToQueue({ jobIds: [jobId], addedVia: 'manual' });
      setStatus('added');
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'agent' || q.queryKey[0] === 'job' });
    } catch (err) {
      setStatus(apiErrorCode(err) === 'conflict' ? 'full' : 'error');
    }
  }, [client, jobId]);
  return { status, add };
}

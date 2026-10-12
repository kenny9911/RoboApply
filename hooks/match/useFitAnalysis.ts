'use client';

// hooks/match/useFitAnalysis.ts — the structured fit analysis
// (`POST /match/jobs/:id/fit-analysis`; credit `fit_analysis`; F-ORION-03).
//
// Runs through the shared credit gate: one idempotency key per run (a network
// retry never charges twice), the out-of-credits sheet on `402`, and the
// credit summary refetched afterwards. The server spends a credit only when a
// model call is needed (`card.charged`); a cached AI score is rebuilt free.
//
// The card is the job's one fit (the person's main resume): the request
// carries no resume version.

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { getFitAnalysis } from '../../lib/api/match';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { FitAnalysisCard } from '../../lib/api/contracts/match';
import { useCreditGate, type CreditGate } from '../shared/useCreditGate';
import { jobFitKey } from './useJobFit';

export type FitAnalysisStatus = 'idle' | 'running' | 'done' | 'out_of_credits' | 'unavailable' | 'error';

export interface UseFitAnalysis {
  card: FitAnalysisCard | null;
  status: FitAnalysisStatus;
  gate: CreditGate;
  run: () => Promise<void>;
}

/** The fit analysis is always for the main resume: the hook takes no resume version, and the server refuses a request that names one (422). */
export function useFitAnalysis(jobId: string): UseFitAnalysis {
  const gate = useCreditGate('fit_analysis');
  const client = useQueryClient();
  const [card, setCard] = useState<FitAnalysisCard | null>(null);
  const [status, setStatus] = useState<FitAnalysisStatus>('idle');

  const run = useCallback(async () => {
    setStatus('running');
    try {
      const result = await gate.run((idempotencyKey) =>
        getFitAnalysis(jobId, {}, { idempotencyKey }),
      );
      if (!result.ok) {
        setStatus('out_of_credits');
        return;
      }
      setCard(result.value);
      setStatus('done');
      // The analysis may have produced the AI score: refresh the job's fit.
      void client.invalidateQueries({ queryKey: jobFitKey(jobId) });
    } catch (err) {
      setStatus(apiErrorCode(err) === 'ai_unavailable' ? 'unavailable' : 'error');
    }
  }, [client, gate, jobId]);

  return { card, status, gate, run };
}

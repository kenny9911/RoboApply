// backend/src/lib/deductionCost.ts
//
// Bridges the always-on LoggerService cost tally → a UsageDeductionLog row's
// cost fields. RoboApply feature debits (resume tailor, cover letter, match
// score, insight, JD parse, onboarding, keyword/score/weekly crons) call this
// just before `writeDeductionLog` so each row carries a REAL platform cost
// derived from the actual LLM token usage of that request — replacing the
// flat "~$0.0x/call" SKU-comment estimates.
//
// HTTP routes: the requestId is already in AsyncLocalStorage (getCurrentRequestId).
// Cron units: wrap each unit in `runWithRequestId(id, fn)` (lib/requestContext.ts)
// so logLLMCall tallies under that id, then read it here with { clear: true }.
//
// Never throws: a missing tally returns zeros (the deduction row is still
// written; cost is just null/0). Best-effort, mirrors the deduction-log
// "losing a forensic detail beats failing a real operation" rule.

import { logger } from '../services/LoggerService.js';

export interface DeductionCostPatch {
  /** Canonical platform cost-to-serve in USD (→ UsageDeductionLog.platformCostUsd). */
  platformCostUsd: number;
  /** Forensic detail to merge into the deduction row's metadata. */
  metadata: {
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string | null;
    provider: string | null;
    llmCalls: number;
    /** 'tally' = measured from real usage; 'none' = no LLM calls captured. */
    costSource: 'tally' | 'none';
  };
}

const ZERO: DeductionCostPatch = {
  platformCostUsd: 0,
  metadata: {
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: null,
    provider: null,
    llmCalls: 0,
    costSource: 'none',
  },
};

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Build the cost patch for a deduction row from the current request's LLM tally.
 * @param requestId  the request to read (usually getCurrentRequestId()).
 * @param opts.clear drop the tally after reading (use for cron per-unit scopes).
 */
export function costPatchFromTally(
  requestId?: string | null,
  opts?: { clear?: boolean },
): DeductionCostPatch {
  try {
    const tally = logger.getRequestCostTally(requestId);
    if (opts?.clear) logger.clearRequestCostTally(requestId);
    if (!tally || tally.llmCalls === 0) return { ...ZERO, metadata: { ...ZERO.metadata } };
    const costUsd = round6(tally.costUsd);
    return {
      platformCostUsd: costUsd,
      metadata: {
        costUsd,
        promptTokens: tally.promptTokens,
        completionTokens: tally.completionTokens,
        totalTokens: tally.totalTokens,
        model: tally.model,
        provider: tally.provider,
        llmCalls: tally.llmCalls,
        costSource: 'tally',
      },
    };
  } catch {
    return { ...ZERO, metadata: { ...ZERO.metadata } };
  }
}

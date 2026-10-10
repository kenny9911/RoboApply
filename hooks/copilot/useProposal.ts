'use client';

// hooks/copilot/useProposal.ts — confirm or dismiss an Assistant proposal
// (WP-51; ARCHITECTURE.md §5.5 "Proposal safety").
//
// Every change the Assistant suggests is a proposal: a filter change, a credit
// action (tailor, cover letter, outreach draft, job import) or a memory fact.
// Nothing happens until the user presses the card's confirm button. Credit
// actions spend their own bucket only here, through useCreditGate (one
// idempotency key per press, the out-of-credits sheet on 402).
//
// Results:
//   applied   { result }       the server applied it
//   conflict  { details }      filters changed since the suggestion (409 version_conflict)
//   expired                    older than 24 h (proposal_expired)
//   credits                    out of credits (the sheet is already open)
//   failed    { code }         anything else

import { useCallback, useState } from 'react';

import { applyProposal, dismissProposal } from '../../lib/api/copilot';
import { apiErrorCode, apiErrorDetails, apiErrorReason, newIdempotencyKey } from '../../lib/api/contracts/wire';
import { useCreditGate } from '../shared/useCreditGate';

export type ProposalOutcome =
  | { kind: 'applied'; result: unknown }
  | { kind: 'conflict'; details: Record<string, unknown> | null }
  | { kind: 'expired' }
  | { kind: 'credits' }
  | { kind: 'failed'; code: string | null };

export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'dismissed' | 'expired' | 'conflict' | 'failed';

/** Map a failed apply to an outcome. Pure. */
export function proposalFailure(err: unknown): ProposalOutcome {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  if (code === 'proposal_expired' || reason === 'proposal_expired' || code === 'gone') return { kind: 'expired' };
  if (code === 'version_conflict' || reason === 'version_conflict' || code === 'conflict') return { kind: 'conflict', details: apiErrorDetails(err) };
  if (code === 'credits_exhausted') return { kind: 'credits' };
  return { kind: 'failed', code: code ?? reason };
}

/** True when an ISO expiry is in the past. Pure. */
export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

export function useProposal(proposalId: string, opts: { bucket?: string | null; initial?: ProposalStatus } = {}) {
  const gate = useCreditGate(opts.bucket ?? 'assistant');
  const [status, setStatus] = useState<ProposalStatus>(opts.initial ?? 'pending');
  const [result, setResult] = useState<unknown>(null);

  const apply = useCallback(
    async (body: { baseVersion?: number } = {}): Promise<ProposalOutcome> => {
      setStatus('applying');
      let outcome: ProposalOutcome;
      try {
        if (opts.bucket) {
          const r = await gate.run((idempotencyKey) => applyProposal(proposalId, body, { idempotencyKey }));
          outcome = r.ok ? { kind: 'applied', result: r.value.result } : { kind: 'credits' };
        } else {
          const res = await applyProposal(proposalId, body, { idempotencyKey: newIdempotencyKey() });
          outcome = { kind: 'applied', result: res.result };
        }
      } catch (err) {
        outcome = proposalFailure(err);
      }
      if (outcome.kind === 'applied') {
        setResult(outcome.result);
        setStatus('applied');
      } else if (outcome.kind === 'expired') setStatus('expired');
      else if (outcome.kind === 'conflict') setStatus('conflict');
      else if (outcome.kind === 'credits') setStatus('pending');
      else setStatus('failed');
      return outcome;
    },
    [gate, opts.bucket, proposalId],
  );

  const dismiss = useCallback(async () => {
    setStatus('dismissed');
    try {
      await dismissProposal(proposalId);
    } catch {
      // Dismissing is a courtesy to the server; the card stays dismissed.
    }
  }, [proposalId]);

  return { status, result, apply, dismiss, setStatus };
}

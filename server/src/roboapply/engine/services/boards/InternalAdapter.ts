// backend/src/seeker/services/boards/InternalAdapter.ts
//
// "Internal" board adapter for the RoboHire job bank. This is the no-op
// path — submitting to an internal job is a DB write the orchestrator
// already does via SeekerApplicationService. The adapter exists so the
// orchestrator can treat internal and external boards uniformly:
//
//   for each eligible job → pick adapter → adapter.submit() → persist
//
// We don't actually call any external API here. The orchestrator does the
// idempotency check (existing SeekerApplication on the same (seeker, job))
// before calling submit, so this adapter only returns a successful sentinel
// the orchestrator persists alongside the row.

import type {
  SeekerBoardAdapter,
  BoardAdapterSubmitInput,
  BoardAdapterSubmitResult,
  SeekerBoardConnectionLike,
} from './SeekerBoardAdapter.js';

class InternalAdapter implements SeekerBoardAdapter {
  readonly name = 'internal' as const;
  readonly displayName = 'RoboHire Internal Job Bank';
  /** Always available — internal applications are DB writes, no external deps. */
  readonly isAvailable = true;

  async validate(_connection: SeekerBoardConnectionLike | null): Promise<{ valid: boolean; error?: string }> {
    return { valid: true };
  }

  async submit(input: BoardAdapterSubmitInput): Promise<BoardAdapterSubmitResult> {
    // Guard: orchestrator should pass source='internal', but defensively reject
    // a mismatched job so we don't accidentally submit an external job to the
    // internal path.
    if (input.job.source !== 'internal') {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: `Internal adapter received job with source='${input.job.source}'`,
        retryable: false,
      };
    }
    // Sanity: job id must be a non-empty cuid-ish string. We don't enforce
    // a strict cuid pattern because Prisma generates them, but an empty value
    // means the orchestrator passed something malformed.
    if (!input.job.id || typeof input.job.id !== 'string') {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: 'Internal adapter requires a non-empty job.id',
        retryable: false,
      };
    }
    // Sanity: resume content must be non-empty. Without it the recruiter has
    // nothing to view, so we surface this as a terminal failure rather than
    // silently submit a blank application.
    if (!input.resumeContent || input.resumeContent.trim().length < 20) {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: 'Internal adapter requires non-empty resume content',
        retryable: false,
      };
    }
    // No external API call. The orchestrator persists the SeekerApplication
    // row and commits the quota deduction itself. Our job is just to say
    // "yes, this is OK to submit" and return the metadata the orchestrator
    // can attach for future forensics.
    return {
      success: true,
      // Internal board doesn't have a separate external id — return the
      // internal job id so the persisted boardMetadata stays uniform across
      // adapters.
      externalApplicationId: `internal:${input.job.id}`,
      boardMetadata: {
        board: 'internal',
        submittedVia: 'auto_apply',
        jobId: input.job.id,
        companyName: input.job.companyName,
        // Useful for the deep-dive view — confirms which resume content was
        // attached at submit time. We don't store the full resume here (the
        // SeekerResumeVersion row carries that); just a fingerprint.
        resumeContentBytes: input.resumeContent.length,
        coverLetterPresent: !!input.coverLetter,
      },
    };
  }
}

export const internalAdapter = new InternalAdapter();
export default internalAdapter;

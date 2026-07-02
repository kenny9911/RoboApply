// backend/src/seeker/services/boards/GreenhouseAdapter.ts
//
// Greenhouse Job Board API adapter. Phase 1 ATS partner.
//
// STRATEGY (Phase 1, simulation-first):
// ─────────────────────────────────────────────────────────────────────────
// Greenhouse's official Job Board API (`https://boards-api.greenhouse.io`)
// requires an OAuth flow with the EMPLOYER's Greenhouse account to actually
// submit applications. RoboHire doesn't have an employer-side Greenhouse
// account in Phase 1 — we're a seeker product submitting on the seeker's
// behalf to whichever employer's board the seeker is targeting.
//
// Until we have either (a) RoboHire's own Greenhouse partner integration or
// (b) per-employer OAuth flows, this adapter operates in TWO MODES:
//
//   1. SIMULATION MODE (default in dev/staging, and when GREENHOUSE_API_KEY
//      is not set). Submit() returns success WITHOUT actually calling the
//      Greenhouse API. The submitted application is logged with
//      `simulated: true` in the activity log and SeekerApplication
//      boardMetadata so admins / audits can tell real from simulated
//      submissions apart. The user-visible UX stays the same (status
//      'submitted', counts toward quota) — this is consistent with the PRD's
//      Phase 1 wedge: prove the workflow, prove the UX, prove the quota
//      pipeline. Real Greenhouse submissions follow once partner integration
//      lands.
//
//   2. LIVE MODE (when GREENHOUSE_API_KEY is set). We POST to Greenhouse's
//      public Job Board API. This is gated on the env var so production
//      deploys without the key fall safely into simulation.
//
// Env vars
// ─────────────────────────────────────────────────────────────────────────
//   GREENHOUSE_API_KEY        — partner-level key (when set, adapter goes live)
//   GREENHOUSE_BOARD_TOKEN    — board token (employer-scoped); required when LIVE
//   GREENHOUSE_BASE_URL       — defaults to https://boards-api.greenhouse.io
//
// Per-seeker per-employer credentials would live on SeekerBoardConnection
// for Phase 2 when we add OAuth. Today the connection row only acts as a
// "I have consented to Greenhouse auto-apply" marker.
//
// Boundary: imports from third-party packages only (or none in simulation
// mode). Never imports SeekerApplicationService.

import type {
  SeekerBoardAdapter,
  BoardAdapterSubmitInput,
  BoardAdapterSubmitResult,
  SeekerBoardConnectionLike,
} from './SeekerBoardAdapter.js';
import { logger } from '../../../../services/LoggerService.js';

interface GreenhouseAdapterEnv {
  apiKey: string | null;
  boardToken: string | null;
  baseUrl: string;
}

function readEnv(): GreenhouseAdapterEnv {
  // Read env on every call so test harnesses can flip GREENHOUSE_API_KEY at
  // runtime via `delete process.env.GREENHOUSE_API_KEY`. The variables are
  // small strings; reading them each time is free.
  const apiKey = (process.env.GREENHOUSE_API_KEY ?? '').trim() || null;
  const boardToken = (process.env.GREENHOUSE_BOARD_TOKEN ?? '').trim() || null;
  const baseUrl =
    (process.env.GREENHOUSE_BASE_URL ?? '').trim() || 'https://boards-api.greenhouse.io';
  return { apiKey, boardToken, baseUrl };
}

class GreenhouseAdapter implements SeekerBoardAdapter {
  readonly name = 'greenhouse' as const;
  readonly displayName = 'Greenhouse';

  /**
   * Adapter is always considered available — in simulation mode it still
   * "works" for the orchestrator (just doesn't make a real HTTP call). The
   * orchestrator decides whether to surface the simulation badge based on
   * the submit() result's `simulated:true` flag.
   */
  readonly isAvailable = true;

  async validate(connection: SeekerBoardConnectionLike | null): Promise<{ valid: boolean; error?: string }> {
    // In Phase 1 the "connection" is just an opt-in marker. Validation succeeds
    // as long as the row exists OR we're in simulation mode (where no
    // connection is actually required to submit). The orchestrator passes the
    // connection in, so its presence/absence is the validation answer.
    if (!connection) {
      // No connection row but adapter is in simulation mode — that's fine,
      // we still let the orchestrator proceed and let submit() handle it.
      const env = readEnv();
      if (!env.apiKey) {
        return { valid: true };
      }
      return { valid: false, error: 'Greenhouse connection required (live mode)' };
    }
    if (connection.status !== 'connected') {
      return { valid: false, error: `Greenhouse connection status is '${connection.status}'` };
    }
    return { valid: true };
  }

  async submit(input: BoardAdapterSubmitInput): Promise<BoardAdapterSubmitResult> {
    // ── Common input validation ──────────────────────────────────────────
    if (input.job.source !== 'greenhouse') {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: `Greenhouse adapter received job with source='${input.job.source}'`,
        retryable: false,
      };
    }
    if (!input.job.id || typeof input.job.id !== 'string') {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: 'Greenhouse adapter requires a non-empty job.id',
        retryable: false,
      };
    }
    if (!input.resumeContent || input.resumeContent.trim().length < 20) {
      return {
        success: false,
        errorCode: 'invalid_input',
        error: 'Greenhouse adapter requires non-empty resume content',
        retryable: false,
      };
    }
    if (!input.seeker.email) {
      // Greenhouse forms always require an email — block in both modes so
      // simulation can't paper over a missing field that would break the
      // real submission later.
      return {
        success: false,
        errorCode: 'invalid_input',
        error: 'Greenhouse requires seeker.email',
        retryable: false,
      };
    }

    const env = readEnv();

    // ── Simulation mode ──────────────────────────────────────────────────
    // No API key → return success with `simulated:true`. The activity log
    // and SeekerApplication.boardMetadata carry the flag so QA + admin
    // tooling can distinguish "really submitted" from "we pretended to."
    if (!env.apiKey || !env.boardToken) {
      logger.info(
        'SEEKER_AUTO_APPLY',
        'Greenhouse adapter running in simulation mode (no GREENHOUSE_API_KEY/BOARD_TOKEN)',
        {
          jobId: input.job.id,
          seekerProfileId: input.seeker.seekerProfileId,
          missingKey: !env.apiKey,
          missingBoardToken: !env.boardToken,
        },
        input.requestId ?? undefined,
      );
      // Generate a deterministic-looking external id so downstream forensics
      // can sort simulated submissions consistently. Prefix with `sim:` so
      // it's obvious in logs.
      const simulatedId = `sim:greenhouse:${input.seeker.seekerProfileId.slice(0, 6)}:${input.job.id.slice(0, 10)}:${Date.now()}`;
      return {
        success: true,
        simulated: true,
        externalApplicationId: simulatedId,
        boardMetadata: {
          board: 'greenhouse',
          mode: 'simulation',
          simulated: true,
          jobId: input.job.id,
          companyName: input.job.companyName,
          submittedAt: new Date().toISOString(),
          resumeContentBytes: input.resumeContent.length,
          coverLetterPresent: !!input.coverLetter,
          note: 'Greenhouse adapter is in simulation mode — no external API call was made. See backend/src/seeker/services/boards/GreenhouseAdapter.ts for the live-mode env contract.',
        },
      };
    }

    // ── Live mode ────────────────────────────────────────────────────────
    // Real Greenhouse Job Board API call. We POST to
    //   {baseUrl}/v1/boards/{boardToken}/jobs/{jobId}
    // with a multipart-ish JSON body. Greenhouse expects a base64-encoded
    // resume blob + the seeker's first/last/email. See:
    // https://developers.greenhouse.io/job-board.html#post-application
    try {
      const nameParts = (input.seeker.displayName ?? '').trim().split(/\s+/);
      const firstName = nameParts[0] || 'Candidate';
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Applicant';

      // Wrap a tiny envelope around the resume content. Greenhouse accepts a
      // base64-encoded attachment + a content_type. For markdown/text payloads
      // we send text/plain. If we ever add PDF upload, switch on content
      // sniff.
      const resumeBase64 = Buffer.from(input.resumeContent).toString('base64');

      const url = `${env.baseUrl}/v1/boards/${encodeURIComponent(env.boardToken)}/jobs/${encodeURIComponent(input.job.id)}`;
      // The job-board "post application" endpoint requires HTTP Basic auth
      // with the partner API key as the username + an empty password
      // (Greenhouse convention).
      const basicAuth = Buffer.from(`${env.apiKey}:`).toString('base64');

      const payload = {
        first_name: firstName,
        last_name: lastName,
        email: input.seeker.email,
        resume_content: resumeBase64,
        resume_content_filename: `resume_${input.seeker.seekerProfileId.slice(0, 8)}.txt`,
        resume_content_type: 'text/plain',
        ...(input.coverLetter
          ? {
              cover_letter_content: Buffer.from(input.coverLetter).toString('base64'),
              cover_letter_content_filename: 'cover_letter.txt',
              cover_letter_content_type: 'text/plain',
            }
          : {}),
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth}`,
          'User-Agent': 'RoboHire-AutoApply/1.0',
        },
        body: JSON.stringify(payload),
        // 30s cap — the orchestrator also has a global 60s per-run budget.
        signal: AbortSignal.timeout(30_000),
      });

      // ── Map HTTP status to BoardAdapterSubmitResult error codes ──────
      if (response.status === 201 || response.status === 200) {
        let externalApplicationId: string | undefined;
        try {
          const json = (await response.json()) as { id?: string | number };
          if (json && (typeof json.id === 'string' || typeof json.id === 'number')) {
            externalApplicationId = String(json.id);
          }
        } catch {
          // Greenhouse occasionally returns an empty body; that's fine — we
          // already know it was a success.
        }
        return {
          success: true,
          externalApplicationId,
          boardMetadata: {
            board: 'greenhouse',
            mode: 'live',
            simulated: false,
            jobId: input.job.id,
            companyName: input.job.companyName,
            submittedAt: new Date().toISOString(),
            httpStatus: response.status,
            externalApplicationId,
          },
        };
      }

      const errorBody = await safeReadErrorText(response);
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          errorCode: 'auth_expired',
          error: `Greenhouse rejected credentials (HTTP ${response.status})`,
          retryable: false,
          boardMetadata: { httpStatus: response.status, body: errorBody.slice(0, 500) },
        };
      }
      if (response.status === 409) {
        return {
          success: false,
          errorCode: 'duplicate',
          error: 'Greenhouse reports the seeker already applied',
          retryable: false,
          boardMetadata: { httpStatus: response.status, body: errorBody.slice(0, 500) },
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          errorCode: 'rate_limited',
          error: 'Greenhouse rate-limited the submission',
          retryable: true,
          boardMetadata: { httpStatus: response.status },
        };
      }
      if (response.status >= 500) {
        return {
          success: false,
          errorCode: 'server_error',
          error: `Greenhouse returned HTTP ${response.status}`,
          retryable: true,
          boardMetadata: { httpStatus: response.status, body: errorBody.slice(0, 500) },
        };
      }
      // 4xx other than the special cases above — treat as terminal bad input.
      return {
        success: false,
        errorCode: 'invalid_input',
        error: `Greenhouse returned HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        retryable: false,
        boardMetadata: { httpStatus: response.status, body: errorBody.slice(0, 500) },
      };
    } catch (err) {
      // Network error / timeout / DNS / TLS / etc. — transient, retryable.
      const message = err instanceof Error ? err.message : String(err);
      // AbortError is the timeout path.
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return {
        success: false,
        errorCode: 'network',
        error: isTimeout ? `Greenhouse request timed out: ${message}` : `Greenhouse network error: ${message}`,
        retryable: true,
        boardMetadata: { isTimeout },
      };
    }
  }
}

async function safeReadErrorText(response: Response): Promise<string> {
  try {
    return (await response.text()) ?? '';
  } catch {
    return '';
  }
}

export const greenhouseAdapter = new GreenhouseAdapter();
export default greenhouseAdapter;

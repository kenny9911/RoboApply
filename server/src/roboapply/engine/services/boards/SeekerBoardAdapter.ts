// backend/src/seeker/services/boards/SeekerBoardAdapter.ts
//
// Board adapter contract for Phase 1 auto-apply. Two adapters ship in v1:
//   - InternalAdapter   — RoboHire's own job bank (DB write, no external API)
//   - GreenhouseAdapter — Greenhouse Job Board API (Phase 1 ATS partner)
//
// Phase 2 will add LinkedIn / Indeed / Lever / Workday under the same
// contract — that's the whole point of the adapter pattern. See
// docs/job-seeker-ai-architecture.md §13 and docs/prd-job-seeker-app.md §F4
// for the Phase 1 scope lock (LinkedIn + Indeed deferred to Phase 2).
//
// Adapters are stateless services — every call carries its own (job, seeker,
// resume, connection) bundle. Failures are explicit `success: false` results
// with `retryable: true|false` so the orchestrator can decide whether to
// retry vs. give up.
//
// Boundary: lives under backend/src/seeker/services/boards. Adapters may
// import from seeker/lib + third-party packages only. They MUST NOT import
// SeekerApplicationService / SeekerAutoApplyService — the orchestrator owns
// composition + persistence so adapters stay swap-in-swap-out.

// ─── Minimal entity shapes adapters consume ────────────────────────────
//
// We deliberately avoid passing full Prisma models so adapters stay decoupled
// from schema changes. The orchestrator projects the fields each adapter
// needs at call time.

export interface JobLike {
  /** Internal Job.id when board='internal', otherwise the external board's job id / url tail. */
  id: string;
  title: string;
  companyName: string | null;
  description: string | null;
  qualifications: string | null;
  hardRequirements: string | null;
  niceToHave: string | null;
  /** Where this job is hosted ('internal' = RoboHire job bank). */
  source: 'internal' | 'greenhouse' | 'linkedin' | 'indeed' | 'lever' | 'workday';
  /** Optional external URL (for non-internal boards). */
  externalUrl?: string | null;
  location?: string | null;
  workType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
}

export interface SeekerLike {
  userId: string;
  seekerProfileId: string;
  /** Pulled from SeekerProfile.locale; controls submission email language for some adapters. */
  locale: string | null;
  /** Seeker's display name (from User.name); some boards require first/last separately. */
  displayName: string | null;
  /** Seeker's email — the channel some boards use to surface the submission. */
  email: string | null;
}

/** Minimal projection of a SeekerBoardConnection row. Null for `internal`. */
export interface SeekerBoardConnectionLike {
  id: string;
  board: string;
  status: string;
  /** Decrypted access token. The orchestrator (and only the orchestrator) decrypts before passing in. */
  accessToken: string | null;
  /** Decrypted refresh token, when present. */
  refreshToken: string | null;
  scopes: string[];
  /** When the access token expires (informational; not enforced by adapters). */
  expiresAt: Date | null;
}

export interface BoardAdapterSubmitInput {
  job: JobLike;
  seeker: SeekerLike;
  /** Materialized resume content (markdown or text) — already tailored by the orchestrator. */
  resumeContent: string;
  /** Optional cover letter content. v1 — typically null. */
  coverLetter?: string | null;
  /** Active connection for this board. NULL for `internal`. */
  connection: SeekerBoardConnectionLike | null;
  /** Optional request id for correlation in logs / activity rows. */
  requestId?: string | null;
}

export type BoardAdapterSubmitResult =
  | {
      success: true;
      /** Board-assigned id (when the API returns one), or our own deterministic id for internal. */
      externalApplicationId?: string;
      /** Adapter-specific submission metadata to persist on SeekerApplication.boardMetadata. */
      boardMetadata?: Record<string, unknown>;
      /** Whether the submission was simulated (no real external call made). */
      simulated?: boolean;
    }
  | {
      success: false;
      /** Closed enum the orchestrator switches on for activity-log + retry decisions. */
      errorCode:
        | 'rate_limited'        // board threw 429 — retry later
        | 'duplicate'           // board says we already applied — terminal
        | 'auth_expired'        // token expired / invalid — needs reconnect, terminal until user fixes
        | 'auth_missing'        // no connection on file but adapter requires one — terminal
        | 'form_changed'        // form schema drift (board adapters only) — terminal until adapter fix
        | 'network'             // transient HTTP error — retry later
        | 'server_error'        // 5xx from board — retry later
        | 'invalid_input'       // we sent something bad (missing required field) — terminal
        | 'simulation_only'     // simulator path — successful UX, terminal (do not retry)
        | 'disabled'            // board disabled by AppConfig kill switch — terminal
        | 'other';
      /** Human-readable error message for activity log. Never includes secrets. */
      error: string;
      /** Hint for orchestrator retry policy. */
      retryable: boolean;
      /** Adapter-specific failure metadata for forensics. */
      boardMetadata?: Record<string, unknown>;
    };

export interface SeekerBoardAdapter {
  readonly name: 'internal' | 'greenhouse';
  readonly displayName: string;
  /**
   * Whether the adapter has everything it needs to attempt a submit:
   *   - `internal`     — always true (DB write).
   *   - `greenhouse`   — true iff GREENHOUSE_API_KEY env is set, OR the
   *                      adapter is in simulation mode (env var unset).
   */
  readonly isAvailable: boolean;
  /**
   * Per-connection validation. Returns `valid:true` for `internal` regardless
   * (no connection needed). For greenhouse, performs a cheap HEAD/GET against
   * the board's API to confirm credentials still work. The orchestrator may
   * call this before kickoff to fail fast.
   */
  validate(connection: SeekerBoardConnectionLike | null): Promise<{ valid: boolean; error?: string }>;
  /** Submit one application. See BoardAdapterSubmitInput / BoardAdapterSubmitResult above. */
  submit(input: BoardAdapterSubmitInput): Promise<BoardAdapterSubmitResult>;
}

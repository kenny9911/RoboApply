// backend/src/roboapply/services/accountPurgeHelpers.ts
//
// Pure selection logic for the nightly GDPR account-purge sweep — split from
// SeekerAccountPurgeService so it can be unit-tested without pulling in
// prisma / the S3 SDK (same pattern as interview-engine/sessions/
// lifecycleHelpers.ts). No I/O in this file.

/** Days a soft-deleted account is retained before the hard purge. */
export const DEFAULT_PURGE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The only role sets the sweep will hard-delete. RoboApply seeker signup
 * creates role='seeker', roles=['seeker'] (SeekerAuthService); 'candidate' is
 * the legacy multi-role spelling. Anything else on the row (admin, recruiter
 * 'user', internal staff) means the User is not purely a RoboApply seeker and
 * hard-deleting it would cascade non-seeker data — skip and flag for manual
 * review instead.
 */
const PURGE_SAFE_ROLES: ReadonlySet<string> = new Set(['seeker', 'candidate']);

export interface PurgeCandidate {
  userId: string;
  /** SeekerProfile.deletedAt — soft-delete marker set by POST /account/delete. */
  deletedAt: Date | null;
  /** User.role (primary) — invariant roles[0] === role. */
  role: string;
  /** User.roles (full list). */
  roles: string[];
}

export interface PurgePartition {
  /** Retention elapsed + safe role set → hard-purge this run. */
  due: PurgeCandidate[];
  /** Soft-deleted but inside the retention window — leave for a later run. */
  notYetDue: PurgeCandidate[];
  /** Retention elapsed but the role set isn't purely seeker — needs a human. */
  unsafeRole: PurgeCandidate[];
}

/**
 * Parse ACCOUNT_PURGE_RETENTION_DAYS. Anything unset / non-numeric / < 1 falls
 * back to the default — a bad env var must never shorten retention to zero and
 * mass-purge same-day deletions.
 */
export function resolveRetentionDays(raw: string | undefined): number {
  const n = Number((raw ?? '').trim() || NaN);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PURGE_RETENTION_DAYS;
  return Math.floor(n);
}

/** Latest deletedAt that is old enough to purge (inclusive). */
export function purgeCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** True when the soft-delete happened at least `retentionDays` before `now`. */
export function isPurgeDue(
  deletedAt: Date | null | undefined,
  now: Date,
  retentionDays: number,
): boolean {
  if (!deletedAt) return false;
  return deletedAt.getTime() <= purgeCutoff(now, retentionDays).getTime();
}

/** True when every role on the user (primary + list) is a pure seeker role. */
export function isPurgeSafeRoleSet(role: string | null | undefined, roles: readonly string[] | null | undefined): boolean {
  const all = new Set(
    [role, ...(roles ?? [])].filter((r): r is string => typeof r === 'string' && r.length > 0),
  );
  if (all.size === 0) return false; // no role info at all — don't guess
  for (const r of all) {
    if (!PURGE_SAFE_ROLES.has(r)) return false;
  }
  return true;
}

/**
 * Split the sweep's candidate rows into due / not-yet-due / unsafe-role. The
 * DB query already filters by deletedAt <= cutoff; re-checking here keeps this
 * function the single tested source of truth (and makes the sweep safe even if
 * the query is ever loosened).
 */
export function partitionPurgeCandidates(
  candidates: readonly PurgeCandidate[],
  now: Date,
  retentionDays: number,
): PurgePartition {
  const due: PurgeCandidate[] = [];
  const notYetDue: PurgeCandidate[] = [];
  const unsafeRole: PurgeCandidate[] = [];
  for (const c of candidates) {
    if (!isPurgeDue(c.deletedAt, now, retentionDays)) {
      notYetDue.push(c);
    } else if (!isPurgeSafeRoleSet(c.role, c.roles)) {
      unsafeRole.push(c);
    } else {
      due.push(c);
    }
  }
  return { due, notYetDue, unsafeRole };
}

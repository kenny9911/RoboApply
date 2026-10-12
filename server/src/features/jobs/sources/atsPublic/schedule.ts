// server/src/features/jobs/sources/atsPublic/schedule.ts — when a board is read
// next and when it is switched off (MARKET_STRATEGY 1.2 tier 0, 1.5 closure;
// JI-4). Pure rules; ingest/boards.ts applies them after each read.
//
//   success        failCount 0, lastError null, lastSyncedAt = the read.
//                  lastChangeAt = now when the run added or closed a posting.
//                  A board's FIRST successful read is not a change (it adds
//                  every posting the board lists; ingest/boards.ts
//                  `writeBoard`): the board is then read every 24 h until a
//                  posting really opens or closes.
//                  Next read: +2 h when the board changed in the last 48 h,
//                  +12 h when in the last 14 days, +24 h otherwise.
//                  Posting texts (SmartRecruiters) change that: while texts
//                  of new postings were not asked for yet (`pendingDetails`,
//                  the per-run budget) the board is due at once, at the next
//                  board sync; when a text was asked for and could not be
//                  read (`failedDetails`) the board comes back in 1 h, and a
//                  run that was refused every text it asked for also waits
//                  1 h whatever is still pending, so a host that limits us
//                  is asked less often, never more.
//   hard failure   the board is gone, refuses us, or answers something that
//                  is not a listing (404, any other 4xx except 408 and 429, a
//                  redirect, not JSON, another shape, an answer too large to
//                  read, a system we cannot read). failCount + 1, retried in
//                  1 h (401 and 403: in 6 h, because a host may refuse our
//                  address for a while and that must not switch off every
//                  board on it within two hours); the third one with no
//                  successful read in between switches the source off (enabled
//                  false, disabledAt = now). Its open postings are archived 48
//                  hours later; until then `nextSyncAt` holds that time (a
//                  switched-off source is never leased, so the column is free
//                  to say when its postings go).
//   transient      a timeout, a 5xx, a 408, a 429, a network error: retried in
//                  1 h x the attempt number (at most 6 h) and never counted
//                  toward switching the source off. The attempt number needs
//                  no column: `lastSyncedAt` is the time of the last read, so
//                  the gap since a transient failure is the wait that was used.
//   candidate      a discovered or imported source that is not switched on
//                  yet has no successful read to fall back on, so its failed
//                  list-only reads are counted in `failCount`: tried again in
//                  1 h x the attempt, and the third one is final
//                  (`candidateRetry`).
//   passed over    the source's connector is switched off (ATS_WORKABLE_DISABLED,
//                  CN_ATS_BEISEN_ENABLED not set) or its tenant is on the
//                  denylist: no request is made and nothing is counted. The
//                  reason is written as `lastError` and the source is looked
//                  at again in 24 h (`skippedStamp`); its read time, its
//                  failure count and its postings are left as they are (a
//                  denylisted tenant's postings are archived by ingest/boards.ts,
//                  at every board sync).
//   tenant floor   a 北森 tenant is never asked twice within 30 minutes,
//                  whatever the rules above say, and whatever happened to the
//                  run that asked it. Three things hold it together:
//                    - the time a tenant is asked is written to `lastSyncedAt`
//                      BEFORE the request (ingest/boards.ts, service.ts), so a
//                      run that is cut off, dies or runs out of time after
//                      asking still leaves the time behind; the lease and
//                      "Check now" refuse a tenant asked under 30 minutes ago
//                      (`tenantAskedRecently`);
//                    - no stamp sets a tenant's next read earlier than 30
//                      minutes away (`withTenantFloor`), and the lease itself
//                      holds a tenant for 30 minutes, not 15;
//                    - a candidate has no read time (its `lastSyncedAt` stays
//                      empty until a verdict), so before it is asked the time
//                      of its next possible request is written to
//                      `nextSyncAt`; switching it on by hand keeps that time
//                      (`firstReadAfterSwitchOn`).

import { CONNECTOR_DISABLED } from './contract.js';
import {
  BEISEN_TENANT_FLOOR_MS,
  isMainlandOnlyAts,
  DISABLED_ARCHIVE_AFTER_MS,
  SYNC_COLD_INTERVAL_MS,
  SYNC_HOT_INTERVAL_MS,
  SYNC_HOT_WINDOW_MS,
  SYNC_MAX_HARD_FAILURES,
  SYNC_REFUSED_RETRY_MS,
  SYNC_RETRY_MAX_STEPS,
  SYNC_RETRY_MS,
  SYNC_WARM_INTERVAL_MS,
  SYNC_WARM_WINDOW_MS,
} from './shared.js';

export type BoardFailureClass = 'hard' | 'transient';

/** Error codes that mean "this is not a readable board" (http.ts BoardFetchError codes, plus an unknown system). */
export const HARD_BOARD_ERRORS = ['board_not_found', 'redirect', 'unexpected_shape', 'not_json', 'not_xml', 'invalid_board_id', 'unsupported_job_board', 'response_too_large'] as const;

/** `lastError` of a source whose tenant is on CN_ATS_TENANT_DENYLIST (connectors/beisen.ts throws the same code). */
export const TENANT_DENIED = 'tenant_denied';
/** `error` of "Check now" on a 北森 tenant that was read less than 30 minutes ago: no request is made. */
export const TENANT_FLOOR = 'tenant_floor';
/** Reasons a source is passed over without a request (see the header). */
export const SKIPPED_BOARD_ERRORS: readonly string[] = [CONNECTOR_DISABLED, TENANT_DENIED];

export function isSkippedBoardError(error: string | null | undefined): boolean {
  return !!error && SKIPPED_BOARD_ERRORS.includes(error);
}

/** The stamp of a source that was passed over: why, and when it is looked at again. Not a failure and not a read. */
export function skippedStamp(now: Date, error: string): { lastError: string; nextSyncAt: Date } {
  return { lastError: error.slice(0, 300), nextSyncAt: new Date(now.getTime() + SYNC_COLD_INTERVAL_MS) };
}

/**
 * A 北森 tenant is not read again within 30 minutes of a read, whatever the
 * stamp says. The stamp of a source that was just switched off is left alone:
 * there `nextSyncAt` is the time its postings are archived, not a read.
 */
export function withTenantFloor<T extends { nextSyncAt: Date; enabled?: boolean }>(source: { ats: string }, stamp: T, now: Date): T {
  if (!isMainlandOnlyAts(source.ats) || stamp.enabled === false) return stamp;
  const floor = now.getTime() + BEISEN_TENANT_FLOOR_MS;
  return stamp.nextSyncAt.getTime() >= floor ? stamp : { ...stamp, nextSyncAt: new Date(floor) };
}

/**
 * Was this 北森 tenant asked under 30 minutes ago (so it must not be asked
 * now)? The time of the last request is `lastSyncedAt` (see the header). A
 * tenant with no read time was only ever asked as a candidate, if at all: it
 * then carries the earliest time of its next request in `nextSyncAt`, and
 * until that time has come it counts as asked recently. Other systems: never.
 */
export function tenantAskedRecently(source: { ats: string; lastSyncedAt: Date | null; nextSyncAt?: Date | null }, now: Date): boolean {
  if (!isMainlandOnlyAts(source.ats)) return false;
  if (source.lastSyncedAt) return now.getTime() - source.lastSyncedAt.getTime() < BEISEN_TENANT_FLOOR_MS;
  const next = source.nextSyncAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return next > now.getTime() && next - now.getTime() <= BEISEN_TENANT_FLOOR_MS;
}

/**
 * `nextSyncAt` of a source an admin switches on: null (due at the next board
 * sync), except for a 北森 tenant that was never switched on and carries a
 * time before which it must not be asked again (a candidate whose check asked
 * it, see the header): that time stands, at most 30 minutes from now. A tenant
 * that was switched on before has its last request in `lastSyncedAt`, which
 * the lease reads.
 */
export function firstReadAfterSwitchOn(source: { ats: string; nextSyncAt: Date | null; disabledAt: Date | null }, now: Date): Date | null {
  if (!isMainlandOnlyAts(source.ats) || source.disabledAt || !source.nextSyncAt || source.nextSyncAt.getTime() <= now.getTime()) return null;
  return new Date(Math.min(source.nextSyncAt.getTime(), now.getTime() + BEISEN_TENANT_FLOOR_MS));
}

/** 4xx answers that pass by themselves: the host was slow, or we asked too often. */
const PASSING_HTTP_ERRORS = ['http_408', 'http_429'];
/** "You may not read this": counted like any hard failure, but retried later (see the header). */
const REFUSED_HTTP_ERRORS = ['http_401', 'http_403'];

export function classifyBoardError(error: string): BoardFailureClass {
  if ((HARD_BOARD_ERRORS as readonly string[]).includes(error)) return 'hard';
  // Any other 4xx is the host saying no to this request as it is (gone, refused, malformed): asking again will not help.
  if (/^http_4\d\d$/.test(error) && !PASSING_HTTP_ERRORS.includes(error)) return 'hard';
  return 'transient';
}

/** How long after a successful read the board is read again. */
export function syncIntervalMs(lastChangeAt: Date | null, now: Date): number {
  if (!lastChangeAt) return SYNC_COLD_INTERVAL_MS;
  const quietFor = now.getTime() - lastChangeAt.getTime();
  if (quietFor <= SYNC_HOT_WINDOW_MS) return SYNC_HOT_INTERVAL_MS;
  if (quietFor <= SYNC_WARM_WINDOW_MS) return SYNC_WARM_INTERVAL_MS;
  return SYNC_COLD_INTERVAL_MS;
}

export interface SourceSyncState {
  failCount: number;
  lastChangeAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

export interface SourceStamp {
  lastSyncedAt: Date;
  lastError: string | null;
  failCount: number;
  nextSyncAt: Date;
  lastJobCount?: number;
  lastChangeAt?: Date;
  enabled?: boolean;
  disabledAt?: Date;
}

export interface BoardReadResult {
  now: Date;
  listed: number;
  /** The run added or closed a posting. */
  changed: boolean;
  /** New postings whose text this run did not ask for (connectors.ts BoardRead). */
  pendingDetails: number;
  /** New postings whose text was asked for and could not be read. */
  failedDetails?: number;
  /** Posting texts this run did read. */
  readDetails?: number;
}

/** How long after a successful read the board is read again, given the posting texts it still owes (see the header). */
export function nextReadDelayMs(lastChangeAt: Date | null, result: Pick<BoardReadResult, 'now' | 'pendingDetails' | 'failedDetails' | 'readDetails'>): number {
  const interval = syncIntervalMs(lastChangeAt, result.now);
  const failed = result.failedDetails ?? 0;
  if (result.pendingDetails <= 0 && failed <= 0) return interval;
  // Texts not asked for yet, and the host answers: carry on at the next board sync.
  if (result.pendingDetails > 0 && (failed <= 0 || (result.readDetails ?? 0) > 0)) return 0;
  // A text that could not be read, or a run that was refused every text: come back later, not sooner.
  return Math.min(interval, SYNC_RETRY_MS);
}

/** The stamp after a board was read. */
export function successStamp(state: Pick<SourceSyncState, 'lastChangeAt'>, result: BoardReadResult): SourceStamp {
  const { now } = result;
  const lastChangeAt = result.changed ? now : state.lastChangeAt;
  const next = new Date(now.getTime() + nextReadDelayMs(lastChangeAt, result));
  return { lastSyncedAt: now, lastError: null, failCount: 0, lastJobCount: result.listed, nextSyncAt: next, ...(result.changed ? { lastChangeAt: now } : {}) };
}

/** The attempt number of a transient failure that follows `state` (1 for the first in a row). */
export function transientAttempt(state: Pick<SourceSyncState, 'lastSyncedAt' | 'lastError'>, now: Date): number {
  if (!state.lastError || !state.lastSyncedAt || classifyBoardError(state.lastError) !== 'transient') return 1;
  const waited = Math.round((now.getTime() - state.lastSyncedAt.getTime()) / SYNC_RETRY_MS);
  return Math.min(SYNC_RETRY_MAX_STEPS, Math.max(1, waited) + 1);
}

/** The stamp after a board could not be read. */
export function failureStamp(state: SourceSyncState, failure: { now: Date; error: string }): SourceStamp {
  const { now } = failure;
  const error = failure.error.slice(0, 300);
  if (classifyBoardError(failure.error) === 'transient') {
    const attempt = transientAttempt(state, now);
    return { lastSyncedAt: now, lastError: error, failCount: state.failCount, nextSyncAt: new Date(now.getTime() + SYNC_RETRY_MS * attempt) };
  }
  const failCount = state.failCount + 1;
  if (failCount >= SYNC_MAX_HARD_FAILURES) {
    // Switched off; `nextSyncAt` now says when its open postings are archived.
    return { lastSyncedAt: now, lastError: error, failCount, enabled: false, disabledAt: now, nextSyncAt: new Date(now.getTime() + DISABLED_ARCHIVE_AFTER_MS) };
  }
  const wait = REFUSED_HTTP_ERRORS.includes(failure.error) ? SYNC_REFUSED_RETRY_MS : SYNC_RETRY_MS;
  return { lastSyncedAt: now, lastError: error, failCount, nextSyncAt: new Date(now.getTime() + wait) };
}

/** A candidate's list-only read is tried this many times before a passing failure is final. */
export const CANDIDATE_MAX_ATTEMPTS = 3;

/**
 * What a candidate gets when its list-only read failed for a passing reason (a
 * timeout, a 5xx, a 429): `failCount` is the attempts made so far. Tried again
 * 1 h x the attempt later; the attempt that reaches CANDIDATE_MAX_ATTEMPTS is
 * final (the caller stamps it checked, so it is not tried again).
 */
export function candidateRetry(failCount: number, now: Date): { failCount: number; final: boolean; nextSyncAt: Date | null } {
  const attempts = Math.max(0, failCount) + 1;
  if (attempts >= CANDIDATE_MAX_ATTEMPTS) return { failCount: attempts, final: true, nextSyncAt: null };
  return { failCount: attempts, final: false, nextSyncAt: new Date(now.getTime() + SYNC_RETRY_MS * attempts) };
}

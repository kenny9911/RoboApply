// server/src/features/tracker/service.ts — the applications tracker core (WP-38).
//
// One service behind both routers (the legacy /v2/tracker CRUD in
// roboapply/v2/routes/tracker.ts and the new paths in ./routes.ts) and the
// cross-area seams on ./index.ts (`markApplied`, `undoApplied`,
// `updateOffer`, `summary`).
//
// Rules this file enforces (TASK_PLAN.md WP-38 acceptance):
//   - every change written by PATCH (and create, bulk, mark-applied, undo)
//     records an RATrackerEvent in the same transaction;
//   - a move to `applied` stamps `dateApplied` when it is not set;
//   - statuses and stage details are validated against the brand's ladder
//     (RoboApply C1; GoApply 收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 → Offer → 三方 / 未通过);
//   - an outcome ("They said no" / "I withdrew" / "Job was pulled") moves the
//     entry to its terminal status, and leaving a terminal status clears it.
//   - every writer that can move a job's entry to Saved or Applied (create,
//     patch, bulk, upsertForJob, markApplied, undoApplied) runs under
//     `pg_advisory_xact_lock(hashtext(trackerEntryLockKey(userId, jobId)))`,
//     the same key the job page's writers take (jobs/detail), and re-reads the
//     entry inside that transaction: a concurrent apply and undo run one after
//     the other and can never both move it (WP-93 #5);
//   - moves made in the tracker itself (create, patch, bulk) carry
//     `payload.via = 'tracker'`; the apply channels keep their own `via`;
//   - a change that puts a job at Saved or Applied tells the feed once
//     (`feedService.recordInteraction`, 'save' | 'applied'), after the write and
//     softly: a failure there never blocks or undoes the move, and a slow feed
//     store holds the answer back for at most `FEED_SIGNAL_TIMEOUT_MS` (a bulk
//     move sends its signals side by side, one per job) (WP-93 #24);
//   - GoApply with CN_RECRUITMENT_INFO_MODE=off: an entry whose job is a
//     third-party posting is left out of every read (the user's own imports
//     and jobs they typed in stay), and it comes back when the mode allows
//     postings again (R-14, R41-1b).
// D1: nothing here applies anywhere; `applied` is only ever what the user did.

import { Prisma, type RATrackerEntry } from '../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { logger } from '../../services/LoggerService.js';
import {
  ALL_TRACKER_STATUSES,
  OUTCOME_STATUS,
  TRACKER_ERROR_CODES,
  TRACKER_EVENT_KINDS,
  type ApplicationArtifactView,
  type FollowUpView,
  type TrackerBulkBody,
  type TrackerCreateBody,
  type TrackerEntryView,
  type TrackerEventKind,
  type TrackerEventView,
  type TrackerExternalSnapshot,
  type TrackerJobView,
  type TrackerListQuery,
  type TrackerListResponse,
  type TrackerOffer,
  type TrackerOutcome,
  type TrackerPatchBody,
  type TrackerStatus,
  type WeeklyFacts,
} from './contract.js';
import { computeFollowUps, computeWeeklyFacts, weekRange, type FactEntry } from './facts.js';
import { isStageDetailAllowed, isStatusAllowed, isTerminal, outcomeForStatus, type TrackerMarket } from './stages.js';

// ── Errors (the legacy route maps them to its own response shapes) ────────

export class TrackerNotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly reason = TRACKER_ERROR_CODES.notFound;
  constructor() {
    super('Tracker entry not found');
    this.name = 'TrackerNotFoundError';
  }
}

export class TrackerDuplicateError extends Error {
  readonly code = 'conflict' as const;
  readonly reason = TRACKER_ERROR_CODES.duplicate;
  constructor() {
    super('Already in tracker');
    this.name = 'TrackerDuplicateError';
  }
}

export class TrackerInvalidInputError extends Error {
  readonly code = 'invalid_request' as const;
  constructor(
    msg: string,
    readonly reason: string = 'invalid_input',
  ) {
    super(msg);
    this.name = 'TrackerInvalidInputError';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export type TrackerDb = Pick<ExtendedPrismaClient, '$transaction' | 'rATrackerEntry' | 'rATrackerEvent' | 'rAApplicationArtifact' | 'rAJob'>;

/** What a writer uses inside its locked transaction. */
type TrackerTx = Pick<ExtendedPrismaClient, 'rATrackerEntry' | 'rATrackerEvent' | '$executeRaw'>;

/** What a tracker move teaches the feed (WP-32 affinity). */
export type TrackerAffinityKind = 'save' | 'applied';

/** The job fields the GoApply recruitment-info mode check reads (cn/jobs `CnPostingLike`). */
export interface TrackerPostingLike {
  market: string;
  visibility: string;
  ownerUserId: string | null;
}

/** The longest a tracker write waits for the feed signal: the move is already saved by then. */
export const FEED_SIGNAL_TIMEOUT_MS = 1_500;
/** Feed signals sent side by side after a bulk move. */
export const FEED_SIGNAL_BATCH = 20;

export interface TrackerCoreDeps {
  getDb?: () => Promise<TrackerDb>;
  now?: () => Date;
  /** Market of the current request (default: the brand context's market). */
  market?: () => TrackerMarket;
  /**
   * Feed affinity for a job that reached Saved or Applied. Called once per
   * change, after the write; a failure is logged and never blocks the move.
   * Absent → nothing is recorded (the process-wide `trackerCore` wires
   * `feedService.recordInteraction`).
   */
  recordInteraction?: ((userId: string, jobId: string, kind: TrackerAffinityKind) => Promise<unknown>) | null;
  /**
   * The user's own time zone (IANA), for "this week" and the CSV. Default:
   * `SeekerProfile.timezone` captured at signup, else the brand's fallback
   * (features/alerts `resolveTimeZone`: Asia/Shanghai on GoApply, UTC otherwise).
   */
  timeZone?: (userId: string) => Promise<string>;
  /** How long a write waits for the feed signal before answering (default `FEED_SIGNAL_TIMEOUT_MS`). */
  feedSignalTimeoutMs?: number;
  /**
   * Advisory-lock key of one user's entry for one job (default: jobs/detail
   * `trackerEntryLockKey`, so the tracker and the job page serialize on the same key).
   */
  lockKey?: (userId: string, jobId: string) => string | Promise<string>;
  /**
   * May this viewer see this job under the GoApply recruitment-info mode
   * (default: cn/jobs `cnPostingVisible`; non-cn jobs are always visible).
   */
  postingVisible?: (job: TrackerPostingLike, userId: string) => boolean | Promise<boolean>;
  /** Env the mode is read from (tests). */
  env?: EnvSource;
}

type EntryRow = RATrackerEntry;

interface JobRow {
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: string;
  applyUrl: string;
  closedAt: Date | null;
  archivedAt: Date | null;
  expiresAt: Date | null;
  // Read for the GoApply recruitment-info mode (absent on rows a test seeds without them).
  market?: string | null;
  visibility?: string | null;
  ownerUserId?: string | null;
}

const JOB_SELECT = {
  id: true,
  title: true,
  companyName: true,
  companyLogoUrl: true,
  location: true,
  workType: true,
  applyUrl: true,
  closedAt: true,
  archivedAt: true,
  expiresAt: true,
  market: true,
  visibility: true,
  ownerUserId: true,
} as const;

interface EventDraft {
  kind: TrackerEventKind;
  fromValue?: string | null;
  toValue?: string | null;
  payload?: Record<string, unknown> | null;
}

/** Rows a list may scan when it filters or sorts in memory (q, view=date). Per user, so small. */
const SCAN_CAP = 2000;
const EVENTS_CAP = 200;

// ── Pure helpers ──────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const parseDate = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);
const parseDay = (s: string | null | undefined): Date | null => (s ? new Date(`${s.slice(0, 10)}T00:00:00.000Z`) : null);

function asSnapshot(value: unknown): TrackerExternalSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || typeof v.companyName !== 'string') return null;
  return v as TrackerExternalSnapshot;
}

function asOffer(value: unknown): TrackerOffer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as TrackerOffer;
}

function asOutcome(value: string | null): TrackerOutcome | null {
  return value && value in OUTCOME_STATUS ? (value as TrackerOutcome) : null;
}

export function jobClosed(job: Pick<JobRow, 'closedAt' | 'archivedAt' | 'expiresAt'>, now: Date): boolean {
  return Boolean(job.closedAt || job.archivedAt || (job.expiresAt && job.expiresAt.getTime() < now.getTime()));
}

export function toTrackerView(row: EntryRow, job: JobRow | null | undefined, now: Date = new Date()): TrackerEntryView {
  const jobView: TrackerJobView | null = job
    ? {
        title: job.title,
        companyName: job.companyName,
        companyLogoUrl: job.companyLogoUrl ?? null,
        location: job.location ?? null,
        workType: job.workType ?? 'onsite',
        applyUrl: job.applyUrl,
        closed: jobClosed(job, now),
        visibility: job.visibility === 'private' ? 'private' : 'public',
      }
    : null;
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId ?? null,
    status: row.status as TrackerStatus,
    excitementStars: row.excitementStars ?? 0,
    maxSalary: row.maxSalary ?? null,
    maxSalaryCurrency: row.maxSalaryCurrency ?? null,
    notesMarkdown: row.notesMarkdown ?? null,
    dateSaved: row.dateSaved.toISOString(),
    dateApplied: iso(row.dateApplied),
    deadline: dateOnly(row.deadline),
    followUpAt: iso(row.followUpAt),
    appliedVia: row.appliedVia ?? null,
    linkedRunId: row.linkedRunId ?? null,
    job: jobView,
    externalSnapshot: asSnapshot(row.externalSnapshot),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: row.source ?? null,
    stageDetail: row.stageDetail ?? null,
    outcome: asOutcome(row.outcome ?? null),
    interviewAt: iso(row.interviewAt),
    offer: asOffer(row.offer),
    tailoredVariantId: row.tailoredVariantId ?? null,
    coverLetterId: row.coverLetterId ?? null,
  };
}

function emptyCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of ALL_TRACKER_STATUSES) out[s] = 0;
  return out;
}

function eventView(row: {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
}): TrackerEventView {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : null;
  const kind = (TRACKER_EVENT_KINDS as readonly string[]).includes(row.kind) ? (row.kind as TrackerEventKind) : 'field';
  return { id: row.id, kind, fromValue: row.fromValue, toValue: row.toValue, payload, at: row.createdAt.toISOString() };
}

function matchesQuery(view: TrackerEntryView, q: string): boolean {
  const needle = q.toLowerCase();
  const hay = [view.job?.title, view.job?.companyName, view.externalSnapshot?.title, view.externalSnapshot?.companyName, view.notesMarkdown]
    .filter((s): s is string => typeof s === 'string')
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

/** Newest applied date first, then newest saved date (the By date view). */
function byDate(a: TrackerEntryView, b: TrackerEntryView): number {
  const ka = a.dateApplied ?? a.dateSaved;
  const kb = b.dateApplied ?? b.dateSaved;
  return kb.localeCompare(ka);
}

/** The channels that record an application (ruling C11). */
export type ApplyVia = 'apply_click' | 'agent_open' | 'manual' | 'extension';

/** What `markApplied` did, and the token `undoApplied` takes to revert exactly that move. */
export interface ApplyMark {
  entryId: string;
  /** False when the entry was already at Applied or further along (nothing to undo). */
  changed: boolean;
  /** The event that recorded the move (null when nothing moved). */
  eventId: string | null;
}

/** What `markApplied` answers: the undo token plus `alreadyApplied`, the name every apply surface uses. */
export interface ApplyResult extends ApplyMark {
  /** `!changed`: the entry was already at Applied or further along, so no Undo is offered. */
  alreadyApplied: boolean;
}

export interface UndoAppliedOptions {
  /** The token markApplied returned; the precise way to undo. */
  mark?: ApplyMark;
  /** Without a token: only undo a move made through this channel. */
  via?: ApplyVia;
}

/** Without a token, "Undo · I didn't apply" only reverts a move this recent. */
export const UNDO_WINDOW_MS = 10 * 60_000;

const SOURCE_FOR_VIA: Record<ApplyVia, string> = { apply_click: 'feed', agent_open: 'agent', extension: 'extension', manual: 'manual' };

/** `payload.via` of a move the user made in the tracker itself (drawer, board, list, Add a job). */
export const VIA_TRACKER = 'tracker';

const isApplied = (status: string): boolean => status === 'applied' || status === 'applying';

/** The feed signal of an entry that just reached `status` (null: nothing to learn from this move). */
function affinityFor(status: string): TrackerAffinityKind | null {
  if (status === 'bookmarked') return 'save';
  return isApplied(status) ? 'applied' : null;
}

// ── The service ───────────────────────────────────────────────────────────

const defaultGetDb = async (): Promise<TrackerDb> => (await import('../../lib/prisma.js')).default;

// Other areas are reached through their public index, loaded on first use so
// importing the tracker does not pull the job, feed and GoApply routers in.
const defaultLockKey = async (userId: string, jobId: string): Promise<string> =>
  (await import('../jobs/detail/index.js')).trackerEntryLockKey(userId, jobId);
/** Production feed affinity (WP-32 `feedService.recordInteraction`). */
export const feedRecordInteraction = async (userId: string, jobId: string, kind: TrackerAffinityKind): Promise<void> => {
  const { feedService } = await import('../feed/index.js');
  await feedService.recordInteraction(userId, jobId, kind);
};

/**
 * A user's time zone from the tracker's own database handle; never throws
 * (the brand's fallback, else UTC, when it cannot be read).
 */
async function readTimeZone(getDb: () => Promise<TrackerDb>, userId: string): Promise<string> {
  let stored: string | null = null;
  try {
    const db = (await getDb()) as unknown as { seekerProfile?: { findUnique(args: { where: { userId: string }; select: { timezone: true } }): Promise<{ timezone: string | null } | null> } };
    stored = (await db.seekerProfile?.findUnique({ where: { userId }, select: { timezone: true } }))?.timezone ?? null;
  } catch (err) {
    logger.warn('TRACKER', 'time zone not read; using the fallback', { userId, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { resolveTimeZone } = await import('../alerts/index.js');
    return resolveTimeZone(stored, getCurrentBrandOrDefault().id);
  } catch {
    return 'UTC';
  }
}

export function createTrackerCore(deps: TrackerCoreDeps = {}) {
  const getDb = deps.getDb ?? defaultGetDb;
  const timeZoneOf = deps.timeZone ?? ((userId: string) => readTimeZone(getDb, userId));
  const clock = deps.now ?? (() => new Date());
  const marketOf = deps.market ?? (() => getCurrentBrandOrDefault().market as TrackerMarket);
  const lockKeyOf = deps.lockKey ?? defaultLockKey;
  const recordInteraction = deps.recordInteraction ?? null;
  const feedSignalTimeoutMs = deps.feedSignalTimeoutMs ?? FEED_SIGNAL_TIMEOUT_MS;
  const postingVisible =
    deps.postingVisible ??
    (async (job: TrackerPostingLike, userId: string): Promise<boolean> => (await import('../cn/jobs/index.js')).cnPostingVisible(job, userId, deps.env ?? process.env));

  /**
   * Is this entry's job hidden from the user right now? Only a GoApply (`cn`)
   * third-party posting while CN_RECRUITMENT_INFO_MODE is `off`. The user's
   * own import, an entry with no job (typed in by the user) and every non-cn
   * job are never hidden.
   */
  async function jobHidden(job: JobRow | null | undefined, userId: string): Promise<boolean> {
    if (!job || job.market !== 'cn') return false;
    return !(await postingVisible({ market: 'cn', visibility: job.visibility ?? 'public', ownerUserId: job.ownerUserId ?? null }, userId));
  }

  async function jobsById(db: TrackerDb, ids: (string | null)[]): Promise<Map<string, JobRow>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (unique.length === 0) return new Map();
    const jobs = (await db.rAJob.findMany({ where: { id: { in: unique } }, select: JOB_SELECT })) as JobRow[];
    return new Map(jobs.map((j) => [j.id, j]));
  }

  /** The rows the user may see, with their jobs (drops entries whose job the mode hides). */
  async function visibleRows(db: TrackerDb, userId: string, rows: EntryRow[]): Promise<{ rows: EntryRow[]; jobs: Map<string, JobRow> }> {
    const jobs = await jobsById(db, rows.map((r) => r.jobId));
    const cnJobs = [...jobs.values()].filter((j) => j.market === 'cn');
    if (cnJobs.length === 0) return { rows, jobs };
    const hidden = new Set<string>();
    for (const j of cnJobs) if (await jobHidden(j, userId)) hidden.add(j.id);
    return hidden.size === 0 ? { rows, jobs } : { rows: rows.filter((r) => !r.jobId || !hidden.has(r.jobId)), jobs };
  }

  async function views(db: TrackerDb, userId: string, rows: EntryRow[]): Promise<TrackerEntryView[]> {
    const visible = await visibleRows(db, userId, rows);
    const now = clock();
    return visible.rows.map((r) => toTrackerView(r, r.jobId ? visible.jobs.get(r.jobId) : null, now));
  }

  /** One entry's view for its owner (the caller already checked it is visible). */
  async function viewOf(db: TrackerDb, row: EntryRow): Promise<TrackerEntryView> {
    const job = row.jobId ? (await jobsById(db, [row.jobId])).get(row.jobId) : null;
    return toTrackerView(row, job, clock());
  }

  /** The user's live entry; 404 when it is missing, not theirs, or its job is hidden by the mode. */
  async function liveEntry(db: Pick<TrackerDb, 'rATrackerEntry' | 'rAJob'>, userId: string, id: string): Promise<EntryRow> {
    const row = await db.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) throw new TrackerNotFoundError();
    if (row.jobId) {
      const job = (await db.rAJob.findUnique({ where: { id: row.jobId }, select: { id: true, market: true, visibility: true, ownerUserId: true } })) as JobRow | null;
      if (await jobHidden(job, userId)) throw new TrackerNotFoundError();
    }
    return row;
  }

  /**
   * Run a write under the advisory lock of every (user, job) entry it may
   * move. Keys are taken in sorted order, so two bulk writes cannot deadlock.
   * Entries with no job (typed in by the user) have no shared key: one row,
   * one writer path, nothing to serialize against.
   */
  async function withEntryLocks<T>(db: TrackerDb, userId: string, jobIds: ReadonlyArray<string | null | undefined>, fn: (tx: TrackerTx) => Promise<T>): Promise<T> {
    const ids = [...new Set(jobIds.filter((j): j is string => Boolean(j)))].sort();
    const keys: string[] = [];
    for (const jobId of ids) keys.push(await lockKeyOf(userId, jobId));
    return db.$transaction(async (raw) => {
      const tx = raw as unknown as TrackerTx;
      for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      return fn(tx);
    });
  }

  /**
   * Job ids of this user's entries that the GoApply mode hides right now
   * (empty on RoboApply and whenever third-party postings are allowed).
   */
  async function hiddenJobIdsFor(db: TrackerDb, userId: string): Promise<string[]> {
    if (marketOf() !== 'cn') return [];
    const rows = await db.rATrackerEntry.findMany({ where: { userId, deletedAt: null, jobId: { not: null } }, select: { jobId: true }, take: SCAN_CAP });
    const jobs = await jobsById(db, rows.map((r) => r.jobId));
    const hidden: string[] = [];
    for (const job of jobs.values()) if (await jobHidden(job, userId)) hidden.push(job.id);
    return hidden;
  }

  /**
   * Tell the feed about a job that reached Saved or Applied. Never throws, and
   * never waits longer than the timeout: the move is already saved, so a slow
   * feed store must not hold back (or time out) the answer. A signal still
   * running after the timeout is left to finish on its own.
   */
  async function learn(userId: string, jobId: string | null | undefined, kind: TrackerAffinityKind | null): Promise<void> {
    if (!jobId || !kind || !recordInteraction) return;
    const failed = (err: unknown) =>
      logger.warn('TRACKER', 'feed affinity failed (the move is kept)', { userId, jobId, kind, error: err instanceof Error ? err.message : String(err) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Started inside the try: a reader that throws at once is swallowed like one that rejects.
      const signal = Promise.resolve(recordInteraction(userId, jobId, kind)).then(() => 'done' as const);
      const waited = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), feedSignalTimeoutMs);
      });
      if ((await Promise.race([signal, waited])) === 'timeout') {
        logger.warn('TRACKER', 'feed affinity is slow (the move is kept; not waiting)', { userId, jobId, kind, waitedMs: feedSignalTimeoutMs });
        signal.catch(failed);
      }
    } catch (err) {
      failed(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The feed signals of a bulk move: one per job and kind, sent side by side
   * in small batches, and no new batch is started once the wait has reached
   * twice the timeout (the rest are skipped and logged: affinity is a hint,
   * the moves are saved).
   */
  async function learnMany(userId: string, moved: ReadonlyArray<{ jobId: string | null; kind: TrackerAffinityKind | null }>): Promise<void> {
    if (!recordInteraction) return;
    const unique = new Map<string, { jobId: string; kind: TrackerAffinityKind }>();
    for (const m of moved) if (m.jobId && m.kind) unique.set(`${m.jobId}|${m.kind}`, { jobId: m.jobId, kind: m.kind });
    const items = [...unique.values()];
    const startedAt = Date.now();
    for (let i = 0; i < items.length; i += FEED_SIGNAL_BATCH) {
      if (i > 0 && Date.now() - startedAt >= 2 * feedSignalTimeoutMs) {
        logger.warn('TRACKER', 'feed affinity skipped for the rest of a bulk move (the moves are kept)', { userId, skipped: items.length - i });
        return;
      }
      await Promise.all(items.slice(i, i + FEED_SIGNAL_BATCH).map((m) => learn(userId, m.jobId, m.kind)));
    }
  }

  function assertStatus(market: TrackerMarket, status: string): asserts status is TrackerStatus {
    if (!isStatusAllowed(market, status)) {
      throw new TrackerInvalidInputError(`Status "${status}" is not a stage on this site.`, TRACKER_ERROR_CODES.invalidStatus);
    }
  }

  function eventRows(userId: string, entryId: string, events: EventDraft[], at: Date): Prisma.RATrackerEventCreateManyInput[] {
    return events.map((e) => ({
      entryId,
      userId,
      kind: e.kind,
      fromValue: e.fromValue ?? null,
      toValue: e.toValue ?? null,
      payload: (e.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      createdAt: at,
    }));
  }

  /**
   * Work out the update and the events for a patch. Pure apart from `now`.
   * Returns `null` data keys only for fields that change.
   */
  function planPatch(existing: EntryRow, body: TrackerPatchBody, market: TrackerMarket, now: Date) {
    const data: Prisma.RATrackerEntryUncheckedUpdateInput = {};
    const events: EventDraft[] = [];

    // Status and outcome move together.
    let status = existing.status;
    let outcome = existing.outcome ?? null;
    if (body.outcome !== undefined && body.outcome !== null) {
      const target = OUTCOME_STATUS[body.outcome];
      if (body.status !== undefined && body.status !== target) {
        throw new TrackerInvalidInputError('An outcome sets its own stage.', TRACKER_ERROR_CODES.invalidStatus);
      }
      status = target;
      outcome = body.outcome;
    } else {
      if (body.status !== undefined) {
        assertStatus(market, body.status);
        status = body.status;
        if (isTerminal(status)) outcome = outcomeForStatus(status);
        else outcome = null;
      }
      if (body.outcome === null) outcome = isTerminal(status) ? outcomeForStatus(status) : null;
    }
    assertStatus(market, status);

    if (status !== existing.status) {
      data.status = status;
      // A stage move made in the tracker (never undone by the job page's "Undo · I didn't apply").
      events.push({ kind: 'status', fromValue: existing.status, toValue: status, payload: { via: VIA_TRACKER } });
    }
    if (outcome !== (existing.outcome ?? null)) {
      data.outcome = outcome;
      events.push({ kind: 'outcome', fromValue: existing.outcome ?? null, toValue: outcome, payload: { stage: existing.status } });
    }

    // Stage detail: validated against the final status; dropped when it no longer fits.
    let stageDetail = existing.stageDetail ?? null;
    if (body.stageDetail !== undefined) {
      if (!isStageDetailAllowed(market, status, body.stageDetail)) {
        throw new TrackerInvalidInputError('That detail does not fit this stage.', TRACKER_ERROR_CODES.invalidStageDetail);
      }
      stageDetail = body.stageDetail;
    } else if (stageDetail !== null && !isStageDetailAllowed(market, status, stageDetail)) {
      stageDetail = null;
    }
    if (stageDetail !== (existing.stageDetail ?? null)) {
      data.stageDetail = stageDetail;
      events.push({ kind: 'stage', fromValue: existing.stageDetail ?? null, toValue: stageDetail });
    }

    // dateApplied: explicit value wins; otherwise the first move to applied stamps it.
    let dateApplied = existing.dateApplied;
    let stamped = false;
    if (body.dateApplied !== undefined) dateApplied = parseDate(body.dateApplied);
    else if ((status === 'applied' || status === 'applying') && !existing.dateApplied && status !== existing.status) {
      dateApplied = now;
      stamped = true;
    }
    if (iso(dateApplied) !== iso(existing.dateApplied)) {
      data.dateApplied = dateApplied;
      if (stamped) {
        const statusEvent = events.find((e) => e.kind === 'status');
        if (statusEvent) statusEvent.payload = { ...(statusEvent.payload ?? {}), stampedDateApplied: true };
      } else {
        events.push({ kind: 'field', fromValue: dateOnly(existing.dateApplied), toValue: dateOnly(dateApplied), payload: { field: 'dateApplied' } });
      }
    }

    const interviewAt = body.interviewAt !== undefined ? parseDate(body.interviewAt) : existing.interviewAt;
    if (iso(interviewAt) !== iso(existing.interviewAt)) {
      data.interviewAt = interviewAt;
      events.push({ kind: 'interview', fromValue: iso(existing.interviewAt), toValue: iso(interviewAt) });
    }

    const followUpAt = body.followUpAt !== undefined ? parseDate(body.followUpAt) : existing.followUpAt;
    if (iso(followUpAt) !== iso(existing.followUpAt)) {
      data.followUpAt = followUpAt;
      events.push({ kind: 'follow_up', fromValue: iso(existing.followUpAt), toValue: iso(followUpAt) });
    }

    if (body.offer !== undefined) {
      const before = JSON.stringify(existing.offer ?? null);
      const after = JSON.stringify(body.offer ?? null);
      if (before !== after) {
        // Clearing a `Json?` column needs Prisma.DbNull: Prisma 7 rejects a
        // literal null there (WP-64 REQ-64-05, Wave 5 gate).
        data.offer = body.offer === null ? Prisma.DbNull : (body.offer as Prisma.InputJsonValue);
        events.push({ kind: 'offer', toValue: body.offer === null ? 'cleared' : 'set' });
      }
    }

    const deadline = body.deadline !== undefined ? parseDay(body.deadline) : existing.deadline;
    if (dateOnly(deadline) !== dateOnly(existing.deadline)) {
      data.deadline = deadline;
      events.push({ kind: 'field', fromValue: dateOnly(existing.deadline), toValue: dateOnly(deadline), payload: { field: 'deadline' } });
    }

    if (body.notesMarkdown !== undefined && (body.notesMarkdown ?? null) !== (existing.notesMarkdown ?? null)) {
      data.notesMarkdown = body.notesMarkdown;
      // The note text stays in the entry; the event records only that it changed.
      events.push({ kind: 'field', payload: { field: 'notesMarkdown' } });
    }

    const scalar = (field: 'excitementStars' | 'maxSalary' | 'maxSalaryCurrency') => {
      const next = body[field];
      if (next === undefined) return;
      const prev = existing[field] ?? null;
      if ((next ?? null) === prev) return;
      (data as Record<string, unknown>)[field] = next;
      events.push({ kind: 'field', fromValue: prev === null ? null : String(prev), toValue: next === null ? null : String(next), payload: { field } });
    };
    scalar('excitementStars');
    scalar('maxSalary');
    scalar('maxSalaryCurrency');

    return { data, events };
  }

  /**
   * Save or apply for a job, creating the entry when there is none. Never moves
   * an entry backwards: saving changes no stage, and applying moves only from
   * Saved or from an ended entry (a re-application). Reports whether the stage
   * moved and the id of the event that recorded the move (the undo token).
   */
  async function upsertJobEntry(
    userId: string,
    jobId: string,
    args: { status: TrackerStatus; excitementStars?: number; appliedVia?: string | null; source?: string; applyMark?: boolean },
  ): Promise<{ view: TrackerEntryView; changed: boolean; moveEventId: string | null }> {
    const db = await getDb();
    const now = clock();
    const job = (await db.rAJob.findUnique({ where: { id: jobId }, select: { ...JOB_SELECT, salaryMax: true, salaryCurrency: true } })) as
      | (JobRow & { salaryMax: number | null; salaryCurrency: string | null })
      | null;
    if (!job || (await jobHidden(job, userId))) throw new TrackerNotFoundError();
    const via = args.appliedVia ?? null;
    const markPayload = args.applyMark ? { applyMark: true } : {};
    const applyTarget = isApplied(args.status);

    // Read and write under the (user, job) lock: a concurrent apply, save or undo waits here.
    const out = await withEntryLocks(db, userId, [jobId], async (tx) => {
      const existing = await tx.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } });
      if (existing) {
        const data: Prisma.RATrackerEntryUncheckedUpdateInput = {};
        const others: EventDraft[] = [];
        let move: EventDraft | null = null;
        const forward =
          args.status !== 'bookmarked' &&
          args.status !== existing.status &&
          (!applyTarget || existing.status === 'bookmarked' || isTerminal(existing.status));
        if (forward) {
          data.status = args.status;
          if (isTerminal(existing.status)) data.outcome = null;
          const stamp = applyTarget && !existing.dateApplied;
          if (stamp) data.dateApplied = now;
          if (applyTarget && args.appliedVia !== undefined && args.appliedVia !== existing.appliedVia) data.appliedVia = args.appliedVia;
          move = {
            kind: 'status',
            fromValue: existing.status,
            toValue: args.status,
            payload: stamp
              ? { stampedDateApplied: true, via, ...markPayload }
              : { via, previousAppliedVia: existing.appliedVia ?? null, ...markPayload },
          };
          if (isTerminal(existing.status)) others.push({ kind: 'outcome', fromValue: existing.outcome ?? null, toValue: null });
        }
        if (args.excitementStars !== undefined && args.excitementStars !== existing.excitementStars) {
          data.excitementStars = args.excitementStars;
          others.push({ kind: 'field', fromValue: String(existing.excitementStars), toValue: String(args.excitementStars), payload: { field: 'excitementStars' } });
        }
        if (Object.keys(data).length === 0) return { row: existing, changed: false, moveId: null as string | null, learned: null as TrackerAffinityKind | null };
        const u = await tx.rATrackerEntry.update({ where: { id: existing.id }, data });
        const moveRow = move ? await tx.rATrackerEvent.create({ data: eventRows(userId, existing.id, [move], now)[0]! }) : null;
        if (others.length > 0) await tx.rATrackerEvent.createMany({ data: eventRows(userId, existing.id, others, now) });
        return { row: u, changed: move !== null, moveId: moveRow?.id ?? null, learned: move ? affinityFor(args.status) : null };
      }

      const source = args.source ?? 'feed';
      const c = await tx.rATrackerEntry.create({
        data: {
          userId,
          jobId,
          status: args.status,
          excitementStars: args.excitementStars ?? 0,
          dateSaved: now,
          maxSalary: job.salaryMax ?? null,
          maxSalaryCurrency: job.salaryCurrency ?? null,
          dateApplied: applyTarget ? now : null,
          appliedVia: applyTarget ? (args.appliedVia ?? 'manual') : null,
          source,
        },
      });
      const ev = await tx.rATrackerEvent.create({
        data: eventRows(userId, c.id, [{ kind: 'created', toValue: args.status, payload: { source, via, ...markPayload } }], now)[0]!,
      });
      return { row: c, changed: true, moveId: ev.id as string | null, learned: affinityFor(args.status) };
    });

    // The extension service records its own feed signal for its saves and its
    // "I submitted" (features/extension/service.ts), so this channel is not counted twice.
    const extension = args.source === 'extension' || via === 'extension';
    if (!extension) await learn(userId, jobId, out.learned);
    return { view: toTrackerView(out.row, job, now), changed: out.changed, moveEventId: out.moveId };
  }

  const core = {
    async list(userId: string, query: TrackerListQuery = {}): Promise<TrackerListResponse> {
      const db = await getDb();
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = Math.max(query.offset ?? 0, 0);
      const statuses = query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];
      const where: Prisma.RATrackerEntryWhereInput = { userId, deletedAt: null };
      if (statuses.length > 0) where.status = { in: statuses };
      if (query.source) where.source = query.source;

      // GoApply, mode off: entries whose job is a third-party posting are left out of
      // every number and list (one indexed id query; skipped on RoboApply).
      const hiddenJobIds = await hiddenJobIdsFor(db, userId);
      const base: Prisma.RATrackerEntryWhereInput = hiddenJobIds.length
        ? { userId, deletedAt: null, OR: [{ jobId: null }, { jobId: { notIn: hiddenJobIds } }] }
        : { userId, deletedAt: null };
      Object.assign(where, base);

      const countRows = await db.rATrackerEntry.findMany({ where: base, select: { status: true } });
      const statusCounts = emptyCounts();
      for (const r of countRows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

      if (query.q || query.view === 'date') {
        const rows = await db.rATrackerEntry.findMany({ where, orderBy: { updatedAt: 'desc' }, take: SCAN_CAP });
        let all = await views(db, userId, rows);
        if (query.q) all = all.filter((v) => matchesQuery(v, query.q!));
        if (query.view === 'date') all.sort(byDate);
        return { entries: all.slice(offset, offset + limit), statusCounts, total: all.length };
      }

      const dir = query.sortDir ?? 'desc';
      const orderBy: Prisma.RATrackerEntryOrderByWithRelationInput =
        query.sortBy === 'dateApplied'
          ? { dateApplied: dir }
          : query.sortBy === 'deadline'
            ? { deadline: dir }
            : query.sortBy === 'excitement'
              ? { excitementStars: dir }
              : { updatedAt: dir };
      const [rows, total] = await Promise.all([
        db.rATrackerEntry.findMany({ where, orderBy, skip: offset, take: limit }),
        db.rATrackerEntry.count({ where }),
      ]);
      return { entries: await views(db, userId, rows), statusCounts, total };
    },

    async getById(userId: string, id: string): Promise<TrackerEntryView> {
      const db = await getDb();
      return viewOf(db, await liveEntry(db, userId, id));
    },

    async create(userId: string, body: TrackerCreateBody): Promise<TrackerEntryView> {
      const db = await getDb();
      const market = marketOf();
      const now = clock();
      if (!body.jobId && !body.externalSnapshot) throw new TrackerInvalidInputError('Missing jobId or externalSnapshot');
      const status = body.status ?? 'bookmarked';
      assertStatus(market, status);
      const stageDetail = body.stageDetail ?? null;
      if (!isStageDetailAllowed(market, status, stageDetail)) {
        throw new TrackerInvalidInputError('That detail does not fit this stage.', TRACKER_ERROR_CODES.invalidStageDetail);
      }
      type PaidJob = JobRow & { salaryMax?: number | null; salaryCurrency?: string | null };
      let job: PaidJob | null = null;
      if (body.jobId) {
        job = ((await db.rAJob.findUnique({ where: { id: body.jobId }, select: { ...JOB_SELECT, salaryMax: true, salaryCurrency: true } })) ?? null) as PaidJob | null;
        if (!job || (await jobHidden(job, userId))) throw new TrackerNotFoundError();
      }
      const applied = isApplied(status);
      const data: Prisma.RATrackerEntryUncheckedCreateInput = {
        userId,
        jobId: body.jobId ?? null,
        externalSnapshot: body.jobId ? undefined : (body.externalSnapshot as Prisma.InputJsonValue),
        status,
        outcome: isTerminal(status) ? outcomeForStatus(status) : null,
        stageDetail,
        excitementStars: body.excitementStars ?? 0,
        maxSalary: body.maxSalary ?? job?.salaryMax ?? null,
        maxSalaryCurrency: body.maxSalaryCurrency ?? job?.salaryCurrency ?? null,
        notesMarkdown: body.notesMarkdown ?? null,
        dateSaved: now,
        dateApplied: body.dateApplied ? new Date(body.dateApplied) : applied ? now : null,
        deadline: parseDay(body.deadline ?? null),
        followUpAt: parseDate(body.followUpAt ?? null),
        interviewAt: parseDate(body.interviewAt ?? null),
        appliedVia: applied ? 'manual' : null,
        source: body.source ?? (body.jobId ? 'feed' : 'manual'),
      };
      // Under the (user, job) lock the duplicate check and the insert are one step:
      // two concurrent adds (or an add racing the job page's Save) leave one live entry.
      const row = await withEntryLocks(db, userId, [body.jobId], async (tx) => {
        if (body.jobId) {
          // Only a live row blocks re-adding: a deleted entry must not 409 the same job forever.
          const collide = await tx.rATrackerEntry.findFirst({ where: { userId, jobId: body.jobId, deletedAt: null } });
          if (collide) throw new TrackerDuplicateError();
        }
        const created = await tx.rATrackerEntry.create({ data });
        await tx.rATrackerEvent.createMany({
          data: eventRows(userId, created.id, [{ kind: 'created', toValue: status, payload: { source: data.source ?? null, via: VIA_TRACKER } }], now),
        });
        return created;
      });
      await learn(userId, row.jobId, affinityFor(status));
      return toTrackerView(row, job, now);
    },

    async patch(userId: string, id: string, body: TrackerPatchBody): Promise<TrackerEntryView> {
      const db = await getDb();
      const market = marketOf();
      const now = clock();
      const seen = await liveEntry(db, userId, id);
      // Plan against the row as it is inside the lock (it may have moved since `seen` was read).
      const out = await withEntryLocks(db, userId, [seen.jobId], async (tx) => {
        const existing = seen.jobId ? await tx.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } }) : seen;
        if (!existing) throw new TrackerNotFoundError();
        const { data, events } = planPatch(existing, body, market, now);
        if (events.length === 0) return { row: existing, learned: null as TrackerAffinityKind | null };
        const updated = await tx.rATrackerEntry.update({ where: { id }, data });
        await tx.rATrackerEvent.createMany({ data: eventRows(userId, id, events, now) });
        return { row: updated, learned: updated.status !== existing.status ? affinityFor(updated.status) : null };
      });
      await learn(userId, out.row.jobId, out.learned);
      return viewOf(db, out.row);
    },

    /** Soft delete (the row stays for recovery and the 30-day purge, compliance retention). */
    async remove(userId: string, id: string): Promise<void> {
      const db = await getDb();
      await liveEntry(db, userId, id);
      await db.rATrackerEntry.update({ where: { id }, data: { deletedAt: clock() } });
    },

    async bulk(userId: string, body: TrackerBulkBody): Promise<{ updated: number; entries: TrackerEntryView[] }> {
      const db = await getDb();
      const owned = await db.rATrackerEntry.findMany({ where: { id: { in: body.ids }, userId, deletedAt: null } });
      // An entry whose job the GoApply mode hides is answered like one that is not the user's:
      // nothing in the request is changed, and the answer does not say which id it was.
      const seen = (await visibleRows(db, userId, owned)).rows;
      if (new Set(seen.map((e) => e.id)).size !== new Set(body.ids).size) {
        throw new TrackerInvalidInputError('Some ids not owned by user', 'not_owner');
      }
      const market = marketOf();
      const now = clock();
      const moved = await withEntryLocks(db, userId, seen.map((e) => e.jobId), async (tx) => {
        const existing = await tx.rATrackerEntry.findMany({ where: { id: { in: body.ids }, userId, deletedAt: null } });
        const learned: Array<{ jobId: string | null; kind: TrackerAffinityKind | null }> = [];
        for (const e of existing) {
          const p = planPatch(e, body.patch, market, now);
          if (p.events.length === 0) continue;
          const updated = await tx.rATrackerEntry.update({ where: { id: e.id }, data: p.data });
          await tx.rATrackerEvent.createMany({ data: eventRows(userId, e.id, p.events, now) });
          if (updated.status !== e.status) learned.push({ jobId: updated.jobId, kind: affinityFor(updated.status) });
        }
        return learned;
      });
      await learnMany(userId, moved);
      const rows = await db.rATrackerEntry.findMany({ where: { id: { in: body.ids }, userId } });
      return { updated: rows.length, entries: await views(db, userId, rows) };
    },

    /**
     * Idempotent save/apply for a job (legacy /v2/jobs/:id/save and /apply).
     * Saving never moves an entry backwards, and neither does applying: a
     * move to Applied happens only from Saved (or, as a re-application, from
     * an ended entry). An entry already at Applied or further along stays put.
     */
    async upsertForJob(
      userId: string,
      jobId: string,
      args: { status: TrackerStatus; excitementStars?: number; appliedVia?: string | null; source?: string },
    ): Promise<TrackerEntryView> {
      return (await upsertJobEntry(userId, jobId, args)).view;
    },

    /**
     * Apply-click, Ready to apply `open`, extension "I submitted", manual: the
     * entry moves to Applied at once (ruling C11). Returns the undo token:
     * `changed` is false when the click moved nothing (the entry was already
     * at Applied or further along), and `eventId` names the move to undo.
     */
    async markApplied(userId: string, jobId: string, via: ApplyVia): Promise<ApplyResult> {
      const out = await upsertJobEntry(userId, jobId, { status: 'applied', appliedVia: via, source: SOURCE_FOR_VIA[via], applyMark: true });
      return { entryId: out.view.id, changed: out.changed, eventId: out.moveEventId, alreadyApplied: !out.changed };
    },

    /**
     * "Undo · I didn't apply": reverts only the move that the matching
     * `markApplied` call made. With `mark` (the token markApplied returned) it
     * does nothing unless that exact move is still the entry's newest move.
     * Without a token it acts only on a move recorded by markApplied (through
     * `via`, when given) in the last 10 minutes. It restores the previous
     * stage and clears the applied date that move stamped. An entry the move
     * created is removed, unless the user has since added notes or edits, in
     * which case it goes back to Saved and keeps them.
     */
    async undoApplied(userId: string, jobId: string, opts: UndoAppliedOptions = {}): Promise<{ undone: boolean }> {
      const NOOP = { undone: false };
      if (opts.mark && (!opts.mark.changed || !opts.mark.eventId)) return NOOP;
      const db = await getDb();
      const now = clock();
      // Same lock as markApplied: the entry and its history are read after any
      // concurrent apply or stage move has finished, so one move is undone at most once.
      return withEntryLocks(db, userId, [jobId], async (tx) => {
        const entry = await tx.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } });
        if (!entry || !isApplied(entry.status)) return NOOP;
        if (opts.mark && opts.mark.entryId !== entry.id) return NOOP;
        const history = await tx.rATrackerEvent.findMany({
          where: { entryId: entry.id, userId },
          orderBy: { createdAt: 'desc' },
          take: EVENTS_CAP,
        });
        // Newest move first; on a timestamp tie a status move is newer than the creation.
        const moves = history
          .filter((e) => e.kind === 'status' || e.kind === 'created')
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Number(a.kind === 'created') - Number(b.kind === 'created'));
        // With a token, the move it names must still be the newest one (nothing moved the entry since).
        const last = opts.mark ? moves.find((e) => e.id === opts.mark!.eventId) : moves[0];
        if (!last || last.toValue !== entry.status) return NOOP;
        if (moves.some((e) => e.createdAt.getTime() > last.createdAt.getTime())) return NOOP;
        const payload = (last.payload && typeof last.payload === 'object' ? last.payload : {}) as Record<string, unknown>;
        if (!opts.mark) {
          if (payload.applyMark !== true) return NOOP;
          if (opts.via && payload.via !== opts.via) return NOOP;
          if (now.getTime() - last.createdAt.getTime() > UNDO_WINDOW_MS) return NOOP;
        }

        if (last.kind === 'created') {
          const touchedSince = history.some(
            (e) => e.id !== last.id && e.kind !== 'reminder' && e.kind !== 'status' && e.kind !== 'created' && e.createdAt.getTime() >= last.createdAt.getTime(),
          );
          if (!touchedSince) {
            await tx.rATrackerEntry.update({ where: { id: entry.id }, data: { deletedAt: now } });
            await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, [{ kind: 'status', fromValue: entry.status, toValue: null, payload: { undo: true, removed: true } }], now) });
            return { undone: true };
          }
          // The user has written into this entry since: keep it, as a saved job.
          await tx.rATrackerEntry.update({ where: { id: entry.id }, data: { status: 'bookmarked', dateApplied: null, appliedVia: null } });
          await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, [{ kind: 'status', fromValue: entry.status, toValue: 'bookmarked', payload: { undo: true } }], now) });
          return { undone: true };
        }

        const previous = (last.fromValue ?? 'bookmarked') as TrackerStatus;
        const data: Prisma.RATrackerEntryUncheckedUpdateInput = { status: previous };
        const events: EventDraft[] = [{ kind: 'status', fromValue: entry.status, toValue: previous, payload: { undo: true } }];
        if (payload.stampedDateApplied === true) {
          data.dateApplied = null;
          data.appliedVia = null;
        } else if (typeof payload.previousAppliedVia === 'string' || payload.previousAppliedVia === null) {
          data.appliedVia = payload.previousAppliedVia as string | null;
        }
        const restoredOutcome = outcomeForStatus(previous);
        if (restoredOutcome) {
          data.outcome = restoredOutcome;
          events.push({ kind: 'outcome', fromValue: entry.outcome ?? null, toValue: restoredOutcome, payload: { undo: true } });
        }
        await tx.rATrackerEntry.update({ where: { id: entry.id }, data });
        await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, events, now) });
        return { undone: true };
      });
    },

    /** WP-64 seam: write the user's own offer numbers (an `offer` event is recorded). */
    async updateOffer(userId: string, entryId: string, offer: TrackerOffer | null): Promise<void> {
      await core.patch(userId, entryId, { offer });
    },

    async events(userId: string, entryId: string): Promise<TrackerEventView[]> {
      const db = await getDb();
      await liveEntry(db, userId, entryId);
      const rows = await db.rATrackerEvent.findMany({
        where: { entryId, userId, kind: { not: 'reminder' } },
        orderBy: { createdAt: 'desc' },
        take: EVENTS_CAP,
      });
      return rows.map(eventView);
    },

    async addNote(userId: string, entryId: string, note: string): Promise<TrackerEventView> {
      const db = await getDb();
      await liveEntry(db, userId, entryId);
      const row = await db.rATrackerEvent.create({
        data: { entryId, userId, kind: 'note', payload: { text: note } as Prisma.InputJsonValue, createdAt: clock() },
      });
      return eventView(row);
    },

    async artifacts(userId: string, entryId: string): Promise<ApplicationArtifactView[]> {
      const db = await getDb();
      await liveEntry(db, userId, entryId);
      const rows = await db.rAApplicationArtifact.findMany({ where: { userId, trackerEntryId: entryId }, orderBy: { createdAt: 'desc' }, take: 100 });
      return rows.map((a) => ({
        id: a.id,
        kind: a.kind === 'resume' || a.kind === 'cover_letter' ? a.kind : 'other',
        fileName: a.fileName,
        format: a.format,
        sha256: a.fileSha256,
        via: a.channel,
        variantId: a.variantId ?? null,
        coverLetterId: a.coverLetterId ?? null,
        createdAt: a.createdAt.toISOString(),
      }));
    },

    async factEntries(userId: string): Promise<FactEntry[]> {
      const db = await getDb();
      const all = await db.rATrackerEntry.findMany({ where: { userId, deletedAt: null }, take: SCAN_CAP });
      const { rows, jobs } = await visibleRows(db, userId, all);
      return rows.map((r) => {
        const job = r.jobId ? jobs.get(r.jobId) : null;
        const snap = asSnapshot(r.externalSnapshot);
        return {
          id: r.id,
          status: r.status,
          dateApplied: r.dateApplied,
          followUpAt: r.followUpAt,
          interviewAt: r.interviewAt,
          deadline: r.deadline,
          companyName: job?.companyName ?? snap?.companyName ?? null,
          title: job?.title ?? snap?.title ?? null,
        };
      });
    },

    async followUps(userId: string): Promise<FollowUpView[]> {
      return computeFollowUps(await core.factEntries(userId), clock(), marketOf());
    },

    /**
     * The user's time zone. `preferred` is the zone the reader's browser
     * reports for this request: the page shows and groups dates in that zone,
     * so when it is a valid IANA name it wins. The stored zone is written once,
     * at signup, and is missing on older accounts; it (see
     * `TrackerCoreDeps.timeZone`) is the fallback.
     */
    async timeZone(userId: string, preferred?: string | null): Promise<string> {
      // A name longer than any IANA zone is not looked up.
      if (typeof preferred === 'string' && preferred.trim() && preferred.length <= 64) {
        try {
          // The same check alerts use (loaded on demand, like the stored-zone fallback above).
          const { isValidTimeZone } = await import('../alerts/index.js');
          if (isValidTimeZone(preferred)) return preferred.trim();
        } catch {
          // fall through to the stored zone
        }
      }
      return timeZoneOf(userId);
    },

    /**
     * The week's counts. `weekStart` is a Sunday (YYYY-MM-DD); its seven days
     * are the user's days, in their time zone (`preferredTimeZone` as in `timeZone`).
     */
    async weeklyFacts(userId: string, weekStart: string, preferredTimeZone?: string | null): Promise<WeeklyFacts> {
      const db = await getDb();
      const timeZone = await core.timeZone(userId, preferredTimeZone);
      const { start, end } = weekRange(weekStart, timeZone);
      const [entries, events] = await Promise.all([
        core.factEntries(userId),
        db.rATrackerEvent.findMany({
          where: { userId, kind: { in: ['status', 'outcome'] }, createdAt: { gte: start, lt: end } },
          select: { entryId: true, kind: true, toValue: true, createdAt: true },
          take: SCAN_CAP,
        }),
      ]);
      return computeWeeklyFacts(entries, events, weekStart, clock(), marketOf(), timeZone);
    },

    async summary(userId: string): Promise<{ byStatus: Record<string, number>; followUps: FollowUpView[] }> {
      const [{ statusCounts }, followUps] = await Promise.all([core.list(userId, { limit: 1 }), core.followUps(userId)]);
      const byStatus: Record<string, number> = {};
      for (const [k, v] of Object.entries(statusCounts)) if (v > 0) byStatus[k] = v;
      return { byStatus, followUps };
    },

    /** Every live entry, newest activity first (CSV export). */
    async exportEntries(userId: string): Promise<TrackerEntryView[]> {
      const db = await getDb();
      const rows = await db.rATrackerEntry.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: SCAN_CAP });
      return views(db, userId, rows);
    },
  };
  return core;
}

export type TrackerCore = ReturnType<typeof createTrackerCore>;

/** The process-wide instance (real Prisma, brand market from the request context, feed affinity on). */
export const trackerCore: TrackerCore = createTrackerCore({ recordInteraction: feedRecordInteraction });

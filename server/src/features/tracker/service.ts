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
// D1: nothing here applies anywhere; `applied` is only ever what the user did.

import { Prisma, type RATrackerEntry } from '../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
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

export interface TrackerCoreDeps {
  getDb?: () => Promise<TrackerDb>;
  now?: () => Date;
  /** Market of the current request (default: the brand context's market). */
  market?: () => TrackerMarket;
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

export interface UndoAppliedOptions {
  /** The token markApplied returned; the precise way to undo. */
  mark?: ApplyMark;
  /** Without a token: only undo a move made through this channel. */
  via?: ApplyVia;
}

/** Without a token, "Undo · I didn't apply" only reverts a move this recent. */
export const UNDO_WINDOW_MS = 10 * 60_000;

const SOURCE_FOR_VIA: Record<ApplyVia, string> = { apply_click: 'feed', agent_open: 'agent', extension: 'extension', manual: 'manual' };

// ── The service ───────────────────────────────────────────────────────────

const defaultGetDb = async (): Promise<TrackerDb> => (await import('../../lib/prisma.js')).default;

export function createTrackerCore(deps: TrackerCoreDeps = {}) {
  const getDb = deps.getDb ?? defaultGetDb;
  const clock = deps.now ?? (() => new Date());
  const marketOf = deps.market ?? (() => getCurrentBrandOrDefault().market as TrackerMarket);

  async function jobsById(db: TrackerDb, ids: (string | null)[]): Promise<Map<string, JobRow>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (unique.length === 0) return new Map();
    const jobs = (await db.rAJob.findMany({ where: { id: { in: unique } }, select: JOB_SELECT })) as JobRow[];
    return new Map(jobs.map((j) => [j.id, j]));
  }

  async function views(db: TrackerDb, rows: EntryRow[]): Promise<TrackerEntryView[]> {
    const jobs = await jobsById(db, rows.map((r) => r.jobId));
    const now = clock();
    return rows.map((r) => toTrackerView(r, r.jobId ? jobs.get(r.jobId) : null, now));
  }

  async function liveEntry(db: Pick<TrackerDb, 'rATrackerEntry'>, userId: string, id: string): Promise<EntryRow> {
    const row = await db.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) throw new TrackerNotFoundError();
    return row;
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
      events.push({ kind: 'status', fromValue: existing.status, toValue: status });
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
    if (!job) throw new TrackerNotFoundError();
    const existing = await db.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } });
    const via = args.appliedVia ?? null;
    const markPayload = args.applyMark ? { applyMark: true } : {};

    if (existing) {
      const data: Prisma.RATrackerEntryUncheckedUpdateInput = {};
      const others: EventDraft[] = [];
      let move: EventDraft | null = null;
      const applyTarget = args.status === 'applied' || args.status === 'applying';
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
      if (Object.keys(data).length === 0) return { view: toTrackerView(existing, job, now), changed: false, moveEventId: null };
      const out = await db.$transaction(async (tx) => {
        const u = await tx.rATrackerEntry.update({ where: { id: existing.id }, data });
        const moveRow = move ? await tx.rATrackerEvent.create({ data: eventRows(userId, existing.id, [move], now)[0]! }) : null;
        if (others.length > 0) await tx.rATrackerEvent.createMany({ data: eventRows(userId, existing.id, others, now) });
        return { u, moveId: moveRow?.id ?? null };
      });
      return { view: toTrackerView(out.u, job, now), changed: move !== null, moveEventId: out.moveId };
    }

    const applied = args.status === 'applied' || args.status === 'applying';
    const source = args.source ?? 'feed';
    const out = await db.$transaction(async (tx) => {
      const c = await tx.rATrackerEntry.create({
        data: {
          userId,
          jobId,
          status: args.status,
          excitementStars: args.excitementStars ?? 0,
          dateSaved: now,
          maxSalary: job.salaryMax ?? null,
          maxSalaryCurrency: job.salaryCurrency ?? null,
          dateApplied: applied ? now : null,
          appliedVia: applied ? (args.appliedVia ?? 'manual') : null,
          source,
        },
      });
      const ev = await tx.rATrackerEvent.create({
        data: eventRows(userId, c.id, [{ kind: 'created', toValue: args.status, payload: { source, via, ...markPayload } }], now)[0]!,
      });
      return { c, moveId: ev.id };
    });
    return { view: toTrackerView(out.c, job, now), changed: true, moveEventId: out.moveId };
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

      const countRows = await db.rATrackerEntry.findMany({ where: { userId, deletedAt: null }, select: { status: true } });
      const statusCounts = emptyCounts();
      for (const r of countRows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

      if (query.q || query.view === 'date') {
        const rows = await db.rATrackerEntry.findMany({ where, orderBy: { updatedAt: 'desc' }, take: SCAN_CAP });
        let all = await views(db, rows);
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
      return { entries: await views(db, rows), statusCounts, total };
    },

    async getById(userId: string, id: string): Promise<TrackerEntryView> {
      const db = await getDb();
      const row = await liveEntry(db, userId, id);
      return (await views(db, [row]))[0]!;
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
      let job: JobRow | null = null;
      if (body.jobId) {
        // Only a live row blocks re-adding: a deleted entry must not 409 the same job forever.
        const collide = await db.rATrackerEntry.findFirst({ where: { userId, jobId: body.jobId, deletedAt: null } });
        if (collide) throw new TrackerDuplicateError();
        job = ((await db.rAJob.findUnique({ where: { id: body.jobId }, select: { ...JOB_SELECT, salaryMax: true, salaryCurrency: true } })) ??
          null) as (JobRow & { salaryMax: number | null; salaryCurrency: string | null }) | null;
        if (!job) throw new TrackerNotFoundError();
      }
      const applied = status === 'applied' || status === 'applying';
      const salaryJob = job as (JobRow & { salaryMax?: number | null; salaryCurrency?: string | null }) | null;
      const data: Prisma.RATrackerEntryUncheckedCreateInput = {
        userId,
        jobId: body.jobId ?? null,
        externalSnapshot: body.jobId ? undefined : (body.externalSnapshot as Prisma.InputJsonValue),
        status,
        outcome: isTerminal(status) ? outcomeForStatus(status) : null,
        stageDetail,
        excitementStars: body.excitementStars ?? 0,
        maxSalary: body.maxSalary ?? salaryJob?.salaryMax ?? null,
        maxSalaryCurrency: body.maxSalaryCurrency ?? salaryJob?.salaryCurrency ?? null,
        notesMarkdown: body.notesMarkdown ?? null,
        dateSaved: now,
        dateApplied: body.dateApplied ? new Date(body.dateApplied) : applied ? now : null,
        deadline: parseDay(body.deadline ?? null),
        followUpAt: parseDate(body.followUpAt ?? null),
        interviewAt: parseDate(body.interviewAt ?? null),
        appliedVia: applied ? 'manual' : null,
        source: body.source ?? (body.jobId ? 'feed' : 'manual'),
      };
      const row = await db.$transaction(async (tx) => {
        const created = await tx.rATrackerEntry.create({ data });
        await tx.rATrackerEvent.createMany({
          data: eventRows(userId, created.id, [{ kind: 'created', toValue: status, payload: { source: data.source ?? null } }], now),
        });
        return created;
      });
      return toTrackerView(row, job, now);
    },

    async patch(userId: string, id: string, body: TrackerPatchBody): Promise<TrackerEntryView> {
      const db = await getDb();
      const market = marketOf();
      const now = clock();
      const existing = await liveEntry(db, userId, id);
      const { data, events } = planPatch(existing, body, market, now);
      let row = existing;
      if (events.length > 0) {
        row = await db.$transaction(async (tx) => {
          const updated = await tx.rATrackerEntry.update({ where: { id }, data });
          await tx.rATrackerEvent.createMany({ data: eventRows(userId, id, events, now) });
          return updated;
        });
      }
      return (await views(db, [row]))[0]!;
    },

    /** Soft delete (the row stays for recovery and the 30-day purge, compliance retention). */
    async remove(userId: string, id: string): Promise<void> {
      const db = await getDb();
      await liveEntry(db, userId, id);
      await db.rATrackerEntry.update({ where: { id }, data: { deletedAt: clock() } });
    },

    async bulk(userId: string, body: TrackerBulkBody): Promise<{ updated: number; entries: TrackerEntryView[] }> {
      const db = await getDb();
      const existing = await db.rATrackerEntry.findMany({ where: { id: { in: body.ids }, userId, deletedAt: null } });
      if (new Set(existing.map((e) => e.id)).size !== new Set(body.ids).size) {
        throw new TrackerInvalidInputError('Some ids not owned by user', 'not_owner');
      }
      const market = marketOf();
      const now = clock();
      const plans = existing.map((e) => ({ id: e.id, ...planPatch(e, body.patch, market, now) }));
      await db.$transaction(async (tx) => {
        for (const p of plans) {
          if (p.events.length === 0) continue;
          await tx.rATrackerEntry.update({ where: { id: p.id }, data: p.data });
          await tx.rATrackerEvent.createMany({ data: eventRows(userId, p.id, p.events, now) });
        }
      });
      const rows = await db.rATrackerEntry.findMany({ where: { id: { in: body.ids }, userId } });
      return { updated: rows.length, entries: await views(db, rows) };
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
    async markApplied(userId: string, jobId: string, via: ApplyVia): Promise<ApplyMark> {
      const out = await upsertJobEntry(userId, jobId, { status: 'applied', appliedVia: via, source: SOURCE_FOR_VIA[via], applyMark: true });
      return { entryId: out.view.id, changed: out.changed, eventId: out.moveEventId };
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
      const entry = await db.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } });
      if (!entry || (entry.status !== 'applied' && entry.status !== 'applying')) return NOOP;
      if (opts.mark && opts.mark.entryId !== entry.id) return NOOP;
      const history = await db.rATrackerEvent.findMany({
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
          await db.$transaction(async (tx) => {
            await tx.rATrackerEntry.update({ where: { id: entry.id }, data: { deletedAt: now } });
            await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, [{ kind: 'status', fromValue: entry.status, toValue: null, payload: { undo: true, removed: true } }], now) });
          });
          return { undone: true };
        }
        // The user has written into this entry since: keep it, as a saved job.
        await db.$transaction(async (tx) => {
          await tx.rATrackerEntry.update({ where: { id: entry.id }, data: { status: 'bookmarked', dateApplied: null, appliedVia: null } });
          await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, [{ kind: 'status', fromValue: entry.status, toValue: 'bookmarked', payload: { undo: true } }], now) });
        });
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
      await db.$transaction(async (tx) => {
        await tx.rATrackerEntry.update({ where: { id: entry.id }, data });
        await tx.rATrackerEvent.createMany({ data: eventRows(userId, entry.id, events, now) });
      });
      return { undone: true };
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
      const rows = await db.rATrackerEntry.findMany({ where: { userId, deletedAt: null }, take: SCAN_CAP });
      const jobs = await jobsById(db, rows.map((r) => r.jobId));
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

    async weeklyFacts(userId: string, weekStart: string): Promise<WeeklyFacts> {
      const db = await getDb();
      const { start, end } = weekRange(weekStart);
      const [entries, events] = await Promise.all([
        core.factEntries(userId),
        db.rATrackerEvent.findMany({
          where: { userId, kind: { in: ['status', 'outcome'] }, createdAt: { gte: start, lt: end } },
          select: { entryId: true, kind: true, toValue: true, createdAt: true },
          take: SCAN_CAP,
        }),
      ]);
      return computeWeeklyFacts(entries, events, weekStart, clock(), marketOf());
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
      return views(db, rows);
    },
  };
  return core;
}

export type TrackerCore = ReturnType<typeof createTrackerCore>;

/** The process-wide instance (real Prisma, brand market from the request context). */
export const trackerCore: TrackerCore = createTrackerCore();

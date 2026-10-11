// server/src/features/agent/service.ts — Ready to apply (WP-52; TASK_PLAN.md
// R-19; ARCH §3.7; PRODUCT_PLAN.md §5.8, F-AGENT-01…11, F-FILT-07).
//
// Settings and setup, the weekly list (cron and on demand), the queue and its
// state machine, kit preparation (credit proposal first, work on confirm, run
// by the `agent.prepare` worker), kit review decisions, Open application and
// its Undo, and the answer bank.
//
// D1: we prepare, the user submits. Nothing here calls an employer endpoint
// or claims a submission; `open` returns the employer URL for the user to open
// and moves the tracker entry exactly like "Apply on company site"
// (`jobDetailService.recordApplyClick`), with "Undo · I didn't apply".
// `userMarkedSubmitted` is set only by the extension when the user says so.
// D3: lists come from the user's own saved search and real fit scores; a job
// without a score never counts as "Good fit". AI steps run only when
// `aiAllowed(user)` and the brand's text model allow them; otherwise a kit is
// the user's own resume and their saved answers, with no model call.

import { CreditsExhaustedError } from '../../platform/credits/index.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import { resolveTimeZone } from '../alerts/index.js';
import { bankListable, cnListable } from '../feed/contract.js';
import {
  ACTIVE_QUEUE_STATES,
  AGENT_ERROR_CODES,
  CALIBRATION_MAX,
  CALIBRATION_REQUIRED,
  DEFAULT_AGENT_SETTINGS,
  KIT_ERROR_CODES,
  MAX_ACTIVE_QUEUE_ITEMS,
  PREPARABLE_STATES,
  QUEUE_TABS,
  READY_NOT_OPENED_STATES,
  TAB_STATES,
  type AgentSettings,
  type AgentSettingsResponse,
  type AgentSetupResponse,
  type AnswerBankItemView,
  type CalibrationEntry,
  type GenerateListResponse,
  type KitEventDetail,
  type KitEventView,
  type OpenApplicationResponse,
  type PrepareCreditLine,
  type PrepareProposal,
  type QueueAddedVia,
  type QueueItemDetail,
  type QueueItemView,
  type QueueListResponse,
  type QueueState,
  type QueueTab,
  type QuestionKeyView,
  type ReadyBadgeResponse,
  type SetupStep,
  type SetupStepResponse,
} from './contract.js';
import { defaultAgentDeps, type AgentDeps, type PreparePayload, type RecordFilesPayload } from './deps.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { storedListFilters } from './weekly.js';
import { customQuestionKey, isValidQuestionKey, questionDefFor, questionKeysFor } from './questionKeys.js';
import {
  effectiveSetupStep,
  kitFileName,
  letterNeeded,
  meetsMinTier,
  postAsksForCoverLetter,
  resumeHeadingName,
  setupMove,
  setupStepIndex,
  weekKeyFor,
} from './stateMachine.js';
import {
  JOB_SELECT,
  QUEUE_SELECT,
  isJobClosed,
  itemOrThrow,
  readCalibration,
  readDetail,
  recordKitNote,
  settingsFromRow,
  toAnswerView,
  toKitEventView,
  toQueueView,
  transitionItem,
  type AgentDb,
  type JobRow,
  type KitEventRow,
  type QueueRow,
  type SettingsRow,
} from './store.js';

const SETTINGS_SELECT = {
  userId: true,
  weeklyTarget: true,
  minTier: true,
  tailorEach: true,
  coverLetterMode: true,
  baseVariantId: true,
  fileNameStyle: true,
  setupStep: true,
  calibration: true,
  setupCompletedAt: true,
  searchProfileId: true,
  filterOverrides: true,
  createdAt: true,
  updatedAt: true,
} as const;

const EVENT_SELECT = { id: true, userId: true, queueItemId: true, fromState: true, toState: true, actor: true, kind: true, detail: true, createdAt: true } as const;

/** A JSON column's "no value": the database NULL (Prisma's `DbNull`, loaded lazily so the router stays cheap to import). */
async function dbNull(): Promise<typeof Prisma.DbNull> {
  return (await import('../../generated/prisma/client.js')).Prisma.DbNull;
}

const ANSWER_SELECT = { id: true, questionKey: true, questionText: true, answer: true, source: true, locale: true, lastUsedAt: true, updatedAt: true } as const;

const EXPIRABLE: readonly QueueState[] = ['picked', 'ready_for_review', 'approved', 'failed'];
const LIST_LIMIT = 200;
const PREVIEW_LIMIT = 50;
/** A kit still `preparing` after this long is swept to `failed` (the worker died or its work item went dead). */
export const PREPARE_STALE_AFTER_MS = 30 * 60_000;
const SWEEP_BATCH = 200;

function isConflict(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'conflict';
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

/** List page cursor: the last row's `updatedAt` and id (newest first). */
export function encodeListCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeListCursor(cursor: string | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const cut = raw.indexOf('|');
  const updatedAt = new Date(raw.slice(0, cut));
  const id = raw.slice(cut + 1);
  if (cut <= 0 || !id || Number.isNaN(updatedAt.getTime())) {
    throw new HttpError('invalid_request', 'That page link is not valid. Reload the list.', { reason: 'invalid_cursor' });
  }
  return { updatedAt, id };
}

/** A short code for why a step failed (stored in `lastError`; never a raw message). */
export function failureCode(err: unknown): string {
  if (err instanceof CreditsExhaustedError) return `credits_exhausted:${err.bucket}`;
  const e = err as { code?: unknown; details?: unknown } | null;
  const details = e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : null;
  const reason = typeof details?.reason === 'string' ? details.reason : null;
  const code = typeof e?.code === 'string' ? e.code : null;
  if (code === 'credits_exhausted' && typeof details?.bucket === 'string') return `credits_exhausted:${details.bucket}`;
  if (code && reason) return `${code}:${reason}`.slice(0, 80);
  return (code ?? 'failed').slice(0, 80);
}

function errorReason(err: unknown): string | null {
  const e = err as { details?: unknown } | null;
  const d = e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : null;
  if (typeof d?.code === 'string') return d.code;
  if (typeof d?.reason === 'string') return d.reason;
  return null;
}

function pendingOf(err: unknown): number | null {
  const e = err as { pending?: unknown; details?: unknown } | null;
  if (typeof e?.pending === 'number') return e.pending;
  const d = e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : null;
  return typeof d?.pending === 'number' ? d.pending : null;
}

function unverifiedError(pending: number): HttpError {
  return new HttpError('conflict', 'Check every highlighted detail in Verify details before you use this resume.', {
    reason: AGENT_ERROR_CODES.unverifiedClaims,
    pending,
  });
}

function notReady(message = 'This kit is not ready for that step yet.'): HttpError {
  return new HttpError('conflict', message, { reason: AGENT_ERROR_CODES.notReady });
}

type CreditUsage = Awaited<ReturnType<AgentDeps['creditUsage']>>;

/** A cost line with what is left and when it resets (only the cost when usage is unknown). */
function creditLine(usage: CreditUsage | null, bucket: PrepareCreditLine['bucket'], cost: number): PrepareCreditLine {
  const u = usage?.lines[bucket];
  return u ? { bucket, cost, remaining: u.remaining, window: u.window, resetsAt: u.resetsAt.toISOString() } : { bucket, cost };
}

/** What "Not right" ratings rule out or push back (keys from `nameKey`). */
export interface Dislikes {
  /** `title|company` of "Wrong job title" ratings: left out. */
  titleAtCompany: Set<string>;
  /** Titles rated "Wrong job title": picked last at other companies. */
  titles: Set<string>;
  /** Companies rated "Company I don't want": left out. */
  companies: Set<string>;
}

/** A title or a company name as it is compared: case, accents of width, punctuation and spacing do not count. */
export function nameKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Apply the user's "Not right" ratings to a best-fit-first list: leave out the
 * rated title at the rated company and the unwanted companies, and move the
 * rated title at other companies to the end (order otherwise kept). Pure.
 */
export function applyDislikes<T extends { title: string; company: { name: string } }>(items: readonly T[], dislikes: Dislikes): T[] {
  if (!dislikes.titleAtCompany.size && !dislikes.titles.size && !dislikes.companies.size) return [...items];
  const keep: T[] = [];
  const last: T[] = [];
  for (const item of items) {
    const title = nameKey(item.title);
    const company = nameKey(item.company?.name);
    if (company && dislikes.companies.has(company)) continue;
    if (dislikes.titleAtCompany.has(`${title}|${company}`)) continue;
    (dislikes.titles.has(title) ? last : keep).push(item);
  }
  return [...keep, ...last];
}

export interface GenerateListOptions {
  overrides?: Record<string, unknown>;
  more?: boolean;
  source: 'cron' | 'user' | 'setup';
}

export function createAgentService(overrides: Partial<AgentDeps> = {}) {
  const deps: AgentDeps = { ...defaultAgentDeps(), ...overrides };

  // ── Reads ──────────────────────────────────────────────────────────────

  async function settingsRow(db: AgentDb, userId: string): Promise<SettingsRow | null> {
    return (await db.rAAgentSettings.findUnique({ where: { userId }, select: SETTINGS_SELECT })) as SettingsRow | null;
  }

  async function timeZoneOf(db: AgentDb, userId: string): Promise<string> {
    const p = await db.seekerProfile.findFirst({ where: { userId }, select: { timezone: true } });
    return resolveTimeZone(p?.timezone ?? null, deps.brand().id);
  }

  /**
   * Jobs this user may see on this brand (market, own imports, the GoApply
   * recruitment-info mode). A public mainland posting with no usable apply
   * link is never prepared or listed here either (feed/sourceLine.ts
   * `cnListable`), and neither is a recruiter-bank row whose bank has no
   * posting page (`bankListable`): Ready to apply ends at the user opening
   * that link (D1).
   */
  async function visibleJobs(db: AgentDb, userId: string, ids: readonly string[]): Promise<Map<string, JobRow>> {
    if (!ids.length) return new Map();
    const market = deps.brand().market;
    const rows = (await db.rAJob.findMany({ where: { id: { in: [...new Set(ids)] } }, select: JOB_SELECT })) as JobRow[];
    const mine = rows.filter((j) => j.market === market && (j.visibility !== 'private' || j.ownerUserId === userId) && cnListable(j) && bankListable(j));
    const visible = await deps.visibleJobs(mine, userId);
    return new Map(visible.map((j) => [j.id, j]));
  }

  async function views(db: AgentDb, userId: string, rows: QueueRow[]): Promise<QueueItemView[]> {
    const jobs = await visibleJobs(
      db,
      userId,
      rows.map((r) => r.jobId),
    );
    return rows.filter((r) => jobs.has(r.jobId)).map((r) => toQueueView(r, jobs.get(r.jobId)!));
  }

  async function view(db: AgentDb, userId: string, row: QueueRow): Promise<QueueItemView> {
    const jobs = await visibleJobs(db, userId, [row.jobId]);
    return toQueueView(row, jobs.get(row.jobId) ?? null);
  }

  async function activeCount(db: AgentDb, userId: string): Promise<number> {
    return db.rAAgentQueueItem.count({ where: { userId, state: { in: [...ACTIVE_QUEUE_STATES] } } });
  }

  async function events(db: AgentDb, itemId: string): Promise<KitEventRow[]> {
    return (await db.rAAgentKitEvent.findMany({
      where: { queueItemId: itemId },
      orderBy: { createdAt: 'asc' },
      select: EVENT_SELECT,
    })) as KitEventRow[];
  }

  /**
   * "Use" decisions made since the kit last became ready. A revision resets
   * them: a new draft, or a 'revise' decision on a part (only a 'use' after
   * the latest revise of that part counts).
   */
  function decisionsSinceReady(rows: KitEventRow[]): { resume: boolean; letter: boolean } {
    let start = -1;
    rows.forEach((r, i) => {
      if (r.toState === 'ready_for_review' && r.fromState !== 'ready_for_review') start = i;
    });
    const out = { resume: false, letter: false };
    for (const r of rows.slice(start + 1)) {
      if (r.fromState !== r.toState) continue;
      const d = readDetail(r.detail);
      if (d.part !== 'resume' && d.part !== 'letter') continue;
      if (d.decision === 'use') out[d.part] = true;
      else if (d.decision === 'revise') out[d.part] = false;
    }
    return out;
  }

  async function baseVariantFor(db: AgentDb, userId: string, settings: AgentSettings): Promise<{ id: string } | null> {
    if (settings.baseVariantId) {
      const chosen = await db.rAResumeVariant.findFirst({ where: { id: settings.baseVariantId, userId }, select: { id: true } });
      if (chosen) return chosen;
    }
    const primary = await db.rAResumeVariant.findFirst({ where: { userId, isPrimary: true }, select: { id: true }, orderBy: { lastEditedAt: 'desc' } });
    if (primary) return primary;
    return db.rAResumeVariant.findFirst({ where: { userId, kind: 'base' }, select: { id: true }, orderBy: { lastEditedAt: 'desc' } });
  }

  // ── Settings ───────────────────────────────────────────────────────────

  /** The settings as the page reads them: the weekly choices plus which search the lists come from. */
  function settingsView(row: SettingsRow | null): AgentSettingsResponse {
    return { ...settingsFromRow(row), listFilters: storedListFilters(row) };
  }

  async function getSettings(userId: string): Promise<AgentSettingsResponse> {
    const db = await deps.getDb();
    return settingsView(await settingsRow(db, userId));
  }

  async function putSettings(userId: string, patch: Partial<AgentSettings> & { filterOverrides?: null }): Promise<AgentSettingsResponse> {
    const db = await deps.getDb();
    if (patch.baseVariantId) {
      const owned = await db.rAResumeVariant.findFirst({ where: { id: patch.baseVariantId, userId }, select: { id: true } });
      if (!owned) throw new HttpError('invalid_request', 'That resume was not found.', { reason: 'resume_not_found' });
    }
    const { filterOverrides, ...settings } = patch;
    const data = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as Partial<AgentSettings>;
    // `filterOverrides: null`: forget the filter changes made inside Ready to apply (lists use the main search again).
    const clear = filterOverrides === null ? { filterOverrides: await dbNull() } : {};
    const row = (await db.rAAgentSettings.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_AGENT_SETTINGS, ...data },
      update: { ...data, ...clear },
      select: SETTINGS_SELECT,
    })) as SettingsRow;
    return settingsView(row);
  }

  // ── Setup (F-AGENT-02) ─────────────────────────────────────────────────

  async function setup(userId: string): Promise<AgentSetupResponse> {
    const db = await deps.getDb();
    const brand = deps.brand();
    const [row, extensionAvailable, answersCount, extensionConnected] = await Promise.all([
      settingsRow(db, userId),
      deps.flag('extension', userId).catch(() => false),
      db.rAAnswerBankItem.count({ where: { userId } }),
      deps.extensionConnected(userId, brand.id).catch(() => false),
    ]);
    let profileMissing: Array<{ key: string; label: string }> = [];
    try {
      profileMissing = await deps.profileMissing(userId);
    } catch (err) {
      logger.warn('AGENT', 'profile completeness unavailable', { error: err instanceof Error ? err.message : String(err) });
    }
    const calibration = readCalibration(row?.calibration);
    const step: SetupStep = row?.setupCompletedAt ? 'done' : effectiveSetupStep(row?.setupStep, extensionAvailable);
    return {
      step,
      checks: {
        profileMissing,
        calibrationDone: calibration.length >= CALIBRATION_REQUIRED,
        reportReady: false,
        extensionConnected,
        calibrationCount: calibration.length,
        answersCount,
        // Progress, not the row: rating jobs creates the row with defaults before the weekly step is reached.
        weeklySaved: Boolean(row?.setupCompletedAt) || setupStepIndex(step) > setupStepIndex('weekly'),
        extensionAvailable,
      },
      completedAt: row?.setupCompletedAt ? row.setupCompletedAt.toISOString() : null,
    };
  }

  async function calibrate(userId: string, entry: CalibrationEntry): Promise<AgentSetupResponse> {
    const db = await deps.getDb();
    if (!(await visibleJobs(db, userId, [entry.jobId])).has(entry.jobId)) {
      throw new HttpError('not_found', 'Job not found.', { reason: AGENT_ERROR_CODES.jobNotFound });
    }
    const row = await settingsRow(db, userId);
    const next = [entry, ...readCalibration(row?.calibration).filter((c) => c.jobId !== entry.jobId)].slice(0, CALIBRATION_MAX);
    await db.rAAgentSettings.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_AGENT_SETTINGS, calibration: next },
      update: { calibration: next },
    });
    return setup(userId);
  }

  /**
   * "Check your search" has nothing to rate: the jobs list is off for this
   * account (GoApply with third-party postings off), the search matches no
   * job, or every job it matches is rated or on the list already. Then the
   * step cannot ask for 3 ratings (a wizard nobody can finish), so it may be
   * left for later. A list that cannot be read counts the same: the user
   * cannot rate what they cannot see.
   */
  async function nothingToRate(userId: string): Promise<boolean> {
    try {
      return (await suggestions(userId, { limit: 1 })).items.length === 0;
    } catch (err) {
      logger.warn('AGENT', 'calibration suggestions unavailable; the step may be left for later', { userId, error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  }

  async function completeStep(
    userId: string,
    input: { step: 'profile' | 'calibrate' | 'answers' | 'weekly' | 'extension'; action: 'complete' | 'skip' },
  ): Promise<SetupStepResponse> {
    const db = await deps.getDb();
    // "Get the extension" can always be skipped; "Check your search" only when there is nothing to rate (below).
    if (input.action === 'skip' && input.step !== 'extension' && input.step !== 'calibrate') {
      throw new HttpError('conflict', 'This step cannot be skipped.', { reason: AGENT_ERROR_CODES.stepNotSkippable });
    }
    const row = await settingsRow(db, userId);
    const calibrated = readCalibration(row?.calibration).length >= CALIBRATION_REQUIRED;
    const extensionAvailable = await deps.flag('extension', userId).catch(() => false);
    const move = setupMove(row?.setupStep, input.step, extensionAvailable);
    if (move.kind === 'out_of_order') {
      throw new HttpError('conflict', 'Finish the earlier setup steps first.', { reason: AGENT_ERROR_CODES.stepOutOfOrder, step: move.current });
    }
    // Three ratings, unless there is nothing to rate ("Rate jobs later"): checked once, only when it decides something.
    let ratingsWaived: boolean | null = null;
    const mayLeaveRatings = async (): Promise<boolean> => calibrated || (ratingsWaived ??= await nothingToRate(userId));
    if (input.step === 'calibrate' && move.kind === 'advance' && !(await mayLeaveRatings())) {
      throw new HttpError('conflict', `Rate ${CALIBRATION_REQUIRED} jobs first.`, { reason: AGENT_ERROR_CODES.calibrationIncomplete });
    }
    // An earlier step is a no-op, except that a stored step already shown as 'done' (the extension
    // capability went away while the user was on that step) still finishes setup.
    const next: SetupStep = move.kind === 'advance' ? move.next : move.current;
    const finishing = next === 'done' && !row?.setupCompletedAt;
    if (move.kind === 'noop' && !finishing) return { ...(await setup(userId)), firstList: null };
    if (finishing && !(await mayLeaveRatings())) {
      throw new HttpError('conflict', `Rate ${CALIBRATION_REQUIRED} jobs first.`, { reason: AGENT_ERROR_CODES.calibrationIncomplete, step: 'calibrate' });
    }
    const data = { setupStep: next, ...(finishing ? { setupCompletedAt: deps.now() } : {}) };
    await db.rAAgentSettings.upsert({ where: { userId }, create: { userId, ...DEFAULT_AGENT_SETTINGS, ...data }, update: data });
    let firstList: GenerateListResponse | null = null;
    if (finishing) {
      try {
        firstList = await generateList(userId, { source: 'setup' });
      } catch (err) {
        logger.warn('AGENT', 'first weekly list failed after setup', { userId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ...(await setup(userId)), firstList };
  }

  // ── Suggestions and the weekly list (F-AGENT-02 step 2, F-AGENT-04) ────

  async function excludedJobIds(db: AgentDb, userId: string, row: SettingsRow | null): Promise<{ queued: Set<string>; down: Set<string>; rated: Set<string> }> {
    const queued = await db.rAAgentQueueItem.findMany({ where: { userId }, select: { jobId: true } });
    const calibration = readCalibration(row?.calibration);
    return {
      queued: new Set(queued.map((q) => q.jobId)),
      down: new Set(calibration.filter((c) => c.verdict === 'down').map((c) => c.jobId)),
      rated: new Set(calibration.map((c) => c.jobId)),
    };
  }

  /**
   * What the user's "Not right" ratings say beyond the one job they were given
   * for. A rating used to keep only that job id off the list, so "Wrong job
   * title" on a post did nothing about the same title at the same company
   * posted for another city. Now:
   *   - "Wrong job title": that title at that company is left out, and the
   *     title at other companies is picked last (after every other job);
   *   - "Company I don't want": that company is left out.
   * Only the user's own ratings are read; nothing is inferred from them.
   */
  async function dislikesOf(db: AgentDb, row: SettingsRow | null): Promise<Dislikes> {
    const out: Dislikes = { titleAtCompany: new Set(), titles: new Set(), companies: new Set() };
    const down = readCalibration(row?.calibration).filter((c) => c.verdict === 'down' && (c.reason === 'wrong_title' || c.reason === 'company'));
    if (!down.length) return out;
    const jobs = (await db.rAJob.findMany({ where: { id: { in: [...new Set(down.map((c) => c.jobId))] } }, select: { id: true, title: true, companyName: true } })) as Array<{
      id: string;
      title: string;
      companyName: string;
    }>;
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const c of down) {
      const job = byId.get(c.jobId);
      if (!job) continue;
      const title = nameKey(job.title);
      const company = nameKey(job.companyName);
      if (c.reason === 'company') {
        if (company) out.companies.add(company);
      } else if (title) {
        out.titles.add(title);
        if (company) out.titleAtCompany.add(`${title}|${company}`);
      }
    }
    return out;
  }

  /** Top-fit jobs not in the list yet (calibration "Show 3 more", "Add jobs"). */
  async function suggestions(userId: string, input: { limit?: number; exclude?: string }) {
    const db = await deps.getDb();
    if (!(await deps.flag('jobs.feed', userId))) return { items: [] };
    const limit = input.limit ?? 3;
    const skip = new Set((input.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const row = await settingsRow(db, userId);
    const ex = await excludedJobIds(db, userId, row);
    const dislikes = await dislikesOf(db, row);
    const preview = await deps.feedPreview(userId, { sort: 'best_fit', limit: PREVIEW_LIMIT });
    const items = applyDislikes(
      preview
        .filter((j) => !skip.has(j.jobId) && !ex.queued.has(j.jobId) && !ex.rated.has(j.jobId))
        .filter((j) => !j.tracker || j.tracker.status === 'bookmarked'),
      dislikes,
    ).slice(0, limit);
    return { items };
  }

  async function insertItem(
    db: AgentDb,
    userId: string,
    jobId: string,
    weekKey: string,
    addedVia: QueueAddedVia,
    actor: 'user' | 'system',
  ): Promise<QueueRow | null> {
    try {
      return await db.$transaction(async (tx) => {
        const row = (await tx.rAAgentQueueItem.create({ data: { userId, jobId, weekKey, addedVia, state: 'picked' }, select: QUEUE_SELECT })) as QueueRow;
        await tx.rAAgentKitEvent.create({ data: { userId, queueItemId: row.id, fromState: null, toState: 'picked', actor, kind: 'transition', detail: { weekKey, via: addedVia } } });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return null; // already in the list (another request or the cron)
      throw err;
    }
  }

  /**
   * The filters a list is built with, on top of the user's active search
   * (SR-52-1): the saved search `searchProfileId` names when it is not the
   * active one, then the filter changes made inside Ready to apply — the ones
   * this request carries (`explicit`), else the ones kept from last time.
   * A change with the value `null` removes that filter of the search (the
   * filter patch convention: removed → null). Kept filters that no longer
   * parse are left out and never block a list; filters the request itself
   * carries are refused (422) instead.
   */
  async function listFilters(
    userId: string,
    row: SettingsRow | null,
    explicit: Record<string, unknown> | undefined,
  ): Promise<{ overrides: Record<string, unknown> | undefined; filtersDiffer: boolean }> {
    const stored = storedListFilters(row);
    const patch = explicit ?? stored.overrides ?? undefined;
    // `null` → the key is taken out of the search's filters (an `undefined` value drops it when the set is parsed).
    const changes = patch ? Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v])) : undefined;
    if (!changes && !stored.searchProfileId) return { overrides: undefined, filtersDiffer: false };
    const market = deps.brand().market;
    const active = await deps.activeSearch(userId);
    let overrides = changes;
    if (stored.searchProfileId && stored.searchProfileId !== active.id) {
      const other = await deps.searchProfile(userId, stored.searchProfileId).catch(() => null);
      // Another saved search replaces the active one's filters: its own keys, and none of the active search's.
      if (other) overrides = { ...Object.fromEntries(Object.keys(active.filters).map((k) => [k, undefined])), ...other.filters, ...(changes ?? {}) };
    }
    if (!overrides) return { overrides: undefined, filtersDiffer: false };
    if (!(await deps.filtersValid(active.filters, overrides, market))) {
      if (explicit) throw new HttpError('invalid_request', 'The filters are not valid.', { reason: 'invalid_filters' });
      logger.warn('AGENT', 'kept list filters no longer parse; the list uses the main search', { userId });
      return { overrides: undefined, filtersDiffer: false };
    }
    return { overrides, filtersDiffer: await deps.filtersDiffer(active.filters, overrides, market) };
  }

  /**
   * Build this week's list: jobs with a real fit at or above `minTier`, not
   * already in the list or in Applications, up to the weekly target (a
   * target, never a cap) and the 50 active items limit. The jobs come from the
   * active saved search with Ready to apply's own filter changes on top
   * (`listFilters`); changes a user request carries are kept for the next
   * lists, the weekly one included.
   */
  async function generateList(userId: string, options: GenerateListOptions): Promise<GenerateListResponse> {
    const db = await deps.getDb();
    const now = deps.now();
    const weekKey = weekKeyFor(now, await timeZoneOf(db, userId));
    const empty = (reason: GenerateListResponse['reason'], filtersDiffer = false): GenerateListResponse => ({
      weekKey,
      added: 0,
      items: [],
      filtersDiffer,
      reason,
    });
    const row = await settingsRow(db, userId);
    const explicit = options.overrides && Object.keys(options.overrides).length ? options.overrides : undefined;
    const { overrides, filtersDiffer } = await listFilters(userId, row, explicit);
    // "No, only this list": the change is Ready to apply's own from now on (next week's list too).
    if (explicit && options.source === 'user') {
      const kept = JSON.parse(JSON.stringify(explicit)) as Prisma.InputJsonValue;
      await db.rAAgentSettings.upsert({ where: { userId }, create: { userId, ...DEFAULT_AGENT_SETTINGS, filterOverrides: kept }, update: { filterOverrides: kept }, select: { userId: true } });
    }
    if (!(await deps.flag('jobs.feed', userId))) return empty('no_feed', filtersDiffer);

    const settings = settingsFromRow(row);
    const room = MAX_ACTIVE_QUEUE_ITEMS - (await activeCount(db, userId));
    if (room <= 0) return empty('queue_full', filtersDiffer);
    const thisWeek = await db.rAAgentQueueItem.count({ where: { userId, weekKey, addedVia: 'weekly' } });
    const want = Math.min(room, options.more ? settings.weeklyTarget : settings.weeklyTarget - thisWeek);
    if (want <= 0) return empty('target_reached', filtersDiffer);

    const ex = await excludedJobIds(db, userId, row);
    const dislikes = await dislikesOf(db, row);
    const preview = await deps.feedPreview(userId, { filters: overrides as never, sort: 'best_fit', limit: PREVIEW_LIMIT });
    const picks = applyDislikes(
      preview
        .filter((j) => j.fit && meetsMinTier(j.fit.tier, settings.minTier))
        .filter((j) => !ex.queued.has(j.jobId) && !ex.down.has(j.jobId))
        .filter((j) => !j.tracker || j.tracker.status === 'bookmarked'),
      dislikes,
    ).slice(0, want);

    const created: QueueRow[] = [];
    for (const job of picks) {
      const r = await insertItem(db, userId, job.jobId, weekKey, 'weekly', options.source === 'cron' ? 'system' : 'user');
      if (r) created.push(r);
    }
    // A list the user just asked for needs no "your list is ready" notice: record it as handled.
    if (created.length && options.source !== 'cron') {
      await recordKitNote(db, created[0]!, 'system', { notice: 'ready_list_ready', sent: false, weekKey });
    }
    return {
      weekKey,
      added: created.length,
      items: await views(db, userId, created),
      filtersDiffer,
      reason: created.length ? null : 'no_matches',
    };
  }

  /**
   * F-FILT-07: "Use this for your main search too?" → yes. Patches the active
   * saved search; the changes are the main search's now, so Ready to apply
   * keeps none of its own.
   */
  async function saveToMain(userId: string, input: { filters: Record<string, unknown>; version: number }) {
    const active = await deps.activeSearch(userId);
    const saved = await deps.patchSearch(userId, active.id, input.version, input.filters);
    const db = await deps.getDb();
    await db.rAAgentSettings.updateMany({ where: { userId }, data: { filterOverrides: await dbNull() } });
    return saved;
  }

  // ── Queue (F-AGENT-04/05/08) ───────────────────────────────────────────

  /** Kits whose post is gone become `expired` (flagged with Remove); preparing kits are left to finish. */
  async function expireClosed(db: AgentDb, rows: QueueRow[], jobs: Map<string, JobRow>): Promise<QueueRow[]> {
    const out: QueueRow[] = [];
    for (const r of rows) {
      const job = jobs.get(r.jobId);
      if (job && isJobClosed(job) && (EXPIRABLE as readonly string[]).includes(r.state)) {
        try {
          out.push(await transitionItem(db, r, 'expired', { actor: 'system', detail: { error: 'job_closed' } }));
          continue;
        } catch (err) {
          logger.debug('AGENT', 'expire skipped', { id: r.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      out.push(r);
    }
    return out;
  }

  /**
   * One page of the list, newest change first. The tab / state / week filter
   * is applied in the query before the page limit, `cursor` continues after
   * the last row of the previous page (`nextCursor`), and `counts` are counted
   * per tab over all the user's items (not just this page).
   */
  async function listQueue(
    userId: string,
    query: { state?: QueueState; weekKey?: string; tab?: QueueTab; cursor?: string; limit?: number },
  ): Promise<QueueListResponse> {
    const db = await deps.getDb();
    const states = query.state ? [query.state] : query.tab ? [...TAB_STATES[query.tab]] : null;
    const limit = Math.min(Math.max(query.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
    const after = decodeListCursor(query.cursor);
    const page = (await db.rAAgentQueueItem.findMany({
      where: {
        userId,
        ...(states ? { state: { in: states } } : {}),
        ...(query.weekKey ? { weekKey: query.weekKey } : {}),
        ...(after ? { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: QUEUE_SELECT,
    })) as QueueRow[];
    const last = page.length === limit ? page[page.length - 1]! : null;
    const jobs = await visibleJobs(
      db,
      userId,
      page.map((r) => r.jobId),
    );
    const fresh = await expireClosed(
      db,
      page.filter((r) => jobs.has(r.jobId)),
      jobs,
    );
    // A kit that just expired belongs to another tab now.
    const picked = fresh.filter((r) => !states || states.includes(r.state as QueueState));
    const counted = await Promise.all(
      QUEUE_TABS.map((t) => db.rAAgentQueueItem.count({ where: { userId, state: { in: [...TAB_STATES[t]] } } })),
    );
    const counts = Object.fromEntries(QUEUE_TABS.map((t, i) => [t, counted[i] ?? 0])) as Record<QueueTab, number>;
    // The same deterministic fit the Jobs list shows; none when it is not known or not shown to this account.
    const fits = await deps.fitsFor(userId, picked.map((r) => r.jobId)).catch(() => new Map<string, never>());
    return {
      items: picked.map((r) => toQueueView(r, jobs.get(r.jobId)!, fits.get(r.jobId) ?? null)),
      counts,
      weekKey: weekKeyFor(deps.now(), await timeZoneOf(db, userId)),
      nextCursor: last ? encodeListCursor(last) : null,
    };
  }

  async function addToQueue(userId: string, input: { jobIds: string[]; addedVia?: QueueAddedVia }): Promise<{ items: QueueItemView[] }> {
    const db = await deps.getDb();
    const ids = [...new Set(input.jobIds)];
    const jobs = await visibleJobs(db, userId, ids);
    if (!jobs.size) throw new HttpError('not_found', 'Job not found.', { reason: AGENT_ERROR_CODES.jobNotFound });
    const existing = (await db.rAAgentQueueItem.findMany({ where: { userId, jobId: { in: [...jobs.keys()] } }, select: QUEUE_SELECT })) as QueueRow[];
    const have = new Set(existing.map((e) => e.jobId));
    const toAdd = [...jobs.keys()].filter((id) => !have.has(id));
    const room = MAX_ACTIVE_QUEUE_ITEMS - (await activeCount(db, userId));
    if (toAdd.length > room) {
      throw new HttpError('conflict', `Your list holds up to ${MAX_ACTIVE_QUEUE_ITEMS} jobs at a time. Remove some first.`, {
        reason: AGENT_ERROR_CODES.queueFull,
        room: Math.max(0, room),
      });
    }
    const weekKey = weekKeyFor(deps.now(), await timeZoneOf(db, userId));
    const created: QueueRow[] = [];
    for (const jobId of toAdd) {
      const r = await insertItem(db, userId, jobId, weekKey, input.addedVia ?? 'manual', 'user');
      if (r) created.push(r);
    }
    const rows = [...existing, ...created];
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0));
    return { items: rows.map((r) => toQueueView(r, jobs.get(r.jobId)!)) };
  }

  async function badge(userId: string): Promise<ReadyBadgeResponse> {
    const db = await deps.getDb();
    return { readyNotOpened: await db.rAAgentQueueItem.count({ where: { userId, state: { in: [...READY_NOT_OPENED_STATES] } } }) };
  }

  async function history(userId: string, id: string): Promise<{ items: KitEventView[] }> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    return { items: (await events(db, item.id)).map(toKitEventView) };
  }

  async function detail(userId: string, id: string): Promise<QueueItemDetail> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    const jobs = await visibleJobs(db, userId, [item.jobId]);
    const job = jobs.get(item.jobId);
    if (!job) throw new HttpError('not_found', 'This job is not in your Ready to apply list.', { reason: AGENT_ERROR_CODES.notFound });
    const [settings, rows, answers, ai, usage] = await Promise.all([
      settingsRow(db, userId).then(settingsFromRow),
      events(db, item.id),
      listAnswers(userId),
      deps.aiAvailable(userId).catch(() => false),
      deps.creditUsage(userId).catch(() => null),
    ]);
    let pendingClaims = 0;
    if (item.tailorSessionId) {
      const session = await deps.tailorSession(userId, item.tailorSessionId);
      pendingClaims = session?.pendingClaims ?? 0;
    } else if (item.resumeVariantId) {
      pendingClaims = await deps.unverifiedClaims(item.resumeVariantId).catch(() => 0);
    }
    const decided = decisionsSinceReady(rows);
    const asks = postAsksForCoverLetter(job.descriptionPlain, job.qualifications);
    return {
      item: toQueueView(item, job),
      kit: {
        resume: {
          variantId: item.resumeVariantId,
          tailorSessionId: item.tailorSessionId,
          pendingClaims,
          tailored: Boolean(item.tailorSessionId),
          used: decided.resume || ['approved', 'opened', 'applied'].includes(item.state),
        },
        letter: {
          coverLetterId: item.coverLetterId,
          needed: letterNeeded(settings.coverLetterMode, asks),
          used: decided.letter || (Boolean(item.coverLetterId) && ['approved', 'opened', 'applied'].includes(item.state)),
        },
        answers: answers.items,
        fileName: await downloadName(db, userId, item, job, settings),
        aiAvailable: ai,
        revisionCost: ai ? { resume: creditLine(usage, 'tailor', 1), letter: creditLine(usage, 'cover_letter', 1) } : null,
      },
      history: rows.map(toKitEventView),
    };
  }

  /**
   * The name the kit's resume downloads as, or null when the kit has no
   * resume yet. It is worked out from the same things the export reads
   * (RAResumeService.exportVariant), so the review shows the name of the file
   * the user gets, the same on every load:
   *   - the person's name is the resume's own first heading;
   *   - the company and the job title come from the job the resume was made
   *     for (a tailored copy) or, once the application was opened, from the
   *     kit's own job (its tracker entry); an untailored resume that was not
   *     opened yet names no job, because the export cannot know it;
   *   - with no part known, the resume's own title.
   */
  async function downloadName(db: AgentDb, userId: string, item: QueueRow, job: JobRow, settings: AgentSettings): Promise<string | null> {
    if (!item.resumeVariantId) return null;
    const variant = await db.rAResumeVariant.findFirst({
      where: { id: item.resumeVariantId, userId },
      select: { name: true, resumeMarkdown: true, targetJobId: true, targetTitle: true, parsedData: true },
    });
    if (!variant) return null;
    const namedJobId = variant.targetJobId ?? (item.trackerEntryId ? item.jobId : null);
    const namedJob = !namedJobId ? null : namedJobId === job.id ? job : ((await visibleJobs(db, userId, [namedJobId])).get(namedJobId) ?? null);
    const target = (variant.parsedData as { tailorTarget?: { company?: unknown; title?: unknown } } | null)?.tailorTarget ?? null;
    const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    return kitFileName(settings.fileNameStyle, {
      name: resumeHeadingName(variant.resumeMarkdown),
      company: namedJob?.companyName ?? text(target?.company),
      role: namedJob?.title ?? text(target?.title) ?? text(variant.targetTitle),
      date: deps.now(),
      fallback: text(variant.name) ?? 'Resume',
    });
  }

  // ── Prepare (F-AGENT-10: the cost before the work) ─────────────────────

  async function prepare(userId: string, ids: string[], confirm: boolean): Promise<PrepareProposal> {
    const db = await deps.getDb();
    const items = (await db.rAAgentQueueItem.findMany({ where: { userId, id: { in: [...new Set(ids)] } }, select: QUEUE_SELECT })) as QueueRow[];
    if (!items.length) throw new HttpError('not_found', 'This job is not in your Ready to apply list.', { reason: AGENT_ERROR_CODES.notFound });
    const preparable = items.filter((i) => (PREPARABLE_STATES as readonly string[]).includes(i.state));
    const notPreparable = items.filter((i) => !preparable.includes(i)).map((i) => i.id);
    const settings = settingsFromRow(await settingsRow(db, userId));
    const ai = await deps.aiAvailable(userId);
    const jobs = await visibleJobs(
      db,
      userId,
      preparable.map((i) => i.jobId),
    );
    const targets = preparable.filter((i) => jobs.has(i.jobId));
    const tailorCost = ai && settings.tailorEach ? targets.length : 0;
    const letterCost = ai
      ? targets.filter((i) => {
          const j = jobs.get(i.jobId)!;
          return !i.coverLetterId && letterNeeded(settings.coverLetterMode, postAsksForCoverLetter(j.descriptionPlain, j.qualifications));
        }).length
      : 0;

    const usage = await deps.creditUsage(userId);
    const line = (bucket: PrepareCreditLine['bucket'], cost: number): PrepareCreditLine => creditLine(usage, bucket, cost);
    const credits: PrepareCreditLine[] = [line('ready_kits', targets.length)];
    if (tailorCost) credits.push(line('tailor', tailorCost));
    if (letterCost) credits.push(line('cover_letter', letterCost));
    const short = credits.find((c) => typeof c.remaining === 'number' && c.cost > c.remaining);
    const proposal: PrepareProposal = {
      credits,
      confirmed: false,
      enough: !short,
      aiAvailable: ai,
      itemIds: targets.map((t) => t.id),
      notPreparable,
    };
    if (!confirm) return proposal;

    if (!targets.length) throw notReady('These jobs are already prepared or in progress.');
    if (short) {
      const u = usage.lines[short.bucket]!;
      throw new CreditsExhaustedError({ bucket: short.bucket, resetsAt: u.resetsAt, upgradable: usage.upgradable, cap: u.cap, window: u.window });
    }
    if (ai && (tailorCost || letterCost)) await deps.assertPhoneBound(userId);

    const started: string[] = [];
    for (const item of targets) {
      const attempt = (await db.rAAgentKitEvent.count({ where: { queueItemId: item.id, toState: 'preparing' } })) + 1;
      let reservation: { id: string; replayed: boolean } | null = null;
      try {
        reservation = await deps.reserveKit(userId, `ready_kit:${item.id}:${attempt}`, item.id);
      } catch (err) {
        if (started.length) break; // a race used the last kit credit: keep what started
        throw err;
      }
      let preparing: QueueRow;
      try {
        preparing = await transitionItem(db, item, 'preparing', { actor: 'user', detail: { attempt, creditLedgerId: reservation.id }, data: { lastError: null } });
      } catch (err) {
        // A twin request (double click, second tab) computed the same attempt, so it holds this
        // same reservation (the second reserve is a replay) and may have moved the kit first.
        // Then the reservation is live: the kit is started, and it is never ours to release.
        const current = await db.rAAgentQueueItem.findFirst({ where: { id: item.id, userId }, select: { state: true } });
        if (current?.state === 'preparing' && (await lastPrepareEvent(db, item.id))?.creditLedgerId === reservation.id) {
          started.push(item.id);
          continue;
        }
        // A replayed reservation belongs to the request that created it (it releases its own).
        if (!reservation.replayed) await deps.releaseKit(reservation.id, 'kit_not_started').catch(() => undefined);
        if (targets.length === 1) throw err;
        continue;
      }
      const payload: PreparePayload = { queueItemId: item.id, userId, attempt, reservationId: reservation.id, part: 'all' };
      try {
        await deps.enqueuePrepare(payload, `agent.prepare:${item.id}:${attempt}`);
      } catch (err) {
        // Nothing will run this kit: take it out of `preparing` and give the kit credit back.
        logger.warn('AGENT', 'prepare could not be queued', { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
        await leavePreparing(db, preparing, {
          code: KIT_ERROR_CODES.enqueueFailed,
          part: 'all',
          reservationId: reservation.id,
          attempt,
          releaseReason: 'kit_not_started',
        }).catch(() => undefined);
        if (targets.length === 1) throw err;
        continue;
      }
      started.push(item.id);
    }
    if (started.length) deps.kickPrepare();
    return { ...proposal, confirmed: true, started };
  }

  /**
   * Take a kit out of `preparing`: to `failed`, or back to review for a failed
   * revision (the user keeps the kit they had), with the reason in
   * `lastError`. The kit credit is released either way.
   */
  async function leavePreparing(
    db: AgentDb,
    item: QueueRow,
    opts: { code: string; part: PreparePayload['part']; reservationId: string | null; attempt?: number; releaseReason: string },
  ): Promise<QueueRow> {
    try {
      const keep = opts.part === 'resume' && Boolean(item.resumeVariantId);
      const detail: KitEventDetail = { error: opts.code };
      if (typeof opts.attempt === 'number') detail.attempt = opts.attempt;
      return await transitionItem(db, item, keep ? 'ready_for_review' : 'failed', { actor: 'system', detail, data: { lastError: opts.code } });
    } finally {
      if (opts.reservationId) await deps.releaseKit(opts.reservationId, opts.releaseReason).catch(() => undefined);
    }
  }

  /** The newest move into `preparing` (it carries the attempt, the kit credit and the part). */
  async function lastPrepareEvent(db: AgentDb, itemId: string): Promise<KitEventDetail | null> {
    const row = await db.rAAgentKitEvent.findFirst({
      where: { queueItemId: itemId, toState: 'preparing' },
      orderBy: { createdAt: 'desc' },
      select: { detail: true },
    });
    return row ? readDetail(row.detail) : null;
  }

  /**
   * The `agent.prepare` worker body: tailoring and the letter through RES / CL;
   * never submits (D1). An unexpected error is retried by the queue; on the
   * last attempt (`finalAttempt`) the kit is marked `failed` ('internal') and
   * its credit released, so it never stays `preparing`.
   */
  async function runPrepare(payload: PreparePayload, opts: { finalAttempt?: boolean } = {}): Promise<'ready' | 'failed' | 'stale' | 'expired'> {
    try {
      return await prepareKit(payload);
    } catch (err) {
      if (isConflict(err)) return 'stale'; // another request (or the sweep) moved the kit meanwhile
      if (!opts.finalAttempt) throw err;
      logger.error('AGENT', 'kit preparation failed on its last attempt', {
        itemId: payload.queueItemId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        const db = await deps.getDb();
        const item = (await db.rAAgentQueueItem.findFirst({
          where: { id: payload.queueItemId, userId: payload.userId },
          select: QUEUE_SELECT,
        })) as QueueRow | null;
        if (item?.state === 'preparing') {
          await leavePreparing(db, item, {
            code: KIT_ERROR_CODES.internal,
            part: payload.part,
            reservationId: payload.reservationId,
            attempt: payload.attempt,
            releaseReason: 'kit_failed',
          });
        } else if (payload.reservationId) {
          await deps.releaseKit(payload.reservationId, 'kit_failed').catch(() => undefined);
        }
      } catch (inner) {
        // The stale-preparing sweep (ready-weekly cron) picks the kit up later.
        logger.error('AGENT', 'could not mark a kit failed', { itemId: payload.queueItemId, error: inner instanceof Error ? inner.message : String(inner) });
      }
      return 'failed';
    }
  }

  async function prepareKit(payload: PreparePayload): Promise<'ready' | 'failed' | 'stale' | 'expired'> {
    const db = await deps.getDb();
    const item = (await db.rAAgentQueueItem.findFirst({ where: { id: payload.queueItemId, userId: payload.userId }, select: QUEUE_SELECT })) as QueueRow | null;
    const latest = item?.state === 'preparing' ? await lastPrepareEvent(db, item.id) : null;
    // Stale: the kit left `preparing`, or a newer attempt is the one running now.
    if (!item || item.state !== 'preparing' || (typeof latest?.attempt === 'number' && latest.attempt !== payload.attempt)) {
      if (payload.reservationId) await deps.releaseKit(payload.reservationId, 'kit_stale').catch(() => undefined);
      return 'stale';
    }
    const userId = item.userId;
    const settings = settingsFromRow(await settingsRow(db, userId));
    const job = (await db.rAJob.findUnique({ where: { id: item.jobId }, select: JOB_SELECT })) as JobRow | null;

    const fail = async (code: string): Promise<'failed'> => {
      await leavePreparing(db, item, { code, part: payload.part, reservationId: payload.reservationId, attempt: payload.attempt, releaseReason: 'kit_failed' });
      return 'failed';
    };

    if (!job) return fail(AGENT_ERROR_CODES.jobNotFound);
    if (isJobClosed(job)) {
      // The post closed after confirm: no tailoring or letter credits are spent on it.
      try {
        await transitionItem(db, item, 'expired', {
          actor: 'system',
          detail: { attempt: payload.attempt, error: KIT_ERROR_CODES.jobClosed },
          data: { lastError: KIT_ERROR_CODES.jobClosed },
        });
      } finally {
        if (payload.reservationId) await deps.releaseKit(payload.reservationId, 'kit_job_closed').catch(() => undefined);
      }
      return 'expired';
    }
    const ai = await deps.aiAvailable(userId).catch(() => false);
    const base = await baseVariantFor(db, userId, settings);
    if (!base) return fail(AGENT_ERROR_CODES.noResume);

    let resumeVariantId = item.resumeVariantId;
    let tailorSessionId = item.tailorSessionId;
    const tailorWanted = payload.part === 'resume' || settings.tailorEach;
    if (ai && tailorWanted) {
      try {
        const session = await deps.tailor(userId, {
          baseVariantId: base.id,
          jobId: item.jobId,
          idempotencyKey: `kit:${item.id}:${payload.attempt}:tailor`,
          instruction: payload.instruction,
        });
        if (session.status === 'failed' || !session.resultVariantId) return fail('ai_unavailable:ai_failed');
        tailorSessionId = session.id;
        resumeVariantId = session.resultVariantId;
      } catch (err) {
        // An unexpected error (no domain code: a network or programming fault) is retried by
        // the queue; on the last attempt runPrepare marks the kit failed ('internal').
        if (typeof (err as { code?: unknown } | null)?.code !== 'string') throw err;
        return fail(failureCode(err));
      }
    } else if (payload.part === 'all') {
      resumeVariantId = base.id;
      tailorSessionId = null;
    } else {
      return fail('ai_unavailable');
    }

    let coverLetterId = item.coverLetterId;
    let letterError: string | null = null;
    const asks = postAsksForCoverLetter(job.descriptionPlain, job.qualifications);
    if (payload.part === 'all' && ai && !coverLetterId && letterNeeded(settings.coverLetterMode, asks)) {
      try {
        // Written from the base resume: the tailored copy still has claims to verify (CL refuses those).
        const letter = await deps.createLetter(userId, { jobId: item.jobId, resumeVariantId: base.id }, `kit:${item.id}:${payload.attempt}:letter`);
        coverLetterId = letter.id;
      } catch (err) {
        letterError = `letter:${failureCode(err)}`.slice(0, 80);
        logger.warn('AGENT', 'kit letter failed; the kit is ready without one', { itemId: item.id, code: letterError });
      }
    }

    let missingFields: Array<{ key: string; label: string }> = [];
    try {
      missingFields = await deps.profileMissing(userId);
    } catch {
      missingFields = [];
    }

    const detail: KitEventDetail = { attempt: payload.attempt };
    if (tailorSessionId) detail.tailorSessionId = tailorSessionId;
    if (coverLetterId) detail.coverLetterId = coverLetterId;
    if (letterError) detail.error = letterError;
    try {
      await transitionItem(db, item, 'ready_for_review', {
        actor: 'system',
        detail,
        data: { resumeVariantId, tailorSessionId, coverLetterId, missingFields, lastError: letterError },
      });
    } catch (err) {
      // Moved meanwhile (e.g. swept): give the credit back. Any other error is retried with the same reservation.
      if (isConflict(err)) {
        if (payload.reservationId) await deps.releaseKit(payload.reservationId, 'kit_stale').catch(() => undefined);
        return 'stale';
      }
      throw err;
    }
    if (payload.reservationId) {
      await deps.commitKit(payload.reservationId, item.id).catch((err) => {
        logger.error('AGENT', 'ready_kits commit failed after a prepared kit', { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    return 'ready';
  }

  /**
   * Kits stuck in `preparing` (the worker died, its lease ran out, or its work
   * item went dead without reaching runPrepare's last-attempt path) for longer
   * than PREPARE_STALE_AFTER_MS move to `failed` (a revision: back to review)
   * with 'prepare_timeout', and their kit credit is released. Users of other
   * brands are left to their own brand's run. Stops when `stop()` says so.
   */
  async function sweepStalePreparing(input: { brand: string; now: Date; stop?: () => boolean }): Promise<{ swept: number; scanned: number }> {
    const db = await deps.getDb();
    const before = new Date(input.now.getTime() - PREPARE_STALE_AFTER_MS);
    let cursor: string | null = null;
    let swept = 0;
    let scanned = 0;
    for (;;) {
      const rows = (await db.rAAgentQueueItem.findMany({
        where: { state: 'preparing', updatedAt: { lt: before }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: QUEUE_SELECT,
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
      })) as QueueRow[];
      if (!rows.length) break;
      scanned += rows.length;
      cursor = rows[rows.length - 1]!.id;
      const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, brand: true } });
      const mine = new Set(users.filter((u) => u.brand === input.brand).map((u) => u.id));
      for (const row of rows) {
        if (!mine.has(row.userId)) continue;
        if (input.stop?.()) return { swept, scanned };
        const last = await lastPrepareEvent(db, row.id);
        try {
          await leavePreparing(db, row, {
            code: KIT_ERROR_CODES.timeout,
            part: last?.part === 'resume' ? 'resume' : 'all',
            reservationId: typeof last?.creditLedgerId === 'string' ? last.creditLedgerId : null,
            attempt: typeof last?.attempt === 'number' ? last.attempt : undefined,
            releaseReason: 'kit_timeout',
          });
          swept += 1;
        } catch (err) {
          if (!isConflict(err)) throw err; // finished meanwhile
        }
      }
      if (rows.length < SWEEP_BATCH || input.stop?.()) break;
    }
    return { swept, scanned };
  }

  // ── Review decisions (F-AGENT-05) ──────────────────────────────────────

  async function guardClaims(item: QueueRow): Promise<void> {
    if (!item.resumeVariantId) return;
    const pending = await deps.unverifiedClaims(item.resumeVariantId);
    if (pending > 0) throw unverifiedError(pending);
  }

  /** ready_for_review → approved once every part is used; never while the resume has unverified claims. */
  async function maybeApprove(db: AgentDb, item: QueueRow): Promise<QueueRow> {
    if (item.state !== 'ready_for_review') return item;
    const decided = decisionsSinceReady(await events(db, item.id));
    if (!decided.resume || (item.coverLetterId && !decided.letter)) return item;
    await guardClaims(item);
    return transitionItem(db, item, 'approved', { actor: 'user' });
  }

  async function confirmPart(
    userId: string,
    id: string,
    input: { part: 'resume' | 'letter'; decision: 'use' | 'revise'; instruction?: string },
  ): Promise<QueueItemView> {
    const db = await deps.getDb();
    let item = await itemOrThrow(db, userId, id);
    if (item.state !== 'ready_for_review' && item.state !== 'approved') throw notReady();

    if (input.decision === 'use') {
      if (input.part === 'resume') {
        if (item.tailorSessionId) {
          try {
            await deps.finalizeTailor(userId, item.tailorSessionId);
          } catch (err) {
            const pending = pendingOf(err);
            if (pending !== null && pending > 0) throw unverifiedError(pending);
            throw err;
          }
        }
        await guardClaims(item);
      } else if (!item.coverLetterId) {
        throw notReady('There is no cover letter in this kit.');
      }
      await recordKitNote(db, item, 'user', { part: input.part, decision: 'use' });
      item = await maybeApprove(db, item);
      return view(db, userId, item);
    }

    // Revise: AI only. Its cost (1 tailor / 1 cover_letter credit) is on the review screen
    // (detail().kit.revisionCost); with none left it is refused here, before any work.
    if (!(await deps.aiAvailable(userId))) throw new HttpError('ai_unavailable', 'AI is not available for this account.');
    await deps.assertPhoneBound(userId);
    {
      const bucket = input.part === 'resume' ? 'tailor' : 'cover_letter';
      const usage = await deps.creditUsage(userId);
      const u = usage.lines[bucket];
      if (u && u.remaining < 1) {
        throw new CreditsExhaustedError({ bucket, resetsAt: u.resetsAt, upgradable: usage.upgradable, cap: u.cap, window: u.window });
      }
    }
    if (input.part === 'resume') {
      const attempt = (await db.rAAgentKitEvent.count({ where: { queueItemId: item.id, toState: 'preparing' } })) + 1;
      item = await transitionItem(db, item, 'preparing', { actor: 'user', detail: { part: 'resume', decision: 'revise', attempt }, data: { lastError: null } });
      try {
        await deps.enqueuePrepare(
          { queueItemId: item.id, userId, attempt, reservationId: null, part: 'resume', instruction: input.instruction?.trim() || undefined },
          `agent.prepare:${item.id}:${attempt}`,
        );
      } catch (err) {
        // Nothing will run the revision: the user keeps the kit they had, back in review.
        await leavePreparing(db, item, { code: KIT_ERROR_CODES.enqueueFailed, part: 'resume', reservationId: null, attempt, releaseReason: 'kit_not_started' }).catch(
          () => undefined,
        );
        throw err;
      }
      deps.kickPrepare();
      return view(db, userId, item);
    }

    // Letter: rewrite with the instruction, regenerate without one, or write the first letter.
    const settings = settingsFromRow(await settingsRow(db, userId));
    let letterId = item.coverLetterId;
    if (letterId) {
      const instruction = input.instruction?.trim();
      const out = instruction
        ? await deps.rewriteLetter(userId, letterId, instruction)
        : await deps.regenerateLetter(userId, letterId, `kit:${item.id}:letter:${deps.now().getTime()}`);
      letterId = out.id;
    } else {
      const base = await baseVariantFor(db, userId, settings);
      if (!base) throw new HttpError('conflict', 'Add a resume first.', { reason: AGENT_ERROR_CODES.noResume });
      letterId = (await deps.createLetter(userId, { jobId: item.jobId, resumeVariantId: base.id }, `kit:${item.id}:letter:${deps.now().getTime()}`)).id;
      await db.rAAgentQueueItem.updateMany({ where: { id: item.id, userId }, data: { coverLetterId: letterId } });
      item = { ...item, coverLetterId: letterId };
    }
    await recordKitNote(db, item, 'user', { part: 'letter', decision: 'revise', coverLetterId: letterId });
    // A changed letter needs another look before the kit is approved.
    if (item.state === 'approved') item = await transitionItem(db, item, 'ready_for_review', { actor: 'user', detail: { part: 'letter', decision: 'revise' } });
    const fresh = await itemOrThrow(db, userId, item.id);
    return view(db, userId, fresh);
  }

  // ── Open application and its Undo (R-19, ruling C11) ───────────────────

  async function open(userId: string, id: string): Promise<OpenApplicationResponse> {
    const db = await deps.getDb();
    let item = await itemOrThrow(db, userId, id);
    if (!['approved', 'opened', 'applied'].includes(item.state)) throw notReady('Check and approve this kit first.');
    if (item.state === 'approved') await guardClaims(item);
    let click;
    try {
      click = await deps.recordApplyClick(userId, item.jobId);
    } catch (err) {
      if (errorReason(err) === 'job_closed' && item.state === 'approved') {
        await transitionItem(db, item, 'expired', { actor: 'system', detail: { error: 'job_closed' } }).catch(() => undefined);
      }
      throw err;
    }
    const firstOpen = item.state === 'approved';
    if (item.state === 'approved') {
      item = await transitionItem(db, item, 'opened', {
        actor: 'user',
        detail: { via: 'apply_click', alreadyApplied: click.alreadyApplied === true },
        data: { openedAt: deps.now(), trackerEntryId: click.trackerEntryId },
      });
    } else if (item.trackerEntryId !== click.trackerEntryId) {
      await db.rAAgentQueueItem.updateMany({ where: { id: item.id, userId }, data: { trackerEntryId: click.trackerEntryId } });
      item = { ...item, trackerEntryId: click.trackerEntryId };
    }
    if (item.coverLetterId) {
      await deps.attachLetter(userId, item.coverLetterId, click.trackerEntryId).catch((err) => {
        logger.warn('AGENT', 'letter not attached to the application', { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    // The resume the user is about to send is recorded on the application
    // (its files then show with the application). Queued: the export never
    // delays opening the form, and a failure never blocks it.
    if (firstOpen && item.resumeVariantId) {
      await deps.enqueueRecordFiles({ queueItemId: item.id, userId }, `kit:${item.id}:files:${deps.now().getTime()}`).catch((err) => {
        logger.warn('AGENT', 'resume file not queued for the application', { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    return {
      applyUrl: click.applyUrl,
      handoff: { jobId: item.jobId, variantId: item.resumeVariantId, coverLetterId: item.coverLetterId },
      trackerEntryId: click.trackerEntryId,
      alreadyApplied: click.alreadyApplied === true,
      atsType: click.atsType,
      extensionSupported: click.extensionSupported,
      item: await view(db, userId, item),
    };
  }

  /**
   * The `agent.record-files` worker body: export the kit's resume with the
   * application's tracker entry, so the exact file is recorded
   * (RAApplicationArtifact, channel `agent`), and note the file on the kit's
   * move to `opened`. Runs once per open: a kit that was undone since, or
   * whose open already carries a file, is left alone.
   */
  async function recordKitFiles(payload: RecordFilesPayload): Promise<'recorded' | 'stale' | 'already'> {
    const db = await deps.getDb();
    const item = (await db.rAAgentQueueItem.findFirst({ where: { id: payload.queueItemId, userId: payload.userId }, select: QUEUE_SELECT })) as QueueRow | null;
    if (!item || !item.resumeVariantId || !item.trackerEntryId) return 'stale';
    if (item.state !== 'opened' && item.state !== 'applied') return 'stale';
    const opened = lastInto(await events(db, item.id), 'opened');
    if (!opened) return 'stale';
    const detail = readDetail(opened.detail);
    if (detail.artifactId) return 'already';
    const settings = settingsFromRow(await settingsRow(db, payload.userId));
    const file = await deps.recordResumeFile(payload.userId, { variantId: item.resumeVariantId, trackerEntryId: item.trackerEntryId, nameStyle: settings.fileNameStyle });
    if (!file.artifactId) return 'stale';
    const next: KitEventDetail = { ...detail, artifactId: file.artifactId, fileName: file.fileName };
    await db.rAAgentKitEvent.updateMany({ where: { id: opened.id, queueItemId: item.id }, data: { detail: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue } });
    return 'recorded';
  }

  function lastInto(rows: KitEventRow[], state: QueueState): KitEventRow | null {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]!;
      if (r.toState === state && r.fromState !== state) return r;
    }
    return null;
  }

  /**
   * "Undo · I didn't apply": the kit goes back to `approved` and the tracker
   * to the status the move replaced. The kit moves first (so a second Undo
   * racing this one gets a 409 and never touches the tracker); when the
   * tracker move can no longer be reverted (older than the tracker's undo
   * window, or the entry moved since) the kit is put back as it was and the
   * call answers 409 `kit_undo_expired`, so the kit and the tracker never
   * disagree. A job that was already Applied before opening needs no tracker
   * change.
   */
  async function undoApplied(userId: string, id: string): Promise<QueueItemView> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    if (item.state !== 'opened' && item.state !== 'applied') throw notReady('There is nothing to undo for this job.');
    const was = item.state as 'opened' | 'applied';
    const rows = await events(db, item.id);
    const openedDetail = readDetail(lastInto(rows, 'opened')?.detail);
    const appliedRow = was === 'applied' ? lastInto(rows, 'applied') : null;
    const mark = appliedRow ? readDetail(appliedRow.detail).applyMark : undefined;
    let undoTracker: (() => Promise<{ reverted: boolean }>) | null = null;
    if (mark) {
      if (mark.changed) undoTracker = () => deps.undoMarkApplied(userId, item.jobId, mark);
    } else if (lastInto(rows, 'opened') && openedDetail.alreadyApplied !== true) {
      undoTracker = () => deps.undoApplyClick(userId, item.jobId);
    }

    const next = await transitionItem(db, item, 'approved', {
      actor: 'user',
      detail: { via: 'undo' },
      data: { openedAt: null, completedAt: null, userMarkedSubmitted: false },
    });
    if (!undoTracker) return view(db, userId, next);

    let failure: unknown = null;
    let reverted = false;
    try {
      reverted = (await undoTracker()).reverted;
    } catch (err) {
      failure = err;
    }
    if (reverted) return view(db, userId, next);

    // The tracker still says Applied: put the kit back as it was (carrying what a later Undo reads).
    const restore: KitEventDetail = { via: 'undo_refused', error: failure ? 'undo_failed' : AGENT_ERROR_CODES.undoExpired };
    if (was === 'applied' && mark) restore.applyMark = mark;
    if (was === 'opened') restore.alreadyApplied = openedDetail.alreadyApplied === true;
    await transitionItem(db, next, was, {
      actor: 'system',
      detail: restore,
      data: { openedAt: item.openedAt, completedAt: item.completedAt, userMarkedSubmitted: item.userMarkedSubmitted },
    }).catch((err) => {
      logger.error('AGENT', 'could not restore a kit after a refused undo', { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
    });
    if (failure) throw failure;
    throw new HttpError('conflict', 'This can no longer be undone here. You can change the status in Applications.', {
      reason: AGENT_ERROR_CODES.undoExpired,
    });
  }

  /** The user's own "I applied" (a post with no link to open, or after opening it). */
  async function markApplied(userId: string, id: string): Promise<QueueItemView> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    if (item.state === 'opened') {
      return view(db, userId, await transitionItem(db, item, 'applied', { actor: 'user', detail: { via: 'user' }, data: { completedAt: deps.now() } }));
    }
    if (item.state === 'approved') {
      await guardClaims(item);
      const mark = await deps.markApplied(userId, item.jobId, 'agent_open');
      const next = await transitionItem(db, item, 'applied', {
        actor: 'user',
        detail: { via: 'agent_open', applyMark: mark },
        data: { completedAt: deps.now(), trackerEntryId: mark.entryId },
      });
      return view(db, userId, next);
    }
    if (item.state === 'applied') return view(db, userId, item);
    throw notReady('Check and approve this kit first.');
  }

  async function skip(userId: string, id: string): Promise<QueueItemView> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    if (item.state === 'preparing') throw new HttpError('conflict', 'This kit is still being prepared.', { reason: AGENT_ERROR_CODES.busy });
    return view(db, userId, await transitionItem(db, item, 'skipped', { actor: 'user' }));
  }

  async function restore(userId: string, id: string): Promise<QueueItemView> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    if ((await activeCount(db, userId)) >= MAX_ACTIVE_QUEUE_ITEMS) {
      throw new HttpError('conflict', `Your list holds up to ${MAX_ACTIVE_QUEUE_ITEMS} jobs at a time.`, { reason: AGENT_ERROR_CODES.queueFull, room: 0 });
    }
    return view(db, userId, await transitionItem(db, item, 'picked', { actor: 'user' }));
  }

  async function remove(userId: string, id: string): Promise<null> {
    const db = await deps.getDb();
    const item = await itemOrThrow(db, userId, id);
    if (item.state === 'preparing') throw new HttpError('conflict', 'This kit is still being prepared.', { reason: AGENT_ERROR_CODES.busy });
    await db.$transaction(async (tx) => {
      await tx.rAAgentKitEvent.deleteMany({ where: { queueItemId: item.id } });
      await tx.rAAgentQueueItem.deleteMany({ where: { id: item.id, userId } });
    });
    return null;
  }

  /** The extension's "Did you submit this application?" → yes (the only submit signal; D1). */
  async function markUserSubmitted(userId: string, jobId: string): Promise<void> {
    const db = await deps.getDb();
    const item = (await db.rAAgentQueueItem.findFirst({ where: { userId, jobId }, select: QUEUE_SELECT })) as QueueRow | null;
    if (!item) return;
    const at = deps.now();
    if (item.state === 'opened') {
      await transitionItem(db, item, 'applied', { actor: 'extension', detail: { via: 'extension' }, data: { userMarkedSubmitted: true, completedAt: at } });
      return;
    }
    if (item.state === 'approved') {
      const mark = await deps.markApplied(userId, jobId, 'extension');
      await transitionItem(db, item, 'applied', {
        actor: 'extension',
        detail: { via: 'extension', applyMark: mark },
        data: { userMarkedSubmitted: true, completedAt: at, trackerEntryId: mark.entryId },
      });
      return;
    }
    if (item.state === 'applied' && !item.userMarkedSubmitted) {
      await db.rAAgentQueueItem.updateMany({ where: { id: item.id, userId }, data: { userMarkedSubmitted: true } });
    }
  }

  // ── Answer bank (F-AGENT-03) ───────────────────────────────────────────

  async function listAnswers(userId: string): Promise<{ items: AnswerBankItemView[] }> {
    const db = await deps.getDb();
    const rows = await db.rAAnswerBankItem.findMany({ where: { userId }, orderBy: { questionKey: 'asc' }, select: ANSWER_SELECT });
    return { items: rows.map(toAnswerView) };
  }

  async function putAnswers(
    userId: string,
    answers: Array<{ questionKey: string; questionText: string; answer: string; locale: string }>,
  ): Promise<{ items: AnswerBankItemView[] }> {
    const db = await deps.getDb();
    const market = deps.brand().market;
    const invalid = answers.filter((a) => !isValidQuestionKey(a.questionKey, market)).map((a) => a.questionKey);
    if (invalid.length) {
      throw new HttpError('invalid_request', 'Some questions are not recognised.', { reason: AGENT_ERROR_CODES.invalidQuestionKey, keys: invalid });
    }
    for (const a of answers) {
      const answer = a.answer.trim();
      if (!answer) {
        await db.rAAnswerBankItem.deleteMany({ where: { userId, questionKey: a.questionKey } });
        continue;
      }
      const data = { questionText: a.questionText.trim(), answer, locale: a.locale || deps.brand().defaultLocale, source: 'user' };
      const existing = await db.rAAnswerBankItem.findFirst({ where: { userId, questionKey: a.questionKey }, select: { id: true } });
      if (existing) {
        await db.rAAnswerBankItem.update({ where: { id: existing.id }, data });
        continue;
      }
      try {
        await db.rAAnswerBankItem.create({ data: { userId, questionKey: a.questionKey, ...data } });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await db.rAAnswerBankItem.updateMany({ where: { userId, questionKey: a.questionKey }, data });
      }
    }
    return listAnswers(userId);
  }

  async function deleteAnswer(userId: string, key: string): Promise<{ items: AnswerBankItemView[] }> {
    const db = await deps.getDb();
    await db.rAAnswerBankItem.deleteMany({ where: { userId, questionKey: key } });
    return listAnswers(userId);
  }

  function questions(): { items: QuestionKeyView[] } {
    return { items: questionKeysFor(deps.brand().market) };
  }

  /**
   * Extension "Save this answer" (F-EXT-04): an answer the user approved in the
   * side panel, saved under the question as the form asked it (`custom:<hash>`,
   * so saving the same question again replaces the answer). The caller has
   * already refused protected and sensitive questions.
   */
  async function saveApprovedAnswer(userId: string, input: { questionText: string; answer: string; locale?: string }): Promise<{ questionKey: string }> {
    const questionText = input.questionText.replace(/\s+/g, ' ').trim().slice(0, 500);
    const answer = input.answer.trim().slice(0, 5000);
    if (!questionText || !answer) throw new HttpError('invalid_request', 'A question and an answer are needed.');
    const db = await deps.getDb();
    const questionKey = customQuestionKey(questionText);
    const data = { questionText, answer, locale: input.locale || deps.brand().defaultLocale, source: 'ai_confirmed' };
    const existing = await db.rAAnswerBankItem.findFirst({ where: { userId, questionKey }, select: { id: true } });
    if (existing) {
      await db.rAAnswerBankItem.update({ where: { id: existing.id }, data });
      return { questionKey };
    }
    try {
      await db.rAAnswerBankItem.create({ data: { userId, questionKey, ...data } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await db.rAAnswerBankItem.updateMany({ where: { userId, questionKey }, data });
    }
    return { questionKey };
  }

  /** Extension: remember which saved answers were used to fill a form. */
  async function markAnswersUsed(userId: string, keys: string[]): Promise<void> {
    if (!keys.length) return;
    const db = await deps.getDb();
    await db.rAAnswerBankItem.updateMany({ where: { userId, questionKey: { in: keys } }, data: { lastUsedAt: deps.now() } });
  }

  return {
    deps,
    getSettings,
    putSettings,
    setup,
    calibrate,
    completeStep,
    suggestions,
    generateList,
    saveToMain,
    listQueue,
    addToQueue,
    badge,
    history,
    detail,
    prepare,
    runPrepare,
    sweepStalePreparing,
    confirmPart,
    open,
    recordKitFiles,
    undoApplied,
    markApplied,
    skip,
    restore,
    remove,
    markUserSubmitted,
    listAnswers,
    putAnswers,
    deleteAnswer,
    questions,
    markAnswersUsed,
    saveApprovedAnswer,
    questionDefFor,
  };
}

export type AgentServiceImpl = ReturnType<typeof createAgentService>;

let singleton: AgentServiceImpl | null = null;

/** The process-wide service over the production seams. */
export function getAgentService(): AgentServiceImpl {
  singleton ??= createAgentService();
  return singleton;
}

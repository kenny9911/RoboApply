// server/src/features/agent/store.ts — the narrow typed Prisma adapter of
// Ready to apply (WP-52). Rows → wire views, and the one way to change a
// queue item's state: `transitionItem` (guarded by the R-19 table, an
// optimistic state check, and one RAAgentKitEvent audit row per transition).

import type { Prisma } from '../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { HttpError } from '../../platform/http.js';
import {
  AGENT_ERROR_CODES,
  DEFAULT_AGENT_SETTINGS,
  MissingFieldsSchema,
  QUEUE_ADDED_VIA,
  type AgentSettings,
  type AnswerBankItemView,
  type CalibrationEntry,
  CalibrationEntrySchema,
  type KitEventDetail,
  type KitEventView,
  type QueueAddedVia,
  type QueueItemView,
  type QueueJobSummary,
  type QueueState,
} from './contract.js';
import { assertTransition, isQueueState, postAsksForCoverLetter, tabOf } from './stateMachine.js';

export type AgentDb = Pick<
  ExtendedPrismaClient,
  | '$transaction'
  | 'rAAgentSettings'
  | 'rAAgentQueueItem'
  | 'rAAgentKitEvent'
  | 'rAAnswerBankItem'
  | 'rAJob'
  | 'rAResumeVariant'
  | 'rAExtensionDevice'
  | 'seekerProfile'
  | 'user'
>;

/** Rows as this area reads them (the adapter selects these columns only). */
export interface SettingsRow {
  userId: string;
  weeklyTarget: number;
  minTier: string;
  tailorEach: boolean;
  coverLetterMode: string;
  baseVariantId: string | null;
  fileNameStyle: string;
  setupStep: string;
  calibration: unknown;
  setupCompletedAt: Date | null;
  /** SCHEMA-4 (SR-52-1); absent on rows read before the columns were selected. */
  searchProfileId?: string | null;
  filterOverrides?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueRow {
  id: string;
  userId: string;
  jobId: string;
  trackerEntryId: string | null;
  state: string;
  weekKey: string;
  resumeVariantId: string | null;
  coverLetterId: string | null;
  tailorSessionId: string | null;
  missingFields: unknown;
  addedVia: string;
  lastError: string | null;
  openedAt: Date | null;
  completedAt: Date | null;
  userMarkedSubmitted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KitEventRow {
  id: string;
  userId: string;
  queueItemId: string;
  fromState: string | null;
  toState: string;
  actor: string;
  /** SCHEMA-4 (SR-52-3): 'transition' | 'decision' | 'notice'; null on rows written before the column. */
  kind?: string | null;
  detail: unknown;
  createdAt: Date;
}

export interface JobRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  applyUrl: string | null;
  /** With `fromRecruiterBank`: what the bank posting-page rule reads (feed/sourceLine.ts `bankListable`). */
  sourceBoard?: string;
  fromRecruiterBank?: boolean;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  closedAt: Date | null;
  archivedAt: Date | null;
  descriptionPlain: string | null;
  qualifications: string | null;
}

export const QUEUE_SELECT = {
  id: true,
  userId: true,
  jobId: true,
  trackerEntryId: true,
  state: true,
  weekKey: true,
  resumeVariantId: true,
  coverLetterId: true,
  tailorSessionId: true,
  missingFields: true,
  addedVia: true,
  lastError: true,
  openedAt: true,
  completedAt: true,
  userMarkedSubmitted: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const JOB_SELECT = {
  id: true,
  title: true,
  companyName: true,
  location: true,
  applyUrl: true,
  sourceBoard: true,
  fromRecruiterBank: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  closedAt: true,
  archivedAt: true,
  descriptionPlain: true,
  qualifications: true,
} as const;

// ── Settings ─────────────────────────────────────────────────────────────

export function settingsFromRow(row: SettingsRow | null): AgentSettings {
  if (!row) return { ...DEFAULT_AGENT_SETTINGS };
  const d = DEFAULT_AGENT_SETTINGS;
  const target = [5, 10, 20, 30].includes(row.weeklyTarget) ? (row.weeklyTarget as AgentSettings['weeklyTarget']) : d.weeklyTarget;
  return {
    weeklyTarget: target,
    minTier: (['great', 'good', 'possible'] as const).find((t) => t === row.minTier) ?? d.minTier,
    tailorEach: row.tailorEach,
    coverLetterMode: (['when_required', 'always', 'never'] as const).find((m) => m === row.coverLetterMode) ?? d.coverLetterMode,
    baseVariantId: row.baseVariantId,
    fileNameStyle: (['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const).find((s) => s === row.fileNameStyle) ?? d.fileNameStyle,
  };
}

/** The stored calibration list (bad rows dropped, never thrown on). */
export function readCalibration(value: unknown): CalibrationEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CalibrationEntry[] = [];
  for (const raw of value) {
    const parsed = CalibrationEntrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ── Queue views ──────────────────────────────────────────────────────────

export function isJobClosed(job: Pick<JobRow, 'closedAt' | 'archivedAt'>): boolean {
  return job.closedAt != null || job.archivedAt != null;
}

export type QueueFit = NonNullable<QueueJobSummary['fit']>;

/** The fields of a `Fit` (match/fit.ts) a Ready to apply row shows. */
export interface QueueFitSource {
  jobId: string;
  score: number | null;
  tier: QueueFit['tier'] | null;
  kind: 'ai' | 'estimate';
  confidence?: QueueFit['confidence'];
}

/**
 * `getFits` as the rows show it: the same score, tier and kind as the feed
 * card and the job page (an estimate is `pre` on the wire). A job with no
 * comparable fit has no entry (the row shows none, never 0). The list reads
 * this live on every request; no fit is stored on a queue row.
 */
export function queueFits(fits: ReadonlyMap<string, QueueFitSource>): Map<string, QueueFit> {
  const out = new Map<string, QueueFit>();
  for (const [jobId, f] of fits) {
    if (!f.tier || typeof f.score !== 'number' || !Number.isFinite(f.score)) continue;
    out.set(jobId, { tier: f.tier, score: f.score, kind: f.kind === 'ai' ? 'ai' : 'pre', ...(f.confidence ? { confidence: f.confidence } : {}) });
  }
  return out;
}

export function jobSummary(job: JobRow | null | undefined, fit?: QueueFit | null): QueueJobSummary | null {
  if (!job) return null;
  return {
    ...(fit ? { fit } : {}),
    title: job.title,
    companyName: job.companyName,
    location: job.location ?? null,
    hasApplyUrl: Boolean(job.applyUrl?.trim()),
    closed: isJobClosed(job),
    asksForCoverLetter: postAsksForCoverLetter(job.descriptionPlain, job.qualifications),
  };
}

function readMissing(value: unknown): Array<{ key: string; label: string }> {
  const parsed = MissingFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function asAddedVia(v: string): QueueAddedVia {
  return (QUEUE_ADDED_VIA as readonly string[]).includes(v) ? (v as QueueAddedVia) : 'manual';
}

export function toQueueView(row: QueueRow, job?: JobRow | null, fit?: QueueFit | null): QueueItemView {
  const state: QueueState = isQueueState(row.state) ? row.state : 'failed';
  return {
    id: row.id,
    jobId: row.jobId,
    state,
    weekKey: row.weekKey,
    trackerEntryId: row.trackerEntryId,
    resumeVariantId: row.resumeVariantId,
    coverLetterId: row.coverLetterId,
    missingFields: readMissing(row.missingFields),
    addedVia: asAddedVia(row.addedVia),
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    userMarkedSubmitted: row.userMarkedSubmitted,
    updatedAt: row.updatedAt.toISOString(),
    job: job === undefined ? undefined : jobSummary(job, fit),
    tailorSessionId: row.tailorSessionId,
    lastError: row.lastError,
    tab: tabOf(state),
    createdAt: row.createdAt.toISOString(),
  };
}

export function readDetail(value: unknown): KitEventDetail {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as KitEventDetail) : {};
}

export const KIT_EVENT_KINDS = ['transition', 'decision', 'notice'] as const;
export type KitEventKind = (typeof KIT_EVENT_KINDS)[number];

/** What a row is, from its states alone: a decision or a notice leaves the state as it was. */
export function deriveKitEventKind(fromState: string | null, toState: string, detail: unknown): KitEventKind {
  if (fromState === toState) return readDetail(detail).notice ? 'notice' : 'decision';
  return 'transition';
}

/**
 * The kind of a history row: the stored column when the writer set it, else
 * derived (rows from before the column read null — never taken as 'transition').
 */
export function kitEventKind(row: Pick<KitEventRow, 'fromState' | 'toState' | 'detail' | 'kind'>): KitEventView['kind'] {
  const stored = row.kind;
  if (typeof stored === 'string' && (KIT_EVENT_KINDS as readonly string[]).includes(stored)) return stored as KitEventKind;
  return deriveKitEventKind(row.fromState, row.toState, row.detail);
}

export function toKitEventView(row: KitEventRow): KitEventView {
  const actor = row.actor === 'system' || row.actor === 'extension' ? row.actor : 'user';
  return {
    id: row.id,
    kind: kitEventKind(row),
    fromState: isQueueState(row.fromState) ? row.fromState : null,
    toState: isQueueState(row.toState) ? row.toState : 'failed',
    actor,
    detail: row.detail && typeof row.detail === 'object' ? (row.detail as Record<string, unknown>) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAnswerView(row: {
  id: string;
  questionKey: string;
  questionText: string;
  answer: string;
  source: string;
  locale: string;
  lastUsedAt: Date | null;
  updatedAt: Date;
}): AnswerBankItemView {
  return {
    id: row.id,
    questionKey: row.questionKey,
    questionText: row.questionText,
    answer: row.answer,
    locale: row.locale,
    source: row.source === 'ai_confirmed' ? 'ai_confirmed' : 'user',
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

export type KitActor = 'user' | 'system' | 'extension';

function json(detail: KitEventDetail | undefined): Prisma.InputJsonValue | undefined {
  if (!detail) return undefined;
  return JSON.parse(JSON.stringify(detail)) as Prisma.InputJsonValue;
}

/**
 * Move a queue item to `to`: checks the R-19 table, updates only when the row
 * is still in the state the caller read (409 when another request moved it),
 * and writes one RAAgentKitEvent audit row in the same transaction.
 */
export async function transitionItem(
  db: AgentDb,
  item: QueueRow,
  to: QueueState,
  options: { actor: KitActor; detail?: KitEventDetail; data?: Prisma.RAAgentQueueItemUncheckedUpdateManyInput } = { actor: 'user' },
): Promise<QueueRow> {
  assertTransition(item.state, to);
  return db.$transaction(async (tx) => {
    const res = await tx.rAAgentQueueItem.updateMany({
      where: { id: item.id, userId: item.userId, state: item.state },
      data: { ...(options.data ?? {}), state: to },
    });
    if (res.count !== 1) {
      throw new HttpError('conflict', 'This job changed in another window. Reload and try again.', {
        reason: AGENT_ERROR_CODES.invalidTransition,
        from: item.state,
        to,
      });
    }
    await tx.rAAgentKitEvent.create({
      data: { userId: item.userId, queueItemId: item.id, fromState: item.state, toState: to, actor: options.actor, kind: 'transition', detail: json(options.detail) },
    });
    const row = await tx.rAAgentQueueItem.findUnique({ where: { id: item.id }, select: QUEUE_SELECT });
    return row as QueueRow;
  });
}

/** A history row that is not a state change: a user decision or a notice (fromState = toState = current state). */
export async function recordKitNote(db: AgentDb, item: QueueRow, actor: KitActor, detail: KitEventDetail): Promise<void> {
  await db.rAAgentKitEvent.create({
    data: { userId: item.userId, queueItemId: item.id, fromState: item.state, toState: item.state, actor, kind: detail.notice ? 'notice' : 'decision', detail: json(detail) },
  });
}

/** The item, or 404 `queue_item_not_found` (other users' items are a 404 too). */
export async function itemOrThrow(db: AgentDb, userId: string, id: string): Promise<QueueRow> {
  const row = await db.rAAgentQueueItem.findFirst({ where: { id, userId }, select: QUEUE_SELECT });
  if (!row) throw new HttpError('not_found', 'This job is not in your Ready to apply list.', { reason: AGENT_ERROR_CODES.notFound });
  return row as QueueRow;
}

export { json as kitDetailJson };

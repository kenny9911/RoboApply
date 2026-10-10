// hooks/agent/adapters.ts — the narrow, typed reads Ready to apply makes on
// top of the agent contract (WP-53; contract: server/src/features/agent/contract.ts).
//
// WP-52 adds optional fields to the FND `QueueItemView` (`tailorSessionId`,
// `lastError`, `tab`) and new reads (kit detail, kit history). Until its
// contract merges, the fields are read here through narrow guards and the new
// shapes are mirrored in lib/api/agent.ts. A field the server does not send
// reads as "unknown" (null / undefined) and the UI hides what it cannot
// show; nothing is guessed (D3).

import type { QueueItemView, QueueState } from '../../lib/api/contracts/agent';
import type { KitEventView, QueueJobSummary, QueueTab } from '../../lib/api/agent';
import type { BucketSummary } from '../shared/useCredits';

export type { KitEventView } from '../../lib/api/agent';

/** A queue item plus the optional fields WP-52 sends. */
export type ReadyQueueItem = QueueItemView & {
  /** The job as WP-52 stores it on the list (saves one job read per row). */
  job?: QueueJobSummary | null;
  tailorSessionId?: string | null;
  lastError?: string | null;
  tab?: QueueTab;
};

const STATES: readonly QueueState[] = ['picked', 'preparing', 'ready_for_review', 'approved', 'opened', 'applied', 'skipped', 'expired', 'failed'];
const ACTORS = new Set(['user', 'system', 'extension']);
const KINDS = new Set(['transition', 'decision', 'notice']);

function isState(v: unknown): v is QueueState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v);
}

/** The tailoring session id of a kit, when the server sends one. */
export function tailorSessionIdOf(item: ReadyQueueItem): string | null {
  const v = (item as { tailorSessionId?: unknown }).tailorSessionId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Kit history rows from the server, newest first. Malformed rows are
 * dropped; `undefined` in → `undefined` out (the UI then shows no section
 * rather than claiming there is no history).
 */
export function kitEventsOf(raw: unknown): KitEventView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: KitEventView[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !isState(r.toState) || typeof r.createdAt !== 'string') continue;
    rows.push({
      id: r.id,
      ...(typeof r.kind === 'string' && KINDS.has(r.kind) ? { kind: r.kind as KitEventView['kind'] } : {}),
      fromState: isState(r.fromState) ? r.fromState : null,
      toState: r.toState,
      actor: typeof r.actor === 'string' && ACTORS.has(r.actor) ? (r.actor as KitEventView['actor']) : 'system',
      detail: r.detail && typeof r.detail === 'object' ? (r.detail as Record<string, unknown>) : null,
      createdAt: r.createdAt,
    });
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The last file name the kit recorded (an export or an extension upload), if any. */
export function recordedFileNameOf(events: readonly KitEventView[] | undefined): string | null {
  if (!events) return null;
  for (const e of events) {
    const name = e.detail?.fileName;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

/** The job summary the list item carries, when it is complete enough to show. */
export function jobSummaryOf(item: ReadyQueueItem): QueueJobSummary | null {
  const j = (item as { job?: unknown }).job;
  if (!j || typeof j !== 'object') return null;
  const r = j as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) return null;
  return {
    title: r.title,
    companyName: typeof r.companyName === 'string' ? r.companyName : '',
    location: typeof r.location === 'string' && r.location.trim() ? r.location : null,
    hasApplyUrl: r.hasApplyUrl === true,
    closed: r.closed === true,
    asksForCoverLetter: r.asksForCoverLetter === true,
  };
}

/** The raw code of why preparing failed, when the server says (never shown as is). */
export function lastErrorOf(item: ReadyQueueItem): string | null {
  const v = (item as { lastError?: unknown }).lastError;
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Plain-language reason for a failed kit, by the code WP-52 writes in
 * `lastError` (KIT_ERROR_CODES, a step's `failureCode()` such as
 * `credits_exhausted:tailor` or `ai_unavailable:ai_failed`, or `no_resume`).
 * Returns the i18n key under `ready.review.failedReason`, or null for a code
 * this screen does not know (the generic "couldn't be prepared" line stands).
 */
export type FailedReason = 'noResume' | 'aiUnavailable' | 'credits' | 'jobClosed' | 'ourSide';
export function failedReasonOf(code: string | null): FailedReason | null {
  if (!code) return null;
  const base = code.split(':')[0] ?? '';
  switch (base) {
    case 'no_resume':
      return 'noResume';
    case 'ai_unavailable':
      return 'aiUnavailable';
    case 'credits_exhausted':
      return 'credits';
    case 'job_closed':
      return 'jobClosed';
    case 'enqueue_failed':
    case 'internal':
    case 'prepare_timeout':
      return 'ourSide';
    default:
      return null;
  }
}

/**
 * The weekly cap a Pro plan would give for this bucket. `EntitlementService`
 * knows it (`proCap`) but `BucketSummary` does not carry it yet (request to
 * the credits owner); until it does this returns null and nothing is shown.
 */
export function proCapOf(summary: BucketSummary | null | undefined): number | null {
  const v = (summary as { proCap?: unknown } | null | undefined)?.proCap;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// ── States → tabs ───────────────────────────────────────────────────────────

/** URL ids of the tabs (`?tab=`); the server calls the first one `to_prepare`. */
export type ReadyTab = 'prepare' | 'ready' | 'done';
export const READY_TABS: readonly ReadyTab[] = ['prepare', 'ready', 'done'];

/**
 * Which tab a state belongs to: To prepare · Ready · Done (PRODUCT F-AGENT-04),
 * the same grouping as the contract's `TAB_STATES`: a kit being prepared is
 * under Ready; an expired job is under Done (flagged with Remove).
 */
export function tabForState(state: QueueState): ReadyTab {
  switch (state) {
    case 'picked':
    case 'failed':
      return 'prepare';
    case 'preparing':
    case 'ready_for_review':
    case 'approved':
      return 'ready';
    case 'opened':
    case 'applied':
    case 'skipped':
    case 'expired':
      return 'done';
  }
}

/** The tab of an item: the server's own `tab` when it sends one, else from the state. */
export function tabOf(item: ReadyQueueItem): ReadyTab {
  const tab = (item as { tab?: unknown }).tab;
  if (tab === 'to_prepare') return 'prepare';
  if (tab === 'ready' || tab === 'done') return tab;
  return tabForState(item.state);
}

/** A kit that is ready and not opened yet (the nav badge counts these). */
export function isReadyNotOpened(state: QueueState): boolean {
  return state === 'ready_for_review' || state === 'approved';
}

/** States from which "Prepare" may start (contract `PREPARABLE_STATES`). */
export function canPrepare(state: QueueState): boolean {
  return state === 'picked' || state === 'failed';
}

export interface ReadyCounts {
  /** Items per tab. */
  prepare: number;
  ready: number;
  done: number;
  /** Progress strip (F-AGENT-08): jobs still to prepare (picked or failed; never expired). */
  toPrepare: number;
  preparing: number;
  readyNotOpened: number;
  /** Opened or applied (skipped and expired are not progress). */
  applied: number;
  expired: number;
}

/**
 * The items the progress strip counts: this week's list when the server says
 * which week it is (`weekKey` of GET /agent/queue), else every item (and the
 * strip is then labelled as the whole list, not "this week"). Pure.
 */
export function progressScope(items: readonly ReadyQueueItem[], weekKey: string | null | undefined): { scope: 'week' | 'all'; items: ReadyQueueItem[] } {
  if (typeof weekKey === 'string' && weekKey) return { scope: 'week', items: items.filter((i) => i.weekKey === weekKey) };
  return { scope: 'all', items: [...items] };
}

/** Real counts from the list the server returned. */
export function countKits(items: readonly ReadyQueueItem[]): ReadyCounts {
  const c: ReadyCounts = { prepare: 0, ready: 0, done: 0, toPrepare: 0, preparing: 0, readyNotOpened: 0, applied: 0, expired: 0 };
  for (const it of items) {
    c[tabOf(it)] += 1;
    if (canPrepare(it.state)) c.toPrepare += 1;
    if (it.state === 'preparing') c.preparing += 1;
    if (it.state === 'expired') c.expired += 1;
    if (it.state === 'opened' || it.state === 'applied') c.applied += 1;
    if (isReadyNotOpened(it.state)) c.readyNotOpened += 1;
  }
  return c;
}

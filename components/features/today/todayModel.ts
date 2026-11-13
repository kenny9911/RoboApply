// components/features/today/todayModel.ts — what /today works out from the
// reads it already has (docs/agent-driven/REDESIGN.md §5). Pure: no React, no
// copy, no request. Callers pass the results to `t()`.
//
// Honesty rules enforced here, not in the markup (rulings D3, C38):
//   • "Waiting for you" lists only what a loaded read reported. Nothing is
//     listed while any of its reads is still loading (a card that arrives late
//     would take the first place, and with it the screen's one primary
//     button, from the card the user is reading);
//   • a read that failed adds nothing and marks the list `partial`: the page
//     then never says "Nothing is waiting for you";
//   • every number is `null` until its read has answered. `null` renders "—",
//     never 0.
//
// Order of the cards, most urgent first (REDESIGN §5.2):
//   1. review     an application is ready to check        → Check and open
//   2. open       an approved application, not opened yet → Open application
//   3. verify     new details in a tailored resume        → Verify details
//   4. no_reply   applications with no reply in 10 days   → See them
//   5. profile    details application forms ask for       → Add details
//   6. no_resume  no resume at all                        → Add a resume
//   7. setup      setup left early                        → Finish setting up
// A resume version that belongs to an application on the list is verified on
// that application's own page, so it is one card (the application), not two.

import { countKits, jobSummaryOf, tailorSessionIdOf, type ReadyQueueItem } from '../../../hooks/agent';
import type { FilterSet } from '../../../hooks/search';
import type { Loadable, TodaySources } from '../../../hooks/today';
import { countAwaitingReply } from '../../../hooks/tracker/useApplicationsBadge';
import type { PipelineBoardData } from '../../../hooks/usePipelineBoard';
import { BASE_SLOT_KINDS, type ResumeSummary } from '../../../lib/api/resumes';
import { weekOf } from '../tracker';

// ── Waiting for you ─────────────────────────────────────────────────────────

export type WaitingKind = 'review' | 'open' | 'verify' | 'no_reply' | 'profile' | 'no_resume' | 'setup';

export type WaitingItem =
  | { kind: 'review' | 'open'; key: string; jobId: string; title: string | null; company: string | null }
  | { kind: 'verify'; key: string; resumeId: string; sessionId: string | null; name: string; count: number }
  | { kind: 'no_reply'; key: 'no_reply'; count: number }
  | { kind: 'profile'; key: 'profile'; count: number }
  | { kind: 'no_resume'; key: 'no_resume' }
  | { kind: 'setup'; key: 'setup'; count: number };

/** Cards on screen at most. */
export const WAITING_LIMIT = 4;

export interface WaitingState {
  /** `loading` until every read behind the list has answered or failed. */
  status: 'loading' | 'ready';
  /** Everything that waits, most urgent first. Not capped: the title counts these. */
  items: WaitingItem[];
  /** The cards: the first WAITING_LIMIT of `items`. */
  shown: WaitingItem[];
  /** How many wait beyond the cards. */
  more: number;
  /** A read failed, so there may be more than `items`. */
  partial: boolean;
  /** Ask the failed reads again. */
  retry: () => void;
}

export type WaitingSources = Pick<TodaySources, 'queue' | 'resumes' | 'board' | 'profileMissing' | 'setupStepsLeft'>;

const isBase = (r: Pick<ResumeSummary, 'kind'>): boolean => BASE_SLOT_KINDS.includes(r.kind);
const oldestFirst = (a: ReadyQueueItem, b: ReadyQueueItem): number => a.updatedAt.localeCompare(b.updatedAt);

function kitItem(kind: 'review' | 'open', item: ReadyQueueItem): WaitingItem {
  const job = jobSummaryOf(item);
  return { kind, key: `${kind}:${item.id}`, jobId: item.jobId, title: job?.title ?? null, company: job?.companyName?.trim() ? job.companyName : null };
}

/** Tailored versions with details still to verify, newest edit first, without the ones an application on the list owns. */
function verifyItems(resumes: readonly ResumeSummary[], queue: readonly ReadyQueueItem[] | null): WaitingItem[] {
  const kitResumes = new Set<string>();
  const kitSessions = new Set<string>();
  for (const item of queue ?? []) {
    if (item.resumeVariantId) kitResumes.add(item.resumeVariantId);
    const session = tailorSessionIdOf(item);
    if (session) kitSessions.add(session);
  }
  return resumes
    .filter((r) => !isBase(r) && (r.unverifiedClaims ?? 0) > 0)
    .filter((r) => !kitResumes.has(r.id) && !(r.tailorSessionId && kitSessions.has(r.tailorSessionId)))
    .sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt))
    .map((r) => ({ kind: 'verify' as const, key: `verify:${r.id}`, resumeId: r.id, sessionId: r.tailorSessionId ?? null, name: r.name, count: r.unverifiedClaims ?? 0 }));
}

/** Everything that waits for the user, in order. `now` is injectable for tests. */
export function waitingOf(sources: WaitingSources, now: number = Date.now()): WaitingState {
  const reads: Array<Loadable<unknown>> = [sources.queue, sources.resumes, sources.board, sources.profileMissing, sources.setupStepsLeft];
  const failed = reads.filter((r): r is Extract<Loadable<unknown>, { status: 'error' }> => r.status === 'error');
  const retry = () => failed.forEach((r) => r.retry());
  if (reads.some((r) => r.status === 'loading')) return { status: 'loading', items: [], shown: [], more: 0, partial: false, retry };

  const queue = sources.queue.status === 'ready' ? sources.queue.data : null;
  const items: WaitingItem[] = [];

  if (queue) {
    for (const kit of queue.filter((i) => i.state === 'ready_for_review').sort(oldestFirst)) items.push(kitItem('review', kit));
    for (const kit of queue.filter((i) => i.state === 'approved').sort(oldestFirst)) items.push(kitItem('open', kit));
  }
  if (sources.resumes.status === 'ready') items.push(...verifyItems(sources.resumes.data, queue));
  if (sources.board.status === 'ready') {
    const count = countAwaitingReply(sources.board.data.entries, now);
    if (count > 0) items.push({ kind: 'no_reply', key: 'no_reply', count });
  }
  if (sources.profileMissing.status === 'ready' && sources.profileMissing.data > 0) {
    items.push({ kind: 'profile', key: 'profile', count: sources.profileMissing.data });
  }
  if (sources.resumes.status === 'ready' && !sources.resumes.data.some(isBase)) items.push({ kind: 'no_resume', key: 'no_resume' });
  if (sources.setupStepsLeft.status === 'ready' && sources.setupStepsLeft.data > 0) {
    items.push({ kind: 'setup', key: 'setup', count: sources.setupStepsLeft.data });
  }

  const shown = items.slice(0, WAITING_LIMIT);
  return { status: 'ready', items, shown, more: items.length - shown.length, partial: failed.length > 0, retry };
}

/** What the page title says about the list. */
export type TitleState = { kind: 'loading' } | { kind: 'count'; count: number } | { kind: 'none' } | { kind: 'partial' };

export function titleOf(waiting: Pick<WaitingState, 'status' | 'items' | 'partial'>): TitleState {
  if (waiting.status === 'loading') return { kind: 'loading' };
  if (waiting.items.length > 0) return { kind: 'count', count: waiting.items.length };
  // Nothing loaded AND something failed: "Nothing is waiting" would be a guess.
  return waiting.partial ? { kind: 'partial' } : { kind: 'none' };
}

// ── Applications ────────────────────────────────────────────────────────────

export interface ApplicationNumbers {
  /** Applications being prepared now (queue state `preparing`). */
  preparing: number | null;
  /** Prepared and not opened yet (`ready_for_review` + `approved`: the nav badge's own rule). */
  waiting: number | null;
  /** Marked applied in the reader's current week (the weeks /applications groups by). */
  sentThisWeek: number | null;
  /** Saved, not applied to. */
  saved: number | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The week (its first day, `YYYY-MM-DD`) a moment falls in for the reader: the tracker's own weeks. */
export function weekOfNow(now: Date): string {
  return weekOf(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`);
}

/** Applications marked applied in the reader's current week. A saved job is not one. Pure. */
export function sentThisWeek(entries: PipelineBoardData['entries'], now: Date = new Date()): number {
  const week = weekOfNow(now);
  return entries.filter((e) => e.status !== 'bookmarked' && !!e.dateApplied && weekOf(e.dateApplied) === week).length;
}

export function applicationNumbers(sources: Pick<TodaySources, 'queue' | 'board'>, now: Date = new Date()): ApplicationNumbers {
  const kits = sources.queue.status === 'ready' ? countKits(sources.queue.data) : null;
  const board = sources.board.status === 'ready' ? sources.board.data : null;
  const saved = board?.statusCounts?.bookmarked;
  return {
    preparing: kits ? kits.preparing : null,
    waiting: kits ? kits.readyNotOpened : null,
    sentThisWeek: board ? sentThisWeek(board.entries, now) : null,
    saved: board ? (typeof saved === 'number' && Number.isFinite(saved) ? saved : 0) : null,
  };
}

// ── The goal line ───────────────────────────────────────────────────────────

/** Values of a group the goal line prints before it says "and N more". */
export const GOAL_GROUP_LIMIT = 3;

export interface GoalFacts {
  /** Job titles as the user wrote them; the search words when there is no title. */
  roles: string[];
  /** Job functions (taxonomy ids), read only when there is no title or search word. */
  roleIds: string[];
  /** Seniority keys (`filters.options.seniority.*`). */
  seniority: string[];
  /** Work model keys (`filters.options.workModels.*`). */
  workModels: string[];
  /** Place labels as the user saved them. */
  places: string[];
}

const texts = (list: readonly unknown[] | undefined): string[] =>
  (list ?? []).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());

/** The parts of a saved search the goal line can state. Only values that exist. Pure. */
export function goalFacts(filters: FilterSet | null | undefined): GoalFacts {
  const titles = texts(filters?.titles);
  const q = typeof filters?.q === 'string' ? filters.q.trim() : '';
  const roles = titles.length ? titles : q ? [q] : [];
  return {
    roles,
    roleIds: roles.length ? [] : texts(filters?.taxonomyIds),
    seniority: texts(filters?.seniority),
    workModels: texts(filters?.workModels),
    places: texts((filters?.locations ?? []).map((l) => l?.label)),
  };
}

/** True when the search states nothing the goal line prints. */
export function goalIsEmpty(facts: GoalFacts): boolean {
  return !facts.roles.length && !facts.roleIds.length && !facts.seniority.length && !facts.workModels.length && !facts.places.length;
}

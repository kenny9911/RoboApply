// backend/src/roboapply/v2/services/RAActivityService.ts
//
// Activity-log + agent-stats service. Projects the V1 auto-apply engine's run
// history (RoboApplyRun terminal events) into the V3 Activity feed
// (`RAActivityDay[]`, day-grouped) and the agent-stats orb aggregate
// (`RAAgentStats`).
//
// Response-shape parity with the stub (lib/stub/raV2.stub.ts §Activity):
//   - feed({days})  → { days: RAActivityDay[] }   (newest day first, entries
//                      newest-first within a day; only days with >=1 event)
//   - orbStats()    → { stats: RAAgentStats }
//
// Each V1 run can emit ONE activity entry for its most-recent terminal event:
//   submitted        → kind 'success', "Applied to **Company** — **Title**."
//   skipped_by_user  → kind 'action',  "Skipped …", meta 'Skipped'
//   failed           → kind 'note',    "Couldn't auto-apply …", meta failureReason
//   undone           → kind 'action',  "Undid …", meta 'Undone'
//   queued/previewing→ kind 'note',    "Queued … for review", meta 'In queue'
//
// `meta` carries "Xm saved" for successful submits so the UI renders the green
// pill (the stub keys the pill off the substring "saved").
//
// All reads go through `v1Bridge`.

import {
  getMissionForUser,
  getRunStatsForUser,
  listHistoryRunsForUser,
  type V1RunRow,
} from '../lib/v1Bridge.js';
import { logger } from '../../../services/LoggerService.js';

export type RAActivityKind = 'success' | 'action' | 'note' | 'violet';

export interface RAActivityEntry {
  id: string;
  at: string;
  kind: RAActivityKind;
  bodyMarkdown: string;
  meta: string | null;
  relatedJobId: string | null;
}

export interface RAActivityDay {
  label: string;
  dateUtc: string;
  entries: RAActivityEntry[];
}

export interface RAAgentStats {
  sent: number;
  replies: number;
  hoursSaved: number;
  autoAppliedToday: number;
  scannedOvernight: number;
  matchedAboveThreshold: number;
  inQueue: number;
  draftsWritten: number;
  replyRate: number;
  hoursSavedLifetime: number;
  currentAction: string | null;
}

export interface ActivityFeedResult {
  days: RAActivityDay[];
}

export interface AgentStatsResult {
  stats: RAAgentStats;
}

const DAY_MS = 86_400_000;

/** Estimated minutes a single auto-apply saves the user — used to render the
 *  "Xm saved" pill. V1 doesn't time individual submits, so we use a flat
 *  per-application estimate. (Contract gap: V1 lacks a per-event "saved"
 *  measure; derived. See report.) */
const MINUTES_SAVED_PER_APPLY = 9;

// ── date helpers ─────────────────────────────────────────────────────

function iso(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function dateKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Build the day-header label the same way the fixture does:
 *  "Today · Thu, May 26", "Yesterday · Wed, May 25", else "Tue, May 24". */
function dayLabel(dateUtc: string, todayKey: string, yesterdayKey: string): string {
  const d = new Date(dateUtc + 'T00:00:00.000Z');
  const weekday = WEEKDAYS[d.getUTCDay()];
  const month = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const stamp = `${weekday}, ${month} ${day}`;
  if (dateUtc === todayKey) return `Today · ${stamp}`;
  if (dateUtc === yesterdayKey) return `Yesterday · ${stamp}`;
  return stamp;
}

/** Pick the event timestamp + status that best represents a run's most recent
 *  history-worthy moment. */
function eventMomentFor(run: V1RunRow): { at: Date; effectiveStatus: string } {
  switch (run.status) {
    case 'submitted':
      return { at: run.actualSubmitAt ?? run.updatedAt, effectiveStatus: 'submitted' };
    case 'undone':
      return { at: run.undoneAt ?? run.updatedAt, effectiveStatus: 'undone' };
    case 'failed':
      return { at: run.failedAt ?? run.updatedAt, effectiveStatus: 'failed' };
    case 'skipped_by_user':
      return { at: run.updatedAt, effectiveStatus: 'skipped_by_user' };
    case 'queued':
    case 'previewing':
      return { at: run.createdAt, effectiveStatus: run.status };
    default:
      return { at: run.updatedAt, effectiveStatus: run.status };
  }
}

function companyTitle(run: V1RunRow): { company: string; title: string } {
  return {
    company: run.job?.companyName ?? 'a company',
    title: run.job?.title ?? 'a role',
  };
}

/** Turn one V1 run into one activity entry (or null to omit). */
function runToEntry(run: V1RunRow): RAActivityEntry | null {
  const { at, effectiveStatus } = eventMomentFor(run);
  const { company, title } = companyTitle(run);

  let kind: RAActivityKind;
  let bodyMarkdown: string;
  let meta: string | null;

  switch (effectiveStatus) {
    case 'submitted': {
      kind = 'success';
      const live = run.simulated ? ' (simulated — will go live once the board is connected)' : '';
      bodyMarkdown = `Applied to **${company}** — **${title}**.${live}`;
      meta = `${MINUTES_SAVED_PER_APPLY}m saved`;
      break;
    }
    case 'skipped_by_user': {
      kind = 'action';
      bodyMarkdown = `Skipped auto-apply for **${company}** — **${title}**.`;
      meta = 'Skipped';
      break;
    }
    case 'failed': {
      kind = 'note';
      const reason = run.failureReason ? ` (${run.failureReason})` : '';
      bodyMarkdown = `Couldn't auto-apply to **${company}** — **${title}**${reason}.`;
      meta = run.failureReason ?? 'Failed';
      break;
    }
    case 'undone': {
      kind = 'action';
      bodyMarkdown = `Undid the application to **${company}** — **${title}**.`;
      meta = 'Undone';
      break;
    }
    case 'queued':
    case 'previewing': {
      kind = 'note';
      bodyMarkdown = `Queued **${company}** — **${title}** for your review (match ${run.matchScore}).`;
      meta = 'In queue';
      break;
    }
    default:
      return null;
  }

  return {
    id: run.id,
    at: iso(at),
    kind,
    bodyMarkdown,
    meta,
    relatedJobId: run.jobId,
  };
}

export class RAActivityService {
  /** Day-grouped activity feed for the last `days` days (default 7). */
  async feed(userId: string, days = 7): Promise<ActivityFeedResult> {
    const lookbackDays = Math.min(Math.max(days, 1), 90);
    const since = new Date(Date.now() - lookbackDays * DAY_MS);
    const runs = await listHistoryRunsForUser(userId, since);

    const entries: RAActivityEntry[] = [];
    for (const run of runs) {
      const entry = runToEntry(run);
      if (!entry) continue;
      // Drop events that fall outside the window (a run may have been updated
      // recently but its representative event is older — keep it honest).
      if (new Date(entry.at).getTime() < since.getTime()) continue;
      entries.push(entry);
    }

    // Group by UTC date.
    const byDay = new Map<string, RAActivityEntry[]>();
    for (const e of entries) {
      const key = dateKeyUtc(new Date(e.at));
      const bucket = byDay.get(key);
      if (bucket) bucket.push(e);
      else byDay.set(key, [e]);
    }

    const todayKey = dateKeyUtc(new Date());
    const yesterdayKey = dateKeyUtc(new Date(Date.now() - DAY_MS));

    const dayKeys = [...byDay.keys()].sort((a, b) => b.localeCompare(a)); // newest first
    const out: RAActivityDay[] = dayKeys.map((key) => {
      const dayEntries = (byDay.get(key) ?? []).sort((a, b) =>
        b.at.localeCompare(a.at),
      ); // newest first within the day
      return {
        label: dayLabel(key, todayKey, yesterdayKey),
        dateUtc: key,
        entries: dayEntries,
      };
    });

    return { days: out };
  }

  /** The agent-stats orb aggregate. Cheap; reused by Today + sidebar + Plan. */
  async orbStats(userId: string): Promise<AgentStatsResult> {
    const mission = await getMissionForUser(userId);
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);

    const { byStatus, submittedToday, pendingCount } = await getRunStatsForUser(
      userId,
      startOfTodayUtc,
    );

    const sent = byStatus['submitted'] ?? 0;
    const draftsWritten =
      (byStatus['submitted'] ?? 0) +
      (byStatus['previewing'] ?? 0) +
      (byStatus['skipped_by_user'] ?? 0) +
      (byStatus['undone'] ?? 0);

    // V1 has no reply/response tracking surface (that's an integrations
    // concern, not the auto-apply engine) → 0. (Contract gap. See report.)
    const replies = 0;
    const replyRate = sent > 0 ? Math.round((replies / sent) * 100) / 100 : 0;

    const hoursSaved =
      Math.round((sent * MINUTES_SAVED_PER_APPLY) / 60 * 10) / 10;
    // Lifetime mirrors the mission's authoritative totalSubmitted counter when
    // present (survives run pruning); falls back to the windowed `sent`.
    const lifetimeSubmitted = mission?.totalSubmitted ?? sent;
    const hoursSavedLifetime =
      Math.round((lifetimeSubmitted * MINUTES_SAVED_PER_APPLY) / 60 * 10) / 10;

    const stats: RAAgentStats = {
      sent,
      replies,
      hoursSaved,
      autoAppliedToday: submittedToday,
      // V1 doesn't persist an overnight-scan counter or threshold-match counter
      // on the mission; surface what we can and leave the marketing-y ones at 0.
      // (Contract gap. See report.)
      scannedOvernight: 0,
      matchedAboveThreshold: pendingCount,
      inQueue: pendingCount,
      draftsWritten,
      replyRate,
      hoursSavedLifetime,
      currentAction: null,
    };

    logger.info('RA_V2_ACTIVITY', 'orb stats computed', {
      userId,
      sent,
      inQueue: pendingCount,
    });
    return { stats };
  }
}

export const raActivityService = new RAActivityService();
export const _internal_runToEntry = runToEntry;

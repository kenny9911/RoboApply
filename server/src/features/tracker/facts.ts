// server/src/features/tracker/facts.ts — pure rules for follow-up facts and
// the weekly counts (WP-38; rulings C11, C40; PRODUCT F-NOTIF-08).
//
// Facts, not predictions: every item says what happened ("applied 12 days
// ago, still at Applied"), never what will happen. There is no reply signal in
// the data model; a reply is the user moving the entry out of Applied.

import {
  AWAITING_REPLY_STATUSES,
  INTERVIEW_STATUSES,
  NO_REPLY_DAYS,
  OFFER_STATUSES,
  TERMINAL_STATUSES,
  type FollowUpReason,
  type FollowUpView,
  type WeeklyFacts,
} from './contract.js';
import type { TrackerMarket } from './stages.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Saved-job deadline window: 2 days on RoboApply (48 h), 3 days on GoApply (网申截止). */
export const DEADLINE_WINDOW_DAYS: Record<TrackerMarket, number> = { intl: 2, cn: 3 };

export interface FactEntry {
  id: string;
  status: string;
  dateApplied: Date | null;
  followUpAt: Date | null;
  interviewAt: Date | null;
  /** Date-only semantics (stored at UTC midnight). */
  deadline: Date | null;
  companyName: string | null;
  title: string | null;
}

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole days from `from` to `to` (calendar days in UTC). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

const REASON_ORDER: Record<FollowUpReason, number> = {
  interview_tomorrow: 0,
  deadline_soon: 1,
  follow_up_due: 2,
  no_reply_10d: 3,
};

/** Every follow-up fact that holds for these entries at `now`. */
export function computeFollowUps(entries: readonly FactEntry[], now: Date, market: TrackerMarket): FollowUpView[] {
  const out: FollowUpView[] = [];
  const nowMs = now.getTime();
  const noReplyCutoff = nowMs - NO_REPLY_DAYS * DAY_MS;
  for (const e of entries) {
    if ((TERMINAL_STATUSES as readonly string[]).includes(e.status)) continue;
    const base = { entryId: e.id, companyName: e.companyName, title: e.title };

    if (e.followUpAt) {
      // A follow-up date the user set replaces the 10-day rule (a future date snoozes it).
      if (e.followUpAt.getTime() <= nowMs) out.push({ ...base, reason: 'follow_up_due', at: e.followUpAt.toISOString(), days: null });
    } else if (
      (AWAITING_REPLY_STATUSES as readonly string[]).includes(e.status) &&
      e.dateApplied &&
      e.dateApplied.getTime() <= noReplyCutoff
    ) {
      out.push({
        ...base,
        reason: 'no_reply_10d',
        at: e.dateApplied.toISOString(),
        days: Math.floor((nowMs - e.dateApplied.getTime()) / DAY_MS),
      });
    }

    if (e.interviewAt && e.interviewAt.getTime() > nowMs && e.interviewAt.getTime() <= nowMs + DAY_MS) {
      out.push({ ...base, reason: 'interview_tomorrow', at: e.interviewAt.toISOString(), days: null });
    }

    if (e.status === 'bookmarked' && e.deadline) {
      const left = daysBetween(now, e.deadline);
      if (left >= 0 && left <= DEADLINE_WINDOW_DAYS[market]) {
        out.push({ ...base, reason: 'deadline_soon', at: e.deadline.toISOString().slice(0, 10), days: left });
      }
    }
  }
  return out.sort(
    (a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || (b.days ?? 0) - (a.days ?? 0) || a.at.localeCompare(b.at),
  );
}

/** Sunday-anchored UTC week containing `d` (YYYY-MM-DD). */
export function weekStartFor(d: Date): string {
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
  return sunday.toISOString().slice(0, 10);
}

export function weekRange(weekStart: string): { start: Date; end: Date; startUtc: string; endUtc: string } {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  return { start, end, startUtc: weekStart, endUtc: new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10) };
}

export interface FactEvent {
  entryId: string;
  kind: string;
  toValue: string | null;
  createdAt: Date;
}

/**
 * The week's counts from the user's own rows. `events` may span more than the
 * week; only those inside it count. Each number counts applications, not
 * events (an entry that moved twice into interview stages counts once).
 */
export function computeWeeklyFacts(
  entries: readonly FactEntry[],
  events: readonly FactEvent[],
  weekStart: string,
  now: Date,
  market: TrackerMarket,
): WeeklyFacts {
  const { start, end, startUtc, endUtc } = weekRange(weekStart);
  const inWeek = (d: Date | null) => d !== null && d.getTime() >= start.getTime() && d.getTime() < end.getTime();
  const weekEvents = events.filter((ev) => inWeek(ev.createdAt));
  const ids = (pred: (ev: FactEvent) => boolean) => new Set(weekEvents.filter(pred).map((ev) => ev.entryId));

  const interviews = ids((ev) => ev.kind === 'status' && (INTERVIEW_STATUSES as readonly string[]).includes(ev.toValue ?? ''));
  for (const e of entries) if (inWeek(e.interviewAt)) interviews.add(e.id);
  const offers = ids((ev) => ev.kind === 'status' && (OFFER_STATUSES as readonly string[]).includes(ev.toValue ?? ''));
  const ended = ids(
    (ev) =>
      (ev.kind === 'outcome' && ev.toValue !== null) ||
      (ev.kind === 'status' && (TERMINAL_STATUSES as readonly string[]).includes(ev.toValue ?? '')),
  );

  return {
    weekStart: startUtc,
    weekEnd: endUtc,
    applied: entries.filter((e) => inWeek(e.dateApplied)).length,
    interviews: interviews.size,
    offers: offers.size,
    ended: ended.size,
    noReply10d: computeFollowUps(entries, now, market).filter((f) => f.reason === 'no_reply_10d').length,
  };
}

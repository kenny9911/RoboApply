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

// ── The user's own calendar (FIX-3) ────────────────────────────────────────
//
// A tracker date is either a moment (the instant the user marked a job
// applied) or a calendar day the user picked (stored as UTC midnight). A
// moment belongs to the day and the week it happened in FOR THE USER: 02:25
// on Sunday Oct 11 in Taipei is 18:25 UTC on Saturday Oct 10, and counting it
// in the UTC week put it in last week. The zone is the IANA name captured at
// signup (`SeekerProfile.timezone`); 'UTC' when unknown or invalid.

function safeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: Date, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    zoneFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! % 24, min: p.minute!, s: p.second! };
}

/** Minutes the zone is ahead of UTC at `at` (480 for Taipei, -420 for Los Angeles in summer). */
export function zoneOffsetMinutes(at: Date, timeZone: string | null | undefined): number {
  const w = wallClock(at, safeZone(timeZone));
  const wall = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a calendar day starts in the zone (DST-safe). */
export function zonedDayStart(dayKey: string, timeZone: string | null | undefined): Date {
  const utcMidnight = new Date(`${dayKey}T00:00:00.000Z`);
  const first = utcMidnight.getTime() - zoneOffsetMinutes(utcMidnight, timeZone) * 60_000;
  return new Date(utcMidnight.getTime() - zoneOffsetMinutes(new Date(first), timeZone) * 60_000);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a moment in the zone. */
export function zonedDayKey(at: Date, timeZone: string | null | undefined): string {
  const w = wallClock(at, safeZone(timeZone));
  return `${w.y}-${pad2(w.m)}-${pad2(w.d)}`;
}

/** `YYYY-MM-DD HH:mm` of a moment in the zone. */
export function zonedMinute(at: Date, timeZone: string | null | undefined): string {
  const w = wallClock(at, safeZone(timeZone));
  return `${w.y}-${pad2(w.m)}-${pad2(w.d)} ${pad2(w.h)}:${pad2(w.min)}`;
}

/** "UTC+08:00" / "UTC-07:00" / "UTC" for the zone at a moment. */
export function zoneOffsetLabel(at: Date, timeZone: string | null | undefined): string {
  const min = zoneOffsetMinutes(at, timeZone);
  if (min === 0) return 'UTC';
  const abs = Math.abs(min);
  return `UTC${min > 0 ? '+' : '-'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** A stored date that is a picked calendar day (exactly UTC midnight), not a moment. */
export function isCalendarDay(d: Date): boolean {
  return d.getTime() % DAY_MS === 0;
}

/** The calendar day a stored tracker date falls on for the user: a picked day as it is, a moment in their zone. */
export function userDayKey(d: Date, timeZone: string | null | undefined): string {
  return isCalendarDay(d) ? d.toISOString().slice(0, 10) : zonedDayKey(d, timeZone);
}

/** Sunday-anchored week containing `d` (YYYY-MM-DD), in the zone (UTC by default). */
export function weekStartFor(d: Date, timeZone: string | null | undefined = 'UTC'): string {
  const day = new Date(`${zonedDayKey(d, timeZone)}T00:00:00.000Z`);
  return new Date(day.getTime() - day.getUTCDay() * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The seven days from `weekStart`, as instants in the zone. `startUtc` /
 * `endUtc` are the first and last calendar day of the week (names kept from
 * the UTC-only version; they are day keys, not instants).
 */
export function weekRange(weekStart: string, timeZone: string | null | undefined = 'UTC'): { start: Date; end: Date; startUtc: string; endUtc: string } {
  const firstDay = new Date(`${weekStart}T00:00:00.000Z`);
  const nextWeek = new Date(firstDay.getTime() + 7 * DAY_MS).toISOString().slice(0, 10);
  return {
    start: zonedDayStart(weekStart, timeZone),
    end: zonedDayStart(nextWeek, timeZone),
    startUtc: weekStart,
    endUtc: new Date(firstDay.getTime() + 6 * DAY_MS).toISOString().slice(0, 10),
  };
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
  timeZone: string | null | undefined = 'UTC',
): WeeklyFacts {
  const { start, end, startUtc, endUtc } = weekRange(weekStart, timeZone);
  const inWeek = (d: Date | null) => d !== null && d.getTime() >= start.getTime() && d.getTime() < end.getTime();
  // "Applied on" may be a day the user picked: it counts by its day, not by where UTC midnight falls in their zone.
  const dayInWeek = (d: Date | null) => {
    if (d === null) return false;
    if (!isCalendarDay(d)) return inWeek(d);
    const key = d.toISOString().slice(0, 10);
    return key >= startUtc && key <= endUtc;
  };
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
    applied: entries.filter((e) => dayInWeek(e.dateApplied)).length,
    interviews: interviews.size,
    offers: offers.size,
    ended: ended.size,
    noReply10d: computeFollowUps(entries, now, market).filter((f) => f.reason === 'no_reply_10d').length,
  };
}

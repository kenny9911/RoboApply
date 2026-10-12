// server/src/features/alerts/time.ts
//
// User-local time for notifications (PRODUCT §7.1–§7.2): quiet hours
// 21:00–08:00 local for everything non-transactional, digests at 08:00 local
// (daily) and Monday 08:00 local (weekly), "per day" counted in the user's
// own day. Pure functions; the time zone is the IANA name captured at signup
// (`SeekerProfile.timezone`), falling back per brand.

import type { BrandId } from '../../platform/brand/registry.js';

export interface QuietHours {
  /** 'HH:MM' local. */
  start: string;
  /** 'HH:MM' local. */
  end: string;
}

export const DEFAULT_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ start: '21:00', end: '08:00' });

/** Digests go out from 08:00 local; the window stays open until noon so a missed tick still sends. */
export const DIGEST_HOUR_LOCAL = 8;
export const DIGEST_WINDOW_END_HOUR = 12;

/**
 * Time zone when the user never gave one: GoApply users are in mainland
 * China; for RoboApply we do not guess a country, so UTC.
 */
export function fallbackTimeZone(brand: BrandId): string {
  return brand === 'goapply' ? 'Asia/Shanghai' : 'UTC';
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz: string | null | undefined, brand: BrandId): string {
  return isValidTimeZone(tz) ? tz.trim() : fallbackTimeZone(brand);
}

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** 'YYYY-MM-DD' in the zone. */
  dayKey: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localTime(now: Date, tz: string): LocalTime {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(now)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const weekday = WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { year, month, day, hour, minute, weekday, dayKey: `${year}-${pad(month)}-${pad(day)}` };
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** A user's quiet hours, or the default when the stored value is malformed. */
export function normalizeQuietHours(q: Partial<QuietHours> | null | undefined): QuietHours {
  if (q && typeof q.start === 'string' && typeof q.end === 'string' && minutesOf(q.start) !== null && minutesOf(q.end) !== null) {
    return { start: q.start, end: q.end };
  }
  return { ...DEFAULT_QUIET_HOURS };
}

/** True inside quiet hours (start inclusive, end exclusive; a window may cross midnight). */
export function inQuietHours(now: Date, tz: string, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const q = normalizeQuietHours(quiet);
  const start = minutesOf(q.start)!;
  const end = minutesOf(q.end)!;
  if (start === end) return false;
  const lt = localTime(now, tz);
  const cur = lt.hour * 60 + lt.minute;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Milliseconds until quiet hours end (0 when not inside them). */
export function msUntilQuietEnds(now: Date, tz: string, quiet: QuietHours = DEFAULT_QUIET_HOURS): number {
  if (!inQuietHours(now, tz, quiet)) return 0;
  const end = minutesOf(normalizeQuietHours(quiet).end)!;
  const lt = localTime(now, tz);
  const cur = lt.hour * 60 + lt.minute;
  const diff = (end - cur + 24 * 60) % (24 * 60);
  return Math.max(60_000, diff * 60_000);
}

/** Local calendar-day key ('YYYY-MM-DD'). */
export function localDayKey(date: Date, tz: string): string {
  return localTime(date, tz).dayKey;
}

/** Start of the user's local day, as an instant (DST-safe to the minute). */
export function startOfLocalDay(now: Date, tz: string): Date {
  const lt = localTime(now, tz);
  return new Date(now.getTime() - (lt.hour * 60 + lt.minute) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds());
}

export type DigestCadence = 'daily' | 'weekly';

export function parseDigestCadence(v: unknown): DigestCadence | null {
  return v === 'daily' || v === 'weekly' ? v : null;
}

/**
 * Whether a digest is due now: daily from 08:00 local, weekly on Monday from
 * 08:00 local, at most once per local day (daily) or per 6+ days (weekly).
 */
export function digestDue(cadence: DigestCadence, now: Date, tz: string, lastDigestAt: Date | null): boolean {
  const lt = localTime(now, tz);
  if (lt.hour < DIGEST_HOUR_LOCAL || lt.hour >= DIGEST_WINDOW_END_HOUR) return false;
  if (cadence === 'weekly' && lt.weekday !== 1) return false;
  if (!lastDigestAt) return true;
  if (localDayKey(lastDigestAt, tz) === lt.dayKey) return false;
  if (cadence === 'weekly' && now.getTime() - lastDigestAt.getTime() < 6 * 24 * 3_600_000) return false;
  return true;
}

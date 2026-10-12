// server/src/platform/credits/windows.ts
//
// Credit window keys and reset times in the user's time zone
// (ARCHITECTURE.md §7.3; PRODUCT_PLAN.md §6.1 rule 5: credits refill at local
// midnight and never roll over).
//
//   day   → 'd:YYYY-MM-DD'   resets at the next local midnight
//   week  → 'w:GGGG-Www'     ISO week; resets at local Monday 00:00
//   month → 'm:YYYY-MM'      resets at local 00:00 on the 1st
//
// Pure functions over `Intl.DateTimeFormat`; no dependencies. An unknown or
// blank time zone falls back to the caller's fallback (the brand default),
// then to UTC.

export type CreditWindow = 'day' | 'week' | 'month';

export const CREDIT_WINDOWS: readonly CreditWindow[] = ['day', 'week', 'month'];

const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    formatterFor(tz.trim());
    return true;
  } catch {
    return false;
  }
}

/** The first valid zone of `tz`, `fallback`, 'UTC'. */
export function safeTimeZone(tz: string | null | undefined, fallback = 'UTC'): string {
  if (isValidTimeZone(tz)) return tz.trim();
  if (isValidTimeZone(fallback)) return fallback.trim();
  return 'UTC';
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (local − UTC). */
function offsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of local 00:00 on (year, month, day) in `timeZone`. */
export function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  return new Date(second);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Civil date arithmetic in UTC space (no zone involved). */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Monday = 0 … Sunday = 6 for a civil date. */
function isoWeekday(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** ISO-8601 week-numbering year and week of a civil date. */
export function isoWeek(year: number, month: number, day: number): { isoYear: number; week: number } {
  const dow = isoWeekday(year, month, day);
  const thursday = new Date(Date.UTC(year, month - 1, day) + (3 - dow) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Dow * DAY_MS;
  const monday = Date.UTC(year, month - 1, day) - dow * DAY_MS;
  return { isoYear, week: Math.floor((monday - week1Monday) / (7 * DAY_MS)) + 1 };
}

/** The window key for `date` in `timeZone`. */
export function windowKeyFor(window: CreditWindow, date: Date, timeZone: string): string {
  const tz = safeTimeZone(timeZone);
  const p = zonedParts(date, tz);
  switch (window) {
    case 'day':
      return `d:${p.year}-${pad(p.month)}-${pad(p.day)}`;
    case 'week': {
      const { isoYear, week } = isoWeek(p.year, p.month, p.day);
      return `w:${isoYear}-W${pad(week)}`;
    }
    case 'month':
      return `m:${p.year}-${pad(p.month)}`;
  }
}

/** When the window that contains `date` ends: the next local midnight, Monday or 1st. */
export function resetsAtFor(window: CreditWindow, date: Date, timeZone: string): Date {
  const tz = safeTimeZone(timeZone);
  const p = zonedParts(date, tz);
  switch (window) {
    case 'day': {
      const next = addDays(p.year, p.month, p.day, 1);
      return zonedMidnightToUtc(next.year, next.month, next.day, tz);
    }
    case 'week': {
      const next = addDays(p.year, p.month, p.day, 7 - isoWeekday(p.year, p.month, p.day));
      return zonedMidnightToUtc(next.year, next.month, next.day, tz);
    }
    case 'month': {
      const year = p.month === 12 ? p.year + 1 : p.year;
      const month = p.month === 12 ? 1 : p.month + 1;
      return zonedMidnightToUtc(year, month, 1, tz);
    }
  }
}

/** Key and reset time together (the common call). */
export function currentWindow(
  window: CreditWindow,
  date: Date,
  timeZone: string,
): { window: CreditWindow; windowKey: string; resetsAt: Date } {
  return { window, windowKey: windowKeyFor(window, date, timeZone), resetsAt: resetsAtFor(window, date, timeZone) };
}

/**
 * Off-peak scheduling for GoApply batch LLM work (WP-14; CN_TW_LAUNCH_PLAN
 * WP-LLM-CN: "schedule cn batch scoring and digests inside the vendor's
 * off-peak windows when CN_LLM_OFFPEAK_BATCH=true").
 *
 * The windows are configuration, not code: vendors change their discount
 * windows (or drop them), so nothing here assumes one. Set
 *   CN_LLM_OFFPEAK_BATCH=true
 *   CN_LLM_OFFPEAK_WINDOWS=00:30-08:30          (Beijing time, comma list; a
 *                                               window may wrap midnight)
 * With the switch off, or no valid window configured, batch work runs now.
 *
 * Beijing time is UTC+8 all year (no daylight saving), so the arithmetic is
 * a fixed offset.
 */

import { parseBoolEnv } from '../../platform/brand/brandEnv.js';

const BEIJING_OFFSET_MINUTES = 8 * 60;
const DAY_MINUTES = 24 * 60;

/** One window in Beijing minutes after midnight; `end` may be < `start` (wraps midnight). */
export interface OffPeakWindow {
  start: number;
  end: number;
}

function parseClock(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** "00:30-08:30, 13:00-14:00" → windows; malformed or empty entries are skipped. */
export function parseOffPeakWindows(spec: string | undefined | null): OffPeakWindow[] {
  if (!spec) return [];
  const out: OffPeakWindow[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-');
    if (a === undefined || b === undefined) continue;
    const start = parseClock(a);
    const end = parseClock(b);
    if (start === null || end === null || start === end) continue;
    out.push({ start: start % DAY_MINUTES, end: end % DAY_MINUTES });
  }
  return out;
}

export interface OffPeakConfig {
  enabled: boolean;
  windows: OffPeakWindow[];
}

export function offPeakConfig(env: Record<string, string | undefined> = process.env): OffPeakConfig {
  return {
    enabled: parseBoolEnv(env.CN_LLM_OFFPEAK_BATCH),
    windows: parseOffPeakWindows(env.CN_LLM_OFFPEAK_WINDOWS),
  };
}

/** Minutes after Beijing midnight for an instant. */
export function beijingMinuteOfDay(now: Date): number {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + BEIJING_OFFSET_MINUTES) % DAY_MINUTES;
}

function inWindow(minute: number, w: OffPeakWindow): boolean {
  return w.start < w.end ? minute >= w.start && minute < w.end : minute >= w.start || minute < w.end;
}

export function isOffPeak(now: Date, windows: readonly OffPeakWindow[]): boolean {
  const minute = beijingMinuteOfDay(now);
  return windows.some((w) => inWindow(minute, w));
}

/** The next instant a window opens (null when there are no windows). */
export function nextOffPeakStart(now: Date, windows: readonly OffPeakWindow[]): Date | null {
  if (windows.length === 0) return null;
  const minute = beijingMinuteOfDay(now);
  let best = Infinity;
  for (const w of windows) {
    const delta = (w.start - minute + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
    best = Math.min(best, delta);
  }
  const startOfMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(startOfMinute + best * 60_000);
}

export type OffPeakDecisionReason = 'disabled' | 'no_windows' | 'in_window' | 'deferred';

export interface OffPeakDecision {
  runNow: boolean;
  /** When to run (now, or the next window start). */
  runAt: Date;
  reason: OffPeakDecisionReason;
}

/**
 * Should a GoApply batch job run now? Off-peak deferral applies only when the
 * switch is on AND a window is configured; inside a window it runs now,
 * otherwise `runAt` is the next window start (enqueue with that `runAt`).
 */
export function offPeakDecision(now: Date = new Date(), env: Record<string, string | undefined> = process.env): OffPeakDecision {
  const config = offPeakConfig(env);
  if (!config.enabled) return { runNow: true, runAt: now, reason: 'disabled' };
  if (config.windows.length === 0) return { runNow: true, runAt: now, reason: 'no_windows' };
  if (isOffPeak(now, config.windows)) return { runNow: true, runAt: now, reason: 'in_window' };
  return { runNow: false, runAt: nextOffPeakStart(now, config.windows) ?? now, reason: 'deferred' };
}

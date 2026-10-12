// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { beijingMinuteOfDay, isOffPeak, nextOffPeakStart, offPeakDecision, parseOffPeakWindows } from './offPeak.js';

// 2026-10-10T18:00:00Z = 02:00 Beijing (UTC+8, no DST).
const at = (iso: string) => new Date(iso);

describe('offPeak', () => {
  it('parses windows and skips malformed entries', () => {
    expect(parseOffPeakWindows('00:30-08:30, 13:00-14:00')).toEqual([
      { start: 30, end: 510 },
      { start: 780, end: 840 },
    ]);
    expect(parseOffPeakWindows('22:00-02:00')).toEqual([{ start: 1320, end: 120 }]);
    expect(parseOffPeakWindows('bad, 25:00-01:00, 01:00-01:00, 7-8')).toEqual([]);
    expect(parseOffPeakWindows(undefined)).toEqual([]);
  });

  it('computes Beijing time with a fixed +8 offset', () => {
    expect(beijingMinuteOfDay(at('2026-10-10T18:00:00Z'))).toBe(120);
    expect(beijingMinuteOfDay(at('2026-10-10T16:00:00Z'))).toBe(0);
  });

  it('handles windows that wrap midnight', () => {
    const w = parseOffPeakWindows('22:00-02:00');
    expect(isOffPeak(at('2026-10-10T15:00:00Z'), w)).toBe(true); // 23:00
    expect(isOffPeak(at('2026-10-10T17:59:00Z'), w)).toBe(true); // 01:59
    expect(isOffPeak(at('2026-10-10T18:00:00Z'), w)).toBe(false); // 02:00
  });

  it('runs now when the switch is off or no window is configured (nothing assumed)', () => {
    const now = at('2026-10-10T04:00:00Z');
    expect(offPeakDecision(now, {})).toMatchObject({ runNow: true, reason: 'disabled' });
    expect(offPeakDecision(now, { CN_LLM_OFFPEAK_BATCH: 'true' })).toMatchObject({ runNow: true, reason: 'no_windows' });
  });

  it('defers to the next window start, or runs inside a window', () => {
    const env = { CN_LLM_OFFPEAK_BATCH: 'true', CN_LLM_OFFPEAK_WINDOWS: '00:30-08:30' };
    // 12:00 Beijing → next start 00:30 Beijing = 16:30Z.
    const d = offPeakDecision(at('2026-10-10T04:00:00Z'), env);
    expect(d).toMatchObject({ runNow: false, reason: 'deferred' });
    expect(d.runAt.toISOString()).toBe('2026-10-10T16:30:00.000Z');
    expect(offPeakDecision(at('2026-10-10T18:00:00Z'), env)).toMatchObject({ runNow: true, reason: 'in_window' });
    expect(nextOffPeakStart(at('2026-10-10T04:00:00Z'), [])).toBeNull();
  });
});

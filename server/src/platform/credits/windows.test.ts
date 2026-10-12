// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isValidTimeZone, isoWeek, resetsAtFor, safeTimeZone, windowKeyFor, zonedMidnightToUtc } from './windows.js';

describe('windowKeyFor', () => {
  it('formats day, week and month keys', () => {
    const at = new Date('2026-10-09T12:00:00Z');
    expect(windowKeyFor('day', at, 'UTC')).toBe('d:2026-10-09');
    expect(windowKeyFor('week', at, 'UTC')).toBe('w:2026-W41');
    expect(windowKeyFor('month', at, 'UTC')).toBe('m:2026-10');
  });

  it('uses the user time zone, not UTC', () => {
    // 17:30 UTC on Oct 9 is already Oct 10 in Shanghai (UTC+8) and still Oct 9 in Los Angeles.
    const at = new Date('2026-10-09T17:30:00Z');
    expect(windowKeyFor('day', at, 'Asia/Shanghai')).toBe('d:2026-10-10');
    expect(windowKeyFor('day', at, 'America/Los_Angeles')).toBe('d:2026-10-09');
  });

  it('uses ISO week-numbering years at the year edges', () => {
    expect(isoWeek(2026, 1, 1)).toEqual({ isoYear: 2026, week: 1 }); // Thursday
    expect(isoWeek(2027, 1, 1)).toEqual({ isoYear: 2026, week: 53 }); // Friday belongs to 2026-W53
    expect(isoWeek(2024, 12, 30)).toEqual({ isoYear: 2025, week: 1 }); // Monday of 2025-W01
    expect(windowKeyFor('week', new Date('2027-01-01T10:00:00Z'), 'UTC')).toBe('w:2026-W53');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(windowKeyFor('day', new Date('2026-10-09T23:30:00Z'), 'Not/AZone')).toBe('d:2026-10-09');
  });
});

describe('resetsAtFor', () => {
  it('returns the next local midnight for day windows', () => {
    const at = new Date('2026-10-09T17:30:00Z'); // Oct 10 01:30 in Shanghai
    expect(resetsAtFor('day', at, 'Asia/Shanghai').toISOString()).toBe('2026-10-10T16:00:00.000Z');
    expect(resetsAtFor('day', at, 'UTC').toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('returns local Monday 00:00 for week windows', () => {
    const friday = new Date('2026-10-09T12:00:00Z');
    expect(resetsAtFor('week', friday, 'UTC').toISOString()).toBe('2026-10-12T00:00:00.000Z');
    const monday = new Date('2026-10-12T00:00:00Z');
    expect(resetsAtFor('week', monday, 'UTC').toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('returns the 1st of next month for month windows, across the year end', () => {
    expect(resetsAtFor('month', new Date('2026-12-15T00:00:00Z'), 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles daylight-saving changes', () => {
    // New York springs forward on 2026-03-08; midnight on Mar 9 is 04:00Z (EDT), not 05:00Z.
    expect(resetsAtFor('day', new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(zonedMidnightToUtc(2026, 3, 8, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('time zones', () => {
  it('validates and falls back', () => {
    expect(isValidTimeZone('Asia/Taipei')).toBe(true);
    expect(isValidTimeZone('nope')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(safeTimeZone(null, 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(safeTimeZone('bad', 'also-bad')).toBe('UTC');
    expect(safeTimeZone(' Europe/Berlin ')).toBe('Europe/Berlin');
  });
});

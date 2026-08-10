// relativeTime.formatRelativeTime — the locale-aware "2 days ago" used by the
// practice recent-sessions strip and the admin tables.
//
// INVARIANT: no English ever reaches a non-en locale. The previous hand-rolled
// `${n}d ago` builder on the practice page rendered English to all nine locales;
// these assertions pin the localized output so nobody reintroduces one.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../../lib/relativeTime';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const agoMs = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Formatted at a fixed NOW, with ICU's non-breaking spaces (fr: "5 min")
 *  flattened so the expectations below stay readable. */
function at(iso: string, locale: string): string {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    return formatRelativeTime(iso, locale).replace(/[  ]/g, ' ');
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

describe('formatRelativeTime', () => {
  it('walks the second → minute → hour → day → month → year ladder', () => {
    expect(at(agoMs(10_000), 'en')).toBe('now');
    expect(at(agoMs(5 * MIN), 'en')).toBe('5 min. ago');
    expect(at(agoMs(3 * HOUR), 'en')).toBe('3 hr. ago');
    expect(at(agoMs(2 * DAY), 'en')).toBe('2 days ago');
    expect(at(agoMs(70 * DAY), 'en')).toBe('2 mo. ago');
    expect(at(agoMs(800 * DAY), 'en')).toBe('2 yr. ago');
  });

  it('renders in the active locale, never English', () => {
    expect(at(agoMs(2 * DAY), 'zh')).toBe('前天');
    expect(at(agoMs(3 * DAY), 'zh-TW')).toBe('3 天前');
    expect(at(agoMs(3 * HOUR), 'ja')).toBe('3 時間前');
    expect(at(agoMs(5 * MIN), 'ko')).toBe('5분 전');
    expect(at(agoMs(5 * MIN), 'es')).toBe('hace 5 min');
    // 'short', not 'narrow': fr narrow degrades to a bare "-5 min".
    expect(at(agoMs(5 * MIN), 'fr')).toBe('il y a 5 min');
    expect(at(agoMs(3 * HOUR), 'pt')).toBe('há 3 h');
    expect(at(agoMs(3 * HOUR), 'de')).toBe('vor 3 Std.');
  });

  it('returns an empty string for a missing or unparseable timestamp', () => {
    expect(formatRelativeTime(null, 'en')).toBe('');
    expect(formatRelativeTime(undefined, 'en')).toBe('');
    expect(formatRelativeTime('not-a-date', 'en')).toBe('');
  });
});

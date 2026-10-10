// WP-38: the Applications badge counts applications with no reply in 10+
// days; a follow-up date still ahead snoozes one (ruling C11).

import { describe, expect, it } from 'vitest';

import { countAwaitingReply, isAwaitingReply } from './useApplicationsBadge';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('isAwaitingReply', () => {
  it('counts applied 10+ days ago, legacy `applying` too', () => {
    expect(isAwaitingReply({ status: 'applied', dateApplied: iso(NOW - 10 * DAY) }, NOW)).toBe(true);
    expect(isAwaitingReply({ status: 'applying', dateApplied: iso(NOW - 30 * DAY) }, NOW)).toBe(true);
    expect(isAwaitingReply({ status: 'applied', dateApplied: iso(NOW - 9 * DAY) }, NOW)).toBe(false);
    expect(isAwaitingReply({ status: 'first_call', dateApplied: iso(NOW - 30 * DAY) }, NOW)).toBe(false);
    expect(isAwaitingReply({ status: 'applied', dateApplied: null }, NOW)).toBe(false);
  });

  it('a follow-up date ahead snoozes it; a past one does not', () => {
    const base = { status: 'applied', dateApplied: iso(NOW - 20 * DAY) };
    expect(isAwaitingReply({ ...base, followUpAt: iso(NOW + DAY) }, NOW)).toBe(false);
    expect(isAwaitingReply({ ...base, followUpAt: iso(NOW - DAY) }, NOW)).toBe(true);
    expect(countAwaitingReply([base, { ...base, followUpAt: iso(NOW + DAY) }], NOW)).toBe(1);
  });
});

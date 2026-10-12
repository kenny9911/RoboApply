// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FitSnapshot } from '../match/contract.js';
import { alertTierOf, digestSince, instantAllowance, instantSince, selectAlertJobs, type ScoredJob } from './selection.js';
import { digestDue, inQuietHours, localTime, msUntilQuietEnds, normalizeQuietHours, resolveTimeZone, startOfLocalDay } from './time.js';

const s = (jobId: string, score: number | null, tier: ScoredJob['tier'], topGap: string | null = null): ScoredJob => ({ jobId, score, tier, topGap });

describe('selectAlertJobs', () => {
  it('keeps only jobs at Possible or better with a known score, minus hidden / tracked / already sent', () => {
    const r = selectAlertJobs({
      candidateIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      excluded: new Set(['b', 'f']), // b hidden, f tracked
      scores: [s('a', 70, 'good', 'SQL'), s('b', 95, 'great'), s('c', 44, 'unlikely'), s('d', null, null), s('e', 82, 'great'), s('f', 90, 'great'), s('g', 45, 'possible')],
      limit: 5,
    });
    expect(r.picked.map((p) => p.jobId)).toEqual(['e', 'a', 'g']);
    expect(r.qualifying).toBe(3);
    // A caller that says nothing about the kind is read as a quick estimate with no snapshot.
    expect(r.picked[1]).toEqual({ jobId: 'a', score: 70, tier: 'good', lowered: false, gap: 'SQL', kind: 'estimate', fit: null });
  });

  it('MKT-2F: a quick estimate with low confidence never counts above Possible: it still alerts, ordered after every fit that earned its tier, and the card keeps the fit\'s own tier (I1)', () => {
    const snap = (kind: FitSnapshot['kind'], score: number, tier: FitSnapshot['tier']): FitSnapshot => ({ score, tier, kind, rubric: 'fit_v3', estimator: 'est_v2', model: kind === 'ai' ? 'm' : null, scoredAt: '2026-10-10T08:00:00.000Z' });
    const scores: ScoredJob[] = [
      // 88 "great" on a post that says almost nothing.
      { jobId: 'thin', score: 88, tier: 'great', topGap: null, kind: 'estimate', confidence: 'low', snapshot: snap('estimate', 88, 'great') },
      { jobId: 'ai', score: 70, tier: 'good', topGap: null, kind: 'ai', confidence: 'high', snapshot: snap('ai', 70, 'good') },
      { jobId: 'est', score: 81, tier: 'great', topGap: null, kind: 'estimate', confidence: 'medium', snapshot: snap('estimate', 81, 'great') },
      // An AI fit keeps its own tier whatever its coverage.
      { jobId: 'aiLow', score: 83, tier: 'great', topGap: null, kind: 'ai', confidence: 'low', snapshot: snap('ai', 83, 'great') },
      // A fit that earned Possible is listed before the thin estimate that only counts as one.
      { jobId: 'poss', score: 50, tier: 'possible', topGap: null, kind: 'estimate', confidence: 'high', snapshot: snap('estimate', 50, 'possible') },
    ];
    const r = selectAlertJobs({ candidateIds: ['thin', 'ai', 'est', 'aiLow', 'poss'], excluded: new Set(), scores, limit: 5 });
    expect(r.picked.map((p) => [p.jobId, p.tier, p.kind, p.lowered])).toEqual([
      ['aiLow', 'great', 'ai', false],
      ['est', 'great', 'estimate', false],
      ['ai', 'good', 'ai', false],
      ['poss', 'possible', 'estimate', false],
      // Last, yet with the tier and score every other surface shows for it.
      ['thin', 'great', 'estimate', true],
    ]);
    // One card, one tier: the tier shown is the tier of the snapshot that travels with it.
    for (const p of r.picked) expect(p.tier).toBe(p.fit!.tier);
    expect(r.picked[4]!.fit).toEqual(snap('estimate', 88, 'great'));
    // What a fit counts as when the alert orders its jobs.
    expect(alertTierOf({ tier: 'great', kind: 'estimate', confidence: 'low' })).toBe('possible');
    expect(alertTierOf({ tier: 'possible', kind: 'estimate', confidence: 'low' })).toBe('possible');
    expect(alertTierOf({ tier: 'unlikely', kind: 'estimate', confidence: 'low' })).toBeNull();
    expect(alertTierOf({ tier: 'great', kind: 'estimate', confidence: 'medium' })).toBe('great');
    expect(alertTierOf({ tier: 'great', kind: 'ai', confidence: 'low' })).toBe('great');
  });

  it('MKT-2F: a thin Good estimate is ordered after a fit that earned Possible, takes the next place, and shows Good', () => {
    const low = (id: string, score: number): ScoredJob => ({ jobId: id, score, tier: 'good', topGap: null, kind: 'estimate', confidence: 'low' });
    const r = selectAlertJobs({ candidateIds: ['l1', 'l2', 'p1'], excluded: new Set(), scores: [low('l1', 66), low('l2', 74), s('p1', 47, 'possible')], limit: 2 });
    expect(r.qualifying).toBe(3);
    expect(r.picked.map((p) => [p.jobId, p.tier, p.lowered])).toEqual([
      ['p1', 'possible', false],
      ['l2', 'good', true],
    ]);
  });

  it('MKT-2F: at the same tier and score an AI fit is listed before a quick estimate', () => {
    const scores: ScoredJob[] = [
      { jobId: 'e', score: 70, tier: 'good', topGap: null, kind: 'estimate', confidence: 'high' },
      { jobId: 'a', score: 70, tier: 'good', topGap: null, kind: 'ai', confidence: 'high' },
    ];
    expect(selectAlertJobs({ candidateIds: ['e', 'a'], excluded: new Set(), scores, limit: 5 }).picked.map((p) => p.jobId)).toEqual(['a', 'e']);
  });

  it('returns nothing (so nothing is sent) when no candidate qualifies', () => {
    const r = selectAlertJobs({ candidateIds: ['a', 'b'], excluded: new Set(), scores: [s('a', 30, 'unlikely'), s('b', null, null)], limit: 5 });
    expect(r).toEqual({ picked: [], qualifying: 0 });
  });

  it('caps at the limit, best score first, ties newest first, and counts every qualifying job', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const r = selectAlertJobs({ candidateIds: ids, excluded: new Set(), scores: ids.map((id) => s(id, 70, 'good')), limit: 5 });
    expect(r.picked.map((p) => p.jobId)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(r.qualifying).toBe(7);
  });

  it('a job without a score is never sent (an unknown is not a fit)', () => {
    const r = selectAlertJobs({ candidateIds: ['a'], excluded: new Set(), scores: [], limit: 5 });
    expect(r.picked).toEqual([]);
  });
});

describe('instantAllowance', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const base = { profileMax: 5, planMax: 100, sentTodayForProfile: 0, sentTodayForUser: 0, lastInstantAt: null, now };

  it('Free plan: 1 instant alert a day across every saved search', () => {
    expect(instantAllowance({ ...base, planMax: 1 })).toEqual({ allowed: true });
    expect(instantAllowance({ ...base, planMax: 1, sentTodayForUser: 1 })).toEqual({ allowed: false, reason: 'plan_cap' });
  });

  it("the saved search's own frequency caps it too", () => {
    expect(instantAllowance({ ...base, profileMax: 2, sentTodayForProfile: 2, sentTodayForUser: 2 })).toEqual({ allowed: false, reason: 'profile_cap' });
  });

  it('keeps alerts at least 3 hours apart', () => {
    expect(instantAllowance({ ...base, lastInstantAt: new Date(now.getTime() - 2 * 3_600_000) })).toEqual({ allowed: false, reason: 'spacing' });
    expect(instantAllowance({ ...base, lastInstantAt: new Date(now.getTime() - 3 * 3_600_000) })).toEqual({ allowed: true });
  });

  it('off when the search or the plan allows none', () => {
    expect(instantAllowance({ ...base, profileMax: 0 })).toEqual({ allowed: false, reason: 'off' });
    expect(instantAllowance({ ...base, planMax: 0 })).toEqual({ allowed: false, reason: 'off' });
  });
});

describe('alert windows', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('instant alerts look back at most 24 h, or to the last alert', () => {
    expect(instantSince(null, now).toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(instantSince(new Date('2026-10-10T06:00:00Z'), now).toISOString()).toBe('2026-10-10T06:00:00.000Z');
    expect(instantSince(new Date('2026-10-01T06:00:00Z'), now).toISOString()).toBe('2026-10-09T12:00:00.000Z');
  });
  it('digests look back to the last digest; weekly never more than 7 days', () => {
    expect(digestSince('daily', null, now).toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(digestSince('weekly', null, now).toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(digestSince('weekly', new Date('2026-09-01T00:00:00Z'), now).toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(digestSince('daily', new Date('2026-10-09T08:00:00Z'), now).toISOString()).toBe('2026-10-09T08:00:00.000Z');
  });

  it('a daily digest never reaches back before yesterday (local), so "since yesterday" stays true', () => {
    // Last digest 5 days ago (empty days in between): the window starts at yesterday 00:00 local.
    expect(digestSince('daily', new Date('2026-10-05T06:00:00Z'), now).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    // 12:00 UTC = 14:00 Berlin (CEST): yesterday 00:00 Berlin = 2026-10-08T22:00Z.
    expect(digestSince('daily', new Date('2026-10-05T06:00:00Z'), now, 'Europe/Berlin').toISOString()).toBe('2026-10-08T22:00:00.000Z');
    // 12:00 UTC = 07:00 Chicago (CDT): yesterday 00:00 Chicago = 2026-10-09T05:00Z.
    expect(digestSince('daily', new Date('2026-10-01T06:00:00Z'), now, 'America/Chicago').toISOString()).toBe('2026-10-09T05:00:00.000Z');
  });
});

describe('user-local time', () => {
  it('quiet hours are 21:00–08:00 in the person’s zone', () => {
    // 02:00 UTC = 22:00 New York (EDT), 10:00 Shanghai.
    const t = new Date('2026-10-10T02:00:00Z');
    expect(inQuietHours(t, 'America/New_York')).toBe(true);
    expect(inQuietHours(t, 'Asia/Shanghai')).toBe(false);
    expect(msUntilQuietEnds(t, 'America/New_York')).toBe(10 * 3_600_000);
    expect(msUntilQuietEnds(t, 'Asia/Shanghai')).toBe(0);
  });

  it('honours a custom window and ignores a malformed one', () => {
    const t = new Date('2026-10-10T12:30:00Z'); // 12:30 UTC
    expect(inQuietHours(t, 'UTC', { start: '12:00', end: '13:00' })).toBe(true);
    expect(normalizeQuietHours({ start: '25:00', end: 'x' })).toEqual({ start: '21:00', end: '08:00' });
  });

  it('falls back per brand when the zone is missing or invalid', () => {
    expect(resolveTimeZone(null, 'goapply')).toBe('Asia/Shanghai');
    expect(resolveTimeZone('Not/AZone', 'roboapply')).toBe('UTC');
    expect(resolveTimeZone('Europe/Berlin', 'roboapply')).toBe('Europe/Berlin');
  });

  it('local day start and weekday', () => {
    const t = new Date('2026-10-12T06:30:00Z'); // Monday 08:30 Berlin (CEST)
    expect(localTime(t, 'Europe/Berlin')).toMatchObject({ weekday: 1, hour: 8, dayKey: '2026-10-12' });
    expect(startOfLocalDay(t, 'Europe/Berlin').toISOString()).toBe('2026-10-11T22:00:00.000Z');
  });

  it('daily digests go out from 08:00 local once a day; weekly on Monday', () => {
    const monday0830 = new Date('2026-10-12T06:30:00Z');
    const tuesday0830 = new Date('2026-10-13T06:30:00Z');
    const monday0700 = new Date('2026-10-12T05:00:00Z');
    expect(digestDue('daily', monday0830, 'Europe/Berlin', null)).toBe(true);
    expect(digestDue('daily', monday0700, 'Europe/Berlin', null)).toBe(false);
    expect(digestDue('daily', monday0830, 'Europe/Berlin', new Date('2026-10-12T06:00:00Z'))).toBe(false);
    expect(digestDue('daily', tuesday0830, 'Europe/Berlin', new Date('2026-10-12T06:00:00Z'))).toBe(true);
    expect(digestDue('weekly', monday0830, 'Europe/Berlin', new Date('2026-10-05T06:30:00Z'))).toBe(true);
    expect(digestDue('weekly', tuesday0830, 'Europe/Berlin', null)).toBe(false);
  });
});

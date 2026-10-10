// WP-33 — pure helpers of hooks/feed.

import { describe, expect, it } from 'vitest';

import { applyPatchPreview, isNoopPatch, opsToPatch, relaxPatch } from './filterOps';
import { flattenFeedPages } from './useFeed';
import { jobsBadgeFrom } from './useJobsBadge';
import { sameLocalDay, within } from './useCalibration';
import { feedKeys } from './keys';

describe('opsToPatch', () => {
  it('add appends without duplicates; remove drops; set replaces', () => {
    const patch = opsToPatch(
      { excludedCompanies: ['Acme'], skills: ['Go', 'Rust'], postedWithinDays: 30 },
      [
        { op: 'add', path: 'excludedCompanies', value: 'Acme' },
        { op: 'add', path: '/excludedCompanies', value: 'Initech' },
        { op: 'remove', path: 'skills', value: 'Go' },
        { op: 'set', path: 'needsSponsorship', value: true },
        { op: 'remove', path: 'postedWithinDays', value: 30 },
      ],
    );
    expect(patch).toEqual({ excludedCompanies: ['Acme', 'Initech'], skills: ['Rust'], needsSponsorship: true, postedWithinDays: null });
  });

  it('emptying a list clears the field; nested and unknown op paths are ignored', () => {
    expect(opsToPatch({ skills: ['Go'] }, [{ op: 'remove', path: 'skills', value: ['Go'] }])).toEqual({ skills: null });
    expect(opsToPatch({}, [{ op: 'set', path: 'locations/0', value: 1 }, { op: 'set', path: 'a.b', value: 1 }])).toEqual({});
    expect(opsToPatch({}, [{ op: 'move' as 'set', path: 'q', value: 'x' }])).toEqual({});
    expect(opsToPatch({}, [{ op: 'set', path: 'q', value: undefined }])).toEqual({ q: null });
    expect(opsToPatch({}, [{ op: 'add', path: 'skills', value: ['Go', 'Go'] }])).toEqual({ skills: ['Go'] });
  });

  it('preview applies a patch; relax removes one item or the field', () => {
    expect(applyPatchPreview({ q: 'x', skills: ['Go'] }, { q: null, skills: ['Go', 'Rust'] })).toEqual({ skills: ['Go', 'Rust'] });
    expect(relaxPatch({ workModels: ['remote', 'hybrid'] }, 'workModels', 'remote')).toEqual({ workModels: ['hybrid'] });
    expect(relaxPatch({ workModels: ['remote'] }, 'workModels', 'remote')).toEqual({ workModels: null });
    expect(relaxPatch({ postedWithinDays: 7 }, 'postedWithinDays', 7)).toEqual({ postedWithinDays: null });
    expect(relaxPatch({ skills: ['Go'] }, 'skills', null)).toEqual({ skills: null });
  });
});

describe('flattenFeedPages', () => {
  it('keeps page order and the first copy of a job', () => {
    const a = { jobId: 'a' } as never;
    const b = { jobId: 'b' } as never;
    const c = { jobId: 'c' } as never;
    const pages = [
      { items: [a, b], cursor: 's:20', endOfFeed: false, hiddenByTier: 0, sessionId: 's' },
      { items: [b, c], cursor: null, endOfFeed: true, hiddenByTier: 0, sessionId: 's' },
    ];
    expect(flattenFeedPages(pages).map((i) => i.jobId)).toEqual(['a', 'b', 'c']);
    expect(flattenFeedPages(undefined)).toEqual([]);
  });
});

describe('jobs badge', () => {
  it('only a positive real count makes a badge', () => {
    expect(jobsBadgeFrom(4)).toEqual({ kind: 'count', count: 4 });
    expect(jobsBadgeFrom(4.7)).toEqual({ kind: 'count', count: 4 });
    for (const v of [0, -1, NaN, Infinity, null, undefined, '3']) expect(jobsBadgeFrom(v)).toBeNull();
  });
});

describe('calibration timing', () => {
  it('same local day and within N days', () => {
    const now = new Date(2026, 9, 10, 15, 0, 0);
    expect(sameLocalDay(new Date(2026, 9, 10, 1, 0, 0).toISOString(), now)).toBe(true);
    expect(sameLocalDay(new Date(2026, 9, 9, 23, 0, 0).toISOString(), now)).toBe(false);
    expect(sameLocalDay(null, now)).toBe(false);
    expect(sameLocalDay('nope', now)).toBe(false);
    expect(within(new Date(now.getTime() - 3 * 864e5).toISOString(), 7, now.getTime())).toBe(true);
    expect(within(new Date(now.getTime() - 8 * 864e5).toISOString(), 7, now.getTime())).toBe(false);
    expect(within(undefined, 7, now.getTime())).toBe(false);
  });
});

describe('keys', () => {
  it('the list is not under the feed root (job actions must not restart the session)', () => {
    const key = feedKeys.list({ searchProfileId: 'sp', version: 2, sort: 'recommended', fitTier: 'all' });
    expect(key[0]).toBe('feed-list');
    expect(feedKeys.newCount()[0]).toBe('feed');
  });
});

describe('isNoopPatch', () => {
  it('an empty patch (every op dropped) changes nothing', () => {
    expect(isNoopPatch({ skills: ['Go'] }, opsToPatch({ skills: ['Go'] }, [{ op: 'set', path: 'geo/radius', value: 5 }]))).toBe(true);
  });
  it('values already set change nothing; a real edit does', () => {
    expect(isNoopPatch({ skills: ['Go'] }, { skills: ['Go'] })).toBe(true);
    expect(isNoopPatch({}, { skills: null })).toBe(true);
    expect(isNoopPatch({ skills: ['Go'] }, { skills: ['Go', 'SQL'] })).toBe(false);
    expect(isNoopPatch({ skills: ['Go'] }, { skills: null })).toBe(false);
  });
});

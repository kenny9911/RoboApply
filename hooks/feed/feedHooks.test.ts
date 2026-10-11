// WP-33 — pure helpers of hooks/feed.
// MKT-4F (SM-9): the two lines of a plain-language proposal, the words a list
// is ranked by (who they belong to, how long they last) and the relevance text
// as it is sent and keyed.

import { afterEach, describe, expect, it } from 'vitest';

import { applyPatchPreview, isNoopPatch, opsToPatch, relaxPatch } from './filterOps';
import { __listRelevanceStore, clearListRelevance, nlLines, rankListBy, relevanceFor, sortUsesRelevance, type ListRelevance } from './useExplore';
import { FEED_RELEVANCE_MAX, feedRelevance, flattenFeedPages } from './useFeed';
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

  it('the words a list is ranked by are part of its key: ranking by them, or clearing them, is another list', () => {
    const base = { searchProfileId: 'sp', version: 2, sort: 'recommended' as const, fitTier: 'all' as const };
    const plain = feedKeys.list(base);
    expect(feedKeys.list({ ...base, relevance: '' })).toEqual(plain);
    expect(feedKeys.list({ ...base, relevance: null })).toEqual(plain);
    expect(feedKeys.list({ ...base, relevance: 'climate startups Rust' })).not.toEqual(plain);
    expect(feedKeys.list({ ...base, relevance: 'climate startups Rust' }).at(-1)).toBe('climate startups Rust');
  });
});

describe('the relevance text as it is sent', () => {
  it('trimmed; empty, missing or longer than the server accepts is no text at all', () => {
    expect(FEED_RELEVANCE_MAX).toBe(240);
    expect(feedRelevance('  climate startups Rust ')).toBe('climate startups Rust');
    for (const v of ['', '   ', null, undefined]) expect(feedRelevance(v)).toBe('');
    expect(feedRelevance('x'.repeat(240))).toHaveLength(240);
    expect(feedRelevance('x'.repeat(241))).toBe('');
  });
});

describe('the two lines of a plain-language proposal', () => {
  it('ranking terms as they came; "not checked" is what stayed unmatched and is no ranking term', () => {
    expect(nlLines({ rankedBy: ['climate startups', 'Rust'], unmatched: ['climate startups', 'using Rust', 'salary above 150k'] })).toEqual({
      rankedBy: ['climate startups', 'Rust'],
      notChecked: ['salary above 150k'],
    });
    // Nothing to rank by: every left-over phrase is simply not checked.
    expect(nlLines({ rankedBy: [], unmatched: ['a 4-day week'] })).toEqual({ rankedBy: [], notChecked: ['a 4-day week'] });
    // Case, width and spacing do not make a phrase new.
    expect(nlLines({ rankedBy: ['Ｒust'], unmatched: ['using  RUST'] }).notChecked).toEqual([]);
  });

  it('a response without the lists, or with junk in them, gives two empty lines', () => {
    expect(nlLines({})).toEqual({ rankedBy: [], notChecked: [] });
    expect(nlLines({ rankedBy: null, unmatched: undefined })).toEqual({ rankedBy: [], notChecked: [] });
    expect(nlLines({ rankedBy: ['  Rust ', '', 7 as never], unmatched: ['  ', 'visa'] })).toEqual({ rankedBy: ['Rust'], notChecked: ['visa'] });
  });
});

describe('the words a list is ranked by', () => {
  afterEach(() => __listRelevanceStore.reset());
  const stored = (over: Partial<ListRelevance> = {}): ListRelevance => ({ searchProfileId: 'sp', terms: ['Rust'], text: 'Rust', baseVersion: 3, version: null, ...over });

  it('rankListBy stores the terms joined by a space; no terms, or terms too long to send, store nothing', () => {
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['climate startups', ' Rust '] });
    expect(__listRelevanceStore.get()).toEqual({ searchProfileId: 'sp', terms: ['climate startups', 'Rust'], text: 'climate startups Rust', baseVersion: 3, version: null });
    rankListBy({ searchProfileId: 'sp', baseVersion: 4, rankedBy: [] });
    expect(__listRelevanceStore.get()).toBeNull();
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['Rust'] });
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['x'.repeat(241)] });
    expect(__listRelevanceStore.get()).toBeNull();
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: undefined });
    expect(__listRelevanceStore.get()).toBeNull();
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['Rust'] });
    clearListRelevance();
    expect(__listRelevanceStore.get()).toBeNull();
  });

  it('terms chosen without a saved change belong to the version they were chosen against, from the start', () => {
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['Rust'], saved: false });
    expect(__listRelevanceStore.get()).toEqual({ searchProfileId: 'sp', terms: ['Rust'], text: 'Rust', baseVersion: 3, version: 3 });
    // That version only: the next change of the search ends them (they do not survive one, as a saved proposal's do).
    expect(relevanceFor(__listRelevanceStore.get(), { id: 'sp', version: 3 })).not.toBeNull();
    expect(relevanceFor(__listRelevanceStore.get(), { id: 'sp', version: 4 })).toBeNull();
    // `saved: true` is the default.
    rankListBy({ searchProfileId: 'sp', baseVersion: 3, rankedBy: ['Rust'], saved: true });
    expect(__listRelevanceStore.get()?.version).toBeNull();
  });

  it('the words take part in Recommended and Best fit only', () => {
    expect(['recommended', 'best_fit', 'newest', 'highest_pay', 'deadline', null, undefined, ''].map((s) => sortUsesRelevance(s))).toEqual([true, true, false, false, false, false, false, false]);
  });

  it('belong to one saved search, from the version the proposal was made against until the applied change is replaced', () => {
    // Before /jobs has seen the applied change: the version the proposal was made against, or any later one.
    expect(relevanceFor(stored(), { id: 'sp', version: 3 })).not.toBeNull();
    expect(relevanceFor(stored(), { id: 'sp', version: 4 })).not.toBeNull();
    expect(relevanceFor(stored(), { id: 'sp', version: 2 })).toBeNull();
    // Once the applied change (version 4) is known: that version only.
    expect(relevanceFor(stored({ version: 4 }), { id: 'sp', version: 4 })).not.toBeNull();
    expect(relevanceFor(stored({ version: 4 }), { id: 'sp', version: 5 })).toBeNull();
    expect(relevanceFor(stored({ version: 4 }), { id: 'sp', version: 3 })).toBeNull();
    // Another search, no search, or nothing stored.
    expect(relevanceFor(stored(), { id: 'other', version: 3 })).toBeNull();
    expect(relevanceFor(stored(), null)).toBeNull();
    expect(relevanceFor(null, { id: 'sp', version: 3 })).toBeNull();
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

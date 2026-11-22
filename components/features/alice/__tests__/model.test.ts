// Pure helpers of Alice's screens: which rows of two profiles differ, the
// version before a version, topic progress, a day without a time-zone shift,
// and the region a stage opens on.

import { describe, expect, it } from 'vitest';

import type { AliceJobProfile, AliceRevision } from '../../../../lib/api/contracts/alice';
import { canvasFor, columnKey, currentRevision, differingFields, formatDay, previousRevision, topicProgress } from '../model';
import { errorKey } from '../Conversation';

const base: AliceJobProfile = {
  id: 'a',
  label: 'Steady',
  headline: 'Senior designer',
  summary: '',
  titles: ['Senior Product Designer'],
  searchTitles: [],
  levels: ['senior'],
  workModels: ['remote'],
  places: [],
  pay: null,
  industries: [],
  companyKinds: [],
  companySizes: [],
  companies: [],
  skills: [],
  mustHaves: [],
  niceToHaves: [],
  dealbreakers: [],
  whyItFits: [],
  tradeoff: '',
  jobTypes: [],
};

const rev = (version: number, over: Partial<AliceRevision> = {}): AliceRevision => ({ version, profile: base, comment: null, notes: [], changed: [], origin: 'pick', at: '', ...over });

describe('Alice model', () => {
  it('marks the rows where two profiles differ (and only shown rows)', () => {
    const b = { ...base, id: 'b', levels: ['lead_staff' as const], label: 'Step up', searchTitles: ['x'] };
    expect([...differingFields(base, b)]).toEqual(['levels']);
  });

  it('finds the current version and the one before it', () => {
    const thread = { revisions: [rev(1), rev(2), rev(3)], currentVersion: 2 };
    expect(currentRevision(thread)?.version).toBe(2);
    expect(previousRevision(thread, rev(2))?.version).toBe(1);
    expect(previousRevision(thread, rev(1))).toBeNull();
    expect(currentRevision({ revisions: [rev(1)], currentVersion: 0 })?.version).toBe(1);
  });

  it('counts covered and declined topics once', () => {
    expect(topicProgress({ topics: { all: ['roles', 'level', 'pay'], required: [], covered: ['roles'], declined: ['pay', 'roles'] } })).toEqual({ done: 2, total: 3 });
  });

  it('formats a day as written, in any time zone', () => {
    expect(formatDay('2026-11-27', 'en')).toMatch(/Nov(ember)? 27/);
    expect(formatDay('not-a-day', 'en')).toBe('not-a-day');
  });

  it('opens the canvas on the profiles while shaping, on the jobs once saved', () => {
    expect(canvasFor('intake')).toBe('profile');
    expect(canvasFor('choosing')).toBe('profile');
    expect(canvasFor('refining')).toBe('profile');
    expect(canvasFor('saved')).toBe('jobs');
    expect(columnKey('bookmarked')).toBe('saved');
    expect(columnKey('first_call')).toBe('first_call');
  });

  it('words each failure from its reason first', () => {
    expect(errorKey({ code: 'ai_unavailable', reason: 'alice_not_ready', message: '' })).toBe('not_ready');
    expect(errorKey({ code: 'conflict', reason: 'alice_busy', message: '' })).toBe('busy');
    expect(errorKey({ code: 'rate_limited', reason: null, message: '' })).toBe('rate_limited');
    expect(errorKey({ code: 'stream_interrupted', reason: null, message: '' })).toBe('interrupted');
    expect(errorKey({ code: 'unknown', reason: null, message: '' })).toBe('generic');
  });
});

// WP-53: pure logic of the Ready to apply hooks — state → tab, real counts,
// the nav badge, the optional fields requested from WP-52, proposal sums,
// polling, and the runtime option lists' parity with the server contract.

import { describe, expect, it } from 'vitest';

import * as contract from '../../server/src/features/agent/contract';
import type { QueueItemView, QueueState } from '../../lib/api/contracts/agent';
import {
  canPrepare,
  countKits,
  failedReasonOf,
  isReadyNotOpened,
  jobSummaryOf,
  kitEventsOf,
  lastErrorOf,
  proCapOf,
  progressScope,
  recordedFileNameOf,
  tabForState,
  tabOf,
  tailorSessionIdOf,
  type ReadyQueueItem,
} from './adapters';
import { PREPARING_POLL_MS, isUnavailable, queueRefetchInterval, shouldRetryAgent, sumProposals } from './useAgent';
import { readyBadgeFrom } from './useReadyBadge';
import { COVER_LETTER_MODES, FILE_NAME_STYLES, MIN_TIERS, SETUP_STEPS, WEEKLY_TARGETS } from '../../components/features/agent/options';
import { RoboApiError } from '../../lib/api/client';

function item(over: Partial<ReadyQueueItem> = {}): ReadyQueueItem {
  return {
    id: 'q1',
    jobId: 'job1',
    state: 'picked',
    weekKey: '2026-W41',
    trackerEntryId: null,
    resumeVariantId: null,
    coverLetterId: null,
    missingFields: [],
    addedVia: 'weekly',
    openedAt: null,
    userMarkedSubmitted: false,
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...over,
  };
}

const err = (code: string) => new RoboApiError(code, { code, status: 400, payload: { code } });

describe('states', () => {
  it('maps every contract state to one tab like the contract TAB_STATES, with no "submitted" state anywhere (D1)', () => {
    expect(contract.QUEUE_STATES).not.toContain('submitted' as QueueState);
    const tabs = Object.fromEntries(contract.QUEUE_STATES.map((s) => [s, tabForState(s)]));
    expect(tabs).toEqual({
      picked: 'prepare',
      failed: 'prepare',
      preparing: 'ready',
      ready_for_review: 'ready',
      approved: 'ready',
      opened: 'done',
      applied: 'done',
      skipped: 'done',
      expired: 'done',
    });
    // The server's own `tab` wins when it sends one.
    expect(tabOf(item({ state: 'picked', tab: 'done' }))).toBe('done');
    expect(tabOf(item({ state: 'picked', tab: 'to_prepare' }))).toBe('prepare');
  });

  it('prepares only from states the contract lets move to preparing', () => {
    const preparable = contract.QUEUE_STATES.filter(canPrepare);
    expect(preparable).toEqual(['picked', 'failed']);
    for (const s of preparable) expect(contract.QUEUE_TRANSITIONS[s]).toContain('preparing');
  });

  it('counts real items per group', () => {
    const items: QueueItemView[] = (['picked', 'preparing', 'expired', 'ready_for_review', 'approved', 'applied', 'skipped'] as const).map((state, i) => item({ id: `q${i}`, state }));
    expect(countKits(items)).toEqual({ prepare: 1, ready: 3, done: 3, toPrepare: 1, preparing: 1, readyNotOpened: 2, applied: 1, expired: 1 });
    expect(isReadyNotOpened('opened')).toBe(false);
  });

  it('counts the progress strip over this week only when the server names the week', () => {
    const items = [item({ id: 'a', weekKey: '2026-W41', state: 'applied' }), item({ id: 'b', weekKey: '2026-W38', state: 'applied' }), item({ id: 'c', weekKey: '2026-W41', state: 'picked' })];
    const week = progressScope(items, '2026-W41');
    expect(week.scope).toBe('week');
    expect(week.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(countKits(week.items)).toMatchObject({ applied: 1, toPrepare: 1 });
    const all = progressScope(items, undefined);
    expect(all.scope).toBe('all');
    expect(all.items).toHaveLength(3);
  });
});

describe('readyBadgeFrom', () => {
  it('shows the server count of kits ready and not opened; null for unknown, malformed or zero', () => {
    expect(readyBadgeFrom(undefined)).toBeNull();
    expect(readyBadgeFrom({ readyNotOpened: 0 })).toBeNull();
    expect(readyBadgeFrom({ readyNotOpened: Number.NaN })).toBeNull();
    expect(readyBadgeFrom({} as never)).toBeNull();
    expect(readyBadgeFrom({ readyNotOpened: 2 })).toEqual({ kind: 'count', count: 2 });
  });
});

describe('contract shapes read through guards (WP-93: no mirror types)', () => {
  it('a history row without a kind is read by the server\'s rule, never as a transition by default', () => {
    const events = kitEventsOf([
      { id: 'a', kind: 'notice', fromState: 'approved', toState: 'approved', actor: 'system', detail: null, createdAt: '2026-10-08T01:00:00.000Z' },
      { id: 'b', fromState: 'approved', toState: 'approved', actor: 'user', detail: { part: 'resume', decision: 'use' }, createdAt: '2026-10-08T02:00:00.000Z' },
      { id: 'c', fromState: 'approved', toState: 'approved', actor: 'system', detail: { notice: 'kit_not_opened' }, createdAt: '2026-10-08T03:00:00.000Z' },
      { id: 'd', fromState: 'approved', toState: 'opened', actor: 'user', detail: null, createdAt: '2026-10-08T04:00:00.000Z' },
      { id: 'e', kind: 'whatever', fromState: null, toState: 'picked', actor: 'system', detail: null, createdAt: '2026-10-08T05:00:00.000Z' },
    ])!;
    expect(Object.fromEntries(events.map((e) => [e.id, e.kind]))).toEqual({ a: 'notice', b: 'decision', c: 'notice', d: 'transition', e: 'transition' });
  });

  it('the list row\'s fit is read only when it is complete', () => {
    const job = { title: 'Analyst', companyName: 'Acme', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false };
    expect(jobSummaryOf(item({ job: { ...job, fit: { tier: 'great', score: 88 } } }))?.fit).toEqual({ tier: 'great', score: 88 });
    expect(jobSummaryOf(item({ job }))).not.toHaveProperty('fit');
    expect(jobSummaryOf(item({ job: { ...job, fit: null } }))).not.toHaveProperty('fit');
    expect(jobSummaryOf(item({ job: { ...job, fit: { tier: 'amazing', score: 99 } } as never }))).not.toHaveProperty('fit');
    expect(jobSummaryOf(item({ job: { ...job, fit: { tier: 'good', score: Number.NaN } } }))).not.toHaveProperty('fit');
  });

  it('proCapOf reads the Pro weekly cap from the credits summary, and nothing when it is absent', () => {
    const bucket = { cap: 3, used: 2, remaining: 1, grantRemaining: 0, window: 'week', resetsAt: '2026-10-12T00:00:00.000Z' };
    expect(proCapOf({ ...bucket, proCap: 30 } as never)).toBe(30);
    expect(proCapOf(bucket as never)).toBeNull();
    expect(proCapOf({ ...bucket, proCap: 0 } as never)).toBeNull();
    expect(proCapOf({ ...bucket, proCap: '30' } as never)).toBeNull();
    expect(proCapOf(null)).toBeNull();
  });
});

describe('optional fields requested from WP-52', () => {
  it('reads nothing when the server sends nothing', () => {
    const it0 = item();
    expect(tailorSessionIdOf(it0)).toBeNull();
    expect(jobSummaryOf(it0)).toBeNull();
    expect(kitEventsOf(undefined)).toBeUndefined();
    expect(recordedFileNameOf(undefined)).toBeNull();
    expect(lastErrorOf(it0)).toBeNull();
  });

  it('reads history newest first, drops malformed rows, and finds the recorded file name', () => {
    const it1 = item({ tailorSessionId: 'ts1', lastError: 'prepare_timeout' });
    const events = kitEventsOf([
      { id: 'e1', fromState: null, toState: 'picked', actor: 'system', detail: null, createdAt: '2026-10-06T06:00:00.000Z' },
      { id: 'e2', fromState: 'approved', toState: 'opened', actor: 'user', detail: { fileName: 'Jane Doe - Acme - Analyst.pdf' }, createdAt: '2026-10-08T06:00:00.000Z' },
      { id: 'bad', toState: 'submitted', createdAt: 'x' },
    ]);
    expect(tailorSessionIdOf(it1)).toBe('ts1');
    expect(lastErrorOf(it1)).toBe('prepare_timeout');
    expect(events?.map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(recordedFileNameOf(events)).toBe('Jane Doe - Acme - Analyst.pdf');
  });

  it('reads the job summary only when it has a title', () => {
    expect(jobSummaryOf(item({ job: { title: 'Data Analyst', companyName: 'Acme', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false } }))).toMatchObject({ title: 'Data Analyst', companyName: 'Acme' });
    expect(jobSummaryOf(item({ job: { title: ' ' } as never }))).toBeNull();
    expect(jobSummaryOf(item({ job: null }))).toBeNull();
  });

  it('maps every lastError code WP-52 writes to a plain reason, never the raw code', () => {
    expect(failedReasonOf('no_resume')).toBe('noResume');
    expect(failedReasonOf('ai_unavailable')).toBe('aiUnavailable');
    expect(failedReasonOf('ai_unavailable:ai_failed')).toBe('aiUnavailable');
    expect(failedReasonOf('credits_exhausted:tailor')).toBe('credits');
    // WP-52 KIT_ERROR_CODES (not in this tag's contract yet).
    expect(failedReasonOf('job_closed')).toBe('jobClosed');
    for (const c of ['enqueue_failed', 'internal', 'prepare_timeout']) expect(failedReasonOf(c)).toBe('ourSide');
    expect(failedReasonOf('conflict:something_new')).toBeNull();
    expect(failedReasonOf(null)).toBeNull();
  });
});

describe('preparing', () => {
  it('sums only the server proposals (skipping unreadable ones)', () => {
    expect(
      sumProposals([
        { credits: [{ bucket: 'tailor', cost: 1 }, { bucket: 'cover_letter', cost: 1 }], confirmed: false },
        null,
        { credits: [{ bucket: 'tailor', cost: 1 }], confirmed: false },
      ]),
    ).toEqual({ tailor: 2, cover_letter: 1 });
  });

  it('polls only while a kit is being prepared', () => {
    expect(queueRefetchInterval([item({ state: 'picked' })])).toBe(false);
    expect(queueRefetchInterval([item({ state: 'preparing' })])).toBe(PREPARING_POLL_MS);
    expect(queueRefetchInterval(undefined)).toBe(false);
  });

  it('does not retry final errors; flags the area as unavailable when off or not built', () => {
    expect(shouldRetryAgent(0, err('feature_disabled'))).toBe(false);
    expect(shouldRetryAgent(0, err('server_error'))).toBe(true);
    expect(shouldRetryAgent(1, err('server_error'))).toBe(false);
    expect(isUnavailable(err('not_implemented'))).toBe(true);
    expect(isUnavailable(err('feature_disabled'))).toBe(true);
    expect(isUnavailable(err('server_error'))).toBe(false);
  });
});

describe('option lists', () => {
  it('equal the server contract', () => {
    expect([...WEEKLY_TARGETS]).toEqual([...contract.WEEKLY_TARGETS]);
    expect([...MIN_TIERS]).toEqual([...contract.MIN_TIERS]);
    expect([...COVER_LETTER_MODES]).toEqual([...contract.COVER_LETTER_MODES]);
    expect([...FILE_NAME_STYLES]).toEqual([...contract.FILE_NAME_STYLES]);
    expect([...SETUP_STEPS]).toEqual([...contract.SETUP_STEPS]);
  });
});

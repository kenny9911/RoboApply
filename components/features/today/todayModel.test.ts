// todayModel — what /today works out from its reads (REDESIGN §5): the order
// and cap of "Waiting for you", the title, the lane counts and the goal line.
// Pure functions; no network, no rendering.

import { describe, expect, it, vi } from 'vitest';

import { NOW, board, daysAgo, entry, failed, kit, loading, off, ready, resume, sourcesWith } from './today.testkit';
import { WAITING_LIMIT, applicationNumbers, goalFacts, goalIsEmpty, sentThisWeek, titleOf, waitingOf, weekOfNow } from './todayModel';

const at = NOW.getTime();

describe('waitingOf: what waits, most urgent first', () => {
  it('orders every kind: check, open, verify, no reply, profile, no resume, setup', () => {
    const waiting = waitingOf(
      sourcesWith({
        queue: ready([kit({ id: 'q_open', jobId: 'job_open', state: 'approved' }), kit({ id: 'q_review', jobId: 'job_review', state: 'ready_for_review' })]),
        resumes: ready([resume({ id: 'rv_t', kind: 'tailored_for_jd', isPrimary: false, name: 'For Initech', unverifiedClaims: 2, tailorSessionId: 'ts9' })]),
        board: ready(board([entry({ id: 'e1', status: 'applied', dateApplied: daysAgo(12) })])),
        profileMissing: ready(3),
        setupStepsLeft: ready(2),
      }),
      at,
    );
    expect(waiting.status).toBe('ready');
    expect(waiting.items.map((i) => i.kind)).toEqual(['review', 'open', 'verify', 'no_reply', 'profile', 'no_resume', 'setup']);
    expect(waiting.items[2]).toMatchObject({ kind: 'verify', resumeId: 'rv_t', sessionId: 'ts9', count: 2, name: 'For Initech' });
    expect(waiting.items[3]).toMatchObject({ kind: 'no_reply', count: 1 });
    expect(waiting.items[4]).toMatchObject({ kind: 'profile', count: 3 });
    expect(waiting.items[6]).toMatchObject({ kind: 'setup', count: 2 });
  });

  it('shows at most four cards and counts the rest', () => {
    const kits = Array.from({ length: 6 }, (_, i) => kit({ id: `q${i}`, jobId: `job${i}`, updatedAt: daysAgo(10 - i) }));
    const waiting = waitingOf(sourcesWith({ queue: ready(kits), profileMissing: ready(1) }), at);
    expect(WAITING_LIMIT).toBe(4);
    expect(waiting.items).toHaveLength(7);
    expect(waiting.shown).toHaveLength(4);
    expect(waiting.more).toBe(3);
    // The application that has waited longest comes first.
    expect(waiting.shown.map((i) => (i.kind === 'review' ? i.jobId : i.kind))).toEqual(['job0', 'job1', 'job2', 'job3']);
    expect(titleOf(waiting)).toEqual({ kind: 'count', count: 7 });
  });

  it('lists an application to check before one to open, whatever their dates', () => {
    const waiting = waitingOf(
      sourcesWith({
        queue: ready([kit({ id: 'a', jobId: 'old_approved', state: 'approved', updatedAt: daysAgo(9) }), kit({ id: 'b', jobId: 'new_review', state: 'ready_for_review', updatedAt: daysAgo(0) })]),
      }),
      at,
    );
    expect(waiting.items.map((i) => ('jobId' in i ? i.jobId : i.kind))).toEqual(['new_review', 'old_approved']);
  });

  it('counts only applications that are ready: none that is picked, being prepared, opened, skipped or failed', () => {
    const states = ['picked', 'preparing', 'opened', 'applied', 'skipped', 'expired', 'failed'] as const;
    const waiting = waitingOf(sourcesWith({ queue: ready(states.map((state, i) => kit({ id: `q${i}`, jobId: `job${i}`, state }))) }), at);
    expect(waiting.items).toEqual([]);
    expect(titleOf(waiting)).toEqual({ kind: 'none' });
  });

  it('a tailored resume that belongs to an application on the list is one card, not two', () => {
    const waiting = waitingOf(
      sourcesWith({
        queue: ready([kit({ id: 'q1', jobId: 'job1', resumeVariantId: 'rv_kit', tailorSessionId: 'ts_kit' })]),
        resumes: ready([
          resume(),
          resume({ id: 'rv_kit', kind: 'tailored_for_jd', isPrimary: false, unverifiedClaims: 3, tailorSessionId: 'ts_kit' }),
          resume({ id: 'rv_same_session', kind: 'tailored_for_jd', isPrimary: false, unverifiedClaims: 1, tailorSessionId: 'ts_kit' }),
          resume({ id: 'rv_own', kind: 'tailored_for_jd', isPrimary: false, name: 'For Hooli', unverifiedClaims: 1, tailorSessionId: 'ts_own' }),
        ]),
      }),
      at,
    );
    expect(waiting.items.map((i) => i.key)).toEqual(['review:q1', 'verify:rv_own']);
  });

  it('a base resume with nothing to verify adds no card; a version with no claims left adds none either', () => {
    const waiting = waitingOf(sourcesWith({ resumes: ready([resume(), resume({ id: 'rv_done', kind: 'tailored_for_jd', isPrimary: false, unverifiedClaims: 0 })]) }), at);
    expect(waiting.items).toEqual([]);
  });

  it('"no resume" means no base resume: a tailored version alone does not count as one', () => {
    const none = waitingOf(sourcesWith({ resumes: ready([]) }), at);
    expect(none.items.map((i) => i.kind)).toEqual(['no_resume']);
    const tailoredOnly = waitingOf(sourcesWith({ resumes: ready([resume({ id: 'rv_t', kind: 'tailored_for_jd', isPrimary: false })]) }), at);
    expect(tailoredOnly.items.map((i) => i.kind)).toEqual(['no_resume']);
    const fromTemplate = waitingOf(sourcesWith({ resumes: ready([resume({ kind: 'from_template' })]) }), at);
    expect(fromTemplate.items).toEqual([]);
  });

  it('no reply follows the 10-day rule of the Applications badge, follow-up dates included', () => {
    const waiting = waitingOf(
      sourcesWith({
        board: ready(
          board([
            entry({ id: 'old', status: 'applied', dateApplied: daysAgo(11) }),
            entry({ id: 'recent', status: 'applied', dateApplied: daysAgo(9) }),
            entry({ id: 'snoozed', status: 'applied', dateApplied: daysAgo(30), followUpAt: new Date(at + 86_400_000).toISOString() }),
            entry({ id: 'moved_on', status: 'interviewing', dateApplied: daysAgo(30) }),
            entry({ id: 'saved', status: 'bookmarked', dateApplied: null }),
          ]),
        ),
      }),
      at,
    );
    expect(waiting.items).toEqual([{ kind: 'no_reply', key: 'no_reply', count: 1 }]);
  });

  it('with Ready to apply off there are no application cards and nothing waits for them', () => {
    const waiting = waitingOf(sourcesWith({ queue: off, profileMissing: ready(2) }), at);
    expect(waiting.status).toBe('ready');
    expect(waiting.items.map((i) => i.kind)).toEqual(['profile']);
  });

  it('lists nothing while any read is still loading: a late card must not take the first place', () => {
    const waiting = waitingOf(sourcesWith({ queue: ready([kit()]), board: loading }), at);
    expect(waiting).toMatchObject({ status: 'loading', items: [], shown: [], more: 0 });
    expect(titleOf(waiting)).toEqual({ kind: 'loading' });
  });

  it('a read that failed adds nothing, marks the list partial and can be asked again', () => {
    const retryBoard = vi.fn();
    const retryProfile = vi.fn();
    const waiting = waitingOf(sourcesWith({ queue: ready([kit()]), board: failed(retryBoard), profileMissing: failed(retryProfile) }), at);
    expect(waiting.status).toBe('ready');
    expect(waiting.partial).toBe(true);
    expect(waiting.items.map((i) => i.kind)).toEqual(['review']);
    waiting.retry();
    expect(retryBoard).toHaveBeenCalledTimes(1);
    expect(retryProfile).toHaveBeenCalledTimes(1);
  });

  it('never says "nothing" when a read failed and nothing else is listed', () => {
    const waiting = waitingOf(sourcesWith({ resumes: failed() }), at);
    expect(waiting.items).toEqual([]);
    expect(titleOf(waiting)).toEqual({ kind: 'partial' });
  });

  it('a list item names its job only from what the server sent', () => {
    const waiting = waitingOf(
      sourcesWith({
        queue: ready([
          kit({ id: 'full', jobId: 'j1' }),
          kit({ id: 'no_company', jobId: 'j2', job: { title: 'Analyst', companyName: '  ', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false } }),
          kit({ id: 'no_job', jobId: 'j3', job: null }),
        ]),
      }),
      at,
    );
    expect(waiting.items).toEqual([
      { kind: 'review', key: 'review:full', jobId: 'j1', title: 'Data Analyst', company: 'Acme' },
      { kind: 'review', key: 'review:no_company', jobId: 'j2', title: 'Analyst', company: null },
      { kind: 'review', key: 'review:no_job', jobId: 'j3', title: null, company: null },
    ]);
  });
});

describe('applicationNumbers: real counts, null until loaded', () => {
  it('counts being prepared, waiting and sent this week from the list and the tracker', () => {
    const numbers = applicationNumbers(
      {
        queue: ready([
          kit({ id: 'a', state: 'preparing' }),
          kit({ id: 'b', state: 'preparing' }),
          kit({ id: 'c', state: 'ready_for_review' }),
          kit({ id: 'd', state: 'approved' }),
          kit({ id: 'e', state: 'approved' }),
          kit({ id: 'f', state: 'opened' }),
          kit({ id: 'g', state: 'picked' }),
        ]),
        board: ready(board([entry({ id: 'x', dateApplied: daysAgo(0) }), entry({ id: 'y', status: 'bookmarked', dateApplied: null })])),
      },
      NOW,
    );
    expect(numbers).toEqual({ preparing: 2, waiting: 3, sentThisWeek: 1, saved: 1 });
  });

  it('a read that is loading, failed or off gives null (shown as "—"), never 0', () => {
    expect(applicationNumbers({ queue: loading, board: loading }, NOW)).toEqual({ preparing: null, waiting: null, sentThisWeek: null, saved: null });
    expect(applicationNumbers({ queue: failed(), board: failed() }, NOW)).toEqual({ preparing: null, waiting: null, sentThisWeek: null, saved: null });
    expect(applicationNumbers({ queue: off, board: ready(board()) }, NOW)).toEqual({ preparing: null, waiting: null, sentThisWeek: 0, saved: 0 });
  });

  it('zero is zero once the read has answered', () => {
    expect(applicationNumbers({ queue: ready([]), board: ready(board()) }, NOW)).toEqual({ preparing: 0, waiting: 0, sentThisWeek: 0, saved: 0 });
  });
});

describe('sentThisWeek: the tracker’s own weeks', () => {
  it('counts applications marked applied since the week began, and no saved job', () => {
    // NOW is a Wednesday: the week began on Sunday 8 November.
    expect(weekOfNow(NOW)).toBe('2026-11-08');
    const entries = [
      entry({ id: 'sun', dateApplied: new Date(2026, 10, 8, 9, 0).toISOString() }),
      entry({ id: 'today', dateApplied: new Date(2026, 10, 11, 8, 0).toISOString() }),
      entry({ id: 'last_sat', dateApplied: new Date(2026, 10, 7, 23, 0).toISOString() }),
      entry({ id: 'picked_day', dateApplied: '2026-11-09T00:00:00.000Z' }),
      entry({ id: 'undone', status: 'bookmarked', dateApplied: new Date(2026, 10, 10, 9, 0).toISOString() }),
      entry({ id: 'never', status: 'bookmarked', dateApplied: null }),
      entry({ id: 'interview', status: 'interviewing', dateApplied: new Date(2026, 10, 9, 9, 0).toISOString() }),
    ];
    expect(sentThisWeek(entries, NOW)).toBe(4);
  });
});

describe('goalFacts: only what the saved search holds', () => {
  it('reads titles, level, work models and places', () => {
    const facts = goalFacts({
      titles: ['Product designer', ' UX designer '],
      seniority: ['senior'],
      workModels: ['remote', 'hybrid'],
      locations: [{ label: 'London', radiusKm: 40 }],
      taxonomyIds: ['design_product'],
      q: 'figma',
    });
    expect(facts).toEqual({ roles: ['Product designer', 'UX designer'], roleIds: [], seniority: ['senior'], workModels: ['remote', 'hybrid'], places: ['London'] });
    expect(goalIsEmpty(facts)).toBe(false);
  });

  it('falls back to the search words, then to the job functions, when there is no title', () => {
    expect(goalFacts({ q: ' data ', taxonomyIds: ['data_analyst'] })).toMatchObject({ roles: ['data'], roleIds: [] });
    expect(goalFacts({ taxonomyIds: ['data_analyst'] })).toMatchObject({ roles: [], roleIds: ['data_analyst'] });
  });

  it('an empty search states nothing', () => {
    for (const filters of [{}, null, undefined, { fitTier: 'good' as const, postedWithinDays: 7 as const }]) {
      expect(goalIsEmpty(goalFacts(filters))).toBe(true);
    }
  });
});

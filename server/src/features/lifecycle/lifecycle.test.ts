// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { createBudget } from '../../platform/queue/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import type { NotifyMessage } from '../alerts/deliver.js';
import type { PreferenceFacts } from '../alerts/preferences.js';
import type { Recipient } from '../alerts/repo.js';
import { createPrismaLifecycleRepo, resumeCheckViewSignalSince, type LifecyclePerson, type LifecycleRepo, type PrismaLifecycleRepoOptions } from './repo.js';
import { LIFECYCLE_STEPS, TIPS_STEPS, dayBudgetUsed, eligibleSteps, stepForTemplate, type SentRecord } from './rules.js';
import { FEED_LIMITS } from '../feed/contract.js';
import { CANDIDATE_PAGE, RE_ENGAGEMENT_COUNT_LIMIT, canSendWith, countNewJobsWith, createLifecycleTask, runForPerson, type LifecycleDeps } from './service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-10T15:00:00Z'); // 11:00 New York, 17:00 Berlin, 23:00 Shanghai

const person = (over: Partial<LifecyclePerson> = {}): LifecyclePerson => ({
  userId: 'u1',
  brand: 'roboapply',
  cnIdentity: null,
  createdAt: new Date(NOW.getTime() - 2 * HOUR),
  lastActiveAt: new Date(NOW.getTime() - HOUR),
  onboardingStep: 'basics',
  onboardingCompletedAt: null,
  history: [],
  resumeCheck: null,
  hasTailored: false,
  practiceUsed: false,
  hasSearch: true,
  ...over,
});

const sent = (step: (typeof LIFECYCLE_STEPS)[number], at: Date): SentRecord => ({
  templateKey: {
    welcome: NOTIFY_TEMPLATES.welcome,
    finish_setup: NOTIFY_TEMPLATES.finishSetup,
    resume_check_ready: NOTIFY_TEMPLATES.resumeCheckReady,
    tips_first_tailor: NOTIFY_TEMPLATES.tipsFirstTailor,
    tips_practice: NOTIFY_TEMPLATES.tipsPractice,
    follow_up_reminder: NOTIFY_TEMPLATES.followUpReminder,
    interview_date_reminder: NOTIFY_TEMPLATES.interviewReminder,
    ready_list_ready: NOTIFY_TEMPLATES.readyListReady,
    tips_re_engagement: NOTIFY_TEMPLATES.tipsReEngagement,
  }[step],
  at,
});

describe('lifecycle rules (PRODUCT §7.3)', () => {
  it('maps every step to a notify template and back', () => {
    for (const s of LIFECYCLE_STEPS) expect(stepForTemplate(sent(s, NOW).templateKey)).toBe(s);
    for (const s of TIPS_STEPS) expect(LIFECYCLE_STEPS).toContain(s);
  });

  it('welcome: right after onboarding completes, or 1 h after signup; once', () => {
    expect(eligibleSteps(person({ createdAt: new Date(NOW.getTime() - 30 * 60_000) }), NOW, true)).toEqual([]);
    expect(eligibleSteps(person({ createdAt: new Date(NOW.getTime() - 30 * 60_000), onboardingStep: 'done', onboardingCompletedAt: NOW }), NOW, true)).toEqual(['welcome']);
    expect(eligibleSteps(person(), NOW, true)).toEqual(['welcome']);
    expect(eligibleSteps(person({ history: [sent('welcome', new Date(NOW.getTime() - HOUR))] }), NOW, true)).toEqual([]);
  });

  it('finish setup: 24 h after signup while before the resume stage; once', () => {
    const p = person({ createdAt: new Date(NOW.getTime() - 26 * HOUR), history: [sent('welcome', new Date(NOW.getTime() - 25 * HOUR))] });
    expect(eligibleSteps(p, NOW, true)).toEqual(['finish_setup']);
    expect(eligibleSteps({ ...p, onboardingStep: 'resume' }, NOW, true)).toEqual([]);
    expect(eligibleSteps({ ...p, onboardingStep: 'done' }, NOW, true)).toEqual([]);
  });

  it('resume check: ready and known to be unopened after 24 h', () => {
    const p = person({
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      onboardingStep: 'done',
      history: [sent('welcome', new Date(NOW.getTime() - 2 * DAY))],
      resumeCheck: { resumeId: 'r1', completedAt: new Date(NOW.getTime() - 25 * HOUR), issueCount: 3, viewed: false },
    });
    expect(eligibleSteps(p, NOW, false)).toEqual(['resume_check_ready']);
    expect(eligibleSteps({ ...p, resumeCheck: { ...p.resumeCheck!, viewed: true } }, NOW, false)).toEqual([]);
    expect(eligibleSteps({ ...p, resumeCheck: { ...p.resumeCheck!, completedAt: new Date(NOW.getTime() - 2 * HOUR) } }, NOW, false)).toEqual([]);
  });

  it('resume check: an unknown view state counts as viewed (fail closed, nothing is sent)', () => {
    const p = person({
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      onboardingStep: 'done',
      history: [sent('welcome', new Date(NOW.getTime() - 2 * DAY))],
      resumeCheck: { resumeId: 'r1', completedAt: new Date(NOW.getTime() - 25 * HOUR), issueCount: 3, viewed: null },
    });
    expect(eligibleSteps(p, NOW, false)).toEqual([]);
  });


  it('day 3 tailoring tip and day 5 practice tip only with "Tips and reminders" on', () => {
    const p = person({ createdAt: new Date(NOW.getTime() - 5 * DAY - HOUR), onboardingStep: 'done', history: [sent('welcome', new Date(NOW.getTime() - 5 * DAY))] });
    expect(eligibleSteps(p, NOW, true)).toEqual(['tips_first_tailor', 'tips_practice']);
    expect(eligibleSteps(p, NOW, false)).toEqual([]);
    expect(eligibleSteps({ ...p, hasTailored: true, practiceUsed: true }, NOW, true)).toEqual([]);
  });

  it('re-engagement at 14 and 30 days idle, stopping after 2 unanswered', () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    const idle14 = person({ createdAt: old, onboardingStep: 'done', lastActiveAt: new Date(NOW.getTime() - 15 * DAY) });
    expect(eligibleSteps(idle14, NOW, true)).toEqual(['tips_re_engagement']);
    const once = { ...idle14, history: [sent('tips_re_engagement', new Date(NOW.getTime() - DAY))] };
    expect(eligibleSteps(once, NOW, true)).toEqual([]); // second one waits for day 30
    const idle31 = { ...once, lastActiveAt: new Date(NOW.getTime() - 31 * DAY), history: [sent('tips_re_engagement', new Date(NOW.getTime() - 16 * DAY))] };
    expect(eligibleSteps(idle31, NOW, true)).toEqual(['tips_re_engagement']);
    const twice = { ...idle31, history: [...idle31.history, sent('tips_re_engagement', new Date(NOW.getTime() - DAY))] };
    expect(eligibleSteps(twice, NOW, true)).toEqual([]);
    // coming back resets the count
    const back = { ...twice, lastActiveAt: new Date(NOW.getTime() - 15 * DAY) };
    expect(eligibleSteps({ ...back, history: [sent('tips_re_engagement', new Date(NOW.getTime() - 20 * DAY))] }, NOW, true)).toEqual(['tips_re_engagement']);
    expect(eligibleSteps({ ...idle14, hasSearch: false }, NOW, true)).toEqual([]);
  });

  it('one lifecycle message a day, reminders from producers included', () => {
    expect(dayBudgetUsed([sent('follow_up_reminder', new Date(NOW.getTime() - 3 * HOUR))], NOW)).toBe(true);
    expect(dayBudgetUsed([sent('follow_up_reminder', new Date(NOW.getTime() - 25 * HOUR))], NOW)).toBe(false);
    expect(dayBudgetUsed([{ templateKey: 'billing.receipt', at: NOW }], NOW)).toBe(false);
  });
});

// ── Service ──────────────────────────────────────────────────────────────

const prefs = (over: Partial<PreferenceFacts> = {}): PreferenceFacts => ({
  userId: 'u1',
  brand: 'roboapply',
  tipsGranted: null,
  marketingGranted: null,
  country: 'US',
  prefs: {},
  timeZone: 'America/New_York',
  quietHours: { start: '21:00', end: '08:00' },
  ...over,
});

const recipient = (brand: BrandId = 'roboapply'): Recipient => ({ userId: 'u1', brand, email: 'u1@example.com', locale: 'en', timeZone: 'America/New_York', seekerProfileId: 'sp1' });

function makeDeps(
  p: LifecyclePerson,
  opts: { prefs?: PreferenceFacts; count?: number | null; credits?: number | null; free?: boolean; claim?: boolean; topJob?: { id: string; title: string; company: string } | null } = {},
) {
  const sentMsgs: NotifyMessage[] = [];
  const recorded: Array<{ userId: string; templateKey: string; at: Date }> = [];
  const repo: LifecycleRepo = {
    candidates: async ({ afterId }) => (afterId ? [] : [p.userId]),
    people: async () => new Map([[p.userId, p]]),
    recordSent: async (userId, templateKey, at) => {
      recorded.push({ userId, templateKey, at });
    },
    topFitJob: async () => (opts.topJob === undefined ? { id: 'j1', title: 'Data Analyst', company: 'Acme' } : opts.topJob),
    activeSearch: async () => ({ id: 'sp1', name: 'Data jobs', filters: {} }),
  };
  const deps: LifecycleDeps = {
    repo,
    prefs: { load: async () => opts.prefs ?? prefs() },
    recipients: async () => new Map([[p.userId, recipient(p.brand)]]),
    deliver: async (msg) => (sentMsgs.push(msg), { notificationId: 'n1', email: null, channels: {} }),
    practiceBalance: async () => {
      const credits = opts.credits === undefined ? 1 : opts.credits;
      return credits === null ? null : { credits, free: opts.free ?? true };
    },
    countNewJobs: vi.fn(async () => (opts.count === undefined ? 12 : opts.count)),
    firstRoute: (b) => (b.market === 'cn' ? '/campus' : '/jobs'),
    setupRoute: () => '/onboarding/basics',
    claimDay: vi.fn(async () => opts.claim ?? true),
  };
  return { deps, sentMsgs, recorded };
}

describe('lifecycle service', () => {
  const brand = getBrand('roboapply');

  it('sends the first due row in-app (and onward), with the welcome links', async () => {
    const p = person();
    const { deps, sentMsgs } = makeDeps(p);
    expect(await runForPerson(p, recipient(), prefs(), brand, deps, NOW)).toEqual({ sent: 'welcome' });
    expect(sentMsgs[0]).toMatchObject({ kind: 'lifecycle', category: 'reminder', templateKey: NOTIFY_TEMPLATES.welcome, params: { firstRoute: '/jobs' } });
  });

  it('records every send whatever the channel, so a once-only row never repeats (e.g. push only)', async () => {
    const p = person();
    const pushOnly = prefs({ prefs: { channels: { reminder: ['push'] } } });
    const { deps, recorded } = makeDeps(p, { prefs: pushOnly });
    // deliver wrote no in-app row and no email
    deps.deliver = async () => ({ notificationId: null, email: null, channels: { web_push: { delivered: true } } });
    expect(await runForPerson(p, recipient(), pushOnly, brand, deps, NOW)).toEqual({ sent: 'welcome' });
    expect(recorded).toEqual([{ userId: 'u1', templateKey: NOTIFY_TEMPLATES.welcome, at: NOW }]);
    // read back as history, the row is not due again, and the day budget is used
    const later = new Date(NOW.getTime() + 2 * DAY);
    const again = { ...p, history: recorded.map((r) => ({ templateKey: r.templateKey, at: r.at })) };
    expect(eligibleSteps(again, later, true)).not.toContain('welcome');
    expect(dayBudgetUsed(again.history, new Date(NOW.getTime() + HOUR))).toBe(true);
  });

  it('one a day: a lifecycle message in the last 24 h, or a lost claim, sends nothing', async () => {
    const p = person({ history: [sent('follow_up_reminder', new Date(NOW.getTime() - HOUR))] });
    const a = makeDeps(p);
    expect(await runForPerson(p, recipient(), prefs(), brand, a.deps, NOW)).toEqual({ skipped: 'day_used' });
    const q = person();
    const b = makeDeps(q, { claim: false });
    expect(await runForPerson(q, recipient(), prefs(), brand, b.deps, NOW)).toEqual({ skipped: 'claimed' });
    expect(b.sentMsgs).toHaveLength(0);
  });

  it('nothing in quiet hours', async () => {
    const p = person();
    const { deps, sentMsgs } = makeDeps(p);
    const late = new Date('2026-10-11T02:00:00Z'); // 22:00 New York
    expect(await runForPerson(p, recipient(), prefs(), brand, deps, late)).toEqual({ skipped: 'quiet' });
    expect(sentMsgs).toHaveLength(0);
  });

  it.each([
    ['US', true],
    ['DE', false],
    ['GB', false],
    ['CA', false],
    [null, false],
  ])('"Tips and reminders" rows with the regional default in %s → sent: %s', async (country, expected) => {
    const p = person({ createdAt: new Date(NOW.getTime() - 5 * DAY - HOUR), onboardingStep: 'done', history: [sent('welcome', new Date(NOW.getTime() - 5 * DAY))] });
    const { deps, sentMsgs } = makeDeps(p);
    const r = await runForPerson(p, recipient(), prefs({ country }), brand, deps, NOW);
    expect('sent' in r).toBe(expected);
    if (expected) expect(sentMsgs[0]).toMatchObject({ category: 'tips', templateKey: NOTIFY_TEMPLATES.tipsFirstTailor, params: { job: { id: 'j1' } } });
    else expect(sentMsgs).toHaveLength(0);
  });

  it('GoApply: tips are off by default, on only with a recorded choice', async () => {
    const p = person({ brand: 'goapply', createdAt: new Date(NOW.getTime() - 5 * DAY - HOUR), onboardingStep: 'done', history: [sent('welcome', new Date(NOW.getTime() - 5 * DAY))] });
    const cn = getBrand('goapply');
    const tz = { timeZone: 'Asia/Shanghai' };
    const noon = new Date('2026-10-10T04:00:00Z'); // 12:00 Shanghai
    const off = makeDeps(p);
    expect(await runForPerson(p, recipient('goapply'), prefs({ brand: 'goapply', country: 'CN', ...tz }), cn, off.deps, noon)).toEqual({ skipped: 'nothing_due' });
    const on = makeDeps(p);
    expect(await runForPerson(p, recipient('goapply'), prefs({ brand: 'goapply', country: 'CN', tipsGranted: true, ...tz }), cn, on.deps, noon)).toEqual({ sent: 'tips_first_tailor' });
  });

  it('the tailoring tip with no job to name opens the job list, or the resume page where the job list is closed', async () => {
    const p = person({ brand: 'goapply', createdAt: new Date(NOW.getTime() - 5 * DAY - HOUR), onboardingStep: 'done', history: [sent('welcome', new Date(NOW.getTime() - 5 * DAY))] });
    const cn = getBrand('goapply');
    const cnPrefs = prefs({ brand: 'goapply', country: 'CN', tipsGranted: true, timeZone: 'Asia/Shanghai' });
    const noon = new Date('2026-10-10T04:00:00Z'); // 12:00 Shanghai
    // GoApply with the recruitment-info mode off: no posting is named and /jobs is closed.
    const closed = makeDeps(p, { topJob: null });
    expect(await runForPerson(p, recipient('goapply'), cnPrefs, cn, { ...closed.deps, jobsOpen: () => false }, noon)).toEqual({ sent: 'tips_first_tailor' });
    expect(closed.sentMsgs[0]).toMatchObject({ templateKey: NOTIFY_TEMPLATES.tipsFirstTailor, params: { job: null, fallbackHref: '/resume' }, href: '/resume' });
    // The job list is open but nothing fits yet: the list itself.
    const open = makeDeps(p, { topJob: null });
    expect(await runForPerson(p, recipient('goapply'), cnPrefs, cn, { ...open.deps, jobsOpen: () => true }, noon)).toEqual({ sent: 'tips_first_tailor' });
    expect(open.sentMsgs[0]).toMatchObject({ params: { job: null }, href: '/jobs' });
    expect(open.sentMsgs[0]!.params).not.toHaveProperty('fallbackHref');
    // A job to name wins wherever it is allowed.
    const fit = makeDeps(p);
    await runForPerson(p, recipient('goapply'), cnPrefs, cn, { ...fit.deps, jobsOpen: () => true }, noon);
    expect(fit.sentMsgs[0]).toMatchObject({ params: { job: { id: 'j1' } }, href: '/jobs/j1?from=tips' });
  });

  it('the practice tip needs a real unused credit (it replaces the Friday nudge)', async () => {
    const p = person({ createdAt: new Date(NOW.getTime() - 5 * DAY - HOUR), onboardingStep: 'done', hasTailored: true, history: [sent('welcome', new Date(NOW.getTime() - 5 * DAY))] });
    const none = makeDeps(p, { credits: 0 });
    expect(await runForPerson(p, recipient(), prefs(), brand, none.deps, NOW)).toEqual({ skipped: 'nothing_due' });
    const unknown = makeDeps(p, { credits: null });
    expect(await runForPerson(p, recipient(), prefs(), brand, unknown.deps, NOW)).toEqual({ skipped: 'nothing_due' });
    const one = makeDeps(p, { credits: 1 });
    expect(await runForPerson(p, recipient(), prefs(), brand, one.deps, NOW)).toEqual({ sent: 'tips_practice' });
    expect(one.sentMsgs[0]!.params).toEqual({ free: true });
    // Pro credits or a bought pack: sent, but the copy must not call it free
    const paid = makeDeps(p, { credits: 3, free: false });
    expect(await runForPerson(p, recipient(), prefs(), brand, paid.deps, NOW)).toEqual({ sent: 'tips_practice' });
    expect(paid.sentMsgs[0]!.params).toEqual({ free: false });
    const optedOut = makeDeps(p, { credits: 1 });
    expect(await runForPerson(p, recipient(), prefs({ practiceNudgeOptOut: true }), brand, optedOut.deps, NOW)).toEqual({ skipped: 'nothing_due' });
  });

  it('re-engagement only when N ≥ 3 (a real count), with N and the date in the message', async () => {
    const p = person({ createdAt: new Date(NOW.getTime() - 200 * DAY), onboardingStep: 'done', lastActiveAt: new Date(NOW.getTime() - 15 * DAY) });
    const two = makeDeps(p, { count: 2 });
    expect(await runForPerson(p, recipient(), prefs(), brand, two.deps, NOW)).toEqual({ skipped: 'nothing_due' });
    const many = makeDeps(p, { count: 7 });
    expect(await runForPerson(p, recipient(), prefs(), brand, many.deps, NOW)).toEqual({ sent: 'tips_re_engagement' });
    expect(many.sentMsgs[0]!.params).toMatchObject({ count: 7, search: 'Data jobs', since: p.lastActiveAt!.toISOString() });
    // Counted for the saved search itself, through the feed's alert seam (join J4).
    expect(many.deps.countNewJobs).toHaveBeenCalledWith({ searchProfileId: 'sp1', userId: 'u1', market: 'intl', since: p.lastActiveAt });
    // More matched than were read: there is no exact N, so nothing is sent (never a floor; D3).
    const unknown = makeDeps(p, { count: null });
    expect(await runForPerson(p, recipient(), prefs(), brand, unknown.deps, NOW)).toEqual({ skipped: 'nothing_due' });
    expect(unknown.sentMsgs).toHaveLength(0);
  });

  it('the re-engagement count is the candidate seam’s ids for that search; a truncated read is not a number', async () => {
    const since = new Date(NOW.getTime() - 15 * DAY);
    const asked: unknown[] = [];
    const source = (found: { ids: string[]; truncated: boolean }) => async (q: unknown) => (asked.push(q), found);
    const input = { searchProfileId: 'sp1', userId: 'u1', market: 'intl' as const, since };
    expect(await countNewJobsWith(source({ ids: ['a', 'b', 'c', 'd'], truncated: false }))(input)).toBe(4);
    expect(asked[0]).toEqual({ searchProfileId: 'sp1', userId: 'u1', market: 'intl', filters: null, since, postedSince: null, limit: RE_ENGAGEMENT_COUNT_LIMIT });
    expect(await countNewJobsWith(source({ ids: [], truncated: false }))(input)).toBe(0);
    expect(await countNewJobsWith(source({ ids: Array.from({ length: RE_ENGAGEMENT_COUNT_LIMIT }, (_v, i) => `j${i}`), truncated: true }))(input)).toBeNull();
    // The limit is the feed's own id limit: a larger ask would be clamped there and still report `truncated`.
    expect(RE_ENGAGEMENT_COUNT_LIMIT).toBe(FEED_LIMITS.retrievalLimit);
  });

  it('the cron runs per brand and answers no_work fast', async () => {
    const p = person();
    const { deps, sentMsgs } = makeDeps(p);
    const ctx = { name: 'lifecycle-emails', brand, budget: createBudget(240_000), now: NOW };
    expect(await createLifecycleTask(() => deps)(ctx)).toMatchObject({ processed: 1, sent: 1, bySteps: { welcome: 1 } });
    expect(sentMsgs).toHaveLength(1);
    const empty: LifecycleDeps = { ...deps, repo: { ...deps.repo, candidates: async () => [] } };
    expect(await createLifecycleTask(() => empty)(ctx)).toEqual({ skipped: 'no_work', processed: 0 });
    // another brand's account is never handled by this brand's run
    const other = makeDeps(person({ brand: 'goapply' }));
    expect(await createLifecycleTask(() => other.deps)(ctx)).toMatchObject({ processed: 0, sent: 0 });
  });

  it('the cron pages through every candidate, not only the first page', async () => {
    const total = CANDIDATE_PAGE * 2 + 37;
    const all = Array.from({ length: total }, (_, i) => `u${String(i).padStart(5, '0')}`);
    const calls: Array<string | null> = [];
    const base = makeDeps(person());
    const deps: LifecycleDeps = {
      ...base.deps,
      repo: {
        ...base.deps.repo,
        candidates: async ({ afterId, limit }) => {
          calls.push(afterId);
          return all.filter((id) => !afterId || id > afterId).slice(0, limit);
        },
        people: async (ids) => new Map(ids.map((id) => [id, person({ userId: id })])),
      },
      recipients: async (ids) => new Map(ids.map((id) => [id, { ...recipient(), userId: id }])),
    };
    const ctx = { name: 'lifecycle-emails', brand, budget: createBudget(240_000), now: NOW };
    expect(await createLifecycleTask(() => deps)(ctx)).toMatchObject({ processed: total, sent: total });
    expect(calls).toEqual([null, all[CANDIDATE_PAGE - 1], all[2 * CANDIDATE_PAGE - 1]]);
  });

  it('canSend: quiet hours, day budget, tips preference and once-only rows', async () => {
    const p = person({ history: [sent('welcome', new Date(NOW.getTime() - 3 * DAY))] });
    const { deps } = makeDeps(p);
    expect(await canSendWith('u1', 'follow_up_reminder', NOW, deps)).toBe(true);
    expect(await canSendWith('u1', 'welcome', NOW, deps)).toBe(false);
    expect(await canSendWith('u1', 'follow_up_reminder', new Date('2026-10-11T02:00:00Z'), deps)).toBe(false);
    const de = { ...deps, prefs: { load: async () => prefs({ country: 'DE' }) } };
    expect(await canSendWith('u1', 'tips_practice', NOW, de)).toBe(false);
    const busy = makeDeps(person({ history: [sent('interview_date_reminder', new Date(NOW.getTime() - HOUR))] }));
    expect(await canSendWith('u1', 'follow_up_reminder', NOW, busy.deps)).toBe(false);
  });
});

// ── Repo: the resume-check view signal (SR-39a-1) ────────────────────────

type GradeRow = { userId: string; variantId: string; completedAt: Date | null; counts: unknown; viewedAt: Date | null };

/** The reads `people()` makes, over fixed rows (no database). */
function lifecycleDb(grades: GradeRow[], opts: { createdAt?: Date } = {}) {
  const gradeArgs: Array<{ select?: Record<string, unknown> }> = [];
  const none = { findMany: async () => [] };
  const db = {
    user: {
      findMany: async () => [
        {
          id: 'u1',
          brand: 'roboapply',
          createdAt: opts.createdAt ?? new Date(NOW.getTime() - 2 * DAY),
          lastActiveAt: new Date(NOW.getTime() - 30 * HOUR),
          seekerProfile: { onboardingStep: 'done', onboardingCompletedAt: new Date(NOW.getTime() - 2 * DAY) },
          raProfile: null,
        },
      ],
    },
    // The welcome row already went out, so row 4 is the next one due.
    seekerNotification: { findMany: async () => [{ userId: 'u1', templateKey: NOTIFY_TEMPLATES.welcome, createdAt: new Date(NOW.getTime() - 2 * DAY) }] },
    rAEmailLog: none,
    rARateCounter: none,
    rAResumeGrade: {
      findMany: async (args: { select?: Record<string, unknown> }) => {
        gradeArgs.push(args);
        return grades;
      },
    },
    rATailorSession: none,
    mockInterviewCreditLedger: none,
    rASearchProfile: none,
  };
  return { getDb: (async () => db) as unknown as NonNullable<PrismaLifecycleRepoOptions['getDb']>, gradeArgs };
}

const grade = (over: Partial<GradeRow> = {}): GradeRow => ({
  userId: 'u1',
  variantId: 'rv1',
  completedAt: new Date(NOW.getTime() - 25 * HOUR),
  counts: { urgent: 2, critical: 1, optional: 4 },
  viewedAt: null,
  ...over,
});

describe('lifecycle repo: resume check view signal (SR-39a-1)', () => {
  const brand = getBrand('roboapply');
  // The stamp went live 10 days ago: every check in these tests was completed after it, unless a test says otherwise.
  const env = { RESUME_CHECK_VIEW_SIGNAL_SINCE: new Date(NOW.getTime() - 10 * DAY).toISOString() };

  it('reads RAResumeGrade.viewedAt, and row 4 goes out when the check is unopened after 24 h', async () => {
    const { getDb, gradeArgs } = lifecycleDb([grade()]);
    const repo = createPrismaLifecycleRepo({ getDb, env });
    const p = (await repo.people(['u1'], NOW)).get('u1')!;
    expect(gradeArgs[0]!.select).toMatchObject({ viewedAt: true });
    expect(p.resumeCheck).toEqual({ resumeId: 'rv1', completedAt: new Date(NOW.getTime() - 25 * HOUR), issueCount: 3, viewed: false });
    expect(eligibleSteps(p, NOW, false)).toEqual(['resume_check_ready']);
    // End to end through the service: the message names the real resume and the real count.
    const { deps, sentMsgs, recorded } = makeDeps(p);
    expect(await runForPerson(p, recipient(), prefs(), brand, { ...deps, repo: { ...deps.repo, people: repo.people } }, NOW)).toEqual({ sent: 'resume_check_ready' });
    expect(sentMsgs[0]).toMatchObject({
      category: 'reminder',
      templateKey: NOTIFY_TEMPLATES.resumeCheckReady,
      params: { resumeId: 'rv1', issueCount: 3 },
      href: '/resume/rv1/check',
    });
    expect(recorded).toEqual([{ userId: 'u1', templateKey: NOTIFY_TEMPLATES.resumeCheckReady, at: NOW }]);
  });

  it('an opened check is never announced: the first check, or any later one the person opened', async () => {
    const opened = createPrismaLifecycleRepo({ env, getDb: lifecycleDb([grade({ viewedAt: new Date(NOW.getTime() - 20 * HOUR) })]).getDb });
    const a = (await opened.people(['u1'], NOW)).get('u1')!;
    expect(a.resumeCheck?.viewed).toBe(true);
    expect(eligibleSteps(a, NOW, false)).toEqual([]);
    // First check unopened, but they ran and opened a second one.
    const later = createPrismaLifecycleRepo({
      env,
      getDb: lifecycleDb([grade(), grade({ variantId: 'rv2', completedAt: new Date(NOW.getTime() - 3 * HOUR), viewedAt: new Date(NOW.getTime() - 2 * HOUR) })]).getDb,
    });
    const b = (await later.people(['u1'], NOW)).get('u1')!;
    expect(b.resumeCheck).toMatchObject({ resumeId: 'rv1', viewed: true });
    expect(eligibleSteps(b, NOW, false)).toEqual([]);
  });

  it('not before 24 h, and no check means no message', async () => {
    const fresh = createPrismaLifecycleRepo({ env, getDb: lifecycleDb([grade({ completedAt: new Date(NOW.getTime() - 2 * HOUR) })]).getDb });
    expect(eligibleSteps((await fresh.people(['u1'], NOW)).get('u1')!, NOW, false)).toEqual([]);
    const noCheck = createPrismaLifecycleRepo({ env, getDb: lifecycleDb([]).getDb });
    const p = (await noCheck.people(['u1'], NOW)).get('u1')!;
    expect(p.resumeCheck).toBeNull();
    expect(eligibleSteps(p, NOW, false)).toEqual([]);
  });

  it('a check completed before the stamp went live is "not known", never "unopened": nothing is sent for it', async () => {
    // Completed 25 h ago, stamp live since 2 h ago: viewedAt is null whether or not the person read it.
    const cutoff = { RESUME_CHECK_VIEW_SIGNAL_SINCE: new Date(NOW.getTime() - 2 * HOUR).toISOString() };
    const before = createPrismaLifecycleRepo({ env: cutoff, getDb: lifecycleDb([grade()]).getDb });
    const p = (await before.people(['u1'], NOW)).get('u1')!;
    expect(p.resumeCheck).toMatchObject({ resumeId: 'rv1', viewed: null });
    expect(eligibleSteps(p, NOW, false)).toEqual([]);
    // Opened since (the stamp is there): known as viewed.
    const openedSince = createPrismaLifecycleRepo({ env: cutoff, getDb: lifecycleDb([grade({ viewedAt: new Date(NOW.getTime() - HOUR) })]).getDb });
    expect((await openedSince.people(['u1'], NOW)).get('u1')!.resumeCheck?.viewed).toBe(true);
    // The go-live time is not set, or cannot be read: no check is known as unopened (row 4 stays off).
    for (const unset of [{}, { RESUME_CHECK_VIEW_SIGNAL_SINCE: '' }, { RESUME_CHECK_VIEW_SIGNAL_SINCE: 'soon' }]) {
      const repo = createPrismaLifecycleRepo({ env: unset, getDb: lifecycleDb([grade()]).getDb });
      const q = (await repo.people(['u1'], NOW)).get('u1')!;
      expect(q.resumeCheck?.viewed).toBeNull();
      expect(eligibleSteps(q, NOW, false)).toEqual([]);
    }
    expect(resumeCheckViewSignalSince({ RESUME_CHECK_VIEW_SIGNAL_SINCE: '2026-10-12T00:00:00Z' })).toEqual(new Date('2026-10-12T00:00:00Z'));
    expect(resumeCheckViewSignalSince({})).toBeNull();
  });

  it('GoApply with CN_RECRUITMENT_INFO_MODE=off: the tailoring tip names no posting; with nothing set it does (D5 default)', async () => {
    const scores = vi.fn(async () => [{ jobId: 'job_gh', score: 90, job: { title: '产品经理', companyName: '示例科技' } }]);
    const db = { rAJobMatchScore: { findMany: scores }, rAJobUserState: { findMany: async () => [] } };
    const getDb = (async () => db) as unknown as NonNullable<PrismaLifecycleRepoOptions['getDb']>;
    const off = createPrismaLifecycleRepo({ getDb, env: { CN_RECRUITMENT_INFO_MODE: 'off' } });
    expect(await off.topFitJob('u1', 'cn')).toBeNull();
    expect(scores).not.toHaveBeenCalled();
    const on = createPrismaLifecycleRepo({ getDb, env: { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' } });
    expect(await on.topFitJob('u1', 'cn')).toEqual({ id: 'job_gh', title: '产品经理', company: '示例科技' });
    const byDefault = createPrismaLifecycleRepo({ getDb, env: {} });
    expect(await byDefault.topFitJob('u1', 'cn')).toEqual({ id: 'job_gh', title: '产品经理', company: '示例科技' });
    // RoboApply is not affected by the GoApply mode.
    expect(await off.topFitJob('u1', 'intl')).toEqual({ id: 'job_gh', title: '产品经理', company: '示例科技' });
  });
});

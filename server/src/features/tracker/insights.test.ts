// @vitest-environment node
//
// WP-38: the weekly card (ruling C40; roboapply/v2/services/RAInsightService.ts
// and routes/insights.ts, tested here inside the tracker area). Real counts always; an AI summary only
// with consent and a model (zero LLM calls otherwise); no canned narrative.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const billing = vi.hoisted(() => ({ writeDeductionLog: vi.fn(async () => undefined) }));
vi.mock('../../lib/matchBilling.js', () => billing);
vi.mock('../../lib/deductionCost.js', () => ({ costPatchFromTally: () => ({ platformCostUsd: 0, metadata: {} }) }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { WeeklyFacts } from './index.js';
import { createInsightsRouter, INSIGHT_REFRESH_LIMIT_NAME } from '../../roboapply/v2/routes/insights.js';
import { createInsightService, DETERMINISTIC_MODEL, refreshWeek, type InsightServiceDeps } from '../../roboapply/v2/services/RAInsightService.js';
import { WeeklyInsightQuerySchema, WeeklyInsightRefreshBodySchema } from './contract.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const FACTS: WeeklyFacts = { weekStart: '2026-10-04', weekEnd: '2026-10-10', applied: 3, interviews: 1, offers: 0, ended: 1, noReply10d: 2 };

let fake = createFakePrisma();
let consent = true;
let aiText = true;
const runAgent = vi.fn(async () => ({
  headline: 'Three applications this week',
  bodyMarkdown: 'You applied to Acme [[tracker:t1]].',
  citedTrackerIds: ['t1'],
  recommendations: [],
  model: 'test/model',
}));
const weeklyFacts = vi.fn(async () => FACTS);

function deps(): InsightServiceDeps {
  return {
    getDb: async () => fake as never,
    tracker: { weeklyFacts },
    aiAllowed: async () => consent,
    aiTextEnabled: () => aiText,
    runAgent,
    now: () => NOW,
  };
}

beforeEach(() => {
  fake = createFakePrisma({
    seed: {
      rATrackerEntry: [
        {
          id: 't1',
          userId: 'u1',
          jobId: null,
          status: 'applied',
          excitementStars: 0,
          dateSaved: new Date('2026-10-05T00:00:00Z'),
          dateApplied: new Date('2026-10-06T00:00:00Z'),
          notesMarkdown: 'Email the recruiter at jane.doe@example.com or +1 415 555 0100',
          externalSnapshot: { title: 'Analyst', companyName: 'Acme' },
          deletedAt: null,
          updatedAt: new Date('2026-10-06T00:00:00Z'),
        },
      ],
      rAResumeVariant: [{ id: 'r1', userId: 'u1', name: 'Main', kind: 'base', deletedAt: null, lastEditedAt: new Date('2026-10-01T00:00:00Z') }],
    },
  });
  consent = true;
  aiText = true;
  runAgent.mockClear();
  weeklyFacts.mockClear();
  billing.writeDeductionLog.mockClear();
});

describe('getWeekly', () => {
  it('always returns the counts; hides the pre-clone canned summary', async () => {
    fake.$rows('rACareerInsight').push({
      id: 'old',
      userId: 'u1',
      weekStartUtc: new Date('2026-10-04T00:00:00Z'),
      summaryMarkdown: "## Week summary\n\nYou're moving steadily through the funnel.",
      citedTrackerIds: [],
      modelUsed: DETERMINISTIC_MODEL,
      generatedAt: NOW,
    });
    const out = await createInsightService(deps()).getWeekly('u1');
    expect(out).toEqual({ insight: null, facts: FACTS, week: { startUtc: '2026-10-04', endUtc: '2026-10-10' }, aiAvailable: true });
    // No zone asked for: the tracker falls back to the stored one.
    expect(weeklyFacts).toHaveBeenCalledWith('u1', '2026-10-04', null);
  });

  it('the reader’s zone reaches the weekly counts, so the week is bucketed in the zone the page shows (FIX-3 carry-over)', async () => {
    await createInsightService(deps()).getWeekly('u1', '2026-10-04', 'America/Los_Angeles');
    expect(weeklyFacts).toHaveBeenLastCalledWith('u1', '2026-10-04', 'America/Los_Angeles');
    // The query schema takes an IANA name; an unknown name is not an error (the tracker falls back to the stored zone).
    expect(WeeklyInsightQuerySchema.parse({ weekStartUtc: '2026-10-04', tz: 'Asia/Shanghai' })).toEqual({ weekStartUtc: '2026-10-04', tz: 'Asia/Shanghai' });
    expect(WeeklyInsightQuerySchema.parse({})).toEqual({});
    expect(WeeklyInsightQuerySchema.safeParse({ tz: 'x'.repeat(65) }).success).toBe(false);
    expect(WeeklyInsightRefreshBodySchema.parse({ weekStartUtc: '2026-10-04', tz: 'Asia/Shanghai' })).toEqual({ weekStartUtc: '2026-10-04', tz: 'Asia/Shanghai' });
    expect(WeeklyInsightRefreshBodySchema.safeParse({ weekStartUtc: 'last week' }).success).toBe(false);
    expect(WeeklyInsightRefreshBodySchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('returns an AI summary flagged aiGenerated, and aiAvailable=false without consent', async () => {
    fake.$rows('rACareerInsight').push({
      id: 'i1',
      userId: 'u1',
      weekStartUtc: new Date('2026-10-04T00:00:00Z'),
      summaryMarkdown: '## Headline\n\nBody',
      citedTrackerIds: ['t1'],
      modelUsed: 'test/model',
      generatedAt: NOW,
    });
    consent = false;
    const out = await createInsightService(deps()).getWeekly('u1', '2026-10-04');
    expect(out.insight).toMatchObject({ id: 'i1', aiGenerated: true, citedTrackerIds: ['t1'] });
    expect(out.aiAvailable).toBe(false);
  });
});

describe('refresh', () => {
  it('makes zero LLM calls without AI consent or without a model', async () => {
    consent = false;
    await expect(createInsightService(deps()).refresh('u1', 'zh')).rejects.toMatchObject({ code: 'ai_unavailable' });
    consent = true;
    aiText = false;
    await expect(createInsightService(deps()).refresh('u1', 'zh')).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('passes the counts and redacted notes to the agent, stores the summary and bills it', async () => {
    const out = await createInsightService(deps()).refresh('u1', 'en');
    expect(runAgent).toHaveBeenCalledTimes(1);
    const [input, locale] = runAgent.mock.calls[0] as unknown as [
      { weekFacts: WeeklyFacts; goal: unknown; trackerEntriesLast4Weeks: Array<{ notesMarkdown: string | null; externalSnapshot: unknown }> },
      string,
    ];
    expect(locale).toBe('en');
    expect(input.goal).toBeNull();
    expect(input.weekFacts).toEqual(FACTS);
    const notes = input.trackerEntriesLast4Weeks[0]!.notesMarkdown!;
    expect(notes).not.toContain('jane.doe@example.com');
    expect(notes).not.toContain('555 0100');
    expect(out.insight).toMatchObject({ aiGenerated: true, modelUsed: 'test/model', summaryMarkdown: expect.stringContaining('## Three applications this week') });
    expect(fake.$rows('rACareerInsight')[0]).toMatchObject({ metrics: { applicationsCount: 3, interviewsCount: 1, offerCount: 0 } });
    expect(billing.writeDeductionLog).toHaveBeenCalledWith(expect.objectContaining({ sku: 'ra_insight', userId: 'u1' }));
  });

  it('writes the summary under the week the page shows, with the counts of the reader’s zone; never under an older week', async () => {
    // The reader is already in next week (a zone ahead of UTC at the week boundary).
    const ahead = await createInsightService(deps()).refresh('u1', 'zh', { weekStartUtc: '2026-10-11', tz: 'Asia/Shanghai' });
    expect(weeklyFacts).toHaveBeenLastCalledWith('u1', '2026-10-11', 'Asia/Shanghai');
    expect(ahead.week).toEqual({ startUtc: '2026-10-11', endUtc: '2026-10-17' });
    expect((fake.$rows('rACareerInsight')[0] as { weekStartUtc: Date }).weekStartUtc.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    // The stored summary is found by the GET for that same week.
    expect((await createInsightService(deps()).getWeekly('u1', '2026-10-11', 'Asia/Shanghai')).insight).not.toBeNull();
    // Without a week the summary is for the current UTC week and the stored zone, as before.
    await createInsightService(deps()).refresh('u1', 'en');
    expect(weeklyFacts).toHaveBeenLastCalledWith('u1', '2026-10-04', null);
    // An older (or far) week is refused: the summary is written from recent activity, never back-dated.
    runAgent.mockClear();
    for (const weekStartUtc of ['2026-09-20', '2026-10-25', '2026-10-05']) {
      await expect(createInsightService(deps()).refresh('u1', 'en', { weekStartUtc })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'not_current_week', currentWeekStartUtc: '2026-10-04' } });
    }
    expect(runAgent).not.toHaveBeenCalled();
    expect(refreshWeek(null, NOW)).toBe('2026-10-04');
    expect(refreshWeek('2026-09-27', NOW)).toBe('2026-09-27');
  });

  it('maps a failed call to ai_unavailable and lets content_blocked through', async () => {
    runAgent.mockRejectedValueOnce(new Error('timeout'));
    await expect(createInsightService(deps()).refresh('u1')).rejects.toMatchObject({ code: 'ai_unavailable' });
    runAgent.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'content_blocked' }));
    await expect(createInsightService(deps()).refresh('u1')).rejects.toMatchObject({ code: 'content_blocked' });
    expect(fake.$rows('rACareerInsight')).toHaveLength(0);
    expect(billing.writeDeductionLog).not.toHaveBeenCalled();
  });
});

describe('/v2/insights routes', () => {
  let h: RouteHarness;
  const limited: string[] = [];
  beforeAll(async () => {
    h = await startRouteHarness({
      env: {},
      mounts: [
        [
          '/api/v1/roboapply/v2/insights',
          createInsightsRouter({
            service: createInsightService({ ...deps(), getDb: async () => fake as never }),
            auth: [fakeAuth({ id: 'u1' })],
            phoneGate: (_req, _res, next) => {
              limited.push('phoneGate');
              next();
            },
            limiter: (name) => (_req, _res, next) => {
              limited.push(name);
              next();
            },
          }),
        ],
      ],
    });
  });
  afterAll(() => h.close());

  it('GET /weekly answers the envelope; POST /refresh is rate limited; consent off → 503', async () => {
    const res = await h.request<{ success: boolean; data: { facts: WeeklyFacts } }>('GET', '/api/v1/roboapply/v2/insights/weekly', { host: 'localhost:3621' });
    expect(res.status).toBe(200);
    expect(res.body.data.facts).toEqual(FACTS);
    const bad = await h.request('GET', '/api/v1/roboapply/v2/insights/weekly?weekStartUtc=10-04', { host: 'localhost:3621' });
    expect(bad.status).toBe(422);
    consent = false;
    const refresh = await h.request<{ code: string }>('POST', '/api/v1/roboapply/v2/insights/refresh', { host: 'localhost:3621' });
    expect([refresh.status, refresh.body.code]).toEqual([503, 'ai_unavailable']);
    expect(limited).toEqual(['phoneGate', INSIGHT_REFRESH_LIMIT_NAME]);
  });
});

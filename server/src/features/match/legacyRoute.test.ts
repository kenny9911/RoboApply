// @vitest-environment node
// WP-18 — the legacy V2 job routes (server/src/roboapply/v2/routes/jobs.ts):
// additive fields, honest `signals`, never a null score, and no model call
// without GoApply AI consent or on a route the brand's LLM policy refuses.
// No network, no database (Prisma and the agents are mocked).
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { SCORER_PROMPT_VERSION, type MatchDimension } from './contract.js';
import { legacyAiGate, legacyExplanation, legacyExtras, legacySignals, v2Signals, v3Dimensions } from './legacyView.js';

const INTL_MODEL = 'openrouter/openai/gpt-5.6-luna';

const mocks = vi.hoisted(() => ({
  model: 'openrouter/openai/gpt-5.6-luna',
  brandId: 'roboapply' as 'roboapply' | 'goapply',
  consent: true,
  existing: null as Record<string, unknown> | null,
  agentRun: vi.fn(),
  scoreUpsert: vi.fn(),
  writeDeductionLog: vi.fn(),
  aiAllowed: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  default: {
    rAJob: {
      findUnique: vi.fn(async () => ({ id: 'job1', title: 'Backend Engineer', description: 'Build APIs.', qualifications: 'TypeScript', benefits: null, workType: 'remote', sourceBoard: 'greenhouse' })),
    },
    rAResumeVariant: {
      findFirst: vi.fn(async () => ({ id: 'variant1', userId: 'user1', resumeMarkdown: '# Ada\nTypeScript', resumeContentHash: 'resume-hash', targetJobId: null })),
      findUnique: vi.fn(async () => ({ resumeContentHash: 'resume-hash' })),
      update: vi.fn(async () => ({})),
    },
    rAJobMatchScore: {
      findUnique: vi.fn(async () => mocks.existing),
      findFirst: vi.fn(async () => mocks.existing),
      upsert: (...args: unknown[]) => mocks.scoreUpsert(...args),
    },
    rATrackerEntry: { findFirst: vi.fn(async () => null) },
    rAKeywordExtraction: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../../roboapply/v2/lib/raAuth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: 'user1', subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../roboapply/v2/lib/raLocale.js', () => ({ RA_DEFAULT_LOCALE: 'en', getRequestLocale: () => 'en' }));
vi.mock('../../roboapply/v2/agents/RAJobMatchScorerAgent.js', () => ({
  resolvedJobMatchScorerModel: () => mocks.model,
  RAJobMatchScorerAgent: class {
    run(...args: unknown[]) {
      return mocks.agentRun(...args);
    }
  },
}));
vi.mock('../../lib/matchBilling.js', () => ({ writeDeductionLog: (...args: unknown[]) => mocks.writeDeductionLog(...args) }));
vi.mock('../../lib/deductionCost.js', () => ({ costPatchFromTally: () => ({ platformCostUsd: 0.01, metadata: {} }) }));
vi.mock('../../lib/requestContext.js', () => ({ getCurrentRequestId: () => 'request1' }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../roboapply/v2/services/RAJobIndexService.js', () => ({ raJobIndexService: {}, toJobView: (row: unknown) => row }));
vi.mock('../../roboapply/v2/services/RATrackerService.js', () => ({ raTrackerService: {}, TrackerNotFoundError: class extends Error {}, _internal_toTrackerView: vi.fn() }));
vi.mock('../../platform/brand/brandContext.js', async () => {
  const { getBrand: brandOf } = await vi.importActual<typeof import('../../platform/brand/registry.js')>('../../platform/brand/registry.js');
  return { getCurrentBrandOrDefault: () => brandOf(mocks.brandId) };
});
vi.mock('../../platform/consent/aiAllowed.js', () => ({ aiAllowed: (subject: unknown) => mocks.aiAllowed(subject) }));

function dims(): MatchDimension[] {
  return [
    { key: 'title_level', weight: 35, score: 90, status: 'scored', evidence: [] },
    { key: 'skills', weight: 30, score: 60, status: 'scored', evidence: [] },
    { key: 'industry', weight: 15, score: null, status: 'not_stated', evidence: [] },
    {
      key: 'logistics',
      weight: 10,
      score: 50,
      status: 'scored',
      evidence: [
        { text: 'Berlin, DE', source: 'posting', ref: 'location_met' },
        { text: 'EUR 50000', source: 'posting', ref: 'pay_not_met' },
      ],
    },
    { key: 'career_path', weight: 10, score: null, status: 'not_stated', evidence: [] },
  ];
}

const V2_ROW = {
  score: 94,
  resumeVariantId: 'variant1',
  resumeContentHashAtScore: 'resume-hash',
  modelUsed: INTL_MODEL,
  // An old v2 row: experience was a copy of the total, location/salary constants.
  explanation: { strengths: ['Go'], gaps: [], rationale: 'Strong fit.', signals: { skills: 67, experience: 94, location: 95, salary: 85 }, responseLanguage: 'en', promptVersion: 'v2_jobs_score_v1' },
  generatedAt: new Date('2026-08-12T00:00:00.000Z'),
  tier: null,
  dimensions: null,
  promptVersion: null,
};

const V3_ROW = {
  ...V2_ROW,
  score: 78,
  explanation: { strengths: ['Your Go work'], gaps: ['No Kubernetes'], rationale: 'Your payments work lines up.', keywordsMatched: [], keywordsMissing: [], responseLanguage: 'en', promptVersion: SCORER_PROMPT_VERSION },
  tier: 'good',
  dimensions: dims(),
  promptVersion: SCORER_PROMPT_VERSION,
};

describe('legacy POST /jobs/:id/score and GET /jobs/:id', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const router = (await import('../../roboapply/v2/routes/jobs.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/jobs', router);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.model = INTL_MODEL;
    mocks.brandId = 'roboapply';
    mocks.existing = null;
    mocks.aiAllowed.mockImplementation(async () => mocks.consent);
    mocks.consent = true;
    mocks.agentRun.mockResolvedValue({ score: 82, summary: 'Strong fit.', strengths: ['TypeScript'], gaps: [], keywordsMatched: ['TypeScript', 'Go'], keywordsMissing: ['Kubernetes'] });
    mocks.scoreUpsert.mockImplementation(async (args: Record<string, any>) => ({ ...args.update, resumeVariantId: 'variant1', generatedAt: new Date('2026-08-13T00:00:00.000Z') }));
    mocks.writeDeductionLog.mockResolvedValue(undefined);
  });

  async function postScore(body: Record<string, unknown> = { resumeVariantId: 'variant1' }): Promise<{ status: number; body: any }> {
    const r = await fetch(`${baseUrl}/jobs/job1/score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  it('a fresh v2 score: honest signals, the additive fields, and a row marked as v2', async () => {
    const r = await postScore();
    expect(r.status).toBe(200);
    expect(r.body.cached).toBe(false);
    expect(r.body.matchScore).toMatchObject({
      score: 82,
      tier: 'great',
      kind: 'ai',
      dimensions: null,
      estimateReason: null,
      explanation: { rationale: 'Strong fit.', signals: { skills: 67, experience: null, location: null, salary: null } },
    });
    const write = mocks.scoreUpsert.mock.calls[0]![0] as { create: Record<string, any>; update: Record<string, any> };
    expect(write.update).toMatchObject({ scoreKind: 'ai', tier: 'great', promptVersion: 'v2_jobs_score_v1', locale: 'en' });
    expect(write.update.explanation.signals).toEqual({ skills: 67, experience: null, location: null, salary: null });
    expect(mocks.aiAllowed).toHaveBeenCalledWith({ id: 'user1', brand: 'roboapply' });
  });

  it('serves a cached v2 row: the score stays a number, synthesized signals become null', async () => {
    mocks.existing = { ...V2_ROW };
    const r = await postScore();
    expect(r.body.cached).toBe(true);
    expect(r.body.matchScore.score).toBe(94);
    expect(r.body.matchScore).toMatchObject({ tier: 'great', kind: 'ai', dimensions: null, estimateReason: null });
    expect(r.body.matchScore.explanation.signals).toEqual({ skills: 67, experience: null, location: null, salary: null });
    expect(mocks.agentRun).not.toHaveBeenCalled();
  });

  it('serves a cached scorer v3 row with its dimensions; signals come from the components', async () => {
    mocks.existing = { ...V3_ROW };
    const r = await postScore();
    expect(r.body.cached).toBe(true);
    expect(r.body.matchScore).toMatchObject({ score: 78, tier: 'good', kind: 'ai', estimateReason: null });
    expect(r.body.matchScore.dimensions).toHaveLength(5);
    expect(r.body.matchScore.explanation).toMatchObject({ strengths: ['Your Go work'], signals: { skills: 60, experience: 90, location: 100, salary: 0 } });
  });

  it('GoApply without AI consent: 503 ai_off and zero model calls; a cached score is still served', async () => {
    mocks.brandId = 'goapply';
    mocks.consent = false;
    const r = await postScore();
    expect(r).toEqual({ status: 503, body: { error: 'ai_off' } });
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.scoreUpsert).not.toHaveBeenCalled();
    expect(mocks.writeDeductionLog).not.toHaveBeenCalled();

    mocks.existing = { ...V2_ROW };
    const cached = await postScore();
    expect(cached.status).toBe(200);
    expect(cached.body.matchScore.score).toBe(94);
    expect(mocks.agentRun).not.toHaveBeenCalled();
  });

  it('GoApply with consent but an international scorer model: 503 ai_unavailable, zero model calls (R-13)', async () => {
    mocks.brandId = 'goapply';
    const r = await postScore();
    expect(r).toEqual({ status: 503, body: { error: 'ai_unavailable' } });
    expect(mocks.agentRun).not.toHaveBeenCalled();

    mocks.model = 'deepseek/deepseek-chat';
    const domestic = await postScore();
    expect(domestic.status).toBe(200);
    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
  });

  it('a failed model call stays a 502 (never a null score)', async () => {
    mocks.agentRun.mockRejectedValueOnce(new Error('timeout'));
    const r = await postScore();
    expect(r.status).toBe(502);
    expect(mocks.scoreUpsert).not.toHaveBeenCalled();
  });

  it('GET /jobs/:id adds the same fields and nulls synthesized signals on an old row', async () => {
    mocks.existing = { ...V2_ROW };
    const r = await fetch(`${baseUrl}/jobs/job1`);
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(body.matchScore).toMatchObject({
      score: 94,
      tier: 'great',
      kind: 'ai',
      dimensions: null,
      estimateReason: null,
      stale: false,
      explanationStale: false,
      explanation: { strengths: ['Go'], signals: { skills: 67, experience: null, location: null, salary: null } },
    });
  });
});

describe('legacyView helpers', () => {
  it('v3Dimensions trusts only scorer v3 rows', () => {
    expect(v3Dimensions({ promptVersion: SCORER_PROMPT_VERSION, dimensions: dims() })).toHaveLength(5);
    expect(v3Dimensions({ promptVersion: 'v2_jobs_score_v1', dimensions: dims() })).toBeNull();
    expect(v3Dimensions({ promptVersion: SCORER_PROMPT_VERSION, dimensions: [{ key: 'nope' }] })).toBeNull();
  });

  it('legacySignals: components when known, the stored keyword share otherwise, never a constant', () => {
    expect(legacySignals(dims(), null)).toEqual({ skills: 60, experience: 90, location: 100, salary: 0 });
    const notStated = dims().map((d) => (d.key === 'logistics' ? { ...d, evidence: [] } : d));
    expect(legacySignals(notStated, null)).toMatchObject({ location: null, salary: null });
    expect(legacySignals(null, { signals: { skills: 'x' } })).toEqual({ skills: null, experience: null, location: null, salary: null });
    expect(legacySignals(null, null)).toEqual({ skills: null, experience: null, location: null, salary: null });
  });

  it('v2Signals: the matched-keyword share, null with no keywords', () => {
    expect(v2Signals({ keywordsMatched: ['a'], keywordsMissing: ['b', 'c'] })).toEqual({ skills: 33, experience: null, location: null, salary: null });
    expect(v2Signals({})).toEqual({ skills: null, experience: null, location: null, salary: null });
  });

  it('legacyExplanation normalizes arrays; legacyExtras keeps a stored tier or derives one', () => {
    expect(legacyExplanation({ explanation: 'oops' })).toEqual({ strengths: [], gaps: [], rationale: '', signals: { skills: null, experience: null, location: null, salary: null } });
    expect(legacyExtras({ score: 50, tier: 'great' }).tier).toBe('great');
    expect(legacyExtras({ score: 50, tier: 'bogus' }).tier).toBe('possible');
    expect(legacyExtras({ score: null }).tier).toBeNull();
  });

  it('legacyAiGate: consent first, then the brand LLM policy', async () => {
    const goapply: ProductBrand = getBrand('goapply');
    const yes = async () => true;
    expect(await legacyAiGate({ userId: 'u', brand: goapply, model: INTL_MODEL }, { aiAllowed: async () => false })).toBe('ai_off');
    expect(await legacyAiGate({ userId: 'u', brand: goapply, model: INTL_MODEL }, { aiAllowed: yes })).toBe('ai_unavailable');
    expect(await legacyAiGate({ userId: 'u', brand: goapply, model: 'deepseek/deepseek-chat' }, { aiAllowed: yes })).toBeNull();
    // 'qwen/…' is not a routing prefix LLMService knows: it goes to the default provider (OpenRouter), so it is refused.
    expect(await legacyAiGate({ userId: 'u', brand: goapply, model: 'qwen/qwen-max' }, { aiAllowed: yes })).toBe('ai_unavailable');
    expect(await legacyAiGate({ userId: 'u', brand: getBrand('roboapply'), model: INTL_MODEL }, { aiAllowed: yes })).toBeNull();
    expect(await legacyAiGate({ userId: 'u', brand: getBrand('roboapply'), model: 'deepseek/deepseek-chat' }, { aiAllowed: yes })).toBe('ai_unavailable');
  });
});

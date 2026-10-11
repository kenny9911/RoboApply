// @vitest-environment node
// WP-18, MKT-4G — MatchService: the pinned scorer behind the cache (scorer v4 by default, scorer v3 behind
// MATCH_SCORER_RUBRIC=fit_v3), caps, consent, CitationGuard, the requirement checklist, fit analysis credits and
// the keyword check. No network, no database; every scorer is a fake and the model is never called.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../services/llm/LLMService.js', () => ({ llmService: { chat: llm.chat }, LLMService: class {} }));
vi.mock('../../services/LoggerService.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startStep: vi.fn(() => 0),
    endStep: vi.fn(),
    logAgentStart: vi.fn(),
    logAgentEnd: vi.fn(),
    pushAgent: vi.fn(),
    popAgent: vi.fn(),
    getRequestSnapshot: vi.fn(() => null),
    logLanguageDetection: vi.fn(),
  },
}));

import { getBrand } from '../../platform/brand/registry.js';
import { createCreditTestKit } from '../../platform/credits/testkit.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import {
  RAJobMatchScorerV3Agent,
  RAJobMatchScorerV4Agent,
  type RAJobMatchScorerV3Output,
  type RAJobMatchScorerV4Input,
  type RAJobMatchScorerV4Output,
  type ScorerV4RequirementAnswer,
} from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { SCORER_PROMPT_VERSION, type JobRequirement } from './contract.js';
import { cnPostingVisible } from '../cn/jobs/index.js';
import { currentJobHash, jobContentHash, requirementListHash } from './jobHash.js';
import { ScorerFailedError, createMatchService, shownKeywords, visibleTo, type MatchServiceDeps, type ScorerLike, type ScorerV4Like } from './MatchService.js';
import type { StoredRequirementsDoc } from './scorerV4.js';
import { createMemoryRepo, defaultUserInputs, jobRecord, resumeRecord } from './testkit.js';

const MODEL = 'test/model-a';

function scorerOutput(overrides: Partial<RAJobMatchScorerV3Output> = {}): RAJobMatchScorerV3Output {
  return {
    dimensions: {
      title_level: { score: 90, evidence: [{ text: 'Senior Software Engineer, PayCo', source: 'resume' }, { text: 'Invented quote', source: 'resume' }] },
      skills: { score: 60, evidence: [{ text: 'Kubernetes required', source: 'posting' }] },
      industry: { score: 80, evidence: [] },
      career_path: { score: null, evidence: [] },
    },
    strengths: ['Your payments APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    keywordsMatched: ['TypeScript'],
    keywordsMissing: ['Kubernetes'],
    summary: 'Your payments work lines up well, though the post centres on Kubernetes.',
    ...overrides,
  };
}

function allow(remaining = 100): RateLimitResult {
  return { allowed: true, retryAfterSec: 0, remaining, windows: [] };
}

/**
 * A service on scorer v3: the rollback, with its switch set explicitly (MATCH_SCORER_RUBRIC=fit_v3). The scorer v4
 * cases further down use `setupV4`, which sets nothing and so runs the default.
 */
function setup(over: Partial<MatchServiceDeps> & { repo?: ReturnType<typeof createMemoryRepo> } = {}) {
  const repo = over.repo ?? createMemoryRepo();
  const scorer = { run: vi.fn(async () => scorerOutput()) } satisfies ScorerLike;
  const consume = vi.fn(async () => allow());
  const costLog = vi.fn(async () => undefined);
  const withCredit = vi.fn(async (_o: unknown, fn: () => Promise<unknown>) => fn()) as unknown as NonNullable<MatchServiceDeps['withCredit']>;
  const service = createMatchService({
    repo,
    scorer,
    resolveModel: () => MODEL,
    routeAllowed: () => true,
    aiAllowed: async () => true,
    consume,
    withCredit,
    costLog,
    profileSnapshot: async () => null,
    brand: () => getBrand('roboapply'),
    now: () => new Date('2026-10-10T08:00:00Z'),
    ...over,
    // The rollback switch. Nothing else is set: GoApply cases here score public postings, which the recruitment-info
    // mode allows by default (D5).
    env: { MATCH_SCORER_RUBRIC: 'fit_v3', ...over.env },
  });
  return { service, repo, scorer: (over.scorer as typeof scorer) ?? scorer, consume, costLog, withCredit };
}

beforeEach(() => {
  llm.chat.mockReset();
});

describe('scoreJob — scorer v3 (the rollback: MATCH_SCORER_RUBRIC=fit_v3)', () => {
  it('the server computes the total from the components; the model never emits it', async () => {
    const { service, repo, scorer, costLog } = setup();
    const fit = await service.scoreJob('u1', 'job1', { locale: 'en' });
    expect(scorer.run).toHaveBeenCalledTimes(1);
    const logistics = fit.dimensions.find((d) => d.key === 'logistics')!;
    // Deterministic logistics: Berlin within radius, pay 90k ≥ 60k.
    expect(logistics.score).toBe(100);
    // 35·90 + 30·60 + 15·80 + 10·100 over 90 (career_path not stated drops out).
    expect(fit.score).toBe(Math.round((35 * 90 + 30 * 60 + 15 * 80 + 10 * 100) / 90));
    expect(fit.tier).toBe('good');
    expect(fit.kind).toBe('ai');
    expect(fit.dimensions.find((d) => d.key === 'career_path')!.status).toBe('not_stated');
    const saved = repo.state.scores[0]!;
    expect(saved).toMatchObject({ score: fit.score, tier: 'good', promptVersion: SCORER_PROMPT_VERSION, modelUsed: MODEL, scoreKind: 'ai', locale: 'en', searchProfileVersion: 1 });
    expect((saved.explanation as Record<string, unknown>).signals).toBeUndefined();
    expect(costLog).toHaveBeenCalledWith(expect.objectContaining({ reason: 'first_score', jobId: 'job1' }));
  });

  it('keeps only verified model keywords and gives the complete deterministic skill split', async () => {
    const scorer = {
      run: vi.fn(async () => scorerOutput({ keywordsMatched: ['TypeScript', 'Rust'], keywordsMissing: ['Kubernetes', 'Haskell', 'Go'] })),
    };
    const { service, repo } = setup({ scorer });
    const fit = await service.scoreJob('u1', 'job1');
    // Rust/Haskell are not in the post (dropped); Go is in the post and the resume (moved to matched).
    expect(repo.state.scores[0]!.explanation).toMatchObject({ keywordsMatched: ['TypeScript', 'Go'], keywordsMissing: ['Kubernetes'] });
    // FIX-3: the view does not repeat a term the skill chips already list (they are the same three things).
    expect(fit.keywordsMatched).toEqual([]);
    expect(fit.keywordsMissing).toEqual([]);
    expect(fit.skills).toEqual({ aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], softSkills: [], listed: 3 });
    const pre = await setup({ aiAllowed: async () => false }).service.scoreJob('u1', 'job1');
    expect(pre).toMatchObject({ kind: 'pre', keywordsMatched: [], keywordsMissing: [], skills: { aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], softSkills: [], listed: 3 } });
  });

  it('FIX-3: stored model terms are shown by the current rule: no repeats, usual spelling, and a broader term a listed technology shows is not "missing"', async () => {
    const stored = { keywordsMatched: ['typescript/node.js', 'TypeScript', 'payments'], keywordsMissing: ['cloud infrastructure', 'relational databases', 'grpc', 'GRPC', 'kubernetes'] };
    const user = { skills: ['TypeScript', 'Node.js', 'AWS'], resumeTextNorm: 'built payments apis on aws with postgresql', recentTitle: 'Software Engineer' };
    expect(shownKeywords(stored, user, { aligned: ['TypeScript'], missing: ['Kubernetes'] })).toEqual({
      keywordsMatched: ['TypeScript/Node.js', 'Payments', 'Cloud infrastructure', 'Relational databases'],
      keywordsMissing: ['gRPC'],
    });
  });

  it('a skill only in the resume body counts as shown in the fit view', async () => {
    const repo = createMemoryRepo({ resumes: [{ ...resumeRecord({ resumeMarkdown: '## Experience\nRan Kubernetes clusters; TypeScript and Go services.', parsedData: null }), userId: 'u1' }] });
    repo.state.users.u1!.profile!.skills = [];
    const { service } = setup({ repo });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit.skills).toEqual({ aligned: ['TypeScript', 'Kubernetes', 'Go'], missing: [], softSkills: [], listed: 3 });
    expect(fit.dimensions.find((d) => d.key === 'logistics')).toBeDefined();
  });

  it('drops evidence that is not a verbatim quote of its source (CitationGuard)', async () => {
    const { service } = setup();
    const fit = await service.scoreJob('u1', 'job1');
    const title = fit.dimensions.find((d) => d.key === 'title_level')!;
    expect(title.evidence).toEqual([{ text: 'Senior Software Engineer, PayCo', source: 'resume' }]);
    expect(fit.dimensions.find((d) => d.key === 'skills')!.evidence).toEqual([{ text: 'Kubernetes required', source: 'posting' }]);
  });

  it('sends a PII-stripped resume and the computed logistics, never the user name or email', async () => {
    const { service, scorer } = setup();
    await service.scoreJob('u1', 'job1');
    const input = scorer.run.mock.calls[0]![0] as { resumeMarkdown: string; logistics: { lines: string[] } };
    expect(input.resumeMarkdown).not.toMatch(/Ada|Lovelace|ada@example\.com|2345 6789/);
    expect(input.resumeMarkdown).toContain('Built payment APIs');
    expect(input.logistics.lines).toEqual(['Location: fits what the candidate asked for', 'Pay: fits what the candidate asked for']);
  });

  it('serves a fresh cached row without a model call; a logistics-only change recomputes the total without one', async () => {
    const { service, repo, scorer } = setup();
    const first = await service.scoreJob('u1', 'job1');
    const again = await service.scoreJob('u1', 'job1');
    expect(scorer.run).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ score: first.score, cached: true });

    // The user raises their pay floor above the posting: logistics drops to 50.
    repo.state.users.u1!.searchProfile = {
      version: 2,
      filters: { ...(repo.state.users.u1!.searchProfile!.filters as object), salaryMin: { amount: 120000, currency: 'EUR', period: 'year' } },
    };
    const moved = await service.scoreJob('u1', 'job1');
    expect(scorer.run).toHaveBeenCalledTimes(1);
    expect(moved.dimensions.find((d) => d.key === 'logistics')!.score).toBe(50);
    expect(moved.score).toBe(Math.round((35 * 90 + 30 * 60 + 15 * 80 + 10 * 50) / 90));
    expect(repo.state.scores[0]).toMatchObject({ score: moved.score, searchProfileVersion: 2 });
  });

  it('re-scores when the resume, the prompt version, the model or the posting changes, and says which', async () => {
    const { service, repo, scorer, costLog } = setup();
    await service.scoreJob('u1', 'job1');
    repo.state.resumes[0]!.resumeContentHash = 'hash-2';
    await service.scoreJob('u1', 'job1');
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'resume_changed' }));
    repo.state.scores[0]!.promptVersion = 'v2_jobs_score_v1';
    await service.scoreJob('u1', 'job1');
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'prompt_changed' }));
    expect(scorer.run).toHaveBeenCalledTimes(3);
    // The posting's requirements change: the stored score was for other content.
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, qualifications: '8+ years of backend experience. Rust required.' };
    await service.scoreJob('u1', 'job1');
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'posting_changed' }));
    // The pinned model changes: an on-demand call re-scores with it.
    const next = setup({ repo, resolveModel: () => 'test/model-b' });
    await next.service.scoreJob('u1', 'job1');
    expect(next.costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'model_changed' }));
    expect(repo.state.scores).toHaveLength(1);
    expect(repo.state.scores[0]).toMatchObject({ modelUsed: 'test/model-b', rubricVersion: 'fit_v3' });
  });

  it('freshness: a row is the fit for the same resume content and the posting as it is now; the model and prompt version only make it stale', async () => {
    const { service, repo, scorer } = setup();
    const first = await service.scoreJob('u1', 'job1');
    expect(first).toMatchObject({ kind: 'ai', stale: false, cached: false });
    // Stored with the posting's content hash and the rubric.
    expect(repo.state.scores[0]!.jobContentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.state.scores[0]!.rubricVersion).toBe('fit_v3');

    // Another model is pinned: cache-only readers keep the stored AI fit, flagged stale; nothing is re-scored for them.
    const b = setup({ repo, resolveModel: () => 'test/model-b' });
    expect(await b.service.scoreJob('u1', 'job1', { mode: 'cache_only' })).toMatchObject({ kind: 'ai', score: first.score, tier: first.tier, stale: true, cached: true });
    expect((await b.service.preScoreMany('u1', ['job1']))[0]).toMatchObject({ kind: 'ai', score: first.score });
    expect(b.scorer.run).not.toHaveBeenCalled();
    // No model configured at all: the stored fit still answers (reading it needs no model).
    const none = setup({ repo, resolveModel: () => null });
    expect(await none.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: first.score, cached: true, stale: false });

    // A row older than the hash column counts for the posting as it is.
    repo.state.scores[0] = { ...repo.state.scores[0]!, jobContentHash: null };
    expect(await service.scoreJob('u1', 'job1', { mode: 'cache_only' })).toMatchObject({ kind: 'ai', cached: true });
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });

  it('hysteresis: a recomputed total keeps the stored tier until it is 3 points past the edge it crosses', async () => {
    // Location met, pay floor above the posting; the job offers sponsorship.
    const repo = createMemoryRepo({ jobs: [jobRecord({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' })] });
    const filters = (change: Record<string, unknown>, version: number) => {
      repo.state.users.u1!.searchProfile = { version, filters: { ...(repo.state.users.u1!.searchProfile!.filters as object), ...change } };
    };
    filters({ salaryMin: { amount: 120000, currency: 'EUR', period: 'year' } }, 1);
    const scorer = { run: vi.fn(async () => scorerOutput({ dimensions: { title_level: { score: 95, evidence: [] }, skills: { score: 70, evidence: [] }, industry: { score: 80, evidence: [] }, career_path: { score: null, evidence: [] } } })) };
    const { service } = setup({ repo, scorer });
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ score: 79, tier: 'good' });
    // Needs sponsorship, which the job offers: total 81, one point over the Great edge. The tier stays.
    filters({ needsSponsorship: true }, 2);
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ score: 81, tier: 'good', cached: true });
    expect(repo.state.scores[0]).toMatchObject({ score: 81, tier: 'good', searchProfileVersion: 2 });
    // Pay floor lowered: total 85, three or more over. The tier changes.
    filters({ salaryMin: { amount: 60000, currency: 'EUR', period: 'year' } }, 3);
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ score: 85, tier: 'great', cached: true });
    expect(repo.state.scores[0]).toMatchObject({ score: 85, tier: 'great', searchProfileVersion: 3 });
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });

  it('a language switch serves the cached prose flagged stale; regenerating it is explicit', async () => {
    const { service, scorer } = setup();
    await service.scoreJob('u1', 'job1', { locale: 'en' });
    const zh = await service.scoreJob('u1', 'job1', { locale: 'zh' });
    expect(zh).toMatchObject({ cached: true, summaryLocaleStale: true });
    expect(scorer.run).toHaveBeenCalledTimes(1);
    const regen = await service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(regen).toMatchObject({ cached: false, summaryLocaleStale: false });
    expect(scorer.run).toHaveBeenCalledTimes(2);
  });

  it('rewriting the text in another language keeps the score, its components and the scored date', async () => {
    const run = vi
      .fn<ScorerLike['run']>()
      .mockResolvedValueOnce(scorerOutput())
      // The second call would score differently: none of its numbers may be used.
      .mockResolvedValueOnce(
        scorerOutput({
          dimensions: {
            title_level: { score: 20, evidence: [] },
            skills: { score: 10, evidence: [] },
            industry: { score: 30, evidence: [] },
            career_path: { score: 40, evidence: [] },
          },
          strengths: ['你在 Go 里做过支付接口'],
          gaps: ['没有体现 Kubernetes 经验'],
          summary: '你的支付经验很对口，但这个职位以 Kubernetes 为主。',
          keywordsMatched: [],
          keywordsMissing: [],
        }),
      );
    const { service, repo, costLog } = setup({ scorer: { run } });
    const first = await service.scoreJob('u1', 'job1', { locale: 'en' });
    const scoredAt = repo.state.scores[0]!.generatedAt;
    const regen = await service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(regen).toMatchObject({
      kind: 'ai',
      score: first.score,
      tier: first.tier,
      dimensions: first.dimensions,
      keywordsMatched: first.keywordsMatched,
      keywordsMissing: first.keywordsMissing,
      scoredAt: first.scoredAt,
      summary: '你的支付经验很对口，但这个职位以 Kubernetes 为主。',
      strengths: ['你在 Go 里做过支付接口'],
      gaps: ['没有体现 Kubernetes 经验'],
      summaryLocaleStale: false,
      cached: false,
    });
    expect(repo.state.scores).toHaveLength(1);
    expect(repo.state.scores[0]).toMatchObject({ score: first.score, locale: 'zh', generatedAt: scoredAt });
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'locale_regen' }));
    // The next read in that language is the cache, not flagged.
    expect(await service.scoreJob('u1', 'job1', { locale: 'zh' })).toMatchObject({ cached: true, summaryLocaleStale: false, score: first.score });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a rewrite that may not run, or fails, leaves the stored AI fit in place: never a quick estimate', async () => {
    // Over the daily cap.
    let capped = false;
    const consume = vi.fn(async ({ key }: { key: string }) => (capped && key.includes(':score:user:') ? { ...allow(0), allowed: false } : allow()));
    const a = setup({ consume });
    const first = await a.service.scoreJob('u1', 'job1', { locale: 'en' });
    capped = true;
    const overCap = await a.service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(overCap).toMatchObject({ kind: 'ai', score: first.score, summary: first.summary, summaryLocaleStale: true, estimateReason: null });
    expect(a.scorer.run).toHaveBeenCalledTimes(1);
    expect(a.repo.state.scores[0]).toMatchObject({ locale: 'en', score: first.score });

    // The model call fails.
    const run = vi.fn<ScorerLike['run']>().mockResolvedValueOnce(scorerOutput()).mockRejectedValueOnce(new Error('upstream 502'));
    const b = setup({ scorer: { run } });
    const stored = await b.service.scoreJob('u1', 'job1', { locale: 'en' });
    const failed = await b.service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(failed).toMatchObject({ kind: 'ai', score: stored.score, summary: stored.summary, summaryLocaleStale: true });
    expect(b.repo.state.scores[0]).toMatchObject({ locale: 'en' });
  });

  it('beyond 80 a day (or the brand budget) answers the Quick estimate', async () => {
    const consume = vi.fn(async ({ key }: { key: string }) => (key.includes(':score:user:') ? { ...allow(0), allowed: false } : allow()));
    const { service, scorer } = setup({ consume });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit).toMatchObject({ kind: 'pre', estimateReason: 'daily_cap', summary: null });
    expect(fit.score).not.toBeNull();
    expect(scorer.run).not.toHaveBeenCalled();
    const perUserCall = consume.mock.calls.find(([c]) => c.key.includes(':score:user:'));
    expect(perUserCall![0]).toMatchObject({ windows: [{ limit: 80, windowSec: 86400 }] });

    const budget = vi.fn(async ({ key }: { key: string; cost?: number }) => (key.startsWith('budget:') ? { ...allow(0), allowed: true } : allow()));
    const b = setup({ consume: budget });
    expect(await b.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'budget' });
    expect(b.scorer.run).not.toHaveBeenCalled();
  });

  it('a spent brand budget never costs the user one of their 80 daily scores', async () => {
    const used: Record<string, number> = {};
    const consume = vi.fn(async ({ key, cost }: { key: string; cost?: number }) => {
      used[key] = (used[key] ?? 0) + (cost ?? 1);
      // The budget is already spent: a peek (cost 0) reports nothing left.
      return key.startsWith('budget:') ? { ...allow(0), allowed: (cost ?? 1) === 0 } : allow();
    });
    const { service, scorer } = setup({ consume });
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'budget' });
    expect(Object.keys(used).some((k) => k.includes(':score:user:'))).toBe(false);
    expect(consume.mock.calls[0]![0]).toMatchObject({ cost: 0 });
    expect(scorer.run).not.toHaveBeenCalled();
  });

  // Which routes a brand may use is the LLM policy's own rule (match/scorerRoute.ts and platform/llm: under D5
  // GoApply scores on the shared stack unless CN_LLM_DOMESTIC_ONLY is set; that table is tested there). This
  // service has one duty: ask the policy for the brand and the model, and make zero scorer calls when it says no.
  it('GoApply with consent: a scorer model the brand LLM policy refuses means zero scorer calls; an allowed one scores', async () => {
    const scorer = { run: vi.fn(async () => scorerOutput()) };
    const asked: Array<[string, string]> = [];
    const { service, repo } = setup({
      repo: createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }),
      scorer,
      resolveModel: () => 'openrouter/openai/gpt-5.6-luna',
      routeAllowed: (brand, model) => {
        asked.push([brand.id, model]);
        return false;
      },
      brand: () => getBrand('goapply'),
    });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit).toMatchObject({ kind: 'pre', estimateReason: 'ai_unavailable' });
    expect(asked).toEqual([['goapply', 'openrouter/openai/gpt-5.6-luna']]);
    expect(scorer.run).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);

    // The policy allows the route (the shared model with no CN_ value, or a domestic one): the AI score, on both brands.
    for (const model of ['openrouter/openai/gpt-5.6-luna', 'deepseek/deepseek-chat']) {
      const cn = setup({ repo: createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }), resolveModel: () => model, routeAllowed: () => true, brand: () => getBrand('goapply') });
      expect((await cn.service.scoreJob('u1', 'job1')).kind, model).toBe('ai');
    }
    const intl = setup({ resolveModel: () => 'openrouter/openai/gpt-5.6-luna', routeAllowed: () => true });
    expect((await intl.service.scoreJob('u1', 'job1')).kind).toBe('ai');
  });

  it('a counter outage never becomes unmetered model spend', async () => {
    const { service, scorer } = setup({ consume: vi.fn(async () => Promise.reject(new Error('db down'))) });
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'budget' });
    expect(scorer.run).not.toHaveBeenCalled();
  });

  it('no resume, no model configured, or a failed model call → Quick estimate with its reason', async () => {
    const noResume = setup({ repo: createMemoryRepo({ resumes: [] }) });
    expect(await noResume.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'no_resume', resumeVariantId: null });

    const noModel = setup({ resolveModel: () => null });
    expect(await noModel.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_unavailable' });

    const failing = { run: vi.fn(async () => Promise.reject(new Error('timeout'))) };
    const fail = setup({ scorer: failing });
    expect(await fail.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    expect(fail.repo.state.scores).toHaveLength(0);
    expect(fail.costLog).not.toHaveBeenCalled();
    await expect(fail.service.scoreJob('u1', 'job1', { onAiFailure: 'throw' })).rejects.toThrow(/fit scorer failed/);
  });

  it('GoApply without AI consent: zero LLMService calls, the Quick estimate', async () => {
    const realAgent = new RAJobMatchScorerV3Agent();
    const goapplyJob = jobRecord({ market: 'cn' });
    const { service, repo } = setup({
      repo: createMemoryRepo({ jobs: [goapplyJob] }),
      scorer: { run: (input, o) => realAgent.run(input, o) },
      aiAllowed: async () => false,
      brand: () => getBrand('goapply'),
    });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit).toMatchObject({ kind: 'pre', estimateReason: 'ai_off' });
    const analysis = await service.fitAnalysis('u1', 'job1', 'idem-key-1');
    expect(analysis).toMatchObject({ kind: 'pre', charged: false, aiWritten: false, summary: null });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);
  });

  it('the real v3 agent path: LLMService is called once and the server sums the parsed components', async () => {
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...scorerOutput(), total: 99, score: 99 }));
    const realAgent = new RAJobMatchScorerV3Agent();
    const { service } = setup({ scorer: { run: (input, o) => realAgent.run(input, o) } });
    const fit = await service.scoreJob('u1', 'job1');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(fit.kind).toBe('ai');
    expect(fit.score).not.toBe(99);
  });

  it('answers 404 for a job of the other market or someone else’s import, and for another user’s resume', async () => {
    const repo = createMemoryRepo({
      jobs: [jobRecord({ id: 'cn1', market: 'cn' }), jobRecord({ id: 'priv', visibility: 'private', ownerUserId: 'u2' }), jobRecord({ id: 'mine', visibility: 'private', ownerUserId: 'u1' })],
    });
    const { service } = setup({ repo });
    await expect(service.scoreJob('u1', 'cn1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.scoreJob('u1', 'priv')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.scoreJob('u1', 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.scoreJob('u1', 'mine', { resumeVariantId: 'not-mine' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'resume_variant_not_found' } });
    expect((await service.scoreJob('u1', 'mine')).kind).toBe('ai');
  });

  it('GoApply, recruitment-info mode off: a third-party posting is a 404 on every reader; the user’s own import still works [R41-1b]', async () => {
    const jobs = [
      jobRecord({ id: 'gohire', market: 'cn' }),
      jobRecord({ id: 'mine', market: 'cn', visibility: 'private', ownerUserId: 'u1' }),
    ];
    const off = setup({ repo: createMemoryRepo({ jobs }), brand: () => getBrand('goapply'), env: { CN_RECRUITMENT_INFO_MODE: 'off' } });
    for (const call of [
      () => off.service.scoreJob('u1', 'gohire'),
      () => off.service.fitAnalysis('u1', 'gohire', 'idem-key-0001'),
      () => off.service.keywordCheck('u1', 'gohire'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(off.scorer.run).not.toHaveBeenCalled();
    expect(await off.service.preScoreMany('u1', ['gohire', 'mine'])).toMatchObject([{ jobId: 'mine' }]);
    expect((await off.service.keywordCheck('u1', 'mine')).jobId).toBe('mine');
    expect((await off.service.scoreJob('u1', 'mine')).jobId).toBe('mine');

    // Control: once the mode allows postings the same posting is readable.
    const on = setup({ repo: createMemoryRepo({ jobs }), brand: () => getBrand('goapply'), env: { CN_RECRUITMENT_INFO_MODE: 'licensed' } });
    expect((await on.service.keywordCheck('u1', 'gohire')).jobId).toBe('gohire');
    expect((await on.service.preScoreMany('u1', ['gohire', 'mine'])).map((p) => p.jobId)).toEqual(['gohire', 'mine']);

    // Default (nothing set): postings are readable too (D5: the feed is on unless the switch says off).
    const byDefault = setup({ repo: createMemoryRepo({ jobs }), brand: () => getBrand('goapply'), env: {} });
    expect((await byDefault.service.keywordCheck('u1', 'gohire')).jobId).toBe('gohire');
    expect((await byDefault.service.preScoreMany('u1', ['gohire', 'mine'])).map((p) => p.jobId)).toEqual(['gohire', 'mine']);
  });

  it('visibleTo gives the same answer as cn/jobs cnPostingVisible in every mode (one rule, two readers)', () => {
    const jobs = [
      { market: 'cn', visibility: 'public', ownerUserId: null },
      { market: 'cn', visibility: 'private', ownerUserId: 'u1' },
      { market: 'cn', visibility: 'private', ownerUserId: 'u2' },
      { market: 'cn', visibility: 'public', ownerUserId: 'u1' },
      { market: 'intl', visibility: 'public', ownerUserId: null },
      { market: 'intl', visibility: 'private', ownerUserId: 'u1' },
      { market: 'intl', visibility: 'private', ownerUserId: 'u2' },
    ];
    for (const mode of [undefined, 'off', 'partner_deeplink', 'licensed', 'nonsense']) {
      const env = mode ? { CN_RECRUITMENT_INFO_MODE: mode } : {};
      for (const job of jobs) {
        const basic = job.visibility === 'public' || job.ownerUserId === 'u1';
        expect(visibleTo(job, 'u1', job.market, env), `${mode} ${JSON.stringify(job)}`).toBe(basic && cnPostingVisible(job, 'u1', env));
      }
    }
    // Another brand's market is never visible, whatever the mode.
    expect(visibleTo(jobs[0]!, 'u1', 'intl', { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(false);
  });

  it('a score for the job a resume version was tailored for is stored as a fit only: no copy is written to the version (matchScoreCached)', async () => {
    // The writer is put on the repository here: neither repository has one any more (M4 gate), and the service calls none.
    const cached = vi.fn(async () => undefined);
    const repo = Object.assign(createMemoryRepo({ resumes: [{ ...resumeRecord({ targetJobId: 'job1' }), userId: 'u1' }] }), { updateVariantCachedScore: cached });
    const { service } = setup({ repo });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit.kind).toBe('ai');
    expect(repo.state.scores).toHaveLength(1);
    expect(cached).not.toHaveBeenCalled();
  });

  it('a rewrite the daily cap stops says so on the view (rewriteBlocked), and the stored fit is answered as it was', async () => {
    let capped = false;
    const consume = vi.fn(async ({ key }: { key: string }) => (capped && key.includes(':score:user:') ? { ...allow(0), allowed: false } : allow()));
    const a = setup({ consume });
    const first = await a.service.scoreJob('u1', 'job1', { locale: 'en' });
    expect(first.rewriteBlocked).toBeUndefined();
    capped = true;
    const blocked = await a.service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(blocked).toMatchObject({ kind: 'ai', score: first.score, summaryLocaleStale: true, rewriteBlocked: 'daily_cap' });
    // A plain read in the other language asked for no rewrite: nothing is blocked.
    expect((await a.service.scoreJob('u1', 'job1', { locale: 'zh' })).rewriteBlocked).toBeUndefined();
    // No model this brand may call, and a failed call, say so too.
    const noModel = setup({ repo: a.repo, resolveModel: () => null });
    expect((await noModel.service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true })).rewriteBlocked).toBe('ai_unavailable');
    const failing = setup({ repo: a.repo, scorer: { run: vi.fn(async () => Promise.reject(new Error('upstream 502'))) } });
    expect((await failing.service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true })).rewriteBlocked).toBe('ai_failed');
    // A re-score that could not run is not a rewrite: the stale fit answers with no such flag.
    const other = setup({ repo: a.repo, resolveModel: () => 'test/model-b', consume: vi.fn(async () => ({ ...allow(0), allowed: false })) });
    const stale = await other.service.scoreJob('u1', 'job1', { locale: 'en' });
    expect(stale).toMatchObject({ kind: 'ai', stale: true });
    expect(stale.rewriteBlocked).toBeUndefined();
  });
});

describe('one implementation behind every reader', () => {
  it('scoreJob is getFit as a view, preScoreMany is getFits as a list: the same score, tier and kind', async () => {
    const repo = createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2', skills: [], skillsDetail: null })] });
    const { service, scorer } = setup({ repo });
    await service.scoreJob('u1', 'job1');
    scorer.run.mockClear();
    const fits = await service.fits.getFits('u1', ['job1', 'job2']);
    const list = await service.preScoreMany('u1', ['job1', 'job2']);
    for (const [i, id] of ['job1', 'job2'].entries()) {
      const fit = fits.get(id)!;
      const view = await service.scoreJob('u1', id, { mode: 'cache_only' });
      const one = await service.fits.getFit('u1', id);
      const wire = fit.kind === 'ai' ? 'ai' : 'pre';
      expect([view.score, view.tier, view.kind], id).toEqual([fit.score, fit.tier, wire]);
      expect([list[i]!.score, list[i]!.tier, list[i]!.kind], id).toEqual([fit.score, fit.tier, wire]);
      expect([one.score, one.tier, one.kind], id).toEqual([fit.score, fit.tier, fit.kind]);
      expect(view).toMatchObject({ coverage: fit.coverage, confidence: fit.confidence, confidenceReason: fit.confidenceReason, requirements: [] });
    }
    expect(fits.get('job1')!.kind).toBe('ai');
    expect(fits.get('job2')).toMatchObject({ kind: 'estimate', confidence: 'medium' });
    expect(scorer.run).not.toHaveBeenCalled();
  });

  it('the scorer is told the facts of location and pay (met / stated) and the saved search as the stated target, never as the fit', async () => {
    const { service, scorer } = setup();
    await service.scoreJob('u1', 'job1');
    const input = scorer.run.mock.calls[0]![0] as { logistics: { score: number | null }; targets: { titles: string[]; seniority: string[] } };
    // Both checks are met through the person's own filters: the estimate counts that part at its prior, the AI score at 100.
    expect(input.logistics.score).toBe(100);
    expect(input.targets).toEqual({ titles: [], seniority: ['senior'] });
  });
});

describe('preScoreMany', () => {
  it('pre-scores visible jobs only, with no model call and no counters', async () => {
    const repo = createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2', market: 'cn' }), jobRecord({ id: 'job3', skills: [], skillsDetail: null })] });
    const { service, scorer, consume } = setup({ repo });
    const out = await service.preScoreMany('u1', ['job1', 'job2', 'job3', 'missing']);
    expect(out.map((p) => p.jobId)).toEqual(['job1', 'job3']);
    expect(out.every((p) => p.kind === 'pre')).toBe(true);
    expect(scorer.run).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(await service.preScoreMany('u1', [])).toEqual([]);
  });

  it('FIX-3: a job the user has an AI score for carries THAT score in every list (Similar jobs and alerts used to show the quick estimate)', async () => {
    const repo = createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2' })] });
    const { service, scorer } = setup({ repo });
    // The job page scored job1 with the model; job2 has no AI score.
    const detail = await service.scoreJob('u1', 'job1', { locale: 'en' });
    expect(detail.kind).toBe('ai');
    scorer.run.mockClear();

    const list = await service.preScoreMany('u1', ['job1', 'job2']);
    const estimate = (await service.preScoreJobs('u1', [jobRecord()]))[0]!;
    expect(estimate.kind).toBe('pre');
    expect(estimate.score).not.toBe(detail.score); // the two numbers differ: showing both is the bug
    expect(list[0]).toMatchObject({ jobId: 'job1', kind: 'ai', score: detail.score, tier: detail.tier });
    expect(list[0]!.dimensions.find((d) => d.key === 'skills')!.score).toBe(60); // the AI components, not the estimate's
    expect(list[1]).toMatchObject({ jobId: 'job2', kind: 'pre', score: estimate.score });
    expect(scorer.run).not.toHaveBeenCalled(); // never a model call for a list
  });

  it('FIX-3: an AI score for an older resume or prompt is not shown (the same rule as the feed card)', async () => {
    const repo = createMemoryRepo({ jobs: [jobRecord()] });
    const { service } = setup({ repo });
    await service.scoreJob('u1', 'job1');
    repo.state.resumes[0]!.resumeContentHash = 'hash-2'; // the resume changed
    expect((await service.preScoreMany('u1', ['job1']))[0]!.kind).toBe('pre');
    repo.state.resumes[0]!.resumeContentHash = 'hash-1';
    repo.state.scores[0]!.promptVersion = 'old-prompt';
    expect((await service.preScoreMany('u1', ['job1']))[0]!.kind).toBe('pre');
  });

  it('FIX-3: the list still answers the quick estimate when the stored scores cannot be read', async () => {
    const repo = createMemoryRepo({ jobs: [jobRecord()] });
    repo.listAiScores = async () => {
      throw new Error('db down');
    };
    const { service } = setup({ repo });
    expect((await service.preScoreMany('u1', ['job1']))[0]).toMatchObject({ jobId: 'job1', kind: 'pre' });
  });
});

describe('fitAnalysis', () => {
  it('spends a fit_analysis credit only when a model call is needed', async () => {
    const { service, withCredit, scorer } = setup();
    const card = await service.fitAnalysis('u1', 'job1', 'idem-key-1', { locale: 'en' });
    expect(withCredit).toHaveBeenCalledTimes(1);
    expect((withCredit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ userId: 'u1', bucket: 'fit_analysis', idempotencyKey: 'idem-key-1', refId: 'job1' });
    expect(card).toMatchObject({
      kind: 'ai',
      charged: true,
      aiWritten: true,
      highlights: ['Your payments APIs in Go'],
      gaps: ['No Kubernetes work shown'],
      skills: { aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'] },
      education: { required: null, yours: 'BSc Computer Science', meets: null },
    });
    // Now cached: the card is rebuilt for free.
    const again = await service.fitAnalysis('u1', 'job1', 'idem-key-2');
    expect(again.charged).toBe(false);
    expect(withCredit).toHaveBeenCalledTimes(1);
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });

  it('the paid path skips the platform caps', async () => {
    const consume = vi.fn(async () => ({ ...allow(0), allowed: false }));
    const ok = setup({ consume });
    expect((await ok.service.fitAnalysis('u1', 'job1', 'idem-key-1')).charged).toBe(true);
  });

  it('a failed model call answers 503 and the real CreditService releases the reservation (usage unchanged)', async () => {
    const kit = createCreditTestKit();
    const failing = setup({
      scorer: { run: vi.fn(async () => Promise.reject(new Error('boom'))) },
      withCredit: (opts, fn) => kit.credits.withCredit(opts, () => fn()),
    });
    const before = (await kit.credits.usage('u1', { brand: 'roboapply' })).find((u) => u.bucket === 'fit_analysis')!;
    await expect(failing.service.fitAnalysis('u1', 'job1', 'idem-key-1')).rejects.toMatchObject({ code: 'ai_unavailable' });
    const rows = kit.store.ledger.filter((r) => r.bucket === 'fit_analysis');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'released', userId: 'u1', refId: 'job1' });
    const after = (await kit.credits.usage('u1', { brand: 'roboapply' })).find((u) => u.bucket === 'fit_analysis')!;
    expect(after).toMatchObject({ used: before.used, reserved: 0, remaining: before.remaining });
    expect(kit.deductionLogs).toHaveLength(0);

    // And a successful call commits exactly one unit.
    const okKit = createCreditTestKit();
    const ok = setup({ withCredit: (opts, fn) => okKit.credits.withCredit(opts, () => fn()) });
    expect((await ok.service.fitAnalysis('u1', 'job1', 'idem-key-2')).charged).toBe(true);
    expect(okKit.store.ledger.filter((r) => r.bucket === 'fit_analysis').map((r) => r.status)).toEqual(['committed']);
  });

  it('without a resume the card is the free quick estimate', async () => {
    const { service, withCredit } = setup({ repo: createMemoryRepo({ resumes: [] }) });
    expect(await service.fitAnalysis('u1', 'job1', 'idem-key-1')).toMatchObject({ kind: 'pre', charged: false, estimateReason: 'no_resume' });
    expect(withCredit).not.toHaveBeenCalled();
  });
});

describe('keywordCheck', () => {
  it('builds rows from the job, the resume and the extracted keywords', async () => {
    const repo = createMemoryRepo({ keywords: { job1: [{ keyword: 'PostgreSQL', importance: 'high' }] } });
    const { service } = setup({ repo });
    const res = await service.keywordCheck('u1', 'job1');
    expect(res.resumeVariantId).toBe('v1');
    expect(res.rows.map((r) => r.key)).toEqual(['title', 'years', 'education', 'skills', 'keywords']);
    expect(res.rows[4]).toMatchObject({ found: 1, total: 1, status: 'met' });
  });
});

// ── Scorer v4 (MKT-4G; MARKET_STRATEGY 2.1 point 5, 2.2 I5 and I7): the default ──────────────────────────────────

/** Requirement lines of the test kit's posting (verbatim) and what the test kit's resume shows of them. */
const YEARS: ScorerV4RequirementAnswer = { id: 'a', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' };
const K8S: ScorerV4RequirementAnswer = { id: 'b', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' };

function checklist(over: Partial<RAJobMatchScorerV4Output> = {}): RAJobMatchScorerV4Output {
  return {
    requirements: [YEARS, K8S],
    level: { post: 'senior', resume: 'senior', direction: 'match' },
    domain: { status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
    trajectory: { status: 'toward', evidence: '' },
    strengths: ['Your payments APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    summary: 'Your payments work lines up well, though the post centres on Kubernetes.',
    ...over,
  };
}

/** An in-memory `saveJobRequirements` with the production rule: the first writer wins for a text of the posting; a list of another text is replaced. */
function withRequirementStore(repo: ReturnType<typeof createMemoryRepo>) {
  const saveJobRequirements = vi.fn(async (jobId: string, doc: StoredRequirementsDoc): Promise<boolean> => {
    const job = repo.state.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    const had = job.requirements as { contentHash?: unknown } | null | undefined;
    if (had && had.contentHash === doc.contentHash) return false;
    job.requirements = doc;
    return true;
  });
  return Object.assign(repo, { saveJobRequirements });
}

/**
 * The key a stored requirement list of the test kit's posting carries: the posting's title and requirement text,
 * never its skills (M4 gate; the same value enrichment v3 writes, jobs/enrich `requirementsHashRow`).
 */
const KIT_HASH = requirementListHash(jobRecord());

/** A service with BOTH scorers and nothing configured: the default pin decides which one runs. */
function setupV4(over: Partial<MatchServiceDeps> & { repo?: ReturnType<typeof createMemoryRepo>; answer?: () => RAJobMatchScorerV4Output } = {}) {
  const { answer, ...deps } = over;
  const repo = deps.repo ?? withRequirementStore(createMemoryRepo());
  const scorer = { run: vi.fn(async () => scorerOutput()) } satisfies ScorerLike;
  const scorerV4 = { run: vi.fn(async (_input: RAJobMatchScorerV4Input) => (answer ? answer() : checklist())) } satisfies ScorerV4Like;
  const consume = vi.fn(async () => allow());
  const costLog = vi.fn(async () => undefined);
  const withCredit = vi.fn(async (_o: unknown, fn: () => Promise<unknown>) => fn()) as unknown as NonNullable<MatchServiceDeps['withCredit']>;
  const service = createMatchService({
    repo,
    scorer,
    scorerV4,
    resolveModel: () => MODEL,
    routeAllowed: () => true,
    aiAllowed: async () => true,
    consume,
    withCredit,
    costLog,
    profileSnapshot: async () => null,
    brand: () => getBrand('roboapply'),
    env: {},
    now: () => new Date('2026-10-10T08:00:00Z'),
    ...deps,
  });
  return { service, repo, scorer, scorerV4, consume, costLog, withCredit };
}

/** A calibration map that puts every estimate at one value on the AI scale: the estimate the borderline rule reads. */
const estimateAt = (value: number): MatchServiceDeps['calibration'] => async () => ({ map: { knots: [[0, value], [100, value]] }, priors: null });

describe('scoreJob — scorer v4 (the default)', () => {
  it('with nothing configured a new score is the checklist\'s: every number computed on the server, stored as fit_v4', async () => {
    const { service, repo, scorer, scorerV4, costLog } = setupV4();
    const fit = await service.scoreJob('u1', 'job1', { locale: 'en' });
    expect(scorerV4.run).toHaveBeenCalledTimes(1);
    expect(scorer.run).not.toHaveBeenCalled();
    expect(fit.kind).toBe('ai');
    const dim = (key: string) => fit.dimensions.find((d) => d.key === key)!;
    // One required line met and one not shown: 100 × 1 / 2 = 50. Same level: 100. Adjacent domain: 60. Toward: 100.
    expect([dim('title_level').score, dim('skills').score, dim('industry').score, dim('logistics').score, dim('career_path').score]).toEqual([100, 50, 60, 100, 100]);
    // (35 × 100 + 30 × 50 + 15 × 60 + 10 × 100 + 10 × 100) / 100 = 79
    expect(fit.score).toBe(79);
    const saved = repo.state.scores[0]!;
    expect(saved).toMatchObject({ score: 79, promptVersion: 'scorer_v4', rubricVersion: 'fit_v4', modelUsed: MODEL, scoreKind: 'ai', locale: 'en', searchProfileVersion: 1, jobContentHash: currentJobHash(jobRecord()) });
    const exp = saved.explanation as Record<string, unknown>;
    expect(Object.keys(exp).sort()).toEqual(['domain', 'estimateAtScore', 'gaps', 'level', 'promptVersion', 'rationale', 'requirements', 'responseLanguage', 'strengths', 'tierRule', 'trajectory']);
    expect(exp).toMatchObject({
      strengths: ['Your payments APIs in Go'],
      gaps: ['No Kubernetes work shown'],
      rationale: 'Your payments work lines up well, though the post centres on Kubernetes.',
      level: { post: 'senior', resume: 'senior', direction: 'match' },
      domain: { status: 'adjacent', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
      trajectory: { status: 'toward', evidence: '' },
      responseLanguage: 'en',
      promptVersion: 'scorer_v4',
    });
    expect(exp.requirements).toEqual([
      { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
      { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
    ]);
    expect((exp.estimateAtScore as { score: number }).score).toBe((await setupV4({ aiAllowed: async () => false }).service.scoreJob('u1', 'job1')).score);
    // The view carries the checklist; the model-picked keyword lists of v3 are gone (the checklist replaces them).
    expect(fit.requirements).toEqual(exp.requirements);
    expect(fit).toMatchObject({ summary: 'Your payments work lines up well, though the post centres on Kubernetes.', keywordsMatched: [], keywordsMissing: [] });
    expect(costLog).toHaveBeenCalledWith(expect.objectContaining({ reason: 'first_score', jobId: 'job1', prompt: 'scorer_v4' }));
  });

  it('on both brands: GoApply writes fit_v4 too, and CN_MATCH_SCORER_RUBRIC switches GoApply alone', async () => {
    const cn = () => withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }));
    const go = setupV4({ repo: cn(), brand: () => getBrand('goapply') });
    expect((await go.service.scoreJob('u1', 'job1')).kind).toBe('ai');
    expect(go.repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v4', rubricVersion: 'fit_v4' });

    const env = { CN_MATCH_SCORER_RUBRIC: 'fit_v3' };
    const goV3 = setupV4({ repo: cn(), brand: () => getBrand('goapply'), env });
    await goV3.service.scoreJob('u1', 'job1');
    expect(goV3.repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' });
    expect(goV3.scorerV4.run).not.toHaveBeenCalled();
    const robo = setupV4({ env });
    await robo.service.scoreJob('u1', 'job1');
    expect(robo.repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v4', rubricVersion: 'fit_v4' });
  });

  it('MATCH_SCORER_RUBRIC=fit_v3 writes v3 rows again with no deploy; the v4 fits already stored stay visible and are replaced one by one', async () => {
    const repo = withRequirementStore(createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2' })] }));
    const v4 = setupV4({ repo });
    const first = await v4.service.scoreJob('u1', 'job1');
    expect(repo.state.scores[0]).toMatchObject({ rubricVersion: 'fit_v4' });

    // The rollback: the same deployment, one variable.
    const back = setupV4({ repo, env: { MATCH_SCORER_RUBRIC: 'fit_v3' } });
    // The stored v4 fit keeps serving on every read that makes no call, flagged stale; nothing drops to an estimate.
    expect(await back.service.scoreJob('u1', 'job1', { mode: 'cache_only' })).toMatchObject({ kind: 'ai', score: first.score, tier: first.tier, stale: true, cached: true });
    expect((await back.service.fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', score: first.score, stale: true });
    expect(back.scorer.run).not.toHaveBeenCalled();
    // A new score is a v3 row; the planned re-score of the old one writes v3 over it and says why.
    await back.service.scoreJob('u1', 'job2');
    expect(repo.state.scores.find((r) => r.jobId === 'job2')).toMatchObject({ promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' });
    await back.service.scoreJob('u1', 'job1', { mode: 'precompute' });
    expect(repo.state.scores.find((r) => r.jobId === 'job1')).toMatchObject({ promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' });
    expect(back.costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'prompt_changed', prompt: 'scorer_v3' }));
    expect(back.scorerV4.run).not.toHaveBeenCalled();

    // And forward again: a v3 row under the v4 pin is stale, serves, and its re-score is a checklist.
    const forward = setupV4({ repo });
    expect(await forward.service.scoreJob('u1', 'job2', { mode: 'cache_only' })).toMatchObject({ kind: 'ai', stale: true, requirements: [] });
    const rescored = await forward.service.scoreJob('u1', 'job2', { mode: 'precompute' });
    expect(rescored).toMatchObject({ kind: 'ai', stale: false, cached: false });
    expect(rescored.requirements).toHaveLength(2);
    // Anything that is not a known rubric keeps the default: a typo never switches the scorer.
    const typo = setupV4({ env: { MATCH_SCORER_RUBRIC: 'fit_v5' } });
    await typo.service.scoreJob('u1', 'job1');
    expect(typo.repo.state.scores[0]).toMatchObject({ rubricVersion: 'fit_v4' });
  });

  it('after a model change the existing fits stay visible and are re-scored gradually', async () => {
    const repo = withRequirementStore(createMemoryRepo());
    const first = await setupV4({ repo }).service.scoreJob('u1', 'job1');
    // The posting has its stored lines by now (the first score wrote them): the new model fills in those ids.
    const next = setupV4({ repo, resolveModel: () => 'test/model-b', answer: () => checklist({ requirements: [{ ...YEARS, id: 'r1' }, { ...K8S, id: 'r2', status: 'partly', evidence: 'TypeScript, Go, PostgreSQL' }] }) });
    expect(await next.service.scoreJob('u1', 'job1', { mode: 'cache_only' })).toMatchObject({ kind: 'ai', score: first.score, stale: true });
    expect((await next.service.preScoreMany('u1', ['job1']))[0]).toMatchObject({ kind: 'ai', score: first.score });
    expect(next.scorerV4.run).not.toHaveBeenCalled();
    const rescored = await next.service.scoreJob('u1', 'job1', { mode: 'precompute' });
    expect(rescored).toMatchObject({ kind: 'ai', stale: false });
    expect(rescored.requirements!.map((r) => [r.id, r.status])).toEqual([['r1', 'met'], ['r2', 'partly']]);
    expect(repo.state.scores).toHaveLength(1);
    expect(repo.state.scores[0]).toMatchObject({ modelUsed: 'test/model-b', rubricVersion: 'fit_v4' });
    expect(next.costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'model_changed' }));
  });

  it('a service that was handed one scorer writes what that scorer speaks and never reaches for a real agent', async () => {
    // Only a v3 fake, nothing configured (the default is fit_v4): v3 rows, and no LLMService call.
    const repo = createMemoryRepo();
    const scorer = { run: vi.fn(async () => scorerOutput()) };
    const v3only = createMatchService({ repo, scorer, resolveModel: () => MODEL, routeAllowed: () => true, aiAllowed: async () => true, consume: async () => allow(), costLog: async () => undefined, profileSnapshot: async () => null, brand: () => getBrand('roboapply'), env: {} });
    expect((await v3only.scoreJob('u1', 'job1')).kind).toBe('ai');
    expect(repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' });
    // Its own rows are current under its own pin.
    expect(await v3only.scoreJob('u1', 'job1')).toMatchObject({ cached: true, stale: false });
    // Only a v4 fake, with the rollback switch set: v4 rows.
    const repo4 = createMemoryRepo();
    const scorerV4 = { run: vi.fn(async () => checklist()) };
    const v4only = createMatchService({ repo: repo4, scorerV4, resolveModel: () => MODEL, routeAllowed: () => true, aiAllowed: async () => true, consume: async () => allow(), costLog: async () => undefined, profileSnapshot: async () => null, brand: () => getBrand('roboapply'), env: { MATCH_SCORER_RUBRIC: 'fit_v3' } });
    expect((await v4only.scoreJob('u1', 'job1')).kind).toBe('ai');
    expect(repo4.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v4', rubricVersion: 'fit_v4' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('the model is given the stripped resume first, the job, the stored lines or none, and the logistics facts; never the saved search', async () => {
    const { service, scorerV4 } = setupV4();
    await service.scoreJob('u1', 'job1', { locale: 'zh' });
    const [input, options] = scorerV4.run.mock.calls[0]! as unknown as [RAJobMatchScorerV4Input, { locale: string; model: string }];
    expect(options).toEqual({ locale: 'zh', model: MODEL });
    expect(input.resumeMarkdown).not.toMatch(/Ada|Lovelace|ada@example\.com|2345 6789/);
    expect(input.resumeMarkdown).toContain('Built payment APIs');
    expect(input.requirements).toBeNull();
    expect(input.job).toMatchObject({ title: 'Backend Engineer', companyName: 'Acme', seniority: 'senior', minYears: 5 });
    expect(input.logistics).toEqual({ lines: ['Location: fits what the candidate asked for', 'Pay: fits what the candidate asked for'] });
    expect(input).not.toHaveProperty('targets');
  });

  it('a "met" with an invented quote is stored as "not shown" and lowers the score; a line that is not in the posting is not stored at all, and neither is the thinned list', async () => {
    const honest = await setupV4().service.scoreJob('u1', 'job1');
    const padded = setupV4({
      answer: () =>
        checklist({
          requirements: [
            { ...YEARS, evidence: 'Led a platform team of 40 engineers.' },
            K8S,
            { id: 'z', kind: 'skill', text: '10 years of COBOL', importance: 'must', status: 'met', evidence: 'TypeScript, Go, PostgreSQL' },
          ],
        }),
    });
    const fit = await padded.service.scoreJob('u1', 'job1');
    expect(fit.requirements!.map((r) => [r.text, r.status, r.evidence])).toEqual([
      ['5+ years of backend experience', 'not_shown', ''],
      ['Kubernetes required', 'not_shown', ''],
    ]);
    expect(fit.dimensions.find((d) => d.key === 'skills')!.score).toBe(0);
    expect(fit.score!).toBeLessThan(honest.score!);
    expect(JSON.stringify(padded.repo.state.scores[0])).not.toContain('COBOL');
    // One copied line of three was not the posting's: the score stands for this person, and the remaining two lines
    // are NOT written to the job as its checklist (the next score copies the lines again).
    expect(padded.repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(padded.repo.state.jobs[0]!.requirements ?? null).toBeNull();
  });

  // The review's probes, through the service: the same judgments, with the lines the resume does not show reworded.
  const OWNS: ScorerV4RequirementAnswer = { id: 'c', kind: 'experience', text: 'You will own our payments service', importance: 'must', status: 'not_shown', evidence: '' };
  const K8S_REWORDED: ScorerV4RequirementAnswer = { ...K8S, text: 'Kubernetes experience is required' };
  const OWNS_REWORDED: ScorerV4RequirementAnswer = { ...OWNS, text: 'Own the payments service' };

  it('requirement lines the model did not copy verbatim never raise the score: the answer is refused, the estimate answers and nothing is stored', async () => {
    // Verbatim: one required line met, two not shown: skills 100 × 1 / 3 = 33.
    const verbatim = setupV4({ answer: () => checklist({ requirements: [YEARS, K8S, OWNS] }) });
    const honest = await verbatim.service.scoreJob('u1', 'job1');
    expect(honest).toMatchObject({ kind: 'ai', score: 74, tier: 'good' });
    expect(honest.dimensions.find((d) => d.key === 'skills')!.score).toBe(33);
    expect((verbatim.repo.state.jobs[0]!.requirements as StoredRequirementsDoc).items).toHaveLength(3);

    // The two "not shown" lines reworded. Dropping them would read skills 100 and 94 / Great, and would leave the
    // one surviving line as the posting's checklist for everyone after.
    const reworded = setupV4({ answer: () => checklist({ requirements: [YEARS, K8S_REWORDED, OWNS_REWORDED] }) });
    const fit = await reworded.service.scoreJob('u1', 'job1');
    expect(fit).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed', requirements: [] });
    expect(reworded.repo.state.scores).toHaveLength(0);
    expect(reworded.repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(reworded.repo.state.jobs[0]!.requirements ?? null).toBeNull();
    expect(reworded.costLog).not.toHaveBeenCalled();

    // Both lines not shown, both reworded: no line would be left and the total would renormalize to 91 / Great.
    const both = setupV4({ answer: () => checklist({ requirements: [K8S, OWNS] }) });
    expect(await both.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 64, tier: 'possible' });
    const bothReworded = setupV4({ answer: () => checklist({ requirements: [K8S_REWORDED, OWNS_REWORDED] }) });
    expect(await bothReworded.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    expect(bothReworded.repo.state.scores).toHaveLength(0);
    expect(bothReworded.repo.saveJobRequirements).not.toHaveBeenCalled();
  });

  it('one reworded line in three is tolerated for this score; the thinned list is never stored, so the next person is judged on a full copy', async () => {
    const repo = withRequirementStore(createMemoryRepo());
    const first = setupV4({ repo, answer: () => checklist({ requirements: [YEARS, K8S, OWNS_REWORDED] }) });
    const mine = await first.service.scoreJob('u1', 'job1');
    expect(mine.kind).toBe('ai');
    expect(mine.requirements!.map((r) => r.text)).toEqual(['5+ years of backend experience', 'Kubernetes required']);
    expect(repo.saveJobRequirements).not.toHaveBeenCalled();
    // The next score of the posting is not handed a list: its model copies the lines itself, and a clean copy is stored.
    repo.state.resumes.push({ ...resumeRecord({ id: 'v2', resumeContentHash: 'hash-u2' }), userId: 'u2' });
    repo.state.users.u2 = defaultUserInputs();
    const second = setupV4({ repo, answer: () => checklist({ requirements: [YEARS, K8S, OWNS] }) });
    await second.service.scoreJob('u2', 'job1');
    expect((second.scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toBeNull();
    expect((repo.state.jobs[0]!.requirements as StoredRequirementsDoc).items.map((r) => r.text)).toEqual(['5+ years of backend experience', 'Kubernetes required', 'You will own our payments service']);
  });

  it('nothing the model returns can set a component or the total: a score it adds anyway changes nothing', async () => {
    const plain = await setupV4().service.scoreJob('u1', 'job1');
    const loud = setupV4({ answer: () => ({ ...checklist(), score: 100, total: 100, dimensions: { skills: { score: 100 } } }) as unknown as RAJobMatchScorerV4Output });
    const fit = await loud.service.scoreJob('u1', 'job1');
    expect(fit.score).toBe(plain.score);
    expect(fit.dimensions).toEqual(plain.dimensions);
    expect(loud.repo.state.scores[0]!.explanation).not.toHaveProperty('score');
    expect(loud.repo.state.scores[0]!.explanation).not.toHaveProperty('total');
  });

  it('the real v4 agent path: LLMService is called once, the number in the answer is ignored and the server computes the score', async () => {
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...checklist(), score: 12, total: 12 }));
    const realAgent = new RAJobMatchScorerV4Agent();
    const { service, repo } = setupV4({ scorerV4: { run: (input, o) => realAgent.run(input, o) } });
    const fit = await service.scoreJob('u1', 'job1');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(fit).toMatchObject({ kind: 'ai', score: 79 });
    expect(repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v4' });
    // Temperature 0 and the 2,400-token cap reach the call; the user message starts with the resume.
    const [messages, options] = llm.chat.mock.calls[0]! as [Array<{ role: string; content: string }>, { temperature: number; maxTokens: number }];
    expect(options).toMatchObject({ temperature: 0, maxTokens: 2400 });
    expect(messages[1]!.content.startsWith('## Candidate resume\n')).toBe(true);
  });

  it('a parser error or a checklist that cannot be used answers the estimate and stores nothing', async () => {
    // The model's answer does not parse (the real agent throws on it).
    llm.chat.mockResolvedValue(JSON.stringify({ ...checklist(), level: undefined }));
    const realAgent = new RAJobMatchScorerV4Agent();
    const broken = setupV4({ scorerV4: { run: (input, o) => realAgent.run(input, o) } });
    expect(await broken.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed', requirements: [] });
    expect(broken.repo.state.scores).toHaveLength(0);
    expect(broken.repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(broken.costLog).not.toHaveBeenCalled();
    await expect(broken.service.scoreJob('u1', 'job1', { onAiFailure: 'throw' })).rejects.toThrow(/fit scorer failed/);
    llm.chat.mockReset();

    // The posting has a stored list and the answer leaves one of its lines out.
    const stored: StoredRequirementsDoc = { v: 1, contentHash: KIT_HASH, model: 'enrich/model', extractedAt: '2026-10-09T00:00:00.000Z', items: [{ id: 'r1', kind: 'experience', text: YEARS.text, importance: 'must' }, { id: 'r2', kind: 'skill', text: K8S.text, importance: 'must' }] };
    const partial = setupV4({ repo: withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ requirements: stored })] })), answer: () => checklist({ requirements: [{ ...YEARS, id: 'r1' }] }) });
    expect(await partial.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    expect(partial.repo.state.scores).toHaveLength(0);
    // The model call fails outright.
    const down = setupV4({ answer: () => { throw new Error('upstream 502'); } });
    expect(await down.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    // A strip that cannot run sends nothing to a model.
    const noStrip = setupV4({ stripResume: () => { throw new Error('strip unavailable'); } });
    expect(await noStrip.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    expect(noStrip.scorerV4.run).not.toHaveBeenCalled();
  });

  it('GoApply without the AI consent: zero LLMService calls on the default pin, the Quick estimate, nothing stored (I8)', async () => {
    const realAgent = new RAJobMatchScorerV4Agent();
    const { service, repo } = setupV4({
      repo: withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] })),
      scorerV4: { run: (input, o) => realAgent.run(input, o) },
      aiAllowed: async () => false,
      brand: () => getBrand('goapply'),
    });
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_off', requirements: [] });
    expect(await service.fitAnalysis('u1', 'job1', 'idem-key-1')).toMatchObject({ kind: 'pre', charged: false, aiWritten: false });
    expect(await service.scoreJob('u1', 'job1', { mode: 'precompute' })).toMatchObject({ kind: 'pre', estimateReason: 'ai_off' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);
    expect(repo.saveJobRequirements).not.toHaveBeenCalled();
  });

  const EMPTY = () => checklist({ requirements: [], domain: { status: 'not_stated', evidence: '' }, trajectory: { status: 'no_history', evidence: '' } });

  it('an empty checklist for a posting that lists skills, states years or has a qualifications section is not an answer: the estimate, with nothing stored', async () => {
    const { service, repo, costLog } = setupV4({ answer: EMPTY });
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed', requirements: [] });
    expect(repo.state.scores).toHaveLength(0);
    expect(repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(costLog).not.toHaveBeenCalled();
    // Each of the three alone is a posting with lines to judge.
    const only = (over: Parameters<typeof jobRecord>[0]) => setupV4({ repo: withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ skills: [], skillsDetail: null, qualifications: null, minYears: null, ...over })] })), answer: EMPTY });
    for (const over of [{ skills: ['kubernetes'], skillsDetail: [{ skill: 'Kubernetes', kind: 'hard', required: true }] }, { minYears: 5 }, { qualifications: 'Kubernetes required.' }]) {
      const s = only(over);
      expect(await s.service.scoreJob('u1', 'job1'), JSON.stringify(over)).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
      expect(s.repo.state.scores).toHaveLength(0);
    }
    // A qualifications section that asks for a degree and nothing else (a campus posting): its degree line is a full copy.
    const campus = setupV4({
      repo: withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ skills: [], skillsDetail: null, minYears: null, qualifications: "Bachelor's degree in Computer Science." })] })),
      answer: () => checklist({ requirements: [{ id: 'd', kind: 'education', text: "Bachelor's degree in Computer Science", importance: 'must', status: 'not_shown', evidence: '' }] }),
    });
    const fit = await campus.service.scoreJob('u1', 'job1');
    expect(fit.kind).toBe('ai');
    expect(fit.dimensions.find((d) => d.key === 'skills')).toMatchObject({ score: null, status: 'not_stated' });
    // The required degree is not shown in the resume: title_level is halved (100 × 0.5).
    expect(fit.dimensions.find((d) => d.key === 'title_level')!.score).toBe(50);
    expect((campus.repo.state.jobs[0]!.requirements as StoredRequirementsDoc).items).toHaveLength(1);
  });

  it('I4: a result that could judge less than 60% of the rubric weight is never Great, stored or shown, and its confidence is low', async () => {
    // A posting that lists no skills, states no years and has no qualifications section: an empty checklist is a true answer for it.
    const bare = () => withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ skills: [], skillsDetail: null, qualifications: null, minYears: null })] }));
    const { service, repo } = setupV4({ repo: bare(), answer: EMPTY });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit.dimensions.filter((d) => d.status === 'not_stated').map((d) => d.key)).toEqual(['skills', 'industry', 'career_path']);
    // title_level 100 and logistics 100 over their own weights: the total is 100, as computed, over 45% of the rubric.
    expect(fit).toMatchObject({ kind: 'ai', score: 100, coverage: 0.45, tier: 'good', confidence: 'low', requirements: [] });
    expect(repo.state.scores[0]).toMatchObject({ score: 100, tier: 'good' });
    // Every later read holds it there (the 3-point rule alone would move 100 up to Great), and nothing is rewritten.
    const saves = vi.spyOn(repo, 'saveScore');
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 100, tier: 'good', confidence: 'low', cached: true });
    expect((await service.fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', score: 100, tier: 'good', confidence: 'low' });
    expect(saves).not.toHaveBeenCalled();
    // With the domain and the trajectory judged the same total is backed by 70% of the rubric and is Great.
    const backed = setupV4({ repo: bare(), answer: () => checklist({ requirements: [], domain: { status: 'direct', evidence: '' }, trajectory: { status: 'toward', evidence: '' } }) });
    expect(await backed.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 100, coverage: 0.7, tier: 'great' });
  });

  it('a failed run says what failed: an answer that was received and refused, or a call that failed', async () => {
    const thrown = async (s: ReturnType<typeof setupV4>): Promise<unknown> => s.service.scoreJob('u1', 'job1', { mode: 'precompute', onAiFailure: 'throw' }).then(() => null, (err: unknown) => err);
    // The checklist is refused (reworded lines), the answer does not parse, a stored line is left out: 'answer'.
    const refused = await thrown(setupV4({ answer: () => checklist({ requirements: [K8S_REWORDED, OWNS_REWORDED] }) }));
    expect(refused).toBeInstanceOf(ScorerFailedError);
    expect(refused).toMatchObject({ kind: 'answer', message: expect.stringMatching(/fit scorer failed: scorer v4 checklist: 2 of the 2 copied/) });
    llm.chat.mockResolvedValue('I cannot help with that.');
    const realAgent = new RAJobMatchScorerV4Agent();
    expect(await thrown(setupV4({ scorerV4: { run: (input, o) => realAgent.run(input, o) } }))).toMatchObject({ kind: 'answer', message: expect.stringMatching(/unparseable scorer response/) });
    llm.chat.mockReset();
    // The call itself failed, or the resume could not be stripped: 'call'.
    expect(await thrown(setupV4({ answer: () => { throw new Error('upstream 502'); } }))).toMatchObject({ kind: 'call' });
    llm.chat.mockRejectedValue(new Error('socket hang up'));
    expect(await thrown(setupV4({ scorerV4: { run: (input, o) => realAgent.run(input, o) } }))).toMatchObject({ kind: 'call' });
    llm.chat.mockReset();
    expect(await thrown(setupV4({ stripResume: () => { throw new Error('strip unavailable'); } }))).toMatchObject({ kind: 'call' });
    expect(new ScorerFailedError(new Error('x')).kind).toBe('call');
  });
});

describe('scorer v4 — the requirement lines belong to the posting', () => {
  const STORED: JobRequirement[] = [
    { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must' },
    { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must' },
    { id: 'r3', kind: 'skill', text: 'Build APIs in TypeScript and Go', importance: 'preferred' },
  ];
  const doc = (): StoredRequirementsDoc => ({ v: 1, contentHash: KIT_HASH, model: 'enrich/model', extractedAt: '2026-10-09T00:00:00.000Z', items: STORED });
  const filled = (): RAJobMatchScorerV4Output =>
    checklist({
      requirements: [
        // The model rewords a line and re-labels it: the store's text, kind and importance are the ones kept.
        { id: 'r1', kind: 'skill', text: 'Five years in backend', importance: 'preferred', status: 'met', evidence: 'Senior Software Engineer, PayCo (2019-01 – present)' },
        { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must', status: 'not_shown', evidence: '' },
        { id: 'r3', kind: 'skill', text: 'Build APIs in TypeScript and Go', importance: 'preferred', status: 'met', evidence: 'Built payment APIs in TypeScript and Go serving 2M users.' },
      ],
    });

  it('stored-requirements mode: the model gets the stored lines, the row carries their ids and texts, and nothing is written to the job', async () => {
    const repo = withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ requirements: doc() })] }));
    const { service, scorerV4 } = setupV4({ repo, answer: filled });
    const fit = await service.scoreJob('u1', 'job1');
    expect((scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toEqual(STORED);
    expect(fit.requirements!.map(({ id, kind, text, importance }) => ({ id, kind, text, importance }))).toEqual(STORED);
    expect(fit.requirements!.map((r) => r.status)).toEqual(['met', 'not_shown', 'met']);
    // must met 1, must not shown 0, preferred met 0.5: 100 × 1.5 / 2.5 = 60
    expect(fit.dimensions.find((d) => d.key === 'skills')!.score).toBe(60);
    expect(repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(repo.state.jobs[0]!.requirements).toEqual(doc());
  });

  it('first-writer rule: the first score of a posting with no list stores its verified lines once; the next person is judged against them', async () => {
    const repo = withRequirementStore(createMemoryRepo());
    repo.state.resumes.push({ ...resumeRecord({ id: 'v2', resumeContentHash: 'hash-u2', resumeMarkdown: '## Experience\nPlatform Engineer, Globex (2021-03 – present)\n- Ran Kubernetes clusters for 40 services.\n\n## Skills\nKubernetes, Go' }), userId: 'u2' });
    repo.state.users.u2 = defaultUserInputs();
    const first = setupV4({ repo });
    const mine = await first.service.scoreJob('u1', 'job1');
    expect(repo.saveJobRequirements).toHaveBeenCalledTimes(1);
    const written = repo.state.jobs[0]!.requirements as StoredRequirementsDoc;
    expect(written).toEqual({
      v: 1,
      contentHash: KIT_HASH,
      model: MODEL,
      extractedAt: '2026-10-10T08:00:00.000Z',
      items: [
        { id: 'r1', kind: 'experience', text: '5+ years of backend experience', importance: 'must' },
        { id: 'r2', kind: 'skill', text: 'Kubernetes required', importance: 'must' },
      ],
    });

    // The second person: the model is handed the stored lines and only fills them in.
    const second = setupV4({
      repo,
      answer: () =>
        checklist({
          requirements: [
            { id: 'r1', kind: 'experience', text: YEARS.text, importance: 'must', status: 'partly', evidence: 'Platform Engineer, Globex (2021-03 – present)' },
            { id: 'r2', kind: 'skill', text: K8S.text, importance: 'must', status: 'met', evidence: 'Ran Kubernetes clusters for 40 services.' },
          ],
        }),
    });
    const theirs = await second.service.scoreJob('u2', 'job1');
    expect((second.scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toEqual(written.items);
    const lines = (view: typeof mine) => view.requirements!.map(({ id, kind, text, importance }) => ({ id, kind, text, importance }));
    expect(lines(theirs)).toEqual(lines(mine));
    expect(theirs.requirements!.map((r) => r.status)).toEqual(['partly', 'met']);
    // 100 × (0.5 + 1) / 2 = 75
    expect(theirs.dimensions.find((d) => d.key === 'skills')!.score).toBe(75);
    // Nothing is written a second time, and the list is the first writer's.
    expect(repo.saveJobRequirements).toHaveBeenCalledTimes(1);
    expect(repo.state.jobs[0]!.requirements).toEqual(written);
  });

  it('a stored list is the posting\'s only for the text it was copied from: one of an earlier text is not used, and the next score replaces it', async () => {
    // Enrichment stored these lines for an earlier text of the posting; the posting has changed since.
    const stale: StoredRequirementsDoc = { v: 1, contentHash: 'hash-of-the-earlier-text', model: 'enrich/model', extractedAt: '2026-10-01T00:00:00.000Z', items: [{ id: 'r1', kind: 'skill', text: 'A line the posting no longer has', importance: 'must' }] };
    const repo = withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ requirements: stale })] }));
    const { service, scorerV4 } = setupV4({ repo });
    const fit = await service.scoreJob('u1', 'job1');
    // The model was not handed the outdated lines: it copied the posting's lines as they are now.
    expect((scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toBeNull();
    expect(fit.requirements!.map((r) => r.text)).toEqual(['5+ years of backend experience', 'Kubernetes required']);
    expect(repo.saveJobRequirements).toHaveBeenCalledTimes(1);
    expect(repo.state.jobs[0]!.requirements).toMatchObject({ contentHash: KIT_HASH, model: MODEL, items: [{ id: 'r1', text: '5+ years of backend experience' }, { id: 'r2', text: 'Kubernetes required' }] });
    // A list that does not say which text it is for is treated the same way.
    const unhashed = withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ requirements: { v: 1, items: stale.items } })] }));
    const again = setupV4({ repo: unhashed });
    await again.service.scoreJob('u1', 'job1');
    expect((again.scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toBeNull();
    expect(unhashed.state.jobs[0]!.requirements).toMatchObject({ contentHash: KIT_HASH });
    // The list is for the posting's own text, whatever the search index stored as its hash a moment ago.
    const indexedLater = withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ contentHash: 'the-hash-the-index-wrote-before-enrichment', requirements: { v: 1, contentHash: KIT_HASH, model: 'enrich/model', extractedAt: '2026-10-09T00:00:00.000Z', items: [{ id: 'r1', kind: 'skill', text: K8S.text, importance: 'must' }] } })] }));
    const fresh = setupV4({ repo: indexedLater, answer: () => checklist({ requirements: [{ ...K8S, id: 'r1' }] }) });
    await fresh.service.scoreJob('u1', 'job1');
    expect((fresh.scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toEqual([{ id: 'r1', kind: 'skill', text: K8S.text, importance: 'must' }]);
    expect(indexedLater.saveJobRequirements).not.toHaveBeenCalled();
  });

  it('a list enrichment stored survives a change of the skill strings: the key reads the text only, so the scorer does not copy the lines again', async () => {
    // Enrichment v3 keys its list by the title and the requirement text with no skills. Ingest then writes the
    // provider's skill list back over the row (every refresh does), which changes the fit's hash and not this key.
    const list: StoredRequirementsDoc = { v: 1, contentHash: KIT_HASH, model: 'enrich/model', extractedAt: '2026-10-09T00:00:00.000Z', items: [{ id: 'r1', kind: 'skill', text: K8S.text, importance: 'must' }] };
    const refreshed = jobRecord({ skills: ['Kubernetes', 'A skill string the refresh added'], requirements: list });
    expect(jobContentHash(refreshed)).not.toBe(jobContentHash(jobRecord()));
    expect(requirementListHash(refreshed)).toBe(KIT_HASH);
    expect(KIT_HASH).not.toBe(jobContentHash(jobRecord()));
    const repo = withRequirementStore(createMemoryRepo({ jobs: [refreshed] }));
    const { service, scorerV4 } = setupV4({ repo, answer: () => checklist({ requirements: [{ ...K8S, id: 'r1' }] }) });
    await service.scoreJob('u1', 'job1');
    expect((scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toEqual(list.items);
    expect(repo.saveJobRequirements).not.toHaveBeenCalled();
    expect(repo.state.jobs[0]!.requirements).toEqual(list);
    // An edited text is another posting text: the stored list is not used and the next score replaces it.
    const edited = withRequirementStore(createMemoryRepo({ jobs: [jobRecord({ qualifications: `${jobRecord().qualifications ?? ''}\nA line the employer added.`, requirements: list })] }));
    const again = setupV4({ repo: edited });
    await again.service.scoreJob('u1', 'job1');
    expect((again.scorerV4.run.mock.calls[0]![0] as RAJobMatchScorerV4Input).requirements).toBeNull();
  });

  it('nothing is stored when no copied line is in the posting: the answer is refused; a lost race or a failed write never fails the score', async () => {
    const none = setupV4({ answer: () => checklist({ requirements: [{ ...K8S, text: 'A line the posting does not have' }] }) });
    expect(await none.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'pre', estimateReason: 'ai_failed' });
    expect(none.repo.state.scores).toHaveLength(0);
    expect(none.repo.saveJobRequirements).not.toHaveBeenCalled();

    // Another writer got there first (the guarded UPDATE touched no row).
    const lost = createMemoryRepo();
    const saveLost = vi.fn(async () => false);
    const a = setupV4({ repo: Object.assign(lost, { saveJobRequirements: saveLost }) });
    expect(await a.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 79 });
    expect(saveLost).toHaveBeenCalledTimes(1);
    expect(lost.state.scores).toHaveLength(1);

    const failing = createMemoryRepo();
    const b = setupV4({ repo: Object.assign(failing, { saveJobRequirements: vi.fn(async () => Promise.reject(new Error('db down'))) }) });
    expect(await b.service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 79 });
    expect(failing.state.scores).toHaveLength(1);

    // A repository with no way to write to the job (the member is optional on the interface): the score is stored, the lines are not.
    const plain = Object.assign(createMemoryRepo(), { saveJobRequirements: undefined });
    expect(await setupV4({ repo: plain }).service.scoreJob('u1', 'job1')).toMatchObject({ kind: 'ai', score: 79 });
    expect(plain.state.jobs[0]!.requirements ?? null).toBeNull();
  });

  it('a list never reads the checklist; the single-job read and the fit-analysis card carry it', async () => {
    const { service, withCredit } = setupV4();
    const card = await service.fitAnalysis('u1', 'job1', 'idem-key-1');
    expect(withCredit).toHaveBeenCalledTimes(1);
    expect(card).toMatchObject({ kind: 'ai', charged: true, aiWritten: true, highlights: ['Your payments APIs in Go'] });
    expect((card as { requirements?: unknown[] }).requirements).toHaveLength(2);
    expect((await service.scoreJob('u1', 'job1', { mode: 'cache_only' })).requirements).toHaveLength(2);
    expect((await service.fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', requirements: [], prose: null });
    // An estimate has no checklist, on the card either.
    const pre = await setupV4({ aiAllowed: async () => false }).service.fitAnalysis('u1', 'job1', 'idem-key-2');
    expect(pre.kind).toBe('pre');
    expect(pre).not.toHaveProperty('requirements');
  });
});

describe('scorer v4 — "rewrite in my language" changes the words and nothing else', () => {
  it('statuses, components, the score, the tier and the scored date are kept; only strengths, gaps and summary are written again', async () => {
    const run = vi
      .fn<ScorerV4Like['run']>()
      .mockResolvedValueOnce(checklist())
      // The second answer would judge everything differently: none of it may be used.
      .mockResolvedValueOnce(
        checklist({
          requirements: [{ ...YEARS, status: 'not_shown', evidence: '' }, { ...K8S, status: 'met', evidence: 'TypeScript, Go, PostgreSQL' }],
          level: { post: 'senior', resume: 'intern_newgrad', direction: 'post_higher' },
          domain: { status: 'unrelated', evidence: '' },
          trajectory: { status: 'away', evidence: '' },
          strengths: ['你在 Go 里做过支付接口'],
          gaps: ['没有体现 Kubernetes 经验'],
          summary: '你的支付经验很对口，但这个职位以 Kubernetes 为主。',
        }),
      );
    const { service, repo, costLog } = setupV4({ scorerV4: { run } });
    const first = await service.scoreJob('u1', 'job1', { locale: 'en' });
    const before = repo.state.scores[0]!;
    const regen = await service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(regen).toMatchObject({
      kind: 'ai',
      score: first.score,
      tier: first.tier,
      dimensions: first.dimensions,
      requirements: first.requirements,
      scoredAt: first.scoredAt,
      summary: '你的支付经验很对口，但这个职位以 Kubernetes 为主。',
      strengths: ['你在 Go 里做过支付接口'],
      gaps: ['没有体现 Kubernetes 经验'],
      summaryLocaleStale: false,
      cached: false,
    });
    const after = repo.state.scores[0]!;
    expect(repo.state.scores).toHaveLength(1);
    expect(after).toMatchObject({ score: before.score, tier: before.tier, dimensions: before.dimensions, locale: 'zh', generatedAt: before.generatedAt, promptVersion: 'scorer_v4', rubricVersion: 'fit_v4' });
    const exp = after.explanation as Record<string, unknown>;
    const was = before.explanation as Record<string, unknown>;
    for (const key of ['requirements', 'level', 'domain', 'trajectory', 'estimateAtScore']) expect(exp[key], key).toEqual(was[key]);
    expect(exp).toMatchObject({ responseLanguage: 'zh', rationale: '你的支付经验很对口，但这个职位以 Kubernetes 为主。' });
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'locale_regen', prompt: 'scorer_v4' }));
    // The posting's stored lines are untouched by a rewrite.
    expect(repo.saveJobRequirements).toHaveBeenCalledTimes(1);
    // The next read in that language is the cache.
    expect(await service.scoreJob('u1', 'job1', { locale: 'zh' })).toMatchObject({ cached: true, summaryLocaleStale: false, score: first.score });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a rewrite the cap stops leaves the fit and its checklist as they were, and says so', async () => {
    let capped = false;
    const consume = vi.fn(async ({ key }: { key: string }) => (capped && key.includes(':score:user:') ? { ...allow(0), allowed: false } : allow()));
    const { service, scorerV4 } = setupV4({ consume });
    const first = await service.scoreJob('u1', 'job1', { locale: 'en' });
    capped = true;
    const blocked = await service.scoreJob('u1', 'job1', { locale: 'zh', regenerateExplanation: true });
    expect(blocked).toMatchObject({ kind: 'ai', score: first.score, requirements: first.requirements, summary: first.summary, summaryLocaleStale: true, rewriteBlocked: 'daily_cap' });
    expect(scorerV4.run).toHaveBeenCalledTimes(1);
  });

  describe('on a stale row (every stored row, after a change of the scorer version) the person who asked is still told why', () => {
    const ASK = { locale: 'zh', regenerateExplanation: true } as const;
    /** A v3 fit written in English, read under the default pin (scorer v4): stale. */
    async function staleV3Row() {
      const repo = withRequirementStore(createMemoryRepo());
      const v3 = setupV4({ repo, env: { MATCH_SCORER_RUBRIC: 'fit_v3' } });
      const first = await v3.service.scoreJob('u1', 'job1', { locale: 'en' });
      expect(repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v3', locale: 'en' });
      return { repo, first };
    }
    const denied = (key: (k: string) => boolean) => vi.fn(async (input: { key: string }) => (key(input.key) ? { ...allow(0), allowed: false } : allow()));

    it.each([
      ['daily_cap', { consume: denied((k) => k.includes(':score:user:')) }],
      ['budget', { consume: vi.fn(async () => ({ ...allow(0), allowed: false })) }],
      ['ai_unavailable', { resolveModel: () => null }],
      ['ai_unavailable', { routeAllowed: () => false }],
      ['ai_failed', { answer: () => { throw new Error('upstream 502'); } }],
      ['ai_failed', { answer: () => checklist({ requirements: [] }) }],
    ] as const)('%s', async (reason, deps) => {
      const { repo, first } = await staleV3Row();
      const s = setupV4({ repo, ...(deps as Partial<Parameters<typeof setupV4>[0]>) });
      const view = await s.service.scoreJob('u1', 'job1', ASK);
      // The old-language fit is answered as it was, flagged stale, with the reason the rewrite did not happen.
      expect(view).toMatchObject({ kind: 'ai', score: first.score, tier: first.tier, summary: first.summary, stale: true, summaryLocaleStale: true, rewriteBlocked: reason });
      expect(repo.state.scores).toHaveLength(1);
      expect(repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v3', locale: 'en' });
    });

    it('the same on a row of another model or of an earlier posting text; a plain read, or one that asked for no rewrite, carries no flag', async () => {
      const capped = { consume: denied((k) => k.includes(':score:user:')) };
      const repo = withRequirementStore(createMemoryRepo());
      const first = await setupV4({ repo }).service.scoreJob('u1', 'job1', { locale: 'en' });
      const otherModel = setupV4({ repo, resolveModel: () => 'test/model-b', ...capped });
      expect(await otherModel.service.scoreJob('u1', 'job1', ASK)).toMatchObject({ kind: 'ai', score: first.score, stale: true, rewriteBlocked: 'daily_cap' });
      // No rewrite was asked for: a re-score that could not run is not a blocked rewrite.
      const plain = await otherModel.service.scoreJob('u1', 'job1', { locale: 'zh' });
      expect(plain).toMatchObject({ kind: 'ai', stale: true, summaryLocaleStale: true });
      expect(plain.rewriteBlocked).toBeUndefined();
      // Asked for, in the language the row already has: nothing to rewrite, nothing blocked.
      expect((await otherModel.service.scoreJob('u1', 'job1', { locale: 'en', regenerateExplanation: true })).rewriteBlocked).toBeUndefined();
      // A read that may not call a model at all (a list, the cache) never carries it.
      expect((await otherModel.service.scoreJob('u1', 'job1', { ...ASK, mode: 'cache_only' })).rewriteBlocked).toBeUndefined();
      // The posting changed since the score.
      repo.state.jobs[0]!.qualifications = '7+ years of backend experience. Kubernetes required.';
      expect(await setupV4({ repo, ...capped }).service.scoreJob('u1', 'job1', ASK)).toMatchObject({ kind: 'ai', stale: true, rewriteBlocked: 'daily_cap' });
    });

    it('when the model may run, the stale row is re-scored in the language that was asked for and nothing is blocked', async () => {
      const { repo } = await staleV3Row();
      const s = setupV4({ repo, answer: () => checklist({ summary: '你的支付经验很对口。' }) });
      const view = await s.service.scoreJob('u1', 'job1', ASK);
      expect(view).toMatchObject({ kind: 'ai', stale: false, cached: false, summary: '你的支付经验很对口。', summaryLocaleStale: false });
      expect(view.rewriteBlocked).toBeUndefined();
      expect(repo.state.scores[0]).toMatchObject({ promptVersion: 'scorer_v4', locale: 'zh' });
    });
  });
});

describe('scorer v4 — the borderline rule (I5): within 3 points of a tier edge the stored tier is on the estimate\'s side', () => {
  // The test kit's logistics are met (100). With the same level (100): total = 45 + 0.3 × skills + 0.15 × domain + 0.1 × trajectory.
  // One level apart (60): total = 31 + the same three terms.
  const NO_SKILL = [K8S]; // skills 0
  const HALF = [YEARS, K8S]; // skills 50
  const ALL = [YEARS]; // skills 100
  const totals: Record<number, Partial<RAJobMatchScorerV4Output>> = {
    // 31 + 0 + 3 + 10
    44: { requirements: NO_SKILL, level: { post: 'senior', resume: 'mid', direction: 'post_higher' }, domain: { status: 'unrelated', evidence: '' }, trajectory: { status: 'toward', evidence: '' } },
    // 31 + 0 + 9 + 6
    46: { requirements: NO_SKILL, level: { post: 'senior', resume: 'mid', direction: 'post_higher' }, domain: { status: 'adjacent', evidence: '' }, trajectory: { status: 'neutral', evidence: '' } },
    // 45 + 0 + 9 + 10
    64: { requirements: NO_SKILL, domain: { status: 'adjacent', evidence: '' }, trajectory: { status: 'toward', evidence: '' } },
    // 45 + 15 + 3 + 2.5 = 65.5
    66: { requirements: HALF, domain: { status: 'unrelated', evidence: '' }, trajectory: { status: 'away', evidence: '' } },
    // 45 + 15 + 3 + 6
    69: { requirements: HALF, domain: { status: 'unrelated', evidence: '' }, trajectory: { status: 'neutral', evidence: '' } },
    // 45 + 15 + 9 + 10
    79: { requirements: HALF, domain: { status: 'adjacent', evidence: '' }, trajectory: { status: 'toward', evidence: '' } },
    // 45 + 30 + 3 + 2.5 = 80.5
    81: { requirements: ALL, domain: { status: 'unrelated', evidence: '' }, trajectory: { status: 'away', evidence: '' } },
  };

  it.each([
    // total, estimate, stored tier, edge the rule was applied at
    [66, 58, 'possible', 65], // the plan's case: a total of 66 with an estimate of 58
    [66, 70, 'good', 65],
    [64, 58, 'possible', 65],
    [64, 70, 'good', 65],
    [69, 58, 'good', null], // the plan's other case: 4 points over, its own tier
    [79, 85, 'great', 80],
    [79, 70, 'good', 80],
    [81, 85, 'great', 80],
    [81, 70, 'good', 80],
    [44, 50, 'possible', 45],
    [44, 30, 'unlikely', 45],
    [46, 50, 'possible', 45],
    [46, 30, 'unlikely', 45],
  ] as const)('a total of %s with an estimate of %s is stored as %s', async (total, estimate, tier, edge) => {
    const { service, repo, scorerV4 } = setupV4({ answer: () => checklist(totals[total]), calibration: estimateAt(estimate) });
    // The estimate the person was shown before the score.
    expect((await service.scoreJob('u1', 'job1', { mode: 'cache_only' })).score).toBe(estimate);
    const fit = await service.scoreJob('u1', 'job1');
    // The score is stored as computed; only the tier follows the estimate.
    expect(fit).toMatchObject({ kind: 'ai', score: total, tier });
    expect(repo.state.scores[0]).toMatchObject({ score: total, tier });
    const exp = repo.state.scores[0]!.explanation as { tierRule?: { edge: number; estimate: number } };
    expect(exp.tierRule ?? null).toEqual(edge === null ? null : { edge, estimate });
    // No second model call, and every later read shows the same tier.
    expect(scorerV4.run).toHaveBeenCalledTimes(1);
    expect(await service.scoreJob('u1', 'job1')).toMatchObject({ score: total, tier, cached: true });
    expect((await service.fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ score: total, tier });
  });

  it('without a calibration map the side is the plain estimate\'s; the configured MATCH_TIERS edges are the ones read', async () => {
    const plain = setupV4({ answer: () => checklist(totals[66]) });
    const estimate = (await plain.service.scoreJob('u1', 'job1', { mode: 'cache_only' })).score!;
    const fit = await plain.service.scoreJob('u1', 'job1');
    expect(fit.score).toBe(66);
    expect(fit.tier).toBe(estimate >= 65 ? 'good' : 'possible');
    expect((plain.repo.state.scores[0]!.explanation as { estimateAtScore: { score: number } }).estimateAtScore.score).toBe(estimate);

    // Good starts at 70 here: 69 is one point under that edge, 66 is no longer near one.
    const env = { MATCH_TIERS: '{"great":85,"good":70,"possible":50}' };
    const near = setupV4({ env, answer: () => checklist(totals[69]), calibration: estimateAt(75) });
    expect(await near.service.scoreJob('u1', 'job1')).toMatchObject({ score: 69, tier: 'good' });
    const far = setupV4({ env, answer: () => checklist(totals[66]), calibration: estimateAt(75) });
    expect(await far.service.scoreJob('u1', 'job1')).toMatchObject({ score: 66, tier: 'possible' });
  });

  it('three runs that land on both sides of an edge store one tier; scorer v3 keeps its own rule', async () => {
    const tiers: string[] = [];
    for (const total of [64, 66, 64]) {
      const { service } = setupV4({ answer: () => checklist(totals[total]), calibration: estimateAt(58) });
      tiers.push((await service.scoreJob('u1', 'job1')).tier!);
    }
    expect(new Set(tiers)).toEqual(new Set(['possible']));
    // The rollback scorer: a new result takes its own tier (its tests above), estimate or not.
    const v3 = setup({ calibration: estimateAt(20), scorer: { run: vi.fn(async () => scorerOutput({ dimensions: { title_level: { score: 66, evidence: [] }, skills: { score: 66, evidence: [] }, industry: { score: 66, evidence: [] }, career_path: { score: 66, evidence: [] } } })) } });
    const fit = await v3.service.scoreJob('u1', 'job1');
    expect(fit.score).toBe(69);
    expect(fit.tier).toBe('good');
    expect(v3.repo.state.scores[0]!.explanation).not.toHaveProperty('tierRule');
  });
});

describe('the resume a prompt gets (both scorers): two strips, one after the other', () => {
  const RESUME = [
    '# Ada Lovelace',
    'ada@example.com · +49 151 2345 6789',
    '- Profile: linkedin.com/in/ada-example',
    '- Code: github.com/adal0velace',
    '联系我 微信 wxm_dev2020 或 QQ 123456789',
    'WeChat: coder_x99, Telegram @coderx',
    'Site: adalovelace.dev',
    'Portfolio at ada-portfolio.vercel.app',
    '',
    '## Experience',
    'Senior Software Engineer, PayCo (2019-01 – present)',
    '- Built payment APIs in TypeScript and Go serving 2M users.',
    '- Built WeChat mini programs and an ASP.NET service with socket.io.',
    '',
    '## Skills',
    'TypeScript, Go, PostgreSQL',
  ].join('\n');

  it.each(['fit_v4', 'fit_v3'])('%s: no profile link without a scheme, no chat handle, no personal page; ordinary text is left alone', async (rubric) => {
    const repo = withRequirementStore(createMemoryRepo({ resumes: [{ ...resumeRecord({ resumeMarkdown: RESUME }), userId: 'u1' }] }));
    const s = setupV4({ repo, env: { MATCH_SCORER_RUBRIC: rubric } });
    await s.service.scoreJob('u1', 'job1');
    const call = (rubric === 'fit_v4' ? s.scorerV4.run : s.scorer.run).mock.calls[0]! as unknown as [{ resumeMarkdown: string }];
    const sent = call[0].resumeMarkdown;
    for (const leak of ['Ada', 'Lovelace', 'ada@example.com', '2345 6789', 'linkedin.com', 'ada-example', 'github.com', 'adal0velace', 'wxm_dev2020', '123456789', 'coder_x99', '@coderx', 'adalovelace.dev', 'vercel.app']) {
      expect(sent, leak).not.toContain(leak);
    }
    for (const kept of ['Senior Software Engineer, PayCo (2019-01 – present)', 'Built payment APIs in TypeScript and Go serving 2M users.', 'Built WeChat mini programs and an ASP.NET service with socket.io.', 'TypeScript, Go, PostgreSQL']) {
      expect(sent, kept).toContain(kept);
    }
  });

  it('a quote is verified against the text the model was sent: one that names what the strip removed is not kept', async () => {
    const repo = withRequirementStore(createMemoryRepo({ resumes: [{ ...resumeRecord({ resumeMarkdown: RESUME }), userId: 'u1' }] }));
    const { service } = setupV4({ repo, answer: () => checklist({ requirements: [{ ...YEARS, evidence: 'Code: github.com/adal0velace' }, K8S] }) });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit.requirements![0]).toMatchObject({ status: 'not_shown', evidence: '' });
    expect(JSON.stringify(repo.state.scores[0])).not.toContain('adal0velace');
  });

  it('a true short quote is not an invented one: "Go", "C#", "R", "AI" and 本科 quoted from the resume stay met, and a required degree line does not halve the level', async () => {
    const resume = ['## Experience', 'Data Engineer, Example Cloud (2020-03 – present)', '- Moved the billing jobs to Google Cloud.', '', '## Education', '北京大学 本科 计算机', '', '## Skills', 'Go, C#, R, SQL, AI'].join('\n');
    // A fresh row per world: the first score of a posting stores its lines on the row.
    const job = () => jobRecord({ qualifications: 'Go. C#. R. AI. Rust. 本科. 硕士.' });
    const line = (text: string, over: Partial<ScorerV4RequirementAnswer> = {}): ScorerV4RequirementAnswer => ({ id: text, kind: 'skill', text, importance: 'must', status: 'met', evidence: text, ...over });
    const world = (requirements: ScorerV4RequirementAnswer[]) =>
      setupV4({ repo: withRequirementStore(createMemoryRepo({ jobs: [job()], resumes: [{ ...resumeRecord({ resumeMarkdown: resume }), userId: 'u1' }] })), answer: () => checklist({ requirements }) });
    const shown = await world([line('Go'), line('C#'), line('R'), line('AI'), line('本科', { kind: 'education' })]).service.scoreJob('u1', 'job1');
    expect(shown.requirements!.map((r) => [r.text, r.status, r.evidence])).toEqual([['Go', 'met', 'Go'], ['C#', 'met', 'C#'], ['R', 'met', 'R'], ['AI', 'met', 'AI'], ['本科', 'met', '本科']]);
    const dim = (view: typeof shown, key: string) => view.dimensions.find((d) => d.key === key)!.score;
    expect([dim(shown, 'skills'), dim(shown, 'title_level')]).toEqual([100, 100]);
    // What the resume does not say is still not shown: "Rust" is in no line, 硕士 neither, and "Go" is not found inside "Google".
    const missing = await world([line('Go'), line('Rust'), line('硕士', { kind: 'education' })]).service.scoreJob('u1', 'job1');
    expect(missing.requirements!.map((r) => r.status)).toEqual(['met', 'not_shown', 'not_shown']);
    expect([dim(missing, 'skills'), dim(missing, 'title_level')]).toEqual([50, 50]);
    const noGo = setupV4({
      repo: withRequirementStore(createMemoryRepo({ jobs: [job()], resumes: [{ ...resumeRecord({ resumeMarkdown: resume.replace('Go, C#, R, SQL, AI', 'C#, SQL') }), userId: 'u1' }] })),
      answer: () => checklist({ requirements: [line('Go'), line('C#')] }),
    });
    expect((await noGo.service.scoreJob('u1', 'job1')).requirements!.map((r) => [r.text, r.status])).toEqual([['Go', 'not_shown'], ['C#', 'met']]);
  });
});

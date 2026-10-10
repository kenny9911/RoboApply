// @vitest-environment node
// WP-18 — MatchService: scorer v3 behind the cache, caps, consent, CitationGuard,
// fit analysis credits and the keyword check. No network, no database.
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
import { RAJobMatchScorerV3Agent, type RAJobMatchScorerV3Output } from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { SCORER_PROMPT_VERSION } from './contract.js';
import { cnPostingVisible } from '../cn/jobs/index.js';
import { createMatchService, visibleTo, type MatchServiceDeps, type ScorerLike } from './MatchService.js';
import { createMemoryRepo, jobRecord, resumeRecord } from './testkit.js';

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
    // GoApply cases here score public postings, which needs the recruitment-info mode to allow them (R-14).
    env: { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' },
    now: () => new Date('2026-10-10T08:00:00Z'),
    ...over,
  });
  return { service, repo, scorer: (over.scorer as typeof scorer) ?? scorer, consume, costLog, withCredit };
}

beforeEach(() => {
  llm.chat.mockReset();
});

describe('scoreJob — scorer v3', () => {
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
    expect(fit.keywordsMatched).toEqual(['TypeScript', 'Go']);
    expect(fit.keywordsMissing).toEqual(['Kubernetes']);
    expect(repo.state.scores[0]!.explanation).toMatchObject({ keywordsMatched: ['TypeScript', 'Go'], keywordsMissing: ['Kubernetes'] });
    expect(fit.skills).toEqual({ aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], listed: 3 });
    const pre = await setup({ aiAllowed: async () => false }).service.scoreJob('u1', 'job1');
    expect(pre).toMatchObject({ kind: 'pre', keywordsMatched: [], keywordsMissing: [], skills: { aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], listed: 3 } });
  });

  it('a skill only in the resume body counts as shown in the fit view', async () => {
    const repo = createMemoryRepo({ resumes: [{ ...resumeRecord({ resumeMarkdown: '## Experience\nRan Kubernetes clusters; TypeScript and Go services.', parsedData: null }), userId: 'u1' }] });
    repo.state.users.u1!.profile!.skills = [];
    const { service } = setup({ repo });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit.skills).toEqual({ aligned: ['TypeScript', 'Kubernetes', 'Go'], missing: [], listed: 3 });
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

  it('re-scores when the resume, the model or the prompt version changes', async () => {
    const { service, repo, scorer, costLog } = setup();
    await service.scoreJob('u1', 'job1');
    repo.state.resumes[0]!.resumeContentHash = 'hash-2';
    await service.scoreJob('u1', 'job1');
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'resume_changed' }));
    repo.state.scores[0]!.promptVersion = 'v2_jobs_score_v1';
    await service.scoreJob('u1', 'job1');
    expect(costLog).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'prompt_changed' }));
    expect(scorer.run).toHaveBeenCalledTimes(3);
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

  it('GoApply with consent but an international scorer model: zero scorer calls (brand LLM policy, R-13)', async () => {
    const scorer = { run: vi.fn(async () => scorerOutput()) };
    const { service, repo } = setup({
      repo: createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }),
      scorer,
      resolveModel: () => 'openrouter/openai/gpt-5.6-luna',
      routeAllowed: undefined, // the real policy check
      brand: () => getBrand('goapply'),
    });
    const fit = await service.scoreJob('u1', 'job1');
    expect(fit).toMatchObject({ kind: 'pre', estimateReason: 'ai_unavailable' });
    expect(scorer.run).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);

    // A domestic route is allowed on GoApply; the same international one is fine on RoboApply.
    const cn = setup({ repo: createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }), resolveModel: () => 'deepseek/deepseek-chat', routeAllowed: undefined, brand: () => getBrand('goapply') });
    expect((await cn.service.scoreJob('u1', 'job1')).kind).toBe('ai');
    const intl = setup({ resolveModel: () => 'openrouter/openai/gpt-5.6-luna', routeAllowed: undefined });
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
    const off = setup({ repo: createMemoryRepo({ jobs }), brand: () => getBrand('goapply'), env: {} });
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
    for (const mode of [undefined, 'off', 'partner_deeplink', 'licensed']) {
      const env = mode ? { CN_RECRUITMENT_INFO_MODE: mode } : {};
      for (const job of jobs) {
        const basic = job.visibility === 'public' || job.ownerUserId === 'u1';
        expect(visibleTo(job, 'u1', job.market, env), `${mode} ${JSON.stringify(job)}`).toBe(basic && cnPostingVisible(job, 'u1', env));
      }
    }
    // Another brand's market is never visible, whatever the mode.
    expect(visibleTo(jobs[0]!, 'u1', 'intl', { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(false);
  });

  it('updates the variant’s cached score when it was tailored for this job', async () => {
    const repo = createMemoryRepo({ resumes: [{ ...resumeRecord({ targetJobId: 'job1' }), userId: 'u1' }] });
    const { service } = setup({ repo });
    const fit = await service.scoreJob('u1', 'job1');
    expect(repo.state.cachedScores.v1).toBe(fit.score);
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

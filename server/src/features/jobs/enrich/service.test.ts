// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../lib/modelPricing.js', () => ({ calculateModelCost: vi.fn(() => 0.0012) }));

import { getCurrentBrandId, runWithBrand } from '../../../lib/requestContext.js';
import { SHARED_COST_USER_ID } from '../../../roboapply/v2/lib/raFeatureCatalog.js';
import { enrichDedupeKey, enrichJob, rulesOnlyMarker, systemUserIdFor, type EnrichDeps } from './service.js';
import type { EnrichLlmOptions } from './agent.js';
import type { EnrichJobRecord, EnrichUpdate } from './reconcile.js';
import type { EnrichCostEntry, KeywordRow } from './repository.js';
import type { PostingIndustry } from '../companies/service.js';
import { logger } from '../../../services/LoggerService.js';
import { ENRICH_VERSION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL } from './schema.js';
import { CN_POSTING, INTL_BUSINESS_LINE, INTL_POSTING, INTL_POSTING_WITH_BUSINESS, intlModelReply, makeJob } from './__tests__/fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const FIRST = { attempt: 1, maxAttempts: 5 };
/** A posting that says what its employer does (SM-10). */
const STATED = { description: INTL_POSTING_WITH_BUSINESS, descriptionPlain: INTL_POSTING_WITH_BUSINESS };

interface Harness {
  deps: EnrichDeps;
  job: EnrichJobRecord;
  saves: EnrichUpdate[];
  keywords: KeywordRow[];
  costs: EnrichCostEntry[];
  calls: Array<{ brand: string | undefined; options: EnrichLlmOptions; user: string }>;
  hooks: Array<{ job: Record<string, unknown>; ctx: Record<string, unknown> }>;
  /** Industries passed on to a company row (SM-10). */
  industries: Array<{ companyId: string; input: PostingIndustry }>;
  aiAllowed: ReturnType<typeof vi.fn>;
}

function harness(
  job: EnrichJobRecord,
  options: {
    reply?: Record<string, unknown> | (() => Promise<string>);
    env?: Record<string, string | undefined>;
    budgetAllowed?: boolean;
    budgetLimit?: number;
    consent?: boolean;
    /** Make the company write fail (the job must still finish). */
    industryWriteFails?: boolean;
  } = {},
): Harness {
  const state = { ...job };
  const h: Harness = {
    job: state,
    saves: [],
    keywords: [],
    costs: [],
    calls: [],
    hooks: [],
    industries: [],
    aiAllowed: vi.fn(async () => options.consent ?? true),
    deps: undefined as unknown as EnrichDeps,
  };
  h.deps = {
    repo: {
      loadJob: async (id) => (id === state.id ? { ...state } : null),
      saveJob: async (_id, update) => {
        h.saves.push(update);
        Object.assign(state, update);
      },
      saveKeywords: async (_id, row) => {
        h.keywords.push(row);
      },
      logCost: async (entry) => {
        h.costs.push(entry);
      },
    },
    llm: {
      chatWithUsage: async (messages, opts) => {
        h.calls.push({ brand: getCurrentBrandId(), options: opts, user: String(messages[1]?.content ?? '') });
        const reply = options.reply ?? intlModelReply();
        const content = typeof reply === 'function' ? await reply() : JSON.stringify(reply);
        return { content, usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 }, model: opts.model ?? 'stack-default-model' };
      },
    },
    budget: async () => ({
      allowed: options.budgetLimit === 0 ? false : (options.budgetAllowed ?? true),
      retryAfterSec: options.budgetAllowed === false || options.budgetLimit === 0 ? 3600 : 0,
      limit: options.budgetLimit ?? 8000,
    }),
    aiAllowed: h.aiAllowed as unknown as EnrichDeps['aiAllowed'],
    afterEnrich: async (j, ctx) => {
      h.hooks.push({ job: j, ctx: ctx as unknown as Record<string, unknown> });
    },
    setCompanyIndustry: async (companyId, input) => {
      h.industries.push({ companyId, input });
      if (options.industryWriteFails) throw new Error('company write failed');
    },
    env: options.env ?? DEFAULT_ENV,
    now: () => NOW,
  };
  return h;
}

/** The shared stack: a system user for cost rows and a default model (the enrich task inherits it). */
const DEFAULT_ENV = { RA_SYSTEM_USER_ID: 'sys_roboapply', LLM_MODEL: 'stack-default-model' };

const cnJob = () =>
  makeJob({ id: 'job_cn', market: 'cn', title: '数据分析师', companyName: '某某能源集团', description: CN_POSTING, descriptionPlain: CN_POSTING, sourceBoard: 'bank_gohire' });

describe('enrichJob', () => {
  it('makes one enrich call for an intl job and writes the row, keywords, cost and hooks', async () => {
    const h = harness(makeJob(), { env: { RA_SYSTEM_USER_ID: 'sys_roboapply', LLM_ENRICH_MODEL: 'openai/gpt-cheap' } });
    const outcome = await enrichJob({ jobId: 'job_1' }, { ...FIRST, requestId: 'req-1' }, h.deps);

    expect(outcome).toEqual({ status: 'enriched', model: 'openai/gpt-cheap', costUsd: 0.0012 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.brand).toBe('roboapply');
    expect(h.calls[0]!.options).toMatchObject({ task: 'enrich', model: 'openai/gpt-cheap', responseFormat: 'json_object', temperature: 0, carriesUserData: false });
    expect(h.calls[0]!.user).toContain('- backend_engineer:');

    expect(h.job).toMatchObject({
      primaryTaxonomyId: 'backend_engineer',
      sponsorship: 'not_offered',
      sponsorshipEvidence: 'We are unable to sponsor work visas for this role.',
      citizenshipRequired: true,
      enrichVersion: ENRICH_VERSION,
      enrichModel: 'openai/gpt-cheap',
      enrichedAt: NOW,
    });
    expect(h.keywords).toHaveLength(1);
    expect(h.keywords[0]).toMatchObject({ modelUsed: 'openai/gpt-cheap', tokenCost: 0.0012 });
    expect(h.keywords[0]!.keywords[0]).toEqual({ keyword: 'python', importance: 'high', frequency: 1 });
    expect(h.keywords[0]!.keywords.length).toBeLessThanOrEqual(30);
    expect(h.costs).toEqual([
      {
        userId: 'sys_roboapply',
        jobId: 'job_1',
        brand: 'roboapply',
        market: 'intl',
        model: 'openai/gpt-cheap',
        promptTokens: 1200,
        completionTokens: 300,
        costUsd: 0.0012,
        requestId: 'req-1',
      },
    ]);
    expect(h.hooks).toHaveLength(1);
    expect(h.hooks[0]!.ctx).toEqual({ brand: 'roboapply', market: 'intl', stage: 'enrich', userId: null });
    expect(h.hooks[0]!.job).toMatchObject({ id: 'job_1', market: 'intl', provider: 'activejobs', sponsorship: 'not_offered' });
  });

  it('runs a GoApply job on its own CN model under runWithBrand(goapply), whatever the ambient brand', async () => {
    const h = harness(cnJob(), {
      env: { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat', LLM_ENRICH_MODEL: 'openai/gpt-cheap', CN_RA_SYSTEM_USER_ID: 'sys_goapply' },
      reply: { taxonomyId: 'data_analyst', sponsorship: { status: 'not_stated', quote: null }, employerTags: [{ tag: 'soe', quote: '某某能源集团是一家中央企业' }] },
    });
    const outcome = await runWithBrand('roboapply', () => enrichJob({ jobId: 'job_cn' }, FIRST, h.deps));

    expect(outcome).toMatchObject({ status: 'enriched', model: 'deepseek/deepseek-chat' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.brand).toBe('goapply');
    expect(h.calls[0]!.options.task).toBe('enrich');
    expect(h.calls[0]!.options.model).toBe('deepseek/deepseek-chat');
    // No pin by default: the model id's own prefix routes it.
    expect(h.calls[0]!.options.provider).toBeUndefined();
    expect(h.calls[0]!.user).toContain('MARKET: mainland China');
    expect(h.job.employerTags).toEqual(['soe']);
    expect(h.costs[0]).toMatchObject({ userId: 'sys_goapply', brand: 'goapply', market: 'cn' });
    expect(h.hooks[0]!.ctx).toMatchObject({ brand: 'goapply', market: 'cn' });
  });

  it('GoApply with only the shared stack enriches with RoboApply\'s model, under runWithBrand(goapply), cost under the shared system user', async () => {
    const env = { LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'openai/gpt-default', RA_SYSTEM_USER_ID: 'sys_shared' };
    const h = harness(cnJob(), { env, reply: { taxonomyId: 'data_analyst', sponsorship: { status: 'not_stated', quote: null } } });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toMatchObject({ status: 'enriched', model: 'openai/gpt-cheap' });
    expect(h.calls).toHaveLength(1);
    // Routed and filtered as GoApply (content safety follows the brand), on the same selector RoboApply uses.
    expect(h.calls[0]!.brand).toBe('goapply');
    expect(h.calls[0]!.options).toMatchObject({ task: 'enrich', model: 'openai/gpt-cheap' });
    expect(h.calls[0]!.options.provider).toBeUndefined();
    expect(h.job).toMatchObject({ enrichModel: 'openai/gpt-cheap', enrichVersion: ENRICH_VERSION, enrichedAt: NOW });
    // CN_RA_SYSTEM_USER_ID is unset: the shared id, read per key.
    expect(h.costs).toEqual([expect.objectContaining({ userId: 'sys_shared', brand: 'goapply', market: 'cn', model: 'openai/gpt-cheap' })]);

    // The same env enriches a RoboApply job with the same model.
    const intl = harness(makeJob(), { env });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, intl.deps)).toMatchObject({ status: 'enriched', model: 'openai/gpt-cheap' });
    expect(intl.calls[0]!.brand).toBe('roboapply');
    expect(intl.calls[0]!.options.model).toBe(h.calls[0]!.options.model);
  });

  it('no model anywhere → rules only, zero LLM calls (both brands)', async () => {
    for (const [job, id] of [[cnJob(), 'job_cn'], [makeJob(), 'job_1']] as const) {
      const h = harness(job, { env: { RA_SYSTEM_USER_ID: 'sys' } });
      expect(await enrichJob({ jobId: id }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
      expect(h.calls).toHaveLength(0);
      expect(h.job).toMatchObject({ enrichModel: RULES_ONLY_MODEL, enrichVersion: ENRICH_VERSION, enrichedAt: NOW });
      expect(h.keywords[0]!.modelUsed).toBe(RULES_ONLY_MODEL);
      expect(h.costs).toHaveLength(0);
      expect(h.hooks).toHaveLength(1);
    }
  });

  it('behind the wall (CN_LLM_DOMESTIC_ONLY) GoApply refuses a model id that is not pinned to a domestic provider: rules only, zero LLM calls', async () => {
    const wall = { CN_LLM_DOMESTIC_ONLY: 'true' };
    for (const env of [
      { CN_LLM_ENRICH_MODEL: 'deepseek-chat' },
      { CN_LLM_ENRICH_MODEL: 'openrouter/deepseek/deepseek-chat' },
      { CN_LLM_ENRICH_MODEL: 'openai/gpt-cheap' },
      // The shared model it would otherwise use is not a mainland route either.
      { LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'openai/gpt-default' },
    ]) {
      const h = harness(cnJob(), { env: { ...wall, ...env } });
      expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
      expect(h.calls).toHaveLength(0);
    }
    // A domestic model is pinned to its provider, as before.
    const h = harness(cnJob(), { env: { ...wall, CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, reply: { taxonomyId: 'data_analyst', sponsorship: { status: 'not_stated', quote: null } } });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toMatchObject({ status: 'enriched', model: 'deepseek/deepseek-chat' });
    expect(h.calls[0]!.options).toMatchObject({ model: 'deepseek/deepseek-chat', provider: 'deepseek' });
    // Without the wall the same ids are simply used.
    const open = harness(cnJob(), { env: { CN_LLM_ENRICH_MODEL: 'openai/gpt-cheap' }, reply: { taxonomyId: 'data_analyst', sponsorship: { status: 'not_stated', quote: null } } });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, open.deps)).toMatchObject({ status: 'enriched', model: 'openai/gpt-cheap' });
  });

  it("makes zero LLM calls for a GoApply user's import without AI consent", async () => {
    const job = { ...cnJob(), visibility: 'private', ownerUserId: 'user_cn' };
    const h = harness(job, { env: { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, consent: false });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_ai_consent' });
    expect(h.aiAllowed).toHaveBeenCalledWith('user_cn');
    expect(h.calls).toHaveLength(0);
    // Settled for this version: jobs-maintain does not force it again night after night.
    expect(h.job.enrichModel).toBe(RULES_CHECKED_MODEL);
    expect(h.hooks[0]!.ctx).toMatchObject({ userId: 'user_cn' });
  });

  it("marks a RoboApply user's import as user data for the egress rule", async () => {
    const h = harness(makeJob({ visibility: 'private', ownerUserId: 'user_1' }));
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.calls[0]!.options.carriesUserData).toBe(true);
  });

  it('skips the model when ingest already covered taxonomy, seniority and 5+ skills', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const h = harness(
      makeJob({
        descriptionPlain: plain,
        description: plain,
        primaryTaxonomyId: 'backend_engineer',
        taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
        seniority: 'mid',
        skills: ['python', 'go', 'sql', 'kafka', 'terraform'],
      }),
    );
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'covered' });
    expect(h.calls).toHaveLength(0);
    // Nothing a model could add: the row says so itself (never queued for a model pass).
    expect(h.job.enrichModel).toBe(RULES_CHECKED_MODEL);
    expect(h.keywords[0]!.modelUsed).toBe(RULES_ONLY_MODEL);
    expect(h.keywords[0]!.keywords.slice(0, 5).map((k) => k.keyword)).toEqual(['python', 'go', 'sql', 'kafka', 'terraform']);
  });

  it('SM-2: a covered row whose title only half names a role is the model\'s to decide: one call, and its pick replaces the weak role', async () => {
    const plain = 'Design distributed services in Java and Go. Review system designs with the platform team.';
    // Filed under the building profession by the old one-word match; ingest covered the rest.
    const h = harness(
      makeJob({
        title: 'Java Backend Architect',
        titleNormalized: 'java backend architect',
        descriptionPlain: plain,
        description: plain,
        primaryTaxonomyId: 'architect',
        taxonomyIds: ['design', 'spatial_design', 'architect'],
        seniority: 'senior',
        skills: ['java', 'go', 'sql', 'kafka', 'terraform'],
        enrichedAt: new Date('2026-09-01T00:00:00.000Z'),
        enrichVersion: 1,
        enrichModel: 'openai/gpt-cheap',
      }),
      { reply: intlModelReply({ taxonomyId: 'software_architect', sponsorship: null, citizenshipRequired: null, skills: [], summary: null }) },
    );
    vi.mocked(logger.info).mockClear();
    // A row stamped with the old version is enriched again without `force`.
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.calls).toHaveLength(1);
    // The model is offered the software reading, the building profession and the role the row holds.
    expect(h.calls[0]!.user).toContain('- software_architect:');
    expect(h.calls[0]!.user).toContain('- architect:');
    expect(h.job).toMatchObject({
      primaryTaxonomyId: 'software_architect',
      taxonomyIds: ['software_engineering', 'swe_leadership', 'software_architect'],
      enrichVersion: ENRICH_VERSION,
    });
    expect(h.job.titleMatchScore).toBeGreaterThanOrEqual(0.85);
    expect(h.job.titleMatchScore).toBeLessThan(0.9);
    expect(vi.mocked(logger.info).mock.calls.some(([, , meta]) => JSON.stringify((meta as { taxonomyOverridden?: unknown })?.taxonomyOverridden) === JSON.stringify({ from: 'architect', to: 'software_architect', by: 'model' }))).toBe(true);
  });

  it('SM-2: a title that names its role keeps it without a call, and a rules-only finish still stores the title score', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const covered = { descriptionPlain: plain, description: plain, seniority: 'mid', skills: ['python', 'go', 'sql', 'kafka', 'terraform'] };
    const exact = harness(makeJob({ ...covered, primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'] }));
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, exact.deps)).toEqual({ status: 'rules_only', reason: 'covered' });
    expect(exact.calls).toHaveLength(0);
    expect(exact.job.titleMatchScore).toBe(1);
    expect(exact.job.primaryTaxonomyId).toBe('backend_engineer');
    // No model for the brand: a weak row finishes rules only, keeps its role and records how weak the title was.
    vi.mocked(logger.info).mockClear();
    const weak = harness(
      makeJob({ ...covered, title: 'Registered Nurse - ICU', primaryTaxonomyId: 'nurse_practitioner', taxonomyIds: ['healthcare', 'clinical', 'nurse_practitioner'] }),
      { env: { RA_SYSTEM_USER_ID: 'sys_roboapply' } },
    );
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, weak.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(weak.calls).toHaveLength(0);
    expect(weak.job.primaryTaxonomyId).toBe('nurse_practitioner');
    expect(weak.job.titleMatchScore).toBeLessThan(0.9);
    expect(weak.job.enrichModel).toBe(RULES_ONLY_MODEL);
    // Nothing changed, so nothing is logged about the role.
    expect(vi.mocked(logger.info).mock.calls.filter(([, message]) => message === 'role changed by the title')).toEqual([]);
    // Even without a model, a role the retired one-word match put there leaves the wrong category.
    const retired = harness(
      makeJob({ ...covered, title: 'Java Backend Architect', primaryTaxonomyId: 'architect', taxonomyIds: ['design', 'spatial_design', 'architect'] }),
      { env: { RA_SYSTEM_USER_ID: 'sys_roboapply' } },
    );
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, retired.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(retired.job).toMatchObject({ primaryTaxonomyId: 'software_architect', taxonomyIds: ['software_engineering', 'swe_leadership', 'software_architect'] });
    // A role the title moved on a rules-only pass leaves a trace, like a model's override does.
    expect(vi.mocked(logger.info).mock.calls.filter(([, message]) => message === 'role changed by the title')).toEqual([
      ['JOB_ENRICH', 'role changed by the title', { jobId: 'job_1', reason: 'no_model', taxonomyOverridden: { from: 'architect', to: 'software_architect', by: 'title' } }],
    ]);
    // So does a role the title removes ("Principal Engineer" is not a school principal), on a covered pass too.
    vi.mocked(logger.info).mockClear();
    const removed = harness(
      makeJob({ ...covered, title: 'Principal Engineer', primaryTaxonomyId: 'education_administrator', taxonomyIds: ['education', 'education_admin', 'education_administrator'] }),
      { env: { RA_SYSTEM_USER_ID: 'sys_roboapply' } },
    );
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, removed.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(removed.job).toMatchObject({ primaryTaxonomyId: null, taxonomyIds: [] });
    expect(vi.mocked(logger.info).mock.calls.filter(([, message]) => message === 'role changed by the title')).toEqual([
      ['JOB_ENRICH', 'role changed by the title', { jobId: 'job_1', reason: 'no_model', taxonomyOverridden: { from: 'education_administrator', to: null, by: 'title' } }],
    ]);
  });

  it('SM-10: a public posting that says what its employer does fills the company industry, once, with the posting link', async () => {
    const quote = INTL_BUSINESS_LINE;
    const h = harness(makeJob({ ...STATED, companyId: 'co_1', sourceUrl: 'https://boards.example.com/acme/123' }), { reply: intlModelReply({ industry: { value: 'B2B SaaS', quote } }) });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.calls).toHaveLength(1);
    expect(h.industries).toEqual([{ companyId: 'co_1', input: { industry: 'B2B SaaS', sourceUrl: 'https://boards.example.com/acme/123', at: NOW } }]);
    // The industry is a company fact, never a job column.
    expect(h.saves.every((u) => !('industry' in u))).toBe(true);
    // A second delivery of the same item does nothing more.
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.industries).toHaveLength(1);
  });

  it('SM-10: no industry is stored without a verified quote, without a company, or from a user\'s own import', async () => {
    const quote = INTL_BUSINESS_LINE;
    const invented = harness(makeJob({ ...STATED, companyId: 'co_1' }), { reply: intlModelReply({ industry: { value: 'Fintech', quote: 'We are a leading payments company.' } }) });
    await enrichJob({ jobId: 'job_1' }, FIRST, invented.deps);
    expect(invented.industries).toEqual([]);

    const noCompany = harness(makeJob({ ...STATED, companyId: null }), { reply: intlModelReply({ industry: { value: 'B2B SaaS', quote } }) });
    await enrichJob({ jobId: 'job_1' }, FIRST, noCompany.deps);
    expect(noCompany.industries).toEqual([]);

    // A private import is its owner's data: it never writes to a company row everyone shares.
    const imported = harness(makeJob({ ...STATED, companyId: 'co_1', visibility: 'private', ownerUserId: 'user_1' }), { reply: intlModelReply({ industry: { value: 'B2B SaaS', quote } }) });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, imported.deps)).status).toBe('enriched');
    expect(imported.industries).toEqual([]);

    // Rules only (no model): nothing is claimed.
    const rules = harness(makeJob({ ...STATED, companyId: 'co_1' }), { env: { RA_SYSTEM_USER_ID: 'sys_roboapply' } });
    await enrichJob({ jobId: 'job_1' }, FIRST, rules.deps);
    expect(rules.industries).toEqual([]);
  });

  it('SM-10: a failed company write does not fail the job (the row is written, the hooks run)', async () => {
    const quote = INTL_BUSINESS_LINE;
    const h = harness(makeJob({ ...STATED, companyId: 'co_1' }), { reply: intlModelReply({ industry: { value: 'B2B SaaS', quote } }), industryWriteFails: true });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.industries).toHaveLength(1);
    expect(h.job.enrichVersion).toBe(ENRICH_VERSION);
    expect(h.hooks).toHaveLength(1);
    expect(h.costs).toHaveLength(1);
  });

  it('SM-10: a dependency set without the company writer still enriches (the industry is simply not stored)', async () => {
    const quote = INTL_BUSINESS_LINE;
    const h = harness(makeJob({ ...STATED, companyId: 'co_1' }), { reply: intlModelReply({ industry: { value: 'B2B SaaS', quote } }) });
    const { setCompanyIndustry: _unused, ...withoutWriter } = h.deps;
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, withoutWriter)).status).toBe('enriched');
    expect(h.industries).toEqual([]);
  });

  it('respects the daily budget: writes the rule-based parts and defers without calling the model', async () => {
    const fee = `${makeJob().descriptionPlain}\nA one-time training fee of $85 is due before your first shift.`;
    const h = harness(makeJob({ descriptionPlain: fee, description: fee }), { budgetAllowed: false });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'deferred', retryAfterMs: 3_600_000 });
    expect(h.calls).toHaveLength(0);
    expect(h.saves).toEqual([
      { fraudFlags: [{ rule: 'intl_fee_required', evidence: 'A one-time training fee of $85 is due before your first shift.', at: NOW.toISOString() }] },
    ]);
    expect(h.job.enrichedAt).toBeNull();
    expect(h.keywords[0]!.modelUsed).toBe(RULES_ONLY_MODEL);
    expect(h.hooks).toHaveLength(0);
  });

  it('ENRICH_DAILY_JOBS=0 finishes rules only (stamped, hooks run) instead of deferring forever', async () => {
    const fee = `${makeJob().descriptionPlain}\nA one-time training fee of $85 is due before your first shift.`;
    const h = harness(makeJob({ descriptionPlain: fee, description: fee }), { budgetLimit: 0 });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'budget_disabled' });
    expect(h.calls).toHaveLength(0);
    expect(h.job).toMatchObject({ enrichModel: RULES_ONLY_MODEL, enrichVersion: ENRICH_VERSION, enrichedAt: NOW });
    expect(h.job.fraudFlags).toEqual([{ rule: 'intl_fee_required', evidence: 'A one-time training fee of $85 is due before your first shift.', at: NOW.toISOString() }]);
    expect(h.hooks).toHaveLength(1);
  });

  // ── WP-74 "Keep": re-enrichment never brings back a scam rule an admin cleared ──

  const FEE_LINE = 'A one-time training fee of $85 is due before your first shift.';
  const CHAT_LINE = 'To apply, message our recruiter on Telegram only.';
  const scamJob = () => {
    const text = `${makeJob().descriptionPlain}\n${FEE_LINE}\n${CHAT_LINE}`;
    return makeJob({ descriptionPlain: text, description: text });
  };

  it('a cleared rule is not re-added on re-enrichment; a rule that was not cleared is', async () => {
    const h = harness(scamJob(), { budgetLimit: 0 });
    // Control: with no admin decision both rules are raised.
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    const raised = (h.job.fraudFlags as Array<{ rule: string }>).map((f) => f.rule).sort();
    expect(raised).toContain('intl_fee_required');
    expect(raised.length).toBeGreaterThanOrEqual(2);
    const other = raised.find((r) => r !== 'intl_fee_required')!;

    // The admin restored the job and cleared the fee rule (the admin write also drops the stored flags).
    h.job.fraudFlags = null;
    const clearedScamRules = vi.fn(async () => ['intl_fee_required']);
    h.deps.repo.clearedScamRules = clearedScamRules;
    expect(await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'budget_disabled' });
    expect(clearedScamRules).toHaveBeenCalledWith('job_1');
    const after = (h.job.fraudFlags as Array<{ rule: string }>).map((f) => f.rule);
    expect(after).not.toContain('intl_fee_required');
    expect(after).toContain(other);
  });

  it('clearing every raised rule leaves the job unflagged after re-enrichment (it stays in the lists)', async () => {
    const fee = `${makeJob().descriptionPlain}\n${FEE_LINE}`;
    const h = harness(makeJob({ descriptionPlain: fee, description: fee }), { budgetLimit: 0 });
    h.deps.repo.clearedScamRules = async () => ['intl_fee_required'];
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job.fraudFlags).toBeNull();
    // The deferred path (budget spent) honours the decision too: nothing partial is written back.
    const deferred = harness(makeJob({ descriptionPlain: fee, description: fee }), { budgetAllowed: false });
    deferred.deps.repo.clearedScamRules = async () => ['intl_fee_required'];
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, deferred.deps)).status).toBe('deferred');
    expect(deferred.job.fraudFlags ?? null).toBeNull();
  });

  it('a decision log outage keeps the rules as detected (a posting is never unflagged by an outage)', async () => {
    const fee = `${makeJob().descriptionPlain}\n${FEE_LINE}`;
    const h = harness(makeJob({ descriptionPlain: fee, description: fee }), { budgetLimit: 0 });
    h.deps.repo.clearedScamRules = async () => {
      throw new Error('db down');
    };
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect((h.job.fraudFlags as Array<{ rule: string }>).map((f) => f.rule)).toEqual(['intl_fee_required']);
  });

  it('is idempotent: a second delivery of the same item does nothing; a retry re-runs hooks only', async () => {
    const h = harness(makeJob());
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'already_enriched', hooksRerun: false });
    expect(h.calls).toHaveLength(1);
    expect(h.hooks).toHaveLength(1);
    expect(await enrichJob({ jobId: 'job_1' }, { attempt: 2, maxAttempts: 5 }, h.deps)).toEqual({ status: 'already_enriched', hooksRerun: true });
    expect(h.calls).toHaveLength(1);
    expect(h.hooks).toHaveLength(2);
  });

  it('re-enriches with force (a materially changed job)', async () => {
    const h = harness(makeJob());
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.calls).toHaveLength(2);
  });

  it('a forced re-enrichment of an edited posting drops sponsorship and citizenship quotes the posting no longer contains', async () => {
    // Ingest (WP-16b pipeline) enqueues `{ jobId, force: true }` when a row's
    // title/description hash changed. The model may still repeat the old
    // quotes; reconcile must not keep evidence the text no longer has (D3).
    const h = harness(makeJob());
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job).toMatchObject({ sponsorshipEvidence: 'We are unable to sponsor work visas for this role.', citizenshipRequired: true });

    const edited = INTL_POSTING.split('\n')
      .filter((line) => !/sponsor|citizens/i.test(line))
      .join('\n');
    Object.assign(h.job, { description: edited, descriptionPlain: edited });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toMatchObject({ status: 'already_enriched' });

    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.calls).toHaveLength(2);
    expect(h.job.sponsorshipEvidence).toBeNull();
    expect(h.job.sponsorship).not.toBe('not_offered');
    expect(h.job.citizenshipRequired).not.toBe(true);
  });

  it('a rules-only row records whether a model pass is still owed: only "no model" and "enrichment off" stay retryable', () => {
    expect(rulesOnlyMarker('no_model')).toBe(RULES_ONLY_MODEL);
    expect(rulesOnlyMarker('budget_disabled')).toBe(RULES_ONLY_MODEL);
    expect(rulesOnlyMarker('covered')).toBe(RULES_CHECKED_MODEL);
    expect(rulesOnlyMarker('no_ai_consent')).toBe(RULES_CHECKED_MODEL);
    expect(rulesOnlyMarker('llm_failed')).toBe(RULES_CHECKED_MODEL);
    expect(RULES_CHECKED_MODEL).not.toBe(RULES_ONLY_MODEL);
  });

  it('a forced model pass on a rules-only row that the model has nothing to add to settles it (no second forced pass)', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const covered = { descriptionPlain: plain, description: plain, primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'], seniority: 'mid', skills: ['python', 'go', 'sql', 'kafka', 'terraform'] };
    // As stored before this marker existed: rules-only at the current version.
    const h = harness(makeJob({ ...covered, enrichedAt: new Date('2026-10-01'), enrichVersion: ENRICH_VERSION, enrichModel: RULES_ONLY_MODEL }));
    expect(await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'covered' });
    expect(h.job.enrichModel).toBe(RULES_CHECKED_MODEL);
    expect(h.calls).toHaveLength(0);
  });

  it('re-enriches a row stamped with an older version', async () => {
    const h = harness(makeJob({ enrichedAt: new Date('2026-01-01'), enrichVersion: ENRICH_VERSION - 1 }));
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
  });

  it('lets the queue retry a failed call, then finishes rules only on the last attempt', async () => {
    const h = harness(makeJob(), { reply: async () => Promise.reject(new Error('upstream 503')) });
    await expect(enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).rejects.toThrow('upstream 503');
    expect(h.job.enrichedAt).toBeNull();
    expect(h.keywords).toHaveLength(1);

    expect(await enrichJob({ jobId: 'job_1' }, { attempt: 5, maxAttempts: 5 }, h.deps)).toEqual({ status: 'rules_only', reason: 'llm_failed' });
    // The model had its attempts: not queued for another call until the posting or ENRICH_VERSION changes.
    expect(h.job).toMatchObject({ enrichModel: RULES_CHECKED_MODEL, enrichVersion: ENRICH_VERSION });
    expect(h.costs).toHaveLength(0);
  });

  it('treats an unparsable reply like a failed call', async () => {
    const h = harness(makeJob(), { reply: async () => 'Sorry, I cannot do that.' });
    await expect(enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).rejects.toThrow(/not JSON/);
  });

  it('ignores missing and archived jobs', async () => {
    const h = harness(makeJob({ archivedAt: new Date('2026-09-01') }));
    expect(await enrichJob({ jobId: 'nope' }, FIRST, h.deps)).toEqual({ status: 'not_found' });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'archived' });
    expect(h.calls).toHaveLength(0);
  });

  it('propagates a failing market hook so the queue retries', async () => {
    const h = harness(makeJob());
    h.deps.afterEnrich = async () => Promise.reject(new Error('hook failed'));
    await expect(enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).rejects.toThrow('hook failed');
  });
});

describe('helpers', () => {
  it('logs cost under the brand system user (GoApply: its own id, else the shared one), else the shared-cost sentinel', () => {
    expect(systemUserIdFor('intl', { RA_SYSTEM_USER_ID: 'sys_r' })).toBe('sys_r');
    expect(systemUserIdFor('cn', { RA_SYSTEM_USER_ID: 'sys_r', CN_RA_SYSTEM_USER_ID: 'sys_g' })).toBe('sys_g');
    // RA_SYSTEM_USER_ID is read per key: GoApply uses the shared id when CN_RA_SYSTEM_USER_ID is unset.
    expect(systemUserIdFor('cn', { RA_SYSTEM_USER_ID: 'sys_r' })).toBe('sys_r');
    expect(systemUserIdFor('cn', { CN_RA_SYSTEM_USER_ID: 'sys_g' })).toBe('sys_g');
    // RoboApply never reads the CN_ id.
    expect(systemUserIdFor('intl', { CN_RA_SYSTEM_USER_ID: 'sys_g' })).toBe(SHARED_COST_USER_ID);
    // The sentinel only when neither is set.
    expect(systemUserIdFor('intl', {})).toBe(SHARED_COST_USER_ID);
    expect(systemUserIdFor('cn', {})).toBe(SHARED_COST_USER_ID);
  });

  it('builds the dedupe key from the job id and version', () => {
    expect(enrichDedupeKey('j1')).toBe(`job.enrich:j1:v${ENRICH_VERSION}`);
    expect(enrichDedupeKey('j1', 7)).toBe('job.enrich:j1:v7');
  });
});

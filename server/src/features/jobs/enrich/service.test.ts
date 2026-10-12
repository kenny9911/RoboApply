// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../lib/modelPricing.js', () => ({ calculateModelCost: vi.fn(() => 0.0012) }));
// The default index hook enqueues through the platform queue: recorded here, never a database write.
const queued = vi.hoisted(() => [] as Array<{ kind: string; payload: unknown; options: Record<string, unknown> }>);
vi.mock('../../../platform/queue/index.js', async (original) => ({
  ...(await original<typeof import('../../../platform/queue/index.js')>()),
  enqueue: vi.fn(async (kind: string, payload: unknown, options: Record<string, unknown>) => {
    queued.push({ kind, payload, options });
    return { id: 'w1', kind, status: 'queued', dedupeKey: options.dedupeKey ?? null, created: true };
  }),
}));

import { getCurrentBrandId, runWithBrand } from '../../../lib/requestContext.js';
import { SHARED_COST_USER_ID } from '../../../roboapply/v2/lib/raFeatureCatalog.js';
import { defaultEnrichDeps, enrichDedupeKey, enrichJob, rulesOnlyMarker, systemUserIdFor, type EnrichDeps, type EnrichedJobRef } from './service.js';
import type { EnrichLlmOptions } from './agent.js';
import type { EnrichJobRecord, EnrichUpdate, StoredRequirements } from './reconcile.js';
import type { EnrichCostEntry, KeywordRow } from './repository.js';
import type { RoleNeighbourContext } from './roleNeighbours.js';
import type { PostingIndustry } from '../companies/service.js';
import { jobContentHash } from '../../match/jobHash.js';
import { logger } from '../../../services/LoggerService.js';
import { ENRICH_VERSION, RULES_CHECKED_MODEL, RULES_ONLY_MODEL } from './schema.js';
import { CN_POSTING, INTL_BUSINESS_LINE, INTL_POSTING, INTL_POSTING_WITH_BUSINESS, fakeSkillsPort, fixtureVocabulary, intlModelReply, makeJob, type FakeSkillsPort } from './__tests__/fixtures.js';
import { createEnrichSkillsPort } from './skills.js';
import * as skillsArea from '../../skills/index.js';

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
  /** The vocabulary port over the fixture vocabulary (SM-6): its calls and the mentions it counted. */
  vocab: FakeSkillsPort;
  /** Titles the nearest-roles step was asked for (SM-2). */
  neighbourCalls: Array<{ title: string; ctx: RoleNeighbourContext }>;
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
    /** The vocabulary port (default: the fixture vocabulary, exact aliases and new unreviewed skills). */
    skills?: Parameters<typeof fakeSkillsPort>[0];
    /** What the nearest-roles step answers (default: the step is not wired). */
    nearestRoles?: string[] | (() => Promise<string[]>);
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
    vocab: fakeSkillsPort(options.skills),
    neighbourCalls: [],
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
    skills: h.vocab.port,
    contentHash: async () => jobContentHash,
    ...(options.nearestRoles
      ? {
          roleNeighbours: async (title: string, ctx: RoleNeighbourContext) => {
            h.neighbourCalls.push({ title, ctx });
            return typeof options.nearestRoles === 'function' ? options.nearestRoles() : (options.nearestRoles as string[]);
          },
        }
      : {}),
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
    expect(h.keywords[0]!.keywords[0]).toEqual({ keyword: 'python', importance: 'high', frequency: 1, skillId: 'python' });
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

describe('index hook (MKT-2H: job.index after every finished enrichment)', () => {
  function withIndex(job: EnrichJobRecord, options: Parameters<typeof harness>[1] = {}) {
    const h = harness(job, options);
    const indexed: EnrichedJobRef[] = [];
    const order: string[] = [];
    h.deps.enqueueIndex = async (ref) => {
      indexed.push(ref);
      order.push('index');
    };
    const afterEnrich = h.deps.afterEnrich;
    h.deps.afterEnrich = async (j, ctx) => {
      order.push('hook');
      return afterEnrich(j, ctx);
    };
    return { h, indexed, order };
  }

  it('is called once after an enriched finish, with the stamp of this enrichment', async () => {
    const { h, indexed } = withIndex(makeJob());
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toMatchObject({ status: 'enriched' });
    expect(indexed).toEqual([{ id: 'job_1', market: 'intl', enrichedAt: NOW }]);
  });

  it('is called after a rules-only finish too: no model, no AI consent, enrichment off', async () => {
    const noModel = withIndex(makeJob(), { env: {} });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, noModel.h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(noModel.indexed).toEqual([{ id: 'job_1', market: 'intl', enrichedAt: NOW }]);

    const noConsent = withIndex(makeJob({ id: 'job_cn', market: 'cn', visibility: 'private', ownerUserId: 'u1' }), { consent: false, env: { CN_LLM_MODEL: 'deepseek/deepseek-chat' } });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, noConsent.h.deps)).toEqual({ status: 'rules_only', reason: 'no_ai_consent' });
    expect(noConsent.indexed).toEqual([{ id: 'job_cn', market: 'cn', enrichedAt: NOW }]);

    const off = withIndex(makeJob(), { budgetLimit: 0 });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, off.h.deps)).toEqual({ status: 'rules_only', reason: 'budget_disabled' });
    expect(off.indexed).toHaveLength(1);
  });

  it('is not called for a deferred job (it is not finished), nor for a missing or archived one', async () => {
    const deferred = withIndex(makeJob(), { budgetAllowed: false });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, deferred.h.deps)).toMatchObject({ status: 'deferred' });
    expect(deferred.indexed).toHaveLength(0);
    const archived = withIndex(makeJob({ archivedAt: new Date('2026-09-01') }));
    await enrichJob({ jobId: 'job_1' }, FIRST, archived.h.deps);
    await enrichJob({ jobId: 'nope' }, FIRST, archived.h.deps);
    expect(archived.indexed).toHaveLength(0);
  });

  it('runs before the market hooks, so a failing hook cannot hold indexing back; a retry asks again with the same stamp', async () => {
    const { h, indexed, order } = withIndex(makeJob());
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(order).toEqual(['index', 'hook']);
    // A second delivery does nothing; a retry re-runs the hooks, and the index request carries the same stamp (one queue item).
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(indexed).toHaveLength(1);
    await enrichJob({ jobId: 'job_1' }, { attempt: 2, maxAttempts: 5 }, h.deps);
    expect(indexed).toHaveLength(2);
    expect(indexed[1]).toEqual(indexed[0]);

    const failing = withIndex(makeJob());
    failing.h.deps.afterEnrich = async () => Promise.reject(new Error('hook failed'));
    await expect(enrichJob({ jobId: 'job_1' }, FIRST, failing.h.deps)).rejects.toThrow('hook failed');
    expect(failing.indexed).toHaveLength(1);
  });

  it('a failed enqueue does not fail the enrichment (the retrieval sweep finds the row)', async () => {
    const h = harness(makeJob());
    h.deps.enqueueIndex = async () => Promise.reject(new Error('queue down'));
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toMatchObject({ status: 'enriched' });
    expect(h.hooks).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('JOB_ENRICH', expect.stringContaining('could not queue the job for indexing'), expect.objectContaining({ jobId: 'job_1' }));
  });

  it('a dependency set without the index hook still enriches', async () => {
    const h = harness(makeJob());
    expect(h.deps.enqueueIndex).toBeUndefined();
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toMatchObject({ status: 'enriched' });
  });

  it('the default hook enqueues job.index once per job and enrichment, in the brand of the job market', async () => {
    queued.length = 0;
    const enqueueIndex = defaultEnrichDeps().enqueueIndex!;
    await enqueueIndex({ id: 'job_1', market: 'intl', enrichedAt: NOW });
    await enqueueIndex({ id: 'job_cn', market: 'cn', enrichedAt: null });
    expect(queued).toEqual([
      { kind: 'job.index', payload: { jobIds: ['job_1'] }, options: { dedupeKey: `job.index:job_1:${NOW.getTime()}`, brand: 'roboapply' } },
      { kind: 'job.index', payload: { jobIds: ['job_cn'] }, options: { dedupeKey: 'job.index:job_cn:0', brand: 'goapply' } },
    ]);
  });
});

// ── ENRICH_VERSION 3 (SM-6, SM-8, SM-2, JI-11) ───────────────────────────

/** The "finished" log line of a job (one per finished enrichment). */
function finishedLines(): Array<Record<string, unknown>> {
  return vi
    .mocked(logger.info)
    .mock.calls.filter(([, message]) => message === 'enrichment finished')
    .map(([, , meta]) => meta as Record<string, unknown>);
}

describe('canonical skills at write time (SM-6)', () => {
  const POSTGRES = [
    'Acme Analytics is hiring a Backend Engineer.',
    'We run Postgres in production, and PostgreSQL tuning is weekly work.',
    'Clear communication with the product team matters. You will also keep our feature toggles tidy.',
  ].join('\n');
  const postgresJob = (over: Partial<EnrichJobRecord> = {}) => makeJob({ description: POSTGRES, descriptionPlain: POSTGRES, ...over });
  const postgresReply = () =>
    intlModelReply({
      sponsorship: null,
      citizenshipRequired: null,
      summary: null,
      skills: [
        { skill: 'postgres', kind: 'hard', required: true },
        { skill: 'PostgreSQL', kind: 'hard', required: false },
        { skill: 'communication', kind: 'hard', required: true },
        { skill: 'feature toggles', kind: 'hard', required: false },
        // Not in the posting: never stored, never sent to the vocabulary.
        { skill: 'Rust', kind: 'hard', required: true },
      ],
    });

  it('ACCEPT: one PostgreSQL entry with its id, the soft skill out of skillIds, both spellings searchable, an unknown skill stored as unreviewed', async () => {
    vi.mocked(logger.info).mockClear();
    const h = harness(postgresJob(), { reply: postgresReply() });
    expect((await enrichJob({ jobId: 'job_1' }, { ...FIRST, requestId: 'req-9' }, h.deps)).status).toBe('enriched');

    // One call to the vocabulary for the job, with the strings the posting names (provider strings first; here none).
    expect(h.vocab.calls).toEqual([{ terms: ['postgres', 'postgresql', 'communication', 'feature toggles'], options: { brand: 'roboapply', write: true, requestId: 'req-9' } }]);
    expect(h.job.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] },
      { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
      { skill: 'feature toggles', kind: 'hard', required: false, skillId: 'featuretoggle', via: 'new' },
    ]);
    expect(h.job.skillIds).toEqual(['postgresql', 'featuretoggle']);
    expect(h.job.skills).toEqual(['postgres', 'postgresql', 'communication', 'feature toggles']);
    // The keyword row: canonical, concrete terms only, each with its id; one entry per skill.
    expect(h.keywords).toHaveLength(1);
    expect(h.keywords[0]!.keywords).toEqual([
      { keyword: 'postgresql', importance: 'high', frequency: 1, skillId: 'postgresql' },
      { keyword: 'feature toggles', importance: 'medium', frequency: 1, skillId: 'featuretoggle' },
    ]);
    // Mentions: the reviewed skills the row did not hold before; the skill created just now already counts one.
    expect(h.vocab.mentions).toEqual([['postgresql', 'communication']]);
    // The log line of the job carries the three counts.
    expect(finishedLines()).toEqual([
      expect.objectContaining({ jobId: 'job_1', market: 'intl', outcome: 'enriched', skills: { canonical: 2, unreviewed: 1, dropped: 1 }, skillIds: 2 }),
    ]);
  });

  it('a rules-only pass maps the provider\'s skills too: one vocabulary call, ids on the row, keywords with ids, no model', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const h = harness(
      makeJob({
        descriptionPlain: plain,
        description: plain,
        primaryTaxonomyId: 'backend_engineer',
        taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
        seniority: 'mid',
        skills: ['python', 'golang', 'sql', 'kafka', 'in-house rpc'],
      }),
    );
    vi.mocked(logger.info).mockClear();
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'covered' });
    expect(h.calls).toHaveLength(0);
    expect(h.vocab.calls).toEqual([{ terms: ['python', 'golang', 'sql', 'kafka', 'in-house rpc'], options: { brand: 'roboapply', write: true, requestId: undefined } }]);
    expect(h.job.skillIds).toEqual(['python', 'go', 'sql', 'kafka', 'inhouserpc']);
    expect(h.keywords[0]!.keywords.map((k) => [k.keyword, k.skillId, k.importance])).toEqual([
      ['python', 'python', 'medium'],
      ['golang', 'go', 'medium'],
      ['sql', 'sql', 'medium'],
      ['kafka', 'kafka', 'medium'],
      ['in-house rpc', 'inhouserpc', 'medium'],
    ]);
    expect(h.vocab.mentions).toEqual([['python', 'go', 'sql', 'kafka']]);
    expect(finishedLines()).toEqual([expect.objectContaining({ outcome: 'rules_only:covered', skills: { canonical: 4, unreviewed: 1, dropped: 0 }, requirements: null, requirementsStored: 'unchanged' })]);
  });

  it('a re-enrichment counts a skill once per posting: only ids that are new to the row', async () => {
    const h = harness(postgresJob(), { reply: postgresReply() });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.vocab.mentions).toHaveLength(1);
    // The same posting again: the row holds every id already (the unreviewed one is an alias now, and held).
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.vocab.calls).toHaveLength(2);
    expect(h.vocab.mentions).toHaveLength(1);
    // The posting now names one more skill.
    const more = `${POSTGRES}\nKafka experience helps.`;
    Object.assign(h.job, { description: more, descriptionPlain: more });
    h.deps.llm = { chatWithUsage: async (_m, o) => ({ content: JSON.stringify({ ...postgresReply(), skills: [{ skill: 'Kafka', kind: 'hard', required: false }] }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: o.model ?? 'm' }) };
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.vocab.mentions).toEqual([['postgresql', 'communication'], ['kafka']]);
    expect(h.job.skillIds).toEqual(['postgresql', 'featuretoggle', 'kafka']);
  });

  it('a user\'s own import reads the vocabulary and never adds to it: exact alias only, nothing counted', async () => {
    const h = harness(postgresJob({ visibility: 'private', ownerUserId: 'user_1', sourceBoard: 'user_import' }), { reply: postgresReply() });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.vocab.calls).toHaveLength(1);
    expect(h.vocab.calls[0]!.options).toMatchObject({ brand: 'roboapply', write: false });
    expect(h.job.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] },
      { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
      // Not known to the vocabulary and not created from a private posting: shown, no id.
      { skill: 'feature toggles', kind: 'hard', required: false, skillId: null, via: 'none' },
    ]);
    expect(h.job.skillIds).toEqual(['postgresql']);
    expect(h.vocab.mentions).toEqual([]);
    expect(h.vocab.snapshot.idOf('feature toggles')).toBeNull();
  });

  it('I8: a GoApply import without the AI consent makes no model call, and the vocabulary is asked by exact alias only', async () => {
    const job = { ...cnJob(), visibility: 'private', ownerUserId: 'user_cn', skills: ['SQL', 'Python', '向量时钟'] };
    const h = harness(job, { env: { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, consent: false, nearestRoles: ['data_engineer'] });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_ai_consent' });
    expect(h.calls).toHaveLength(0);
    expect(h.vocab.calls).toEqual([{ terms: ['sql', 'python', '向量时钟'], options: { brand: 'goapply', write: false, requestId: undefined } }]);
    expect(h.neighbourCalls).toEqual([]);
    expect(h.job.skillIds).toEqual(['sql', 'python']);
    expect(h.vocab.mentions).toEqual([]);
  });

  it('a machine guess is stored with its mark (`via: embedding`)', async () => {
    const text = 'You will look after our Postgres DB.';
    const h = harness(makeJob({ description: text, descriptionPlain: text }), {
      reply: intlModelReply({ sponsorship: null, citizenshipRequired: null, skills: [{ skill: 'Postgres DB', kind: 'hard', required: true }] }),
      skills: { guesses: { 'postgres db': 'postgresql' } },
    });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job.skillsDetail).toEqual([{ skill: 'postgres db', kind: 'hard', required: true, skillId: 'postgresql', via: 'embedding' }]);
    expect(h.job.skillIds).toEqual(['postgresql']);
  });

  it('a vocabulary that cannot be asked never fails the job: skills are stored without ids and the stored keyword row is left as it is', async () => {
    const h = harness(postgresJob(), { reply: postgresReply(), skills: { fails: true } });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.job.skills).toEqual(['postgres', 'postgresql', 'communication', 'feature toggles']);
    expect((h.job.skillsDetail as Array<{ skillId: string | null }>).every((d) => d.skillId === null)).toBe(true);
    expect(h.job.skillIds).toEqual([]);
    expect(h.keywords).toEqual([]);
    expect(h.vocab.mentions).toEqual([]);
    expect(h.job.enrichVersion).toBe(ENRICH_VERSION);
    expect(h.hooks).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('JOB_ENRICH', expect.stringContaining('the skill vocabulary could not be asked'), expect.objectContaining({ jobId: 'job_1' }));
  });

  it('ACCEPT: with the real port and no embedding key the alias path still fills ids; nothing is embedded, created or looked up in the database', async () => {
    skillsArea.setVocabularyForTests(fixtureVocabulary());
    try {
      const embedTexts = vi.fn();
      const loadDb = vi.fn();
      const h = harness(postgresJob(), { reply: postgresReply() });
      h.deps.skills = createEnrichSkillsPort({
        // No OPENAI_API_KEY and no EMBED_API_KEY: the embeddings client is unavailable for the brand.
        env: {},
        loadSkills: async () => skillsArea,
        loadEmbeddings: async () => ({ resolveEmbeddingConfig: (await import('../../../platform/embeddings/index.js')).resolveEmbeddingConfig, embedTexts }),
        loadDb,
      });
      // The mention count is the one statement this pass would send to the database: not part of this check.
      h.deps.skills.countMentions = async () => undefined;
      expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
      expect(h.job.skillsDetail).toEqual([
        { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] },
        { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
        // Unknown to the vocabulary: shown without an id until a pass with the embedding step maps or creates it.
        { skill: 'feature toggles', kind: 'hard', required: false, skillId: null, via: 'none' },
      ]);
      expect(h.job.skillIds).toEqual(['postgresql']);
      expect(h.keywords[0]!.keywords).toEqual([{ keyword: 'postgresql', importance: 'high', frequency: 1, skillId: 'postgresql' }]);
      expect(embedTexts).not.toHaveBeenCalled();
      expect(loadDb).not.toHaveBeenCalled();
      expect(skillsArea.current().idOf('feature toggles')).toBeNull();
    } finally {
      skillsArea.resetVocabularyForTests();
    }
  });

  it('a lost mention count does not fail the job', async () => {
    const h = harness(postgresJob(), { reply: postgresReply() });
    h.vocab.port.countMentions = async () => Promise.reject(new Error('db down'));
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.hooks).toHaveLength(1);
  });

  it('a dependency set without the vocabulary still enriches: no ids, and no keyword row is written over the stored one', async () => {
    const h = harness(postgresJob(), { reply: postgresReply() });
    const { skills: _skills, contentHash: _hash, ...bare } = h.deps;
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, bare)).status).toBe('enriched');
    expect(h.vocab.calls).toEqual([]);
    expect(h.job.skillIds).toEqual([]);
    expect(h.job.requirements ?? null).toBeNull();
    expect(h.keywords).toEqual([]);
  });

  it('a pass that stops before the model (budget spent) writes the keyword row by exact alias and makes no mapping call', async () => {
    const h = harness(makeJob({ skills: ['k8s', 'Postgres', 'made-up tool'] }), { budgetAllowed: false });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('deferred');
    expect(h.vocab.calls).toEqual([]);
    expect(h.keywords[0]!.keywords.slice(0, 2)).toEqual([
      { keyword: 'k8s', importance: 'medium', frequency: 0, skillId: 'kubernetes' },
      { keyword: 'postgres', importance: 'medium', frequency: 0, skillId: 'postgresql' },
    ]);
    expect(h.keywords[0]!.keywords.every((k) => k.skillId)).toBe(true);
    expect(h.vocab.snapshot.idOf('made-up tool')).toBeNull();
  });
});

describe('requirement lines, once per posting (SM-8)', () => {
  const REQ = [
    'Acme Analytics is hiring a Backend Engineer.',
    'Requirements:',
    '5+ years building backend services',
    'Nice to have: Kubernetes',
  ].join('\n');
  const reqJob = (over: Partial<EnrichJobRecord> = {}) => makeJob({ description: REQ, descriptionPlain: REQ, ...over });
  const reqReply = (requirements: unknown[]) => intlModelReply({ sponsorship: null, citizenshipRequired: null, summary: null, skills: [{ skill: 'Kubernetes', kind: 'hard', required: false }], requirements });
  const LINES = [
    { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
    { kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
    { kind: 'skill', text: 'Experience with Rust', importance: 'must' },
  ];

  it('ACCEPT: the two lines are stored with their exact texts; a line that is not in the posting is dropped and reported', async () => {
    vi.mocked(logger.info).mockClear();
    const h = harness(reqJob(), { reply: reqReply(LINES), env: { RA_SYSTEM_USER_ID: 'sys', LLM_ENRICH_MODEL: 'openai/gpt-cheap' } });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.job.requirements).toEqual({
      v: 1,
      // The key is the posting's text (title and requirement text), not its skill strings: the pass added
      // "kubernetes" to `skills`, and the next ingest refresh may write the provider's list back.
      contentHash: jobContentHash({ title: 'Backend Engineer', descriptionPlain: REQ, skills: [] }),
      model: 'openai/gpt-cheap',
      extractedAt: NOW.toISOString(),
      items: [
        { id: 'r1', kind: 'experience', text: '5+ years building backend services', importance: 'must' },
        { id: 'r2', kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
      ],
    });
    // Written only while the row still has no list (the scorer stores one when a row has none).
    expect(h.saves.find((u) => u.requirements !== undefined)).toMatchObject({ requirementsWere: null });
    expect(finishedLines()).toEqual([expect.objectContaining({ requirements: { kept: 2, notInPosting: 1, age: 0, logistics: 0 }, requirementsStored: 2 })]);
    expect(vi.mocked(logger.info).mock.calls.some(([, message]) => message === 'model claims dropped by the quote guard')).toBe(true);
  });

  it('ACCEPT: two people scored later are judged against the same stored checklist (a second pass over the same posting keeps the list)', async () => {
    const h = harness(reqJob(), { reply: reqReply(LINES) });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    const stored = h.job.requirements as StoredRequirements;
    // The model words its answer differently this time; the posting is the same.
    h.deps.llm = { chatWithUsage: async (_m, o) => ({ content: JSON.stringify(reqReply([LINES[1]])), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: o.model ?? 'm' }) };
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.job.requirements).toEqual(stored);
    expect(h.saves[h.saves.length - 1]!.requirements).toBeUndefined();
  });

  it('the list outlives an ingest refresh that writes the provider\'s skills back over the row (review: the key does not read the skills)', async () => {
    // A provider row: enrichment adds the skill the posting names to the provider's list.
    const h = harness(reqJob({ skills: ['backend'] }), { reply: reqReply(LINES) });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job.skills).toEqual(['backend', 'kubernetes']);
    const stored = h.job.requirements as StoredRequirements;
    expect(stored.contentHash).toBe(jobContentHash({ title: 'Backend Engineer', descriptionPlain: REQ, skills: [] }));
    // The row's own content hash moved with the skills; the list's key did not.
    expect(jobContentHash({ title: 'Backend Engineer', descriptionPlain: REQ, skills: h.job.skills })).not.toBe(stored.contentHash);
    // Ingest refreshes the row: `skills` is the provider's list again (ingest/upsert.ts), the text is the same.
    Object.assign(h.job, { skills: ['backend'] });
    // Whoever reads the list now, with the row as it reads now, computes the same key: the same checklist.
    expect(jobContentHash({ title: h.job.title, qualifications: h.job.qualifications, descriptionPlain: h.job.descriptionPlain, skills: [] })).toBe(stored.contentHash);
    // And a later pass of enrichment, model or rules only, leaves it alone.
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    expect(h.job.requirements).toEqual(stored);
    Object.assign(h.job, { skills: ['backend'] });
    h.deps.env = { RA_SYSTEM_USER_ID: 'sys' };
    expect(await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(h.job.requirements).toEqual(stored);
    expect(h.saves.slice(1).every((u) => u.requirements === undefined)).toBe(true);
  });

  it('a rules-only finish writes no list (the scorer extracts the lines itself, first writer wins)', async () => {
    const h = harness(reqJob(), { env: { RA_SYSTEM_USER_ID: 'sys' } });
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(h.job.requirements ?? null).toBeNull();
    expect(h.saves.every((u) => u.requirements === undefined)).toBe(true);
  });

  it('a changed posting gets a new list on a model pass, and loses its old one on a rules-only pass', async () => {
    const h = harness(reqJob(), { reply: reqReply(LINES) });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    const first = h.job.requirements as StoredRequirements;
    const edited = `${REQ}\nOn-call one week in six.`;
    Object.assign(h.job, { description: edited, descriptionPlain: edited });
    await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps);
    const second = h.job.requirements as StoredRequirements;
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(h.saves[h.saves.length - 1]).toMatchObject({ requirementsWere: first.contentHash });
    // The model is gone (no model configured): the list of the earlier text is removed, none is written.
    const again = `${edited}\nTravel twice a year.`;
    Object.assign(h.job, { description: again, descriptionPlain: again });
    h.deps.env = { RA_SYSTEM_USER_ID: 'sys' };
    expect(await enrichJob({ jobId: 'job_1', force: true }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(h.job.requirements).toBeNull();
  });

  it('GoApply: a line with an age and more keeps the more; a production year and a customer group are no age limit (review probes)', async () => {
    const mixed = ['某某机械招聘设备维修工。', '年龄25-35岁，大专及以上学历，3年以上机械维修经验', '熟悉2018年以后生产的数控设备的维修保养'].join('\n');
    const cn = (text: string) => makeJob({ id: 'job_cn', market: 'cn', title: '设备维修工', companyName: '某某机械', description: text, descriptionPlain: text, sourceBoard: 'bank_gohire' });
    const reply = (texts: string[]) => ({ taxonomyId: null, sponsorship: { status: 'not_stated', quote: null }, requirements: texts.map((text) => ({ kind: 'experience', text, importance: 'must' })) });
    const env = { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' };
    const h = harness(cn(mixed), { env, reply: reply(mixed.split('\n').slice(1)) });
    expect((await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).status).toBe('enriched');
    // The checklist is not empty: education and experience survive the age clause, and the equipment line is no age line.
    expect((h.job.requirements as StoredRequirements).items.map((i) => i.text)).toEqual(['大专及以上学历，3年以上机械维修经验', '熟悉2018年以后生产的数控设备的维修保养']);
    expect(h.job.marketTags).toEqual([{ tag: 'age_limit_stated', evidenceQuote: '年龄25-35岁，大专及以上学历，3年以上机械维修经验', evidenceUrl: null }]);

    // No age statement at all: no tag is written, whatever years and ages the work is about.
    const none = ['某某公司招聘市场专员。', '1、熟悉2018年以后生产的数控设备的维修保养；', '负责18-35岁女性护肤产品的市场推广', '产品主要面向35岁以下白领'].join('\n');
    const clean = harness(cn(none), { env, reply: reply(none.split('\n').slice(1)) });
    expect((await enrichJob({ jobId: 'job_cn' }, FIRST, clean.deps)).status).toBe('enriched');
    expect(clean.job.marketTags ?? null).toBeNull();
    expect((clean.job.requirements as StoredRequirements).items).toHaveLength(3);
  });

  it('GoApply: an age line gives the tag and no requirement', async () => {
    const posting = ['某某科技招聘数据分析师。', '任职要求：', '本科及以上学历', '年龄35周岁以下', '熟悉SQL和Python'].join('\n');
    const job = makeJob({ id: 'job_cn', market: 'cn', title: '数据分析师', companyName: '某某科技', description: posting, descriptionPlain: posting, sourceBoard: 'bank_gohire' });
    const h = harness(job, {
      env: { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' },
      reply: {
        taxonomyId: 'data_analyst',
        sponsorship: { status: 'not_stated', quote: null },
        requirements: [
          { kind: 'education', text: '本科及以上学历', importance: 'must' },
          { kind: 'experience', text: '年龄35周岁以下', importance: 'must' },
          { kind: 'skill', text: '熟悉SQL和Python', importance: 'must' },
        ],
      },
    });
    expect((await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).status).toBe('enriched');
    expect((h.job.requirements as StoredRequirements).items).toEqual([
      { id: 'r1', kind: 'education', text: '本科及以上学历', importance: 'must' },
      { id: 'r2', kind: 'skill', text: '熟悉SQL和Python', importance: 'must' },
    ]);
    expect(h.job.marketTags).toEqual([{ tag: 'age_limit_stated', evidenceQuote: '年龄35周岁以下', evidenceUrl: null }]);
    // The market hooks see the tag with the rest of the row.
    expect(h.hooks[0]!.job.marketTags).toEqual(h.job.marketTags);
  });
});

describe('version 3: gradual re-enrichment (SM-6, SM-8; I7)', () => {
  it('ACCEPT: a row at version 2 is enriched again without `force`, and after one pass has skillIds, keywords with ids and requirements', async () => {
    const text = ['We run Postgres in production.', 'Requirements:', '3+ years with Python and SQL'].join('\n');
    const v2 = makeJob({
      description: text,
      descriptionPlain: text,
      // As version 2 left it: free strings, no ids, no requirement list.
      skills: ['postgres', 'python'],
      skillsDetail: [{ skill: 'postgres', kind: 'hard', required: true }, { skill: 'python', kind: 'hard', required: true }],
      enrichedAt: new Date('2026-09-01T00:00:00.000Z'),
      enrichVersion: 2,
      enrichModel: 'openai/gpt-cheap',
    });
    const h = harness(v2, {
      reply: intlModelReply({ sponsorship: null, citizenshipRequired: null, skills: [{ skill: 'SQL', kind: 'hard', required: true }], requirements: [{ kind: 'experience', text: '3+ years with Python and SQL', importance: 'must' }] }),
    });
    const indexed: EnrichedJobRef[] = [];
    h.deps.enqueueIndex = async (ref) => {
      indexed.push(ref);
    };
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.job).toMatchObject({ enrichVersion: 3, skillIds: ['postgresql', 'python', 'sql'], skills: ['postgres', 'python', 'sql'] });
    expect(h.keywords[0]!.keywords.every((k) => typeof k.skillId === 'string')).toBe(true);
    expect((h.job.requirements as StoredRequirements).items).toEqual([{ id: 'r1', kind: 'experience', text: '3+ years with Python and SQL', importance: 'must' }]);
    // The search document and the vector follow: job.index is queued once for this enrichment.
    expect(indexed).toEqual([{ id: 'job_1', market: 'intl', enrichedAt: NOW }]);

    // At version 3 the same item is done: nothing runs, nothing is queued again.
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'already_enriched', hooksRerun: false });
    expect(h.calls).toHaveLength(1);
    expect(h.vocab.calls).toHaveLength(1);
    expect(indexed).toHaveLength(1);
    expect(ENRICH_VERSION).toBe(3);
    expect(enrichDedupeKey('job_1')).toBe('job.enrich:job_1:v3');
  });

  it('a version-2 row that needs no model still gets its ids on the rules-only pass, and job.index is queued once', async () => {
    const plain = 'Build APIs in Python and Go. Benefits include dental.';
    const h = harness(
      makeJob({
        descriptionPlain: plain,
        description: plain,
        primaryTaxonomyId: 'backend_engineer',
        taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
        seniority: 'mid',
        skills: ['python', 'go', 'sql', 'kafka', 'terraform'],
        enrichedAt: new Date('2026-09-01T00:00:00.000Z'),
        enrichVersion: 2,
        enrichModel: RULES_CHECKED_MODEL,
      }),
    );
    const indexed: EnrichedJobRef[] = [];
    h.deps.enqueueIndex = async (ref) => {
      indexed.push(ref);
    };
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'covered' });
    expect(h.job).toMatchObject({ enrichVersion: 3, skillIds: ['python', 'go', 'sql', 'kafka', 'terraform'] });
    expect(h.job.requirements ?? null).toBeNull();
    expect(indexed).toHaveLength(1);
  });
});

describe('skills-only pass (a row mapped while the embedding step was off is mapped again without a model call)', () => {
  const POSTGRES = [
    'Acme Analytics is hiring a Backend Engineer.',
    'We run Postgres in production, and PostgreSQL tuning is weekly work.',
    'You will also keep our feature toggles tidy.',
    'Requirements:',
    '3+ years with Postgres',
  ].join('\n');
  const reply = () =>
    intlModelReply({
      sponsorship: null,
      citizenshipRequired: null,
      skills: [{ skill: 'PostgreSQL', kind: 'hard', required: true }, { skill: 'feature toggles', kind: 'hard', required: true }],
      requirements: [{ kind: 'experience', text: '3+ years with Postgres', importance: 'must' }],
    });

  /** A row enriched at this version while the embedding step was off, with everything a full pass leaves behind. */
  async function enrichedWhileOff(over: Partial<EnrichJobRecord> = {}) {
    const h = harness(makeJob({ description: POSTGRES, descriptionPlain: POSTGRES, ...over }), { reply: reply(), skills: { embeddingOff: true }, env: { RA_SYSTEM_USER_ID: 'sys', LLM_ENRICH_MODEL: 'openai/gpt-cheap' } });
    const indexed: EnrichedJobRef[] = [];
    h.deps.enqueueIndex = async (ref) => {
      indexed.push(ref);
    };
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).status).toBe('enriched');
    return { h, indexed };
  }

  it('the finding: such a row is stamped with the version, holds a skill with no id, and no ordinary item ever maps it', async () => {
    const { h, indexed } = await enrichedWhileOff();
    expect(h.job.enrichVersion).toBe(ENRICH_VERSION);
    expect(h.job.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
      { skill: 'feature toggles', kind: 'hard', required: true, skillId: null, via: 'none' },
    ]);
    expect(h.job.skillIds).toEqual(['postgresql']);
    // The embedding step works now, and the item jobs-maintain would queue still does nothing for this row.
    h.vocab.embeddingOff = false;
    expect(await enrichJob({ jobId: 'job_1' }, FIRST, h.deps)).toEqual({ status: 'already_enriched', hooksRerun: false });
    expect(h.job.skillIds).toEqual(['postgresql']);
    expect(indexed).toHaveLength(1);
  });

  it('maps the skills again: ids, keywords and the index follow; no model call, no budget, no hook, no other column', async () => {
    const { h, indexed } = await enrichedWhileOff();
    const before = { ...h.job };
    h.vocab.embeddingOff = false;
    h.deps.budget = async () => Promise.reject(new Error('the budget is not read'));
    h.deps.aiAllowed = async () => Promise.reject(new Error('the consent is not read'));
    h.deps.now = () => new Date('2026-10-12T08:00:00.000Z');
    vi.mocked(logger.info).mockClear();

    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, { ...FIRST, requestId: 'job-enrich-w7' }, h.deps)).toEqual({ status: 'skills_remapped', changed: true, skillIds: 2 });
    expect(h.calls).toHaveLength(1);
    expect(h.costs).toHaveLength(1);
    expect(h.hooks).toHaveLength(1);
    // One vocabulary call: the row's own strings and its stored entries, as a public posting (the embedding step may run).
    expect(h.vocab.calls[h.vocab.calls.length - 1]).toEqual({ terms: ['postgresql', 'feature toggles'], options: { brand: 'roboapply', write: true, requestId: 'job-enrich-w7' } });
    // Only the skill columns were written.
    const save = h.saves[h.saves.length - 1]!;
    expect(Object.keys(save).sort()).toEqual(['searchText', 'skillIds', 'skills', 'skillsDetail']);
    expect(h.job.skillsDetail).toEqual([
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
      // What the model said of the skill (required, hard) is what the row stored.
      { skill: 'feature toggles', kind: 'hard', required: true, skillId: 'featuretoggle', via: 'new' },
    ]);
    expect(h.job.skillIds).toEqual(['postgresql', 'featuretoggle']);
    for (const column of ['enrichedAt', 'enrichVersion', 'enrichModel', 'requirements', 'summary', 'seniority', 'primaryTaxonomyId', 'marketTags', 'sponsorship'] as const) expect(h.job[column], column).toEqual(before[column]);
    // The keyword row is rewritten with the new skill; the model and the cost of the pass that paid for it stay.
    const row = h.keywords[h.keywords.length - 1]!;
    expect(row.keepModelAndCost).toBe(true);
    expect(row.keywords.map((k) => [k.keyword, k.skillId, k.importance])).toEqual([
      ['postgresql', 'postgresql', 'high'],
      ['feature toggles', 'featuretoggle', 'high'],
    ]);
    // A skill created on this pass already counts this posting; the one the row held is not counted again.
    expect(h.vocab.mentions).toHaveLength(1);
    // The search document carries the canonical labels: one more index run, told apart by the time of this pass.
    expect(indexed).toEqual([
      { id: 'job_1', market: 'intl', enrichedAt: NOW },
      { id: 'job_1', market: 'intl', enrichedAt: new Date('2026-10-12T08:00:00.000Z') },
    ]);
    expect(vi.mocked(logger.info).mock.calls.filter(([, message]) => message === 'skills mapped again').map(([, , meta]) => meta)).toEqual([
      { jobId: 'job_1', market: 'intl', changed: true, skills: { canonical: 1, unreviewed: 1, dropped: 0 }, skillIds: 2 },
    ]);

    // Delivered again: the row already holds these skills. Nothing is saved or indexed; the keyword row is current.
    const saves = h.saves.length;
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, h.deps)).toEqual({ status: 'skills_remapped', changed: false, skillIds: 2 });
    expect(h.saves).toHaveLength(saves);
    expect(indexed).toHaveLength(2);
    expect(h.calls).toHaveLength(1);
  });

  it('a mapped skill the row did not hold counts one mention; a machine guess keeps its mark', async () => {
    const { h } = await enrichedWhileOff();
    h.vocab.embeddingOff = false;
    // The neighbour step now maps the string to a reviewed skill.
    const guessing = fakeSkillsPort({ snapshot: h.vocab.snapshot, guesses: { 'feature toggles': 'featureflag' } });
    h.deps.skills = guessing.port;
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, h.deps)).toEqual({ status: 'skills_remapped', changed: true, skillIds: 2 });
    expect((h.job.skillsDetail as Array<Record<string, unknown>>)[1]).toEqual({ skill: 'feature toggles', kind: 'hard', required: true, skillId: 'featureflag', via: 'embedding' });
    expect(guessing.mentions).toEqual([['featureflag']]);
    // A guess is never a keyword.
    expect(h.keywords[h.keywords.length - 1]!.keywords.map((k) => k.skillId)).toEqual(['postgresql']);
  });

  it('a user\'s own import is mapped by exact alias only, as on a full pass', async () => {
    const { h } = await enrichedWhileOff({ visibility: 'private', ownerUserId: 'user_1', sourceBoard: 'user_import' });
    h.vocab.embeddingOff = false;
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, h.deps)).toEqual({ status: 'skills_remapped', changed: false, skillIds: 1 });
    expect(h.vocab.calls[h.vocab.calls.length - 1]!.options).toMatchObject({ write: false });
    expect(h.vocab.mentions).toEqual([]);
    expect(h.vocab.snapshot.idOf('feature toggles')).toBeNull();
  });

  it('a vocabulary that cannot be asked leaves the row as it is: its ids are not taken away', async () => {
    const { h, indexed } = await enrichedWhileOff();
    const saves = h.saves.length;
    const keywords = h.keywords.length;
    h.deps.skills = fakeSkillsPort({ fails: true }).port;
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, h.deps)).toEqual({ status: 'skills_remapped', changed: false, skillIds: 1 });
    expect(h.job.skillIds).toEqual(['postgresql']);
    expect(h.saves).toHaveLength(saves);
    expect(h.keywords).toHaveLength(keywords);
    expect(indexed).toHaveLength(1);
    // The same without a vocabulary at all.
    const { skills: _skills, ...bare } = h.deps;
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, bare)).toEqual({ status: 'skills_remapped', changed: false, skillIds: 1 });
  });

  it('a row that is not enriched at this version gets the full pass instead (it maps the skills too); missing and archived rows are skipped', async () => {
    const h = harness(makeJob({ description: POSTGRES, descriptionPlain: POSTGRES, enrichedAt: new Date('2026-09-01T00:00:00.000Z'), enrichVersion: 2, enrichModel: 'openai/gpt-cheap' }), { reply: reply() });
    expect((await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, h.deps)).status).toBe('enriched');
    expect(h.calls).toHaveLength(1);
    expect(h.job).toMatchObject({ enrichVersion: ENRICH_VERSION, skillIds: ['postgresql', 'featuretoggle'] });
    const never = harness(makeJob({ description: POSTGRES, descriptionPlain: POSTGRES }), { reply: reply() });
    expect((await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, never.deps)).status).toBe('enriched');
    expect(await enrichJob({ jobId: 'nope', skillsOnly: true }, FIRST, h.deps)).toEqual({ status: 'not_found' });
    const archived = harness(makeJob({ archivedAt: new Date('2026-09-01'), enrichedAt: new Date('2026-09-01'), enrichVersion: ENRICH_VERSION }));
    expect(await enrichJob({ jobId: 'job_1', skillsOnly: true }, FIRST, archived.deps)).toEqual({ status: 'archived' });
    expect(archived.vocab.calls).toEqual([]);
  });
});

describe('nearest roles by title embedding (SM-2)', () => {
  const NEAREST = ['strategy_manager', 'program_manager', 'operations_manager'];
  const weak = (over: Partial<EnrichJobRecord> = {}) => makeJob({ title: 'Head of Special Projects', titleNormalized: 'head of special projects', ...over });

  it('a public posting with a weak title: the step is asked once and its roles are offered to the model', async () => {
    const h = harness(weak(), { nearestRoles: NEAREST, reply: intlModelReply({ taxonomyId: 'program_manager' }) });
    expect((await enrichJob({ jobId: 'job_1' }, { ...FIRST, requestId: 'req-3' }, h.deps)).status).toBe('enriched');
    expect(h.neighbourCalls).toEqual([{ title: 'Head of Special Projects', ctx: { brand: 'roboapply', requestId: 'req-3' } }]);
    for (const id of NEAREST) expect(h.calls[0]!.user).toContain(`- ${id}:`);
    // The model may pick one of them: it was offered.
    expect(h.job.primaryTaxonomyId).toBe('program_manager');
  });

  it('is not asked for a title that names its role, for a user\'s import, or when no model will run', async () => {
    const exact = harness(makeJob(), { nearestRoles: NEAREST });
    await enrichJob({ jobId: 'job_1' }, FIRST, exact.deps);
    expect(exact.calls).toHaveLength(1);
    expect(exact.neighbourCalls).toEqual([]);

    // An import is enriched inside its request, and its title is its owner's data.
    const imported = harness(weak({ visibility: 'private', ownerUserId: 'user_1' }), { nearestRoles: NEAREST });
    await enrichJob({ jobId: 'job_1' }, FIRST, imported.deps);
    expect(imported.calls).toHaveLength(1);
    expect(imported.neighbourCalls).toEqual([]);

    for (const options of [{ env: { RA_SYSTEM_USER_ID: 'sys' } }, { budgetAllowed: false }, { budgetLimit: 0 }]) {
      const none = harness(weak(), { nearestRoles: NEAREST, ...options });
      await enrichJob({ jobId: 'job_1' }, FIRST, none.deps);
      expect(none.calls).toHaveLength(0);
      expect(none.neighbourCalls).toEqual([]);
    }
  });

  it('no neighbours (the client is unavailable) or a failing step: the candidate list is the deterministic one and the job is enriched', async () => {
    const plain = harness(weak());
    await enrichJob({ jobId: 'job_1' }, FIRST, plain.deps);
    const empty = harness(weak(), { nearestRoles: [] });
    await enrichJob({ jobId: 'job_1' }, FIRST, empty.deps);
    expect(empty.calls[0]!.user).toBe(plain.calls[0]!.user);
    const failing = harness(weak(), { nearestRoles: async () => Promise.reject(new Error('embeddings down')) });
    expect((await enrichJob({ jobId: 'job_1' }, FIRST, failing.deps)).status).toBe('enriched');
    expect(failing.calls[0]!.user).toBe(plain.calls[0]!.user);
  });
});

describe('sponsorship names its source (JI-11)', () => {
  it('a posting that says it sponsors ends with the value, its quote and the source, also over a provider\'s reading', async () => {
    const text = INTL_POSTING.replace('We are unable to sponsor work visas for this role.', 'Visa sponsorship is available for this role.');
    const h = harness(makeJob({ description: text, descriptionPlain: text, sponsorship: 'not_offered', sponsorshipSource: 'provider:activejobs_feed' }), {
      reply: intlModelReply({ sponsorship: { status: 'offered', quote: 'Visa sponsorship is available for this role.' } }),
    });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job).toMatchObject({ sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available for this role.', sponsorshipSource: 'posting_quote' });
  });

  it('a provider\'s reading with no sponsorship sentence in the text keeps both columns', async () => {
    const quiet = INTL_POSTING.split('\n')
      .filter((l) => !/sponsor/i.test(l))
      .join('\n');
    const h = harness(makeJob({ description: quiet, descriptionPlain: quiet, sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed' }), {
      reply: intlModelReply({ sponsorship: { status: 'not_stated', quote: null } }),
    });
    await enrichJob({ jobId: 'job_1' }, FIRST, h.deps);
    expect(h.job).toMatchObject({ sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed', sponsorshipEvidence: null });
    expect(h.saves.every((u) => !('sponsorship' in u) && !('sponsorshipSource' in u))).toBe(true);
  });
});

describe('default dependencies', () => {
  it('wire the vocabulary, the content hash of features/match and the nearest roles', async () => {
    const deps = defaultEnrichDeps();
    expect(typeof deps.skills?.canonicalize).toBe('function');
    expect(typeof deps.roleNeighbours).toBe('function');
    // One vocabulary port and one set of role vectors per process, whatever asks for the dependencies.
    expect(defaultEnrichDeps().skills).toBe(deps.skills);
    expect(defaultEnrichDeps().roleNeighbours).toBe(deps.roleNeighbours);
    const hash = await deps.contentHash!();
    const row = { title: 'Backend Engineer', qualifications: null, descriptionPlain: 'Build APIs.', skills: ['python'] };
    expect(hash(row)).toBe(jobContentHash(row));
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

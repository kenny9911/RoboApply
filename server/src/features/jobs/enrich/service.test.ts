// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../lib/modelPricing.js', () => ({ calculateModelCost: vi.fn(() => 0.0012) }));

import { getCurrentBrandId, runWithBrand } from '../../../lib/requestContext.js';
import { SHARED_COST_USER_ID } from '../../../roboapply/v2/lib/raFeatureCatalog.js';
import { enrichDedupeKey, enrichJob, systemUserIdFor, type EnrichDeps } from './service.js';
import type { EnrichLlmOptions } from './agent.js';
import type { EnrichJobRecord, EnrichUpdate } from './reconcile.js';
import type { EnrichCostEntry, KeywordRow } from './repository.js';
import { ENRICH_VERSION, RULES_ONLY_MODEL } from './schema.js';
import { CN_POSTING, INTL_POSTING, intlModelReply, makeJob } from './__tests__/fixtures.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const FIRST = { attempt: 1, maxAttempts: 5 };

interface Harness {
  deps: EnrichDeps;
  job: EnrichJobRecord;
  saves: EnrichUpdate[];
  keywords: KeywordRow[];
  costs: EnrichCostEntry[];
  calls: Array<{ brand: string | undefined; options: EnrichLlmOptions; user: string }>;
  hooks: Array<{ job: Record<string, unknown>; ctx: Record<string, unknown> }>;
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
    env: options.env ?? { RA_SYSTEM_USER_ID: 'sys_roboapply' },
    now: () => NOW,
  };
  return h;
}

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

  it('runs a GoApply job on the CN model profile under runWithBrand(goapply), whatever the ambient brand', async () => {
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
    expect(h.calls[0]!.options.provider).toBe('deepseek');
    expect(h.calls[0]!.user).toContain('MARKET: mainland China');
    expect(h.job.employerTags).toEqual(['soe']);
    expect(h.costs[0]).toMatchObject({ userId: 'sys_goapply', brand: 'goapply', market: 'cn' });
    expect(h.hooks[0]!.ctx).toMatchObject({ brand: 'goapply', market: 'cn' });
  });

  it('GoApply never falls back to an unprefixed model: no CN model → rules only, zero LLM calls', async () => {
    const h = harness(cnJob(), { env: { LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'openai/gpt-default' } });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
    expect(h.calls).toHaveLength(0);
    expect(h.job).toMatchObject({ enrichModel: RULES_ONLY_MODEL, enrichVersion: ENRICH_VERSION, enrichedAt: NOW });
    expect(h.keywords[0]!.modelUsed).toBe(RULES_ONLY_MODEL);
    expect(h.costs).toHaveLength(0);
    expect(h.hooks).toHaveLength(1);
  });

  it('GoApply refuses a model id that is not pinned to a domestic provider: rules only, zero LLM calls', async () => {
    for (const model of ['deepseek-chat', 'openrouter/deepseek/deepseek-chat', 'openai/gpt-cheap']) {
      const h = harness(cnJob(), { env: { CN_LLM_ENRICH_MODEL: model } });
      expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_model' });
      expect(h.calls).toHaveLength(0);
    }
  });

  it("makes zero LLM calls for a GoApply user's import without AI consent", async () => {
    const job = { ...cnJob(), visibility: 'private', ownerUserId: 'user_cn' };
    const h = harness(job, { env: { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }, consent: false });
    expect(await enrichJob({ jobId: 'job_cn' }, FIRST, h.deps)).toEqual({ status: 'rules_only', reason: 'no_ai_consent' });
    expect(h.aiAllowed).toHaveBeenCalledWith('user_cn');
    expect(h.calls).toHaveLength(0);
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
    expect(h.job.enrichModel).toBe(RULES_ONLY_MODEL);
    expect(h.keywords[0]!.keywords.slice(0, 5).map((k) => k.keyword)).toEqual(['python', 'go', 'sql', 'kafka', 'terraform']);
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
    expect(h.job).toMatchObject({ enrichModel: RULES_ONLY_MODEL, enrichVersion: ENRICH_VERSION });
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
  it('logs cost under the brand system user, else the shared-cost sentinel', () => {
    expect(systemUserIdFor('intl', { RA_SYSTEM_USER_ID: 'sys_r' })).toBe('sys_r');
    expect(systemUserIdFor('cn', { RA_SYSTEM_USER_ID: 'sys_r', CN_RA_SYSTEM_USER_ID: 'sys_g' })).toBe('sys_g');
    expect(systemUserIdFor('cn', { RA_SYSTEM_USER_ID: 'sys_r' })).toBe(SHARED_COST_USER_ID);
    expect(systemUserIdFor('intl', {})).toBe(SHARED_COST_USER_ID);
  });

  it('builds the dedupe key from the job id and version', () => {
    expect(enrichDedupeKey('j1')).toBe(`job.enrich:j1:v${ENRICH_VERSION}`);
    expect(enrichDedupeKey('j1', 7)).toBe('job.enrich:j1:v7');
  });
});

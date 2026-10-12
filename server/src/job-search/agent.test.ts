// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
/** The database the configured gate reads (auth-cn phone binding); empty unless a test fills it. */
const db = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../lib/prisma.js', () => ({ default: db }));
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const llm = vi.hoisted(() => ({ chat: vi.fn(), model: vi.fn() }));
vi.mock('../services/llm/LLMService.js', () => ({ llmService: { chat: llm.chat } }));
vi.mock('../lib/llm/llmModels.js', () => ({ getModelSetting: llm.model }));
import { configuredSearchPlanner, createJobSearchAgent, createPlannerGate, JobSearchAgentUnavailableError, JobSearchAiOffError, JobSearchAiUnavailableError, JobSearchPhoneBindingError, type SearchPlanner } from './agent.js';
import { getBrand } from '../platform/brand/registry.js';
import { setConsentLookup } from '../platform/consent/index.js';
import { parseAgentPlan, parseAgentSearchInput } from './agent-validation.js';
import { SearchQuotaError } from './quota.js';
import { JobSearchValidationError } from './validation.js';
import { getCurrentUserId } from '../lib/requestContext.js';
import { createJobSearchService, type SearchProvider } from './service.js';
import { createIndexProvider, type IndexFeedItem } from './index-provider.js';
import { FILTER_FIELDS } from '../features/search/contract.js';
import type { AgentSearchInput, ProviderInfo, SearchJob, SearchResult } from './types.js';
import type { ProviderJob } from './normalization.js';

const INPUT = { request: 'Find senior software engineer jobs in Taipei.' };
const CONTEXT = { userId: 'owner', requestId: 'agent-fixture' };
const PLAN = { queries: ['software engineer', 'backend engineer'], country: 'tw', location: 'Taipei', unverifiedPreferences: [] };
const PROVIDERS: ProviderInfo[] = [{ id: 'jsearch', name: 'JSearch', enabled: true, sourceType: 'aggregator', homepage: 'https://www.openwebninja.com/api/jsearch' }];

function job(overrides: Partial<SearchJob> = {}): SearchJob {
  return {
    id: 'job_fixture', title: 'Software Engineer', company: 'Fixture Employer', companyLogoUrl: null,
    location: 'Taipei', country: 'TW', description: 'Fixture description.', applyUrl: 'https://careers.example.com/jobs/1',
    sourceUrl: null, provider: 'jsearch', applyIsDirect: true,
    sources: [{ provider: 'jsearch', id: 'jsearch:1', applyUrl: 'https://careers.example.com/jobs/1', publisher: null }],
    postedAt: '2026-09-12T00:00:00Z', fetchedAt: '2026-09-14T00:00:00Z', remote: true, employmentType: 'full_time', salary: null,
    ...overrides,
  };
}
function result(jobs = [job()]): SearchResult {
  return { jobs, meta: { totalReturned: jobs.length, deduplicated: 0, partial: false,
    providers: [{ id: 'jsearch', name: 'JSearch', status: jobs.length ? 'ok' : 'empty', resultCount: jobs.length }],
    searchedAt: '2026-09-14T00:00:00Z', cache: 'miss' } };
}
function setup(plan: unknown = PLAN) {
  const events: string[] = [];
  const service = { providers: vi.fn(() => PROVIDERS), search: vi.fn(async (input) => { events.push(`search:${input.query}`); return structuredClone(result()); }) };
  let counter = 0;
  const quota = {
    reserve: vi.fn(async () => { events.push(`reserve:${++counter}`); return `reservation-${counter}`; }),
    finish: vi.fn(async (id: string) => { events.push(`finish:${id}`); }),
  };
  const planner = vi.fn<SearchPlanner>(async () => { events.push('plan'); return structuredClone(plan); });
  const agent = createJobSearchAgent({ service: service as never, quota: quota as never, planner });
  return { agent, service, quota, planner, events };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('agent input and strict planning schema', () => {
  it('preserves absent overrides and explicitly unrestricted remote/location', () => {
    expect(parseAgentSearchInput(INPUT)).toEqual(INPUT);
    expect(parseAgentSearchInput({ ...INPUT, remote: false, location: '', country: 'TW' })).toEqual({ ...INPUT, remote: false, location: '', country: 'tw' });
  });
  it.each([
    { request: 'too short' }, { request: 'x'.repeat(2001) }, { ...INPUT, query: 'engineer' },
    { ...INPUT, country: 'ZZ' }, { ...INPUT, remote: 'true' }, { ...INPUT, limit: '10' },
    { ...INPUT, providers: 'jsearch' }, { ...INPUT, linkedinOnly: 'yes' }, { ...INPUT, locale: '<script>' },
  ])('rejects invalid requests before planning or billed work %j', async (value) => {
    const { agent, planner, quota, service } = setup();
    await expect(agent.search(value, CONTEXT)).rejects.toMatchObject({ name: 'JobSearchValidationError' });
    expect(planner).not.toHaveBeenCalled(); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });
  it.each([
    'not JSON', '```json\n{}\n```', { queries: [], unverifiedPreferences: 'bad' },
    { ...PLAN, queries: ['one', 'two', 'three'] }, { ...PLAN, queries: ['Engineer', 'engineer'] },
    { ...PLAN, queries: ['https://example.com/jobs'] }, { ...PLAN, providers: ['linkedin'] },
    { ...PLAN, remote: 'true' }, { ...PLAN, country: 'ZZ' }, { ...PLAN, unverifiedPreferences: 'none' },
  ])('fails closed for malformed plans without searching prose %j', async (plan) => {
    const { agent, quota, service } = setup(plan);
    await expect(agent.search(INPUT, CONTEXT)).rejects.toBeInstanceOf(JobSearchAgentUnavailableError);
    expect(quota.reserve).toHaveBeenCalledTimes(1);
    expect(quota.finish).toHaveBeenCalledWith('reservation-1', 503, expect.any(Number), undefined);
    expect(service.search).not.toHaveBeenCalled();
  });
  it('accepts one role and a strictly typed partial criteria object', () => {
    expect(parseAgentPlan(JSON.stringify({ queries: ['senior engineer'], remote: true, unverifiedPreferences: [] })))
      .toEqual({ queries: ['senior engineer'], remote: true, unverifiedPreferences: [] });
  });
  it('requests a role for the explicit roleless-intent sentinel, rather than reporting an outage', async () => {
    const { agent, quota, service } = setup({ queries: [], unverifiedPreferences: [] });
    await expect(agent.search({ request: 'I want a job somewhere in Taipei.' }, CONTEXT)).rejects.toMatchObject({ name: 'JobSearchValidationError', field: 'request', message: expect.stringContaining('job role') });
    expect(quota.finish).toHaveBeenCalledWith('reservation-1', 400, expect.any(Number), undefined);
    expect(service.search).not.toHaveBeenCalled();
  });
});

describe('planned search and durable ordering', () => {
  it('reserves before the model and before each of two queries, then deduplicates', async () => {
    const { agent, events, quota, service } = setup();
    const response = await agent.search(INPUT, CONTEXT);
    expect(events).toEqual(['reserve:1', 'plan', 'search:software engineer', 'finish:reservation-1', 'reserve:2', 'search:backend engineer', 'finish:reservation-2']);
    expect(response.agent).toMatchObject({ mode: 'planned', queries: PLAN.queries, criteria: { country: 'tw', location: 'Taipei' } });
    // A plan that names no topic: nothing is ranked by, and no source is asked for an order.
    expect(response.agent.rankedBy).toEqual([]);
    expect(service.search.mock.calls.every(call => !('rankBy' in call[1]))).toBe(true);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'software engineer', country: 'tw', location: 'Taipei' }), expect.objectContaining({ audience: 'website', requestId: 'agent-fixture' }));
    expect(response.jobs).toHaveLength(1); expect(response.meta.deduplicated).toBe(1);
    expect(response.searches).toHaveLength(2); expect(quota.reserve).toHaveBeenCalledTimes(2);
  });
  it('uses NLP criteria by default and overrides only explicitly supplied fields', async () => {
    const { agent, service } = setup({ ...PLAN, queries: ['engineer'], remote: true, datePosted: 'week', employmentTypes: ['contract'] });
    const response = await agent.search({ ...INPUT, country: 'us', location: '', remote: false, datePosted: 'all' }, CONTEXT);
    expect(response.agent.criteria).toEqual({ country: 'us', remote: false, datePosted: 'all', employmentTypes: ['contract'] });
    expect(service.search).toHaveBeenCalledWith(expect.not.objectContaining({ location: 'Taipei' }), expect.anything());
    expect(service.search.mock.calls[0][0].remote).toBe(false);
  });
  it('defaults an omitted country to US without inferring it from locale', async () => {
    const { agent } = setup({ queries: ['engineer'], unverifiedPreferences: [] });
    expect((await agent.search({ ...INPUT, locale: 'zh-TW' }, CONTEXT)).agent.criteria.country).toBe('us');
  });
  it('exposes omitted salary, sponsorship, and soft remote wishes without restrictive remote filtering', async () => {
    const { agent, service } = setup({ queries: ['engineer'], remote: true, unverifiedPreferences: [] });
    const request = 'Find engineer jobs with salary above $120k and visa sponsorship; ideally remote.';
    const response = await agent.search({ request }, CONTEXT);
    expect(response.agent.criteria.remote).toBeUndefined();
    expect(response.agent.unverifiedPreferences.join(' ')).toContain('$120k');
    expect(response.agent.unverifiedPreferences.join(' ')).toContain('visa sponsorship');
    expect(response.agent.unverifiedPreferences.join(' ')).toContain('ideally remote');
    expect(service.search.mock.calls[0][0].remote).toBeUndefined();
  });
  it('enforces an explicit remote override even when NLP describes a soft preference', async () => {
    const { agent } = setup({ queries: ['engineer'], unverifiedPreferences: [] });
    expect((await agent.search({ request: 'Find engineers, ideally remote.', remote: true }, CONTEXT)).agent.criteria.remote).toBe(true);
  });
  it('denies a first reservation before any model or provider call', async () => {
    const { agent, planner, quota, service } = setup(); quota.reserve.mockRejectedValueOnce(new SearchQuotaError(60));
    await expect(agent.search(INPUT, CONTEXT)).rejects.toMatchObject({ status: 429 });
    expect(planner).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });
  it('preserves first-query results and marks the second quota rejection explicitly', async () => {
    const { agent, quota, service } = setup(); quota.reserve.mockResolvedValueOnce('reservation-1').mockRejectedValueOnce(new SearchQuotaError(60));
    const response = await agent.search(INPUT, CONTEXT);
    expect(response.jobs).toHaveLength(1); expect(response.meta.partial).toBe(true);
    expect(response.searches[1]).toMatchObject({ query: 'backend engineer', providers: [], error: { code: 'rate_limited' } });
    expect(service.search).toHaveBeenCalledTimes(1); expect(quota.finish).toHaveBeenCalledTimes(1);
  });
  it('keeps successful jobs and per-query failure diagnostics when query two throws', async () => {
    const { agent, service } = setup(); service.search.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('private upstream failure'));
    const response = await agent.search(INPUT, CONTEXT);
    expect(response.jobs).toHaveLength(1); expect(response.meta.partial).toBe(true);
    expect(response.meta.providers[0]).toMatchObject({ status: 'ok', resultCount: 1 });
    expect(response.searches[1].providers[0].status).toBe('error');
    expect(JSON.stringify(response)).not.toContain('private upstream failure');
  });
  it('tries the second planned variant after a failed first query without losing failure status', async () => {
    const { agent, service } = setup(); service.search.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(result());
    const response = await agent.search(INPUT, CONTEXT);
    expect(response.jobs).toHaveLength(1); expect(response.meta.partial).toBe(true);
    expect(response.searches[0].error).toBeDefined(); expect(response.searches[1].providers[0].status).toBe('ok');
  });
});

describe('cancellation and model runtime', () => {
  // Browser pass of HANDOFF step 5: one answer with a field the strict check refuses failed the whole search.
  it('asks the model once more when its answer is outside the plan\'s shape, and gives up after the second', async () => {
    const { agent, planner, service } = setup();
    planner.mockResolvedValueOnce({ ...PLAN, rankedBy: ['Rust'] });
    const response = await agent.search(INPUT, CONTEXT);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(response.agent.queries).toEqual(PLAN.queries);
    expect(service.search).toHaveBeenCalled();

    const broken = setup({ ...PLAN, providers: ['jsearch'] });
    await expect(broken.agent.search(INPUT, CONTEXT)).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(broken.planner).toHaveBeenCalledTimes(2);
    expect(broken.service.search).not.toHaveBeenCalled();
  });
  it('does not ask again when the request names no role', async () => {
    const { agent, planner } = setup({ queries: [], unverifiedPreferences: [] });
    await expect(agent.search({ request: 'I want a job somewhere in Taipei.' }, CONTEXT)).rejects.toMatchObject({ name: 'JobSearchValidationError' });
    expect(planner).toHaveBeenCalledTimes(1);
  });
  it('bounds a nonresponsive model and aborts its signal', async () => {
    const { service, quota } = setup(); let signal: AbortSignal | undefined;
    const agent = createJobSearchAgent({ service: service as never, quota: quota as never, planningTimeoutMs: 50, planner: async (_input, context) => { signal = context.signal; return new Promise(() => {}); } });
    await expect(agent.search(INPUT, CONTEXT)).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(signal?.aborted).toBe(true); expect(service.search).not.toHaveBeenCalled();
    expect(quota.finish).toHaveBeenCalledWith('reservation-1', 503, expect.any(Number), undefined);
  });
  it('cancels after the first search without reserving a second one', async () => {
    const { agent, service, quota } = setup(); const controller = new AbortController();
    service.search.mockImplementationOnce(async () => { controller.abort(); return result(); });
    await expect(agent.search(INPUT, { ...CONTEXT, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(quota.reserve).toHaveBeenCalledTimes(1); expect(service.search).toHaveBeenCalledTimes(1);
    expect(quota.finish).toHaveBeenCalledWith('reservation-1', 499, expect.any(Number), undefined);
  });
  it('cancels while a second reservation is pending without starting its upstream query', async () => {
    const { agent, service, quota } = setup(); const controller = new AbortController();
    quota.reserve.mockResolvedValueOnce('reservation-1').mockImplementationOnce(async () => { controller.abort(); return 'reservation-2'; });
    await expect(agent.search(INPUT, { ...CONTEXT, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.search).toHaveBeenCalledTimes(1);
    expect(quota.finish).toHaveBeenCalledWith('reservation-2', 499, expect.any(Number), undefined);
  });
  it('passes configured intent-parser model, JSON mode, caller identity and cancellation to existing LLMService', async () => {
    llm.model.mockImplementation(key => key === 'intentParser' ? 'configured-intent-model' : undefined);
    llm.chat.mockImplementation(async () => { expect(getCurrentUserId()).toBe('owner'); return JSON.stringify(PLAN); });
    const signal = new AbortController().signal;
    const response = await configuredSearchPlanner(INPUT, { ...CONTEXT, signal });
    expect(response).toBe(JSON.stringify(PLAN));
    expect(llm.chat).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ role: 'system' })]), expect.objectContaining({ model: 'configured-intent-model', responseFormat: 'json_object', signal, requestId: 'agent-fixture' }));
  });
});

describe('LinkedIn is not a source, and audience rights', () => {
  it('an explicit linkedinOnly is refused on RoboApply too, before any reservation or model call: LinkedIn is not a source (M-4)', async () => {
    const { agent, planner, quota, service } = setup({ queries: ['engineer'], unverifiedPreferences: [] });
    const refused = agent.search({ ...INPUT, linkedinOnly: true }, { ...CONTEXT, brand: getBrand('roboapply') });
    await expect(refused).rejects.toBeInstanceOf(JobSearchValidationError);
    await expect(refused).rejects.toMatchObject({ field: 'linkedinOnly' });
    expect(planner).not.toHaveBeenCalled(); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });
  it('a planned linkedinOnly restricts nothing: no source is picked for it, no result is filtered, and the wish is disclosed', async () => {
    const { agent, service } = setup({ queries: ['engineer'], unverifiedPreferences: [], linkedinOnly: true });
    // A stored `linkedin` provider row (off) and a JSearch row that came with a LinkedIn page: neither makes the search "LinkedIn only".
    service.providers.mockReturnValue([...PROVIDERS, { id: 'linkedin', name: 'LinkedIn', enabled: false, reason: 'disabled', sourceType: 'board', homepage: 'https://fantastic.jobs' }]);
    service.search.mockResolvedValueOnce(result([job(), job({ id: 'other-job', title: 'Data Engineer', applyUrl: 'https://careers.example.com/jobs/2', sources: [{ provider: 'jsearch', id: 'jsearch:2', applyUrl: 'https://careers.example.com/jobs/2', publisher: null }] })]));
    const response = await agent.search(INPUT, CONTEXT);
    expect(service.search.mock.calls[0][0].providers).toBeUndefined();
    expect(response.jobs).toHaveLength(2);
    expect(response.agent).toMatchObject({ linkedinOnly: false, unverifiedPreferences: ['LinkedIn'] });
  });
  it('denies an API with no granted sources before model work or quota reservation', async () => {
    const { agent, service, planner, quota } = setup();
    service.providers.mockReturnValue(PROVIDERS.map(provider => ({ ...provider, enabled: false, reason: 'not_licensed' })));
    await expect(agent.search(INPUT, { ...CONTEXT, audience: 'api' })).rejects.toMatchObject({ code: 'providers_unavailable' });
    expect(planner).not.toHaveBeenCalled(); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });
  it('runs every planned API query through actual source rights without website-cache leakage', async () => {
    const raw: ProviderJob = { externalId: 'a1', sourceBoard: 'activejobs', title: 'Engineer', company: 'Fixture', location: 'Taipei', locationCity: 'Taipei', locationCountry: 'TW', companyLogoUrl: null, workType: 'remote', employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, postedAt: '2026-09-12T00:00:00Z', applyUrl: 'https://careers.example.com/job/1', applyIsDirect: true, description: 'Restricted website content', sourcePublisher: 'Greenhouse' };
    const activeSearch = vi.fn(async () => [raw]);
    const publicSearch = vi.fn(async () => [{ ...raw, sourceBoard: 'jsearch', externalId: 'j1', description: 'Permitted API content' }]);
    const env = { RAPID_API_KEY: 'fixture', JOB_SEARCH_PROVIDERS: 'activejobs,jsearch', JOB_SEARCH_API_PROVIDERS: 'jsearch' };
    const service = createJobSearchService({ env: () => env, providers: [{ id: 'activejobs', isEnabled: () => true, search: activeSearch }, { id: 'jsearch', isEnabled: () => true, search: publicSearch }] });
    await service.search({ query: 'software engineer', country: 'tw', location: 'Taipei', limit: 50 });
    const { quota } = setup();
    const agent = createJobSearchAgent({ service, quota: quota as never, planner: async () => PLAN });
    const response = await agent.search(INPUT, { ...CONTEXT, audience: 'api' });
    expect(response.jobs[0].description).toBe('Permitted API content');
    expect(response.jobs[0].sources.every(source => source.provider === 'jsearch')).toBe(true);
    expect(activeSearch).toHaveBeenCalledTimes(1);
    expect(quota.reserve).toHaveBeenCalledTimes(2);
  });
});

describe('the planner gate (phone binding, AI consent and the AI text capability before any model call)', () => {
  const GO = getBrand('goapply');
  const RA = getBrand('roboapply');
  const INDEX: ProviderInfo[] = [{ id: 'index', name: 'Job index', enabled: true, sourceType: 'index', homepage: '' }];
  const REQUEST = { request: '找上海的数据分析师职位，最近一周发布' };
  function gateSetup(state: { unbound?: boolean; consent?: boolean; aiText?: boolean } = {}) {
    const base = setup({ queries: ['数据分析师'], location: '上海', datePosted: 'week', unverifiedPreferences: [] });
    base.service.providers.mockReturnValue(INDEX);
    const phoneBindingRequired = vi.fn(async () => state.unbound === true);
    const aiAllowed = vi.fn(async () => state.consent !== false);
    const aiTextEnabled = vi.fn(async () => state.aiText !== false);
    const agent = createJobSearchAgent({ service: base.service as never, quota: base.quota as never, planner: base.planner, gate: createPlannerGate({ phoneBindingRequired, aiAllowed, aiTextEnabled }) });
    return { ...base, agent, phoneBindingRequired, aiAllowed, aiTextEnabled };
  }
  const untouched = ({ planner, quota, service }: ReturnType<typeof gateSetup>) => {
    expect(planner).not.toHaveBeenCalled(); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  };

  it('GoApply WeChat account with no verified phone: 403 phone_binding_required, no reservation, no planner call, no search', async () => {
    const s = gateSetup({ unbound: true });
    const refused = s.agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api', apiKeyId: 'key' });
    await expect(refused).rejects.toBeInstanceOf(JobSearchPhoneBindingError);
    await expect(refused).rejects.toMatchObject({ code: 'phone_binding_required', status: 403 });
    expect(s.phoneBindingRequired).toHaveBeenCalledWith('owner');
    // The phone rule comes first, as on every other GoApply AI route.
    expect(s.aiAllowed).not.toHaveBeenCalled(); expect(s.aiTextEnabled).not.toHaveBeenCalled();
    untouched(s);
  });

  it('without the consent: 403 ai_off, no reservation, no planner call, no search', async () => {
    const s = gateSetup({ consent: false });
    const refused = s.agent.search(REQUEST, { ...CONTEXT, brand: GO });
    await expect(refused).rejects.toBeInstanceOf(JobSearchAiOffError);
    await expect(refused).rejects.toMatchObject({ code: 'ai_off', status: 403 });
    expect(s.aiAllowed).toHaveBeenCalledWith({ id: 'owner', brand: 'goapply' });
    expect(s.aiTextEnabled).not.toHaveBeenCalled();
    untouched(s);
  });

  it('AI text switched off for the brand: 503 ai_unavailable, no reservation, no planner call, no search', async () => {
    const s = gateSetup({ aiText: false });
    const refused = s.agent.search(REQUEST, { ...CONTEXT, brand: GO });
    await expect(refused).rejects.toBeInstanceOf(JobSearchAiUnavailableError);
    await expect(refused).rejects.toMatchObject({ code: 'ai_unavailable', status: 503 });
    expect(s.aiTextEnabled).toHaveBeenCalledWith({ userId: 'owner', brand: GO });
    untouched(s);
  });

  it('the configured ai.text rule: FLAG_GOAPPLY_AI_TEXT=false refuses on GoApply and leaves RoboApply open; FLAG_ROBOAPPLY_AI_TEXT=false refuses on RoboApply', async () => {
    const gate = createPlannerGate({ phoneBindingRequired: async () => false, aiAllowed: async () => true });
    vi.stubEnv('FLAG_GOAPPLY_AI_TEXT', 'false');
    await expect(gate({ userId: 'owner', brand: GO })).rejects.toMatchObject({ code: 'ai_unavailable', status: 503 });
    await expect(gate({ userId: 'owner', brand: RA })).resolves.toBeUndefined();
    vi.unstubAllEnvs();
    vi.stubEnv('FLAG_ROBOAPPLY_AI_TEXT', 'false');
    await expect(gate({ userId: 'owner', brand: RA })).rejects.toMatchObject({ code: 'ai_unavailable' });
  });

  it('the configured gate, nothing injected: a GoApply WeChat account with no verified phone is refused; with one, and the consent, the planner runs', async () => {
    const account = { brand: 'goapply', phoneE164: null as string | null, phoneVerifiedAt: null as Date | null };
    db.user = { findUnique: vi.fn(async () => account) };
    db.rAAuthIdentity = { findFirst: vi.fn(async () => ({ id: 'wechat-identity' })) };
    setConsentLookup(async () => ({ consentType: 'ai_resume_parsing', granted: true, createdAt: new Date() }));
    const build = () => {
      const base = setup({ queries: ['数据分析师'], unverifiedPreferences: [] });
      base.service.providers.mockReturnValue(INDEX);
      return base;
    };
    try {
      // A phone is asked for only where one can be bound (plan §3.7): an SMS provider is live.
      vi.stubEnv('SMS_DEV_CONSOLE', 'true');
      const refused = build();
      await expect(refused.agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api', apiKeyId: 'key' })).rejects.toMatchObject({ code: 'phone_binding_required', status: 403 });
      expect(refused.planner).not.toHaveBeenCalled(); expect(refused.quota.reserve).not.toHaveBeenCalled();
      // With no SMS provider nobody can bind a phone, so the same account is not held (D5).
      vi.stubEnv('SMS_DEV_CONSOLE', '');
      const noSms = build();
      await expect(noSms.agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api', apiKeyId: 'key' })).resolves.toMatchObject({ agent: { queries: ['数据分析师'] } });
      vi.stubEnv('SMS_DEV_CONSOLE', 'true');
      account.phoneE164 = '+8613800000000'; account.phoneVerifiedAt = new Date();
      const allowed = build();
      await expect(allowed.agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api', apiKeyId: 'key' })).resolves.toMatchObject({ agent: { queries: ['数据分析师'] } });
      expect(allowed.planner).toHaveBeenCalledTimes(1);
      // The same account with AI text switched off for GoApply: refused by the third check.
      vi.stubEnv('FLAG_GOAPPLY_AI_TEXT', 'false');
      const off = build();
      await expect(off.agent.search(REQUEST, { ...CONTEXT, brand: GO })).rejects.toMatchObject({ code: 'ai_unavailable', status: 503 });
      expect(off.planner).not.toHaveBeenCalled(); expect(off.quota.reserve).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); setConsentLookup(null); delete db.user; delete db.rAAuthIdentity; }
  });

  it('a failed phone lookup fails closed: no reservation and no planner call', async () => {
    const s = gateSetup();
    s.phoneBindingRequired.mockRejectedValueOnce(new Error('database offline'));
    await expect(s.agent.search(REQUEST, { ...CONTEXT, brand: GO })).rejects.toThrow('database offline');
    untouched(s);
  });

  it('with a bound phone, the consent and AI text on: plans, then searches the GoApply sources as the user, with the brand default country', async () => {
    const { agent, planner, service, quota, events } = gateSetup();
    const response = await agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api', apiKeyId: 'key' });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(service.providers).toHaveBeenCalledWith('api', GO);
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: '数据分析师', country: 'cn', location: '上海', datePosted: 'week' }),
      expect.objectContaining({ audience: 'api', brand: GO, userId: 'owner' }),
    );
    expect(response.agent.criteria).toMatchObject({ country: 'cn', location: '上海' });
    expect(events).toEqual(['reserve:1', 'plan', 'search:数据分析师', 'finish:reservation-1']);
    // The reservation is made against GoApply's budget, not RoboApply's.
    expect(quota.reserve).toHaveBeenCalledWith('owner', 'key', 'agent-fixture', GO);
  });

  it('RoboApply: the phone rule is not looked up, the consent rule is asked with its brand, and the configured gate allows it with no lookup', async () => {
    const s = gateSetup();
    s.service.providers.mockReturnValue(PROVIDERS);
    await s.agent.search(INPUT, { ...CONTEXT, brand: RA });
    expect(s.phoneBindingRequired).not.toHaveBeenCalled();
    expect(s.aiAllowed).toHaveBeenCalledWith({ id: 'owner', brand: 'roboapply' });
    expect(s.quota.reserve).toHaveBeenCalledWith('owner', undefined, 'agent-fixture', RA);
    // The configured gate with nothing injected: no refusal, the plan runs.
    const plain = setup();
    await expect(plain.agent.search(INPUT, { ...CONTEXT, brand: RA })).resolves.toMatchObject({ agent: { mode: 'planned' } });
    expect(plain.service.search.mock.calls[0][0]).toMatchObject({ country: 'tw' });
  });

  it('the configured consent rule refuses a GoApply user with no live consent record and allows one with it', async () => {
    const lookup = vi.fn(async () => null as { consentType: string; granted: boolean; createdAt: Date } | null);
    setConsentLookup(lookup);
    // The configured consent rule; the phone and AI text checks are stated.
    const gate = createPlannerGate({ phoneBindingRequired: async () => false, aiTextEnabled: async () => true });
    const build = () => {
      const base = setup({ queries: ['数据分析师'], unverifiedPreferences: [] });
      base.service.providers.mockReturnValue(INDEX);
      return { ...base, agent: createJobSearchAgent({ service: base.service as never, quota: base.quota as never, planner: base.planner, gate }) };
    };
    try {
      const refused = build();
      await expect(refused.agent.search(REQUEST, { ...CONTEXT, brand: GO })).rejects.toMatchObject({ code: 'ai_off' });
      expect(refused.planner).not.toHaveBeenCalled();
      lookup.mockResolvedValue({ consentType: 'ai_resume_parsing', granted: true, createdAt: new Date() });
      const allowed = build();
      await expect(allowed.agent.search(REQUEST, { ...CONTEXT, brand: GO })).resolves.toMatchObject({ agent: { queries: ['数据分析师'] } });
      expect(allowed.planner).toHaveBeenCalledTimes(1);
    } finally { setConsentLookup(null); }
  });

  it('no source (the mode is off or the index is not granted to keys) is answered before the gate', async () => {
    const s = gateSetup({ consent: false });
    s.service.providers.mockReturnValue(INDEX.map((p) => ({ ...p, enabled: false, reason: 'not_licensed' as const })));
    await expect(s.agent.search(REQUEST, { ...CONTEXT, brand: GO, audience: 'api' })).rejects.toMatchObject({ code: 'providers_unavailable' });
    expect(s.phoneBindingRequired).not.toHaveBeenCalled(); expect(s.aiAllowed).not.toHaveBeenCalled();
  });
});

describe('LinkedIn-only: no site has a LinkedIn-capable source (GoApply by its list, RoboApply since M-4)', () => {
  const GO = getBrand('goapply');
  const INDEX: ProviderInfo[] = [{ id: 'index', name: 'Job index', enabled: true, sourceType: 'index', homepage: '' }];
  const open = createPlannerGate({ phoneBindingRequired: async () => false, aiAllowed: async () => true, aiTextEnabled: async () => true });
  function linkedInSetup(plan: unknown) {
    const base = setup(plan);
    base.service.providers.mockReturnValue(INDEX);
    return { ...base, agent: createJobSearchAgent({ service: base.service as never, quota: base.quota as never, planner: base.planner, gate: open }) };
  }

  it('an explicit linkedinOnly is a 400 before any reservation or model call', async () => {
    const { agent, planner, quota, service } = linkedInSetup({ queries: ['数据分析师'], unverifiedPreferences: [] });
    const refused = agent.search({ request: '找上海的数据分析师职位，最近一周发布', linkedinOnly: true }, { ...CONTEXT, brand: GO });
    await expect(refused).rejects.toBeInstanceOf(JobSearchValidationError);
    await expect(refused).rejects.toMatchObject({ field: 'linkedinOnly' });
    expect(planner).not.toHaveBeenCalled(); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });

  it('a planned linkedinOnly is not applied: the search runs on the index and the wish is disclosed in the user\'s words', async () => {
    const { agent, service, events } = linkedInSetup({ queries: ['数据分析师'], linkedinOnly: true, unverifiedPreferences: [] });
    const response = await agent.search({ request: '找上海的数据分析师职位。只要领英上的职位' }, { ...CONTEXT, brand: GO });
    expect(response.agent.linkedinOnly).toBe(false);
    expect(response.agent.unverifiedPreferences).toContain('只要领英上的职位');
    // The planned search ran on the site's own source: nothing was filtered to LinkedIn postings.
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: '数据分析师', providers: undefined }), expect.objectContaining({ brand: GO }));
    expect(response.jobs).toHaveLength(1);
    expect(events).toEqual(['reserve:1', 'plan', 'search:数据分析师', 'finish:reservation-1']);
  });

  it('a planned linkedinOnly with no LinkedIn wording in the request is disclosed by name', async () => {
    const { agent } = linkedInSetup({ queries: ['数据分析师'], linkedinOnly: true, unverifiedPreferences: ['五险一金'] });
    const response = await agent.search({ request: '找上海的数据分析师职位，最近一周发布' }, { ...CONTEXT, brand: GO });
    expect(response.agent).toMatchObject({ linkedinOnly: false, unverifiedPreferences: ['LinkedIn', '五险一金'] });
  });

  it('RoboApply takes the same path: a planned linkedinOnly is not applied, the search runs on its sources and the wish is disclosed in the user\'s words', async () => {
    const base = setup({ ...PLAN, queries: ['software engineer'], linkedinOnly: true });
    const response = await base.agent.search({ request: 'Find software engineer jobs in Taipei. LinkedIn only.' }, { ...CONTEXT, brand: getBrand('roboapply') });
    expect(response.agent.linkedinOnly).toBe(false);
    expect(response.agent.unverifiedPreferences).toEqual(['Find software engineer jobs in Taipei. LinkedIn only.']);
    expect(base.service.search).toHaveBeenCalledWith(expect.objectContaining({ providers: undefined }), expect.anything());
  });
});

describe('MKT-4H: relevance terms (an order, never a filter, never a checked fact)', () => {
  const GO = getBrand('goapply');
  const RA = getBrand('roboapply');
  const NOW = Date.parse('2026-10-11T12:00:00Z');
  const REQUEST = { request: 'remote backend roles at climate startups, ideally using Rust, paying over 150k' };
  const TOPICS = { queries: ['backend engineer'], remote: true, relevanceTerms: ['climate startups', 'Rust'], unverifiedPreferences: ['paying over 150k'] };
  const open = createPlannerGate({ phoneBindingRequired: async () => false, aiAllowed: async () => true, aiTextEnabled: async () => true });

  it('RoboApply: the sources return their own order, so rankedBy is empty and the topics stay visible as unverified; nothing else in the response changes', async () => {
    const { agent, service } = setup(TOPICS);
    const response = await agent.search(REQUEST, { ...CONTEXT, brand: RA });
    // The plan: one role query, remote as a filter, the topics offered to the sources as an order.
    expect(response.agent.queries).toEqual(['backend engineer']);
    expect(response.agent.criteria).toEqual({ country: 'us', remote: true });
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'backend engineer', remote: true }), expect.objectContaining({ rankBy: ['climate startups', 'Rust'] }));
    // The fake provider result carries no order (as JSearch and Active Jobs DB): nothing is claimed.
    expect(response.agent.rankedBy).toEqual([]);
    expect(response.agent.unverifiedPreferences).toEqual(['paying over 150k', 'climate startups', 'Rust']);
    expect(Object.keys(response.agent).sort()).toEqual(['criteria', 'linkedinOnly', 'mode', 'queries', 'rankedBy', 'unverifiedPreferences']);
    expect(Object.keys(response).sort()).toEqual(['agent', 'jobs', 'meta', 'searches']);
    expect(response.meta).not.toHaveProperty('rankedBy');
  });

  it('RoboApply through the real service: a RapidAPI provider is never handed the topics, and its result is in provider order', async () => {
    const row = (id: string, title: string): ProviderJob => ({ externalId: id, sourceBoard: 'jsearch', title, company: 'Fixture', location: 'Remote', locationCity: null, locationCountry: 'US', companyLogoUrl: null, workType: 'remote', employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, postedAt: '2026-10-10T00:00:00Z', applyUrl: `https://careers.example.com/job/${id}`, applyIsDirect: true, description: '', sourcePublisher: null });
    const jsearch: SearchProvider = { id: 'jsearch', isEnabled: () => true, search: vi.fn(async () => [row('j1', 'Backend Engineer, Payments'), row('j2', 'Backend Engineer (Rust), climate startup')]) };
    const service = createJobSearchService({ env: () => ({ RAPID_API_KEY: 'fixture', JOB_SEARCH_PROVIDERS: 'jsearch' }), providers: [jsearch], now: () => NOW });
    const { quota } = setup();
    const agent = createJobSearchAgent({ service, quota: quota as never, planner: async () => TOPICS, gate: open });
    const response = await agent.search(REQUEST, { ...CONTEXT, brand: RA });
    expect((jsearch.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('relevance');
    expect(response.jobs.map(j => j.title)).toEqual(['Backend Engineer, Payments', 'Backend Engineer (Rust), climate startup']);
    expect(response.agent.rankedBy).toEqual([]);
    expect(response.agent.unverifiedPreferences).toEqual(expect.arrayContaining(['climate startups', 'Rust']));
  });

  /**
   * GoApply's one source over a fake of the feed's read function. `report` is what that fake says about its order:
   * 'applied' (it used the text for the order, the row that mentions it comes first, and it says so), 'unapplied'
   * (it took the text and says it did not order by it) or 'silent' (rows only: a feed without the report).
   * The real feed service is run in index-feed.gate.test.ts.
   */
  function goSetup(plan: unknown, report: 'applied' | 'unapplied' | 'silent' | ((input: { q?: string }) => 'applied' | 'unapplied' | 'silent') = 'applied') {
    const item = (jobId: string, title: string): IndexFeedItem => ({
      jobId, title, company: { name: '示例科技' }, location: '上海', workModel: 'remote', employmentType: 'full_time', pay: null,
      postedAt: '2026-10-09T00:00:00Z', lastSeenAt: '2026-10-11T02:00:00Z', fromRecruiterBank: false,
      source: { name: 'Greenhouse', kind: 'ats_public', original: '示例科技', url: `https://boards.example.cn/${jobId}`, lastVerifiedAt: '2026-10-11T02:00:00Z', via: 'ats' },
      apply: { url: `https://careers.example.cn/jobs/${jobId}`, target: 'employer' },
    });
    // Two equally recent rows.
    const plain = item('plain', '后端工程师');
    const topical = item('topical', '后端工程师（Rust，新能源）');
    const preview = vi.fn(async (_userId: string, input: { q?: string; relevance?: string }) => {
      if (!input.relevance) return [plain, topical];
      const said = typeof report === 'function' ? report(input) : report;
      if (said === 'applied') return { items: [topical, plain], relevanceApplied: true };
      if (said === 'unapplied') return { items: [plain, topical], relevanceApplied: false };
      return [plain, topical];
    });
    const rapid: SearchProvider = { id: 'jsearch', isEnabled: () => true, search: vi.fn(async () => []) };
    const service = createJobSearchService({ providers: [rapid], brandProviders: { goapply: [createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS })] }, env: () => ({ RAPID_API_KEY: 'fixture' }), now: () => NOW });
    const { quota } = setup();
    const agent = createJobSearchAgent({ service, quota: quota as never, planner: async () => structuredClone(plan), gate: open });
    return { agent, preview, rapid, quota };
  }

  it('GoApply: the index is asked through the feed with the query as q and the topics as relevance; when the feed says the topics took part in its order, that order is kept, rankedBy names them, and no outside provider is called', async () => {
    const { agent, preview, rapid } = goSetup({ queries: ['后端工程师'], relevanceTerms: ['新能源', 'Rust'], unverifiedPreferences: ['五险一金'] }, 'applied');
    const response = await agent.search({ request: '找后端工程师职位，最好是新能源行业，用 Rust，要有五险一金' }, { ...CONTEXT, brand: GO });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('owner', expect.objectContaining({ q: '后端工程师', relevance: '新能源 Rust', limit: 50 }));
    expect(response.jobs.map(j => j.title)).toEqual(['后端工程师（Rust，新能源）', '后端工程师']);
    expect(response.agent.rankedBy).toEqual(['新能源', 'Rust']);
    // Ranked by, so not repeated among the preferences nobody applied; the benefit phrase stays there.
    expect(response.agent.unverifiedPreferences).toEqual(['五险一金']);
    expect(rapid.search).not.toHaveBeenCalled();
  });

  it.each(['unapplied', 'silent'] as const)('GoApply, a feed that does not say it ordered by the topics (%s): nothing is claimed, the rows keep the feed\'s order and the topics are listed as not applied, exactly as on RoboApply', async (report) => {
    const { agent, preview, rapid } = goSetup({ queries: ['后端工程师'], relevanceTerms: ['新能源', 'Rust'], unverifiedPreferences: ['五险一金'] }, report);
    const response = await agent.search({ request: '找后端工程师职位，最好是新能源行业，用 Rust，要有五险一金' }, { ...CONTEXT, brand: GO });
    // The topics are still offered to the feed (the same call as above): what is said about them is the feed's answer.
    expect(preview).toHaveBeenCalledWith('owner', expect.objectContaining({ q: '后端工程师', relevance: '新能源 Rust', limit: 50 }));
    expect(response.jobs.map(j => j.title)).toEqual(['后端工程师', '后端工程师（Rust，新能源）']);
    expect(response.agent.rankedBy).toEqual([]);
    expect(response.agent.unverifiedPreferences).toEqual(['五险一金', '新能源', 'Rust']);
    expect(response.meta).not.toHaveProperty('rankedBy');
    expect(rapid.search).not.toHaveBeenCalled();
  });

  it('GoApply without topics: no relevance is sent and the list is the feed\'s own order', async () => {
    const { agent, preview } = goSetup({ queries: ['后端工程师'], unverifiedPreferences: [] });
    const response = await agent.search({ request: '找上海的后端工程师职位，最近一周发布' }, { ...CONTEXT, brand: GO });
    expect((preview.mock.calls[0] as unknown[])[1]).not.toHaveProperty('relevance');
    expect(response.jobs.map(j => j.title)).toEqual(['后端工程师', '后端工程师（Rust，新能源）']);
    expect(response.agent.rankedBy).toEqual([]);
  });

  it('a requirement the model named as a topic is never ranked by (the feed\'s rule): it is listed as unverified, and only the real topics order the list', async () => {
    const { agent, preview } = goSetup({ queries: ['后端工程师'], relevanceTerms: ['paying over 150k', 'visa sponsorship', '五险一金', 'Rust'], unverifiedPreferences: [] });
    const response = await agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO });
    expect(preview).toHaveBeenCalledWith('owner', expect.objectContaining({ relevance: 'Rust' }));
    expect(response.agent.rankedBy).toEqual(['Rust']);
    expect(response.agent.unverifiedPreferences).toEqual(['paying over 150k', 'visa sponsorship', '五险一金']);
  });

  it('only requirements among the terms: nothing is ranked by, no relevance is sent', async () => {
    const { agent, preview } = goSetup({ queries: ['后端工程师'], relevanceTerms: ['salary above 150k'], unverifiedPreferences: [] });
    const response = await agent.search({ request: '找后端工程师职位，最近一周发布的' }, { ...CONTEXT, brand: GO });
    expect((preview.mock.calls[0] as unknown[])[1]).not.toHaveProperty('relevance');
    expect(response.agent).toMatchObject({ rankedBy: [], unverifiedPreferences: ['salary above 150k'] });
  });

  it('a plan with nine terms or a URL in one is still accepted: the bad values are dropped and the search runs', async () => {
    const nine = ['https://evil.example/x', '新能源', 'Rust', '储能', '出海', '开源', '机器人', '芯片', '游戏'];
    const { agent, preview } = goSetup({ queries: ['后端工程师'], relevanceTerms: nine, unverifiedPreferences: [] });
    const response = await agent.search({ request: '找后端工程师职位，最近一周发布的' }, { ...CONTEXT, brand: GO });
    expect(response.agent.rankedBy).toEqual(['新能源', 'Rust', '储能', '出海', '开源']);
    expect(preview).toHaveBeenCalledWith('owner', expect.objectContaining({ relevance: '新能源 Rust 储能 出海 开源' }));
    expect(JSON.stringify(response)).not.toContain('evil.example');
  });

  it('two planned queries: each is ordered by the topics, and rankedBy is claimed only when every search that answered was', async () => {
    const both = goSetup({ queries: ['后端工程师', '服务端工程师'], relevanceTerms: ['Rust'], unverifiedPreferences: [] });
    const ok = await both.agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO });
    expect(both.preview.mock.calls.map(c => (c as unknown as [string, { q: string; relevance?: string }])[1])).toEqual([
      expect.objectContaining({ q: '后端工程师', relevance: 'Rust' }),
      expect.objectContaining({ q: '服务端工程师', relevance: 'Rust' }),
    ]);
    expect(ok.agent.rankedBy).toEqual(['Rust']);
    // One of the two searches was not ordered by the topic: the whole answer claims nothing, and the topic is disclosed.
    const half = goSetup({ queries: ['后端工程师', '服务端工程师'], relevanceTerms: ['Rust'], unverifiedPreferences: [] }, input => (input.q === '后端工程师' ? 'applied' : 'unapplied'));
    const mixed = await half.agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO });
    expect(half.preview).toHaveBeenCalledTimes(2);
    expect(mixed.agent).toMatchObject({ rankedBy: [], unverifiedPreferences: ['Rust'] });
    // One search found nothing: the rows that came back were all ordered by the topic, so it is named.
    const oneEmpty = goSetup({ queries: ['后端工程师', '服务端工程师'], relevanceTerms: ['Rust'], unverifiedPreferences: [] });
    oneEmpty.preview.mockImplementationOnce(async () => ({ items: [], relevanceApplied: false }));
    const partial = await oneEmpty.agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO });
    expect(partial.jobs).toHaveLength(2);
    expect(partial.agent.rankedBy).toEqual(['Rust']);
    // Nothing was found at all: nothing was ordered, so nothing is claimed.
    const nothing = goSetup({ queries: ['后端工程师'], relevanceTerms: ['Rust'], unverifiedPreferences: [] });
    nothing.preview.mockImplementation(async () => ({ items: [], relevanceApplied: true }));
    expect((await nothing.agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO })).agent).toMatchObject({ rankedBy: [], unverifiedPreferences: ['Rust'] });
    // The index fails for every query: nothing was ordered, so nothing is claimed and the topic is disclosed.
    const failing = goSetup({ queries: ['后端工程师'], relevanceTerms: ['Rust'], unverifiedPreferences: [] });
    failing.preview.mockRejectedValue(new Error('index offline'));
    const failed = await failing.agent.search({ request: '找后端工程师职位，用 Rust 的团队优先' }, { ...CONTEXT, brand: GO });
    expect(failed.jobs).toEqual([]);
    expect(failed.agent).toMatchObject({ rankedBy: [], unverifiedPreferences: ['Rust'] });
  });

  it('RoboApply takes the same rule: a requirement named as a topic is never offered to a source as an order; it is disclosed with the rest', async () => {
    const base = setup({ ...TOPICS, relevanceTerms: ['climate startups', 'visa sponsorship', 'Rust'] });
    const response = await base.agent.search(REQUEST, { ...CONTEXT, brand: RA });
    expect(base.service.search.mock.calls[0][1]).toMatchObject({ rankBy: ['climate startups', 'Rust'] });
    expect(response.agent.rankedBy).toEqual([]);
    // The planner's own preference, the requirement it filed as a topic, then the topics nobody ordered by.
    expect(response.agent.unverifiedPreferences).toEqual(['paying over 150k', 'visa sponsorship', 'climate startups', 'Rust']);
    // A plan that names no topic asks for no order at all.
    const none = setup();
    await none.agent.search(INPUT, CONTEXT);
    expect(none.service.search.mock.calls[0][1]).not.toHaveProperty('rankBy');
  });

  it('the planner prompt asks for the topics and keeps the conditions and the "never claim" rule', async () => {
    llm.model.mockReturnValue(undefined);
    llm.chat.mockResolvedValue(JSON.stringify(TOPICS));
    await configuredSearchPlanner(REQUEST, { ...CONTEXT, signal: new AbortController().signal });
    const prompt = String((llm.chat.mock.calls[0][0] as Array<{ role: string; content: string }>)[0]!.content);
    expect(prompt).toContain('"relevanceTerms":["topic to rank results by"]');
    expect(prompt).toMatch(/relevanceTerms: up to 5 short topical phrases/);
    expect(prompt).toMatch(/pay, visa or work authorization, benefits, hours, time zone, commute or company size: those conditions stay in unverifiedPreferences and are never placed in relevanceTerms/);
    expect(prompt).toContain('Never claim these facts were checked.');
    expect(prompt).toContain('never claim they were checked');
    // The LinkedIn wish is still recognised in words (and then disclosed, never applied).
    expect(prompt).toContain('linkedinOnly:true only when the request explicitly restricts sources to LinkedIn');
  });
});

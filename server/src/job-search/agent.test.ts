// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
/** The database the configured gate reads (auth-cn phone binding); empty unless a test fills it. */
const db = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../lib/prisma.js', () => ({ default: db }));
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const llm = vi.hoisted(() => ({ chat: vi.fn(), model: vi.fn() }));
vi.mock('../services/llm/LLMService.js', () => ({ llmService: { chat: llm.chat } }));
vi.mock('../lib/llm/llmModels.js', () => ({ getModelSetting: llm.model }));
import { configuredSearchPlanner, createJobSearchAgent, createPlannerGate, isLinkedInJob, JobSearchAgentUnavailableError, JobSearchAiOffError, JobSearchAiUnavailableError, JobSearchPhoneBindingError, type SearchPlanner } from './agent.js';
import { getBrand } from '../platform/brand/registry.js';
import { setConsentLookup } from '../platform/consent/index.js';
import { parseAgentPlan, parseAgentSearchInput } from './agent-validation.js';
import { SearchQuotaError } from './quota.js';
import { JobSearchValidationError } from './validation.js';
import { getCurrentUserId } from '../lib/requestContext.js';
import { createJobSearchService } from './service.js';
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

describe('LinkedIn provenance and audience rights', () => {
  it.each([
    'https://linkedin.com/jobs/view/123', 'https://www.linkedin.com/jobs/view/engineer-at-example-123/',
    'https://tw.linkedin.com/jobs/view/123?tracking=x',
  ])('recognizes canonical LinkedIn job URLs %s', sourceUrl => expect(isLinkedInJob(job({ sourceUrl }))).toBe(true));
  it.each([
    'https://linkedin.com.evil.example/jobs/view/123', 'https://notlinkedin.com/jobs/view/123',
    'https://careers.example.com/linkedin.com/jobs/view/123', 'https://careers.example.com/?next=https://linkedin.com/jobs/view/123',
    'https://user:password@linkedin.com/jobs/view/123', 'https://linkedin.com/in/engineer', 'https://linkedin.com/company/example',
    'https://linkedin.com/jobs/view/',
  ])('rejects spoofed or unrelated LinkedIn URLs %s', sourceUrl => expect(isLinkedInJob(job({ sourceUrl }))).toBe(false));
  it('uses exact publisher or retained secondary source URL, never just provider ID', () => {
    expect(isLinkedInJob(job({ provider: 'linkedin' }))).toBe(false);
    expect(isLinkedInJob(job({ sources: [{ provider: 'jsearch', id: 'j1', applyUrl: 'https://careers.example.com/job/1', publisher: ' LinkedIn ' }] }))).toBe(true);
    expect(isLinkedInJob(job({ sources: [{ provider: 'activejobs', id: 'a1', applyUrl: 'https://careers.example.com/job/1', publisher: 'Not LinkedIn' }] }))).toBe(false);
    expect(isLinkedInJob(job({ sources: [{ provider: 'jsearch', id: 'j1', applyUrl: 'https://careers.example.com/job/1', publisher: null, sourceUrl: 'https://linkedin.com/jobs/view/123' }] }))).toBe(true);
  });
  it('filters actual source matches and recalculates result counts after filtering', async () => {
    const { agent, service } = setup({ queries: ['engineer'], unverifiedPreferences: [] });
    service.search.mockResolvedValueOnce(result([job(), job({ id: 'linkedin-job', sourceUrl: 'https://linkedin.com/jobs/view/123' })]));
    const response = await agent.search({ ...INPUT, linkedinOnly: true }, CONTEXT);
    expect(response.jobs).toHaveLength(1); expect(response.agent.linkedinOnly).toBe(true);
    expect(response.meta.providers[0].resultCount).toBe(1); expect(response.searches[0].providers[0].resultCount).toBe(1);
  });
  it('keeps unavailable dedicated LinkedIn diagnostics without auto-enabling it', async () => {
    const { agent, service } = setup({ queries: ['engineer'], unverifiedPreferences: [], linkedinOnly: true });
    service.providers.mockReturnValue([...PROVIDERS, { id: 'linkedin', name: 'LinkedIn', enabled: false, reason: 'disabled', sourceType: 'board', homepage: 'https://fantastic.jobs' }]);
    service.search.mockResolvedValueOnce({ ...result([]), meta: { ...result([]).meta, partial: true, providers: [...result([]).meta.providers, { id: 'linkedin', name: 'LinkedIn', status: 'unavailable', reason: 'disabled', resultCount: 0 }] } });
    const response = await agent.search(INPUT, CONTEXT);
    expect(service.search.mock.calls[0][0].providers).toEqual(['jsearch', 'linkedin']);
    expect(response.meta.partial).toBe(true); expect(response.meta.providers[1].status).toBe('unavailable');
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

describe('LinkedIn-only on a site with no LinkedIn-capable source (GoApply)', () => {
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

  it('RoboApply is unchanged: a planned linkedinOnly still restricts the search to its LinkedIn-capable sources', async () => {
    const base = setup({ ...PLAN, queries: ['software engineer'], linkedinOnly: true });
    const response = await base.agent.search({ request: 'Find software engineer jobs in Taipei, LinkedIn only.' }, { ...CONTEXT, brand: getBrand('roboapply') });
    expect(response.agent.linkedinOnly).toBe(true);
    expect(base.service.search).toHaveBeenCalledWith(expect.objectContaining({ providers: ['jsearch'] }), expect.anything());
  });
});

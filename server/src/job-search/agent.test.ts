// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const llm = vi.hoisted(() => ({ chat: vi.fn(), model: vi.fn() }));
vi.mock('../services/llm/LLMService.js', () => ({ llmService: { chat: llm.chat } }));
vi.mock('../lib/llm/llmModels.js', () => ({ getModelSetting: llm.model }));
import { configuredSearchPlanner, createJobSearchAgent, isLinkedInJob, JobSearchAgentUnavailableError, type SearchPlanner } from './agent.js';
import { parseAgentPlan, parseAgentSearchInput } from './agent-validation.js';
import { SearchQuotaError } from './quota.js';
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

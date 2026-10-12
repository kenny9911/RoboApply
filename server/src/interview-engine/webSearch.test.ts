// @vitest-environment node
//
// The interview engine's web search on both brands (D5; G9, G57). GoApply
// searches like RoboApply does: also when session work runs inside the GoApply
// brand with no explicit brand passed (prepare, crons). On either brand the
// query goes through the no-personal-information check before it is sent, and
// a refused or failed search is a quiet null (no evidence, never an error).
// Whether the residency policy lets a brand use the vendor at all is that
// policy's rule (platform/residency/egressPolicy.ts); here a refusal from it
// is simulated. No network: `fetch` is a spy.
// Run: npx vitest run server/src/interview-engine/webSearch.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// The real policy check, observable: which brand each query was checked for.
const policy = vi.hoisted(() => ({ brands: [] as string[], refuse: null as string | null }));
vi.mock('../platform/residency/egressPolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/residency/egressPolicy.js')>();
  return {
    ...actual,
    assertNoPiInPayload: (input: Parameters<typeof actual.assertNoPiInPayload>[0]) => {
      const id = typeof input.brand === 'string' ? input.brand : input.brand.id;
      policy.brands.push(id);
      if (policy.refuse === id) throw new actual.EgressPolicyError('vendor_disabled_in_region', 'refused by the residency policy (simulated)', 'api.tavily.com');
      return actual.assertNoPiInPayload(input);
    },
  };
});

import { runWithBrand } from '../lib/requestContext.js';
import { TAVILY_SEARCH_URL, searchJobRequirements, webSearchAllowedFor } from './webSearch.js';

const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;
const savedKey = process.env.TAVILY_API_KEY;
const savedRegion = process.env.DEPLOY_REGION;

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  delete process.env.DEPLOY_REGION;
  policy.brands.length = 0;
  policy.refuse = null;
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [{ title: 't', url: 'https://x.example', content: 'c', score: 1 }] }), text: async () => '' });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedKey;
  if (savedRegion === undefined) delete process.env.DEPLOY_REGION;
  else process.env.DEPLOY_REGION = savedRegion;
});

const QUERY = 'Backend Engineer job description requirements responsibilities qualifications';

describe('searchJobRequirements per brand', () => {
  it('GoApply searches like RoboApply, whether the brand is passed or ambient', async () => {
    expect((await searchJobRequirements(QUERY, { brand: 'goapply' }))?.results).toHaveLength(1);
    expect((await runWithBrand('goapply', () => searchJobRequirements(QUERY)))?.results).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(TAVILY_SEARCH_URL);
    expect(JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string).query).toBe(QUERY);
    expect(webSearchAllowedFor('goapply')).toBe(true);
    expect(webSearchAllowedFor('roboapply')).toBe(true);
  });

  it('an explicit brand wins over the ambient one, in both directions', async () => {
    await runWithBrand('roboapply', () => searchJobRequirements(QUERY, { brand: 'goapply' }));
    await runWithBrand('goapply', () => searchJobRequirements(QUERY, { brand: 'roboapply' }));
    await runWithBrand('goapply', () => searchJobRequirements(QUERY));
    // The policy check runs for the brand the search is for.
    expect(policy.brands).toEqual(['goapply', 'roboapply', 'goapply']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('GoApply: a query with an email, a phone number, an id number or the user’s name is not sent (the query carries no personal information)', async () => {
    for (const query of [`${QUERY} zhang@example.com`, `${QUERY} 13800138000`, `${QUERY} 11010519491231002X`]) {
      expect(await searchJobRequirements(query, { brand: 'goapply' }), query).toBeNull();
    }
    expect(await runWithBrand('goapply', () => searchJobRequirements(`张伟 ${QUERY}`, { knownValues: ['张伟'] }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The same role text without the known value goes through.
    expect(await runWithBrand('goapply', () => searchJobRequirements(`后端工程师 ${QUERY}`, { knownValues: ['张伟', null] }))).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a failing search degrades to no evidence, never an error, on both brands', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(searchJobRequirements(QUERY, { brand: 'goapply' })).resolves.toBeNull();
    await expect(searchJobRequirements(QUERY, { brand: 'roboapply' })).resolves.toBeNull();
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
    await expect(searchJobRequirements(QUERY, { brand: 'goapply' })).resolves.toBeNull();
  });

  it('a domain-restricted GoApply search that comes back empty retries once on the open web', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' });
    const resp = await runWithBrand('goapply', () => searchJobRequirements(QUERY, { includeDomains: ['linkedin.com/jobs'] }));
    expect(resp?.results).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string).include_domains).toBeUndefined();
  });

  it('a brand the residency policy refuses the vendor for is a quiet null, and the other brand still searches', async () => {
    policy.refuse = 'goapply';
    expect(await searchJobRequirements(QUERY, { brand: 'goapply' })).toBeNull();
    expect(await runWithBrand('goapply', () => searchJobRequirements(QUERY, { includeDomains: ['linkedin.com/jobs'] }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSearchAllowedFor('goapply')).toBe(false);
    expect(webSearchAllowedFor('roboapply')).toBe(true);
    expect(await searchJobRequirements(QUERY, { brand: 'roboapply' })).not.toBeNull();
  });

  it('RoboApply searches Tavily with the role query', async () => {
    const resp = await runWithBrand('roboapply', () => searchJobRequirements(QUERY));
    expect(resp?.results).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(TAVILY_SEARCH_URL);
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string).query).toBe(QUERY);
  });

  it('RoboApply: a query with an email, a phone number or the user’s name is not sent', async () => {
    for (const query of [`${QUERY} jane@example.com`, `${QUERY} +1 415 555 0134`]) {
      expect(await searchJobRequirements(query, { brand: 'roboapply' })).toBeNull();
    }
    expect(await searchJobRequirements(`Jane Doe ${QUERY}`, { brand: 'roboapply', knownValues: ['Jane Doe'] })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The same words without the known value go through.
    expect(await searchJobRequirements(`Jane Doe ${QUERY}`, { brand: 'roboapply', knownValues: ['Someone Else', null] })).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('no key or an empty query is still a quiet null', async () => {
    delete process.env.TAVILY_API_KEY;
    expect(await searchJobRequirements(QUERY, { brand: 'roboapply' })).toBeNull();
    process.env.TAVILY_API_KEY = 'tvly-test';
    expect(await searchJobRequirements('   ', { brand: 'roboapply' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

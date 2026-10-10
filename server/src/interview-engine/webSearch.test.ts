// @vitest-environment node
//
// INT-09 (R7): the interview engine's web search per brand. GoApply never
// calls the (offshore) search — also when session work runs inside the GoApply
// brand with no explicit brand passed (prepare, crons). RoboApply's query goes
// through the no-personal-information check before it is sent. No network:
// `fetch` is a spy.
// Run: npx vitest run server/src/interview-engine/webSearch.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runWithBrand } from '../lib/requestContext.js';
import { TAVILY_SEARCH_URL, searchJobRequirements, webSearchAllowedFor } from './webSearch.js';

const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;
const savedKey = process.env.TAVILY_API_KEY;

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [{ title: 't', url: 'https://x.example', content: 'c', score: 1 }] }), text: async () => '' });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedKey;
});

const QUERY = 'Backend Engineer job description requirements responsibilities qualifications';

describe('searchJobRequirements per brand', () => {
  it('GoApply never calls the offshore search, whether the brand is passed or ambient', async () => {
    expect(await searchJobRequirements(QUERY, { brand: 'goapply' })).toBeNull();
    expect(await runWithBrand('goapply', () => searchJobRequirements(QUERY))).toBeNull();
    // Even a domain-restricted search (which retries on the open web) sends nothing.
    expect(await runWithBrand('goapply', () => searchJobRequirements(QUERY, { includeDomains: ['linkedin.com/jobs'] }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSearchAllowedFor('goapply')).toBe(false);
    expect(webSearchAllowedFor('roboapply')).toBe(true);
  });

  it('an explicit brand wins over the ambient one, in both directions', async () => {
    expect(await runWithBrand('roboapply', () => searchJobRequirements(QUERY, { brand: 'goapply' }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await runWithBrand('goapply', () => searchJobRequirements(QUERY, { brand: 'roboapply' }))).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

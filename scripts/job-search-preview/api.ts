// Deliberately fictional fixtures. This module is only aliased by the loopback preview.
import type { JobSearchKey, ProviderInfo, SearchInput, SearchJob, SearchResult } from '../../lib/api/job-search-types';
import { RoboApiError } from '../../lib/api/client';
export { failedSearchResult, JOB_SEARCH_CURL_EXAMPLE, JOB_SEARCH_OPENAPI_URL } from '../../lib/api/job-search';

const scenario = () => new URLSearchParams(window.location.search).get('scenario');
const sources: ProviderInfo[] = [
  { id: 'jsearch', name: 'JSearch', enabled: true, sourceType: 'aggregator', homepage: 'https://example.invalid/jsearch' },
  { id: 'activejobs', name: 'Active Jobs DB', enabled: true, sourceType: 'aggregator', homepage: 'https://example.invalid/active' },
  { id: 'hiringindex', name: 'HiringIndex', enabled: false, sourceType: 'aggregator', homepage: 'https://example.invalid/hiring' },
];
const fixtureJob: SearchJob = {
  id: 'preview-job-1', title: 'Senior Product Engineer · Example role', company: 'Northstar Studio · Example employer', companyLogoUrl: null, location: 'Taipei, Taiwan', country: 'TW',
  description: 'This is fictional example content for visual QA.\n\nWork with a small product team to build reliable tools for people doing meaningful work. Own features from discovery through delivery, communicate tradeoffs, and improve the experience with customer feedback.\n\nExample requirements\n• Experience building accessible web applications\n• Clear written communication\n• Comfortable working across product and engineering',
  applyUrl: 'https://example.invalid/apply/1', sourceUrl: 'https://example.invalid/jobs/1', applyIsDirect: true, provider: 'jsearch', sources: [{ provider: 'jsearch', id: 'preview-1', applyUrl: 'https://example.invalid/apply/1', publisher: 'Example employer' }, { provider: 'activejobs', id: 'preview-a1', applyUrl: 'https://example.invalid/apply/1', publisher: null }],
  postedAt: '2026-09-10T01:00:00Z', fetchedAt: '2026-09-12T01:00:00Z', remote: true, employmentType: 'full_time', salary: { min: 120000, max: 180000, currency: 'TWD', period: 'month' },
};
let keys: JobSearchKey[] = [];
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 450));
export const jobSearchApi = {
  async providers() { return { providers: sources.map((source) => ({ ...source, enabled: scenario() === 'unconfigured' ? false : source.enabled })) }; },
  async search(input: SearchInput): Promise<SearchResult> {
    await pause();
    if (scenario() === 'error') throw new RoboApiError('Preview failure', { status: 503 });
    if (scenario() === 'rate_limited') throw new RoboApiError('Preview limit', { status: 429 });
    const jobs = scenario() === 'empty' ? [] : [fixtureJob, { ...fixtureJob, id: 'preview-job-2', title: 'Design Engineer · Example role', company: 'Common Ground · Example employer', location: 'Remote', salary: null, postedAt: null, provider: 'activejobs', sources: [fixtureJob.sources[1]] }, { ...fixtureJob, id: 'preview-job-3', title: 'Staff Software Engineer, Developer Experience · Example role', company: 'Field Notes · Example employer', location: 'San Francisco, CA', salary: { min: 180000, max: 230000, currency: 'USD', period: 'year' }, remote: null, sources: [fixtureJob.sources[0]] }];
    return { jobs, meta: { totalReturned: jobs.length, deduplicated: 1, partial: scenario() === 'partial', providers: sources.filter((source) => input.providers?.includes(source.id)).map((source) => ({ id: source.id, name: source.name, status: scenario() === 'partial' && source.id === 'activejobs' ? 'timeout' : 'ok', resultCount: jobs.length })), searchedAt: fixtureJob.fetchedAt, cache: 'miss', requestId: 'preview-request-example' } };
  },
  async keys() { return { keys }; },
  async createKey(name: string) {
    await pause();
    const key = { id: `preview-key-${keys.length + 1}`, name, prefix: 'rjs_EXAMPLE', createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() };
    keys = [key, ...keys];
    return { key, token: 'rjs_EXAMPLE_ONLY_NOT_A_REAL_CREDENTIAL' };
  },
  async revokeKey(id: string) { await pause(); keys = keys.filter((key) => key.id !== id); },
};

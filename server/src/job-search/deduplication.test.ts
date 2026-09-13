// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deduplicateJobs } from './normalization.js';
import type { SearchJob } from './types.js';

function job(id: string, provider = 'activejobs'): SearchJob {
  const applyUrl = `https://careers.example.com/${id}`;
  return {
    id, title: 'Software Engineer', company: 'Example employer', location: 'Taipei', country: 'TW',
    companyLogoUrl: null, description: 'Role details', applyUrl, sourceUrl: applyUrl,
    applyIsDirect: true, provider, sources: [{ id, provider, applyUrl, publisher: null }],
    postedAt: null, fetchedAt: '2026-09-12T00:00:00Z', remote: null, employmentType: null, salary: null,
  };
}

describe('distinct requisition preservation', () => {
  it('keeps distinct IDs from one source even if the employer, title and location match', () => {
    const result = deduplicateJobs([job('req-1'), job('req-2')]);
    expect(result.jobs.map(item => item.id)).toEqual(['req-1', 'req-2']);
    expect(result.deduplicated).toBe(0);
  });
  it('does not arbitrarily attach another source to an ambiguous role fingerprint', () => {
    const result = deduplicateJobs([job('req-1'), job('req-2'), job('other', 'jsearch')]);
    expect(result.jobs).toHaveLength(3);
  });
  it('still merges a confirmed identical application URL despite different provider IDs', () => {
    const first = job('req-1');
    const duplicate = job('provider-other', 'jsearch');
    duplicate.applyUrl = first.applyUrl;
    const result = deduplicateJobs([first, duplicate]);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sources).toHaveLength(2);
  });
  it('does not let an aggregator bridge two distinct requisitions from the same ATS', () => {
    const first = job('req-1'); first.title = 'Engineer';
    const second = job('req-2');
    const bridge = job('other', 'jsearch'); bridge.applyUrl = first.applyUrl;
    expect(deduplicateJobs([first, second, bridge]).jobs).toHaveLength(2);
  });
});

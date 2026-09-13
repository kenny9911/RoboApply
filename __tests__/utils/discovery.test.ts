import { describe, expect, it } from 'vitest';
import type { RAJobListItem } from '../../lib/api/v2';
import { filterDiscoveryJobs, formatSalary } from '../../components/v3/today/lib';

const jobs: RAJobListItem[] = [
  { id: 'a', title: 'Product designer', companyName: 'North Studio', location: 'Taipei', workType: 'hybrid', salaryMin: 100000, salaryMax: null, salaryCurrency: 'TWD', companyLogoUrl: null, postedAt: null, isBookmarked: false, matchScoreCached: null },
  { id: 'b', title: 'Software engineer', companyName: 'Remote Studio', location: null, workType: 'remote', salaryMin: null, salaryMax: null, salaryCurrency: null, companyLogoUrl: null, postedAt: null, isBookmarked: false, matchScoreCached: null },
];

describe('discovery filters', () => {
  it('keeps unscored jobs and unknown salaries in the unfiltered collection', () => {
    expect(filterDiscoveryJobs(jobs, { query: '', workType: 'all', salaryOnly: false })).toEqual(jobs);
  });

  it('combines case-insensitive keyword terms across company, role, and location', () => {
    expect(filterDiscoveryJobs(jobs, { query: '  DESIGNER taipei studio  ', workType: 'hybrid', salaryOnly: true }).map((job) => job.id)).toEqual(['a']);
    expect(filterDiscoveryJobs(jobs, { query: 'designer', workType: 'remote', salaryOnly: false })).toEqual([]);
  });

  it('only removes unknown salary records when disclosure is explicitly selected', () => {
    expect(filterDiscoveryJobs(jobs, { query: '', workType: 'all', salaryOnly: true }).map((job) => job.id)).toEqual(['a']);
    expect(filterDiscoveryJobs(jobs, { query: 'remote', workType: 'all', salaryOnly: false }).map((job) => job.id)).toEqual(['b']);
  });
});

describe('disclosed compensation', () => {
  it('does not invent a currency or round a disclosed salary into another amount', () => {
    expect(formatSalary(null, null, null)).toBeNull();
    expect(formatSalary(1550, 1550, 'USD')).toBe('US$1.55k');
    expect(formatSalary(125000, 150000, 'CAD')).toBe('CA$125k–150k');
    expect(formatSalary(500, 500, null)).toBe('500');
    expect(formatSalary(100000, 120000, 'TWD')).toBe('TWD 100k–120k');
  });

  it('keeps the meaning of one-sided salary bounds', () => {
    expect(formatSalary(90000, null, 'AUD')).toBe('≥ A$90k');
    expect(formatSalary(null, 50, 'USD')).toBe('≤ US$50');
  });
});

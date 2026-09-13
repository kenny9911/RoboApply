import { describe, expect, it } from 'vitest';
import { jobDate, jobSalary, safeJobUrl } from '../../components/job-search/format';

describe('job search source display', () => {
  it('only allows web destinations and rejects injected URL schemes', () => {
    expect(safeJobUrl('javascript:alert(1)')).toBeNull();
    expect(safeJobUrl('data:text/html,hello')).toBeNull();
    expect(safeJobUrl('/relative')).toBeNull();
    expect(safeJobUrl('https://employer.example/job')).toBe('https://employer.example/job');
  });
  it('preserves unknown salary and dates and does not invent a salary period', () => {
    expect(jobSalary(null, 'en')).toBeNull();
    expect(jobSalary({ min: null, max: null, currency: 'USD', period: 'year' }, 'en')).toBeNull();
    expect(jobSalary({ min: 70000, max: null, currency: 'USD', period: null }, 'en')).toBe('USD ≥ 70,000');
    expect(jobDate(null, 'en')).toBeNull();
    expect(jobDate('invalid', 'en')).toBeNull();
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { jobWhereForFilters } from './jobFilters.js';
import { deliverableEmail } from './repo.js';

const expand = (ids: readonly string[]) => ids.flatMap((id) => (id === 'software_engineering' ? ['backend_engineer', 'frontend_engineer'] : []));

describe('jobWhereForFilters', () => {
  it('always limits to the brand market, public, canonical and open jobs (never users’ imports)', () => {
    const w = jobWhereForFilters({}, 'cn', expand);
    expect(w).toEqual({ AND: [{ market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null }] });
  });

  it('roles expand through the taxonomy; unknown roles match nothing rather than everything', () => {
    expect(jobWhereForFilters({ taxonomyIds: ['software_engineering'] }, 'intl', expand).AND).toContainEqual({
      taxonomyIds: { hasSome: ['backend_engineer', 'frontend_engineer'] },
    });
    expect(jobWhereForFilters({ taxonomyIds: ['nope'] }, 'intl', expand).AND).toContainEqual({ id: { in: [] } });
  });

  it('keeps "not stated" jobs for requirement and sponsorship filters (nullable columns)', () => {
    const and = jobWhereForFilters({ excludeRequirements: ['citizenship', 'clearance'], needsSponsorship: true, excludeAgencies: true }, 'intl', expand).AND as unknown[];
    expect(and).toContainEqual({ OR: [{ citizenshipRequired: null }, { citizenshipRequired: false }] });
    expect(and).toContainEqual({ OR: [{ clearanceRequired: null }, { clearanceRequired: false }] });
    expect(and).toContainEqual({ OR: [{ sponsorship: null }, { sponsorship: { not: 'not_offered' } }] });
    expect(and).toContainEqual({ OR: [{ isAgency: null }, { isAgency: false }] });
  });

  it('pay floor: listed pay must reach it, unlisted pay stays unless "Only jobs that list pay"', () => {
    const keep = jobWhereForFilters({ salaryMin: { amount: 5000, currency: 'USD', period: 'month' } }, 'intl', expand).AND as unknown[];
    expect(keep).toContainEqual({ OR: [{ salaryCurrency: 'USD', salaryAnnualMax: { gte: 60000 } }, { salaryAnnualMax: null }] });
    const only = jobWhereForFilters({ salaryMin: { amount: 50, currency: 'USD', period: 'hour' }, includeUndisclosedPay: false }, 'intl', expand).AND as unknown[];
    expect(only).toContainEqual({ salaryCurrency: 'USD', salaryAnnualMax: { gte: 104000 } });
    expect(jobWhereForFilters({ includeUndisclosedPay: false }, 'intl', expand).AND).toContainEqual({ salaryDisclosed: true });
  });

  it('places: cities exactly (plus remote when asked), else countries', () => {
    const and = jobWhereForFilters(
      { workModels: ['remote', 'hybrid'], locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', radiusKm: 40 }] },
      'intl',
      expand,
    ).AND as unknown[];
    expect(and).toContainEqual({ OR: [{ locationCity: { equals: 'Austin', mode: 'insensitive' }, locationCountry: 'US' }, { workModel: 'remote' }] });
    const countries = jobWhereForFilters({ locations: [{ label: 'Germany', country: 'DE', radiusKm: 0 }] }, 'intl', expand).AND as unknown[];
    expect(countries).toContainEqual({ OR: [{ locationCountry: { in: ['DE'] } }] });
  });

  it('companies and titles compare case-insensitively', () => {
    const and = jobWhereForFilters({ excludedCompanies: ['ACME Inc'], titles: ['Data Analyst'] }, 'intl', expand).AND as unknown[];
    expect(and).toContainEqual({ NOT: { companyNameNormalized: { contains: 'acme inc' } } });
    expect(and).toContainEqual({ OR: [{ titleNormalized: { contains: 'data analyst' } }] });
  });
});

describe('deliverableEmail', () => {
  it('never returns placeholder or .invalid addresses', () => {
    expect(deliverableEmail('a@example.com', false)).toBe('a@example.com');
    expect(deliverableEmail('a@example.com', true)).toBeNull();
    expect(deliverableEmail('138xxx@users.goapply.invalid', false)).toBeNull();
    expect(deliverableEmail('nope', false)).toBeNull();
    expect(deliverableEmail(null, false)).toBeNull();
  });
});

describe('jobWhereForFilters: skills, years and company facts', () => {
  it('skills include/exclude, years overlap keeps "not stated", sizes map to company bands', () => {
    const and = jobWhereForFilters(
      { skills: ['SQL'], excludedSkills: ['Java'], yearsRange: { min: 2, max: 5 }, companySizes: ['201-1000'], excludedIndustries: ['Gambling'] },
      'intl',
      expand,
    ).AND as unknown[];
    expect(and).toContainEqual({ skills: { hasSome: ['sql'] } });
    expect(and).toContainEqual({ NOT: { skills: { hasSome: ['java'] } } });
    expect(and).toContainEqual({ OR: [{ minYears: null }, { minYears: { lte: 5 } }] });
    expect(and).toContainEqual({ OR: [{ maxYears: null }, { maxYears: { gte: 2 } }] });
    expect(and).toContainEqual({ company: { is: { sizeBand: { in: ['201-500', '501-1000'] } } } });
    expect(and).toContainEqual({ OR: [{ companyId: null }, { company: { is: { NOT: { industries: { hasSome: ['Gambling'] } } } } }] });
  });
});

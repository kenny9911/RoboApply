// server/src/features/alerts/jobFilters.ts
//
// FilterSet v1 → RAJob `where` for `AlertsRepo.candidateJobIds`, the earlier
// Prisma candidate source. NOT used in production since the INT gate: job
// alerts (join J4) and the re-engagement count (lifecycle `countNewJobsWith`)
// both select through `feedService.alertCandidates`, with the feed's own
// filter rules. It stays for the alert tests that still read
// `candidateJobIds`; delete it with them (WP-97). This narrow translation
// covers the filters that decide whether a job belongs to a saved search. Where a value
// is unknown, include-filters drop the job (an alert may miss a job rather
// than send one outside the search); exclusion filters keep "not stated".
//
// Not translated yet (listed in the handoff): location radius (an exact city
// match is used instead, which is narrower), `postedWithinDays` (alerts only
// look at new jobs anyway), `fitTier` (alerts use their own Possible-or-better
// rule) and the GoApply-only fields (`classYear`, `degree`, `employmentType`,
// `internDays`, `dailyPay`, `hukouTag`, `schoolTiers`), which have no
// structured job columns; GoApply alerts stay off while `jobs.alerts` is off.
//
// Always: the brand's market, public, canonical, open (not archived/closed).
// Jobs with fraud flags are dropped by the repo after the query (JSON column).
// Users' own imports never alert (D3: they are private).

import type { Prisma } from '../../generated/prisma/client.js';
import type { Market } from '../../platform/brand/registry.js';
import type { FilterSet } from '../search/index.js';

/** FilterSet company-size buckets → RACompany.sizeBand values. */
const SIZE_BANDS: Record<string, string[]> = {
  '1-10': ['1-10'],
  '11-50': ['11-50'],
  '51-200': ['51-200'],
  '201-1000': ['201-500', '501-1000'],
  '1001-5000': ['1001-5000'],
  '5000+': ['5001+'],
};

const PERIOD_FACTOR: Record<string, number> = { year: 1, month: 12, hour: 2080 };

function insensitive(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/**
 * `expandTaxonomyIds` is passed in so callers decide how taxonomy loads
 * (the production repo imports it lazily).
 */
export function jobWhereForFilters(
  filters: FilterSet,
  market: Market,
  expandTaxonomyIds: (ids: readonly string[]) => string[],
): Prisma.RAJobWhereInput {
  const and: Prisma.RAJobWhereInput[] = [
    { market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
  ];

  if (filters.taxonomyIds?.length) {
    const roles = expandTaxonomyIds(filters.taxonomyIds);
    // Unknown ids only: the profile names roles we cannot resolve; match nothing rather than everything.
    and.push(roles.length ? { taxonomyIds: { hasSome: roles } } : { id: { in: [] } });
  }
  if (filters.titles?.length) {
    and.push({ OR: insensitive(filters.titles).map((t) => ({ titleNormalized: { contains: t } })) });
  }
  if (filters.excludedTitles?.length) {
    for (const t of insensitive(filters.excludedTitles)) and.push({ NOT: { titleNormalized: { contains: t } } });
  }
  if (filters.q) {
    const q = filters.q.trim();
    and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { companyName: { contains: q, mode: 'insensitive' } }] });
  }
  if (filters.workModels?.length) and.push({ workModel: { in: [...filters.workModels] } });
  if (filters.jobTypes?.length) and.push({ employmentType: { in: [...filters.jobTypes] } });
  if (filters.seniority?.length) and.push({ seniority: { in: [...filters.seniority] } });
  if (filters.roleType) and.push({ roleType: filters.roleType });

  // Place: the country, then cities (an exact city is narrower than a radius, never wider).
  const remoteOk = filters.workModels?.includes('remote') ?? false;
  if (filters.country) {
    and.push({
      OR: [
        { locationCountry: filters.country },
        ...(remoteOk ? [{ workModel: 'remote', OR: [{ remoteScope: filters.country }, { remoteScope: 'global' }] } as Prisma.RAJobWhereInput] : []),
      ],
    });
  }
  const cities = (filters.locations ?? []).filter((l) => l.city);
  if (cities.length) {
    and.push({
      OR: [
        ...cities.map((l) => ({
          locationCity: { equals: l.city!, mode: 'insensitive' as const },
          ...(l.country ? { locationCountry: l.country } : {}),
        })),
        ...(remoteOk ? [{ workModel: 'remote' }] : []),
      ],
    });
  } else if (filters.locations?.length) {
    const countries = [...new Set(filters.locations.map((l) => l.country).filter((c): c is string => !!c))];
    if (countries.length) and.push({ OR: [{ locationCountry: { in: countries } }, ...(remoteOk ? [{ workModel: 'remote' }] : [])] });
  }

  // Pay floor: postings that list pay must reach it; undisclosed pay stays unless "Only jobs that list pay".
  if (filters.salaryMin) {
    const factor = PERIOD_FACTOR[filters.salaryMin.period] ?? 1;
    const annual = Math.round(filters.salaryMin.amount * factor);
    const meets: Prisma.RAJobWhereInput = { salaryCurrency: filters.salaryMin.currency, salaryAnnualMax: { gte: annual } };
    and.push(filters.includeUndisclosedPay === false ? meets : { OR: [meets, { salaryAnnualMax: null }] });
  } else if (filters.includeUndisclosedPay === false) {
    and.push({ salaryDisclosed: true });
  }

  // Nullable columns: "not stated" (null) stays in; SQL NOT would drop it.
  if (filters.excludeRequirements?.includes('citizenship')) and.push({ OR: [{ citizenshipRequired: null }, { citizenshipRequired: false }] });
  if (filters.excludeRequirements?.includes('clearance')) and.push({ OR: [{ clearanceRequired: null }, { clearanceRequired: false }] });
  if (filters.needsSponsorship) and.push({ OR: [{ sponsorship: null }, { sponsorship: { not: 'not_offered' } }] });

  if (filters.companies?.length) {
    and.push({ OR: insensitive(filters.companies).map((c) => ({ companyNameNormalized: { contains: c } })) });
  }
  if (filters.excludedCompanies?.length) {
    for (const c of insensitive(filters.excludedCompanies)) and.push({ NOT: { companyNameNormalized: { contains: c } } });
  }
  if (filters.excludeAgencies) and.push({ OR: [{ isAgency: null }, { isAgency: false }] });
  if (filters.recruiterJobsOnly) and.push({ fromRecruiterBank: true });
  if (filters.employerTags?.length) and.push({ employerTags: { hasSome: [...filters.employerTags] } });
  if (filters.salaryMonthsMin) and.push({ salaryMonths: { gte: filters.salaryMonthsMin } });

  // Skills (normalized lower case on the job).
  if (filters.skills?.length) and.push({ skills: { hasSome: insensitive(filters.skills) } });
  if (filters.excludedSkills?.length) and.push({ NOT: { skills: { hasSome: insensitive(filters.excludedSkills) } } });

  // Years asked for: overlap with the person's range; "not stated" stays.
  if (filters.yearsRange?.max !== undefined) and.push({ OR: [{ minYears: null }, { minYears: { lte: filters.yearsRange.max } }] });
  if (filters.yearsRange?.min !== undefined) and.push({ OR: [{ maxYears: null }, { maxYears: { gte: filters.yearsRange.min } }] });

  // Company facts (RACompany): include-filters need a known value.
  if (filters.industries?.length) and.push({ company: { is: { industries: { hasSome: [...filters.industries] } } } });
  if (filters.excludedIndustries?.length) {
    and.push({ OR: [{ companyId: null }, { company: { is: { NOT: { industries: { hasSome: [...filters.excludedIndustries] } } } } }] });
  }
  if (filters.companySizes?.length) {
    const bands = [...new Set(filters.companySizes.flatMap((b) => SIZE_BANDS[b] ?? []))];
    and.push({ company: { is: { sizeBand: { in: bands } } } });
  }

  return { AND: and };
}

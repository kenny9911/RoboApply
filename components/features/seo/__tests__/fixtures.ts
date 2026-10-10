// Fixtures for the SEO web tests (shapes from server/src/features/seo/contract.ts).

import type { PublicJobDetail, SeoPageResponse, TickerItem } from '../../../../lib/api/contracts/seo';

const AS_OF = '2026-10-10T00:00:00.000Z';
export const n = (value: number, extra: Record<string, unknown> = {}) => ({ value, source: 'index', asOf: AS_OF, method: 'Jobs in our index that we may show publicly.', ...extra });

export const ROLE = { id: 'backend_engineer', slug: 'backend-engineer', label: 'Backend engineer', labelZh: '后端工程师' };
export const TAIPEI = { id: 'tw-taipei', slug: 'taipei', name: 'Taipei', zh: '台北', zhHant: '臺北', country: 'TW' };

export function job(over: Partial<PublicJobDetail> = {}): PublicJobDetail {
  return {
    id: 'cmjob1',
    idSlug: 'cmjob1-backend-engineer-acme',
    path: '/job/cmjob1-backend-engineer-acme',
    title: 'Backend Engineer',
    companyName: 'Acme',
    location: 'Taipei, Taiwan',
    country: 'TW',
    workModel: 'hybrid',
    employmentType: 'full_time',
    pay: { min: 1_200_000, max: 1_600_000, currency: 'TWD', period: 'year' },
    postedAt: '2026-10-01T00:00:00.000Z',
    firstSeenAt: '2026-10-02T00:00:00.000Z',
    sourceName: 'RoboHire',
    originalSourceName: null,
    sponsorshipQuote: null,
    descriptionPlain: 'Build services.\n\nRun them well.',
    qualifications: 'Go or Java.',
    responsibilities: null,
    benefits: null,
    applyUrl: 'https://jobs.acme.example/apply/1',
    sourceUrl: 'https://jobs.acme.example/1',
    expiresAt: '2026-11-30T00:00:00.000Z',
    seniority: 'mid',
    remoteScope: null,
    region: null,
    city: 'Taipei',
    salaryText: null,
    company: { name: 'Acme', website: 'https://acme.example', logoUrl: null },
    canonicalPath: '/job/cmjob1-backend-engineer-acme',
    ...over,
  };
}

export function page(over: Partial<SeoPageResponse> = {}): SeoPageResponse {
  return {
    type: 'role_city',
    slug: 'backend-engineer/taipei',
    path: '/browse/backend-engineer/taipei',
    redirect: false,
    indexable: true,
    floor: 5,
    country: null,
    role: ROLE,
    city: TAIPEI,
    sponsorCountry: null,
    segment: null,
    method: null,
    stats: {
      jobCount: n(26),
      newLast7d: n(4),
      payListed: n(22, { sampleSize: 26 }),
      medianPay: { value: { value: 1_200_000, currency: 'TWD', period: 'year' }, source: 'aggregate', sampleSize: 22, asOf: AS_OF, method: 'Median of listed yearly pay.' },
      topCompanies: [{ name: 'Acme', count: n(3) }],
      asOf: AS_OF,
    },
    intro: { template: 'role_city', params: { count: 26, newLast7d: 4, payListed: 22 } },
    jobs: [job()],
    up: { kind: 'role', path: '/browse/backend-engineer', role: ROLE, jobCount: null },
    children: [],
    ...over,
  };
}

export const TICKER: TickerItem[] = [
  { id: 'a', idSlug: 'a-data-analyst', path: '/job/a-data-analyst', title: 'Data Analyst', companyName: 'Acme', location: 'Austin, TX', firstSeenAt: '2026-10-10T11:55:00.000Z', postedAt: '2026-10-09T00:00:00.000Z' },
  { id: 'b', idSlug: 'b-designer', path: '/job/b-designer', title: 'Designer', companyName: 'Beta', location: null, firstSeenAt: '2026-10-10T09:00:00.000Z', postedAt: null },
];

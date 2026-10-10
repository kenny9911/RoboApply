// server/src/features/seo/service.ts
//
// The SEO reads behind /api/v1/public/seo (contract.ts). Every list and
// number goes through `publicJobWhere` (scope.ts) for the brand's market;
// nothing here is cached (the CDN and the web's unstable_cache are).

import type { EnvSource, ProductBrand } from '../../platform/brand/index.js';
import { isEnabled as platformIsEnabled, type FlagKey } from '../../platform/flags.js';
import { HttpError, httpError, type Sourced } from '../../platform/http.js';
import { cnPostingVisible } from '../cn/jobs/index.js';
import { findCity } from '../jobs/geo/index.js';
import { getTaxonomyNode } from '../jobs/taxonomy/index.js';
import {
  INDEX_FLOORS,
  SEO_HUB_LIMIT,
  SEO_PAGE_CHILD_LIMIT,
  SEO_PAGE_JOB_LIMIT,
  SITEMAP_PARTITION_MAX,
  SPONSORSHIP_METHOD,
  TICKER_LIMIT,
  SeoPageParamsSchema,
  type PublicJobCard,
  type PublicJobDetail,
  type SeoHubResponse,
  type SeoLink,
  type SeoPageQuery,
  type SeoPageResponse,
  type SeoPageStats,
  type SitemapIndexResponse,
  type SitemapPartResponse,
  type TickerResponse,
} from './contract.js';
import { browseTarget, jobIdSlug, jobPath, resolveBrowsePath, targetFromParams, type BrowseTarget } from './paths.js';
import { defaultSeoRepo, type SeoJobDetailRow, type SeoJobRow, type SeoRepo } from './repo.js';
import { allowedPublicBoards, isPubliclyListable, type JobScope, type ScopeContext } from './scope.js';
import { floorFor, indexCount, introFor, isIndexable, medianPay, statsView } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pay rows read for the median (more than enough for MIN_SAMPLE; bounded for cost). */
const PAY_ROWS_MAX = 5000;

/** A closed (or expired / archived) job: the route answers 410. */
export class SeoGoneError extends Error {
  constructor() {
    super('This job has closed.');
    this.name = 'SeoGoneError';
  }
}

export interface SeoServiceDeps {
  repo?: SeoRepo | (() => Promise<SeoRepo>);
  env?: EnvSource;
  now?: () => Date;
  isEnabled?: (key: FlagKey, brand: ProductBrand) => Promise<boolean>;
}

export interface SeoService {
  page(brand: ProductBrand, query: SeoPageQuery): Promise<SeoPageResponse>;
  hub(brand: ProductBrand): Promise<SeoHubResponse>;
  job(brand: ProductBrand, id: string): Promise<PublicJobDetail>;
  ticker(brand: ProductBrand): Promise<TickerResponse>;
  sitemapIndex(brand: ProductBrand): Promise<SitemapIndexResponse>;
  sitemapPart(brand: ProductBrand, part: string): Promise<SitemapPartResponse>;
  /** Stats of one page target (the cron shares it). */
  stats(brand: ProductBrand, scope: JobScope): Promise<SeoPageStats>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Public card of a job row (pay only when disclosed; posted date only when not estimated). */
export function toPublicCard(row: SeoJobRow): PublicJobCard {
  const pay =
    row.salaryDisclosed && (row.salaryMin != null || row.salaryMax != null) && row.salaryCurrency && row.salaryPeriod
      ? { min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod }
      : null;
  return {
    id: row.id,
    idSlug: jobIdSlug(row.id, row.title, row.companyName),
    path: jobPath(row.id, row.title, row.companyName),
    title: row.title,
    companyName: row.companyName,
    location: row.location ?? row.locationCity ?? null,
    country: row.locationCountry,
    workModel: row.workModel,
    employmentType: row.employmentType,
    pay,
    postedAt: row.postedAtEstimated ? null : iso(row.postedAt),
    firstSeenAt: row.firstSeenAt.toISOString(),
    sourceName: row.sourceName,
    originalSourceName: row.originalSourceName,
    sponsorshipQuote: row.sponsorship === 'offered' && row.sponsorshipEvidence ? row.sponsorshipEvidence : null,
  };
}

/** A company field is shown only with a provenance entry in `facts` (D3). */
function hasFact(facts: unknown, field: string): boolean {
  return !!facts && typeof facts === 'object' && !Array.isArray(facts) && field in (facts as Record<string, unknown>);
}

export function toPublicDetail(row: SeoJobDetailRow): PublicJobDetail {
  const card = toPublicCard(row);
  const company = row.company;
  return {
    ...card,
    descriptionPlain: row.descriptionPlain,
    qualifications: row.qualifications,
    responsibilities: row.responsibilities,
    benefits: row.benefits,
    applyUrl: row.applyUrl,
    sourceUrl: row.sourceUrl,
    expiresAt: iso(row.expiresAt),
    seniority: row.seniority,
    remoteScope: row.remoteScope,
    region: row.locationRegion,
    city: row.locationCity,
    salaryText: row.salaryDisclosed ? null : row.salaryText,
    company: {
      name: company?.displayName || row.companyName,
      website: company && company.website && hasFact(company.facts, 'website') ? company.website : null,
      logoUrl: company && company.logoUrl && hasFact(company.facts, 'logoUrl') ? company.logoUrl : null,
    },
    canonicalPath: card.path,
  };
}

const HUB_LINK: SeoLink = { kind: 'hub', path: '/browse', jobCount: null };

function linkFor(target: BrowseTarget, jobCount: Sourced<number> | null): SeoLink {
  const kind: SeoLink['kind'] =
    target.type === 'role'
      ? 'role'
      : target.type === 'role_city'
        ? 'city'
        : target.type === 'remote_role'
          ? 'remote'
          : target.type === 'graduate_role'
            ? 'graduate'
            : target.type === 'sponsorship_role'
              ? 'sponsorship'
              : 'segment';
  return {
    kind,
    path: target.path,
    ...(target.role ? { role: target.role } : {}),
    ...(target.city ? { city: target.city } : {}),
    ...(target.segment ? { segment: target.segment } : {}),
    ...(target.sponsorCountry ? { country: target.sponsorCountry } : {}),
    jobCount,
  };
}

export function createSeoService(deps: SeoServiceDeps = {}): SeoService {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const getRepo = async (): Promise<SeoRepo> => (typeof deps.repo === 'function' ? deps.repo() : (deps.repo ?? defaultSeoRepo()));
  const flag = deps.isEnabled ?? ((key: FlagKey, brand: ProductBrand) => platformIsEnabled(key, { brand, env }));
  const ctxFor = (brand: ProductBrand): ScopeContext => ({ market: brand.market, now: now(), publicBoards: allowedPublicBoards(env) });

  async function stats(brand: ProductBrand, scope: JobScope): Promise<SeoPageStats> {
    const repo = await getRepo();
    const ctx = ctxFor(brand);
    const weekAgo = new Date(ctx.now.getTime() - 7 * DAY_MS);
    const [jobCount, newLast7d, payListed, payRows, topCompanies] = await Promise.all([
      repo.countJobs(scope, ctx),
      repo.countJobs(scope, ctx, { firstSeenSince: weekAgo }),
      repo.countJobs(scope, ctx, { payListed: true }),
      repo.payRows(scope, ctx, PAY_ROWS_MAX),
      repo.topCompanies(scope, ctx, 5),
    ]);
    const median = medianPay(payRows);
    return {
      jobCount,
      newLast7d,
      payListed,
      ...(median ? { medianSalary: median } : {}),
      topCompanies,
      asOf: ctx.now.toISOString(),
    };
  }

  /** Cities with enough jobs for an indexable role × city page, most first. */
  async function cityChildren(brand: ProductBrand, target: BrowseTarget): Promise<SeoLink[]> {
    const repo = await getRepo();
    const groups = await repo.groupCounts(target.scope, ctxFor(brand), ['locationCity', 'locationCountry'], 200);
    const byCity = new Map<string, { city: NonNullable<ReturnType<typeof findCity>>; count: number }>();
    for (const g of groups) {
      const city = findCity(g.keys.locationCity ?? null, { country: g.keys.locationCountry ?? null });
      if (!city) continue;
      const cur = byCity.get(city.id) ?? { city, count: 0 };
      cur.count += g.count;
      byCity.set(city.id, cur);
    }
    const out: SeoLink[] = [];
    for (const { city } of [...byCity.values()].sort((a, b) => b.count - a.count)) {
      if (out.length >= SEO_PAGE_CHILD_LIMIT) break;
      const child = browseTarget('role_city', { role: getTaxonomyNode(target.role!.id), city });
      // The exact count of the child page (its name list may cover rows grouped under other spellings).
      const count = await repo.countJobs(child.scope, ctxFor(brand));
      if (count >= INDEX_FLOORS.role_city) out.push(linkFor(child, indexCount(count, ctxFor(brand).now)));
    }
    return out;
  }

  async function variantChildren(brand: ProductBrand, target: BrowseTarget): Promise<SeoLink[]> {
    const repo = await getRepo();
    const node = getTaxonomyNode(target.role!.id);
    const out: SeoLink[] = [];
    for (const type of ['remote_role', 'graduate_role'] as const) {
      const child = browseTarget(type, { role: node });
      const count = await repo.countJobs(child.scope, ctxFor(brand));
      if (count >= INDEX_FLOORS[type]) out.push(linkFor(child, indexCount(count, ctxFor(brand).now)));
    }
    return out;
  }

  function upFor(target: BrowseTarget): SeoLink {
    if (target.type === 'role') {
      const parent = target.role ? getTaxonomyNode(target.role.id)?.parent : null;
      const node = parent ? getTaxonomyNode(parent) : null;
      return node ? linkFor(browseTarget('role', { role: node }), null) : HUB_LINK;
    }
    if (target.role && target.type !== 'segment') return linkFor(browseTarget('role', { role: getTaxonomyNode(target.role.id) }), null);
    return HUB_LINK;
  }

  return {
    stats,

    async page(brand, query) {
      const country = query.country ? query.country.toUpperCase() : null;
      const resolved = resolveBrowsePath(query.path, { country });
      if (!resolved.ok) throw httpError('not_found', undefined, { reason: resolved.reason });
      const target = resolved.target;
      // `?country=` narrows role, remote, graduate and segment lists (a city already implies its country).
      const filtered = !!country && target.type !== 'role_city' && target.type !== 'sponsorship_role';
      const scope: JobScope = filtered ? { ...target.scope, country: country! } : target.scope;
      const repo = await getRepo();
      const [s, rows] = await Promise.all([stats(brand, scope), repo.listJobs(scope, ctxFor(brand), { limit: SEO_PAGE_JOB_LIMIT, order: 'posted' })]);
      const children =
        target.type === 'role' && !filtered ? [...(await variantChildren(brand, target)), ...(await cityChildren(brand, target))] : [];
      return {
        type: target.type,
        slug: target.slug,
        path: target.path,
        redirect: resolved.redirect,
        indexable: isIndexable(target.type, s.jobCount, { filtered }),
        floor: floorFor(target.type),
        country: filtered ? country : null,
        role: target.role,
        city: target.city,
        sponsorCountry: target.sponsorCountry,
        segment: target.segment,
        method: target.type === 'sponsorship_role' ? SPONSORSHIP_METHOD : null,
        stats: statsView(s),
        intro: introFor(target, s),
        jobs: rows.map(toPublicCard),
        up: upFor(target),
        children,
      };
    },

    async hub(brand) {
      if (brand.market === 'cn') return { pages: [], asOf: now().toISOString() };
      const repo = await getRepo();
      const rows = await repo.listSeoPages(brand.id, { indexableOnly: true });
      const pages: SeoLink[] = [];
      for (const row of [...rows].sort((a, b) => b.jobCount - a.jobCount)) {
        if (pages.length >= SEO_HUB_LIMIT) break;
        const params = SeoPageParamsSchema.safeParse(row.params);
        const target = params.success ? targetFromParams(row.type, params.data) : null;
        if (target) pages.push(linkFor(target, indexCount(row.jobCount, row.lastBuiltAt)));
      }
      return { pages, asOf: now().toISOString() };
    },

    async job(brand, id) {
      const repo = await getRepo();
      const row = await repo.findJob(id);
      if (!row || row.market !== brand.market) throw new HttpError('not_found');
      if (brand.market === 'cn' && !cnPostingVisible(row, null, env)) throw new HttpError('not_found');
      const ctx = ctxFor(brand);
      const closed = row.closedAt !== null || row.archivedAt !== null || (row.expiresAt !== null && row.expiresAt.getTime() <= ctx.now.getTime());
      // Never public: a user's import, a duplicate, a job whose provider may not be shown, a flagged job.
      if (!isPubliclyListable({ ...row, closedAt: null, archivedAt: null, expiresAt: null }, ctx)) throw new HttpError('not_found');
      if (closed) throw new SeoGoneError();
      return toPublicDetail(row);
    },

    async ticker(brand) {
      const asOf = now().toISOString();
      // GoApply's home shows the campus calendar strip instead (PRODUCT F-MKT-02).
      if (brand.market === 'cn') return { items: [], asOf };
      const repo = await getRepo();
      const rows = await repo.listJobs({}, ctxFor(brand), { limit: TICKER_LIMIT, order: 'firstSeen' });
      return {
        items: rows.map((r) => {
          const c = toPublicCard(r);
          return { id: c.id, idSlug: c.idSlug, path: c.path, title: c.title, companyName: c.companyName, location: c.location, firstSeenAt: c.firstSeenAt, postedAt: c.postedAt };
        }),
        asOf,
      };
    },

    async sitemapIndex(brand) {
      const campus = await flag('jobs.campusCalendar', brand);
      // GoApply: browse and public job pages are deferred (PRODUCT F-SEO-*, cn column).
      if (brand.market === 'cn') return { parts: [], surfaces: { browse: false, campus } };
      const browse = await flag('seo.browse', brand);
      const repo = await getRepo();
      const parts: SitemapIndexResponse['parts'] = [];
      if (browse) {
        const pages = await repo.countSeoPages(brand.id, { indexableOnly: true });
        for (let i = 0; i < Math.ceil(pages / SITEMAP_PARTITION_MAX); i += 1) {
          parts.push({ name: `roles-${i + 1}`, count: Math.min(SITEMAP_PARTITION_MAX, pages - i * SITEMAP_PARTITION_MAX), lastmod: null });
        }
      }
      const jobs = await repo.countJobs({}, ctxFor(brand));
      for (let i = 0; i < Math.ceil(jobs / SITEMAP_PARTITION_MAX); i += 1) {
        parts.push({ name: `jobs-${i + 1}`, count: Math.min(SITEMAP_PARTITION_MAX, jobs - i * SITEMAP_PARTITION_MAX), lastmod: null });
      }
      return { parts, surfaces: { browse, campus } };
    },

    async sitemapPart(brand, part) {
      const m = /^(roles|jobs)-(\d{1,4})$/.exec(part);
      if (!m || brand.market === 'cn') throw new HttpError('not_found');
      const n = Number(m[2]);
      if (n < 1) throw new HttpError('not_found');
      const skip = (n - 1) * SITEMAP_PARTITION_MAX;
      const repo = await getRepo();
      if (m[1] === 'roles') {
        if (!(await flag('seo.browse', brand))) throw new HttpError('not_found');
        const rows = await repo.listSeoPages(brand.id, { indexableOnly: true, skip, take: SITEMAP_PARTITION_MAX });
        if (!rows.length) throw new HttpError('not_found');
        const urls: SitemapPartResponse['urls'] = [];
        for (const row of rows) {
          const params = SeoPageParamsSchema.safeParse(row.params);
          const target = params.success ? targetFromParams(row.type, params.data) : null;
          if (target) urls.push({ path: target.path, lastmod: row.lastBuiltAt.toISOString() });
        }
        return { urls };
      }
      const rows = await repo.listJobPage(ctxFor(brand), { skip, take: SITEMAP_PARTITION_MAX });
      if (!rows.length) throw new HttpError('not_found');
      return { urls: rows.map((r) => ({ path: jobPath(r.id, r.title, r.companyName), lastmod: r.updatedAt.toISOString() })) };
    },
  };
}

let shared: SeoService | null = null;
export function defaultSeoService(): SeoService {
  shared ??= createSeoService();
  return shared;
}

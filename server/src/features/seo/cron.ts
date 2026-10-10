// server/src/features/seo/cron.ts — `seo-rebuild` (04:00 UTC daily; ARCH §9.2).
//
// Called by server/src/cron/handlers.ts inside `runWithBrand(brand, …)` with a
// 240 s budget. Per brand:
//   1. skip at once when browse pages are off (`seo.browse`), or when the
//      brand shows no public postings (GoApply with
//      CN_RECRUITMENT_INFO_MODE=off) — under 2 s with nothing due;
//   2. enumerate candidate pages from real inventory (grouped counts of
//      publicly listable jobs: roles and their taxonomy parents, role × city,
//      remote, quote-backed sponsorship by country (RoboApply only:
//      `pageTypeOpen`), graduate, the two segments) plus every page already
//      stored;
//   3. per page, most jobs first, until the budget runs low: exact stats
//      (the same reader the page uses), indexable = jobCount ≥ floor, an
//      English title / h1 / intro built from a template whose numbers are
//      checked against the stats, upsert `RASeoPage`;
//   4. POST the tags of pages that changed (and the hub / sitemap tags) to
//      the web's `/api/revalidate` (secret-gated), which runs
//      `revalidateTag(tag, 'max')`;
//   5. brands indexed by Baidu push newly indexable URLs to Baidu's push API
//      when `CN_BAIDU_PUSH_TOKEN` is set (GoApply).
// Both brands run the same rebuild over their own market's rows (D5).

import { brandEnv, type EnvSource, type ProductBrand } from '../../platform/brand/index.js';
import { isEnabled as platformIsEnabled } from '../../platform/flags.js';
import type { CronContext, CronResult, CronTask } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import { findCity, type CityRecord } from '../jobs/geo/index.js';
import { getTaxonomyNode, taxonomyAncestors, type TaxonomyNode } from '../jobs/taxonomy/index.js';
import { INDEX_FLOORS, SEO_SEGMENTS, SeoPageParamsSchema, type SeoPageType } from './contract.js';
import { browseTarget, pageTypeOpen, seoCacheTag, targetFromParams, type BrowseTarget } from './paths.js';
import { defaultSeoRepo, type SeoPageRow, type SeoRepo } from './repo.js';
import { allowedPublicBoards, type JobScope, type ScopeContext } from './scope.js';
import { createSeoService, publicListingsOpen, type SeoService } from './service.js';
import { introNumbersMatch, introText, isIndexable } from './stats.js';

/** Stop starting new pages when this little budget is left (the run still reports). */
const RESERVE_MS = 15_000;
/** Groups read per candidate query. */
const GROUP_LIMIT = 5000;
const REVALIDATE_CHUNK = 100;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export interface SeoRebuildDeps {
  repo?: SeoRepo;
  service?: SeoService;
  env?: EnvSource;
  fetch?: FetchLike;
  isEnabled?: (key: 'seo.browse', brand: ProductBrand) => Promise<boolean>;
}

interface Candidate {
  target: BrowseTarget;
  /** Pre-count from the grouped query (ordering only; the stored count is exact). */
  weight: number;
}

const keyOf = (type: string, slug: string) => `${type}\u0000${slug}`;

/** English title / h1 for a stored page (the web localizes its own). */
export function pageTitle(target: BrowseTarget): string {
  const role = target.role?.label ?? '';
  switch (target.type) {
    case 'role':
      return `${role} jobs`;
    case 'role_city':
      return `${role} jobs in ${target.city?.name ?? ''}`;
    case 'remote_role':
      return `Remote ${role} jobs`;
    case 'sponsorship_role':
      return `${role} jobs with visa sponsorship in ${target.sponsorCountry ?? ''}`;
    case 'graduate_role':
      return `Graduate ${role} jobs`;
    case 'segment':
      return target.segment === 'internships' ? 'Internships' : 'Entry-level jobs';
    default:
      return role;
  }
}

/** Candidate pages from grouped counts of publicly listable jobs. */
export async function collectCandidates(repo: SeoRepo, ctx: ScopeContext): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();
  const add = (target: BrowseTarget, weight: number) => {
    const k = keyOf(target.type, target.slug);
    const cur = out.get(k);
    if (cur) cur.weight += weight;
    else out.set(k, { target, weight });
  };
  const roleOf = (id: string | null | undefined): TaxonomyNode | null => (id ? getTaxonomyNode(id) : null);

  for (const g of await repo.groupCounts({}, ctx, ['primaryTaxonomyId'], GROUP_LIMIT)) {
    const node = roleOf(g.keys.primaryTaxonomyId);
    if (!node) continue;
    for (const n of taxonomyAncestors(node.id)) add(browseTarget('role', { role: n }), g.count);
  }

  const perCity = new Map<string, { role: TaxonomyNode; city: CityRecord; count: number }>();
  for (const g of await repo.groupCounts({}, ctx, ['primaryTaxonomyId', 'locationCity', 'locationCountry'], GROUP_LIMIT)) {
    const role = roleOf(g.keys.primaryTaxonomyId);
    const city = findCity(g.keys.locationCity ?? null, { country: g.keys.locationCountry ?? null });
    if (!role || !city) continue;
    const k = `${role.id}|${city.id}`;
    const cur = perCity.get(k) ?? { role, city, count: 0 };
    cur.count += g.count;
    perCity.set(k, cur);
  }
  for (const { role, city, count } of perCity.values()) if (count >= INDEX_FLOORS.role_city) add(browseTarget('role_city', { role, city }), count);

  const scoped = async (scope: JobScope, type: 'remote_role' | 'graduate_role') => {
    for (const g of await repo.groupCounts(scope, ctx, ['primaryTaxonomyId'], GROUP_LIMIT)) {
      const role = roleOf(g.keys.primaryTaxonomyId);
      if (role && g.count >= INDEX_FLOORS[type]) add(browseTarget(type, { role }), g.count);
    }
  };
  await scoped({ remote: true }, 'remote_role');
  await scoped({ seniority: ['intern_newgrad'], internship: false }, 'graduate_role');

  // Visa-sponsorship pages exist on the international market only.
  if (pageTypeOpen('sponsorship_role', ctx.market)) {
    for (const g of await repo.groupCounts({ sponsorshipOffered: true }, ctx, ['primaryTaxonomyId', 'locationCountry'], GROUP_LIMIT)) {
      const role = roleOf(g.keys.primaryTaxonomyId);
      if (role && g.keys.locationCountry && g.count >= INDEX_FLOORS.sponsorship_role) add(browseTarget('sponsorship_role', { role, country: g.keys.locationCountry }), g.count);
    }
  }

  for (const segment of SEO_SEGMENTS) add(browseTarget('segment', { segment }), 0);
  return [...out.values()];
}

/** POST tags to the web's revalidate route. Returns how many tags were accepted. */
export async function postRevalidate(brand: ProductBrand, tags: string[], env: EnvSource, fetchImpl: FetchLike): Promise<{ revalidated: number; skipped?: string }> {
  if (!tags.length) return { revalidated: 0 };
  const secret = env.INTERNAL_API_SECRET?.trim();
  if (!secret) return { revalidated: 0, skipped: 'no_internal_secret' };
  const origin = (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
  let revalidated = 0;
  for (let i = 0; i < tags.length; i += REVALIDATE_CHUNK) {
    const chunk = tags.slice(i, i + REVALIDATE_CHUNK);
    try {
      const res = await fetchImpl(`${origin}/api/revalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ra-internal': secret },
        body: JSON.stringify({ tags: chunk }),
      });
      if (res.ok) revalidated += chunk.length;
      else logger.warn('SEO', 'revalidate refused', { brand: brand.id, status: res.status });
    } catch (err) {
      logger.warn('SEO', 'revalidate failed', { brand: brand.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { revalidated };
}

/** Baidu's URL push API (`data.zz.baidu.com/urls`); only for brands Baidu indexes, only when the token is set. */
export async function pushToBaidu(brand: ProductBrand, urls: string[], env: EnvSource, fetchImpl: FetchLike): Promise<{ pushed: number; skipped?: string }> {
  if (!brand.seo.searchEngines.includes('baidu')) return { pushed: 0, skipped: 'not_indexed_by_baidu' };
  const token = brandEnv(brand, 'BAIDU_PUSH_TOKEN', env);
  if (!token) return { pushed: 0, skipped: 'not_configured' };
  if (!urls.length) return { pushed: 0 };
  const site = new URL(brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).origin;
  try {
    const res = await fetchImpl(`http://data.zz.baidu.com/urls?site=${encodeURIComponent(site)}&token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: urls.join('\n'),
    });
    return res.ok ? { pushed: urls.length } : { pushed: 0, skipped: `http_${res.status}` };
  } catch (err) {
    logger.warn('SEO', 'baidu push failed', { brand: brand.id, error: err instanceof Error ? err.message : String(err) });
    return { pushed: 0, skipped: 'failed' };
  }
}

export function createSeoRebuild(deps: SeoRebuildDeps = {}): CronTask {
  return async (ctx: CronContext): Promise<CronResult> => {
    const { brand, budget } = ctx;
    const env = deps.env ?? process.env;
    const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
    // GoApply's off switch for postings: nothing to build, revalidate or push.
    if (!publicListingsOpen(brand, env)) return { skipped: 'postings_off' };
    const browseOn = deps.isEnabled ? await deps.isEnabled('seo.browse', brand) : await platformIsEnabled('seo.browse', { brand, env });
    if (!browseOn) return { skipped: 'disabled' };

    const repo = deps.repo ?? (await defaultSeoRepo());
    const service = deps.service ?? createSeoService({ repo, env, now: () => ctx.now });
    const scopeCtx: ScopeContext = { market: brand.market, now: ctx.now, publicBoards: allowedPublicBoards(env) };
    const locale = brand.defaultLocale;

    const stored = await repo.listSeoPages(brand.id, { indexableOnly: false });
    const prev = new Map<string, SeoPageRow>(stored.filter((r) => r.locale === locale).map((r) => [keyOf(r.type, r.slug), r]));
    const candidates = await collectCandidates(repo, scopeCtx);
    const seen = new Set(candidates.map((c) => keyOf(c.target.type, c.target.slug)));
    for (const row of prev.values()) {
      if (seen.has(keyOf(row.type, row.slug)) || !pageTypeOpen(row.type, brand.market)) continue;
      const params = SeoPageParamsSchema.safeParse(row.params);
      const target = params.success ? targetFromParams(row.type, params.data) : null;
      if (target) candidates.push({ target, weight: row.jobCount });
    }
    candidates.sort((a, b) => b.weight - a.weight || a.target.path.localeCompare(b.target.path));

    const tags: string[] = [];
    const newlyIndexable: string[] = [];
    let processed = 0;
    let upserted = 0;
    let indexable = 0;
    let rejectedIntros = 0;
    let stoppedBy: 'done' | 'budget' = 'done';
    for (const { target } of candidates) {
      if (budget.exhausted(RESERVE_MS)) {
        stoppedBy = 'budget';
        break;
      }
      processed += 1;
      const stats = await service.stats(brand, target.scope);
      const before = prev.get(keyOf(target.type, target.slug));
      if (stats.jobCount === 0 && !before) continue;
      const isIdx = isIndexable(target.type as SeoPageType, stats.jobCount);
      let intro = introText(target, stats);
      const labels = [target.role?.label ?? '', target.city?.name ?? '', target.sponsorCountry ?? ''];
      if (!introNumbersMatch(intro, stats, labels)) {
        rejectedIntros += 1;
        intro = '';
      }
      const title = pageTitle(target);
      await repo.upsertSeoPage({
        brand: brand.id,
        locale,
        type: target.type,
        slug: target.slug,
        params: target.params,
        title,
        h1: title,
        intro,
        stats,
        jobCount: stats.jobCount,
        indexable: isIdx,
        lastBuiltAt: ctx.now,
      });
      upserted += 1;
      if (isIdx) indexable += 1;
      if (!before || before.jobCount !== stats.jobCount || before.indexable !== isIdx) tags.push(seoCacheTag(brand.id, target.type, target.slug));
      if (isIdx && !before?.indexable) newlyIndexable.push(target.path);
    }
    if (tags.length) tags.push(seoCacheTag(brand.id, 'hub', 'all'), seoCacheTag(brand.id, 'sitemap', 'index'), seoCacheTag(brand.id, 'sitemap', 'roles'));

    const revalidate = await postRevalidate(brand, tags, env, fetchImpl);
    const origin = (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
    const baidu = await pushToBaidu(brand, newlyIndexable.map((p) => `${origin}${p}`), env, fetchImpl);
    const result: CronResult = {
      processed,
      upserted,
      indexable,
      candidates: candidates.length,
      changed: tags.length,
      revalidated: revalidate.revalidated,
      ...(revalidate.skipped ? { revalidateSkipped: revalidate.skipped } : {}),
      baiduPushed: baidu.pushed,
      rejectedIntros,
      stoppedBy,
    };
    logger.info('SEO', 'seo-rebuild', { brand: brand.id, ...result });
    return result;
  };
}

/** seo-rebuild (04:00 UTC daily): RASeoPage stats + revalidate tags (ARCH §9). */
export const runSeoRebuild: CronTask = (ctx) => createSeoRebuild()(ctx);

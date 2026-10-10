// server/src/features/seo/paths.ts
//
// Browse paths and public job slugs (TASK_PLAN.md WP-56 routes, R-05). Pure.
//
//   /browse/{role}                          role
//   /browse/{role}/{city}                   role_city (Taipei, Hsinchu, Taichung, Kaohsiung, …)
//   /browse/remote/{role}                   remote_role
//   /browse/visa-sponsorship/{country}/{role} sponsorship_role (RoboApply only: `pageTypeOpen`)
//   /browse/entry-level, /browse/internships segment
//   /browse/graduate/{role}                 graduate_role
//   /job/{id}-{slug}                        public job page
//
// Role slugs are taxonomy ids with `-` (`backend_engineer` → `backend-engineer`);
// a free-text role ("product designer" from the marketing quick search) is
// resolved through the taxonomy matcher and the page 301s to the canonical
// slug. City slugs are the city-table id without its country prefix
// (`tw-taipei` → `taipei`); a name shared by several table entries gets the
// country as a suffix for every entry but the first (`cambridge-gb`).

import { citiesNamed, cityById, countryByCode, findCity, type CityRecord } from '../jobs/geo/index.js';
import { bestTaxonomyMatch, getTaxonomyNode, isTaxonomyId, normalizeTitle, searchTaxonomy, type TaxonomyNode } from '../jobs/taxonomy/index.js';
import {
  SEO_SEGMENTS,
  type SeoCityRef,
  type SeoPageParams,
  type SeoPageType,
  type SeoRoleRef,
  type SeoSegment,
} from './contract.js';
import type { Market } from '../../platform/brand/registry.js';
import type { JobScope } from './scope.js';

/**
 * Does this market have this page type? Visa sponsorship is a question of the
 * international market only (GOAPPLY_PARITY_PLAN 3.12), so GoApply builds,
 * lists and serves no `sponsorship_role` page. Every reader and the rebuild
 * ask this one rule.
 */
export function pageTypeOpen(type: string, market: Market): boolean {
  return type !== 'sponsorship_role' || market !== 'cn';
}

// ── Job slugs ─────────────────────────────────────────────────────────────

/** ASCII slug of a title (`Senior Backend Engineer (Go)` → `senior-backend-engineer-go`); '' when nothing is left. */
export function slugifyTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** `<id>-<slug>`; just the id when the title has no ASCII letters (a CJK title). */
export function jobIdSlug(id: string, title: string, companyName?: string | null): string {
  const slug = slugifyTitle([title, companyName].filter(Boolean).join(' '));
  return slug ? `${id}-${slug}` : id;
}

export function jobPath(id: string, title: string, companyName?: string | null): string {
  return `/job/${jobIdSlug(id, title, companyName)}`;
}

/** The id inside `<id>-<slug>` (ids never contain `-`), or null. */
export function parseIdSlug(idSlug: string): string | null {
  const id = decodeURIComponent(idSlug).split('-')[0] ?? '';
  return /^[A-Za-z0-9_]{1,64}$/.test(id) ? id : null;
}

// ── Roles, cities ─────────────────────────────────────────────────────────

export function roleSlug(taxonomyId: string): string {
  return taxonomyId.replace(/_/g, '-');
}

export function roleRef(node: TaxonomyNode): SeoRoleRef {
  return { id: node.id, slug: roleSlug(node.id), label: node.en, labelZh: node.zh };
}

/** A role segment → the taxonomy node (any level), or null. */
export function resolveRole(segment: string): TaxonomyNode | null {
  const raw = decodeURIComponent(segment).trim();
  const id = raw.toLowerCase().replace(/-/g, '_');
  if (isTaxonomyId(id)) return getTaxonomyNode(id);
  const text = raw.replace(/-/g, ' ');
  const role = bestTaxonomyMatch(text);
  if (role) return getTaxonomyNode(role.id);
  // A category or group named exactly ("software engineering", "数据").
  const q = normalizeTitle(text);
  const exact = searchTaxonomy(text, { limit: 5 }).find((s) => s.matched === q);
  return exact ? getTaxonomyNode(exact.id) : null;
}

/** Canonical slug of a city-table entry. */
export function citySlug(city: CityRecord): string {
  const base = city.id.slice(city.id.indexOf('-') + 1);
  const named = citiesNamed(city.name);
  return named.length > 1 && named[0]!.id !== city.id ? `${base}-${city.country.toLowerCase()}` : base;
}

export function cityRef(city: CityRecord): SeoCityRef {
  return { id: city.id, slug: citySlug(city), name: city.name, zh: city.zh ?? null, zhHant: city.zhHant ?? null, country: city.country };
}

/** Lowercased names a job row's `locationCity` may carry for this city. */
export function cityNames(city: CityRecord): string[] {
  return [...new Set([city.name, city.zh, city.zhHant, ...(city.aliases ?? [])].filter((n): n is string => !!n).map((n) => n.toLowerCase()))];
}

/** A city segment (`taipei`, `new-york`, `cambridge-gb`, `台北`) → the table entry, or null. */
export function resolveCity(segment: string, country?: string | null): CityRecord | null {
  const raw = decodeURIComponent(segment).trim().toLowerCase();
  const suffix = /^(.*)-([a-z]{2})$/.exec(raw);
  if (suffix && countryByCode(suffix[2]!)) {
    const hit = findCity(suffix[1]!.replace(/-/g, ' '), { country: suffix[2]! });
    if (hit) return hit;
  }
  const name = raw.replace(/-/g, ' ');
  return findCity(name, { country: country ?? null }) ?? (country ? null : findCity(name));
}

// ── Browse targets ────────────────────────────────────────────────────────

export interface BrowseTarget {
  type: SeoPageType;
  /** Canonical slug (`RASeoPage.slug`): `backend-engineer`, `backend-engineer/taipei`, `us/backend-engineer`, `entry-level`. */
  slug: string;
  /** Canonical path. */
  path: string;
  role: SeoRoleRef | null;
  city: SeoCityRef | null;
  sponsorCountry: string | null;
  segment: SeoSegment | null;
  scope: JobScope;
  params: SeoPageParams;
}

export type BrowseResolution =
  | { ok: true; target: BrowseTarget; redirect: boolean }
  | { ok: false; reason: 'invalid_path' | 'unknown_role' | 'unknown_city' | 'unknown_country' };

const NEW_GRAD: JobScope['seniority'] = ['intern_newgrad'];
const ENTRY: JobScope['seniority'] = ['intern_newgrad', 'entry'];

/** Build the target for known parts (the cron uses this directly). */
export function browseTarget(
  type: SeoPageType,
  parts: { role?: TaxonomyNode | null; city?: CityRecord | null; country?: string | null; segment?: SeoSegment | null },
): BrowseTarget {
  const role = parts.role ? roleRef(parts.role) : null;
  const city = parts.city ? cityRef(parts.city) : null;
  const params: SeoPageParams = {};
  if (role) params.taxonomyId = role.id;
  if (parts.city) params.city = parts.city.id;
  switch (type) {
    case 'role':
      return { type, slug: role!.slug, path: `/browse/${role!.slug}`, role, city: null, sponsorCountry: null, segment: null, scope: { taxonomyId: role!.id }, params };
    case 'role_city': {
      const slug = `${role!.slug}/${city!.slug}`;
      return {
        type,
        slug,
        path: `/browse/${slug}`,
        role,
        city,
        sponsorCountry: null,
        segment: null,
        scope: { taxonomyId: role!.id, city: { names: cityNames(parts.city!), country: parts.city!.country } },
        params,
      };
    }
    case 'remote_role':
      return { type, slug: role!.slug, path: `/browse/remote/${role!.slug}`, role, city: null, sponsorCountry: null, segment: null, scope: { taxonomyId: role!.id, remote: true }, params: { ...params, segment: 'remote' } };
    case 'sponsorship_role': {
      const country = parts.country!.toUpperCase();
      const slug = `${country.toLowerCase()}/${role!.slug}`;
      return {
        type,
        slug,
        path: `/browse/visa-sponsorship/${slug}`,
        role,
        city: null,
        sponsorCountry: country,
        segment: null,
        scope: { taxonomyId: role!.id, sponsorshipCountry: country },
        params: { ...params, country, segment: 'visa-sponsorship' },
      };
    }
    case 'segment': {
      const segment = parts.segment!;
      const scope: JobScope = segment === 'internships' ? { internship: true } : { seniority: ENTRY, internship: false };
      return { type, slug: segment, path: `/browse/${segment}`, role: null, city: null, sponsorCountry: null, segment, scope, params: { segment } };
    }
    case 'graduate_role':
      return {
        type,
        slug: role!.slug,
        path: `/browse/graduate/${role!.slug}`,
        role,
        city: null,
        sponsorCountry: null,
        segment: null,
        scope: { taxonomyId: role!.id, seniority: NEW_GRAD, internship: false },
        params: { ...params, segment: 'graduate' },
      };
    default: {
      const never: never = type;
      throw new Error(`unknown page type ${String(never)}`);
    }
  }
}

/** Page type + raw slug from a path, without resolving anything (the web's cache key uses this too). */
export function classifyBrowsePath(path: string): { type: SeoPageType; parts: string[] } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const [a, b, c] = parts as [string, string | undefined, string | undefined];
  if (parts.length === 1 && (SEO_SEGMENTS as readonly string[]).includes(a)) return { type: 'segment', parts };
  if (a === 'remote') return parts.length === 2 ? { type: 'remote_role', parts: [b!] } : null;
  if (a === 'graduate') return parts.length === 2 ? { type: 'graduate_role', parts: [b!] } : null;
  if (a === 'visa-sponsorship') return parts.length === 3 ? { type: 'sponsorship_role', parts: [b!, c!] } : null;
  if (parts.length === 1) return { type: 'role', parts };
  if (parts.length === 2) return { type: 'role_city', parts };
  return null;
}

/** Resolve a browse path (`backend-engineer/taipei`) to its canonical target. */
export function resolveBrowsePath(path: string, opts: { country?: string | null } = {}): BrowseResolution {
  const cls = classifyBrowsePath(path);
  if (!cls) return { ok: false, reason: 'invalid_path' };
  const requested = `/browse/${path.split('/').filter(Boolean).join('/')}`;
  const finish = (target: BrowseTarget): BrowseResolution => ({ ok: true, target, redirect: decodeURIComponent(requested) !== target.path });

  if (cls.type === 'segment') return finish(browseTarget('segment', { segment: cls.parts[0] as SeoSegment }));
  if (cls.type === 'sponsorship_role') {
    const country = countryByCode(cls.parts[0]!);
    if (!country) return { ok: false, reason: 'unknown_country' };
    const role = resolveRole(cls.parts[1]!);
    if (!role) return { ok: false, reason: 'unknown_role' };
    return finish(browseTarget('sponsorship_role', { role, country: country.code }));
  }
  const role = resolveRole(cls.parts[0]!);
  if (!role) return { ok: false, reason: 'unknown_role' };
  if (cls.type === 'role_city') {
    const city = resolveCity(cls.parts[1]!, opts.country ?? null);
    if (!city) return { ok: false, reason: 'unknown_city' };
    return finish(browseTarget('role_city', { role, city }));
  }
  return finish(browseTarget(cls.type, { role }));
}

/** The target a stored `RASeoPage` row describes, or null when its params no longer resolve. */
export function targetFromParams(type: string, params: SeoPageParams): BrowseTarget | null {
  const role = params.taxonomyId ? getTaxonomyNode(params.taxonomyId) : null;
  switch (type) {
    case 'role':
    case 'remote_role':
    case 'graduate_role':
      return role ? browseTarget(type, { role }) : null;
    case 'role_city': {
      const city = cityById(params.city);
      return role && city ? browseTarget(type, { role, city }) : null;
    }
    case 'sponsorship_role':
      return role && params.country ? browseTarget(type, { role, country: params.country }) : null;
    case 'segment':
      return params.segment && (SEO_SEGMENTS as readonly string[]).includes(params.segment) ? browseTarget('segment', { segment: params.segment as SeoSegment }) : null;
    default:
      return null;
  }
}

/** `seo:<brand>:<type>:<slug>` — the web's unstable_cache tag for a page. */
export function seoCacheTag(brand: string, type: string, slug: string): string {
  return `seo:${brand}:${type}:${slug}`;
}

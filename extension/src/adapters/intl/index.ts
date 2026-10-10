// extension/src/adapters/intl/index.ts — RoboApply's form adapters.
//
// WP-55b shipped Greenhouse, Lever and Ashby. WP-70 adds Workday,
// SmartRecruiters, iCIMS, Workable, Taleo, SuccessFactors and the
// label-heuristic generic adapter for requested hosts (GENERIC_SITES). The
// manifest's host permissions and content-script matches follow this list
// (src/manifest.ts), and the popup's "can't be filled yet" list drops every
// site that has an adapter (adapters/registry.ts). Order matters: specific
// adapters first, the generic ones last.

import type { AtsAdapter, AtsType } from '../types';
import { ashbyAdapter } from './ashby';
import { GENERIC_ADAPTERS } from './generic';
import { greenhouseAdapter } from './greenhouse';
import { icimsAdapter } from './icims';
import { leverAdapter } from './lever';
import { smartRecruitersAdapter } from './smartrecruiters';
import { successFactorsAdapter, successFactorsStepKey } from './successfactors';
import { taleoAdapter, taleoStepKey } from './taleo';
import { workableAdapter } from './workable';
import { workdayAdapter, workdayStepKey } from './workday';

export const INTL_ADAPTERS: readonly AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workdayAdapter,
  smartRecruitersAdapter,
  icimsAdapter,
  workableAdapter,
  taleoAdapter,
  successFactorsAdapter,
  ...GENERIC_ADAPTERS,
];

/**
 * Forms spread over several pages that the user moves through with the
 * site's own buttons. Each page is filled on its own ("Fill this page"); the
 * step key names the page the user is on (null when the page shows none), so
 * the panel can offer a new fill when it changes. Nothing here moves pages.
 */
export const MULTI_PAGE_STEP: Partial<Record<AtsType, (doc: Document) => string | null>> = {
  workday: workdayStepKey,
  taleo: taleoStepKey,
  successfactors: successFactorsStepKey,
};

export function isMultiPage(adapter: Pick<AtsAdapter, 'id'>): boolean {
  return adapter.id in MULTI_PAGE_STEP;
}

/** The page of a multi-page form the user is on, or null (single-page form, or no step shown). */
export function formStepKey(adapter: Pick<AtsAdapter, 'id'>, doc: Document): string | null {
  return MULTI_PAGE_STEP[adapter.id]?.(doc) ?? null;
}

/**
 * The key the content controller should detect and mount the panel by:
 * `baseKey` (origin + path) plus the step on a multi-page form, so moving to
 * the next Workday page at the same URL counts as a new page to fill. For
 * single-page forms it is `baseKey` unchanged. (R4: the controller and panel
 * adopt this; one run should cover every page of one application.)
 */
export function formPageKey(adapter: Pick<AtsAdapter, 'id'> | null, doc: Document, baseKey: string): string {
  if (!adapter || !isMultiPage(adapter)) return baseKey;
  const step = formStepKey(adapter, doc);
  return step ? `${baseKey}#step=${encodeURIComponent(step)}` : baseKey;
}

/** Form-host ids the server should list as fillable (`EXTENSION_ATS_TYPES_BY_MARKET.intl`). */
export const INTL_FILLABLE_ATS_TYPES: readonly AtsType[] = [...new Set(INTL_ADAPTERS.map((a) => a.id).filter((id) => id !== 'generic'))];

/** A form host this build fills, by the host permissions it is granted. */
export interface IntlFormSite {
  id: AtsType;
  siteName: string;
  /** Registrable hosts, e.g. `myworkdayjobs.com` (subdomains included). */
  domains: string[];
  /** The manifest match patterns, e.g. `https://*.taleo.net/careersection/*`. */
  hostPatterns: string[];
}

function patternHost(pattern: string): string | null {
  const m = pattern.match(/^https?:\/\/(\*\.)?([^/*]+)\//);
  return m ? m[2].toLowerCase() : null;
}

/**
 * Every form host the shipped adapters serve (one row per site name). The
 * popup can tell "this site is supported — open its application form" apart
 * from "this site can't be filled yet": an adapter's matches() needs the
 * form on the page, so a job description page on Workday finds no adapter
 * even though Workday forms are filled.
 */
export const INTL_FORM_SITES: readonly IntlFormSite[] = (() => {
  const bySite = new Map<string, IntlFormSite>();
  for (const a of INTL_ADAPTERS) {
    const row = bySite.get(a.siteName) ?? { id: a.id, siteName: a.siteName, domains: [], hostPatterns: [] };
    for (const p of a.hostPatterns) {
      if (!row.hostPatterns.includes(p)) row.hostPatterns.push(p);
      const host = patternHost(p);
      if (host && !row.domains.includes(host)) row.domains.push(host);
    }
    bySite.set(a.siteName, row);
  }
  return [...bySite.values()];
})();

/** Chrome match-pattern semantics for the https patterns adapters declare. */
export function matchesHostPattern(url: URL, pattern: string): boolean {
  const m = pattern.match(/^(\*|https?):\/\/(\*\.)?([^/]+)(\/.*)$/);
  if (!m) return false;
  const [, scheme, anySub, host, path] = m;
  if (scheme === '*' ? !/^https?:$/.test(url.protocol) : url.protocol !== `${scheme}:`) return false;
  const h = url.hostname.toLowerCase();
  const base = host.toLowerCase();
  if (!(h === base || (anySub && h.endsWith(`.${base}`)))) return false;
  const re = new RegExp(`^${path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(`${url.pathname}${url.search}`);
}

/**
 * The supported form site for a page the extension has access to, or null.
 * True on the site's job description pages too, where no form is open yet.
 */
export function intlFormSiteForUrl(url: URL): IntlFormSite | null {
  return INTL_FORM_SITES.find((s) => s.hostPatterns.some((p) => matchesHostPattern(url, p))) ?? null;
}

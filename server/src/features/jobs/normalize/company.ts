// server/src/features/jobs/normalize/company.ts
//
// The RACompany upsert payload for a job's company (ARCH §4.4 "Company").
// D3: a company field is filled only from a provider / bank statement that
// names its source, and each filled field gets a provenance entry in `facts`
// ({ source, url?, fetchedAt }). Size and industry are never guessed.

import type { Market } from '../../../platform/brand/index.js';
import { atsTypeFromUrl, isJobBoardHost } from './ats.js';
import { cleanOrNull, hostOf, safeUrl, truncate } from './text.js';
import type { CompanyFactsInput, CompanyUpsert } from './types.js';
import { toDate } from './identity.js';

// ── The employer's registrable domain (K3 of the dedupe key; JI-5) ─────────

/** Leading labels that name a careers site, not a company: careers.stripe.com is stripe.com. */
const CAREER_LABELS: ReadonlySet<string> = new Set(['www', 'careers', 'jobs', 'job', 'work', 'boards', 'apply', 'recruiting']);
/**
 * Second-level labels that name a category, not an organisation, under a
 * two-letter country code: acme.co.uk, ucl.ac.uk, bartshealth.nhs.uk,
 * ntu.edu.tw, acme.com.mx. The registrable domain is then the last THREE
 * labels, and the two-label suffix alone names nobody.
 */
const GENERIC_SECOND_LEVEL: ReadonlySet<string> = new Set([
  'co', 'com', 'org', 'net', 'edu', 'gov', 'ac', 'or', 'ne', 'go', 'gob', 'govt', 'gouv', 'gv', 'gc', 'mil', 'nhs', 'police',
  'sch', 'ltd', 'plc', 'me', 'idv', 'nom',
]);
/** Under .us a state code is a namespace (austin.tx.us, state.ca.us), and k12 / cc / lib under it one more (lausd.k12.ca.us). */
const US_STATE_LABELS: ReadonlySet<string> = new Set(
  ('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy ' +
    'dc as gu mp pr vi').split(' '),
);
const US_STATE_SUB_LABELS: ReadonlySet<string> = new Set(['k12', 'cc', 'lib']);
/** Under .cn a province code is a namespace (acme.sh.cn, acme.gd.cn). */
const CN_PROVINCE_LABELS: ReadonlySet<string> = new Set(
  'ah bj cq fj gd gs gz gx ha hb he hi hl hn jl js jx ln nm nx qh sc sd sh sn sx tj xj xz yn zj hk mo tw'.split(' '),
);

/**
 * How many trailing labels of a host are a public suffix, by rule and not by
 * the Public Suffix List (no dependency for it): 1 for a plain top-level
 * domain; 2 under a country code when the second level is a category
 * (`GENERIC_SECOND_LEVEL`), a US state or a mainland province; 3 for
 * `*.sch.uk` (schools register one level deeper) and `k12.<state>.us`.
 */
function publicSuffixLabels(labels: readonly string[]): number {
  const n = labels.length;
  const tld = labels[n - 1]!;
  const second = labels[n - 2];
  if (second === undefined || tld.length !== 2) return 1;
  if (tld === 'us' && US_STATE_LABELS.has(second)) return US_STATE_SUB_LABELS.has(labels[n - 3] ?? '') ? 3 : 2;
  if (tld === 'cn' && CN_PROVINCE_LABELS.has(second)) return 2;
  if (tld === 'uk' && second === 'sch') return 3;
  return GENERIC_SECOND_LEVEL.has(second) ? 2 : 1;
}

/**
 * Hosts under which many unrelated sites or profiles live: site builders,
 * code and app hosting, and social networks a small employer gives as its
 * "website". The last two labels of such a host name the platform, not the
 * employer, so no domain is read from it and the name key is used.
 */
const SHARED_HOST_SUFFIXES: readonly string[] = [
  'github.io', 'gitlab.io', 'notion.site', 'wixsite.com', 'webflow.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev',
  'web.app', 'firebaseapp.com', 'wordpress.com', 'blogspot.com', 'squarespace.com', 'myshopify.com', 'weebly.com', 'godaddysites.com',
  'carrd.co', 'sites.google.com', 'business.site', 'linktr.ee', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'linkedin.com', 'lnkd.in', 'weibo.com', 'mp.weixin.qq.com', 'line.me',
];
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The lower-case host of a URL or of a bare host ("Careers.Stripe.com", "stripe.com/jobs", "stripe.com:443"); null when there is none. */
function hostOfUrlOrHost(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return safeUrl(s) ? new URL(safeUrl(s)!).hostname.toLowerCase() : null;
  const host = s.split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  return host || null;
}

/**
 * The registrable domain of a URL or host, or null when the helper cannot name
 * one: lower case, `www.` and career sub-domains (careers., jobs., job.,
 * work., boards., apply., recruiting.) removed, then the public suffix
 * (`publicSuffixLabels`) and the one label in front of it. An IP address, a
 * single-label host, a malformed host, a host on a shared-hosting or social
 * suffix, a bare suffix (gov.uk, ac.uk, com.mx) and a careers label standing
 * directly on a multi-part suffix (www.gov.uk, jobs.nhs.uk, careers.gov.sg:
 * a sector's shared portal, not one employer) give null. Null always means
 * "use the company name", which is the safe side: a domain that is too wide
 * would put different employers under one dedupe key.
 *
 *   registrableDomain('https://careers.stripe.com/jobs/1')  'stripe.com'
 *   registrableDomain('jobs.foo.co.uk')                     'foo.co.uk'
 *   registrableDomain('www.bartshealth.nhs.uk')             'bartshealth.nhs.uk'
 *   registrableDomain('acme.github.io')                     null
 *
 * It is not the Public Suffix List: a multi-part suffix the rule does not
 * cover (a Japanese prefecture, `pvt.k12.<state>.us`) is read one label short,
 * which is why the shared hosts above are refused.
 */
export function registrableDomain(urlOrHost: string | null | undefined): string | null {
  if (typeof urlOrHost !== 'string') return null;
  const host = hostOfUrlOrHost(urlOrHost);
  if (!host || host.includes(':') || /^[\d.]+$/.test(host)) return null;
  let labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return null;
  if (SHARED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  // The suffix is read from the last labels only, so it does not move while leading labels are dropped.
  const suffix = publicSuffixLabels(labels);
  // A careers label is dropped only while a name is left in front of the suffix.
  while (labels.length > suffix + 1 && CAREER_LABELS.has(labels[0]!)) labels = labels.slice(1);
  if (labels.length <= suffix) return null;
  if (suffix > 1 && CAREER_LABELS.has(labels[labels.length - suffix - 1]!)) return null;
  return labels.slice(-(suffix + 1)).join('.');
}

/**
 * The registrable domain of a host that is the EMPLOYER'S OWN, or null. A job
 * board's, an aggregator's or an ATS's host never names the employer
 * (boards.greenhouse.io/acme is Greenhouse's domain, not Acme's), so it gives
 * null, like everything `registrableDomain` refuses.
 */
export function employerDomain(urlOrHost: string | null | undefined): string | null {
  const domain = registrableDomain(urlOrHost);
  if (!domain || typeof urlOrHost !== 'string') return null;
  const host = hostOfUrlOrHost(urlOrHost);
  for (const h of [host, domain]) {
    if (!h) return null;
    if (isJobBoardHost(h.replace(/^www\./, '')) || atsTypeFromUrl(`https://${h}/`) !== 'other') return null;
  }
  return domain;
}

export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

/** The band an employee count falls in. */
export function sizeBandFromCount(count: number | null | undefined): SizeBand | null {
  if (count == null || !Number.isFinite(count) || count < 1) return null;
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 200) return '51-200';
  if (count <= 500) return '201-500';
  if (count <= 1000) return '501-1000';
  if (count <= 5000) return '1001-5000';
  return '5001+';
}

/** A provider size text ("51-200 employees", "10,001+", "1001-5000", "500人以上") → band, only when it fits one band exactly. */
export function sizeBandFromText(text: string | null | undefined): SizeBand | null {
  if (!text) return null;
  const s = text.normalize('NFKC').replace(/[,，\s]/g, '');
  const range = s.match(/^(\d+)[-–~至](\d+)/);
  if (range) {
    const lo = sizeBandFromCount(Number(range[1]));
    const hi = sizeBandFromCount(Number(range[2]));
    return lo && lo === hi ? lo : null;
  }
  const plus = s.match(/^(\d+)(?:\+|人以上|以上)/);
  if (plus && Number(plus[1]) > 5000) return '5001+';
  return null;
}

export interface CompanyInput {
  market: Market;
  displayName: string;
  nameNormalized: string;
  logoUrl: string | null;
  isAgency: boolean | null;
  bankCompanyRef: string | null;
  facts: CompanyFactsInput | null | undefined;
  /** Provenance for the logo when no facts block is given (e.g. 'provider:activejobs'). */
  logoSource: string;
  now: Date;
}

export function buildCompanyUpsert(input: CompanyInput): CompanyUpsert {
  const f = input.facts;
  const source = cleanOrNull(f?.source);
  const fetchedAt = (toDate(f?.fetchedAt ?? null) ?? input.now).toISOString();
  const url = safeUrl(f?.url ?? null);
  const provenance = source ? { source, ...(url ? { url } : {}), fetchedAt } : null;

  const out: CompanyUpsert = {
    market: input.market,
    displayName: input.displayName,
    nameNormalized: input.nameNormalized,
    logoUrl: safeUrl(input.logoUrl),
    isAgency: input.isAgency,
    bankCompanyRef: cleanOrNull(input.bankCompanyRef),
    website: null,
    domain: null,
    industries: [],
    sizeBand: null,
    employeeCount: null,
    hqLocation: null,
    foundedYear: null,
    description: null,
    facts: {},
  };
  if (out.logoUrl) out.facts.logoUrl = provenance ? { ...provenance } : { source: input.logoSource, fetchedAt };
  if (!f || !provenance) return out;

  const set = <K extends keyof CompanyUpsert>(key: K, value: CompanyUpsert[K] | null) => {
    if (value == null || (Array.isArray(value) && value.length === 0)) return;
    out[key] = value as CompanyUpsert[K];
    out.facts[key as string] = { ...provenance };
  };

  const website = safeUrl(f.website ?? null);
  set('website', website);
  set('domain', cleanOrNull(f.domain)?.toLowerCase().replace(/^www\./, '') ?? hostOf(website));
  set('industries', (f.industries ?? []).map((i) => cleanOrNull(i)).filter((i): i is string => !!i).slice(0, 5));
  const count = typeof f.employeeCount === 'number' && Number.isFinite(f.employeeCount) && f.employeeCount > 0 ? Math.round(f.employeeCount) : null;
  set('employeeCount', count);
  set('sizeBand', sizeBandFromCount(count) ?? sizeBandFromText(f.size));
  set('hqLocation', cleanOrNull(f.hqLocation));
  const year = typeof f.foundedYear === 'number' && f.foundedYear >= 1600 && f.foundedYear <= input.now.getUTCFullYear() ? f.foundedYear : null;
  set('foundedYear', year);
  const description = cleanOrNull(f.description);
  set('description', description ? truncate(description, 2000) : null);
  return out;
}

// server/src/features/jobs/normalize/ats.ts
//
// atsType from the apply / posting host (ARCH §4.4). Feeds the extension's
// adapter choice and the "apply on company site" path; a host we do not know
// is 'other'. Job boards and aggregators are not an ATS: they give null.
//
// Also here, because they read the same hosts (MKT-3C):
//   - the exact posting key K2 `<ats>:<tenant>:<postingId>` parsed from a
//     posting URL (MARKET_STRATEGY §1.5, JI-5). Only URL shapes that carry
//     BOTH the tenant and the posting id give a key; nothing is ever guessed;
//   - which of a posting's links a candidate should open (`pickEmployerLink`,
//     JI-6): the employer's or ATS's page before a job board's, and never
//     LinkedIn's or Indeed's.
// Nothing in this file fetches anything: it reads URL strings only.

import { hostOf, safeUrl } from './text.js';
import type { AtsType } from './types.js';

const ATS_HOSTS: [AtsType, RegExp][] = [
  ['greenhouse', /(^|\.)greenhouse\.io$/],
  ['lever', /(^|\.)lever\.co$/],
  ['workday', /(^|\.)myworkdayjobs\.com$|(^|\.)myworkday\.com$|(^|\.)workday\.com$/],
  ['ashby', /(^|\.)ashbyhq\.com$/],
  ['smartrecruiters', /(^|\.)smartrecruiters\.com$/],
  ['icims', /(^|\.)icims\.com$/],
  ['workable', /(^|\.)workable\.com$/],
  ['taleo', /(^|\.)taleo\.net$/],
  ['successfactors', /(^|\.)successfactors\.(com|eu|cn)$|(^|\.)sapsf\.(com|eu|cn)$/],
  ['moka', /(^|\.)mokahr\.com$/],
  ['beisen', /(^|\.)zhiye\.com$|(^|\.)beisen\.com$/],
  ['feishu', /(^|\.)jobs\.feishu\.cn$|(^|\.)jobs\.bytedance\.com$/],
  ['dayee', /(^|\.)dayee\.com$/],
  // Classified now (JI-8); their board connectors are MKT-5B.
  ['recruitee', /(^|\.)recruitee\.com$/],
  ['personio', /(^|\.)jobs\.personio\.(de|com)$/],
  ['teamtailor', /(^|\.)teamtailor\.com$/],
  ['bamboohr', /(^|\.)bamboohr\.com$/],
];

/**
 * Job boards, aggregators and search engines: their URLs say nothing about the
 * employer's ATS. Listed as full domains (a subdomain of one is a board too),
 * so an employer whose name is a common word keeps its own host:
 * careers.google.com, talent.acme.com and boss.example.com are employers.
 * Brands that exist under many country domains (indeed.co.uk, glassdoor.de …)
 * are matched by their distinctive label.
 */
const BOARD_DOMAINS = new Set([
  'linkedin.com', 'lnkd.in', 'careerbuilder.com', 'simplyhired.com', 'jooble.org', 'talent.com', 'dice.com', 'builtin.com',
  'wellfound.com', 'angel.co', 'otta.com', 'welcometothejungle.com', '104.com.tw', '1111.com.tw', 'yourator.co',
  'cakeresume.com', 'cake.me', 'zhipin.com', 'zhaopin.com', '51job.com', 'liepin.com', 'lagou.com', 'seek.com.au',
  'seek.co.nz', 'naukri.com', 'reed.co.uk', 'totaljobs.com', 'xing.com', 'rapidapi.com', 'gohire.top', 'robohire.io',
]);
const brandHosts = (...brands: string[]): RegExp => new RegExp(String.raw`(^|\.)(${brands.join('|')})\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$`);
const BOARD_BRANDS = brandHosts('indeed', 'glassdoor', 'ziprecruiter', 'monster', 'adzuna', 'jobsdb', 'jobstreet', 'stepstone');
/** Indeed under any of its country domains: the same pattern as its entry in `BOARD_BRANDS`. */
const INDEED_HOSTS = brandHosts('indeed');
/** Google's job search lives on the search host itself; careers.google.com is the employer. */
const SEARCH_HOSTS = new Set(['google.com', 'www.google.com']);

function isBoardHost(host: string): boolean {
  if (SEARCH_HOSTS.has(host) || BOARD_BRANDS.test(host)) return true;
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) if (BOARD_DOMAINS.has(labels.slice(i).join('.'))) return true;
  return false;
}

/** The ATS behind a URL, 'other' for an unknown employer host, null for none / a job board. */
export function atsTypeFromUrl(url: string | null | undefined): AtsType | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [type, re] of ATS_HOSTS) if (re.test(host)) return type;
  if (isBoardHost(host)) return null;
  return 'other';
}

/** The ATS behind the first URL that names one (apply link first, then the posting page). */
export function atsTypeFromUrls(...urls: (string | null | undefined)[]): AtsType | null {
  let other = false;
  for (const u of urls) {
    const t = atsTypeFromUrl(u);
    if (t && t !== 'other') return t;
    if (t === 'other') other = true;
  }
  return other ? 'other' : null;
}

/** True for a job-board / aggregator host. */
export function isJobBoardHost(host: string | null | undefined): boolean {
  return !!host && isBoardHost(host);
}

/** A LinkedIn page host (linkedin.com, its subdomains, the lnkd.in shortener). */
export function isLinkedInHost(host: string | null | undefined): boolean {
  return !!host && (host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in');
}

/** An Indeed host under any of its country domains (indeed.com, uk.indeed.com, indeed.co.uk, tw.indeed.com). */
export function isIndeedHost(host: string | null | undefined): boolean {
  return !!host && INDEED_HOSTS.test(host);
}

// ── Which link a candidate opens (JI-6) ───────────────────────────────────

/** What kind of page a posting link opens; null for a value that is not an http(s) URL. */
export type ApplyLinkKind = 'employer' | 'board' | 'linkedin' | 'indeed';

/** 'employer' = the employer's own site or an ATS; 'board' = any other job board, aggregator or search page. */
export function applyLinkKind(url: string | null | undefined): ApplyLinkKind | null {
  const host = hostOf(url);
  if (!host) return null;
  if (isLinkedInHost(host)) return 'linkedin';
  if (isIndeedHost(host)) return 'indeed';
  return atsTypeFromUrl(url) === null ? 'board' : 'employer';
}

export interface EmployerLinkPick {
  /**
   * The link a candidate should open: the first one on an employer or ATS
   * host, else the first one on a job board that is neither LinkedIn nor
   * Indeed. Null when there is no such link.
   */
  url: string | null;
  /** True when `url` is on an employer or ATS host (employer-direct by host, not by a provider's flag). */
  direct: boolean;
  /**
   * Set only when `url` is null although links were given: every usable link
   * is LinkedIn's or Indeed's. Names the site of the first of them.
   */
  only: 'linkedin' | 'indeed' | null;
}

/**
 * The one host rule for "where does this posting send a candidate"
 * (MARKET_STRATEGY M-3, JI-6), shared by the JSearch raw-payload adapter and
 * the normalizer so both paths agree. Links are read in the order given;
 * values that are not http(s) URLs are ignored. The returned URL is the
 * normalized form (`safeUrl`).
 */
export function pickEmployerLink(urls: readonly (string | null | undefined)[]): EmployerLinkPick {
  let board: string | null = null;
  let only: 'linkedin' | 'indeed' | null = null;
  for (const candidate of urls) {
    const url = safeUrl(candidate ?? null);
    const kind = url ? applyLinkKind(url) : null;
    if (!url || !kind) continue;
    if (kind === 'employer') return { url, direct: true, only: null };
    if (kind === 'board') board ??= url;
    else only ??= kind;
  }
  return board ? { url: board, direct: false, only: null } : { url: null, direct: false, only };
}

// ── K2: the exact posting key (JI-5) ──────────────────────────────────────

/** The ATS names a posting key may start with. `lever_eu` is Lever's EU data centre: its ids live in another namespace. */
export type AtsPostingKeyAts = 'greenhouse' | 'lever' | 'lever_eu' | 'ashby' | 'smartrecruiters' | 'workable' | 'workday' | 'icims';

/** The parts of a posting URL as the URL writes them (case kept). */
export interface AtsPostingRef {
  ats: AtsPostingKeyAts;
  /** Board token, site, organisation, company identifier or tenant sub-domain. */
  tenant: string;
  postingId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const DIGITS_RE = /^\d{1,20}$/;
const WORKDAY_HOST_RE = /^([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com$/;
const ICIMS_HOST_RE = /^([a-z0-9][a-z0-9.-]*)\.icims\.com$/;

function pathSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

const tenantOrNull = (value: string | undefined): string | null => (value && TENANT_RE.test(value) ? value : null);

/**
 * The (ats, tenant, posting id) a posting URL names, exactly as the URL writes
 * them, or null. Only these public URL shapes are read, and each must carry
 * both the tenant and the posting id:
 *
 *   Greenhouse       boards.greenhouse.io/{token}/jobs/{id}, job-boards.greenhouse.io/{token}/jobs/{id}
 *   Lever            jobs.lever.co/{site}/{uuid}          (jobs.eu.lever.co → ats 'lever_eu')
 *   Ashby            jobs.ashbyhq.com/{org}/{uuid}
 *   SmartRecruiters  jobs.smartrecruiters.com/{company}/{id}[-slug]   (the id is the leading digits)
 *   Workable         apply.workable.com/{slug}/j/{shortcode}
 *   Workday          {tenant}.wd{n}.myworkdayjobs.com/…/job/…/{slug}_{requisitionId}
 *   iCIMS            {sub}.icims.com/jobs/{id}/…
 *
 * An employer's own page that only carries `?gh_jid={id}` gives null: the
 * Greenhouse tenant is not in the URL and is never guessed. A board's listing
 * page (no posting id) gives null too.
 */
export function atsPostingRefFromUrl(url: string | null | undefined): AtsPostingRef | null {
  const safe = safeUrl(url ?? null);
  if (!safe) return null;
  const parsed = new URL(safe);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const seg = pathSegments(parsed.pathname);
  if (!seg) return null;
  const ref = (ats: AtsPostingKeyAts, tenant: string | null | undefined, postingId: string | null | undefined): AtsPostingRef | null =>
    tenant && postingId ? { ats, tenant, postingId } : null;

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    return seg.length >= 3 && seg[1] === 'jobs' && DIGITS_RE.test(seg[2]!) ? ref('greenhouse', tenantOrNull(seg[0]), seg[2]) : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return seg.length >= 2 && UUID_RE.test(seg[1]!) ? ref(host === 'jobs.eu.lever.co' ? 'lever_eu' : 'lever', tenantOrNull(seg[0]), seg[1]) : null;
  }
  if (host === 'jobs.ashbyhq.com') {
    return seg.length >= 2 && UUID_RE.test(seg[1]!) ? ref('ashby', tenantOrNull(seg[0]), seg[1]) : null;
  }
  if (host === 'jobs.smartrecruiters.com') {
    // "{id}" or "{id}-{slug}"; the apply flow (/oneclick-ui/company/…) names no posting id here.
    const id = seg.length === 2 ? (seg[1]!.match(/^(\d{4,20})(?:-|$)/)?.[1] ?? null) : null;
    return ref('smartrecruiters', tenantOrNull(seg[0]), id);
  }
  if (host === 'apply.workable.com') {
    return seg.length >= 3 && seg[1] === 'j' && /^[A-Za-z0-9]{6,20}$/.test(seg[2]!) ? ref('workable', tenantOrNull(seg[0]), seg[2]) : null;
  }
  const workday = host.match(WORKDAY_HOST_RE);
  if (workday) {
    // …/job/{location}/{slug}_{requisitionId}[/apply…]: the id is what follows the last underscore of the
    // posting's own segment (the last one before an "/apply" tail).
    const at = seg.indexOf('job');
    const rest = at >= 0 ? seg.slice(at + 1) : [];
    const tail = rest.indexOf('apply');
    const posting = tail >= 0 ? rest.slice(0, tail) : rest;
    const last = posting.length ? posting[posting.length - 1]! : '';
    const cut = last.lastIndexOf('_');
    const id = cut > 0 ? last.slice(cut + 1) : '';
    return /^[A-Za-z0-9-]{2,40}$/.test(id) && /\d/.test(id) ? ref('workday', workday[1], id) : null;
  }
  const icims = host.match(ICIMS_HOST_RE);
  if (icims) {
    return seg.length >= 2 && seg[0] === 'jobs' && DIGITS_RE.test(seg[1]!) ? ref('icims', icims[1], seg[1]) : null;
  }
  return null;
}

/** `<ats>:<tenant>:<postingId>`, lower case (an identity for comparison: never build a request URL from it without `atsPostingRefFromUrl`). */
export function atsPostingKeyOf(ref: AtsPostingRef): string {
  return `${ref.ats}:${ref.tenant}:${ref.postingId}`.toLowerCase();
}

/** K2 of one URL: `<ats>:<tenant>:<postingId>` in lower case, or null. */
export function atsPostingKeyFromUrl(url: string | null | undefined): string | null {
  const ref = atsPostingRefFromUrl(url);
  return ref ? atsPostingKeyOf(ref) : null;
}

/** K2 of a posting: the apply link first, then the posting page. */
export function atsPostingKeyFromUrls(applyUrl: string | null | undefined, sourceUrl?: string | null): string | null {
  return atsPostingKeyFromUrl(applyUrl) ?? atsPostingKeyFromUrl(sourceUrl);
}

/**
 * The `sourceBoard` values of employer-board rows whose `externalId` is
 * `<boardToken>:<postingId>`: the public job-board systems read today
 * (`PUBLIC_ATS` in sources/atsPublic/contract.ts; ats.test.ts fails when a
 * system is added there without a key rule here).
 */
const BOARD_KEY_ATS: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);

/**
 * K2 of an employer-board row, from the row's own identity: its board (the
 * ATS) and its externalId `<boardToken>:<postingId>`. The board API's id is
 * the authority here: a board's posting page may live on the employer's own
 * site (a Greenhouse `absolute_url` with `?gh_jid=`), where the URL names no
 * tenant. The `#cn` suffix of a posting's mainland copy (JC-4) is not part of
 * the key: both copies are the same posting, each in its own market.
 */
export function atsPostingKeyFromBoardRow(sourceBoard: string | null | undefined, externalId: string | null | undefined): string | null {
  const board = (sourceBoard ?? '').trim().toLowerCase();
  if (!BOARD_KEY_ATS.has(board) || typeof externalId !== 'string') return null;
  const id = externalId.trim().replace(/#cn$/i, '');
  const cut = id.indexOf(':');
  if (cut <= 0 || cut === id.length - 1 || id.indexOf(':', cut + 1) !== -1) return null;
  const tenant = id.slice(0, cut);
  const postingId = id.slice(cut + 1);
  if (!TENANT_RE.test(tenant) || /\s/.test(postingId)) return null;
  return `${board}:${tenant}:${postingId}`.toLowerCase();
}

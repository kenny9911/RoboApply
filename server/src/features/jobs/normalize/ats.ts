// server/src/features/jobs/normalize/ats.ts
//
// atsType from the apply / posting host (ARCH §4.4). Feeds the extension's
// adapter choice and the "apply on company site" path; a host we do not know
// is 'other'. Job boards and aggregators are not an ATS: they give null.

import { hostOf } from './text.js';
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
const BOARD_BRANDS = /(^|\.)(indeed|glassdoor|ziprecruiter|monster|adzuna|jobsdb|jobstreet|stepstone)\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
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

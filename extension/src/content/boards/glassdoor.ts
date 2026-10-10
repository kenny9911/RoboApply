// extension/src/content/boards/glassdoor.ts — a job open on Glassdoor
// (/job-listing/…htm, or a jobs search page with `jl=<id>`).
//
// Only the job details are read; reviews, salaries and the member are not.

import type { JobOnPage } from '../../adapters/types';
import { collapse, jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

export const GLASSDOOR_DOMAINS = [
  'glassdoor.com',
  'glassdoor.co.uk',
  'glassdoor.ca',
  'glassdoor.com.au',
  'glassdoor.co.in',
  'glassdoor.ie',
  'glassdoor.de',
  'glassdoor.fr',
  'glassdoor.sg',
  'glassdoor.com.hk',
] as const;

function listingId(url: URL): string | null {
  const jl = url.searchParams.get('jl');
  return jl && /^\d{5,}$/.test(jl) ? jl : null;
}

function isJobPage(url: URL): boolean {
  if (/^\/job-listing\//i.test(url.pathname)) return true;
  return /^\/(Job|job)\//.test(url.pathname) && listingId(url) !== null;
}

const EMPLOYER_SELECTORS = ['[data-test="employer-name"] h4', '[data-test="employer-name"]', '[class*="EmployerProfile_employerName"]'] as const;
const RATING_SELECTORS = '[data-test*="rating" i], [class*="rating" i], [aria-label*="rating" i]';

/**
 * The employer's name without the star rating Glassdoor shows beside it
 * ("Example Co 4.1 ★"). The rating element is dropped from a copy first; a
 * rating left in the text is only ever one digit, a point and one digit, so
 * names that end in a number ("Forever 21", "Area 51") keep it.
 */
export function employerName(doc: Document): string | undefined {
  for (const sel of EMPLOYER_SELECTORS) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(RATING_SELECTORS).forEach((n) => n.remove());
    const text = collapse(clone.textContent)
      .replace(/\s*[1-5]\.\d\s*★$/, '')
      .replace(/\s+[1-5]\.\d$/, '')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function fromDom(doc: Document): JobOnPage | null {
  const title = pick(doc, ['[data-test="job-title"]', '[id^="jd-job-title"]', '[class*="JobDetails_jobTitle"]']);
  const company = employerName(doc);
  const location = pick(doc, ['[data-test="location"]', '[class*="JobDetails_location"]']);
  const descriptionText = pickBlock(doc, ['[class*="JobDetails_jobDescription"]', '.jobDescriptionContent', '#JobDescriptionContainer']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

/** The page's own text first; the employer from schema.org when the page states it (no rating to strip there). */
function readGlassdoorJob(doc: Document): JobOnPage | null {
  const ld = jobFromJsonLd(doc);
  const merged = mergeJob(fromDom(doc), ld);
  if (merged && ld?.company) merged.company = ld.company;
  return merged;
}

export const glassdoorReader = defineBoard({
  id: 'glassdoor',
  siteName: 'Glassdoor',
  domains: GLASSDOOR_DOMAINS,
  isJobPage,
  readJob: readGlassdoorJob,
  canonicalUrl(url) {
    // The listing id (`jl`) names the open job on both page kinds; the rest of the query is search state.
    const jl = listingId(url);
    return jl ? `${url.origin}${url.pathname}?jl=${jl}` : `${url.origin}${url.pathname}`;
  },
});

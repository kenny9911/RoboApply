// extension/src/content/boards/ziprecruiter.ts — a job open on ZipRecruiter
// (/c/<employer>/Job/<role>…, /jobs/<id>, or a results page with `lk=<key>`).

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

function isJobPage(url: URL): boolean {
  if (/^\/c\/[^/]+\/Job\//i.test(url.pathname)) return true;
  if (/^\/jobs\/[^/]+/i.test(url.pathname) && !/^\/jobs\/search/i.test(url.pathname)) return true;
  return /^\/(jobs-search|candidate\/search)/i.test(url.pathname) && Boolean(url.searchParams.get('lk'));
}

function fromDom(doc: Document): JobOnPage | null {
  const title = pick(doc, ['h1.job_title', '[class*="job_title"] h1', '[data-testid="job-title"]', '.job_header h1']);
  const company = pick(doc, ['a.hiring_company_text', '.hiring_company_text', '[data-testid="job-card-company"]', '.hiring_company']);
  const location = pick(doc, ['.location_text', '[data-testid="job-card-location"]', '.job_location']);
  const descriptionText = pickBlock(doc, ['.job_description', '.jobDescriptionSection', '[data-testid="job-description"]']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

export const zipRecruiterReader = defineBoard({
  id: 'ziprecruiter',
  siteName: 'ZipRecruiter',
  domains: ['ziprecruiter.com', 'ziprecruiter.co.uk'],
  isJobPage,
  readJob: (doc) => mergeJob(jobFromJsonLd(doc), fromDom(doc)),
  canonicalUrl(url) {
    const lk = url.searchParams.get('lk');
    if (/^\/(jobs-search|candidate\/search)/i.test(url.pathname) && lk) return `${url.origin}${url.pathname}?lk=${encodeURIComponent(lk)}`;
    // /c/<employer>/Job/<role>/-in-<city> names a role and city, not one
    // posting: `jid` tells two postings apart, so it stays (tracking does not).
    const jid = url.searchParams.get('jid');
    if (/^\/c\/[^/]+\/Job\//i.test(url.pathname) && jid) return `${url.origin}${url.pathname}?jid=${encodeURIComponent(jid)}`;
    return `${url.origin}${url.pathname}`;
  },
});

// extension/src/content/boards/indeed.ts — a job open on Indeed
// (/viewjob?jk=<key>, or a results page with `vjk=<key>`; every country site).
//
// Reads the job pane only. Indeed appends a hidden "- job post" to the title
// for screen readers; it is removed.

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

const KEY_RE = /^[0-9a-f]{8,32}$/i;

function jobKeyOf(url: URL): string | null {
  for (const name of ['jk', 'vjk']) {
    const v = url.searchParams.get(name);
    if (v && KEY_RE.test(v)) return v;
  }
  return null;
}

function fromDom(doc: Document): JobOnPage | null {
  const rawTitle = pick(doc, [
    '[data-testid="jobsearch-JobInfoHeader-title"]',
    'h1.jobsearch-JobInfoHeader-title',
    'h2.jobsearch-JobInfoHeader-title',
    '.jobsearch-JobInfoHeader-title-container h1',
    '.jobsearch-JobInfoHeader-title-container h2',
  ]);
  const title = rawTitle?.replace(/\s*-\s*job post$/i, '').trim() || undefined;
  const company = pick(doc, [
    '[data-testid="inlineHeader-companyName"] a',
    '[data-testid="inlineHeader-companyName"]',
    '[data-company-name="true"]',
    '.jobsearch-CompanyInfoContainer a',
  ]);
  const location = pick(doc, [
    '[data-testid="inlineHeader-companyLocation"]',
    '[data-testid="job-location"]',
    '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
  ]);
  const descriptionText = pickBlock(doc, ['#jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]']);
  if (!title && !company) return null;
  return { title, company, location: location?.replace(/^•\s*/, ''), descriptionText };
}

export const indeedReader = defineBoard({
  id: 'indeed',
  siteName: 'Indeed',
  domains: ['indeed.com'],
  isJobPage: (url) => jobKeyOf(url) !== null,
  readJob: (doc) => mergeJob(fromDom(doc), jobFromJsonLd(doc)),
  canonicalUrl(url) {
    const key = jobKeyOf(url);
    return key ? `${url.origin}/viewjob?jk=${key}` : `${url.origin}${url.pathname}`;
  },
});

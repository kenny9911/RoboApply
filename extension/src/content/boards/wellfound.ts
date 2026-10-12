// extension/src/content/boards/wellfound.ts — a job open on Wellfound
// (/jobs/<id>-<slug>, /company/<employer>/jobs/<id>-<slug>).

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

function isJobPage(url: URL): boolean {
  return /^\/jobs\/\d+/.test(url.pathname) || /^\/company\/[^/]+\/jobs\/\d+/.test(url.pathname);
}

function fromDom(doc: Document): JobOnPage | null {
  const scope = doc.querySelector('main') ?? doc;
  const title = pick(scope, ['h1']);
  const company = pick(scope, ['a[href^="/company/"] h2', 'a[href^="/company/"]']);
  const location = pick(scope, ['[data-test="JobLocation"]', '[class*="location"]']);
  const descriptionText = pickBlock(scope, ['[data-test="JobDescription"]', '#job-description', '[class*="description"]']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

export const wellfoundReader = defineBoard({
  id: 'wellfound',
  siteName: 'Wellfound',
  domains: ['wellfound.com'],
  isJobPage,
  readJob: (doc) => mergeJob(jobFromJsonLd(doc), fromDom(doc)),
});

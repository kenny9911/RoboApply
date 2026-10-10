// extension/src/content/boards/cake.ts — a job open on Cake (formerly
// CakeResume; Taiwan and Asia): /companies/<employer>/jobs/<slug>.

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

function fromDom(doc: Document): JobOnPage | null {
  const title = pick(doc, ['[class*="JobDescriptionLeftColumn_title"]', '[class*="JobHeader_title"]', 'main h1', 'h1']);
  const company = pick(doc, ['[class*="JobDescriptionLeftColumn_name"]', '[class*="JobHeader_companyName"]', 'main a[href*="/companies/"]']);
  const location = pick(doc, ['[class*="JobDescriptionRightColumn_locationsWrapper"]', '[class*="JobHeader_location"]']);
  const descriptionText = pickBlock(doc, ['[class*="JobDescriptionLeftColumn_mainContent"]', '[class*="ContentSection_content"]', 'main article']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

export const cakeReader = defineBoard({
  id: 'cake',
  siteName: 'Cake',
  domains: ['cake.me', 'cakeresume.com'],
  isJobPage: (url) => /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?companies\/[^/]+\/jobs\/[^/]+\/?$/.test(url.pathname),
  readJob: (doc) => mergeJob(jobFromJsonLd(doc), fromDom(doc)),
});

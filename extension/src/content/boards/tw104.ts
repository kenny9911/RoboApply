// extension/src/content/boards/tw104.ts — a job open on 104 (Taiwan;
// www.104.com.tw/job/<code>). RoboApply serves Taiwan (international market).

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

function fromDom(doc: Document): JobOnPage | null {
  const title = pick(doc, ['.job-header__title h1', 'h1.job-header__title', '.job-header h1']);
  const company = pick(doc, ['.job-header__title a[href*="/company/"]', '.job-header a[href*="/company/"]', 'a[data-gtm-head="公司名稱"]']);
  const location = pick(doc, ['.job-address span', '.job-description-table__data .job-address', '[data-gtm-content="地址"]']);
  const descriptionText = pickBlock(doc, ['.job-description__content', '.job-description-table__data', '.job-description']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

export const tw104Reader = defineBoard({
  id: '104',
  siteName: '104',
  domains: ['104.com.tw'],
  isJobPage: (url) => /^\/job\/[0-9a-z]{4,}\/?$/i.test(url.pathname),
  readJob: (doc) => mergeJob(jobFromJsonLd(doc), fromDom(doc)),
});

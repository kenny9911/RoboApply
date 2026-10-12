// extension/src/content/boards/linkedin.ts — a job open on LinkedIn
// (/jobs/view/<id>, or a search / collection page with `currentJobId`).
//
// Reads the job details pane only (the signed-in member's name, feed and
// other listings are never read). Logged-out job pages also carry a
// schema.org JobPosting, used first when present.

import type { JobOnPage } from '../../adapters/types';
import { jobFromJsonLd, mergeJob, pick, pickBlock } from './read';
import { defineBoard } from './types';

const VIEW_RE = /^\/jobs\/view\/(?:[^/]*?-)?(\d{5,})\/?/;

function jobIdOf(url: URL): string | null {
  const view = url.pathname.match(VIEW_RE);
  if (view) return view[1];
  if (/^\/jobs\/(search|collections|search-results)\b/.test(url.pathname)) {
    const id = url.searchParams.get('currentJobId');
    if (id && /^\d{5,}$/.test(id)) return id;
  }
  return null;
}

function fromDom(doc: Document): JobOnPage | null {
  const title = pick(doc, [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    'h1.top-card-layout__title',
    '.topcard__title',
  ]);
  const company = pick(doc, [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    'a.topcard__org-name-link',
    '.topcard__flavor a',
  ]);
  const location = pick(doc, [
    '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
  ]);
  const descriptionText = pickBlock(doc, ['#job-details', '.jobs-description__content', '.jobs-description-content__text', '.show-more-less-html__markup', '.description__text']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

export const linkedinReader = defineBoard({
  id: 'linkedin',
  siteName: 'LinkedIn',
  domains: ['linkedin.com'],
  isJobPage: (url) => jobIdOf(url) !== null,
  readJob: (doc) => mergeJob(jobFromJsonLd(doc), fromDom(doc)),
  canonicalUrl(url) {
    const id = jobIdOf(url);
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : `${url.origin}${url.pathname}`;
  },
});

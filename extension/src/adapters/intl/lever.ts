// extension/src/adapters/intl/lever.ts — Lever application forms (jobs.lever.co/<company>/<id>/apply).

import { cleanLabel } from '../_kit/fields';
import { defineAdapter, descriptionText, firstText, metaContent } from '../_kit/page';
import type { FieldKey } from '../types';

const FORM = 'form.application-form, form#application-form, #application-form';

const BY_NAME: Record<string, FieldKey> = {
  name: 'fullName',
  email: 'email',
  phone: 'phone',
  org: 'currentCompany',
  location: 'location',
  resume: 'resume',
  'urls[LinkedIn]': 'linkedin',
  'urls[GitHub]': 'github',
  'urls[Github]': 'github',
  'urls[Portfolio]': 'portfolio',
  'urls[Twitter]': 'x',
  'urls[X]': 'x',
  'urls[Other]': 'website',
};

function hintFor(el: HTMLElement): FieldKey | undefined {
  const name = el.getAttribute('name') ?? '';
  if (BY_NAME[name]) return BY_NAME[name];
  if (el.getAttribute('type') === 'file' && /resume/i.test(`${el.id} ${name}`)) return 'resume';
  return undefined;
}

function labelFor(el: HTMLElement): string | null {
  const q = el.closest('.application-question') ?? el.closest('li');
  const label = q?.querySelector('.application-label, .text');
  const question = label ? label.textContent : null;
  if (question && el.getAttribute('type') === 'checkbox') {
    const own = cleanLabel(Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? '').join(' '));
    return own ? `${question.trim()} — ${own}` : question;
  }
  return question;
}

/** "Acme - Senior Engineer" (page title) → "Acme"; the logo alt is "Acme logo". */
function companyFrom(doc: Document): string | undefined {
  const alt = doc.querySelector('.main-header-logo img')?.getAttribute('alt')?.replace(/\s+logo$/i, '').trim();
  if (alt) return alt;
  const og = metaContent(doc, ['meta[property="og:title"]']) ?? doc.title;
  const m = og?.match(/^(.+?)\s+[-–—]\s+.+$/);
  return m ? m[1].trim() : undefined;
}

export const leverAdapter = defineAdapter({
  id: 'lever',
  siteName: 'Lever',
  hostPatterns: ['https://jobs.lever.co/*', 'https://jobs.eu.lever.co/*'],
  domains: ['jobs.lever.co', 'jobs.eu.lever.co'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['.posting-headline h2', '.posting-header h2', 'h2']);
    const company = companyFrom(doc);
    const location = firstText(doc, ['.posting-categories .location', '.posting-category.location', '.location']);
    const description = descriptionText(doc, ['.section-wrapper.page-full-width', '.posting-page .content', '[data-qa="job-description"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => el.closest('#h-captcha, .h-captcha, [id*="captcha"]') !== null,
  },
});

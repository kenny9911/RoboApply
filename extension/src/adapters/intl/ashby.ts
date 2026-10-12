// extension/src/adapters/intl/ashby.ts — Ashby application forms (jobs.ashbyhq.com/<company>/<id>/application).
//
// Ashby renders yes/no questions as a pair of <button>s. Buttons are never
// pressed (D1), so those questions are not listed; the panel tells the user
// to answer anything it did not fill.

import { defineAdapter, descriptionText, firstText, metaContent } from '../_kit/page';
import type { FieldKey } from '../types';

const FORM = 'form.ashby-application-form-container, .ashby-application-form-container, form[class*="ashby-application-form"]';

const BY_NAME: Record<string, FieldKey> = {
  _systemfield_name: 'fullName',
  _systemfield_email: 'email',
  _systemfield_phone: 'phone',
  _systemfield_resume: 'resume',
  _systemfield_location: 'location',
  _systemfield_linkedin: 'linkedin',
};

function hintFor(el: HTMLElement): FieldKey | undefined {
  const key = el.getAttribute('name') || el.id;
  return key ? BY_NAME[key] : undefined;
}

function labelFor(el: HTMLElement): string | null {
  const entry = el.closest('.ashby-application-form-field-entry, [class*="field-entry"]');
  const title = entry?.querySelector('.ashby-application-form-question-title, label');
  if (!title) return null;
  if (el.getAttribute('type') === 'checkbox' && (el as HTMLInputElement).labels?.length) return null;
  return title.textContent;
}

/** "Senior Engineer @ Acme" (document / og title). */
function companyFrom(doc: Document): string | undefined {
  const t = metaContent(doc, ['meta[property="og:title"]']) ?? doc.title ?? '';
  const m = t.match(/@\s*(.+)$/);
  if (m) return m[1].trim();
  return metaContent(doc, ['meta[property="og:site_name"]']);
}

export const ashbyAdapter = defineAdapter({
  id: 'ashby',
  siteName: 'Ashby',
  hostPatterns: ['https://jobs.ashbyhq.com/*'],
  domains: ['jobs.ashbyhq.com'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['h1.ashby-job-posting-heading', '[class*="job-posting-heading"]', 'h1']);
    const company = companyFrom(doc);
    const location = firstText(doc, ['[class*="job-posting-location"]', '.ashby-job-posting-left-pane [class*="location"]']);
    const description = descriptionText(doc, ['.ashby-job-posting-description', '[class*="job-posting-description"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
  },
});

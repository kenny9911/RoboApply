// extension/src/adapters/intl/greenhouse.ts — Greenhouse application forms.
//
// Covers the classic board (boards.greenhouse.io, incl. the /embed/job_app
// iframe employers put on their own career pages) and the newer board
// (job-boards.greenhouse.io, React, comboboxes for custom selects).

import { defineAdapter, descriptionText, firstText } from '../_kit/page';
import type { FieldKey } from '../types';

const FORM = 'form#application_form, form#application-form, form.application--form, #application_form, #application-form';

const HINTS: Array<[RegExp, FieldKey]> = [
  [/^(job_application\[)?first_name\]?$/, 'firstName'],
  [/^(job_application\[)?last_name\]?$/, 'lastName'],
  [/^(job_application\[)?preferred_name\]?$/, 'preferredName'],
  [/^(job_application\[)?email\]?$/, 'email'],
  [/^(job_application\[)?phone\]?$/, 'phone'],
  [/^(job_application\[)?location\]?$|^candidate-location$|^auto_complete_input$/, 'location'],
  [/^(job_application\[)?resume\]?$|^resume(_file)?$/, 'resume'],
  [/^(job_application\[)?cover_letter\]?$|^cover_letter(_file)?$/, 'coverLetter'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  for (const key of [el.id, el.getAttribute('name') ?? '']) {
    if (!key) continue;
    for (const [re, field] of HINTS) if (re.test(key)) return field;
  }
  return undefined;
}

function labelFor(el: HTMLElement): string | null {
  const field = el.closest('.field, .text-input-wrapper, .select__container, .file-upload, .checkbox, fieldset');
  if (!field) return null;
  if (el.getAttribute('type') === 'file') {
    const t = field.querySelector('label, [id^="upload-label"], .upload-label');
    return t ? t.textContent : null;
  }
  return null;
}

export const greenhouseAdapter = defineAdapter({
  id: 'greenhouse',
  siteName: 'Greenhouse',
  hostPatterns: ['https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*', 'https://job-boards.eu.greenhouse.io/*'],
  domains: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['h1.app-title', '.job__title h1', 'h1.section-header', '.job-title', 'h1']);
    const companyRaw = firstText(doc, ['.company-name', '.job__company', '[data-company-name]']);
    const company = companyRaw?.replace(/^at\s+/i, '').trim() || undefined;
    const location = firstText(doc, ['#header .location', '.job__location', '.location']);
    const description = descriptionText(doc, ['#content', '.job__description', '.job-post-content']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => el.getAttribute('name') === 'security_code' || el.closest('.grecaptcha-badge, [id*="captcha"]') !== null,
  },
});

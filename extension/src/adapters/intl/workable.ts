// extension/src/adapters/intl/workable.ts — Workable application forms
// (apply.workable.com/<employer>/j/<code>/apply).
//
// Workable names its controls with `name` / `data-ui` (firstname, lastname,
// email, phone, address, resume, cover_letter; custom questions `QA_<id>`).
// "Address" there is a city search box, so it takes the user's location.

import { defineAdapter, descriptionText, firstText, metaContent } from '../_kit/page';
import type { FieldKey } from '../types';
import { cleanCompany, hintFromAttributes, type HintRule } from './shared';

const FORM = 'form[data-ui="application-form"], [data-ui="application-form"] form, form[data-ui="apply-form"]';

const HINTS: readonly HintRule[] = [
  [/^first_?name$/i, 'firstName'],
  [/^last_?name$/i, 'lastName'],
  [/^email$/i, 'email'],
  [/^phone$/i, 'phone'],
  [/^address$/i, 'location'],
  [/^resume$/i, 'resume'],
  [/^cover_?letter$/i, 'coverLetter'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  return hintFromAttributes(el, HINTS, ['name', 'data-ui', 'id']);
}

function labelFor(el: HTMLElement): string | null {
  const type = el.getAttribute('type');
  if (type === 'file') {
    const box = el.parentElement?.closest('[data-ui*="resume" i], [data-ui*="cover" i], [data-role="dropzone"], fieldset, [data-ui="field"]');
    const label = box?.querySelector('label, legend, [data-ui="label"]');
    return label ? label.textContent : null;
  }
  if (type === 'radio') {
    const group = el.closest('fieldset, [role="radiogroup"]');
    const legend = group?.querySelector('legend, [data-ui="label"]');
    if (legend) return legend.textContent;
    const labelledBy = group?.getAttribute('aria-labelledby');
    if (labelledBy) return el.ownerDocument.getElementById(labelledBy)?.textContent ?? null;
  }
  return null;
}

/** og:title is "Role - Employer". */
function companyFrom(doc: Document): string | undefined {
  const named = firstText(doc, ['[data-ui="company-name"]', '[data-ui="account-name"]']);
  if (named) return cleanCompany(named);
  const og = metaContent(doc, ['meta[property="og:title"]']) ?? '';
  const m = og.match(/^.+\s+[-–—]\s+(.+)$/);
  return m ? cleanCompany(m[1]) : cleanCompany(metaContent(doc, ['meta[property="og:site_name"]']));
}

export const workableAdapter = defineAdapter({
  id: 'workable',
  siteName: 'Workable',
  hostPatterns: ['https://apply.workable.com/*'],
  domains: ['apply.workable.com'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['[data-ui="job-title"]', 'h1[data-ui="job-title"]', 'h1']);
    const company = companyFrom(doc);
    const location = firstText(doc, ['[data-ui="job-location"]', '[data-ui="job-location-tooltip"]']);
    const description = descriptionText(doc, ['[data-ui="job-description"]', '[data-ui="job-requirements"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => el.getAttribute('name') === 'avatar' || el.closest('[id*="captcha" i], [class*="captcha" i]') !== null,
  },
});

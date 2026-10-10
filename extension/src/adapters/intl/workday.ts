// extension/src/adapters/intl/workday.ts — Workday application forms
// (<tenant>.wd<N>.myworkdayjobs.com, myworkdaysite.com).
//
// Workday splits an application over several pages (My Information, My
// Experience, Application Questions, Voluntary Disclosures, Review). The user
// moves between them with Workday's own buttons; each page is filled on its
// own ("Fill this page"). We never press Next / Save and Continue / Submit.
//
// Workday names its controls with `data-automation-id` (older tenants:
// `legalNameSection_firstName`; newer: ids such as `name--legalName--firstName`).
// Its dropdowns are <button aria-haspopup="listbox">: buttons are never
// pressed (D1), so those questions are not listed and stay with the user.
// Multi-select prompts (`searchBox`) are left out too: typing into them
// selects nothing.

import { defineAdapter, descriptionText, firstText } from '../_kit/page';
import type { FieldKey } from '../types';
import { companyFromMeta, hintFromAttributes, type HintRule } from './shared';

const PAGE = [
  '[data-automation-id="applyFlowPage"]',
  '[data-automation-id="applyFlowContainer"]',
  '[data-automation-id="contactInformationPage"]',
  '[data-automation-id="myExperiencePage"]',
  '[data-automation-id="applicationQuestionsPage"]',
  '[data-automation-id="voluntaryDisclosuresPage"]',
  '[data-automation-id="selfIdentificationPage"]',
].join(', ');

const HINTS: readonly HintRule[] = [
  // Before the legal-name rules: "preferredNameSection_firstName" also ends in "_firstName".
  [/preferredName(Section)?[_-]+firstName$|^name--preferredName--firstName$/i, 'preferredName'],
  [/(^|[_-])(legalName(Section)?[_-]+)?firstName$|^name--legalName--firstName$/i, 'firstName'],
  [/^(?!.*preferred)(.*[_-])?(legalName(Section)?[_-]+)?lastName$|^name--legalName--lastName$/i, 'lastName'],
  [/^email$|--email$|^emailAddress$/i, 'email'],
  [/^phone-?number$|^phoneNumber--phoneNumber$|^phone$/i, 'phone'],
  [/addressSection_addressLine1$|^address--addressLine1$/i, 'addressLine1'],
  [/addressSection_city$|^address--city$/i, 'city'],
  [/addressSection_postalCode$|^address--postalCode$/i, 'postalCode'],
  [/^linkedinQuestion$|^linkedIn$/i, 'linkedin'],
  [/^file-upload-input-ref$/i, 'resume'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  const hint = hintFromAttributes(el, HINTS, ['data-automation-id', 'id', 'name']);
  // One upload control per section: only the one under "Resume/CV" is the resume.
  if (hint === 'resume') {
    const section = el.parentElement?.closest('[data-automation-id*="resume" i], [data-automation-id="attachments"], section, [role="group"]');
    const heading = section?.querySelector('h2, h3, h4, legend, [data-automation-id="sectionHeader"]')?.textContent ?? '';
    return /resume|cv\b|curriculum/i.test(heading) ? 'resume' : undefined;
  }
  return hint;
}

function labelFor(el: HTMLElement): string | null {
  if (el.getAttribute('type') === 'file') {
    const section = el.parentElement?.closest('[data-automation-id*="resume" i], [data-automation-id="attachments"], section, [role="group"]');
    const heading = section?.querySelector('h2, h3, h4, legend, [data-automation-id="sectionHeader"]');
    return heading ? heading.textContent : null;
  }
  const formField = el.closest('[data-automation-id^="formField"]');
  if (formField && el.getAttribute('type') !== 'radio' && el.getAttribute('type') !== 'checkbox') {
    const label = formField.querySelector('label');
    // Date parts share one label ("From") and name themselves ("Month", "Year").
    const part = el.getAttribute('aria-label');
    if (label && part && label.getAttribute('for') !== el.id) return `${label.textContent ?? ''} — ${part}`;
    if (label) return label.textContent;
  }
  if (el.getAttribute('type') === 'radio') {
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) return legend.textContent;
  }
  return null;
}

/** Where in the flow the user is ("My Information", …): a new page means a new fill. */
export function workdayStepKey(doc: Document): string | null {
  const active = doc.querySelector('[data-automation-id="progressBarActiveStep"]');
  const t = (active?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

export const workdayAdapter = defineAdapter({
  id: 'workday',
  siteName: 'Workday',
  hostPatterns: ['https://*.myworkdayjobs.com/*', 'https://*.myworkdaysite.com/*'],
  domains: ['myworkdayjobs.com', 'myworkdaysite.com'],
  probe: (doc) => Boolean(doc.querySelector(PAGE)),
  readJob(doc) {
    const title = firstText(doc, ['[data-automation-id="jobPostingHeader"]', '[data-automation-id="jobTitle"]']);
    const company = companyFromMeta(doc);
    const location = firstText(doc, ['[data-automation-id="locations"] dd', '[data-automation-id="locations"]']);
    const description = descriptionText(doc, ['[data-automation-id="jobPostingDescription"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(PAGE),
    hintFor,
    labelFor,
    skip: (el) =>
      el.getAttribute('data-automation-id') === 'searchBox' ||
      el.closest('[data-automation-id="multiselectInputContainer"], [data-automation-id="utilityMenu"], [data-automation-id="navigationPanel"]') !== null,
  },
});

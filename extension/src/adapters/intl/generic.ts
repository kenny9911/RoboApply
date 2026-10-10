// extension/src/adapters/intl/generic.ts — the label-heuristic adapter for
// form hosts people asked for ("Request this site") that have no adapter of
// their own.
//
// It works only on the hosts listed in GENERIC_SITES (each becomes a host
// permission and content-script match, path-scoped where the host also serves
// other pages), and only on a page whose form has a resume upload AND an email
// field. Labels are read by the _kit's generic rules (label, aria, placeholder)
// and classified by mapping/classify.ts; anything unclear stays with the user.
// Adding a host: append to GENERIC_SITES together with a saved form at
// extension/test/intl/fixtures/generic/<siteName, lower case>.html (a test
// fails without one); the adapter as a whole keeps ≥3 saved forms.

import { attachFileField, cleanLabel, fillField, genericLabel, listFieldsIn } from '../_kit/fields';
import { descriptionText, firstText, hostIs } from '../_kit/page';
import type { AtsAdapter, FieldKey } from '../types';
import { companyFromMeta, hintFromAttributes, inSignIn, type HintRule } from './shared';

export interface GenericSite {
  siteName: string;
  domains: string[];
  /** Match patterns (become host permissions and content-script matches). */
  hostPatterns: string[];
  /** Pages of the host that can hold an application form. */
  path?: RegExp;
}

/** Requested form hosts served by label heuristics. */
export const GENERIC_SITES: readonly GenericSite[] = [
  { siteName: 'Jobvite', domains: ['jobs.jobvite.com'], hostPatterns: ['https://jobs.jobvite.com/*'] },
  { siteName: 'BambooHR', domains: ['bamboohr.com'], hostPatterns: ['https://*.bamboohr.com/careers/*'], path: /^\/careers(\/|$)/ },
  { siteName: 'Recruitee', domains: ['recruitee.com'], hostPatterns: ['https://*.recruitee.com/o/*'], path: /^\/o\// },
];

const NAME_HINTS: readonly HintRule[] = [
  [/^(applicant[._-]?|candidate[._-]?)?(first[._-]?name|fname|given[._-]?name)$/i, 'firstName'],
  [/^(applicant[._-]?|candidate[._-]?)?(last[._-]?name|lname|surname|family[._-]?name)$/i, 'lastName'],
  [/^(applicant[._-]?|candidate[._-]?)?(full[._-]?name)$/i, 'fullName'],
  [/^(applicant[._-]?|candidate[._-]?)?e-?mail([._-]?address)?$/i, 'email'],
  [/^(applicant[._-]?|candidate[._-]?)?(phone|mobile|telephone)([._-]?number)?$/i, 'phone'],
  [/^linked[._-]?in([._-]?(url|profile))?$/i, 'linkedin'],
  [/^(resume|cv)([._-]?(file|upload|attachment))?$/i, 'resume'],
  [/^cover[._-]?letter([._-]?(file|upload|attachment))?$/i, 'coverLetter'],
];

const RESUME_WORDS = /resume|résumé|\bcv\b|curriculum/i;

function isResumeInput(el: HTMLInputElement): boolean {
  const text = `${el.name} ${el.id} ${el.getAttribute('aria-label') ?? ''} ${genericLabel(el)} ${el.closest('fieldset, .field, .form-group, [class*="upload" i]')?.textContent ?? ''}`;
  return RESUME_WORDS.test(text);
}

function isEmailInput(el: HTMLInputElement): boolean {
  if ((el.getAttribute('type') ?? '').toLowerCase() === 'email') return true;
  if ((el.getAttribute('autocomplete') ?? '').toLowerCase() === 'email') return true;
  return /^e-?mail/i.test(cleanLabel(genericLabel(el))) || /(^|[._-])e-?mail$/i.test(el.name || el.id);
}

/** The application form: the form around a resume upload that also asks for an email. */
export function applicationForm(root: Document | ShadowRoot): Element | null {
  for (const file of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]'))) {
    if (!isResumeInput(file)) continue;
    const form = file.closest('form, [role="form"]');
    if (!form) continue;
    const emails = Array.from(form.querySelectorAll<HTMLInputElement>('input')).filter(isEmailInput);
    if (emails.length) return form;
  }
  return null;
}

function hintFor(el: HTMLElement): FieldKey | undefined {
  const hint = hintFromAttributes(el, NAME_HINTS, ['name', 'id']);
  if (hint === 'resume' || hint === 'coverLetter') return el.getAttribute('type') === 'file' ? hint : undefined;
  return hint;
}

function labelFor(el: HTMLElement): string | null {
  if (el.getAttribute('type') !== 'file') return null;
  const box = el.parentElement?.closest('fieldset, .field, .form-group, [class*="upload" i]');
  const label = box?.querySelector('label, legend');
  return label ? label.textContent : null;
}

function readJob(doc: Document) {
  const title = firstText(doc, ['[itemprop="title"]', '.job-title', '.jobTitle', '[class*="job-title" i]', '.jv-header', 'h1']);
  const company = companyFromMeta(doc);
  const location = firstText(doc, ['[itemprop="jobLocation"]', '.job-location', '.jobLocation', '[class*="job-location" i]', '.jv-job-detail-meta']);
  const description = descriptionText(doc, ['[itemprop="description"]', '.job-description', '.jobDescription', '[class*="job-description" i]']);
  if (!title && !company) return null;
  return { title, company, location, descriptionText: description };
}

export function genericAdapterFor(site: GenericSite): AtsAdapter {
  const probe = (doc: Document) => applicationForm(doc) !== null;
  return {
    id: 'generic',
    siteName: site.siteName,
    hostPatterns: site.hostPatterns,
    matches: (url, doc) => hostIs(url, site.domains) && (!site.path || site.path.test(url.pathname)) && probe(doc),
    probe,
    readJob,
    listFields: (root) =>
      listFieldsIn(root, {
        scope: applicationForm,
        hintFor,
        labelFor,
        skip: (el) => inSignIn(el) || el.closest('[id*="captcha" i], [class*="captcha" i], [aria-hidden="true"]') !== null || /honeypot/i.test(el.getAttribute('name') ?? ''),
      }),
    fill: (field, value) => fillField(field, value),
    attachFile: (field, file) => attachFileField(field, file),
  };
}

export const GENERIC_ADAPTERS: readonly AtsAdapter[] = GENERIC_SITES.map(genericAdapterFor);

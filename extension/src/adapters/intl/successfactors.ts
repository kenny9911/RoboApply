// extension/src/adapters/intl/successfactors.ts — SAP SuccessFactors
// application forms (career<N>.successfactors.com / .eu, `career_ns=job_application`).
//
// The candidate profile fields carry ids such as `fbclc_fName`,
// `fbclc_lName`, `fbclc_email`, `fbclc_cellPhone`, `fbclc_city`,
// `fbclc_zip`, `fbclc_country`. Longer applications span several pages; the
// user moves on with the site's own buttons and each page is filled on its own.
// Employer sites on their own domains are not covered (no host permission).
// Only the career pages (`/career…`) get the content script.

import { defineAdapter, descriptionText, firstText } from '../_kit/page';
import type { FieldKey } from '../types';
import { companyFromMeta, hintFromAttributes, inSignIn, type HintRule } from './shared';

const FORM = ['form#careerApplyForm', 'form[name="careerApplyForm"]', 'form#applyForm', '.applicationForm form', 'form[action*="job_application"]'].join(', ');

const HINTS: readonly HintRule[] = [
  [/^fbclc_(fName|firstName)$/i, 'firstName'],
  [/^fbclc_(lName|lastName)$/i, 'lastName'],
  [/^fbclc_(nickName|preferredName)$/i, 'preferredName'],
  [/^fbclc_(email|contactEmail)$/i, 'email'],
  [/^fbclc_(cellPhone|homePhone|phone|contactPhone)$/i, 'phone'],
  [/^fbclc_(address|addressLine1|address1)$/i, 'addressLine1'],
  [/^fbclc_city$/i, 'city'],
  [/^fbclc_(state|province)$/i, 'region'],
  [/^fbclc_(zip|zipCode|postalCode)$/i, 'postalCode'],
  [/^fbclc_country$/i, 'country'],
  [/^fbclc_(linkedIn|linkedinUrl)$/i, 'linkedin'],
  [/^fbclc_resume(Upload)?$|^resumeUpload$|^attachResume$/i, 'resume'],
  [/^fbclc_coverLetter(Upload)?$|^coverLetterUpload$/i, 'coverLetter'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  return hintFromAttributes(el, HINTS, ['id', 'name']);
}

function labelFor(el: HTMLElement): string | null {
  if (el.getAttribute('type') === 'file') {
    const box = el.parentElement?.closest('.attachmentField, .fileUploadField, fieldset, .field');
    const label = box?.querySelector('label, legend');
    return label ? label.textContent : null;
  }
  return null;
}

/** The current page of a multi-page application (wizard header). */
export function successFactorsStepKey(doc: Document): string | null {
  const current = doc.querySelector('.applicationSteps .currentStep, .wizardSteps [aria-current="step"], .stepIndicator .active');
  const t = (current?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

export const successFactorsAdapter = defineAdapter({
  id: 'successfactors',
  siteName: 'SuccessFactors',
  // Path-scoped: the same hosts serve the employee HR suite, where nothing of ours runs.
  hostPatterns: ['https://*.successfactors.com/career*', 'https://*.successfactors.eu/career*'],
  domains: ['successfactors.com', 'successfactors.eu'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['.jobTitle', '[data-careersite-propertyid="title"]', '#job-title', 'h1']);
    const company = companyFromMeta(doc);
    const location = firstText(doc, ['[data-careersite-propertyid="city"]', '.jobLocation', '.jobGeoLocation']);
    const description = descriptionText(doc, ['.jobdescription', '[data-careersite-propertyid="description"]', '.joqReqDescription']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => inSignIn(el) || /^fbclc_(password|confirmPassword|username)$/i.test(el.id),
  },
});

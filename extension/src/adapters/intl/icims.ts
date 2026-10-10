// extension/src/adapters/intl/icims.ts — iCIMS application forms
// (careers-<employer>.icims.com and other *.icims.com portals).
//
// iCIMS shows its forms inside an iframe on the same host
// (`icims_content_iframe`, `?in_iframe=1`); the content script runs in every
// frame, so the form is found in that frame. Profile fields carry names such
// as `PersonProfileFields.FirstName`. The sign-in step (email, password) is
// the user's: passwords are never listed and the sign-in box is skipped.

import { defineAdapter, descriptionText, firstText } from '../_kit/page';
import type { FieldKey } from '../types';
import { companyFromMeta, hintFromAttributes, inSignIn, type HintRule } from './shared';

const FORM = [
  'form#iCIMS_ApplyForm',
  'form[name="iCIMS_ApplyForm"]',
  'form.iCIMS_Forms',
  '.iCIMS_MainWrapper form',
  '#iCIMS_MainWrapper form',
].join(', ');

const HINTS: readonly HintRule[] = [
  [/(^|[._])FirstName$/i, 'firstName'],
  [/(^|[._])LastName$/i, 'lastName'],
  [/(^|[._])(Preferred|Nick)Name$/i, 'preferredName'],
  [/(^|[._])E-?mail(Address)?$/i, 'email'],
  [/(^|[._])(Phone|PhoneNumber|MobilePhone|HomePhone)$/i, 'phone'],
  [/(^|[._])AddressStreet1$|(^|[._])Address1$/i, 'addressLine1'],
  [/(^|[._])AddressCity$/i, 'city'],
  [/(^|[._])AddressState$/i, 'region'],
  [/(^|[._])Address(Zip|PostalCode)$/i, 'postalCode'],
  [/(^|[._])AddressCountry$/i, 'country'],
  [/(^|[._])LinkedIn(URL|Profile)?$/i, 'linkedin'],
  [/^resume(_?file)?$|(^|[._])Resume(Upload|File)$/i, 'resume'],
  [/^cover_?letter(_?file)?$|(^|[._])CoverLetter(Upload|File)$/i, 'coverLetter'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  return hintFromAttributes(el, HINTS, ['name', 'id']);
}

function labelFor(el: HTMLElement): string | null {
  const row = el.closest('.iCIMS_FieldRow, .iCIMS_TableRow, .row, tr');
  if (!row) return null;
  const type = el.getAttribute('type');
  // A radio's own label is its option ("Yes"); the question is the row's label.
  if (type === 'radio') {
    const q = row.querySelector('.iCIMS_TableLabel, .iCIMS_InfoField, legend');
    return q ? q.textContent : null;
  }
  if (type === 'file' || !(el as HTMLInputElement).labels?.length) {
    const label = row.querySelector('.iCIMS_TableLabel, .iCIMS_InfoField, label');
    return label ? label.textContent : null;
  }
  return null;
}

export const icimsAdapter = defineAdapter({
  id: 'icims',
  siteName: 'iCIMS',
  hostPatterns: ['https://*.icims.com/*'],
  domains: ['icims.com'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['.iCIMS_Header h1', 'h1.iCIMS_Header', '.iCIMS_JobHeaderTitle', '.iCIMS_JobTitle', 'h1']);
    const company = companyFromMeta(doc);
    const location = firstText(doc, ['.iCIMS_JobHeaderData .iCIMS_JobHeaderField + dd', '.iCIMS_JobLocation', '[data-field="location"]']);
    const description = descriptionText(doc, ['.iCIMS_JobContent', '.iCIMS_InfoMsg_Job']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => inSignIn(el) || el.closest('[id*="captcha" i], .g-recaptcha') !== null || /^(captcha|honeypot)/i.test(el.getAttribute('name') ?? ''),
  },
});

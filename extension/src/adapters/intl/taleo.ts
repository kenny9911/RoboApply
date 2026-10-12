// extension/src/adapters/intl/taleo.ts — Oracle Taleo application forms
// (<employer>.taleo.net/careersection/<section>/jobapply.ftl).
//
// Taleo splits an application over several pages with a flow trail at the
// top; the user moves on with Taleo's own "Save and Continue" (never pressed
// here), and each page is filled on its own. Field ids end in the profile
// field's name (`…-cs_candidate_personal_info_FirstName`). The sign-in page is
// the user's: its fields are skipped.

import { defineAdapter, descriptionText, firstText } from '../_kit/page';
import type { FieldKey } from '../types';
import { companyFromMeta, hintFromAttributes, inSignIn, type HintRule } from './shared';

const FORM = [
  'form#editTemplateMultipart',
  'form[id^="et-ef-content-ftf"]',
  'form[name="ftlform"]',
  '#editTemplateMultipart-editForm',
].join(', ');

const HINTS: readonly HintRule[] = [
  [/(^|[-_])(personal_info_)?FirstName$/i, 'firstName'],
  [/(^|[-_])(personal_info_)?LastName$/i, 'lastName'],
  [/(^|[-_])(personal_info_)?(EmailAddress|Email)$/i, 'email'],
  [/(^|[-_])(personal_info_)?(MobilePhone|HomePhone|CellularPhone|WorkPhone)$/i, 'phone'],
  [/(^|[-_])(personal_info_)?Address$/i, 'addressLine1'],
  [/(^|[-_])(personal_info_)?City$/i, 'city'],
  [/(^|[-_])(personal_info_)?(ZipCode|PostalCode)$/i, 'postalCode'],
  [/(^|[-_])ResidenceLocation-0$|(^|[-_])Country$/i, 'country'],
  [/(^|[-_])ResidenceLocation-1$|(^|[-_])(State|Province)$/i, 'region'],
  [/AttachedFilesBlock-resume(FileInput|Upload)$|attachedFilesResume$/i, 'resume'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  return hintFromAttributes(el, HINTS, ['id', 'name']);
}

function labelFor(el: HTMLElement): string | null {
  if (el.getAttribute('type') === 'file') {
    const block = el.parentElement?.closest('[id*="AttachedFilesBlock"], .attachments, fieldset');
    const label = block?.querySelector('label, legend, h2, h3');
    return label ? label.textContent : null;
  }
  return null;
}

/** "Personal Information", … — a new page of the flow means a new fill. */
export function taleoStepKey(doc: Document): string | null {
  const current = doc.querySelector('#et-ef-content-ftf-flowTrail .ftlcurrent, .flowTrail .current, [id*="flowTrail"] [aria-current="step"]');
  const t = (current?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

export const taleoAdapter = defineAdapter({
  id: 'taleo',
  siteName: 'Taleo',
  // Path-scoped to the candidate career sections.
  hostPatterns: ['https://*.taleo.net/careersection/*'],
  domains: ['taleo.net'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['[id*="reqTitleLinkAction"]', '[id*="requisitionTitle"]', '.titlepage', '#requisitionDescriptionInterface h1']);
    const company = companyFromMeta(doc);
    const location = firstText(doc, ['[id*="reqBasicLocation"]', '[id*="requisitionLocation"]']);
    const description = descriptionText(doc, ['[id*="requisitionDescriptionInterface"][id*="descRequisition"]', '.mastercontentpanel3']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {
    scope: (root) => root.querySelector(FORM),
    hintFor,
    labelFor,
    skip: (el) => inSignIn(el) || /(^|[-_])(dialogTemplate|login|userName)/i.test(el.id),
  },
});

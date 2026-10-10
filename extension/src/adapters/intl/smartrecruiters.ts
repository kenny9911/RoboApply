// extension/src/adapters/intl/smartrecruiters.ts — SmartRecruiters application
// forms (jobs.smartrecruiters.com, incl. the one-click `oneclick-ui` flow).
//
// The current form renders its inputs inside web components with open shadow
// roots, so fields are listed across those roots (listFieldsDeep). The
// "Confirm your email" field takes the same email. The location picker is an
// autocomplete; it gets text only (the user picks the suggestion).

import { cleanLabel } from '../_kit/fields';
import { defineAdapter, descriptionText, firstText, metaContent } from '../_kit/page';
import type { AtsAdapter, FieldKey } from '../types';
import { cleanCompany, hintFromAttributes, labelInOwnTree, listFieldsDeep, type HintRule } from './shared';

const FORM = [
  'oc-oneclick-form',
  'form[name="applicationForm"]',
  'form#st-apply-form',
  '[data-test="application-form"]',
  '.application-form',
].join(', ');

const HINTS: readonly HintRule[] = [
  [/^first-?name(-input)?$/i, 'firstName'],
  [/^last-?name(-input)?$/i, 'lastName'],
  [/^(confirm-?)?e-?mail(-input)?$/i, 'email'],
  [/^phone(-?number)?(-input)?$/i, 'phone'],
  [/^(city|location)(-input)?$/i, 'location'],
  [/^linked-?in(-?profile)?(-?url)?(-input)?$/i, 'linkedin'],
  [/^(website|web-?site-?url)(-input)?$/i, 'website'],
  [/^resume(-upload)?(-input)?$/i, 'resume'],
];

function hintFor(el: HTMLElement): FieldKey | undefined {
  const own = hintFromAttributes(el, HINTS, ['id', 'name', 'data-test']);
  if (own) return own;
  // In a component, the host carries the name (<spl-input name="firstName">).
  const host = (el.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
  return host ? hintFromAttributes(host, HINTS, ['id', 'name', 'data-test']) : undefined;
}

function labelFor(el: HTMLElement): string | null {
  // A radio's own label is its option ("Yes"); the question is the group's legend.
  if (el.getAttribute('type') === 'radio') return el.closest('fieldset')?.querySelector('legend')?.textContent ?? null;
  const own = labelInOwnTree(el);
  if (cleanLabel(own)) return own;
  const host = (el.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
  const hostLabel = host?.getAttribute('label') ?? host?.getAttribute('aria-label');
  if (hostLabel && cleanLabel(hostLabel)) return hostLabel;
  if (el.getAttribute('type') === 'file') {
    const box = el.parentElement?.closest('[data-test*="resume" i], .resume-upload, section, fieldset');
    const heading = box?.querySelector('h2, h3, h4, legend, label');
    if (heading) return heading.textContent;
  }
  return null;
}

/** "Software Engineer at Acme" / "Acme - Software Engineer" in the page metadata. */
function companyFrom(doc: Document): string | undefined {
  const named = firstText(doc, ['[itemprop="hiringOrganization"] [itemprop="name"]', '[data-test="company-name"]', '.company-name']);
  if (named) return cleanCompany(named);
  const t = metaContent(doc, ['meta[property="og:title"]']) ?? doc.title ?? '';
  const at = t.match(/\s+at\s+(.+?)(\s+[-|].*)?$/i);
  return at ? cleanCompany(at[1]) : undefined;
}

const base = defineAdapter({
  id: 'smartrecruiters',
  siteName: 'SmartRecruiters',
  hostPatterns: ['https://jobs.smartrecruiters.com/*'],
  domains: ['jobs.smartrecruiters.com'],
  probe: (doc) => Boolean(doc.querySelector(FORM)),
  readJob(doc) {
    const title = firstText(doc, ['[data-test="job-title"]', 'h1.job-title', '[itemprop="title"]', 'h1']);
    const company = companyFrom(doc);
    const location = firstText(doc, ['[data-test="job-location"]', '[itemprop="jobLocation"]', '.job-location']);
    const description = descriptionText(doc, ['[data-test="job-description"]', '[itemprop="description"]', '.job-sections']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  fields: {},
});

export const smartRecruitersAdapter: AtsAdapter = {
  ...base,
  listFields: (root) =>
    listFieldsDeep(root, {
      scope: (r) => r.querySelector(FORM),
      hintFor,
      labelFor,
      skip: (el) => el.closest('[id*="captcha" i], [class*="captcha" i]') !== null,
    }),
};

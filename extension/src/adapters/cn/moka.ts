// extension/src/adapters/cn/moka.ts — Moka 网申 forms (*.mokahr.com).
//
// Campus and experienced-hire application pages are a React single-page app
// on Ant Design: `.ant-form-item` blocks with a `.ant-form-item-label`, custom
// selects (role="combobox"), read-only date pickers (left for the user: they
// open only with a click on the picker), titled sections and an upload input
// for the resume. Hash routes (#/job/…/apply) keep one path, so the panel
// offers "fill again" for each step of a multi-step form.

import { descriptionText, firstText } from '../_kit/page';
import { cnCompany, cnLabelFor, defineCnAdapter, looksLikeCnForm } from './kit';

const DOMAINS = ['mokahr.com'];
const FORM = 'form.ant-form, .ant-form, [class*="apply-form"], [class*="applyForm"]';

export const mokaAdapter = defineCnAdapter({
  id: 'moka',
  siteName: 'Moka',
  hostPatterns: ['https://*.mokahr.com/*'],
  domains: DOMAINS,
  probe: (doc) => Boolean(doc.querySelector('.ant-form-item')) && looksLikeCnForm(doc),
  readJob(doc) {
    const title = firstText(doc, ['[class*="job-title"]', '[class*="jobTitle"]', '.job-name', 'h1']);
    const company = cnCompany(doc, ['[class*="org-name"]', '[class*="orgName"]', '[class*="company-name"]']);
    const location = firstText(doc, ['[class*="job-location"]', '[class*="jobLocation"]']);
    const description = descriptionText(doc, ['[class*="job-description"]', '[class*="jobDescription"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  headings: '[class*="section-title"], [class*="sectionTitle"], [class*="group-title"]',
  submitSelectors: ['[class*="submit"] button', 'button[type="submit"]', 'button.ant-btn-primary'],
  form: FORM,
  fields: {
    labelFor: (el) => cnLabelFor(el, { containers: '.ant-form-item', labels: '.ant-form-item-label label, .ant-form-item-label' }),
    // The custom select's own input sits in `.ant-select-selection-search`: not a search box.
    skip: (el) => Boolean(el.closest('.ant-select-dropdown, [class*="captcha"], [role="search"], [class*="search-bar"], [class*="searchBar"]')),
  },
});

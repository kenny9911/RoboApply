// extension/src/adapters/cn/beisen.ts — Beisen 网申 forms (*.zhiye.com career sites).
//
// Vue pages on Element UI: `.el-form-item` with `.el-form-item__label`,
// `.el-input__inner` inputs, `.el-select` (role="combobox" input + a
// `.el-select-dropdown` list), `.el-date-editor` pickers (read-only: left for
// the user), sections under `.module-title` headings, and repeated row cards
// for education, internships and family members.

import { descriptionText, firstText } from '../_kit/page';
import { cnCompany, cnLabelFor, defineCnAdapter, looksLikeCnForm } from './kit';

const DOMAINS = ['zhiye.com', 'beisen.com'];
const FORM = 'form.el-form, .el-form, [class*="resume-form"], [class*="apply-form"]';

export const beisenAdapter = defineCnAdapter({
  id: 'beisen',
  siteName: 'Beisen',
  hostPatterns: ['https://*.zhiye.com/*', 'https://*.beisen.com/*'],
  domains: DOMAINS,
  probe: (doc) => Boolean(doc.querySelector('.el-form-item')) && looksLikeCnForm(doc),
  readJob(doc) {
    const title = firstText(doc, ['[class*="position-name"]', '[class*="job-name"]', '[class*="jobName"]', 'h1']);
    const company = cnCompany(doc, ['[class*="company-name"]', '[class*="corp-name"]', '[class*="tenant-name"]']);
    const location = firstText(doc, ['[class*="position-city"]', '[class*="work-place"]']);
    const description = descriptionText(doc, ['[class*="position-desc"]', '[class*="job-desc"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  headings: '[class*="module-title"], [class*="moduleTitle"], .el-card__header',
  submitSelectors: ['[class*="submit"] button', 'button[type="submit"]', 'button.el-button--primary'],
  form: FORM,
  fields: {
    labelFor: (el) => cnLabelFor(el, { containers: '.el-form-item', labels: '.el-form-item__label' }),
    skip: (el) => Boolean(el.closest('.el-select-dropdown, .el-picker-panel, [class*="captcha"]')),
  },
});


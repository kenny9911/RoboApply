// extension/src/adapters/cn/feishu.ts — Feishu recruiting forms (*.jobs.feishu.cn).
//
// Career sites on Feishu's recruiting product: ByteDance UD components
// (`.ud__form__item`, `.ud__form__item__label`, `.ud__input`, `.ud__select`
// with role="combobox"), module titles per section, and the resume upload
// at the top of the form.

import { descriptionText, firstText } from '../_kit/page';
import { cnCompany, cnLabelFor, defineCnAdapter, looksLikeCnForm } from './kit';

const FORM = 'form.ud__form, .ud__form, [class*="apply-form"], [class*="applyForm"]';

export const feishuAdapter = defineCnAdapter({
  id: 'feishu',
  siteName: 'Feishu',
  hostPatterns: ['https://*.jobs.feishu.cn/*'],
  domains: ['jobs.feishu.cn'],
  probe: (doc) => Boolean(doc.querySelector('.ud__form__item, [class*="form-item"]')) && looksLikeCnForm(doc),
  readJob(doc) {
    const title = firstText(doc, ['[class*="job-title"]', '[class*="position-title"]', '[class*="jobTitle"]', 'h1']);
    const company = cnCompany(doc, ['[class*="company-name"]', '[class*="tenant-name"]', '[class*="site-name"]']);
    const location = firstText(doc, ['[class*="job-city"]', '[class*="position-city"]']);
    const description = descriptionText(doc, ['[class*="job-description"]', '[class*="position-desc"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  headings: '[class*="module-title"], [class*="moduleTitle"], [class*="block-title"]',
  submitSelectors: ['[class*="submit"] button', 'button[type="submit"]', 'button.ud__button--filled'],
  form: FORM,
  fields: {
    labelFor: (el) => cnLabelFor(el, { containers: '.ud__form__item, [class*="form-item"]', labels: '.ud__form__item__label, [class*="item-label"], label' }),
    skip: (el) => Boolean(el.closest('.ud__select__dropdown, [class*="dropdown"], [class*="captcha"]')),
  },
});

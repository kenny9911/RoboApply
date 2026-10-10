// extension/src/adapters/cn/dayee.ts — Dayee 网申 forms (*.dayee.com, *.hotjob.cn).
//
// Older server-rendered portals: label / value tables (`<th>姓名</th><td><input>`),
// a column-header table for family members and education rows, plain
// <select>s, section headings above each table, and a "保存" / "提交" pair of
// buttons at the end. Nothing here presses either.

import { descriptionText, firstText } from '../_kit/page';
import { cnCompany, cnLabelFor, defineCnAdapter, looksLikeCnForm } from './kit';

const FORM = 'form#applyForm, form[name="applyForm"], form[action*="apply"], form[action*="resume"], form';

export const dayeeAdapter = defineCnAdapter({
  id: 'dayee',
  siteName: 'Dayee',
  hostPatterns: ['https://*.dayee.com/*', 'https://*.hotjob.cn/*'],
  domains: ['dayee.com', 'hotjob.cn'],
  probe: (doc) => Boolean(doc.querySelector('table th, table td')) && looksLikeCnForm(doc),
  readJob(doc) {
    const title = firstText(doc, ['.post-name', '.postName', '[class*="post-title"]', '[class*="job-name"]', 'h1']);
    const company = cnCompany(doc, ['.corp-name', '.corpName', '[class*="company-name"]']);
    const location = firstText(doc, ['.post-city', '[class*="work-place"]']);
    const description = descriptionText(doc, ['.post-desc', '[class*="post-duty"]', '[class*="job-desc"]']);
    if (!title && !company) return null;
    return { title, company, location, descriptionText: description };
  },
  headings: '.module-title, .title-bar, .tab-title, caption',
  submitSelectors: ['#btnSubmit', 'input[type="submit"]', '[class*="submit"]'],
  form: FORM,
  fields: {
    labelFor: (el) => cnLabelFor(el, { containers: '.form-item, [class*="form-item"]', labels: 'label, [class*="label"]' }),
    skip: (el) => Boolean(el.closest('[class*="captcha"], [class*="verify"]')) || /captcha|verify|checkcode/i.test(el.getAttribute('name') ?? ''),
  },
});

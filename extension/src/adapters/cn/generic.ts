// extension/src/adapters/cn/generic.ts — label-heuristic fallback for mainland
// 网申 forms on other career portals (big-tech career sites, self-built forms).
//
// No host permission and no registered content script of its own: it runs only
// where the content script already is (a supported portal whose page did not
// match its specific adapter) or where the user's toolbar click injected it
// under `activeTab`. It recognizes a form by the labels every 网申 form has
// (姓名, 手机, 邮箱, 学校, 学历 …), reads labels from <label>, form-item
// containers or table cells, and fills like the specific adapters.

import { attachFileField, fillField, listFieldsIn } from '../_kit/fields';
import { descriptionText, firstText, hostIs } from '../_kit/page';
import type { AtsAdapter } from '../types';
import { cnCompany, cnFormFieldOptions, cnFormRegions, cnLabelFor, DEFAULT_HEADINGS, looksLikeCnForm, sectionTitleOf, type CnAdapter } from './kit';

function isLocalHost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.localhost');
}

const FORM = 'form';
const labelFor = (el: HTMLElement) => cnLabelFor(el);
const FIELDS = {
  labelFor,
  skip: (el: HTMLElement) => Boolean(el.closest('[class*="captcha"], [role="search"], [class*="search-bar"], [class*="searchBar"], header, nav')),
};

/** Job boards are never treated as application forms (chat-style boards have none to fill). */
export const GENERIC_EXCLUDED_DOMAINS = ['zhipin.com', 'liepin.com', '51job.com', 'zhaopin.com', 'lagou.com', 'linkedin.com', 'linkedin.cn', 'indeed.com', 'maimai.cn', 'shixiseng.com', 'nowcoder.com'];

/** Stricter than the specific adapters: four labels a 网申 form always has. */
const MIN_LABELS = 4;

function hostName(): string {
  try {
    return typeof location !== 'undefined' && location.hostname ? location.hostname : '';
  } catch {
    return '';
  }
}

const base: AtsAdapter = {
  id: 'generic',
  siteName: '',
  hostPatterns: [],
  // Local pages (dev fixtures) are detected by markup in content/detect.ts, specific adapters first.
  matches: (url, doc) =>
    (url.protocol === 'https:' || url.protocol === 'http:') && !isLocalHost(url) && !hostIs(url, GENERIC_EXCLUDED_DOMAINS) && looksLikeCnForm(doc, MIN_LABELS),
  probe: (doc) => looksLikeCnForm(doc, MIN_LABELS),
  readJob(doc) {
    const title = firstText(doc, ['[class*="job-title"]', '[class*="jobTitle"]', '[class*="position-name"]', '[class*="post-name"]', 'h1']);
    const company = cnCompany(doc, ['[class*="company-name"]', '[class*="companyName"]', '[class*="org-name"]']);
    const description = descriptionText(doc, ['[class*="job-desc"]', '[class*="description"]']);
    if (!title && !company) return null;
    return { title, company, descriptionText: description };
  },
  // Every <form> holding 网申 fields (a header search form or a newsletter box is not one); the body when there is none.
  listFields: (root) => listFieldsIn(root, cnFormFieldOptions(FORM, FIELDS)),
  fill: (field, value) => fillField(field, value),
  attachFile: (field, file) => attachFileField(field, file),
};

export const genericCnAdapter: CnAdapter = Object.defineProperty(
  {
    ...base,
    cn: {
      sectionTitle: (el: HTMLElement) => sectionTitleOf(el, DEFAULT_HEADINGS),
      submitSelectors: ['button[type="submit"]', 'input[type="submit"]'],
      formRegions: (root: Document | ShadowRoot) => cnFormRegions(root, FORM, labelFor).regions,
    },
  },
  // "Form on {site}": the page's own host name (a real name, never invented).
  'siteName',
  { get: hostName, enumerable: true },
) as CnAdapter;

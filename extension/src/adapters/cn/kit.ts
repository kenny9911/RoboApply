// extension/src/adapters/cn/kit.ts — shared pieces of GoApply's portal adapters (一键填表).
//
// Mainland 网申 portals share a shape: a long form split into titled sections
// (基本信息 / 教育经历 / 实习经历 / 家庭成员 …), repeated row blocks inside a
// section, labels in a form-item container (Ant Design, Element UI, ByteDance
// UD) or in the table cell beside the input (older jQuery portals), and the
// portal's own 提交 button at the bottom. This file reads that shape; it never
// presses anything (filling goes through the _kit setters and interact.ts).

import { cleanLabel, genericLabel, type ListFieldsOptions } from '../_kit/fields';
import { defineAdapter, firstText, hostIs, metaContent, type AdapterSpec } from '../_kit/page';
import type { AtsAdapter, AtsType, JobOnPage } from '../types';

/** What the cn layer (fields.ts, the panel) needs beyond the base adapter contract. */
export interface CnAdapterExtras {
  /** Title of the form section an element sits in ("教育经历"), or null. */
  sectionTitle(el: HTMLElement): string | null;
  /**
   * Selectors for the portal's own submit control, tried in order. The panel
   * only OUTLINES it after a fill ("请核对后自行提交"); nothing presses it.
   */
  submitSelectors: string[];
  /**
   * The application form on the page: every matching form that holds 网申
   * fields (one per section card on some portals), never a header / nav
   * search form. Empty when the page has no matching form (the whole body is
   * then read). listFields() and the submit hint use the same regions.
   */
  formRegions(root: Document | ShadowRoot): Element[];
}

export type CnAdapter = AtsAdapter & { cn: CnAdapterExtras };

export function isCnAdapter(a: AtsAdapter | null | undefined): a is CnAdapter {
  return Boolean(a && typeof (a as Partial<CnAdapter>).cn === 'object' && (a as CnAdapter).cn !== null);
}

/** Section headings shared by the portals (each adapter adds its own). */
export const DEFAULT_HEADINGS = 'h2, h3, h4, legend, [class*="section-title"], [class*="sectionTitle"], [class*="module-title"], [class*="moduleTitle"], [class*="block-title"]';

/** Form-item containers used by the portals' UI kits. */
export const DEFAULT_CONTAINERS =
  '.ant-form-item, .el-form-item, .ud__form__item, .form-item, .form-group, [class*="form-item"], [class*="formItem"]';

/** The label element inside a form-item container. */
export const DEFAULT_LABELS =
  '.ant-form-item-label label, .ant-form-item-label, .el-form-item__label, .ud__form__item__label, label, [class*="item-label"], [class*="itemLabel"], [class*="form-label"]';

const REQUIRED_CLASS_RE = /(^|[\s_-])(required|is-required|ant-form-item-required)([\s_-]|$)/i;

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** A label without trailing colons ("姓名：" → "姓名"). Keeps a required star for isRequired(). */
export function tidyLabel(raw: string): string {
  return raw.replace(/[：:]\s*(\*?)\s*$/, ' $1').replace(/\s+/g, ' ').trim();
}

function requiredMark(label: Element | null, box: Element | null): boolean {
  const classes = `${label?.getAttribute('class') ?? ''} ${box?.getAttribute('class') ?? ''}`;
  return REQUIRED_CLASS_RE.test(classes) || Boolean(label?.querySelector('.required, [class*="required"]'));
}

/** Header text of the table column a cell sits in (family / education tables). */
export function columnHeader(td: HTMLTableCellElement): string | null {
  const table = td.closest('table');
  const row = td.parentElement as HTMLTableRowElement | null;
  if (!table || !row) return null;
  const index = Array.from(row.cells).indexOf(td);
  const head = table.tHead?.rows[0] ?? (table.rows[0] !== row && table.rows[0]?.querySelector('th') ? table.rows[0] : null);
  const cell = head?.cells[index];
  return cell ? text(cell) || null : null;
}

/** Text of the label cell beside the input in a label/value table row. */
function rowLabel(td: HTMLTableCellElement): { text: string; cell: Element } | null {
  let prev = td.previousElementSibling;
  while (prev) {
    const hasControl = prev.querySelector('input, select, textarea, [role="combobox"]');
    if (!hasControl && text(prev)) return { text: text(prev), cell: prev };
    if (hasControl) return null;
    prev = prev.previousElementSibling;
  }
  return null;
}

export interface CnLabelOptions {
  containers?: string;
  labels?: string;
}

/**
 * The visible label of a control on a mainland portal: the label inside its
 * form-item container, else the label cell beside it in a table row, else the
 * column header of a table, else the generic lookup (<label for>, aria, placeholder).
 * A required item gets a trailing "*" so isRequired() sees it.
 */
export function cnLabelFor(el: HTMLElement, opts: CnLabelOptions = {}): string | null {
  const box = el.closest(opts.containers ?? DEFAULT_CONTAINERS);
  if (box) {
    const label = box.querySelector(opts.labels ?? DEFAULT_LABELS);
    const t = tidyLabel(text(label));
    if (t && label && !label.contains(el)) return requiredMark(label, box) && !t.includes('*') ? `${t} *` : t;
  }
  const td = el.closest('td') as HTMLTableCellElement | null;
  if (td) {
    const beside = rowLabel(td);
    if (beside) {
      const t = tidyLabel(beside.text);
      return requiredMark(beside.cell, null) && !t.includes('*') ? `${t} *` : t;
    }
    const header = columnHeader(td);
    if (header) return tidyLabel(header);
  }
  const generic = genericLabel(el);
  return generic ? tidyLabel(generic) : null;
}

/**
 * The title of the section `el` sits in: walking up from the element, the
 * nearest previous sibling that IS a heading. A previous sibling that merely
 * contains a heading is another section's block, so the walk goes up a level.
 */
export function sectionTitleOf(el: HTMLElement, headings: string = DEFAULT_HEADINGS, maxLevels = 10): string | null {
  let cur: Element | null = el;
  for (let level = 0; cur && level < maxLevels; level++) {
    let prev = cur.previousElementSibling;
    while (prev) {
      if (prev.matches(headings)) {
        const t = cleanLabel(text(prev));
        if (t) return t;
      }
      const inner = prev.querySelectorAll(headings);
      if (inner.length) {
        // A header bar ("教育经历" + an add button) is ours; a block with fields is another section.
        if (prev.querySelector('input, select, textarea, [role="combobox"]')) break;
        const t = cleanLabel(text(inner[inner.length - 1]));
        if (t) return t;
      }
      prev = prev.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Labels a mainland application form almost always has (normalized, without punctuation). */
const CN_FORM_LABEL_RE = /^(真实)?姓名$|^(手机|手机号|手机号码|联系电话|移动电话)$|^(电子)?邮箱(地址)?$|^(毕业)?(学校|院校)(名称)?$|^(最高)?学历$|^专业$|^(附件)?简历|^政治面貌$|^籍贯$/;

/** Probe for a mainland application form: at least `min` labels a 网申 form always has. */
export function looksLikeCnForm(root: ParentNode, min = 3): boolean {
  const seen = new Set<string>();
  const candidates = root.querySelectorAll('label, th, td, [class*="label"], [class*="Label"], .el-form-item__label, .ud__form__item__label');
  for (const c of Array.from(candidates)) {
    if (c.querySelector('input, select, textarea')) continue;
    const t = tidyLabel(text(c)).replace(/[*✱\s]/g, '');
    if (t.length > 12) continue;
    if (CN_FORM_LABEL_RE.test(t)) seen.add(t);
    if (seen.size >= min) return true;
  }
  return false;
}

/** The company name from the page: a selector, then og:site_name, then the document title ("示例科技校园招聘"). */
export function cnCompany(doc: Document, selectors: string[]): string | undefined {
  const fromPage = firstText(doc, selectors);
  if (fromPage) return fromPage;
  const meta = metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  if (meta) return meta;
  const title = (doc.title ?? '').trim();
  const m = title.match(/^(.+?)(?:\s*[-|｜_]\s*)?(?:校园招聘|社会招聘|实习生招聘|招聘官网|招聘|校招|社招)/);
  return m?.[1]?.trim() || undefined;
}

// ── the form on the page ────────────────────────────────────────────────────

/** Page areas that never hold the application form (the site's header / nav search). */
export const NOT_FORM_AREA = 'header, nav, [role="search"], [role="banner"], [role="navigation"]';

const SEARCH_LABEL_RE = /搜索|搜尋|search|关键字|关键词|關鍵字|關鍵詞/i;
/** Words a 网申 field label carries (a header search form has none of them). */
const FORM_HINT_RE =
  /姓名|手机|手機|电话|電話|邮箱|郵箱|学校|學校|院校|学历|學歷|学位|學位|专业|專業|性别|性別|出生|籍贯|籍貫|政治面貌|民族|毕业|畢業|入学|入學|公司|单位|單位|职位|職位|岗位|崗位|关系|關係|称谓|稱謂|简历|簡歷|证件|證件|身份证|微信|生源|户口|戶口|到岗|到崗|实习|實習|^name$|full ?name|phone|mobile|e-?mail|school|university|degree|major|resume/i;
const NON_FIELD_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password']);

function formWeight(form: Element, labelFor: (el: HTMLElement) => string | null): { hinted: number; labelled: number } {
  let hinted = 0;
  let labelled = 0;
  for (const el of Array.from(form.querySelectorAll<HTMLElement>('input, select, textarea, [role="combobox"]'))) {
    if (NON_FIELD_TYPES.has((el.getAttribute('type') ?? '').toLowerCase())) continue;
    const label = (labelFor(el) ?? '').replace(/[*✱\s：:]/g, '');
    if (!label || SEARCH_LABEL_RE.test(label) || /search/i.test(el.getAttribute('name') ?? '')) continue;
    labelled++;
    if (label.length <= 16 && FORM_HINT_RE.test(label)) hinted++;
  }
  return { hinted, labelled };
}

function outermost(els: Element[]): Element[] {
  return els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
}

export interface CnFormRegions {
  /** Forms holding the application's fields, in page order. */
  regions: Element[];
  /** Other matching forms (a search box styled as a form, a newsletter sign-up …). */
  dropped: Element[];
}

/**
 * Every form matching `formSelector` that holds 网申 fields. A portal may put
 * one form per section card (Element UI) or have a search form in the page
 * header before the application form; querySelector() would return only the
 * first match. Forms inside header / nav are never the application form. If no
 * form carries a 网申 label, any form with a labelled field counts (an
 * English-language form on the same portal).
 */
export function cnFormRegions(root: Document | ShadowRoot, formSelector: string, labelFor: (el: HTMLElement) => string | null): CnFormRegions {
  let all: Element[] = [];
  try {
    all = Array.from(root.querySelectorAll(formSelector));
  } catch {
    all = [];
  }
  const candidates = outermost(all.filter((f) => !f.closest(NOT_FORM_AREA)));
  const weights = new Map(candidates.map((f) => [f, formWeight(f, labelFor)]));
  let regions = candidates.filter((f) => weights.get(f)!.hinted > 0);
  if (!regions.length) regions = candidates.filter((f) => weights.get(f)!.labelled > 0);
  const dropped = all.filter((f) => !regions.some((r) => r === f || r.contains(f) || f.contains(r)));
  return { regions, dropped };
}

/** The smallest element holding every region. */
export function commonAncestor(els: Element[]): Element | null {
  let anc: Element | null = els[0] ?? null;
  while (anc && !els.every((e) => anc!.contains(e))) anc = anc.parentElement;
  return anc;
}

/**
 * listFields() options for a portal form: scope = the application form(s)
 * (their common ancestor when there are several), and fields outside them —
 * a header search, another matching form — are left out.
 */
export function cnFormFieldOptions(formSelector: string, fields: Omit<ListFieldsOptions, 'scope'>): ListFieldsOptions {
  const labelFor = fields.labelFor ?? ((el: HTMLElement) => cnLabelFor(el));
  let found: CnFormRegions = { regions: [], dropped: [] };
  return {
    ...fields,
    scope: (root) => {
      found = cnFormRegions(root, formSelector, labelFor);
      if (found.regions.length === 1) return found.regions[0];
      if (found.regions.length > 1) return commonAncestor(found.regions);
      return root instanceof Document ? root.body : root;
    },
    skip: (el) => {
      if (fields.skip?.(el)) return true;
      if (el.closest(NOT_FORM_AREA)) return true;
      if (found.dropped.some((f) => f.contains(el))) return true;
      return found.regions.length > 0 && !found.regions.some((f) => f.contains(el));
    },
  };
}

export interface CnAdapterSpec extends Omit<AdapterSpec, 'readJob' | 'fields'> {
  headings?: string;
  submitSelectors: string[];
  /** Selector list for the application form; every match holding 网申 fields is read. */
  form: string;
  fields: Omit<ListFieldsOptions, 'scope'>;
  readJob(doc: Document): JobOnPage | null;
}

/** A portal adapter: base adapter (filling through the _kit) + the cn extras. */
export function defineCnAdapter(spec: CnAdapterSpec): CnAdapter {
  const base = defineAdapter({ ...spec, fields: cnFormFieldOptions(spec.form, spec.fields) });
  const headings = spec.headings ? `${spec.headings}, ${DEFAULT_HEADINGS}` : DEFAULT_HEADINGS;
  const labelFor = spec.fields.labelFor ?? ((el: HTMLElement) => cnLabelFor(el));
  return {
    ...base,
    cn: {
      sectionTitle: (el) => sectionTitleOf(el, headings),
      submitSelectors: spec.submitSelectors,
      formRegions: (root) => cnFormRegions(root, spec.form, labelFor).regions,
    },
  };
}

/** Host test shared by the specific adapters. */
export function onHosts(url: URL, domains: string[]): boolean {
  return (url.protocol === 'https:' || url.protocol === 'http:') && hostIs(url, domains);
}

export type { AtsType };

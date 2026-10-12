// extension/src/content/panel/submitHint.ts — after a fill on a portal form,
// point at the portal's OWN submit control ("请核对后自行提交").
//
// D1: this file only reads the page and draws an outline. It never presses,
// focuses or submits anything; the user does. The outline is removed when the
// panel goes away (restore()).

import { accessibleName } from '../../adapters/_kit/submitLike';
import type { AtsAdapter } from '../../adapters/types';
import { commonAncestor, isCnAdapter } from '../../adapters/cn/kit';

/** Names of a control that sends the application (best first). */
const SEND_RE = /提交|投递|投遞|送出|submit/i;
const APPLY_RE = /申请|申請|apply|确认|確認/i;
/** Controls that do something else: never outlined as "the" submit control. */
const OTHER_RE = /保存|草稿|下一步|上一步|下一页|上一页|取消|返回|预览|預覽|重置|清空|上传|上傳|添加|新增|删除|刪除|next|back|previous|cancel|save|draft|preview|reset|upload|add|delete|remove/i;

/** Button-like controls. A plain link is never the form's submit control ("提交反馈", "投递记录" in a footer). */
const CANDIDATES = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';

/** Page furniture: a control here is not the form's own (unless the form itself sits inside it). */
const AWAY = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [role="search"]';
/** A modal on top of the page (a consent box's "确认"): not the form's control unless the form is in it. */
const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .el-dialog, .el-message-box, .ud__modal';
/** How far up from the form a control "right after it" may sit (a footer bar beside the form). */
const AFTER_LEVELS = 3;
/** …and how many blocks after it. */
const AFTER_SIBLINGS = 2;

/** Attribute that marks the outlined control (and lets tests find it). */
export const SUBMIT_HINT_ATTR = 'data-ra-submit-hint';

/** Marks our own panel (its buttons are never the portal's submit control). */
export const PANEL_ATTR = 'data-ra-ext-panel';

function visible(el: Element): boolean {
  if (el.closest(`[hidden], [aria-hidden="true"], [${PANEL_ATTR}]`)) return false;
  const style = (el as HTMLElement).style;
  return !(style && (style.display === 'none' || style.visibility === 'hidden'));
}

function nameOf(el: Element): string {
  return accessibleName(el) || (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function score(el: Element): number {
  const name = nameOf(el);
  if (!name || OTHER_RE.test(name)) return 0;
  if (SEND_RE.test(name)) return 3;
  if (APPLY_RE.test(name)) return 2;
  return (el.getAttribute('type') ?? '').toLowerCase() === 'submit' ? 1 : 0;
}

/** The application form's regions on this page (the adapter's own form scope), or the body when it found none. */
function formRegions(doc: Document, adapter: AtsAdapter): { regions: Element[]; whole: boolean } {
  const regions = isCnAdapter(adapter) ? adapter.cn.formRegions(doc) : [];
  return regions.length ? { regions, whole: false } : { regions: doc.body ? [doc.body] : [], whole: true };
}

/** 2 = inside the form, 1 = right after it (a footer bar beside the form), 0 = elsewhere on the page. */
function placement(el: Element, regions: Element[], whole: boolean): number {
  const away = el.closest(AWAY);
  if (away && (whole || !regions.some((r) => r.contains(away)))) return 0;
  const dialog = el.closest(DIALOG);
  if (dialog && (whole || !regions.some((r) => dialog.contains(r) || r.contains(dialog)))) return 0;
  if (regions.some((r) => r.contains(el))) return 2;
  // "After the form": in one of the next few blocks after the form (or after a wrapper of it), not anywhere below.
  const block = regions.length > 1 ? commonAncestor(regions) : regions[0];
  let cur: Element | null = block ?? null;
  for (let level = 0; cur && cur !== el.ownerDocument.body && level < AFTER_LEVELS; level++, cur = cur.parentElement) {
    let sib = cur.nextElementSibling;
    for (let n = 0; sib && n < AFTER_SIBLINGS; n++, sib = sib.nextElementSibling) if (sib.contains(el)) return 1;
  }
  return 0;
}

/**
 * The portal's own submit control, or null when there is none on this page
 * (a multi-step form shows only "下一步" until its last step).
 * Only controls inside the application form, or right after it, count: the
 * adapter's selectors first, then every button-like control by its name.
 * Inside beats after; then the best name; then the last one.
 */
export function findSubmitControl(doc: Document, adapter: AtsAdapter): HTMLElement | null {
  const { regions, whole } = formRegions(doc, adapter);
  const pick = (els: Element[]): HTMLElement | null => {
    let best: { el: HTMLElement; p: number; s: number } | null = null;
    for (const el of els) {
      if (!visible(el)) continue;
      const p = placement(el, regions, whole);
      const s = score(el);
      if (p === 0 || s === 0) continue;
      if (!best || p > best.p || (p === best.p && s >= best.s)) best = { el: el as HTMLElement, p, s };
    }
    return best?.el ?? null;
  };
  if (isCnAdapter(adapter)) {
    for (const sel of adapter.cn.submitSelectors) {
      let found: Element[] = [];
      try {
        found = Array.from(doc.querySelectorAll(sel));
      } catch {
        found = [];
      }
      const hit = pick(found);
      if (hit) return hit;
    }
  }
  return pick(Array.from(doc.querySelectorAll(CANDIDATES)));
}

/**
 * Outline the control (inline style, so the page's own CSS cannot hide it;
 * system colours, so it reads in light and dark pages). Returns restore().
 */
export function outlineSubmitControl(el: HTMLElement): () => void {
  const prev = { outline: el.style.getPropertyValue('outline'), outlinePriority: el.style.getPropertyPriority('outline'), offset: el.style.getPropertyValue('outline-offset') };
  el.style.setProperty('outline', '3px solid Highlight', 'important');
  el.style.setProperty('outline-offset', '3px');
  el.setAttribute(SUBMIT_HINT_ATTR, 'true');
  return () => {
    if (prev.outline) el.style.setProperty('outline', prev.outline, prev.outlinePriority);
    else el.style.removeProperty('outline');
    if (prev.offset) el.style.setProperty('outline-offset', prev.offset);
    else el.style.removeProperty('outline-offset');
    el.removeAttribute(SUBMIT_HINT_ATTR);
  };
}

/** Scroll the control into view. Scrolling only: it is not focused or pressed. */
export function revealSubmitControl(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

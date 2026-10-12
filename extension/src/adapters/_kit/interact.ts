// extension/src/adapters/_kit/interact.ts — THE ONLY FILE IN THE EXTENSION
// ALLOWED TO PRESS ANYTHING (D1; ARCHITECTURE.md §6.6).
//
// It exports exactly two functions: openListbox(el) (open a custom dropdown so
// its options exist) and chooseOption(el) (pick a radio, checkbox or listbox
// option). Both call assertNotSubmitLike(el) first, which throws for buttons,
// submit/button/image inputs, role=button, and anything (or an ancestor up to
// 3 levels) named submit/apply/next/continue/review/提交/投递/下一步….
// scripts/check-extension-no-submit.mjs fails the build when any other file
// presses anything or this file exports anything else.

import { isSubmitLike } from './submitLike';

class SubmitLikeRefusedError extends Error {
  constructor(what: string) {
    super(`Refused to press a submit-like control (${what}). The user submits the application.`);
    this.name = 'SubmitLikeRefusedError';
  }
}

function describe(el: Element | null | undefined): string {
  if (!el) return 'missing element';
  const id = el.id ? `#${el.id}` : '';
  return `${el.tagName.toLowerCase()}${id}`;
}

function assertNotSubmitLike(el: Element | null | undefined): asserts el is HTMLElement {
  if (!el || isSubmitLike(el)) throw new SubmitLikeRefusedError(describe(el));
}

/** Open a custom listbox/combobox so its options render. Throws on submit-like elements. */
export function openListbox(el: Element): void {
  assertNotSubmitLike(el);
  el.focus?.();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.click();
}

/** Choose a radio, checkbox or listbox option. Throws on submit-like elements. */
export function chooseOption(el: Element): void {
  assertNotSubmitLike(el);
  el.click();
}

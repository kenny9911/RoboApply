// extension/src/adapters/_kit/submitLike.ts — "is this a control that submits,
// sends or advances the application?" (ARCHITECTURE.md §6.6).
//
// interact.ts refuses any element for which this is true; listFields() uses it
// to keep such controls out of the field list. Pure DOM reads, no interaction.

/** Words (any locale we ship) naming a control we must never press. */
export const SUBMIT_LIKE_NAME_RE =
  /(?:^|[^\p{L}\p{N}])(?:submit|apply|next|continue|review|send|save|finish|done)(?![\p{L}\p{N}])|提交|投递|投遞|下一步|下一页|下一頁|送出|申请|申請|保存|继续|繼續|確認送出/iu;

/** How many ancestors above the element are checked as well. */
export const SUBMIT_LIKE_ANCESTOR_LEVELS = 3;

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset']);

function textOf(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/**
 * The element's accessible name, approximated: aria-label, aria-labelledby,
 * title, and, for buttons/links/options, their text; for inputs of a button
 * type, their value. A plain container has no name from its content (that
 * would make every form wrapper "submit-like" because it contains the button).
 */
export function accessibleName(el: Element): string {
  const parts: string[] = [];
  const aria = el.getAttribute('aria-label');
  if (aria) parts.push(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && el.ownerDocument) parts.push(textOf(el.ownerDocument, labelledBy));
  const title = el.getAttribute('title');
  if (title) parts.push(title);
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link') parts.push(el.textContent ?? '');
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (BUTTON_INPUT_TYPES.has(type)) parts.push((el as HTMLInputElement).value ?? '', el.getAttribute('alt') ?? '');
    for (const label of Array.from((el as HTMLInputElement).labels ?? [])) parts.push(label.textContent ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** One element, without ancestors. */
export function isSubmitLikeElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'input' && BUTTON_INPUT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase())) return true;
  if ((el.getAttribute('type') ?? '').toLowerCase() === 'submit') return true;
  if ((el.getAttribute('role') ?? '').toLowerCase() === 'button') return true;
  if (tag === 'form') return true;
  return SUBMIT_LIKE_NAME_RE.test(accessibleName(el));
}

/** The element or any of its ancestors (up to 3 levels) is submit-like. */
export function isSubmitLike(el: Element | null | undefined): boolean {
  if (!el) return true;
  let cur: Element | null = el;
  for (let level = 0; cur && level <= SUBMIT_LIKE_ANCESTOR_LEVELS; level++) {
    // The element itself is judged in full; ancestors are judged by role and name
    // only (a <form> ancestor is normal — every field lives in one).
    if (level === 0 ? isSubmitLikeElement(cur) : cur.tagName.toLowerCase() !== 'form' && isSubmitLikeElement(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

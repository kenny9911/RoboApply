// extension/src/adapters/_kit/fields.ts — the field model shared by every adapter:
// find the form's controls in a stable order, label them, and fill them with
// the setters (text, select, file) or interact.ts (radio, checkbox, listbox).
// Submit-like controls are never listed and never pressed.

import type { FieldHandle, FieldKey, FieldKind, FieldValue, FillResult, PreviousValue } from '../types';
import { chooseOption, openListbox } from './interact';
import { matchOption, normalizeText } from './options';
import { attachFileToInput, clearFileInput, restoreSelect, selectOptionLabels, setSelectOption, setTextValue } from './setters';

export interface ListFieldsOptions {
  /** The form container to scan (default: the whole root). */
  scope?: (root: Document | ShadowRoot) => Element | Document | ShadowRoot | null;
  /** Adapter-specific label lookup, tried first. */
  labelFor?: (el: HTMLElement) => string | null;
  /** Adapter-specific canonical key from the form's own field names. */
  hintFor?: (el: HTMLElement) => FieldKey | undefined;
  /** Extra elements to leave out (e.g. honeypots, the site's own search box). */
  skip?: (el: HTMLElement) => boolean;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password']);

export function cleanLabel(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\(required\)|\(optional\)|（必填）|（选填）/gi, ' ')
    .replace(/[*✱]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function byId(doc: Document, id: string): HTMLElement | null {
  try {
    return doc.getElementById(id);
  } catch {
    return null;
  }
}

/** Text of a <label>, without the text of controls nested inside it. */
function labelText(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, button, [role="listbox"], [role="option"]').forEach((n) => n.remove());
  return clone.textContent ?? '';
}

export function genericLabel(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const fromLabels = Array.from((el as HTMLInputElement).labels ?? [])
    .map(labelText)
    .join(' ');
  if (cleanLabel(fromLabels)) return cleanLabel(fromLabels);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = labelledBy
      .split(/\s+/)
      .map((id) => byId(doc, id)?.textContent ?? '')
      .join(' ');
    if (cleanLabel(t)) return cleanLabel(t);
  }
  const aria = el.getAttribute('aria-label');
  if (cleanLabel(aria)) return cleanLabel(aria);
  const placeholder = el.getAttribute('placeholder');
  if (cleanLabel(placeholder)) return cleanLabel(placeholder);
  return cleanLabel(el.getAttribute('name') ?? el.id ?? '');
}

function legendFor(el: HTMLElement): string | null {
  const fs = el.closest('fieldset');
  const legend = fs?.querySelector('legend');
  return legend ? legend.textContent : null;
}

function kindOf(el: HTMLElement): FieldKind | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if ((el.getAttribute('role') ?? '').toLowerCase() === 'combobox') return 'combobox';
  if (tag !== 'input') return null;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (SKIP_INPUT_TYPES.has(type)) return null;
  switch (type) {
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    case 'number':
      return 'number';
    case 'date':
    case 'month':
      return 'date';
    case 'radio':
      return 'radio';
    case 'checkbox':
      return 'checkbox';
    case 'file':
      return 'file';
    default:
      return 'text';
  }
}

function isRequired(el: HTMLElement, rawLabel: string): boolean {
  return (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(rawLabel);
}

function rawLabelFor(el: HTMLElement, opts: ListFieldsOptions): string {
  const adapter = opts.labelFor?.(el);
  if (adapter && cleanLabel(adapter)) return adapter;
  const fromLabels = Array.from((el as HTMLInputElement).labels ?? [])
    .map(labelText)
    .join(' ');
  return fromLabels || genericLabel(el);
}

/** Every fillable control in `root`, in document order. */
export function listFieldsIn(root: Document | ShadowRoot, opts: ListFieldsOptions = {}): FieldHandle[] {
  const scope = opts.scope ? opts.scope(root) : root;
  if (!scope) return [];
  const nodes = Array.from((scope as ParentNode).querySelectorAll<HTMLElement>('input, select, textarea, [role="combobox"]'));
  const out: FieldHandle[] = [];
  const seenIds = new Set<string>();
  const radioGroups = new Map<string, FieldHandle>();
  const uniqueId = (base: string) => {
    let id = base || `field-${out.length}`;
    for (let n = 2; seenIds.has(id); n++) id = `${base}-${n}`;
    seenIds.add(id);
    return id;
  };

  for (const el of nodes) {
    const kind = kindOf(el);
    if (!kind) continue;
    if (kind !== 'file' && el.closest('[hidden], [aria-hidden="true"]')) continue;
    if (opts.skip?.(el)) continue;
    // A combobox wrapper's own input is the same control.
    if (kind !== 'combobox' && el.closest('[role="combobox"]') && el.closest('[role="combobox"]') !== el) continue;
    if (kind === 'combobox' && el.tagName.toLowerCase() !== 'input' && el.querySelector('input[role="combobox"]')) continue;
    if ((el.getAttribute('role') ?? '').toLowerCase() === 'button') continue;

    if (kind === 'radio') {
      const name = el.getAttribute('name') ?? '';
      const radio = el as HTMLInputElement;
      const existing = name ? radioGroups.get(name) : undefined;
      const optionLabel = cleanLabel(Array.from(radio.labels ?? []).map(labelText).join(' ')) || radio.value;
      if (existing) {
        existing.group!.push(radio);
        existing.options!.push(optionLabel);
        existing.required ||= radio.required;
        continue;
      }
      const raw = opts.labelFor?.(el) ?? legendFor(el) ?? name;
      const field: FieldHandle = {
        id: uniqueId(name || radio.id),
        label: cleanLabel(raw),
        kind: 'radio',
        required: isRequired(el, raw ?? ''),
        element: radio,
        group: [radio],
        options: [optionLabel],
        hint: opts.hintFor?.(el),
      };
      if (name) radioGroups.set(name, field);
      out.push(field);
      continue;
    }

    const raw = rawLabelFor(el, opts);
    const field: FieldHandle = {
      id: uniqueId(el.id || el.getAttribute('name') || ''),
      label: cleanLabel(raw),
      kind,
      required: isRequired(el, raw),
      element: el,
      hint: opts.hintFor?.(el),
    };
    if (kind === 'select') field.options = selectOptionLabels(el as HTMLSelectElement);
    const max = (el as HTMLInputElement).maxLength;
    if (typeof max === 'number' && max > 0) field.maxLength = max;
    out.push(field);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 1200, stepMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

function listboxOptions(input: HTMLElement): HTMLElement[] {
  const doc = input.ownerDocument;
  const ids = [input.getAttribute('aria-controls'), input.getAttribute('aria-owns')].filter(Boolean).join(' ');
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const box = byId(doc, id);
    const opts = box ? Array.from(box.querySelectorAll<HTMLElement>('[role="option"]')) : [];
    if (opts.length) return opts;
  }
  const near = input.closest('[data-field], .field, .select, .application-question, div')?.parentElement;
  const local = near ? Array.from(near.querySelectorAll<HTMLElement>('[role="option"]')) : [];
  return local.length ? local : Array.from(doc.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]'));
}

function tryChoose(el: Element): boolean {
  try {
    chooseOption(el);
    return true;
  } catch {
    return false;
  }
}

function textFor(value: FieldValue): string | null {
  if (value.kind === 'text') return value.text;
  if (value.kind === 'option') return value.option;
  return null;
}

/** Fill one field. Never presses a submit-like control (interact.ts refuses). */
export async function fillField(field: FieldHandle, value: FieldValue): Promise<FillResult> {
  const el = field.element;
  if (!el?.isConnected) return { ok: false, reason: 'not_found' };
  const text = textFor(value);
  switch (field.kind) {
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
    case 'number':
    case 'date':
    case 'textarea':
      if (text === null) return { ok: false, reason: 'unsupported' };
      return setTextValue(el as HTMLInputElement | HTMLTextAreaElement, text);
    case 'select':
      if (text === null) return { ok: false, reason: 'unsupported' };
      return setSelectOption(el as HTMLSelectElement, text);
    case 'radio': {
      if (text === null) return { ok: false, reason: 'unsupported' };
      const group = field.group ?? [el as HTMLInputElement];
      const idx = matchOption(field.options ?? [], text);
      if (idx === -1) return { ok: false, reason: 'no_option' };
      const target = group[idx];
      const previous: PreviousValue = { kind: 'radio', checked: group.find((r) => r.checked) ?? null };
      if (target.checked) return { ok: true, previous };
      if (target.disabled) return { ok: false, reason: 'disabled' };
      return tryChoose(target) ? { ok: true, previous } : { ok: false, reason: 'refused' };
    }
    case 'checkbox': {
      const box = el as HTMLInputElement;
      const want = value.kind === 'checked' ? value.checked : text !== null ? /^(yes|true|1|是)$/i.test(normalizeText(text)) : null;
      if (want === null) return { ok: false, reason: 'unsupported' };
      const previous: PreviousValue = { kind: 'checkbox', checked: box.checked };
      if (box.checked === want) return { ok: true, previous };
      if (box.disabled) return { ok: false, reason: 'disabled' };
      return tryChoose(box) ? { ok: true, previous } : { ok: false, reason: 'refused' };
    }
    case 'combobox': {
      if (text === null) return { ok: false, reason: 'unsupported' };
      const previous: PreviousValue = { kind: 'combobox', text: (el as HTMLInputElement).value ?? el.textContent ?? '' };
      try {
        openListbox(el);
      } catch {
        return { ok: false, reason: 'refused' };
      }
      const options = await waitFor(() => {
        const o = listboxOptions(el);
        return o.length ? o : null;
      });
      if (!options) return { ok: false, reason: 'no_option' };
      const idx = matchOption(
        options.map((o) => o.textContent ?? ''),
        text,
      );
      if (idx === -1) return { ok: false, reason: 'no_option' };
      return tryChoose(options[idx]) ? { ok: true, previous } : { ok: false, reason: 'refused' };
    }
    case 'file':
      return { ok: false, reason: 'unsupported' };
  }
}

export async function attachFileField(field: FieldHandle, file: File): Promise<FillResult> {
  if (field.kind !== 'file' || !field.element?.isConnected) return { ok: false, reason: 'not_found' };
  return attachFileToInput(field.element as HTMLInputElement, file);
}

/**
 * Put a field back the way it was. Returns false when that is not possible
 * without pressing something we may not press (a radio group that had no
 * choice, a custom listbox).
 */
export function restoreField(field: FieldHandle, previous: PreviousValue): boolean {
  const el = field.element;
  if (!el?.isConnected) return false;
  switch (previous.kind) {
    case 'text':
      setTextValue(el as HTMLInputElement, previous.text);
      return true;
    case 'select':
      restoreSelect(el as HTMLSelectElement, previous.value);
      return true;
    case 'checkbox':
      return (el as HTMLInputElement).checked === previous.checked || tryChoose(el);
    case 'radio':
      if (!previous.checked) return (field.group ?? []).every((r) => !r.checked);
      return previous.checked.checked || tryChoose(previous.checked);
    case 'files':
      if (previous.count === 0) clearFileInput(el as HTMLInputElement);
      return previous.count === 0;
    case 'combobox':
      return false;
  }
}

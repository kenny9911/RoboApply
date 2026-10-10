// extension/src/adapters/_kit/setters.ts — value setters that framework forms
// (React, Vue, Angular) notice: the native value setter, then input / change /
// blur events. No clicks and no key presses: choosing radios, checkboxes and
// custom listbox options goes through interact.ts.

import type { FillResult, PreviousValue } from '../types';
import { isPlaceholderOption, matchOption } from './options';

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function nativeSetter(el: HTMLElement, prop: 'value' | 'checked'): ((v: unknown) => void) | null {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  return desc?.set ? (v: unknown) => desc.set!.call(el, v) : null;
}

function writable(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  return !el.disabled && !(el as HTMLInputElement).readOnly;
}

/** Type-free text entry into an input or textarea. */
export function setTextValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): FillResult {
  if (!writable(el)) return { ok: false, reason: 'disabled' };
  const previous: PreviousValue = { kind: 'text', text: el.value };
  const max = el.maxLength > 0 ? el.maxLength : undefined;
  const value = max ? text.slice(0, max) : text;
  el.focus?.();
  const set = nativeSetter(el, 'value');
  if (set) set(value);
  else el.value = value;
  fire(el, 'input');
  fire(el, 'change');
  el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  fire(el, 'focusout');
  return { ok: true, previous };
}

export function selectOptionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options)
    .filter((o) => !isPlaceholderOption(o.textContent ?? '', o.value))
    .map((o) => (o.textContent ?? '').trim());
}

/** Choose the <option> whose label matches `wanted`. */
export function setSelectOption(select: HTMLSelectElement, wanted: string): FillResult {
  if (!writable(select)) return { ok: false, reason: 'disabled' };
  const real = Array.from(select.options).filter((o) => !isPlaceholderOption(o.textContent ?? '', o.value));
  const idx = matchOption(
    real.map((o) => (o.textContent ?? '').trim()),
    wanted,
  );
  if (idx === -1) return { ok: false, reason: 'no_option' };
  const previous: PreviousValue = { kind: 'select', value: select.value };
  const set = nativeSetter(select, 'value');
  if (set) set(real[idx].value);
  else select.value = real[idx].value;
  fire(select, 'input');
  fire(select, 'change');
  return { ok: true, previous };
}

export function restoreSelect(select: HTMLSelectElement, value: string): void {
  const set = nativeSetter(select, 'value');
  if (set) set(value);
  else select.value = value;
  fire(select, 'input');
  fire(select, 'change');
}

/** A FileList holding `files` (DataTransfer where the browser has it). */
export function makeFileList(files: File[]): FileList {
  if (typeof DataTransfer !== 'undefined') {
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      return dt.files;
    } catch {
      // jsdom: DataTransfer exists in some versions without items.add
    }
  }
  const list = Object.assign([...files], { item: (i: number) => files[i] ?? null }) as unknown as FileList;
  return list;
}

/** Attach a file to an <input type=file> (DataTransfer → input.files → change). */
export function attachFileToInput(input: HTMLInputElement, file: File): FillResult {
  if (input.disabled) return { ok: false, reason: 'disabled' };
  const previous: PreviousValue = { kind: 'files', count: input.files?.length ?? 0 };
  const list = makeFileList([file]);
  try {
    input.files = list;
  } catch {
    Object.defineProperty(input, 'files', { value: list, configurable: true });
  }
  if (input.files?.length !== 1) Object.defineProperty(input, 'files', { value: list, configurable: true });
  fire(input, 'input');
  fire(input, 'change');
  return { ok: true, previous };
}

export function clearFileInput(input: HTMLInputElement): void {
  const empty = makeFileList([]);
  try {
    input.files = empty;
  } catch {
    Object.defineProperty(input, 'files', { value: empty, configurable: true });
  }
  if (input.files && input.files.length) Object.defineProperty(input, 'files', { value: empty, configurable: true });
  fire(input, 'change');
}

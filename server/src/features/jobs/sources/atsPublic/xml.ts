// server/src/features/jobs/sources/atsPublic/xml.ts — a small, tolerant reader
// for the flat XML feeds some job-board systems publish (MKT-5B, JI-8:
// Personio's `/xml`). No dependency.
//
// It reads what such a feed holds and nothing more: elements by name, text,
// CDATA sections, the five predefined entities and numeric character
// references. Attributes are skipped (the feeds we read carry their data in
// elements); processing instructions, comments and a DOCTYPE are skipped too.
// Nothing is ever expanded from a DOCTYPE: an entity the document declares
// itself stays as written, so a hostile feed cannot make the reader fetch or
// repeat anything (no external entities, no entity bombs).
//
// Tolerant where a real feed is sloppy: text before the root, a missing end
// tag at the end of the document and an end tag that closes an outer element
// (the open inner ones are closed with it) are all read. A document that has
// no element at all, nests deeper than MAX_XML_DEPTH or holds more than
// MAX_XML_NODES elements is refused ('not_xml' / 'unexpected_shape'), because
// then it is not the feed we know.

import { BoardFetchError } from './http.js';
import { decodeEntities } from './shared.js';

export const MAX_XML_DEPTH = 32;
export const MAX_XML_NODES = 200_000;

export interface XmlElement {
  /** The element name as written (case kept, a namespace prefix included). */
  name: string;
  /** Child elements, in document order. */
  children: XmlElement[];
  /**
   * The element's own text: its text nodes (entities decoded) and CDATA
   * sections (verbatim) joined in document order, trimmed. Text of child
   * elements is not included.
   */
  text: string;
  /** Everything between the start and the end tag, exactly as written (for an element whose markup is its content). */
  inner: string;
}

interface OpenElement {
  el: XmlElement;
  parts: string[];
  /** Offset of the first character after the start tag. */
  contentStart: number;
}

const NAME_START = /[A-Za-z_:]/;

/** Where the tag that starts at `from` ('<') ends: the index of its '>', skipping quoted attribute values. -1 when it never ends. */
function tagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < src.length; i += 1) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** The end of a DOCTYPE that starts at `from`: past its internal subset when it has one. */
function doctypeEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === '[') depth += 1;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

/** The document's root element. Throws BoardFetchError('not_xml' | 'unexpected_shape'). */
export function parseXml(source: string): XmlElement {
  const src = source.replace(/^﻿/, '');
  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let i = 0;

  const close = (upTo: number, endOffset: number): void => {
    while (stack.length > upTo) {
      const open = stack.pop()!;
      open.el.text = open.parts.join('').trim();
      open.el.inner = src.slice(open.contentStart, endOffset);
    }
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      if (top) top.parts.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i && top) top.parts.push(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end < 0 ? src.length : end;
      if (top) top.parts.push(src.slice(lt + 9, stop));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = doctypeEnd(src, lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) break;
      const name = src.slice(lt + 2, end).trim();
      // The nearest open element of that name is closed, and every element opened inside it with it.
      let at = stack.length - 1;
      while (at >= 0 && stack[at]!.el.name !== name) at -= 1;
      if (at >= 0) close(at, lt);
      i = end + 1;
      continue;
    }
    if (!NAME_START.test(src[lt + 1] ?? '')) {
      // A bare '<' in text.
      if (top) top.parts.push('<');
      i = lt + 1;
      continue;
    }
    const end = tagEnd(src, lt);
    if (end < 0) break;
    const selfClosing = src[end - 1] === '/';
    const head = src.slice(lt + 1, selfClosing ? end - 1 : end);
    const name = /^[^\s/>]+/.exec(head)?.[0] ?? '';
    nodes += 1;
    if (nodes > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) throw new BoardFetchError('unexpected_shape');
    const el: XmlElement = { name, children: [], text: '', inner: '' };
    if (top) top.el.children.push(el);
    else if (!root) root = el;
    if (!selfClosing) stack.push({ el, parts: [], contentStart: end + 1 });
    i = end + 1;
  }
  close(0, src.length);
  if (!root) throw new BoardFetchError('not_xml');
  return root;
}

/** The direct children of `el` named `name` (exact, case-sensitive). */
export function childrenNamed(el: XmlElement | null | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** The first direct child named `name`, or null. */
export function childNamed(el: XmlElement | null | undefined, name: string): XmlElement | null {
  return el?.children.find((c) => c.name === name) ?? null;
}

/** The text of the first direct child named `name`; null when there is none or it is empty. */
export function childText(el: XmlElement | null | undefined, name: string): string | null {
  const text = childNamed(el, name)?.text ?? '';
  return text ? text : null;
}

/**
 * The markup an element holds as its value: its text (CDATA verbatim, an
 * escaped fragment decoded) when it has no child elements, else what is
 * written between its tags (a feed that puts the HTML in unescaped).
 */
export function elementMarkup(el: XmlElement | null | undefined): string | null {
  if (!el) return null;
  const value = el.children.length > 0 ? el.inner.trim() : el.text;
  return value ? value : null;
}

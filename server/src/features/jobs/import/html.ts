// server/src/features/jobs/import/html.ts — reading HTML we did not write, in
// time proportional to its size.
//
// Why this exists: a page a user asks us to import (directFetch.ts) and the
// text of a posting (extract.ts, cn/jobs/text.ts) come from other people. A
// pattern such as /<meta\b[^>]*…>/ or /<script[\s\S]*?<\/script>/ run over
// such a document starts again at every unclosed "<meta " or "<script" and
// reads to the end each time: 100 KB of "<li " takes seconds, 2 MB takes many
// minutes, and the whole API process waits. Nothing in this file does that.
// `scanHtml` reads the document ONCE, left to right:
//   - the next "<" is found with indexOf; a tag ends at its ">" (a ">" inside
//     a quoted attribute value does not end it);
//   - a comment, a doctype and a whole raw-text element (script, style, …)
//     are reported as one hidden piece, found with one search for the closer;
//   - a search that found nothing is never repeated ("no '>' from here on",
//     "no `-->` from here on", "no closer for <script> from here on"), and a
//     tag that ran to the end of the document switches the rest of the scan to
//     the plain "ends at the next '>'" rule.
// Everything else here (`htmlToText`, `pageOf`, `tagsOnly`, `ldJsonBlocks`) is
// built on that scan and on bounded slices. A pure module: no import.

export interface HtmlVisitor {
  /** A run of text between tags: `html.slice(start, end)`, entities not decoded. */
  text?(start: number, end: number): void;
  /** An opening or closing tag; `name` is lower case, `html.slice(start, end)` is the whole tag. */
  tag?(name: string, closing: boolean, start: number, end: number): void;
  /**
   * Something a reader never sees: a comment or declaration (`name` ''), or a
   * raw-text element from its opening tag through its closing tag (`name` is
   * the element; its content is `html.slice(bodyStart, bodyEnd)`).
   */
  hidden?(name: string, start: number, end: number, bodyStart: number, bodyEnd: number): void;
}

export interface ScanOptions {
  /** Elements whose content is not text (default: script, style). */
  rawText?: ReadonlySet<string>;
  /**
   * A tag, comment or raw-text element that never ends.
   * `drop` (default; what a browser does with a page): the rest of the
   * document is hidden. `text`: the "<" is ordinary text and the scan goes on
   * (a posting that says "a<b" or names "<script>" keeps the rest of its words).
   */
  unterminated?: 'drop' | 'text';
}

const RAW_TEXT_DEFAULT: ReadonlySet<string> = new Set(['script', 'style']);
/** A page's own raw-text and non-content elements: none of their content is the posting's text. */
export const PAGE_RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'title']);

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number): boolean => isLetter(c) || (c >= 48 && c <= 58) || c === 45 || c === 95;
const MAX_TAG_NAME = 40;

const closers = new Map<string, RegExp>();
function closerOf(name: string): RegExp {
  let re = closers.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?![a-z0-9:_-])`, 'gi');
    closers.set(name, re);
  }
  return re;
}

/** Read `html` once, calling the visitor for each piece in document order. See the header for the time bound. */
export function scanHtml(html: string, visitor: HtmlVisitor, options: ScanOptions = {}): void {
  const raw = options.rawText ?? RAW_TEXT_DEFAULT;
  const drop = options.unterminated !== 'text';
  const n = html.length;
  let i = 0;
  let textStart = 0;
  // Searches that found nothing: positions only grow, so the answer stays "nothing".
  let noGt = false;
  let noCommentEnd = false;
  let plainEnds = false;
  const noCloser = new Set<string>();

  const flush = (end: number): void => {
    if (end > textStart) visitor.text?.(textStart, end);
  };
  const nextGt = (from: number): number => {
    if (noGt) return -1;
    const g = html.indexOf('>', from);
    if (g < 0) noGt = true;
    return g;
  };
  /** Index just after the ">" that ends the tag whose name ends at `from`, or -1. */
  const tagEnd = (from: number): number => {
    if (noGt) return -1;
    if (!plainEnds) {
      let afterEq = false;
      let k = from;
      while (k < n) {
        const ch = html.charCodeAt(k);
        if (ch === 62) return k + 1;
        if (ch === 61) {
          afterEq = true;
        } else if ((ch === 34 || ch === 39) && afterEq) {
          const q = html.indexOf(ch === 34 ? '"' : "'", k + 1);
          if (q < 0) break;
          k = q;
          afterEq = false;
        } else if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13 && ch !== 12) {
          afterEq = false;
        }
        k += 1;
      }
      // This tag ran to the end of the document: its quotes are not to be trusted, nor are later ones.
      plainEnds = true;
    }
    const g = nextGt(from);
    return g < 0 ? -1 : g + 1;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const c = html.charCodeAt(lt + 1);

    // A comment, a doctype or a processing instruction.
    if (c === 33 || c === 63) {
      let end = -1;
      if (html.startsWith('<!--', lt)) {
        const close = noCommentEnd ? -1 : html.indexOf('-->', lt + 4);
        if (close < 0) noCommentEnd = true;
        else end = close + 3;
      }
      if (end < 0 && !(drop && html.startsWith('<!--', lt))) {
        const g = nextGt(lt + 2);
        if (g >= 0) end = g + 1;
      }
      if (end < 0) {
        if (!drop) {
          i = lt + 1;
          continue;
        }
        flush(lt);
        visitor.hidden?.('', lt, n, n, n);
        textStart = n;
        i = n;
        break;
      }
      flush(lt);
      visitor.hidden?.('', lt, end, end, end);
      textStart = end;
      i = end;
      continue;
    }

    const closing = c === 47;
    const nameStart = lt + (closing ? 2 : 1);
    let j = nameStart;
    while (j < n && j - nameStart < MAX_TAG_NAME && isNameChar(html.charCodeAt(j))) j += 1;
    if (j === nameStart || !isLetter(html.charCodeAt(nameStart))) {
      // "a < b", "<3": text.
      i = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    const end = tagEnd(j);
    if (end < 0) {
      if (!drop) {
        i = lt + 1;
        continue;
      }
      flush(lt);
      visitor.hidden?.('', lt, n, n, n);
      textStart = n;
      i = n;
      break;
    }

    if (!closing && raw.has(name)) {
      let close = -1;
      if (!noCloser.has(name)) {
        const re = closerOf(name);
        re.lastIndex = end;
        const m = re.exec(html);
        if (m) close = m.index;
        else noCloser.add(name);
      }
      if (close >= 0) {
        const g = nextGt(close);
        const closeEnd = g < 0 ? n : g + 1;
        flush(lt);
        visitor.hidden?.(name, lt, closeEnd, end, close);
        textStart = closeEnd;
        i = closeEnd;
        continue;
      }
      if (drop) {
        flush(lt);
        visitor.hidden?.(name, lt, n, end, n);
        textStart = n;
        i = n;
        break;
      }
      // `text`: an opener that is never closed is an ordinary tag.
    }

    flush(lt);
    visitor.tag?.(name, closing, lt, end);
    textStart = end;
    i = end;
  }
  flush(n);
}

// ── Text ──────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]!;
    if (lower[0] !== '#') return whole;
    const cp = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

function withoutControl(input: string): string {
  // Tab, line feed and carriage return stay; every other C0 control goes.
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '');
}

/** Lines trimmed, every run of blanks one space (so no later pattern meets a long run), at most one empty line in a row. */
export function tidyText(input: string): string {
  return withoutControl(input.normalize('NFC'))
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BREAK_AFTER: ReadonlySet<string> = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'dd', 'dt']);

/**
 * HTML → the text a reader sees, with paragraph and list breaks kept and the
 * page's own punctuation left as written (no width folding: the user confirms
 * this text, and it is their posting's wording).
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  scanHtml(
    html,
    {
      text: (start, end) => out.push(html.slice(start, end)),
      tag: (name, closing) => {
        if (name === 'br') out.push('\n');
        else if (name === 'li' && !closing) out.push('\n• ');
        else out.push(closing && BREAK_AFTER.has(name) ? '\n' : ' ');
      },
      hidden: () => out.push(' '),
    },
    { rawText: PAGE_RAW_TEXT },
  );
  return tidyText(decodeEntities(out.join('')));
}

/**
 * The same markup with nothing a pattern can stumble on: every tag reduced to
 * its bare name (`<li class=…>` → `<li>`), comments and script / style
 * elements gone, a "<" that is not a tag written as `&lt;`. The text a reader
 * sees is unchanged. After this, a helper written with patterns such as
 * /<li[^>]*>/ or /<[^>]+>/ (jobs/normalize `htmlToPlain`) reads the string in
 * linear time, whatever the string was.
 */
export function tagsOnly(html: string): string {
  if (!html.includes('<')) return html;
  const out: string[] = [];
  scanHtml(
    html,
    {
      text: (start, end) => {
        const s = html.slice(start, end);
        out.push(s.includes('<') ? s.replace(/</g, '&lt;') : s);
      },
      // A script or style tag that the scan did not pair (no closer, or a stray closer) is not written at all.
      tag: (name, closing) => out.push(name === 'script' || name === 'style' ? ' ' : closing ? `</${name}>` : `<${name}>`),
      hidden: () => out.push(' '),
    },
    { unterminated: 'text' },
  );
  return out.join('');
}

// ── A page ────────────────────────────────────────────────────────────────

/** A tag longer than this is not read for its attributes (a title, a meta value and a script type are short). */
const MAX_FACT_TAG = 4096;
const MAX_TITLE_CHARS = 2000;
/** Structured-data blocks kept from one page (the extractor parses at most this many). */
export const MAX_LD_JSON_BLOCKS = 20;
const LD_JSON_TYPE = /\btype\s*=\s*["']?\s*application\/ld\+json/i;
const CHROME: ReadonlySet<string> = new Set(['nav', 'header', 'footer', 'aside', 'form']);
const SCOPES = ['main', 'article', 'body'] as const;

const attrRe = (name: string): RegExp => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
const ATTR_PROPERTY = attrRe('property');
const ATTR_NAME = attrRe('name');
const ATTR_CONTENT = attrRe('content');

/** An attribute's value in one tag (a slice of at most MAX_FACT_TAG characters), or null. */
function attr(tag: string, re: RegExp): string | null {
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** The `<meta>` keys the import reads; no other is kept. */
const META_KEYS: ReadonlySet<string> = new Set(['og:title', 'og:site_name', 'og:description', 'description']);

export interface HtmlPage {
  /** The `<title>` text, or null. */
  title: string | null;
  /** The `<meta property=…>` / `<meta name=…>` values the import reads (META_KEYS), by lower-case key; the first of each. */
  meta: Record<string, string>;
  /** The content of each `<script type="application/ld+json">` block, in order (at most MAX_LD_JSON_BLOCKS). */
  ldJson: string[];
  /** The part a reader would call the page: `<main>` or `<article>` when there is one, else `<body>`, without site chrome. */
  mainHtml: string;
}

/** Everything the import reads from a fetched document, in two passes over it. */
export function pageOf(html: string): HtmlPage {
  let title: string | null = null;
  const meta: Record<string, string> = {};
  const ldJson: string[] = [];
  const opened: Partial<Record<(typeof SCOPES)[number], number>> = {};
  const closed: Partial<Record<(typeof SCOPES)[number], number>> = {};

  scanHtml(
    html,
    {
      tag: (name, closing, start, end) => {
        if (name === 'meta' && !closing && end - start <= MAX_FACT_TAG) {
          const tag = html.slice(start, end);
          const key = (attr(tag, ATTR_PROPERTY) ?? attr(tag, ATTR_NAME))?.trim().toLowerCase();
          const content = key && META_KEYS.has(key) && !(key in meta) ? attr(tag, ATTR_CONTENT) : null;
          if (key && content !== null) {
            const value = htmlToText(content);
            if (value) meta[key] = value;
          }
          return;
        }
        if (name !== 'main' && name !== 'article' && name !== 'body') return;
        if (!closing) opened[name] ??= end;
        else if (opened[name] !== undefined) closed[name] = start;
      },
      hidden: (name, start, _end, bodyStart, bodyEnd) => {
        if (name === 'title' && title === null) {
          title = htmlToText(html.slice(bodyStart, Math.min(bodyEnd, bodyStart + MAX_TITLE_CHARS))).replace(/\s+/g, ' ').trim() || null;
        } else if (name === 'script' && ldJson.length < MAX_LD_JSON_BLOCKS && bodyStart - start <= MAX_FACT_TAG && LD_JSON_TYPE.test(html.slice(start, bodyStart))) {
          ldJson.push(html.slice(bodyStart, bodyEnd));
        }
      },
    },
    { rawText: PAGE_RAW_TEXT },
  );

  const scopeName = SCOPES.find((s) => opened[s] !== undefined);
  const from = scopeName ? opened[scopeName]! : 0;
  const to = scopeName ? (closed[scopeName] ?? html.length) : html.length;
  const scope = from === 0 && to === html.length ? html : html.slice(from, to);

  // Second pass, over the scope only: drop what a reader never sees and each whole chrome block.
  const out: string[] = [];
  const pending = new Map<string, number>();
  scanHtml(
    scope,
    {
      text: (start, end) => out.push(scope.slice(start, end)),
      tag: (name, closing, start, end) => {
        if (CHROME.has(name)) {
          const at = pending.get(name);
          if (!closing) {
            if (at === undefined) pending.set(name, out.length);
          } else if (at !== undefined) {
            // The block, from its opening tag to here, is site chrome. Blocks opened inside it go with it.
            out.length = at;
            for (const [k, v] of pending) if (v >= at) pending.delete(k);
            out.push(' ');
            return;
          }
        }
        out.push(scope.slice(start, end));
      },
      hidden: () => out.push(' '),
    },
    { rawText: PAGE_RAW_TEXT },
  );
  return { title, meta, ldJson, mainHtml: out.join('') };
}

/** The content of every `<script type="application/ld+json">` block of a document (at most MAX_LD_JSON_BLOCKS). */
export function ldJsonBlocks(html: string): string[] {
  const out: string[] = [];
  if (!html.includes('<')) return out;
  scanHtml(html, {
    hidden: (name, start, _end, bodyStart, bodyEnd) => {
      if (name === 'script' && out.length < MAX_LD_JSON_BLOCKS && bodyStart - start <= MAX_FACT_TAG && LD_JSON_TYPE.test(html.slice(start, bodyStart))) out.push(html.slice(bodyStart, bodyEnd));
    },
  });
  return out;
}

// ── Markdown links ────────────────────────────────────────────────────────

/**
 * `![alt](target)` → a space, then `[label](target)` → `label`: what
 * `.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')`
 * does, in one pass each (the patterns start again at every "[" and read to
 * the end when no "]" follows).
 */
export function withoutMarkdownLinks(markdown: string): string {
  return replaceLinks(replaceLinks(markdown, true), false);
}

function replaceLinks(s: string, image: boolean): string {
  if (!s.includes('](')) return s;
  const opener = image ? '![' : '[';
  const out: string[] = [];
  let kept = 0;
  let i = 0;
  // The next "]" and ")" at or after a position, each searched for once per stretch.
  let closeAt = -2;
  let parenAt = -2;
  while (i < s.length) {
    const p = s.indexOf(opener, i);
    if (p < 0) break;
    const labelStart = p + opener.length;
    if (closeAt !== -1 && closeAt < labelStart) closeAt = s.indexOf(']', labelStart);
    if (closeAt < 0) break;
    if (s.charCodeAt(closeAt + 1) !== 40) {
      i = p + 1;
      continue;
    }
    if (parenAt !== -1 && parenAt < closeAt + 2) parenAt = s.indexOf(')', closeAt + 2);
    if (parenAt < 0) {
      // No ")" after this label: none after a later one either, unless a later label ends sooner. It cannot: "]" positions only grow.
      break;
    }
    out.push(s.slice(kept, p), image ? ' ' : s.slice(labelStart, closeAt));
    kept = parenAt + 1;
    i = kept;
  }
  if (!kept) return s;
  out.push(s.slice(kept));
  return out.join('');
}

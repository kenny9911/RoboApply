// server/src/platform/llm/contentSafety/normalize.ts
//
// Text normalisation and a multi-term matcher for the keyword list (WP-24).
//
// Two normalised views of the text are matched:
//   - compact: NFKC + lower case with every separator (whitespace,
//     punctuation, symbols, zero-width and control characters) removed, so
//     "赌 博" or "赌*博" still match "赌博". Used for terms that contain any
//     non-ASCII character (Chinese terms).
//   - spaced: NFKC + lower case with each run of separators turned into one
//     space and the text padded with spaces. ASCII terms are matched as whole
//     words here, so "ass" never matches "class".
// Each view keeps a map back to the UTF-16 offset in the original text, used
// to centre the event excerpt on the hit.
//
// Traditional/Simplified folding is not done: the private list should carry
// both spellings when needed (known gap, see the WP-24 handoff).

const SEPARATOR = /[\s\p{P}\p{S}\p{Cc}\p{Cf}\p{Z}]/u;

export interface NormalizedView {
  text: string;
  /** map[i] = UTF-16 offset in the original of normalised char i. */
  map: number[];
}

export interface NormalizedText {
  compact: NormalizedView;
  /** Starts and ends with a space. */
  spaced: NormalizedView;
}

export function normalizeForMatch(input: string): NormalizedText {
  let compact = '';
  const compactMap: number[] = [];
  let spaced = ' ';
  const spacedMap: number[] = [0];
  let offset = 0;
  for (const cp of input) {
    const folded = cp.normalize('NFKC').toLowerCase();
    for (const ch of folded) {
      if (SEPARATOR.test(ch)) {
        if (!spaced.endsWith(' ')) {
          spaced += ' ';
          spacedMap.push(offset);
        }
        continue;
      }
      for (let k = 0; k < ch.length; k++) {
        compact += ch[k];
        compactMap.push(offset);
        spaced += ch[k];
        spacedMap.push(offset);
      }
    }
    offset += cp.length;
  }
  if (!spaced.endsWith(' ')) {
    spaced += ' ';
    spacedMap.push(offset);
  }
  return { compact: { text: compact, map: compactMap }, spaced: { text: spaced, map: spacedMap } };
}

/**
 * How many UTF-16 units `cp` (one code point) contributes to the compact
 * view: 0 for a separator (whitespace, punctuation, symbols, control and
 * format characters, after NFKC folding), usually 1 or 2 otherwise.
 */
export function compactUnits(cp: string): number {
  let n = 0;
  for (const ch of cp.normalize('NFKC').toLowerCase()) if (!SEPARATOR.test(ch)) n += ch.length;
  return n;
}

/** Start index of the code point that ends at UTF-16 index `end` (exclusive). */
export function prevCodePointStart(text: string, end: number): number {
  if (end >= 2) {
    const lo = text.charCodeAt(end - 1);
    const hi = text.charCodeAt(end - 2);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return end - 2;
  }
  return end - 1;
}

/** End index (exclusive) of the code point that starts at UTF-16 index `start`. */
export function nextCodePointEnd(text: string, start: number): number {
  const cp = text.codePointAt(start);
  return start + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

/** True when the normalised term is plain ASCII (matched as whole words). */
export function isAsciiTerm(normalizedSpacedTerm: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]+$/.test(normalizedSpacedTerm);
}

/**
 * The key a term is matched by: the compact form for non-ASCII terms, the
 * space-padded form for ASCII terms. Null when nothing is left after
 * normalisation (a term made only of separators).
 */
export function termKey(term: string): { view: 'compact' | 'spaced'; key: string } | null {
  const n = normalizeForMatch(term);
  const spacedTrim = n.spaced.text.trim();
  if (!spacedTrim) return null;
  if (isAsciiTerm(spacedTrim)) return { view: 'spaced', key: ` ${spacedTrim} ` };
  return n.compact.text ? { view: 'compact', key: n.compact.text } : null;
}

export interface TermHit<T> {
  /** Start offset in the searched string. */
  start: number;
  value: T;
}

interface AcNode<T> {
  next: Map<string, number>;
  fail: number;
  out: Array<{ length: number; value: T }>;
}

/** Aho–Corasick automaton over UTF-16 code units. */
export class TermMatcher<T> {
  private readonly nodes: AcNode<T>[] = [{ next: new Map(), fail: 0, out: [] }];
  readonly size: number;

  constructor(terms: Array<{ key: string; value: T }>) {
    let count = 0;
    for (const { key, value } of terms) {
      if (!key) continue;
      let node = 0;
      for (let i = 0; i < key.length; i++) {
        const ch = key[i];
        let nxt = this.nodes[node].next.get(ch);
        if (nxt === undefined) {
          nxt = this.nodes.length;
          this.nodes.push({ next: new Map(), fail: 0, out: [] });
          this.nodes[node].next.set(ch, nxt);
        }
        node = nxt;
      }
      this.nodes[node].out.push({ length: key.length, value });
      count++;
    }
    this.size = count;
    this.buildFailLinks();
  }

  private buildFailLinks(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    while (queue.length) {
      const u = queue.shift() as number;
      for (const [ch, v] of this.nodes[u].next) {
        let f = this.nodes[u].fail;
        while (f !== 0 && !this.nodes[f].next.has(ch)) f = this.nodes[f].fail;
        const target = this.nodes[f].next.get(ch);
        this.nodes[v].fail = target !== undefined && target !== v ? target : 0;
        this.nodes[v].out.push(...this.nodes[this.nodes[v].fail].out);
        queue.push(v);
      }
    }
  }

  findAll(text: string): TermHit<T>[] {
    const hits: TermHit<T>[] = [];
    let node = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== 0 && !this.nodes[node].next.has(ch)) node = this.nodes[node].fail;
      node = this.nodes[node].next.get(ch) ?? 0;
      for (const o of this.nodes[node].out) hits.push({ start: i - o.length + 1, value: o.value });
    }
    return hits;
  }
}

/** Count of Unicode code points (what users and the 200-character excerpt rule count). */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Split into slices of at most `size` code points (never splits a surrogate pair). */
export function chunkByCodePoints(text: string, size: number): string[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: string[] = [];
  let cur = '';
  let n = 0;
  for (const cp of text) {
    cur += cp;
    n++;
    if (n === size) {
      out.push(cur);
      cur = '';
      n = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The last `count` code points of `text`. */
export function lastCodePoints(text: string, count: number): string {
  if (count <= 0) return '';
  const cps = Array.from(text);
  return cps.slice(Math.max(0, cps.length - count)).join('');
}

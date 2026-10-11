// server/src/features/retrieval/segment.ts
//
// One tokenizer for the lexical leg (MARKET_STRATEGY 2.1 point 3, 2.5 row
// "Lexical tokens"; SM-7, SM-11). Postgres full-text search does not segment
// Chinese (`to_tsvector('simple', '高级软件工程师')` is one token), so the
// application segments, stores space-separated tokens in `RAJob.searchDoc` and
// builds the query from the same tokens. `segmentForSearch` is used for BOTH
// documents and queries: the two sides cannot disagree.
//
// Steps:
//   1. NFKC, lower case; the tech spellings the title normaliser of
//      jobs/taxonomy joins are spelled the same way (c++ → cpp, c# → csharp,
//      .net → dotnet, node.js → nodejs); "asp.net" gives asp and dotnet. A
//      ".net" that ends a domain or an e-mail address stays "net".
//   2. Runs of Han and kana go through `Intl.Segmenter('zh', word)` after the
//      Traditional → Simplified fold (hantHans.ts), so 產品經理 and 产品经理
//      give the same tokens. Everything else is split on non-letters.
//   3. The fallback for words the segmenter does not know:
//      - a segment longer than 4 characters, or not word-like, also yields its
//        character bigrams;
//      - a one-character Han segment is how the segmenter emits an unknown
//        word or an affix. Such pieces in a row also yield their bigrams
//        (鸿|蒙 → 鸿蒙); a lone piece also yields the two characters it forms
//        with the word beside it (工程|师 → 程师, 微|服务 → 微服). One-character
//        function words (的, 和, 与, …) are never glued to a neighbour.
//
// `toTsQuery` is the OR of a text's distinct tokens for
// `to_tsquery('simple', $1)`, ranked by `ts_rank_cd` by the caller. Three
// kinds of token are left out of a QUERY (never out of a document) because an
// OR over them matches nearly every posting and `ts_rank_cd` has no rarity
// weight: function words (QUERY_STOPWORDS), one-character CJK tokens and bare
// numbers. When nothing else is left they are kept, so a query never becomes
// empty by this rule.
//
// Nothing here is ever displayed.

import { foldHantToHans } from './hantHans.js';

/** Most tokens one lexical query carries. */
export const MAX_QUERY_TOKENS = 24;
/** A CJK segment longer than this also yields its character bigrams. */
const LONG_SEGMENT = 4;

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const HAN_CHAR = /^\p{Script=Han}$/u;
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NON_WORD = /[^\p{L}\p{N}]+/u;

let zhSegmenter: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  zhSegmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
  return zhSegmenter;
}

/** NFKC, lower case, tech spellings joined as jobs/taxonomy `normalizeTitle` joins them. */
function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/c\+\+/g, 'cpp')
    .replace(/c#/g, 'csharp')
    // ".NET" the platform, not a domain: never after a letter, a digit or a dot ("careers.acme.net", "a@b.net" keep "net").
    .replace(/\b(asp|ado|vb)\.net\b/g, '$1 dotnet')
    .replace(/(?<![a-z0-9_.@-])\.net\b/g, ' dotnet')
    .replace(/node\.js/g, 'nodejs');
}

function bigrams(chars: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/**
 * One-character words of grammar. A lone character next to one of these is not
 * glued to it: 的|产品 must not yield 的产.
 */
const HAN_FUNCTION_CHARS: ReadonlySet<string> = new Set([...'的和与及或在是有对为等了并以于之其可能要将把被从到给让向跟同而且但也都就还又很更最不无非个些这那您你我他她它们']);

/** Tokens of one run of Han and kana (already folded). */
function segmentCjkRun(run: string): string[] {
  const parts = [...segmenter().segment(run)].map((p) => ({ text: p.segment, chars: [...p.segment], wordLike: p.isWordLike !== false }));
  /** A one-character Han segment that is not a function word: a piece of a word the segmenter does not know. */
  const isPiece = (i: number): boolean => {
    const p = parts[i];
    return !!p && p.chars.length === 1 && HAN_CHAR.test(p.text) && !HAN_FUNCTION_CHARS.has(p.text);
  };
  const isHanWord = (i: number): boolean => {
    const p = parts[i];
    return !!p && p.chars.length > 1 && HAN_CHAR.test(p.chars[0]!) && HAN_CHAR.test(p.chars[p.chars.length - 1]!);
  };
  const out: string[] = [];
  parts.forEach((p, i) => {
    if (!HAS_LETTER_OR_DIGIT.test(p.text)) return;
    out.push(p.text);
    if (p.chars.length > LONG_SEGMENT || !p.wordLike) out.push(...bigrams(p.chars));
    if (!isPiece(i)) return;
    // Pieces in a row are one unknown word: 鸿|蒙 → 鸿蒙.
    if (isPiece(i + 1)) out.push(p.text + parts[i + 1]!.text);
    // A lone piece is an affix of the word beside it: 工程|师 → 程师, 微|服务 → 微服.
    if (!isPiece(i - 1) && !isPiece(i + 1)) {
      if (isHanWord(i - 1)) out.push(parts[i - 1]!.chars[parts[i - 1]!.chars.length - 1]! + p.text);
      if (isHanWord(i + 1)) out.push(p.text + parts[i + 1]!.chars[0]!);
    }
  });
  return out;
}

/**
 * The search tokens of a text, in order, repeats kept (a document's term
 * frequency is real). Used for documents and for queries.
 */
export function segmentForSearch(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text) return [];
  const s = normalizeForSearch(text);
  const out: string[] = [];
  let last = 0;
  const other = (chunk: string) => {
    for (const word of chunk.split(NON_WORD)) if (word) out.push(word);
  };
  for (const m of s.matchAll(CJK_RUN)) {
    const at = m.index ?? 0;
    if (at > last) other(s.slice(last, at));
    out.push(...segmentCjkRun(foldHantToHans(m[0])));
    last = at + m[0].length;
  }
  if (last < s.length) other(s.slice(last));
  return out;
}

/**
 * Words that say nothing about a job in a search query: grammar, and the
 * words every job query carries ("jobs", "role", 工作, 职位). Query side only.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'that', 'the', 'their', 'this', 'to', 'us', 'we', 'with', 'you', 'your', 'who', 'which', 'using', 'use', 'want', 'looking', 'find', 'show',
  'job', 'jobs', 'role', 'roles', 'position', 'positions', 'work', 'working', 'opening', 'openings',
  '工作', '职位', '岗位', '招聘', '相关', '以及', '或者', '一个', '一份', '我们', '我要', '想找', '寻找',
]);

const isSingleCjk = (token: string): boolean => CJK_CHAR.test(token);

/** The distinct tokens a lexical query uses, most `MAX_QUERY_TOKENS`, in order of first appearance. */
export function queryTokens(text: string | null | undefined): string[] {
  const all = [...new Set(segmentForSearch(text))];
  const useful = all.filter((t) => !QUERY_STOPWORDS.has(t) && !isSingleCjk(t) && !/^\p{N}+$/u.test(t));
  return (useful.length ? useful : all).slice(0, MAX_QUERY_TOKENS);
}

/** A token as a quoted `to_tsquery` operand. */
function quoteLexeme(token: string): string {
  return `'${token.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * The lexical query of a text for `to_tsquery('simple', $1)`: the OR of its
 * distinct tokens, each quoted. Null when the text has no token (the caller
 * then runs without the lexical leg; an empty tsquery matches nothing).
 */
export function toTsQuery(text: string | null | undefined): string | null {
  const tokens = queryTokens(text);
  return tokens.length ? tokens.map(quoteLexeme).join(' | ') : null;
}

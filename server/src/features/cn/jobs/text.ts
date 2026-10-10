// server/src/features/cn/jobs/text.ts — posting text helpers for the GoApply
// classifiers (fraud keywords, 届别 tags): plain text of a job, sentence
// splitting that keeps each sentence verbatim, quote windows ≤ MAX_QUOTE_CHARS,
// and a whitespace-insensitive quote check for model output.
//
// Also the mainland text rule of MARKET_STRATEGY §1.5 / JC-7 (five-ministry
// notice): recruiter phone numbers and WeChat ids are removed from a posting's
// text before an indexed row is stored (`stripContactInfo`, called by
// `cnAfterNormalize` at ingest for every market cn row, whatever its source).
// The user applies through the posting's own apply link (D1); we never show a
// recruiter's private contact. A user's own import is their private copy and
// keeps its text as pasted.

import { scanHtml } from '../../jobs/import/contract.js';

/** Quote cap; equal to WP-17's MAX_QUOTE_CHARS (a test keeps them in step). */
export const MAX_QUOTE_CHARS = 240;

export interface Sentence {
  /** Verbatim (trimmed). */
  text: string;
  /** NFKC + lower-case, for matching. Same length mapping is not assumed. */
  norm: string;
}

/** NFKC, lower-case, full-width → half-width (NFKC does that). */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

// ── Markup ───────────────────────────────────────────────────────────────
//
// A posting's markup is somebody else's text and has no length limit here, so
// it is never read with a pattern over the whole of it (a pattern such as
// /<script[\s\S]*?<\/script>/ starts again at every unclosed opener). It is
// read once with the linear scanner of jobs/import (`scanHtml`).

/** Tags that start or end a line of the text a reader sees. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'br', 'hr', 'tr', 'td', 'th', 'table', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'dd', 'dt', 'dl', 'blockquote', 'pre',
]);

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ' };

/** The character(s) an entity stands for, or null when it is not one we read (it then stays as written). */
function entityText(code: string): string | null {
  const lower = code.toLowerCase();
  if (lower[0] !== '#') return NAMED[lower] ?? null;
  const cp = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
  return Number.isFinite(cp) && cp > 0 && cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : null;
}

const isBlank = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0x3000;

interface VisibleText {
  /** What a reader sees: tags gone, entities decoded, a line break at each block tag. */
  text: string;
  /**
   * With `map`: for each UTF-16 unit of `text`, the source range it was read
   * from (`start[i]`, `end[i]`); `start[i]` is -1 for a blank or a line break
   * that stands for a tag.
   */
  start: Int32Array;
  end: Int32Array;
}

/**
 * The text of a piece of markup as a reader sees it. A block tag is a line
 * break; an inline tag is one blank (so "<b>电话</b>138…" reads "电话 138…" and
 * "138<i>0013</i>8000" reads "138 0013 8000"); a comment is nothing; a script
 * or style element is one blank. With `map`, line breaks in the source are
 * blanks (they are in HTML) and every character keeps its source range.
 */
function visibleText(html: string, map: boolean): VisibleText {
  const out: string[] = [];
  const start = map ? new Int32Array(html.length + 1) : new Int32Array(0);
  const end = map ? new Int32Array(html.length + 1) : new Int32Array(0);
  let n = 0;
  let last = 10;
  const put = (s: string, from: number, to: number): void => {
    out.push(s);
    if (map) {
      for (let k = 0; k < s.length; k += 1) {
        start[n + k] = from;
        end[n + k] = to;
      }
    }
    n += s.length;
    last = s.charCodeAt(s.length - 1);
  };
  const plain = (from: number, to: number): void => {
    if (to <= from) return;
    let s = html.slice(from, to);
    if (map) {
      s = s.replace(/[\r\n]/g, ' ');
      for (let k = 0; k < s.length; k += 1) {
        start[n + k] = from + k;
        end[n + k] = from + k + 1;
      }
    }
    out.push(s);
    n += s.length;
    last = s.charCodeAt(s.length - 1);
  };
  const gap = (): void => {
    if (!isBlank(last)) put(' ', -1, -1);
  };
  scanHtml(
    html,
    {
      text: (from, to) => {
        const run = html.slice(from, to);
        if (!run.includes('&')) return plain(from, to);
        let at = 0;
        ENTITY.lastIndex = 0;
        for (let m = ENTITY.exec(run); m; m = ENTITY.exec(run)) {
          const decoded = entityText(m[1]!);
          if (decoded === null) continue;
          plain(from + at, from + m.index);
          put(decoded, from + m.index, from + m.index + m[0].length);
          at = m.index + m[0].length;
        }
        plain(from + at, to);
      },
      tag: (name) => {
        if (BLOCK_TAGS.has(name)) put('\n', -1, -1);
        else gap();
      },
      hidden: (name) => {
        if (name) gap();
      },
    },
    { unterminated: 'text' },
  );
  return { text: out.join(''), start, end };
}

function stripHtml(html: string): string {
  return html.includes('<') || html.includes('&') ? visibleText(html, false).text : html;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Everything the posting says, as plain text: title, then the description and
 * the qualification / responsibility / benefit sections when they are not
 * already inside it.
 *
 * The description is read AS THE POSTING WROTE IT (`description`, tags
 * removed) when the row has it, so the quotes cut from this text (fraud
 * evidence, 届别 / 网申截止 / 校招 tags) carry the posting's own punctuation
 * ("网申截止时间：2026年11月30日", not the width-folded "网申截止时间:2026年…").
 * `descriptionPlain` is the NFKC-folded copy the normalizer parses from; it is
 * the fallback for a row that has no shown text. Matching is unaffected:
 * `splitSentences` matches on each sentence's NFKC form either way, and flag
 * keys (`flagKey`) and `quoteInText` ignore width.
 */
export function postingText(job: Record<string, unknown>): string {
  const description = stripHtml(str(job.description)).trim() || str(job.descriptionPlain);
  const parts = [str(job.title), description];
  for (const key of ['qualifications', 'responsibilities', 'benefits'] as const) {
    const v = str(job[key]).trim();
    if (v && !description.includes(v)) parts.push(v);
  }
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n');
}

/** Split into sentences on Chinese and Latin sentence ends and line breaks, keeping each verbatim. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const raw of text.split(/\n+|(?<=[。！？；!?;])|(?<=[.])\s+/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, norm: normalizeText(t) });
  }
  return out;
}

/** The sentence, or a window of at most MAX_QUOTE_CHARS around `index` (an index into `sentence.norm`). */
export function quoteAround(sentence: Sentence, index: number): string {
  const s = sentence.text;
  if (s.length <= MAX_QUOTE_CHARS) return s;
  // NFKC can change lengths slightly; clamp the window into the verbatim text.
  const start = Math.max(0, Math.min(index - 60, s.length - MAX_QUOTE_CHARS));
  return s.slice(start, start + MAX_QUOTE_CHARS).trim();
}

const squash = (s: string): string => normalizeText(s).replace(/[\s　]+/g, '');

/** True when `quote` appears in `text`, ignoring whitespace, width and case. */
export function quoteInText(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length >= 2 && squash(text).includes(q);
}

/** Company name key for blacklist matching: NFKC, lower-case, no spaces or punctuation, no common legal suffix. */
export function employerKey(name: string): string {
  return normalizeText(name)
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|分公司|公司|co\.?ltd|limited|ltd|inc)$/u, '');
}

// ── Recruiter contact details (MARKET_STRATEGY §1.5, JC-7) ───────────────
//
// Rules of this section:
//   - a detail is matched in the text A READER SEES. For markup that is the
//     visible text (`visibleText`): a label in one tag and its value in the
//     next ("<strong>微信：</strong>hr_zhang01", "Tel:&nbsp;400-…") are one
//     line there, and nothing inside a tag (a path, an attribute) is text;
//   - what is not a contact is left exactly as written: a word after
//     "WeChat:" is a contact only when it looks like an id, a number after an
//     id label (岗位编号, Requisition ID) is not a phone number, and a
//     landline without a label needs its subscriber digits in one run;
//   - every pattern is bounded (no unbounded run of blanks, no pattern that
//     starts again inside a long run of letters), so a posting of any length
//     is read in time proportional to its length.

/** ASCII or full-width digit. */
const D = '[0-9０-９]';
const SEP = '[\\s\\-－—–]';
/** A few blanks, never a line break and never an unbounded run. */
const WS = '[^\\S\\n]{0,6}';
/** Not inside a longer run of digits or Latin letters (an id, a URL slug, an order number). */
const NOT_AFTER = '(?<![0-9０-９A-Za-z])';
const NOT_BEFORE = `(?!${D})`;

/** A mainland mobile number: 1[3-9] + 9 digits, written together or as 3-4-4, with an optional +86 / 0086 / 86 prefix. */
const MOBILE = `(?:(?:[+＋]|00)?86${SEP}?)?[1１][3-9３-９]${D}(?:${SEP}?${D}{4}){2}`;
const AREA_CODE = `(?:[(（]0${D}{2,3}[)）]${SEP}?|0${D}{2,3}${SEP})`;
/** A landline with its area code: 010-12345678, (021) 1234 5678, 0755 1234 5678. Read this freely only after a phone label or a phone word. */
const LANDLINE = `${AREA_CODE}${D}{3,4}${SEP}?${D}{4}`;
/**
 * A landline with no label: the area code in brackets, or 7 to 8 subscriber
 * digits in one run. "010-2026-0001" on its own is as likely a reference
 * number as a phone number, and is left alone.
 */
const LANDLINE_BARE = `(?:[(（]0${D}{2,3}[)）]${SEP}?${D}{3,4}${SEP}?${D}{4}|0${D}{2,3}${SEP}${D}{7,8})`;
/** An extension after a number: "转 801", "分机 12", "ext 12". */
const EXTENSION = `(?:${SEP}{0,2}(?:转|分机|ext\\.?)${SEP}{0,2}${D}{1,6})?`;
/** A service line: 400-123-4567, 800 810 8888. Only removed after a phone label. */
const SERVICE_LINE = `[48４８][0０]{2}${SEP}?${D}{3,4}${SEP}?${D}{3,4}`;
/** Anything phone-shaped. Only removed after a phone label AND a colon ("电话：(86) 21 5555 0000 转 12"). */
const LOOSE_NUMBER = `[+＋(（]?${D}[0-9０-９\\s\\-－—–()（）转]{5,24}${D}`;
/** Latin labels need a word start ("hotel 0755-…" is not a "tel" label). */
const PHONE_LABEL =
  '(?:联系电话|联系手机|咨询电话|招聘电话|招聘热线|客服电话|客服热线|服务热线|热线电话|电话号码|手机号码|手机号|电话|手机|座机|热线|(?<![A-Za-z])(?:telephone|tel|phone|mobile|cell))';
/** "电话号码", "Tel no.", "Phone number": still the label. */
const NUMBER_WORD = `(?:(?:号码?|(?:no|num)\\.?|number|#)${WS})?`;
/** Words that say "ring this": the number after them is a phone number even with its digits in groups. */
const CALL_WORD = `(?<=(?:致电|拨打|来电|电联|(?<![A-Za-z])call)${WS})`;
/**
 * The number before is named as an id, not a phone ("岗位编号：010-20260001",
 * "Requisition ID: 0755-12345678", "Job No. 13912345678").
 */
const NOT_AN_ID = `(?<!(?:编号|工号|单号|序号|代码|代号|(?<![A-Za-z])(?:id|ref\\.?|req\\.?|(?:job|reference|requisition|position|order|ref|req)${WS}(?:no\\.?|number|#)))${WS}[:：#]?${WS})`;

/** An amount, not a number to ring: "13800000000 元", "13800000000万". */
const NOT_AN_AMOUNT = '(?![^\\S\\n]{0,2}(?:元|万|亿|美元|港币|块钱|%|％))';

const ID_CHAR = '[A-Za-z0-9_\\-]';
const ID_END = `(?!${ID_CHAR})`;
/** Not the first word of a Latin phrase ("official accounts", "OAuth2 login"). */
const STANDS_ALONE = '(?![^\\S\\n]{1,3}[A-Za-z])';
/** An id no ordinary word looks like: 6 to 20 characters from a letter, with a digit or an underscore in it. */
const ID_MARKED = `(?=${ID_CHAR}{0,19}[0-9_])[A-Za-z]${ID_CHAR}{5,19}${ID_END}`;
/** The same with an underscore: an id wherever it stands. */
const ID_UNDERSCORED = `(?=${ID_CHAR}{0,19}_)[A-Za-z]${ID_CHAR}{5,19}${ID_END}`;
/** An id made of letters only: taken as one only where it stands alone. */
const ID_PLAIN = `[A-Za-z][A-Za-z\\-]{5,19}${ID_END}${STANDS_ALONE}`;
/** The phone number used as the id, or a numeric id. */
const ID_NUMBER = `(?:${MOBILE}|${D}{6,13})${NOT_BEFORE}`;
/** After an explicit form ("加微信 …", "微信号 …", "微信：…" in Chinese): any of the three. */
const WECHAT_ID = `(?:${ID_MARKED}|${ID_PLAIN}|${ID_NUMBER})`;
/**
 * After a Latin word and only a colon ("WeChat: …"): the next word is a
 * contact only when it looks like an id. An underscore says so by itself; a
 * digit says so when the word stands alone ("WeChat: OAuth2 login" names a
 * protocol); letters alone never do ("WeChat: Moments").
 */
const WECHAT_ID_STRICT = `(?:${ID_UNDERSCORED}|${ID_MARKED}${STANDS_ALONE}|${ID_NUMBER})`;
const WECHAT_CN = '(?:微信|薇信|威信|(?<![A-Za-z])v信)';
const WECHAT_LATIN = '(?<![A-Za-z])(?:vx|wx|wechat|weixin)';
const WECHAT_WORD = `(?:${WECHAT_CN}|${WECHAT_LATIN})`;
const TIED = '(?:[:：]|是|为)';

/**
 * Tried in this order (a detail one pattern took is not read again):
 *   1. a phone label, a colon and anything phone-shaped;
 *   2. a phone label and a mobile, landline or service-line number;
 *   3. 加 / 添加 + a WeChat word (or "V") + the id ("加微信 hr_zhang01");
 *   4. a WeChat word + 号 / ID / 账号 + the id ("微信号 hr_zhang01");
 *   5. "+V:" / "➕vx：" + the id (the colon is required);
 *   6. a WeChat word, a colon and the id: any id after the Chinese word
 *      ("微信：zhangsan"), an id-shaped one after the Latin word
 *      ("VX：hr_zhang01"; "WeChat: official accounts" names a channel);
 *   7. "微信同号" (the phone above is the WeChat id);
 *   8. any bare mobile number, a bare landline (see LANDLINE_BARE), or a
 *      grouped landline after a "ring this" word; never after an id label
 *      and never an amount ("13800000000 元").
 * A WeChat word alone is never enough: "熟悉微信小程序开发" and "微信 SDK"
 * name a skill, not a contact.
 */
const CONTACT_PATTERNS: readonly RegExp[] = [
  new RegExp(`${PHONE_LABEL}${WS}${NUMBER_WORD}[:：]${WS}${NOT_AFTER}(?:${MOBILE}|${LANDLINE}|${SERVICE_LINE}|${LOOSE_NUMBER})${EXTENSION}${NOT_BEFORE}`, 'giu'),
  new RegExp(`${PHONE_LABEL}${WS}${NUMBER_WORD}${NOT_AFTER}(?:${MOBILE}|${LANDLINE}|${SERVICE_LINE})${EXTENSION}${NOT_BEFORE}`, 'giu'),
  new RegExp(`(?:请|可|欢迎)?(?:加|添加)${WS}(?:我的?|hr的?|招聘)?${WS}(?:${WECHAT_WORD}|v)${WS}(?:(?:号码?|id)${WS})?(?:${TIED}${WS})?${NOT_AFTER}${WECHAT_ID}`, 'giu'),
  new RegExp(`${WECHAT_WORD}${WS}(?:号码?|id|账号|帐号)${WS}(?:${TIED}${WS})?${NOT_AFTER}${WECHAT_ID}`, 'giu'),
  new RegExp(`[➕+＋]${WS}(?:${WECHAT_WORD}|v)${WS}[:：]${WS}${NOT_AFTER}${WECHAT_ID}`, 'giu'),
  new RegExp(`(?:${WECHAT_CN}${WS}[:：]${WS}${NOT_AFTER}${WECHAT_ID}|${WECHAT_LATIN}${WS}[:：]${WS}${NOT_AFTER}${WECHAT_ID_STRICT})`, 'giu'),
  new RegExp(`[(（]?${WS}${WECHAT_WORD}${WS}(?:同号|同步|同手机号?|同电话)${WS}[)）]?`, 'giu'),
  new RegExp(`(?:${NOT_AFTER}${NOT_AN_ID}(?:${MOBILE}|${LANDLINE_BARE})${NOT_BEFORE}${NOT_AN_AMOUNT}|${CALL_WORD}${NOT_AFTER}${LANDLINE})${EXTENSION}${NOT_BEFORE}`, 'giu'),
];

export interface ContactStripResult {
  text: string;
  /** How many contact details were removed. */
  removed: number;
}

/**
 * Web links and e-mail addresses are never edited: a number inside one is part
 * of the address, not a phone number. The e-mail half starts only at the start
 * of its run and is bounded, so a long unbroken run (an inline image, a token)
 * is passed over once.
 */
const PROTECTED = /https?:\/\/[^\s<>"'，。；、）)】]+|(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+/g;

/** Stands where a protected token or an already-taken detail was: no pattern reads it or reads across it. */
const TAKEN = '\u0000';

/**
 * The contact details in one line of text, as [start, end) ranges in order,
 * none overlapping. `count` is how many details they are.
 */
function contactRanges(line: string): { ranges: Array<[number, number]>; count: number } {
  const ranges: Array<[number, number]> = [];
  if (line.length < 6) return { ranges, count: 0 };
  const blank = (text: string, spans: Array<[number, number]>): string => {
    const parts: string[] = [];
    let at = 0;
    for (const [from, to] of spans) {
      parts.push(text.slice(at, from), TAKEN.repeat(to - from));
      at = to;
    }
    parts.push(text.slice(at));
    return parts.join('');
  };
  const spansOf = (re: RegExp, text: string): Array<[number, number]> => {
    const spans: Array<[number, number]> = [];
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0].length) {
        re.lastIndex += 1;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
  };
  const kept = spansOf(PROTECTED, line);
  let work = kept.length ? blank(line, kept) : line;
  for (const re of CONTACT_PATTERNS) {
    const spans = spansOf(re, work);
    if (!spans.length) continue;
    ranges.push(...spans);
    work = blank(work, spans);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { ranges, count: ranges.length };
}

function without(line: string, ranges: Array<[number, number]>): string {
  const parts: string[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    parts.push(line.slice(at, from));
    at = to;
  }
  parts.push(line.slice(at));
  return parts.join('');
}

/**
 * What a removal leaves behind in one line of plain text: empty brackets,
 * doubled separators, a separator right after a colon or a full stop, a
 * separator the line now starts or ends with. The line keeps its indentation.
 */
function tidyLine(line: string, original: string): string {
  const indent = /^[ \t]*/.exec(original)?.[0] ?? '';
  const tidy = line
    // Runs of blanks first: no later pattern meets a long one.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[(（][ \t]?[)）]/g, '')
    .replace(/([，,、;；/|])(?:[ \t]?[，,、;；/|])+/g, '$1')
    .replace(/([:：])[ \t]?[，,、;；/|]+[ \t]?/g, '$1')
    .replace(/([。！？!?])[ \t]?[。，,、;；]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]?[，,、;；/|。]+[ \t]?/, '')
    // The separators (and blanks) the line now ends with, read from the start of their run only.
    .replace(/(?<![ \t，,、;；/|:：])[ \t，,、;；/|:：]+$/, '')
    .trim();
  // A line that now holds only a contact label ("联系方式", "Contact") says nothing: drop it.
  return tidy.length <= 40 && LABEL_ONLY.test(tidy) ? '' : indent + tidy;
}

/** A line with nothing but (at most) a contact label and punctuation. */
const LABEL_ONLY = /^[\s•·\-*]*(?:联系方式|联系人|联系我们|联系电话|联系|电话|手机|微信号?|contact(?: us| info(?:rmation)?)?|tel|phone|wechat)?[\s:：，,。.]*$/iu;

/** Plain text: line by line; only a line a detail was taken from is tidied. */
function stripPlain(input: string): ContactStripResult {
  let removed = 0;
  const droppedAt = new Set<number>();
  const lines = input.split('\n').map((line, i) => {
    const found = contactRanges(line);
    if (!found.count) return line;
    removed += found.count;
    const tidy = tidyLine(without(line, found.ranges), line);
    if (!tidy) droppedAt.add(i);
    return tidy;
  });
  if (!removed) return { text: input, removed: 0 };
  // A heading that only introduced the lines just dropped ("联系方式：" above a phone and a WeChat line) goes with them.
  for (const i of [...droppedAt].sort((a, b) => a - b)) {
    let k = i - 1;
    while (k >= 0 && droppedAt.has(k)) k -= 1;
    const head = k >= 0 ? lines[k]!.trim() : '';
    if (head && head.length <= 40 && LABEL_ONLY.test(head)) {
      lines[k] = '';
      droppedAt.add(k);
    }
  }
  const text = lines.join('\n');
  return { text: droppedAt.size ? text.replace(/\n{3,}/g, '\n\n').trim() : text, removed };
}

/** A link that rings or messages the recruiter: `href="tel:…"`, `sms:`, `weixin:`. Run on one tag at a time. */
const CONTACT_HREF = /\shref\s*=\s*(?:"(\s*(?:tel|sms|callto|weixin|wechat):[^"]*)"|'(\s*(?:tel|sms|callto|weixin|wechat):[^']*)'|((?:tel|sms|callto|weixin|wechat):[^\s>]*))/i;
/** Is there such a link anywhere? (Most postings have none: the second read of the markup is skipped.) */
const ANY_CONTACT_HREF = /href\s{0,8}=\s{0,8}["']?\s{0,8}(?:tel|sms|callto|weixin|wechat):/i;

/**
 * Markup: the details are found in the visible text and cut out of the text
 * nodes they came from. The markup itself stays as it is, with one exception:
 * the target of a link that rings or messages the recruiter is emptied.
 */
function stripMarkup(html: string): ContactStripResult {
  const visible = visibleText(html, true);
  const cuts: Array<[number, number]> = [];
  let removed = 0;
  let lineStart = 0;
  const text = visible.text;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    if (lineEnd - lineStart >= 6) {
      const found = contactRanges(text.slice(lineStart, lineEnd));
      removed += found.count;
      for (const [from, to] of found.ranges) {
        for (let k = lineStart + from; k < lineStart + to; k += 1) {
          const a = visible.start[k]!;
          if (a < 0) continue;
          const b = visible.end[k]!;
          const lastCut = cuts[cuts.length - 1];
          if (lastCut && a <= lastCut[1]) lastCut[1] = Math.max(lastCut[1], b);
          else cuts.push([a, b]);
        }
      }
    }
    lineStart = lineEnd + 1;
  }
  if (!ANY_CONTACT_HREF.test(html)) return removed ? { text: without(html, cuts), removed } : { text: html, removed: 0 };
  scanHtml(
    html,
    {
      tag: (name, closing, start, end) => {
        if (closing || (name !== 'a' && name !== 'area')) return;
        const m = CONTACT_HREF.exec(html.slice(start, end));
        if (!m) return;
        // The value alone is cut: `href=""` stays, so the link is still a link that goes nowhere.
        const value = m[1] ?? m[2] ?? m[3] ?? '';
        const valueEnd = start + m.index + m[0].length - (m[3] === undefined ? 1 : 0);
        const valueStart = valueEnd - value.length;
        cuts.push([valueStart, valueEnd]);
        removed += 1;
      },
    },
    { unterminated: 'text' },
  );
  if (!removed) return { text: html, removed: 0 };
  cuts.sort((a, b) => a[0] - b[0]);
  return { text: without(html, cuts), removed };
}

/**
 * Remove recruiter phone numbers and WeChat ids from a posting's text. The
 * rest of the text is left exactly as written: only a line a detail was taken
 * from is tidied (no dangling "（）" or "，，"), and a number that is not
 * phone-shaped (pay such as "13000-18000元", a date, a headcount, a reference
 * number, a number inside a longer token) is never touched. `html: true` reads
 * the details in the visible text and keeps the markup as it is. Idempotent.
 */
export function stripContactInfo(input: string, options: { html?: boolean } = {}): ContactStripResult {
  if (!input) return { text: input ?? '', removed: 0 };
  const once = options.html ? stripMarkup : stripPlain;
  let res = once(input);
  let removed = res.removed;
  // Taking a detail out can put two halves of another side by side ("1380013（微信同号）8000"): read again, a few times at most.
  for (let pass = 0; pass < 3 && res.removed; pass += 1) {
    const next = once(res.text);
    if (!next.removed) break;
    removed += next.removed;
    res = next;
  }
  return { text: res.text, removed };
}

/** A tag somewhere in the text (bounded: an unclosed "<a " is passed over, not read to the end each time). */
const looksLikeHtml = (s: string): boolean => /<\/?[a-z][a-z0-9]*(?:\s[^<>]{0,2000})?\/?>/i.test(s);

/**
 * The text columns of a posting with recruiter contact details removed
 * (`description`, `descriptionPlain`, and the section columns when present).
 * Returns only the columns that changed, and how many details were removed.
 *
 * A column that holds markup is checked again as a reader would see it: if the
 * cleaned markup still shows a detail, the column is stored as its cleaned
 * plain text instead (line breaks kept). The rule is "no stored column shows a
 * recruiter's phone number or WeChat id"; keeping the markup comes second.
 */
export function withoutContactInfo(job: Record<string, unknown>): { changed: Record<string, string>; removed: number } {
  const changed: Record<string, string> = {};
  let removed = 0;
  for (const key of ['description', 'descriptionPlain', 'qualifications', 'responsibilities', 'benefits'] as const) {
    const value = job[key];
    if (typeof value !== 'string' || !value) continue;
    const html = looksLikeHtml(value);
    const res = stripContactInfo(value, { html });
    let text = res.text;
    let count = res.removed;
    if (html) {
      const seen = stripPlain(visibleText(text, false).text);
      if (seen.removed) {
        text = seen.text;
        count += seen.removed;
      }
    }
    if (!count) continue;
    changed[key] = text;
    removed += count;
  }
  return { changed, removed };
}

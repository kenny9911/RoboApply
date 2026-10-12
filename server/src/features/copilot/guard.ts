// server/src/features/copilot/guard.ts — the Assistant's post-pass (ARCH §5.5; WP-50).
//
// Runs on every sentence before it reaches the client (the turn streams
// sentence by sentence through `SentenceBuffer`), and once more over the
// stored reply:
//   1. Submission claims (D1): a sentence that says or implies the product
//      applied, submitted or contacted someone ("I applied", "submitted your
//      application", "已为你投递", …, in the nine UI locales) is replaced with
//      a neutral fact line. Hit kind `submission_claim`.
//   2. Number guard (D3): a sentence holding a number that appears in neither
//      the tool results, the turn's context, nor the user's own text is
//      removed and replaced with "No source found for that number." Hit kind
//      `unsourced_number`. Numbers that label rather than claim are skipped:
//      ordinals and steps ("Step 1", "Top 10", "round 2", 第3轮), versions
//      after a name ("Python 3", "Java 17") and named terms ("401k", "H-1B",
//      "W-2", "24/7"). Money, percentages and k/万 magnitudes stay strict.
//   3. Job links: a `/jobs/<id>` link whose id no tool returned is removed with
//      its sentence. Hit kind `unknown_job_link`.
// Hits are returned so the caller logs `copilot_guard_hit`.

import { allGuardLines, guardLine } from './text.js';

export type GuardHitKind = 'submission_claim' | 'unsourced_number' | 'unknown_job_link';

export interface GuardHit {
  kind: GuardHitKind;
  /** The sentence that was replaced (first 160 chars; logs only). */
  excerpt: string;
  /** The offending number or id, when there is one. */
  token?: string;
}

export interface GuardContext {
  /** Normalized numbers from tool results, context and the user's text (see `numbersIn`). */
  allowedNumbers: ReadonlySet<string>;
  /** Job ids tool results returned this turn (plus the context job and recent cards). */
  allowedJobIds: ReadonlySet<string>;
  locale: string;
}

export interface GuardResult {
  text: string;
  hits: GuardHit[];
}

// ── Submission claims (EN, zh, zh-TW, ja, ko, es, fr, pt, de) ─────────────

const NOT_A_FILTER = String.raw`(?!\s+(?:the|these|those|your|a|an|this|that)?\s*(?:new\s+)?(?:filters?|changes?|sort(?:ing)?|edits?|updates?|settings?|preferences?|search(?:es)?|tips?|suggestions?|fix(?:es)?)\b)`;
/** Words that make "apply/submit … for you" about the search, not an application. */
const SEARCH_WORDS = String.raw`(?:filters?|changes?|sort(?:ing)?|edits?|updates?|settings?|preferences?|search(?:es)?|tips?|suggestions?|fix(?:es)?|feedback|discount|coupon|code)`;
/** Adverbs and fillers between the subject and the verb ("I've gone ahead and applied", "we just quickly sent"). */
const FILLER = String.raw`(?:\s+(?:just|already|also|now|successfully|automatically|quickly|then|gone|went|go|ahead|and|both|actually|finally))*`;
/** A conditional or an instruction before "application submitted" ("once your application is sent, …"). */
const NOT_CONDITIONAL = String.raw`(?<!\b(?:once|after|when|whenever|until|before|if|unless|make sure|ensure|check(?: that)?|confirm(?: that)?|verify(?: that)?)\b[^.!?]{0,40})`;
/** A Chinese condition before "申请已提交" (如果你的申请已提交，…). */
const ZH_NOT_CONDITIONAL = '(?<!(?:如果|若|假如|一旦|等|待|在)[^。！？，,]{0,8})';
const ZH_TW_NOT_CONDITIONAL = '(?<!(?:如果|若|假如|一旦|等|待|在)[^。！？，,]{0,8})';
/** Who the product would act for: 为你/帮您/替你/代您 (zh) and 為你/幫您 (zh-TW). */
const ZH_FOR_YOU = '(?:为你|为您|帮你|帮您|替你|替您|代你|代您)';
const ZH_TW_FOR_YOU = '(?:為你|為您|幫你|幫您|替你|替您|代你|代您)';

export const SUBMISSION_CLAIM_PATTERNS: readonly RegExp[] = [
  // English: "I applied", "I've gone ahead and applied to Acme", "we just submitted"
  new RegExp(String.raw`\b(?:I|we)(?:'ve|’ve|'d|’d| have| had)?${FILLER}\s+(?:applied|submitted|sent)\b` + NOT_A_FILTER, 'i'),
  // "I'll apply to these for you", "we can submit it on your behalf"
  new RegExp(
    String.raw`\b(?:I|we)(?:'ll|’ll| will| can| could| am going to| are going to|'m going to|’m going to)\s+(?:also\s+|now\s+|go ahead and\s+)?(?:apply|submit)\b(?![^.!?]{0,40}\b${SEARCH_WORDS}\b)[^.!?]{0,40}?\b(?:for you|on your behalf)\b`,
    'i',
  ),
  /\b(?:I|we)(?:'ll|’ll| will| can| could)\s+(?:apply|submit)\s+to\s+(?:this|that|the|these|those)\s+(?:job|role|position|jobs|roles|positions)\b/i,
  // "submitted your application", "sent the application"
  /\b(?:submitted|sent)\s+(?:your|the|an?)\s+application\b/i,
  // Agentless: "Application submitted.", "Your application is submitted.", "Applications sent to all 5."
  new RegExp(
    NOT_CONDITIONAL +
      String.raw`\b(?:(?:your|the|an?|all|both)\s+)?applications?\s+(?:(?:is|are|was|were|has been|have been|got|now)\s+)?(?:now\s+|already\s+|successfully\s+|just\s+|been\s+)?(?:submitted|sent|received)(?=\s+(?:to|for)\b|\s*[.!,;:)—-]|\s*$)`,
    'i',
  ),
  /\b(?:I|we)(?:'ve|’ve| have| just| already)*\s+(?:contacted|messaged|emailed|e-mailed|reached out to|introduced you to)\b/i,
  // "applied to all 5 roles for you" (no subject); "you applied … for you" is not a claim
  /(?<!\byou(?:'ve|’ve| have| had)?\s+(?:\w+\s+)?)\bapplied\s+(?:to|for)\b[^.!?;]{0,40}?\b(?:for you|on your behalf)\b/i,
  // Simplified Chinese
  new RegExp(`(?:已|已经)${ZH_FOR_YOU}?(?:投递|提交(?:了)?(?:申请|简历)|申请了|网申|联系了|发送了(?:申请|简历))`),
  // 帮你投了 / 为你申请了 / 替你发过
  new RegExp(`${ZH_FOR_YOU}(?:投递|投|递|申请|网申|提交|发送|发)(?:了|过)`),
  // 已帮你申请 / 已经为您投 (no 了 needed after 已)
  /(?:已|已经)(?:帮|为|替|代)(?:你|您)?(?:申请|投|递|网申|提交|发)/,
  // 简历已发给HR / 申请已提交 / 简历已经投出去
  new RegExp(`${ZH_NOT_CONDITIONAL}(?:简历|申请)(?:已|已经)(?:投|发|提交|递|送出)`),
  // Traditional Chinese
  new RegExp(`(?:已|已經)${ZH_TW_FOR_YOU}?(?:投遞|提交(?:了)?(?:申請|履歷)|申請了|聯絡了|發送了(?:申請|履歷))`),
  new RegExp(`${ZH_TW_FOR_YOU}(?:投遞|投|遞|申請|網申|提交|發送|發|送出)(?:了|過)`),
  /(?:已|已經)(?:幫|為|替|代)(?:你|您)?(?:申請|投|遞|網申|提交|發|送出)/,
  new RegExp(`${ZH_TW_NOT_CONDITIONAL}(?:履歷|簡歷|申請)(?:已|已經)(?:投|發|提交|遞|送出)`),
  // Japanese
  /(?:応募|エントリー)(?:しました|を(?:完了|送信)しました|済みです|を済ませました)/,
  /(?:代わりに|あなたの代わりに).{0,12}(?:応募|送信|連絡)しました/,
  // Korean
  /(?:지원|제출|접수)(?:했습니다|하였습니다|을 완료했습니다|를 완료했습니다|해 드렸습니다|해드렸습니다)/,
  /(?:대신|대신해서)\s?.{0,12}(?:지원|제출|연락)(?:했|하였)/,
  // Spanish
  /\b(?:he|hemos)\s+(?:aplicado|postulado|enviado\s+(?:tu|su|la)\s+(?:solicitud|candidatura|postulación)|contactado)(?![A-Za-zÀ-ÿ])/i,
  /\b(?:tu|su)\s+(?:solicitud|candidatura|postulación)\s+(?:ha sido|fue)\s+enviada(?![A-Za-zÀ-ÿ])/i,
  // French
  /(?:^|[^A-Za-zÀ-ÿ])(?:j'ai|j’ai|nous avons)\s+(?:postulé|envoyé\s+(?:votre|ta|la)\s+candidature|contacté)(?![A-Za-zÀ-ÿ])/i,
  /\b(?:votre|ta)\s+candidature\s+(?:a été|est)\s+envoyée(?![A-Za-zÀ-ÿ])/i,
  // Portuguese
  /\b(?:eu\s+)?(?:me\s+)?candidatei\b/i,
  /\b(?:enviei|enviamos)\s+(?:sua|a|tua)\s+candidatura\b/i,
  /\b(?:sua|tua)\s+candidatura\s+(?:foi)\s+enviada\b/i,
  // German
  /\b(?:ich|wir)\s+(?:habe|haben)\s+(?:mich\s+|uns\s+|sie\s+|dich\s+)?(?:beworben|ihre bewerbung\s+(?:abgeschickt|eingereicht|gesendet)|kontaktiert)\b/i,
  /\b(?:ihre|deine)\s+bewerbung\s+(?:wurde|ist)\s+(?:abgeschickt|eingereicht|gesendet|versendet)\b/i,
];

export function isSubmissionClaim(sentence: string): boolean {
  return SUBMISSION_CLAIM_PATTERNS.some((re) => re.test(sentence));
}

// ── Numbers ───────────────────────────────────────────────────────────────

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  千: 1e3,
  m: 1e6,
  M: 1e6,
  百万: 1e6,
  bn: 1e9,
  B: 1e9,
  万: 1e4,
  萬: 1e4,
  w: 1e4,
  W: 1e4,
  亿: 1e8,
  億: 1e8,
};

const SUFFIX = '百万|bn|[kKmMBwW千万萬亿億]';
const CURRENCY = String.raw`(?:US\$|NT\$|HK\$|[$€£¥₹])`;

/**
 * A number token: optional currency, digits (with thousands separators),
 * optional decimals, optional magnitude suffix. Latin letters on either side
 * make it part of a word or id (`H-1B`, `Q3`, `cm9x2…`, `/jobs/123`) and it is
 * not a number. A hyphen after a letter (`H-1B`) is part of a word; a hyphen
 * after a digit or a space is a range (`90-120k`).
 */
const NUMBER_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.\/\\])(?<![A-Za-z_]-)${CURRENCY}?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(${SUFFIX})?(?![A-Za-z0-9_])`,
  'g',
);

/** The far end of a range (`90-120k`): its suffix applies to the near end too. */
const RANGE_TAIL_RE = new RegExp(String.raw`^\s?(?:-|–|—|~|～|to|至|到)\s?${CURRENCY}?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s?(${SUFFIX})(?![A-Za-z0-9_])`);

function norm(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10_000) / 10_000);
}

/**
 * The value a number token stands for. With a magnitude suffix only the
 * scaled value counts (`$14k` is 14000, never a bare 14 from a count or an
 * id). A suffix inherited from a range end (`90` in `90-120k`) is ambiguous,
 * so both readings count.
 */
function variants(intPart: string, decPart: string | undefined, suffix: string | undefined, inherited?: string): string[] {
  const base = Number(`${intPart.replace(/,/g, '')}${decPart ? `.${decPart}` : ''}`);
  if (!Number.isFinite(base)) return [];
  const mult = suffix ? MULTIPLIERS[suffix] : undefined;
  if (mult) return [norm(base * mult)];
  const inheritedMult = inherited ? MULTIPLIERS[inherited] : undefined;
  return inheritedMult ? [norm(base), norm(base * inheritedMult)] : [norm(base)];
}

/** Strip list markers ("1. ", "2) ") at line starts: they are numbering, not claims. */
function withoutListMarkers(text: string): string {
  return text.replace(/(^|\n)(\s*)\d{1,2}[.)](?=\s)/g, '$1$2');
}

// ── Dates: a date is one token, never three loose numbers ─────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const ISO_DATE_RE = /(?<![\d])(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g;
const MONTH_DAY_RE = new RegExp(String.raw`\b${MONTH_WORD}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, 'gi');
const DAY_MONTH_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}\b\.?(?:,?\s+(\d{4})\b)?`, 'gi');
const CJK_DATE_RE = /(?:(\d{4})\s?年\s?)?(\d{1,2})\s?月\s?(\d{1,2})\s?[日号號]/g;

const dateKey = (y: number, m: number, d: number) => `date:${y}-${m}-${d}`;
const monthDayKey = (m: number, d: number) => `md:${m}-${d}`;

interface DateHit {
  raw: string;
  year: number | null;
  month: number;
  day: number;
}

/** Pull dates out of a text: the hits, and the text with each date blanked. */
function extractDates(text: string): { text: string; dates: DateHit[] } {
  const dates: DateHit[] = [];
  const blank = (s: string) => ' '.repeat(s.length);
  const push = (raw: string, y: string | undefined, m: number, d: string) => {
    const day = Number(d);
    if (m < 1 || m > 12 || day < 1 || day > 31) return false;
    dates.push({ raw: raw.trim(), year: y ? Number(y) : null, month: m, day });
    return true;
  };
  let out = text.replace(ISO_DATE_RE, (raw, y: string, m: string, d: string) => (push(raw, y, Number(m), d) ? blank(raw) : raw));
  out = out.replace(MONTH_DAY_RE, (raw, mon: string, d: string, y: string | undefined) => (push(raw, y, MONTHS[mon.slice(0, 4).toLowerCase().replace(/t$/, '')] ?? MONTHS[mon.slice(0, 3).toLowerCase()] ?? 0, d) ? blank(raw) : raw));
  out = out.replace(DAY_MONTH_RE, (raw, d: string, mon: string, y: string | undefined) => (push(raw, y, MONTHS[mon.slice(0, 3).toLowerCase()] ?? 0, d) ? blank(raw) : raw));
  out = out.replace(CJK_DATE_RE, (raw, y: string | undefined, m: string, d: string) => (push(raw, y, Number(m), d) ? blank(raw) : raw));
  return { text: out, dates };
}

// ── Numbers written in words: Chinese numerals and English number words ──

const CJK_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CJK_BIG: Record<string, number> = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
const CJK_RUN_RE = /[零〇一二两兩俩三四五六七八九十拾百佰千仟万萬亿億]+/g;

/** `三十万` → 300000, `一百零五` → 105, `二〇二六` → 2026; null when it is not a number. */
export function parseCjkNumber(run: string): number | null {
  const chars = [...run];
  if (!chars.length) return null;
  if (chars.every((c) => c in CJK_DIGITS)) {
    if (chars.length === 1) return CJK_DIGITS[chars[0]!]!;
    return Number(chars.map((c) => CJK_DIGITS[c]).join(''));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const c of chars) {
    if (c in CJK_DIGITS) digit = CJK_DIGITS[c]!;
    else if (c in CJK_UNITS) {
      section += (digit || 1) * CJK_UNITS[c]!;
      digit = 0;
    } else if (c in CJK_BIG) {
      section += digit;
      total = (total + (section || 1)) * CJK_BIG[c]!;
      section = 0;
      digit = 0;
    } else return null;
  }
  return total + section + digit;
}

/** What may follow a Chinese numeral for it to be a quantity (pay, people, time, share). */
const CJK_FOLLOW_RE = /^\s?(?:元|块|塊|圆|美元|美金|刀|人|名|位|家|份|次|倍|岁|歲|年|个月|個月|月|周|週|天|小时|小時|%|％|成|多|余|餘|来|來|左右|以上|k|K|w|W)/;
/** A multi-character or unit-bearing numeral may also count things (`二十个职位`). */
const CJK_FOLLOW_COUNT_RE = /^\s?(?:个|個|条|條|项|項|份|篇|间|間)/;
/** A pay or quantity word just before the numeral. */
const CJK_PRE_RE = /(?:约|約|大约|大約|大概|中位|平均|薪|工资|工資|共|超过|超過|不到|将近|將近|多达|多達|仅|僅|只有|高达|高達|低于|低於|高于|高於|至少|最多|达到|達到)[为為是在了]?$/;

function cjkNumeralsToDigits(text: string): string {
  // 百分之三十 → 30%
  let out = text.replace(/百分之([零〇一二两兩三四五六七八九十百]+|\d+(?:\.\d+)?)/g, (raw, n: string) => {
    const v = /\d/.test(n) ? Number(n) : parseCjkNumber(n);
    return v === null || !Number.isFinite(v) ? raw : `${v}%`;
  });
  // 一半的人 / 半数职位 → 50%
  out = out.replace(/(?:一半|半数|半數)(?=的?(?:人|求职者|求職者|申请人|申請人|职位|職位|岗位|崗位|公司|以上))/g, '50%');
  return out.replace(CJK_RUN_RE, (run: string, offset: number, whole: string) => {
    const first = run[0]!;
    // 千万不要, 万一, 百分 …: a run that opens with a magnitude is an idiom, not a number.
    if (first in CJK_BIG || (first in CJK_UNITS && first !== '十' && first !== '拾')) return run;
    // 一 / 两 alone ("一个", "两点") is an article, not a figure.
    if (run.length === 1 && '一两兩俩'.includes(run)) return run;
    const after = whole.slice(offset + run.length);
    if (run === '十' && /^分/.test(after)) return run; // 十分 = "very"
    const before = whole.slice(Math.max(0, offset - 6), offset);
    const multi = run.length > 1 || [...run].some((c) => c in CJK_UNITS || c in CJK_BIG);
    const quantity = CJK_FOLLOW_RE.test(after) || (multi && CJK_FOLLOW_COUNT_RE.test(after)) || CJK_PRE_RE.test(before);
    if (!quantity) return run;
    const v = parseCjkNumber(run);
    return v === null || !Number.isFinite(v) ? run : String(v);
  });
}

const EN_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const EN_WORD = `(?:${[...Object.keys(EN_SMALL), ...Object.keys(EN_SCALE)].join('|')})`;
const EN_NUMBER_RE = new RegExp(
  String.raw`\b(?:an?\s+(?=(?:hundred|thousand|million|billion)\b))?${EN_WORD}(?:(?:\s+and)?[\s-]+${EN_WORD})*\b(\s*(?:percent|per\s+cent)\b)?`,
  'gi',
);

/** `one hundred and forty-five thousand` → 145000. */
export function parseEnglishNumber(phrase: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of phrase.toLowerCase().split(/[\s-]+/)) {
    if (w === 'and' || w === 'a' || w === 'an' || !w) continue;
    if (w in EN_SMALL) {
      current += EN_SMALL[w]!;
      seen = true;
    } else if (w === 'hundred') {
      current = (current || 1) * 100;
      seen = true;
    } else if (w in EN_SCALE) {
      total += (current || 1) * EN_SCALE[w]!;
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

/**
 * English number words become digits only when they read as a figure: a
 * magnitude word (`forty-five thousand`, `a million`) or a percentage
 * (`fifty percent`). "One of the jobs" and "two options" stay words.
 */
function englishNumbersToDigits(text: string): string {
  return text.replace(EN_NUMBER_RE, (raw: string, percent: string | undefined) => {
    const words = percent ? raw.slice(0, raw.length - percent.length) : raw;
    if (!percent && !/\b(?:hundred|thousand|million|billion)\b/i.test(words)) return raw;
    const v = parseEnglishNumber(words);
    if (v === null) return raw;
    return percent ? `${v}%` : String(v);
  });
}

const FULL_WIDTH_DIGIT_RE = /[０-９]/g;

/** Full-width digits, Chinese numerals and English number words → ASCII digits. */
export function normalizeNumerals(text: string): string {
  const ascii = text.replace(FULL_WIDTH_DIGIT_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return englishNumbersToDigits(cjkNumeralsToDigits(ascii));
}

export interface NumberToken {
  raw: string;
  values: string[];
}

/**
 * Terms that hold digits but are names, not figures (US retirement plans,
 * tax forms, visa and work-permit names, "24/7"). Blanked before a sentence
 * the model wrote is scanned. Visa names with a letter-hyphen (H-1B, O-1)
 * are already words to NUMBER_RE.
 */
const NAMED_TERM_RE = /(?<![A-Za-z0-9])(?:401\s?\(?k\)?|403\s?\(?b\)?|457\s?\(?b\)?|529\s+plans?|1099(?:-[A-Z]+)?s?|W-?2s?|W-?4|W-?8BEN|I-?9|24\/7|9-to-5|Form\s+\d{3,4}[A-Z]?)(?![A-Za-z0-9])/gi;

/** A word right before a number that makes it a label or ordinal ("Step 1", "Top 10", "round 2", "#1", 第3轮). */
const LABEL_BEFORE_RE = /(?:(?:^|[^\p{L}])(?:steps?|top|no\.|nr\.|part|phase|round|level|tier|version|ver\.|v|chapter|section|page|question|item|option|stage|day|week|grade|band|series|plan|module|lesson|tip|reason|rule|point)\s?|#\s?|第\s?|步骤\s?|步驟\s?)$/iu;

/** A capitalized name right before a number ("Python 3", "Java 17", "Windows 11", "iOS 18"). */
const NAME_BEFORE_RE = /(?:^|[^\p{L}\p{N}])(\p{L}[\p{L}+#.]*)\s$/u;

/**
 * Capitalized words that open ordinary sentences: a number after one of
 * these is a claim ("About 30 jobs", "Median 145k"), never a version.
 */
const NOT_A_NAME = new Set(
  (
    'about around approximately approx roughly nearly almost over under only just exactly some up down more less fewer below above ' +
    'between within since in by from with at for of to on into than and or but so yes the a an all each every another most many ' +
    'here there these those this that it its they we you i he she expect expected earn earns earning base bonus starting typical typically ' +
    'median mean average avg min max minimum maximum total range ranges pay pays paid salary salaries plus circa est estimated ' +
    'jobs roles posts people applicants candidates companies hiring open openings listed listing listings match matches result results'
  ).split(' '),
);

/** Units that make a number a quantity even after a name ("Google 50 jobs"). */
const UNIT_AFTER_RE = /^\s?(?:%|％|percent\b|per\s?cent\b|pct\b|x\b|×|jobs?\b|posts?\b|postings?\b|roles?\b|positions?\b|openings?\b|people\b|persons?\b|applicants?\b|candidates?\b|companies\b|employees?\b|users?\b|years?\b|yrs?\b|months?\b|weeks?\b|days?\b|hours?\b|hrs?\b|minutes?\b|mins?\b|times\b|matches\b|listings?\b|offers?\b|interviews?\b|credits?\b|dollars?\b|euros?\b|pounds?\b|yuan\b|rmb\b|usd\b|eur\b|gbp\b|cny\b|twd\b|ntd\b|[元块塊人名位家个個条條份次倍岁歲年月天周週])/iu;

const PERCENT_AFTER_RE = /^\s?(?:%|％|percent\b|per\s?cent\b|pct\b)/i;

function isLabelNumber(text: string, digitsAt: number, intPart: string, decPart: string | undefined, after: string): boolean {
  // "Top 10%" is a claim; "Top 10 tips" and "round 2 interview" are labels.
  if (PERCENT_AFTER_RE.test(after)) return false;
  const before = text.slice(Math.max(0, digitsAt - 24), digitsAt);
  if (LABEL_BEFORE_RE.test(before)) return true;
  if (UNIT_AFTER_RE.test(after)) return false;
  const name = NAME_BEFORE_RE.exec(before)?.[1];
  if (!name || !/\p{Lu}/u.test(name) || NOT_A_NAME.has(name.toLowerCase().replace(/\.$/, ''))) return false;
  // A version is short: "3", "17", "3.11", "365"; never a pay figure like 150000.
  return intPart.length <= 3 && !intPart.includes(',') && (decPart === undefined || decPart.length <= 2);
}

function scanNumbers(text: string, options: { skipLabels?: boolean } = {}): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    const after = text.slice(end);
    if (options.skipLabels && !m[3]) {
      const hasCurrency = new RegExp(`^\\s?${CURRENCY}`).test(m[0]);
      const digitsAt = (m.index ?? 0) + m[0].indexOf(m[1]!);
      if (!hasCurrency && isLabelNumber(text, digitsAt, m[1]!, m[2], after)) continue;
    }
    const tail = m[3] ? null : RANGE_TAIL_RE.exec(after);
    const values = variants(m[1]!, m[2], m[3], tail?.[1]);
    if (values.length) out.push({ raw: m[0].trim(), values });
  }
  return out;
}

/** Number claims in a sentence the model wrote (dates count as one token each). */
export function numberClaims(sentence: string): NumberToken[] {
  const { text, dates } = extractDates(withoutListMarkers(sentence).replace(NAMED_TERM_RE, (t) => ' '.repeat(t.length)));
  const out: NumberToken[] = dates.map((d) => ({ raw: d.raw, values: d.year === null ? [monthDayKey(d.month, d.day)] : [dateKey(d.year, d.month, d.day)] }));
  // Labels and names ("Step 1", "Top 10", "Python 3") are not claims; money,
  // percentages and magnitudes always are.
  out.push(...scanNumbers(normalizeNumerals(text), { skipLabels: true }));
  return out;
}

/** Normalized numbers a source text supports (the user's words, context, a tool's string field). */
export function numbersIn(text: string, into: Set<string> = new Set()): Set<string> {
  if (!text) return into;
  const { text: rest, dates } = extractDates(text);
  for (const d of dates) {
    into.add(monthDayKey(d.month, d.day));
    if (d.year !== null) {
      into.add(dateKey(d.year, d.month, d.day));
      into.add(norm(d.year));
    }
  }
  for (const t of scanNumbers(normalizeNumerals(rest))) for (const v of t.values) into.add(v);
  return into;
}

/** Keys whose values are identifiers or links: their digits are never a source. */
const ID_KEY_RE = /^(?:id|ids|url|urls|href|slug|key|cursor|hash|token)$|(?:Id|Ids|ID|Url|URL|Href|Slug|Key|Hash|Token|Cursor)$/;

/**
 * Numbers a tool result (or context object) supports: numeric values, numbers
 * written in its string values, dates as date tokens, and array lengths (so
 * "3 jobs" is sourced by a 3-item list). Id, URL and key fields are skipped.
 */
export function collectSourceNumbers(value: unknown, into: Set<string> = new Set()): Set<string> {
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'number') {
      into.add(norm(v));
      return;
    }
    if (typeof v === 'string') {
      numbersIn(v, into);
      return;
    }
    if (v instanceof Date) {
      numbersIn(v.toISOString(), into);
      return;
    }
    if (Array.isArray(v)) {
      into.add(norm(v.length));
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!ID_KEY_RE.test(k)) walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return into;
}

export function unsourcedNumbers(sentence: string, allowed: ReadonlySet<string>): string[] {
  return numberClaims(sentence)
    .filter((t) => !t.values.some((v) => allowed.has(v)))
    .map((t) => t.raw);
}

// ── Job links ─────────────────────────────────────────────────────────────

const JOB_LINK_RE = /\/(?:jobs|job)\/([A-Za-z0-9_-]{6,64})/g;

export function unknownJobLinks(sentence: string, allowed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(JOB_LINK_RE)) {
    const id = m[1]!;
    if (['added', 'explore', 'report'].includes(id)) continue;
    // `/job/<cuid>-<slug>`: the id is the part before the first dash.
    const head = id.split('-')[0]!;
    if (!allowed.has(id) && !allowed.has(head)) out.push(id);
  }
  return out;
}

// ── Sentences ─────────────────────────────────────────────────────────────

/**
 * Split text into sentences, keeping every character (the trailing
 * whitespace stays with its sentence). Boundaries: a newline, `。！？`, or
 * `. ! ?` followed by whitespace. A `.` between digits is not a boundary.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    let end = -1;
    if (ch === '\n') end = i + 1;
    else if ('。！？'.includes(ch)) end = i + 1;
    else if ('.!?'.includes(ch) && i + 1 < text.length && /\s/.test(text[i + 1]!)) end = i + 1;
    if (end > 0) {
      while (end < text.length && /\s/.test(text[end]!)) end += 1;
      out.push(text.slice(start, end));
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const GUARD_LINES = new Set(allGuardLines());

function excerpt(s: string): string {
  return s.trim().slice(0, 160);
}

/** Keep the sentence's trailing whitespace/newline after a replacement. */
function trailing(sentence: string): string {
  const m = /\s*$/.exec(sentence);
  return m ? m[0] : '';
}

function leading(sentence: string): string {
  const m = /^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)?/.exec(sentence);
  return m ? m[0] : '';
}

/** Guard one sentence. */
export function guardSentence(sentence: string, ctx: GuardContext): GuardResult {
  const body = sentence.trim();
  if (!body || GUARD_LINES.has(body)) return { text: sentence, hits: [] };
  if (isSubmissionClaim(body)) {
    return {
      text: `${leading(sentence)}${guardLine('notSubmitted', ctx.locale)}${trailing(sentence) || ' '}`,
      hits: [{ kind: 'submission_claim', excerpt: excerpt(body) }],
    };
  }
  const links = unknownJobLinks(body, ctx.allowedJobIds);
  if (links.length) {
    return { text: trailing(sentence).includes('\n') ? '\n' : '', hits: [{ kind: 'unknown_job_link', excerpt: excerpt(body), token: links[0] }] };
  }
  const numbers = unsourcedNumbers(body, ctx.allowedNumbers);
  if (numbers.length) {
    return {
      text: `${leading(sentence)}${guardLine('noSource', ctx.locale)}${trailing(sentence) || ' '}`,
      hits: [{ kind: 'unsourced_number', excerpt: excerpt(body), token: numbers[0] }],
    };
  }
  return { text: sentence, hits: [] };
}

/** Guard a whole text, sentence by sentence; consecutive identical replacement lines collapse into one. */
export function guardText(text: string, ctx: GuardContext): GuardResult {
  const hits: GuardHit[] = [];
  let out = '';
  let lastLine: string | null = null;
  for (const s of splitSentences(text)) {
    const r = guardSentence(s, ctx);
    hits.push(...r.hits);
    const line = r.text.trim();
    if (r.hits.length && line && line === lastLine) continue;
    lastLine = r.hits.length ? line : null;
    out += r.text;
  }
  return { text: out, hits };
}

// ── Streaming: release text only in whole, checked sentences ──────────────

/**
 * Buffers streamed text and returns only complete sentences. A `.`/`!`/`?`
 * at the very end is held until the next character shows whether it ends a
 * sentence (`3.` + `5` is a decimal). `flush()` returns what is left.
 */
export class SentenceBuffer {
  private buf = '';

  push(text: string): string {
    this.buf += text;
    let cut = -1;
    for (let i = 0; i < this.buf.length; i += 1) {
      const ch = this.buf[i]!;
      if (ch === '\n' || '。！？'.includes(ch)) cut = i + 1;
      else if ('.!?'.includes(ch) && i + 1 < this.buf.length && /\s/.test(this.buf[i + 1]!)) cut = i + 2;
    }
    if (cut <= 0) return '';
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return ready;
  }

  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  get pending(): string {
    return this.buf;
  }
}

/** Streams guarded text: push raw deltas, receive checked text to emit. */
export class StreamGuard {
  private readonly buffer = new SentenceBuffer();
  private emitted = '';
  readonly hits: GuardHit[] = [];
  private lastLine: string | null = null;

  constructor(private readonly ctx: () => GuardContext) {}

  private run(text: string): string {
    if (!text) return '';
    let out = '';
    for (const s of splitSentences(text)) {
      const r = guardSentence(s, this.ctx());
      this.hits.push(...r.hits);
      const line = r.text.trim();
      if (r.hits.length && line && line === this.lastLine) continue;
      this.lastLine = r.hits.length ? line : null;
      out += r.text;
    }
    this.emitted += out;
    return out;
  }

  push(delta: string): string {
    return this.run(this.buffer.push(delta));
  }

  flush(): string {
    return this.run(this.buffer.flush());
  }

  /** Everything released so far (the guarded reply). */
  get text(): string {
    return this.emitted;
  }
}

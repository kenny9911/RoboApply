// server/src/features/offers/numberGuard.ts — "the AI invents no market data"
// (WP-64 acceptance; CN plan: "The AI explains the trade-offs and invents no
// market data. Any benchmark must cite a source or be absent").
//
// Every number in an AI draft or explanation must be one the model was given:
// the user's own offer figures (and the totals computed from them), the
// posted-range quartiles and N, and the precomputed percent differences.
// Anything else (a "typical" salary, a made-up market percent) fails the
// check and the text is not shown. Pure.
//
// Numbers are read in every form the model could write them (the prompt asks
// for Arabic digits, but the check does not rely on that):
//   - Arabic digits with separators, decimals and units (k / m / 千 / 万 /
//     萬 / w / 百万 / million / thousand), after NFKC normalization so
//     full-width digits (３５０００) read as ASCII;
//   - Chinese numerals (三万五千, 四十万, 一百五, 百分之十五, 二〇二七);
//   - English number words (one hundred forty thousand, twenty percent);
//   - multiples (1.5x, 1.5倍, two times), which must appear in the user's
//     own text to pass;
//   - any other script's digits are refused outright (fail closed).
//
// Tolerated without being on the list: small counts and list markers (≤ 12)
// and calendar years near now written without separators. A value matches an
// allowed one within 2% (so "$120k" matches 121,300 only if within 2%).

export interface AllowedNumbers {
  /** Plain values (money, counts, months, hours). */
  values: number[];
  /** Percent values (entered percentages, precomputed differences). */
  percents: number[];
  /** Multiples written in the user's own text ("1.5倍"); none are computed for the model. */
  multiples?: number[];
}

export interface NumberToken {
  raw: string;
  value: number;
  percent: boolean;
  /** Written with a thousands separator or a unit (so never a bare year/count). */
  scaled: boolean;
  /** A ratio ("1.5x", "两倍", "two times"): never exempt as a small count. */
  multiple?: boolean;
  /** Digits of a script the guard does not read: always unsupported. */
  unreadable?: boolean;
}

const UNIT: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  千: 1e3,
  万: 1e4,
  萬: 1e4,
  w: 1e4,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  百万: 1e6,
  百萬: 1e6,
  亿: 1e8,
  億: 1e8,
};

// ── Arabic digits ─────────────────────────────────────────────────────────
// number (with optional thousands separators and decimals), optional unit,
// optional percent, optional multiple marker.
const TOKEN =
  /(\d{1,3}(?:[,，](?:\d{3}))+|\d+)(?:\.(\d+))?\s*(百万|百萬|million|thousand|mn|千|万|萬|亿|億|[kKmMwW](?![a-zA-Z]))?\s*(%|％|percent\b|个百分点|個百分點)?(\s*(?:[xX×](?![a-zA-Z])|倍|times\b|-?fold\b))?/g;

// ── Chinese numerals ─────────────────────────────────────────────────────
const CJK_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CJK_BIG: Record<string, number> = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
const CJK_CHARS = '零〇一二两兩三四五六七八九十百千万萬亿億';
const CJK_TOKEN = new RegExp(
  `(百分之)?([${CJK_CHARS}]+)(?:[点點]([零〇一二两兩三四五六七八九]+)([百千万萬亿億]*))?(\\s*(?:%|个百分点|個百分點))?(\\s*倍)?`,
  'g',
);

/** The integer a run of Chinese numerals spells ("三万五千" → 35000, "一百五" → 150); null if not one. */
export function parseCjkInteger(run: string): number | null {
  if (!run) return null;
  const chars = [...run];
  let yi = 0; // completed 亿 part
  let wan = 0; // completed 万 part
  let section = 0; // below 万
  let num = 0;
  for (const ch of chars) {
    if (ch in CJK_DIGIT) num = CJK_DIGIT[ch]!;
    else if (ch in CJK_SMALL) {
      section += (num || 1) * CJK_SMALL[ch]!;
      num = 0;
    } else if (ch === '万' || ch === '萬') {
      wan += (section + num) * 1e4;
      section = 0;
      num = 0;
    } else if (ch === '亿' || ch === '億') {
      yi = (yi + wan + section + num) * 1e8;
      wan = 0;
      section = 0;
      num = 0;
    } else return null;
  }
  let tail = num;
  // Spoken shorthand: a digit right after a unit, no 零 ("一百五" = 150, "三万五" = 35,000).
  if (num > 0 && chars.length > 1) {
    const before = chars[chars.length - 2]!;
    if (before === '百' || before === '千') tail = (num * CJK_SMALL[before]!) / 10;
    else if (before in CJK_BIG) tail = (num * CJK_BIG[before]!) / 10;
  }
  return yi + wan + section + tail;
}

// ── English number words ─────────────────────────────────────────────────
const WORD_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

function isNumberWord(w: string): boolean {
  return w in WORD_SMALL || w in WORD_SCALE;
}

function parseWords(words: readonly string[]): number {
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in WORD_SMALL) current += WORD_SMALL[w]!;
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w in WORD_SCALE) {
      total += (current || 1) * WORD_SCALE[w]!;
      current = 0;
    }
  }
  return total + current;
}

interface Located extends NumberToken {
  index: number;
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

function arabicTokens(text: string): { tokens: Located[]; rest: string } {
  const tokens: Located[] = [];
  let rest = text;
  for (const m of text.matchAll(TOKEN)) {
    rest = mask(rest, m.index!, m[0].length);
    const intPart = m[1]!.replace(/[,，]/g, '');
    const value0 = Number(`${intPart}${m[2] ? `.${m[2]}` : ''}`);
    if (!Number.isFinite(value0)) continue;
    const unitRaw = m[3] ?? '';
    const unit = unitRaw ? (UNIT[unitRaw.toLowerCase()] ?? UNIT[unitRaw] ?? 1) : 1;
    const percent = Boolean(m[4]);
    const multiple = !percent && Boolean(m[5]);
    tokens.push({
      index: m.index!,
      raw: m[0].trim(),
      value: percent || multiple ? value0 : value0 * unit,
      percent,
      scaled: /[,，]/.test(m[1]!) || unit !== 1,
      ...(multiple ? { multiple: true } : {}),
    });
  }
  return { tokens, rest };
}

function cjkTokens(text: string): { tokens: Located[]; rest: string } {
  const tokens: Located[] = [];
  let rest = text;
  for (const m of text.matchAll(CJK_TOKEN)) {
    rest = mask(rest, m.index!, m[0].length);
    const percentPrefix = Boolean(m[1]);
    // A run that starts with a unit and no digit is a word, not a number:
    // 千万 ("by all means"), 万一 ("in case"), 百分之百. Drop the leading units.
    let run = m[2]!;
    const lead = /^[百千万萬亿億]+/.exec(run)?.[0] ?? '';
    run = run.slice(lead.length);
    if (!run) continue;
    const percent = percentPrefix || Boolean(m[5]);
    const multiple = !percent && Boolean(m[6]);
    const raw = m[0].slice(m[1] ? m[1].length : 0).trim() || m[0].trim();
    const index = m.index! + (m[1]?.length ?? 0) + lead.length;
    // Digits only: a year is read positionally (二〇二七); shorter runs are
    // separate small numbers ("三四个月" = 3 or 4 months).
    if (/^[零〇一二两兩三四五六七八九]+$/.test(run) && !m[3]) {
      if (run.length >= 4) {
        const value = Number([...run].map((c) => CJK_DIGIT[c]).join(''));
        tokens.push({ index, raw, value, percent, scaled: false, ...(multiple ? { multiple: true } : {}) });
      } else {
        for (const c of run) tokens.push({ index, raw: c, value: CJK_DIGIT[c]!, percent, scaled: false, ...(multiple ? { multiple: true } : {}) });
      }
      continue;
    }
    const int = parseCjkInteger(run);
    if (int === null) continue;
    let value = int;
    let scaled = /[百千万萬亿億]/.test(run);
    if (m[3]) {
      const decimals = Number(`0.${[...m[3]].map((c) => CJK_DIGIT[c]).join('')}`);
      value = int + decimals;
      const tailUnit = m[4] ?? '';
      for (const u of tailUnit) {
        value *= CJK_SMALL[u] ?? CJK_BIG[u] ?? 1;
        scaled = true;
      }
    }
    tokens.push({ index, raw, value, percent, scaled, ...(multiple ? { multiple: true } : {}) });
  }
  return { tokens, rest };
}

function wordTokens(text: string): { tokens: Located[]; rest: string } {
  const tokens: Located[] = [];
  const words = [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({ w: m[0].toLowerCase(), index: m.index!, end: m.index! + m[0].length }));
  let i = 0;
  while (i < words.length) {
    const startsWithA = words[i]!.w === 'a' && i + 1 < words.length && words[i + 1]!.w in WORD_SCALE;
    if (!isNumberWord(words[i]!.w) && !startsWithA) {
      i += 1;
      continue;
    }
    const run: string[] = [];
    let j = startsWithA ? i + 1 : i;
    let end = words[j]!.end;
    while (j < words.length) {
      const w = words[j]!.w;
      if (isNumberWord(w)) {
        run.push(w);
        end = words[j]!.end;
        j += 1;
        continue;
      }
      // "one hundred and twenty": "and" only joins two number words.
      if (w === 'and' && j + 1 < words.length && isNumberWord(words[j + 1]!.w) && run.length) {
        j += 1;
        continue;
      }
      break;
    }
    const next = words[j]?.w;
    const nextAfter = words[j + 1]?.w;
    const percent = next === 'percent' || (next === 'per' && nextAfter === 'cent');
    const multiple = !percent && (next === 'times' || next === 'fold');
    const value = parseWords(run);
    tokens.push({
      index: words[i]!.index,
      raw: text.slice(words[i]!.index, end),
      value,
      percent,
      scaled: run.some((w) => w in WORD_SCALE),
      ...(multiple ? { multiple: true } : {}),
    });
    i = j;
  }
  return { tokens, rest: text };
}

/** Every number in `text`, in reading order. */
export function extractNumbers(text: string): NumberToken[] {
  const normalized = text.normalize('NFKC');
  const a = arabicTokens(normalized);
  const c = cjkTokens(a.rest);
  const w = wordTokens(c.rest);
  const out: Located[] = [...a.tokens, ...c.tokens, ...w.tokens];
  // Digits of any other script (Arabic-Indic, Devanagari …) are not read: fail closed.
  for (const m of c.rest.matchAll(/\p{Nd}+/gu)) {
    if (/^[0-9]+$/.test(m[0])) continue;
    out.push({ index: m.index!, raw: m[0], value: Number.NaN, percent: false, scaled: true, unreadable: true });
  }
  return out.sort((x, y) => x.index - y.index).map(({ index: _index, ...t }) => t);
}

function near(n: number, a: number): boolean {
  return Math.abs(n - a) <= Math.max(1, Math.abs(a) * 0.02);
}

/** Numbers found in the user's own free text (bonus "10% target", 年终 "2–4 个月", "1.5倍"). */
export function numbersInText(texts: ReadonlyArray<string | null | undefined>): AllowedNumbers {
  const values: number[] = [];
  const percents: number[] = [];
  const multiples: number[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const tok of extractNumbers(t)) {
      if (!Number.isFinite(tok.value)) continue;
      (tok.percent ? percents : tok.multiple ? multiples : values).push(tok.value);
    }
  }
  return { values, percents, multiples };
}

export function mergeAllowed(...sets: AllowedNumbers[]): AllowedNumbers {
  return {
    values: sets.flatMap((s) => s.values),
    percents: sets.flatMap((s) => s.percents),
    multiples: sets.flatMap((s) => s.multiples ?? []),
  };
}

export interface GuardResult {
  ok: boolean;
  /** Raw tokens that are not on the list. */
  unsupported: string[];
}

export function checkNumbers(text: string, allowed: AllowedNumbers, now: Date = new Date()): GuardResult {
  const year = now.getUTCFullYear();
  const unsupported: string[] = [];
  for (const tok of extractNumbers(text)) {
    if (tok.unreadable || !Number.isFinite(tok.value)) {
      unsupported.push(tok.raw);
      continue;
    }
    if (tok.percent) {
      if (!allowed.percents.some((p) => Math.abs(Math.abs(tok.value) - Math.abs(p)) <= 1)) unsupported.push(tok.raw);
      continue;
    }
    if (tok.multiple) {
      if (!(allowed.multiples ?? []).some((x) => Math.abs(x - tok.value) < 0.01)) unsupported.push(tok.raw);
      continue;
    }
    if (!tok.scaled && tok.value <= 12) continue;
    if (!tok.scaled && Number.isInteger(tok.value) && tok.value >= year - 2 && tok.value <= year + 3) continue;
    if (allowed.values.some((a) => near(tok.value, a))) continue;
    // A percent the model wrote without the sign ("8 percent" is caught above; "8 points" is not money).
    if (!tok.scaled && allowed.percents.some((p) => Math.abs(Math.abs(p) - tok.value) < 0.5)) continue;
    unsupported.push(tok.raw);
  }
  return { ok: unsupported.length === 0, unsupported };
}

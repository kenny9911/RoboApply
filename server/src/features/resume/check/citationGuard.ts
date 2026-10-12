// server/src/features/resume/check/citationGuard.ts
//
// CitationGuard for resume fixes and the AI pass (WP-22; ruling C12, D3):
//   - a rewrite may only keep numbers that already appear in its source text
//     (or anywhere in the resume); bracketed placeholders like [X] are fine;
//   - a quote the AI pass returns must appear verbatim in the resume.
//
// "Numbers" are Arabic and full-width digits, Chinese numerals with a unit or
// a place value (五人, 三成, 两倍, 百分之三十, 5万), English number words
// (five, twenty-five, two hundred) and multiplier verbs (doubled, tripled,
// halved, 翻倍). Every number is reduced to a value, and a value in the output
// must also be a value of the sources. A bare 一 / "one" is not counted: it is
// far more often an article (一个, 进一步, one of) than a claim.
// Pure.

/** Fold full-width digits onto ASCII so "３０％" and "30%" compare equal. */
export function foldDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

export interface NumberToken {
  /** The text as written, for logs. */
  raw: string;
  /** Equivalent normalized values; one match in the sources is enough. */
  forms: string[];
  /** Integer parts of a dotted run ("2021.09" → 2021, 9); all present also counts. */
  parts?: string[];
}

const norm = (n: number): string => (Number.isFinite(n) ? String(Number(n.toPrecision(12))) : '');

// ── digits ──

const DIGIT_RUN_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)*/g;
const SCALE_AFTER: Array<[RegExp, number]> = [
  [/^\s*亿/, 1e8],
  [/^\s*[万萬wW]/, 1e4],
  [/^\s*千/, 1e3],
  [/^\s*[kK](?![a-zA-Z])/, 1e3],
  [/^\s*(?:M(?![a-zA-Z])|million\b|mn\b)/i, 1e6],
  [/^\s*(?:B(?![a-zA-Z])|billion\b|bn\b)/i, 1e9],
];

function digitTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const raw = m[0];
    const after = text.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 10);
    const forms = new Set<string>();
    let parts: string[] | undefined;
    if (/,/.test(raw)) {
      forms.add(norm(Number(raw.replace(/,/g, ''))));
    } else if (/\.\d+\./.test(raw) || /^\d{4}\.\d{1,2}$/.test(raw)) {
      // Dotted dates / versions ("2021.09", "1.2.3"): the run, plus its parts.
      forms.add(raw);
      parts = raw.split('.').map((p) => norm(Number(p)));
    } else {
      forms.add(norm(Number(raw)));
      if (raw.includes('.')) parts = raw.split('.').map((p) => norm(Number(p)));
    }
    const base = Number(raw.replace(/,/g, ''));
    for (const [re, scale] of SCALE_AFTER) {
      if (re.test(after) && Number.isFinite(base) && !/\.\d+\./.test(raw)) {
        forms.add(norm(base * scale));
        break;
      }
    }
    out.push({ raw, forms: [...forms].filter(Boolean), parts });
  }
  return out;
}

// ── Chinese numerals ──

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG: Record<string, number> = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
const CN_RUN_RE = /[零〇一二两兩三四五六七八九十拾百佰千仟万萬亿億]+/g;
/** Counters / units that make a lone numeral a quantity (五人, 三年, 两倍, 四成). */
const CN_COUNTER_RE = /^[人名位个個次倍成年月周週天日家项項款场場篇门門套条條所级級轮輪期届屆批份台部本种種类類岁歲%％]|^小时|^小時|^分钟|^分鐘|^万|^千|^百/;

/** Value of a Chinese numeral run (一百二十 → 120, 十五 → 15, 三万五千 → 35000). */
export function parseCnNumeral(run: string): number | null {
  if (!run) return null;
  // Digit-by-digit runs without place values (二〇二一 → 2021).
  if (!/[十拾百佰千仟万萬亿億]/.test(run)) {
    let v = 0;
    for (const ch of run) {
      const d = CN_DIGIT[ch];
      if (d === undefined) return null;
      v = v * 10 + d;
    }
    return v;
  }
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const ch of run) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch]!;
    } else if (ch in CN_UNIT) {
      section += (digit ?? 1) * CN_UNIT[ch]!;
      digit = null;
    } else if (ch in CN_BIG) {
      section += digit ?? 0;
      total += (section || 1) * CN_BIG[ch]!;
      section = 0;
      digit = null;
    } else {
      return null;
    }
  }
  return total + section + (digit ?? 0);
}

function cnTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  // 百分之三十 → 30 (percent).
  for (const m of text.matchAll(/百分之([零〇一二两兩三四五六七八九十百]+)/g)) {
    const v = parseCnNumeral(m[1]!);
    if (v !== null) out.push({ raw: m[0], forms: [norm(v)] });
  }
  const masked = text.replace(/百分之[零〇一二两兩三四五六七八九十百]+/g, (s) => ' '.repeat(s.length));
  for (const m of masked.matchAll(CN_RUN_RE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    const before = masked.slice(Math.max(0, at - 1), at);
    const after = masked.slice(at + raw.length, at + raw.length + 3);
    // Ordinals (第三方), 万一 / 千万 idioms, 十分 (= "very") and bare 一 are not quantities.
    if (before === '第') continue;
    if (/^[一]+$/.test(raw)) continue;
    if (/^(?:万一|千万|萬一|千萬)$/.test(raw)) continue;
    if (raw === '十' && /^分/.test(after)) continue;
    // A scale glyph right after Arabic digits (5万) belongs to the digit token.
    if (/^[万萬亿億千百]+$/.test(raw) && /\d\s*$/.test(masked.slice(Math.max(0, at - 3), at))) continue;
    // Without a digit glyph (百度, 万达, 十足) a place glyph needs a counter too.
    const hasDigit = /[零〇一二两兩三四五六七八九]/.test(raw);
    const hasPlace = /[十拾百佰千仟万萬亿億]/.test(raw);
    if (!(hasDigit && hasPlace) && !CN_COUNTER_RE.test(after)) continue;
    const v = parseCnNumeral(raw);
    if (v === null || v === 1) continue;
    const forms = [norm(v)];
    // 三成 = 30 %.
    if (/^成/.test(after)) forms.push(norm(v * 10));
    out.push({ raw, forms });
  }
  for (const m of text.matchAll(/翻(?:了)?(?:一)?(?:倍|番)/g)) out.push({ raw: m[0], forms: ['2'] });
  for (const m of text.matchAll(/减半|減半/g)) out.push({ raw: m[0], forms: ['0.5', '50'] });
  return out;
}

// ── English number words ──

const EN_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const EN_WORD = [...Object.keys(EN_SMALL), ...Object.keys(EN_TENS), ...Object.keys(EN_SCALE)].join('|');
const EN_RUN_RE = new RegExp(`\\b(?:${EN_WORD})(?:(?:[\\s-]+|\\s+and\\s+)(?:${EN_WORD}))*\\b`, 'gi');
const EN_MULTIPLIER: Array<[RegExp, string[]]> = [
  [/\b(?:doubled|doubling)\b/gi, ['2']],
  [/\b(?:tripled|tripling)\b/gi, ['3']],
  [/\b(?:quadrupled|quadrupling)\b/gi, ['4']],
  [/\b(?:halved|halving)\b/gi, ['0.5', '50']],
  [/\bdozens?\b/gi, ['12']],
];

function parseEnNumber(run: string): number | null {
  const words = run.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== 'and');
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in EN_SMALL) current += EN_SMALL[w]!;
    else if (w in EN_TENS) current += EN_TENS[w]!;
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w in EN_SCALE) {
      total += (current || 1) * EN_SCALE[w]!;
      current = 0;
    } else return null;
  }
  return total + current;
}

function enTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(EN_RUN_RE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    // "5 million" is a digit token already.
    if (/^(?:hundred|thousand|million|billion)$/i.test(raw) && /\d\s*$/.test(text.slice(Math.max(0, at - 3), at))) continue;
    const v = parseEnNumber(raw);
    if (v === null || v === 1) continue;
    out.push({ raw, forms: [norm(v)] });
  }
  for (const [re, forms] of EN_MULTIPLIER) for (const m of text.matchAll(re)) out.push({ raw: m[0], forms });
  return out;
}

// ── public API ──

/** Every number in `text` as normalized values, ignoring bracketed placeholders. */
export function numberTokens(text: string): NumberToken[] {
  const stripped = foldDigits(text ?? '').replace(/\[[^\]]*\]/g, ' ');
  return [...digitTokens(stripped), ...cnTokens(stripped), ...enTokens(stripped)];
}

/** The raw number strings in `text` (kept for callers and logs). */
export function numberRuns(text: string): string[] {
  return numberTokens(text).map((t) => t.raw);
}

function sourceValues(sources: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources) {
    for (const t of numberTokens(s)) {
      for (const f of t.forms) set.add(f);
      for (const p of t.parts ?? []) set.add(p);
    }
  }
  return set;
}

/**
 * The numbers in `output` that do not appear in any of `sources`. Years
 * (1950–2099) are allowed only when they appear in a source too, like any
 * other number; there is no free pass. A number written another way in the
 * source still counts as present (五人 ↔ 5, 三成 ↔ 30%, doubled ↔ 2x, 5万 ↔ 50,000).
 */
export function inventedNumbers(output: string, sources: readonly string[]): string[] {
  const values = sourceValues(sources);
  const out: string[] = [];
  for (const t of numberTokens(output)) {
    if (t.forms.some((f) => values.has(f))) continue;
    if (t.parts && t.parts.length > 0 && t.parts.every((p) => values.has(p))) continue;
    out.push(t.raw);
  }
  return out;
}

export function hasInventedNumber(output: string, sources: readonly string[]): boolean {
  return inventedNumbers(output, sources).length > 0;
}

/** Whitespace-normalized verbatim containment (the evidence rule). */
export function quotedIn(quote: string, text: string): boolean {
  const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = normText(quote);
  return q.length > 0 && normText(text).includes(q);
}

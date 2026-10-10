// server/src/features/jobs/normalize/salary.ts
//
// Pay normalization (ARCH §4.4 "Salary", PRODUCT F-SAL-01, TW-03, CN K/月·N薪).
//
//   - Keep the stated min / max / currency / period exactly; never estimate (D3).
//   - Annualize into salaryAnnualMin/Max in the SAME currency: hour × 2080,
//     day × 260, week × 52, month × 12 (or × salaryMonths for CN "N薪"),
//     year × 1. No period stated → no annual figures.
//   - Pay parsed from text sets salarySource = 'posting_text'; structured
//     provider fields set 'provider'.
//   - Taiwan (TW-03): 面議 / 待遇面議 / 依公司規定 means pay is NOT disclosed.
//     The legal floor sentence that comes with it ("經常性薪資達4萬元或以上")
//     is not a figure for this job: no amount is stored and the verbatim text
//     is kept in salaryText. A real figure or range in the same posting is
//     parsed as usual.
//   - Mainland China: "15-25K·14薪" → monthly 15000–25000 CNY, salaryMonths 14;
//     "200-300元/天" → daily; "30-50万/年" → yearly; "面议" → not disclosed.
//   - Text from a job description is read clause by clause. A clause counts
//     only when it names pay (salary, pay range, 薪资, 待遇, 月薪 …), names no
//     bonus / stipend / equity / benefit plan / years of experience / 年终奖 /
//     N个月, carries a figure within a short window of the pay word, and that
//     figure has a currency attached ("$", "USD", "元") or, in Chinese text, a
//     pay unit (K / 千 / 万). It must also give a range or an explicit period.
//     "401k matching", "a $5,000 signing bonus and annual salary review",
//     "3-5 years of experience, paid annually" and 年终奖2-4个月 are not pay.
//   - A single stated bound stays single: "from $150k" has no maximum.
//   - A figure that cannot be pay for its period ("$60,000K-$90,000K an hour"
//     = 60 million dollars an hour, a posting typo) is NOT stored as an
//     amount: the job counts as not listing pay and its words are kept in
//     salaryText (`payPlausible`). Readers apply the same rule to rows stored
//     before it existed (feed cards, job detail, the "Highest pay" sort).
//   - "Competitive pay" / 面議 found in a description keeps only the words
//     that say so (not the rest of the sentence: "Competitive Pay and
//     Benefits, including medical…" is not pay text). `statesAmount` tells a
//     reader whether a pay text carries a figure worth showing as "Pay as
//     stated".

import type { SalaryPeriod, SalarySource } from './types.js';

export interface SalaryResult {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  salarySource: SalarySource | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryMonths: number | null;
  salaryDisclosed: boolean;
  salaryText: string | null;
}

export interface SalaryInput {
  min?: number | string | null;
  max?: number | string | null;
  currency?: string | null;
  period?: string | null;
  /** Pay text as the provider or posting states it. */
  text?: string | null;
  months?: number | null;
  /** Job description (plain text), read only on pay lines. */
  description?: string | null;
  /** ISO country of the job (resolves "$", "¥", "元"). */
  country?: string | null;
  market?: 'intl' | 'cn';
}

export interface ParsedPay {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  months: number | null;
  /** The text says pay is negotiable / per company rules and gives no figure. */
  negotiable: boolean;
  /** The verbatim pay phrase (≤ 80 chars). */
  text: string;
}

const NONE: SalaryResult = {
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  salarySource: null,
  salaryAnnualMin: null,
  salaryAnnualMax: null,
  salaryMonths: null,
  salaryDisclosed: false,
  salaryText: null,
};

const INT_MAX = 2_147_483_647;

// ── Periods ────────────────────────────────────────────────────────────────

const PERIOD_WORDS: Record<string, SalaryPeriod> = {
  year: 'year', yearly: 'year', annual: 'year', annually: 'year', annum: 'year', yr: 'year', y: 'year', pa: 'year',
  month: 'month', monthly: 'month', mo: 'month', mth: 'month',
  week: 'week', weekly: 'week', wk: 'week',
  day: 'day', daily: 'day', diem: 'day',
  hour: 'hour', hourly: 'hour', hr: 'hour', h: 'hour',
};

/** A provider period label ('YEAR', 'per hour', 'MONTHLY', 'hourly') → period. */
export function periodFromLabel(raw: string | null | undefined): SalaryPeriod | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, ' ').trim();
  if (!s) return null;
  for (const w of s.split(/\s+/)) if (PERIOD_WORDS[w]) return PERIOD_WORDS[w];
  return null;
}

const PERIOD_IN_TEXT: [SalaryPeriod, RegExp][] = [
  ['hour', /(?:\/|per |an |a |each )\s*(?:hour|hr|h)\b|\bhourly\b|时薪|時薪|元\s*\/\s*(?:时|時|小时|小時)|\/\s*(?:小时|小時)|每小时|每小時/i],
  ['day', /(?:\/|per |a )\s*(?:day|diem)\b|\bdaily\b|日薪|元\s*\/\s*(?:天|日)|\/\s*(?:天|日)\b|每天|每日/i],
  ['week', /(?:\/|per |a )\s*(?:week|wk)\b|\bweekly\b|周薪|週薪|\/\s*(?:周|週)/i],
  ['month', /(?:\/|per |a )\s*(?:month|mo|mth)\b|\bmonthly\b|月薪|\/\s*月|每月|元\s*\/\s*月|k\s*\/\s*月|·\s*\d{2}\s*薪/i],
  ['year', /(?:\/|per |an |a )\s*(?:year|yr|annum)\b|\b(?:annual(?:ly)?|yearly)\b|\bp\.\s?a\.|年薪|\/\s*年|每年|年收入/i],
];

export function periodFromText(text: string): SalaryPeriod | null {
  const hits = PERIOD_IN_TEXT.filter(([, re]) => re.test(text)).map(([p]) => p);
  // "年薪 ... 月" style mixes: prefer the most specific explicit marker found first in table order.
  return hits[0] ?? null;
}

// ── Currencies ─────────────────────────────────────────────────────────────

const DOLLAR_COUNTRIES: Record<string, string> = { US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', TW: 'TWD', MX: 'MXN' };

/** Currency named in the text, resolving "$", "¥" and "元" with the job's country. */
export function currencyFromText(text: string, country: string | null, market: 'intl' | 'cn' = 'intl'): string | null {
  const s = text.normalize('NFKC');
  const c = country?.toUpperCase() ?? null;
  const rules: [string, RegExp][] = [
    ['TWD', /NT\$|\bNTD\b|\bTWD\b|新台幣|新臺幣|台幣|臺幣/i],
    ['HKD', /HK\$|\bHKD\b|港元|港币|港幣/i],
    ['SGD', /S\$|\bSGD\b/i],
    ['AUD', /A\$|AU\$|\bAUD\b/i],
    ['CAD', /C\$|CA\$|\bCAD\b/i],
    ['BRL', /R\$|\bBRL\b/i],
    ['MXN', /MX\$|\bMXN\b/i],
    ['USD', /US\$|\bUSD\b|美元|美金/i],
    ['CNY', /\bRMB\b|\bCNY\b|人民币|人民幣/i],
    ['JPY', /JP¥|\bJPY\b|円|日元|日圓/i],
    ['GBP', /£|\bGBP\b/i],
    ['EUR', /€|\bEUR\b/i],
    ['INR', /₹|\bINR\b/i],
    ['KRW', /₩|\bKRW\b|원/i],
    ['CHF', /\bCHF\b/i],
  ];
  for (const [code, re] of rules) if (re.test(s)) return code;
  if (/[¥￥]/.test(s)) return c === 'JP' ? 'JPY' : 'CNY';
  if (/\$/.test(s)) return c ? (DOLLAR_COUNTRIES[c] ?? null) : null;
  if (/元|塊/.test(s)) {
    if (c === 'TW') return 'TWD';
    if (c === 'HK') return 'HKD';
    if (c === 'CN' || market === 'cn') return 'CNY';
    return null;
  }
  return null;
}

// ── Amounts ────────────────────────────────────────────────────────────────

export const NEGOTIABLE_RE = /待遇面議|薪資面議|薪资面议|薪酬面议|面議|面议|依公司規定|依公司规定|按公司规定|\bnegotiable\b|\bcompetitive (?:salary|pay|compensation)\b|\bDOE\b|depending on experience|commensurate with experience/i;
/** TW legal floor sentence accompanying 面議 (Employment Services Act Art. 5). */
// The digit lookbehinds keep "104萬以上" / "140,000以上" (real figures) out of the scrub.
export const TW_FLOOR_RE =
  /(?:經常性)?(?:薪資|薪资|月薪)?\s*(?:達|达)?\s*(?:新台幣|NT\$)?\s*(?<![\d.,，〇一二三四五六七八九十百千])(?:4|四)\s*萬(?:元)?\s*(?:或)?以上|(?:經常性)?薪資達\s*(?<![\d.,，])40,?000\s*元?\s*(?:或)?以上/;

const CUR_PREFIX = String.raw`(?:US\$|NT\$|HK\$|S\$|A\$|AU\$|C\$|CA\$|R\$|MX\$|JP¥|USD|TWD|NTD|CNY|RMB|HKD|SGD|GBP|EUR|CAD|AUD|INR|JPY|[$£€¥￥₹₩])`;
const NUM = String.raw`(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const MULT = String.raw`(k|K|千|万|萬|w|W)?`;
const AMOUNT = String.raw`(?:${CUR_PREFIX}\s*)?${NUM}\s*${MULT}`;
const RANGE_RE = new RegExp(String.raw`(?<![\d.])${AMOUNT}\s*(?:元|塊)?\s*(?:-|–|—|~|～|〜|至|到|\bto\b)\s*(?:${CUR_PREFIX}\s*)?${NUM}\s*${MULT}`);
const SINGLE_RE = new RegExp(String.raw`(?<![\d.])${AMOUNT}`);
const CJK_MARKET_CURRENCY: Record<string, string> = { CN: 'CNY', TW: 'TWD', HK: 'HKD', MO: 'MOP' };
const MONTHS_RE = /[·・.\s]\s*(1[2-9]|2[0-4])\s*薪/;

function multiplier(m: string | undefined, cjk: boolean): number | null {
  if (!m) return 1;
  if (m === 'k' || m === 'K' || m === '千') return 1000;
  if (m === '万' || m === '萬') return 10_000;
  if ((m === 'w' || m === 'W') && cjk) return 10_000;
  return null;
}

function toNumber(raw: string): number {
  return Number(raw.replace(/[,，]/g, ''));
}

/** Parse a pay phrase. Null when it states neither a figure nor "negotiable". */
export function parseSalaryText(text: string | null | undefined, opts: { country?: string | null; market?: 'intl' | 'cn' } = {}): ParsedPay | null {
  if (!text) return null;
  const s = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const cjk = /[㐀-鿿]/.test(s);
  const country = opts.country?.toUpperCase() ?? null;
  const market = opts.market ?? 'intl';
  const verbatim = s.slice(0, 80);

  const negotiable = NEGOTIABLE_RE.test(s);
  // TW 面議 + the legal floor sentence: not a figure for this job (TW-03).
  const scrubbed = negotiable ? s.replace(TW_FLOOR_RE, ' ') : s;

  let min: number | null = null;
  let max: number | null = null;
  const range = scrubbed.match(RANGE_RE);
  if (range) {
    const [, a, multA, b, multB] = range;
    const mb = multiplier(multB, cjk);
    const ma = multA ? multiplier(multA, cjk) : mb; // "15-25K": the multiplier applies to both
    if (ma != null && mb != null) {
      min = toNumber(a) * ma;
      max = toNumber(b) * mb;
    }
  } else {
    const single = scrubbed.match(SINGLE_RE);
    if (single) {
      const m = multiplier(single[2], cjk);
      const n = toNumber(single[1]);
      const hasCurrencyOrUnit = new RegExp(CUR_PREFIX).test(single[0]) || m !== 1 || /元|塊|\/|per|hour|year|month|年薪|月薪|时薪|時薪|日薪/i.test(scrubbed);
      if (m != null && hasCurrencyOrUnit && n > 0) {
        const amount = n * m;
        if (/\bup to\b|最高|以下|以内|以內|\bmax(?:imum)?\b/i.test(scrubbed)) max = amount;
        else if (/起|以上|\bfrom\b|\bstarting\b|\bmin(?:imum)?\b|\+/i.test(scrubbed)) min = amount;
        else {
          min = amount;
          max = amount;
        }
      }
    }
  }

  if (min == null && max == null) {
    return negotiable ? { min: null, max: null, currency: null, period: null, months: null, negotiable: true, text: verbatim } : null;
  }
  if (min != null && max != null && min > max) [min, max] = [max, min];

  const monthsMatch = s.match(MONTHS_RE);
  const months = monthsMatch ? Number(monthsMatch[1]) : null;
  let period = periodFromText(s);
  // CN "15-25K·14薪": monthly by definition of the N薪 format.
  if (!period && months != null) period = 'month';
  let currency = currencyFromText(s, country, market);
  // Chinese-language pay text in a Chinese-speaking market without a symbol ("15-25K·14薪", "月薪 4萬~5萬").
  if (!currency && cjk) currency = CJK_MARKET_CURRENCY[country ?? ''] ?? (market === 'cn' ? 'CNY' : null);
  const hasUnit = /[kK千万萬]|[wW](?=\W|$)/.test(range?.[0] ?? scrubbed);
  const hasSymbol = new RegExp(CUR_PREFIX).test(range?.[0] ?? scrubbed);
  // A bare pair of numbers ("2-3") with no currency sign, unit or period is not pay.
  if (!currency && !period && !hasUnit && !hasSymbol) {
    return negotiable ? { min: null, max: null, currency: null, period: null, months: null, negotiable: true, text: verbatim } : null;
  }
  return {
    min,
    max,
    currency,
    period,
    months,
    negotiable: false,
    text: verbatim,
  };
}

// ── Description pay lines ──────────────────────────────────────────────────

const PAY_WORD_RE = /\b(salary|salaries|pay|pay range|pay rate|base pay|compensation|wage|wages|hourly rate|ote|remuneration)\b|薪资|薪資|待遇|月薪|年薪|时薪|時薪|日薪|薪酬|工资|工資|薪水/i;
const CJK_PAY_WORD_RE = /薪资|薪資|待遇|月薪|年薪|时薪|時薪|日薪|薪酬|工资|工資|薪水/;
/** Clauses about something other than base pay. */
const NOT_BASE_PAY_RE =
  /\b(bonus(?:es)?|signing|sign-on|stipends?|equity|stock|rsus?|pto|vacation|allowances?|reimburse\w*|relocation|referral|commissions?|incentives?|benefits? (?:package|plan)|matching)\b|\byears? (?:of )?(?:experience|exp)\b|\d\s*\+?\s*(?:years|yrs)\b|年终奖|年終獎|奖金|獎金|个月|個月|股票|期权|期權|补贴|補貼|津贴|津貼|经验|經驗|年资|年資|试用期|試用期/i;
/** Benefit-plan names that look like amounts ("401k", "401(k)", "403b"). */
const PLAN_TOKEN_RE = /\b(?:401|403|457)\s*\(?[kb]\)?(?=\W|$)/gi;
const CURRENCY_AFTER = String.raw`(?:USD|TWD|NTD|CNY|RMB|HKD|SGD|GBP|EUR|CAD|AUD|INR|JPY|元|塊|块)`;
const MARKED_AMOUNT_RE = new RegExp(String.raw`${CUR_PREFIX}\s*\d|\d[\d,，.]*\s*(?:k|K|千|万|萬|w|W)?\s*${CURRENCY_AFTER}`);
const CJK_UNIT_AMOUNT_RE = /\d\s*(?:k|K|千|万|萬)/;
/** A leading label on a pay line ("Salary:", "Pay range -", "薪资：", "薪資範圍："). */
const PAY_LABEL_RE =
  /^\s*(?:(?:the\s+)?(?:annual\s+|base\s+|hourly\s+|monthly\s+)?(?:salary|pay|compensation|wage|remuneration)(?:\s+(?:range|rate|band))?|薪资|薪資|待遇|月薪|年薪|时薪|時薪|日薪|薪酬|工资|工資|薪水)(?:范围|範圍)?\s*[:：]\s*/i;
/** How far (characters) the figure may sit from the pay word. */
const PAY_WINDOW = 48;

function payClauses(line: string): string[] {
  return line
    .replace(PLAN_TOKEN_RE, ' ')
    .replace(/\bbetween\s+(\S+)\s+and\s+(\S+)/gi, '$1 - $2')
    .split(/,(?!\d{3})|[;，；、]|\s+(?:and|plus|with)\s+|\s[+&]\s/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** A clause that states base pay as a figure with a currency or (in Chinese) a pay unit. */
function isPayClause(clause: string): boolean {
  if (NOT_BASE_PAY_RE.test(clause)) return false;
  const word = clause.match(PAY_WORD_RE);
  if (!word || word.index == null) return false;
  const marked = MARKED_AMOUNT_RE.test(clause) || (CJK_PAY_WORD_RE.test(clause) && CJK_UNIT_AMOUNT_RE.test(clause));
  if (!marked) return false;
  // The figure sits near the pay word (either side: "Salary: $90k" and "$90k base salary").
  const start = Math.max(0, word.index - PAY_WINDOW);
  const end = word.index + word[0].length + PAY_WINDOW;
  return /\d/.test(clause.slice(start, end));
}

/**
 * The words of a description line that say pay is negotiable, with the TW
 * legal-floor sentence when it comes with them ("待遇面議（經常性薪資達4萬元
 * 或以上）"). A verbatim slice of the line, never the whole sentence.
 */
function negotiablePhrase(line: string): string | null {
  const s = line.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const m = s.match(NEGOTIABLE_RE);
  if (!m || m.index == null) return null;
  let start = m.index;
  let end = m.index + m[0].length;
  const floor = s.match(TW_FLOOR_RE);
  if (floor && floor.index != null) {
    start = Math.min(start, floor.index);
    end = Math.max(end, floor.index + floor[0].length);
  }
  // A bracket the floor sentence sits in closes with it.
  if (/^[)）]/.test(s.slice(end))) end += 1;
  return s.slice(start, end).trim().slice(0, 80) || null;
}

/**
 * A description's pay line without its own label: "薪资：18-28K·15薪" →
 * "18-28K·15薪", "Salary: $90k–$110k a year" → "$90k–$110k a year". The UI
 * already labels the row, so the label would be printed twice.
 */
export function withoutPayLabel(text: string): string {
  const stripped = text.replace(PAY_LABEL_RE, '').trim();
  return stripped || text;
}

/** The first pay statement in the description's pay clauses (a range or an explicit period), else null. */
export function payFromDescription(description: string | null | undefined, opts: { country?: string | null; market?: 'intl' | 'cn' } = {}): ParsedPay | null {
  if (!description) return null;
  const lines = description.normalize('NFKC').split(/\n|(?<=[.。;；])\s+/);
  let negotiable: ParsedPay | null = null;
  for (const line of lines) {
    if (!PAY_WORD_RE.test(line)) continue;
    // "待遇面議（經常性薪資達4萬元或以上）": a TW negotiable statement is read on the whole line.
    // Benefit-plan names ("401k") are not figures and must not hide the statement.
    const whole = parseSalaryText(line.replace(PLAN_TOKEN_RE, ' '), opts);
    if (whole?.negotiable) {
      // Keep the words that say it, not the rest of the sentence around them.
      negotiable ??= { ...whole, text: negotiablePhrase(line) ?? whole.text };
      continue;
    }
    for (const clause of payClauses(line)) {
      if (!isPayClause(clause)) continue;
      const parsed = parseSalaryText(clause, opts);
      if (!parsed || parsed.negotiable) continue;
      const isRange = parsed.min != null && parsed.max != null && parsed.min !== parsed.max;
      if (isRange || parsed.period) return { ...parsed, text: withoutPayLabel(parsed.text) };
    }
  }
  return negotiable;
}

// ── Assembly ───────────────────────────────────────────────────────────────

const PERIOD_FACTOR: Record<SalaryPeriod, number> = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

// ── Plausibility ───────────────────────────────────────────────────────────

/**
 * Order of magnitude of one US dollar in each currency. Used ONLY to decide
 * whether a stated figure can be pay at all (never shown, never used to
 * convert an amount). An unlisted currency is treated like the largest
 * common one for the upper limit and skips the lower limit.
 */
const UNITS_PER_USD: Readonly<Record<string, number>> = {
  USD: 1, EUR: 1, GBP: 1, CHF: 1, CAD: 1.4, AUD: 1.5, NZD: 1.7, SGD: 1.3,
  CNY: 7, HKD: 8, MOP: 8, TWD: 32, JPY: 150, KRW: 1400, INR: 85, MYR: 4.5, THB: 35, PHP: 58, IDR: 16_000, VND: 25_000,
  AED: 3.7, SAR: 3.75, QAR: 3.6, ILS: 3.7, TRY: 35, EGP: 50, ZAR: 18, NGN: 1500, KES: 130,
  SEK: 10.5, NOK: 10.5, DKK: 7, PLN: 4, CZK: 23, RON: 4.6, HUF: 360,
  BRL: 5.5, MXN: 18, ARS: 1000, CLP: 950, COP: 4000,
};
/** A year of pay outside this band (in US-dollar magnitude) is not pay: about 25 cents an hour to 10 million a year. */
const PLAUSIBLE_ANNUAL_USD = { min: 500, max: 10_000_000 } as const;
/** A "range" whose top is this many times its bottom mixes two things ("$20 - $65,000"). */
const PLAUSIBLE_RANGE_RATIO = 50;

/**
 * Can these figures be pay for their period? False for "$60,000,000 an hour"
 * or "$15 a year". Unknown period: only an impossible yearly figure fails.
 * Pure; shared by the normalizer and by every reader of stored rows.
 */
export function payPlausible(p: { min: number | null | undefined; max: number | null | undefined; currency: string | null | undefined; period: string | null | undefined; months?: number | null }): boolean {
  const amounts = [p.min, p.max].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (!amounts.length) return true;
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  if (hi / lo > PLAUSIBLE_RANGE_RATIO) return false;
  const code = p.currency?.trim().toUpperCase() ?? '';
  const known = UNITS_PER_USD[code];
  const scale = known ?? 1500;
  const period = p.period && p.period in PERIOD_FACTOR ? (p.period as SalaryPeriod) : null;
  const factor = period === 'month' && p.months && p.months >= 12 && p.months <= 24 ? p.months : period ? PERIOD_FACTOR[period] : 1;
  if ((hi * factor) / scale > PLAUSIBLE_ANNUAL_USD.max) return false;
  if (period && known !== undefined && (lo * factor) / scale < PLAUSIBLE_ANNUAL_USD.min) return false;
  return true;
}

/**
 * Does a pay text carry a figure ("$90k", "4萬元", "18-28K·15薪")? Words alone
 * ("Competitive pay and benefits", 面議) are not something to show as "Pay
 * as stated"; benefit-plan names ("401k") are not figures.
 */
export function statesAmount(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.normalize('NFKC').replace(PLAN_TOKEN_RE, ' ');
  return MARKED_AMOUNT_RE.test(s) || CJK_UNIT_AMOUNT_RE.test(s) || /[一二三四五六七八九十百千两兩]+\s*(?:万|萬|千)?\s*(?:元|塊|块)|[一二三四五六七八九十百两兩]+\s*(?:万|萬)/.test(s);
}

/** Annualize an amount in its own currency (null when the period is unknown). */
export function annualize(amount: number | null, period: SalaryPeriod | null, months?: number | null): number | null {
  if (amount == null || !period) return null;
  const factor = period === 'month' && months && months >= 12 && months <= 24 ? months : PERIOD_FACTOR[period];
  const v = Math.round(amount * factor);
  return v > 0 && v <= INT_MAX ? v : null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n <= INT_MAX ? n : null;
}

function currencyCode(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  if (s === 'RMB') return 'CNY';
  if (s === 'NTD' || s === 'NT$') return 'TWD';
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

function assemble(p: { min: number | null; max: number | null; currency: string | null; period: SalaryPeriod | null; months: number | null }, source: SalarySource, text: string | null): SalaryResult {
  let { min, max } = p;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  // A figure that cannot be pay for its period is a typo in the posting: keep its words, store no amount.
  if (!payPlausible({ min, max, currency: p.currency, period: p.period, months: p.months })) return { ...NONE, salaryText: text };
  const months = p.period === 'month' && p.months && p.months >= 12 && p.months <= 24 ? p.months : null;
  return {
    salaryMin: min != null ? Math.round(min) : null,
    salaryMax: max != null ? Math.round(max) : null,
    salaryCurrency: p.currency,
    salaryPeriod: p.period,
    salarySource: source,
    salaryAnnualMin: annualize(min, p.period, months),
    salaryAnnualMax: annualize(max, p.period, months),
    salaryMonths: months,
    salaryDisclosed: true,
    salaryText: text,
  };
}

function fromParsed(parsed: ParsedPay, source: SalarySource): SalaryResult {
  if (parsed.negotiable) return { ...NONE, salaryText: parsed.text };
  return assemble(parsed, source, parsed.text);
}

/**
 * The full pay rule set: structured provider fields first, then the provider's
 * pay text, then pay lines in the description. Never estimates.
 */
export function normalizeSalary(input: SalaryInput): SalaryResult {
  const opts = { country: input.country ?? null, market: input.market ?? 'intl' };
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.normalize('NFKC').trim() : null;
  const textParsed = text ? parseSalaryText(text, opts) : null;

  const min = num(input.min);
  const max = num(input.max);
  if (min != null || max != null) {
    const period = periodFromLabel(input.period) ?? textParsed?.period ?? null;
    const months = input.months ?? textParsed?.months ?? null;
    // No provider currency: take the posting's own pay line, but only when it states the same figures.
    let currency = currencyCode(input.currency) ?? textParsed?.currency ?? null;
    if (!currency) {
      const desc = payFromDescription(input.description, opts);
      const same = (a: number | null, b: number | null) => a == null || b == null || Math.round(a) === Math.round(b);
      if (desc && !desc.negotiable && same(desc.min, min) && same(desc.max, max)) currency = desc.currency;
    }
    // A single stated bound stays single ("from $150k" has no maximum; D3).
    return assemble(
      {
        min,
        max,
        currency,
        period,
        months,
      },
      'provider',
      text ? text.slice(0, 80) : null,
    );
  }
  if (textParsed) return fromParsed(textParsed, 'posting_text');
  const fromDesc = payFromDescription(input.description, opts);
  if (fromDesc) return fromParsed(fromDesc, 'posting_text');
  return { ...NONE };
}

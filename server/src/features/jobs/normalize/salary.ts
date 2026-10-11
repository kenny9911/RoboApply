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
//   - Taiwan (TW-03, JT-1): 面議 / 待遇面議 / 依公司規定 and the open-data
//     wording 依學經歷、證照核薪 (台灣就業通's own words for "no figure") mean
//     pay is NOT disclosed. The Employment Services Act Art. 5 clause that
//     comes with them ("經常性薪資達4萬元或以上") restates the statutory
//     threshold; it is not a figure for this job: no amount is stored and the
//     verbatim text is kept in salaryText. The clause is recognised at any
//     threshold (the ministry has announced a higher one). Which words are
//     the clause is decided in one place (`floorClauses` / `isFloorClause`):
//       · with the statute's own term (經常性薪資達4萬元以上) it is the clause
//         wherever it stands, in any market, with or without 面議 beside it,
//         on its own line of a description too: it is itself "pay not listed";
//       · with a Taiwan-dollar marker (月薪 NT$40,000 以上) it is the clause
//         next to "pay not listed" wording, in any market;
//       · bare (月薪5萬以上) it is the clause next to such wording only for a
//         job in Taiwan, or an international row whose country is unknown.
//         "月薪 5萬以上" on its own is a stated minimum, and so is a mainland
//         or Hong Kong posting's "面议，月薪5万以上";
//       · an amount in another currency or for another period (HK$40,000,
//         年薪 USD 60,000) is never the clause.
//     A real figure or range in the same posting is parsed as usual.
//   - Mainland China: "15-25K·14薪" → monthly 15000–25000 CNY, salaryMonths 14;
//     "200-300元/天" → daily; "30-50万/年" → yearly; "面议" → not disclosed.
//     A K / 万 figure with no period is a month's pay by the market's
//     convention ("1.5-2.5万" → 15,000–25,000 CNY a month) while it stays under
//     100,000; a larger one ("30-50万") keeps no period. A bare number with no
//     unit, currency or period ("15000-25000") is not pay we can read: it is
//     never filterable. No pay text means no pay (never 面议 unless the posting
//     says so).
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
//     stated". The two short Taiwan forms count in a description only where
//     the line is about pay: bare 核薪 on a labelled pay line ("薪資：核薪";
//     "負責薪資核算、核薪" is a payroll duty), bare 依學經歷 when its own
//     clause names pay. A duties line never becomes pay text (D3).

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

/**
 * 核薪 ("pay is set by …") as wording of its own. Not inside 核薪方式 (a field
 * label), 核薪作業 / 核薪人員 (payroll work), or 審核薪資 / 考核薪酬 / 審核薪水
 * (reviewing pay): those say nothing about this job's pay.
 */
const HE_XIN = '(?<![審审考稽查複复覆])核薪(?!方式|資|资|酬|水|作業|作业|人員|人员)';

/** 台灣就業通's phrase in full: 依學經歷、證照核薪 (with or without the comma and 證照). */
const BY_EDUCATION_PAY = `依學經歷[、,，]?\\s*(?:證照)?\\s*${HE_XIN}|依学经历[、,，]?\\s*(?:证照)?\\s*${HE_XIN}`;

/**
 * The Chinese "pay not listed" wording that says so wherever it stands in a
 * sentence: everything in `CJK_NEGOTIABLE_SOURCE` except its two short forms,
 * bare 依學經歷 and bare 核薪. In running text those are also about other
 * things ("依學經歷分派職務", "負責薪資核算、核薪"); see `saysPayNotListed`.
 */
const CJK_NEGOTIABLE_FIRM =
  '待遇面議|薪資面議|薪资面议|薪酬面议|面議|面议' +
  '|依公司規定|依公司规定|按公司規定|按公司规定' +
  `|${BY_EDUCATION_PAY}`;

/**
 * Chinese wording for "pay is not stated as a figure" (Taiwan and mainland
 * forms), as a regular-expression source. The pay parser below builds on it;
 * the Taiwan card text (jobs/sources/atsPublic/hooks.ts `TW_NEGOTIABLE_SOURCE`)
 * holds the same list, and atsPublic.test.ts fails when the two differ.
 * Longest alternatives first, so a match is the whole phrase.
 *   面議 family           the posting says pay is negotiable;
 *   依公司規定 family     pay follows the company's rules;
 *   依學經歷、證照核薪    台灣就業通's open-data wording when a row carries no
 *                         figure (pay set by education, experience and
 *                         certificates), with 依學經歷 and 核薪 on their own.
 *                         Not 核薪 inside other words (see HE_XIN). The two
 *                         short forms count in a pay field; in a job
 *                         description they count only where the line is
 *                         about pay (see `saysPayNotListed`).
 */
export const CJK_NEGOTIABLE_SOURCE = `${CJK_NEGOTIABLE_FIRM}|依學經歷|依学经历|${HE_XIN}`;

const NEGOTIABLE_EN = String.raw`\bnegotiable\b|\bcompetitive (?:salary|pay|compensation)\b|\bDOE\b|depending on experience|commensurate with experience`;
export const NEGOTIABLE_RE = new RegExp(`${CJK_NEGOTIABLE_SOURCE}|${NEGOTIABLE_EN}`, 'i');
/** The same without the two short forms: wording that says "pay not listed" anywhere in a description. */
const NEGOTIABLE_FIRM_RE = new RegExp(`${CJK_NEGOTIABLE_FIRM}|${NEGOTIABLE_EN}`, 'i');

/** Not the top of a stated range ("4萬~5萬以上", "3萬至5萬以上"): that is a figure. */
const TW_FLOOR_NOT_RANGE_TOP = String.raw`(?<![\d０-９萬万元kK]\s*[-–—~～〜至到]\s*)`;

/** The statute's own term for the wage the threshold is about (經常性薪資, "regular wage"). */
export const TW_FLOOR_STATUTE_SOURCE = '經常性|经常性';
/** A Taiwan-dollar marker in front of the amount. */
export const TW_FLOOR_TWD_SOURCE = String.raw`新台幣|新臺幣|新台币|台幣|臺幣|台币|NT\$|NTD|TWD`;

/**
 * The Employment Services Act Art. 5 clause a "pay not listed" posting repeats
 * ("經常性薪資達4萬元或以上", "每月經常性薪資達4萬元以上", "月薪 NT$50,000 以上"),
 * as a regular-expression source: the SHAPE of the clause. Whether a match is
 * the clause for a given job is `isFloorClause` below. The pay parser scrubs
 * it before reading figures and the Taiwan card text removes it (the same
 * pattern in jobs/sources/atsPublic/hooks.ts, kept in step by
 * atsPublic.test.ts).
 *
 * Threshold-agnostic: the statutory threshold is a round amount of ten
 * thousands (the ministry has announced a higher one than today's; not
 * passed), so any of 4萬 to 9萬 is recognised and no amount is hard-coded.
 * Written for text before or after NFKC (full-width digits, commas and
 * brackets). Guards:
 *   - digit look-behinds keep "104萬以上" / "140,000以上" / "4.5萬以上" (real
 *     figures) out of it;
 *   - the top of a stated range ("4萬~5萬以上", "3萬至5萬以上") is a figure.
 * No capturing group (callers read match[0] and the match offset).
 */
export const TW_FLOOR_CLAUSE_SOURCE =
  String.raw`(?:每月)?(?:${TW_FLOOR_STATUTE_SOURCE})?(?:薪資|薪资|月薪)?\s*(?:達到|达到|達|达|為|为|[:：])?\s*(?:${TW_FLOOR_TWD_SOURCE})?\s*` +
  String.raw`(?:${TW_FLOOR_NOT_RANGE_TOP}(?<![\d０-９.,，〇一二三四五六七八九十百千])[4-9４-９四五六七八九]\s*[萬万]` +
  String.raw`|${TW_FLOOR_NOT_RANGE_TOP}(?<![\d０-９.,，])[4-9４-９][0０][,，]?[0０]{3})` +
  String.raw`\s*元?\s*(?:[(（]含[)）])?\s*(?:或)?\s*以上`;
/** The shape of the statutory-threshold clause (first match; see `floorClauses` for the rule). */
export const TW_FLOOR_RE = new RegExp(TW_FLOOR_CLAUSE_SOURCE);

/**
 * Text that ends by naming another currency or another pay period: an amount
 * that follows it ("HK$40,000 以上", "年薪 USD 60,000 以上", "時薪 …") is not
 * the clause, which is about a month's regular wage in Taiwan dollars. Tested
 * on the text in front of a clause-shaped match, case-insensitively.
 */
export const TW_FLOOR_OTHER_PAY_BEFORE_SOURCE =
  String.raw`(?:US\$|HK\$|S\$|A\$|AU\$|C\$|CA\$|R\$|MX\$|JP¥|USD|HKD|SGD|AUD|CAD|CNY|RMB|JPY|GBP|EUR|INR|KRW|CHF|MOP|MYR|[¥￥£€₹₩]` +
  String.raw`|美元|美金|港幣|港币|港元|澳門幣|澳门币|人民幣|人民币|日圓|日元|歐元|欧元|英鎊|英镑|新加坡幣|新加坡币` +
  String.raw`|年薪|年收入|年收|時薪|时薪|日薪|週薪|周薪)\s*(?:約|约|為|为|達到|达到|達|达|[:：])?\s*$`;

const TW_FLOOR_ALL_RE = new RegExp(TW_FLOOR_CLAUSE_SOURCE, 'g');
const TW_FLOOR_STATUTE_RE = new RegExp(TW_FLOOR_STATUTE_SOURCE);
const TW_FLOOR_TWD_RE = new RegExp(TW_FLOOR_TWD_SOURCE);
const TW_FLOOR_OTHER_PAY_BEFORE_RE = new RegExp(TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, 'i');

/**
 * How a clause-shaped match names its amount:
 *   statute  with the statute's own term (經常性薪資達4萬元以上);
 *   twd      with a Taiwan-dollar marker (月薪 NT$40,000 以上);
 *   bare     neither (月薪5萬以上, 4萬元以上).
 */
type FloorClauseKind = 'statute' | 'twd' | 'bare';
interface FloorClauseMatch {
  index: number;
  text: string;
  kind: FloorClauseKind;
}

/** Where a job is, and whether its pay wording says "not listed". */
interface FloorClauseWhere {
  country?: string | null;
  market?: 'intl' | 'cn';
  negotiable: boolean;
}

/** Every clause-shaped match in the text, minus amounts in another currency or for another period. */
function floorClauses(s: string): FloorClauseMatch[] {
  const out: FloorClauseMatch[] = [];
  for (const m of s.matchAll(TW_FLOOR_ALL_RE)) {
    const index = m.index ?? 0;
    if (TW_FLOOR_OTHER_PAY_BEFORE_RE.test(s.slice(0, index))) continue;
    const kind: FloorClauseKind = TW_FLOOR_STATUTE_RE.test(m[0]) ? 'statute' : TW_FLOOR_TWD_RE.test(m[0]) ? 'twd' : 'bare';
    out.push({ index, text: m[0], kind });
  }
  return out;
}

/**
 * THE rule: is this clause-shaped match the statutory clause for this job (and
 * so never a figure for it)?
 *   statute  always. No posting uses the statute's term for anything else, in
 *            any market: a GoHire or licensed-feed row for a job in Taipei
 *            carries the same sentence.
 *   twd      next to "pay not listed" wording, in any market.
 *   bare     next to such wording, for a job in Taiwan, or on an international
 *            row whose country is unknown. Never for a job known to be
 *            elsewhere, and never on a mainland row of unknown country: there
 *            "面议，月薪5万以上" states a real minimum.
 */
function isFloorClause(kind: FloorClauseKind, where: FloorClauseWhere): boolean {
  if (kind === 'statute') return true;
  if (!where.negotiable) return false;
  if (kind === 'twd') return true;
  const country = where.country?.toUpperCase() || null;
  return country === 'TW' || (country === null && (where.market ?? 'intl') === 'intl');
}

/** The text with its statutory clauses blanked out (by `isFloorClause`). */
function withoutFloorClauses(s: string, clauses: readonly FloorClauseMatch[], where: FloorClauseWhere): string {
  let out = '';
  let at = 0;
  for (const c of clauses) {
    if (!isFloorClause(c.kind, where)) continue;
    out += `${s.slice(at, c.index)} `;
    at = c.index + c.text.length;
  }
  return at === 0 ? s : out + s.slice(at);
}

const CUR_PREFIX = String.raw`(?:US\$|NT\$|HK\$|S\$|A\$|AU\$|C\$|CA\$|R\$|MX\$|JP¥|USD|TWD|NTD|CNY|RMB|HKD|SGD|GBP|EUR|CAD|AUD|INR|JPY|[$£€¥￥₹₩])`;
const NUM = String.raw`(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const MULT = String.raw`(k|K|千|万|萬|w|W)?`;
const AMOUNT = String.raw`(?:${CUR_PREFIX}\s*)?${NUM}\s*${MULT}`;
const RANGE_RE = new RegExp(String.raw`(?<![\d.])${AMOUNT}\s*(?:元|塊)?\s*(?:-|–|—|~|～|〜|至|到|\bto\b)\s*(?:${CUR_PREFIX}\s*)?${NUM}\s*${MULT}`);
const SINGLE_RE = new RegExp(String.raw`(?<![\d.])${AMOUNT}`);
const CJK_MARKET_CURRENCY: Record<string, string> = { CN: 'CNY', TW: 'TWD', HK: 'HKD', MO: 'MOP' };
const MONTHS_RE = /[·・.\s]\s*(1[2-9]|2[0-4])\s*薪/;
/**
 * A mainland K / 千 / 万 figure with no stated period is read as monthly only
 * when its top is below this amount (CNY). From 50,000 up ("5-8万", "6万-9万",
 * "30-50万") a figure with no period is often a year's pay, and reading it as
 * a month's would overstate it twelve times, so it keeps no period.
 */
const MAINLAND_MONTHLY_BELOW = 50_000;

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

  const mainland = market === 'cn' || country === 'CN';
  const floors = floorClauses(s);
  // "Pay not listed": the wording, or the statute's own clause standing alone (it is the same statement).
  const negotiable = NEGOTIABLE_RE.test(s) || floors.some((f) => f.kind === 'statute');
  // The statutory-threshold clause is not a figure for this job (TW-03, JT-1): see `isFloorClause`.
  const scrubbed = withoutFloorClauses(s, floors, { country, market, negotiable });

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
  const hasUnit = /[kK千万萬]|[wW](?=\W|$)/.test(range?.[0] ?? scrubbed);
  const hasSymbol = new RegExp(CUR_PREFIX).test(range?.[0] ?? scrubbed);
  let currency = currencyFromText(s, country, market);
  // Chinese-language pay text in a Chinese-speaking market without a symbol ("15-25K·14薪", "月薪 4萬~5萬").
  if (!currency && cjk) currency = CJK_MARKET_CURRENCY[country ?? ''] ?? (market === 'cn' ? 'CNY' : null);
  // A mainland posting's K / 千 / 万 figure that names no currency is yuan, with or without Chinese words ("15-25K").
  if (!currency && hasUnit && mainland) currency = 'CNY';
  // Mainland convention: a K / 千 / 万 figure that names no period is a month's pay ("1.5-2.5万",
  // "15-25K"). Only below MAINLAND_MONTHLY_BELOW: "5-8万" or "30-50万" with no period may be a
  // year's pay, so it keeps no period and is shown as posted (never guessed; not filterable).
  if (!period && hasUnit && currency === 'CNY' && mainland && Math.max(min ?? 0, max ?? 0) < MAINLAND_MONTHLY_BELOW) {
    period = 'month';
  }
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
/**
 * A description line worth reading for pay: it names pay, or it is the
 * 台灣就業通 phrase 依學經歷…核薪, which says "pay not listed" with no other pay
 * word beside it. Bare 核薪 does not open a line: it is also a payroll duty.
 */
const PAY_LINE_RE = new RegExp(`${PAY_WORD_RE.source}|${BY_EDUCATION_PAY}`, 'i');
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
 * statutory-threshold clause when it comes with them ("待遇面議（經常性薪資達
 * 4萬元或以上）", "依學經歷、證照核薪(每月經常性薪資達4萬元以上)"). A verbatim
 * slice of the line, never the whole sentence.
 */
function negotiablePhrase(line: string, where: Omit<FloorClauseWhere, 'negotiable'>): string | null {
  const s = line.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // A firm phrase first: in "協助核薪，待遇面議" the words that say it are 待遇面議.
  const m = s.match(NEGOTIABLE_FIRM_RE) ?? s.match(NEGOTIABLE_RE);
  const floor = floorClauses(s).find((f) => isFloorClause(f.kind, { ...where, negotiable: true }));
  if ((!m || m.index == null) && !floor) return null;
  // The clause alone (the statute's own words on a line of their own) is the phrase.
  let start = m?.index ?? floor!.index;
  let end = m?.index != null ? m.index + m[0].length : floor!.index + floor!.text.length;
  if (floor) {
    start = Math.min(start, floor.index);
    end = Math.max(end, floor.index + floor.text.length);
  }
  // A bracket the floor sentence sits in closes with it (and opens with it when the clause stands alone).
  if (/^[)）]/.test(s.slice(end))) {
    end += 1;
    if (floor && start === floor.index && /[(（]$/.test(s.slice(0, start))) start -= 1;
  }
  return s.slice(start, end).trim().slice(0, 80) || null;
}

const LINE_LEAD_RE = /^[\s\-–—•●○◆■□▪*·>]+|^\s*[(（]?\d{1,2}[.、)）]\s*/;

/** Bare 依學經歷 is about pay when its own clause names pay ("薪資依學經歷而定", "依學經歷敘薪"). */
const BY_EDUCATION_RE = /依學經歷|依学经历/;
const PAY_TIE_RE = new RegExp(`${CJK_PAY_WORD_RE.source}|敘薪|叙薪|起薪|議薪|议薪|給薪|给薪|計薪|计薪`);

/**
 * Does a description line that reads as "pay not listed" really say so? Yes
 * for the firm phrases (面議, 依公司規定, 依學經歷…核薪, "competitive salary"),
 * for the statute's own clause, and for any wording on a labelled pay line
 * ("薪資：核薪", "待遇：依學經歷"). The two short forms need more than a pay
 * word somewhere on the line (D3: never a pay statement the posting did not
 * make):
 *   bare 依學經歷  counts when its own clause names pay ("本公司薪資依學經歷
 *                  而定"), not in "熟悉薪資作業，依學經歷分派職務";
 *   bare 核薪      counts only on a labelled pay line: "負責薪資核算、核薪、
 *                  勞健保" is a payroll duty.
 */
function saysPayNotListed(line: string): boolean {
  const s = line.normalize('NFKC');
  if (NEGOTIABLE_FIRM_RE.test(s)) return true;
  if (floorClauses(s).some((f) => f.kind === 'statute')) return true;
  if (PAY_LABEL_RE.test(s.replace(LINE_LEAD_RE, ''))) return true;
  return s.split(/[,，、;；。]/).some((clause) => BY_EDUCATION_RE.test(clause) && PAY_TIE_RE.test(clause));
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

/**
 * The first pay statement in the description's pay clauses (a range or an
 * explicit period), else the words that say pay is not listed, else null.
 *
 * A description is read as one posting: when any of its pay lines says "pay
 * not listed", the statutory clause is the clause on every other line too
 * ("待遇：面議" and, a line below, "月薪達5萬元以上"), by the same rule as in
 * a pay field (`isFloorClause`). The statute's own wording ("每月經常性薪資達
 * 4萬元以上") is never a figure wherever it stands.
 */
export function payFromDescription(description: string | null | undefined, opts: { country?: string | null; market?: 'intl' | 'cn' } = {}): ParsedPay | null {
  if (!description) return null;
  const lines = description.normalize('NFKC').split(/\n|(?<=[.。;；])\s+/);
  const where = { country: opts.country ?? null, market: opts.market ?? 'intl' };
  let negotiable: ParsedPay | null = null;
  const figureLines: string[] = [];
  for (const line of lines) {
    if (!PAY_LINE_RE.test(line)) continue;
    // "待遇面議（經常性薪資達4萬元或以上）", "依學經歷、證照核薪(…)": a TW negotiable statement is read on the whole line.
    // Benefit-plan names ("401k") are not figures and must not hide the statement.
    const whole = parseSalaryText(line.replace(PLAN_TOKEN_RE, ' '), opts);
    if (whole?.negotiable) {
      // Keep the words that say it, not the rest of the sentence around them.
      if (saysPayNotListed(line)) negotiable ??= { ...whole, text: negotiablePhrase(line, where) ?? whole.text };
      continue;
    }
    figureLines.push(line);
  }
  for (const line of figureLines) {
    for (const raw of payClauses(line)) {
      // The posting says "pay not listed" on another line: the clause here is the statute's, not a figure.
      const clause = negotiable ? withoutFloorClauses(raw, floorClauses(raw), { ...where, negotiable: true }) : raw;
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

// server/src/features/cn/jobs/card.ts — GoHire honesty fields and the GoApply
// card meta (CN-E-05 display, F-FEED-07 cn tags, F-SAL-01 cn).
//
//   - Source line: 企业直招 ("direct from employer") only when the job came
//     from our recruiter bank AND the bank verified the employer AND it is not
//     an agency (H13). Otherwise "来源：{sourceName}". The source name is
//     always shown when known; never "not on other job boards".
//   - Pay: the posting's own words (`salaryText`, e.g. "15-25K·13薪") when it
//     has a figure; else structured pay in the same notation ("15-25K·13薪",
//     "200-300元/天", "30-50万/年"); else not disclosed ("薪资未披露"). Never
//     estimated (D3). 面议 / negotiable is not disclosed pay.
//   - Market tags 可落户 / 央国企 / 事业编 / 外企 only with an evidence quote.
//   - 届别 as `class_year:<yyyy>` market tags with the quote (WP-18 reads them).
//   - The other GoApply filter tags, each written only when the posting says
//     it, with the sentence it rests on (the feed's filters and the 网申截止
//     sort read them; feed/sql.ts lists the conventions):
//       `cn_hire:campus` / `cn_hire:social`   校招 / 社招 stated as the job's
//                                             hire type (not as the work of a
//                                             recruiting role, not negated)
//       `apply_closes:<yyyy-mm-dd>`           a stated application close date
//                                             (a full date; a date with no year
//                                             is not guessed; the date must be
//                                             tied to applying, so an "as of"
//                                             date or a start date gives none)
//       `intern_days:<n>`                     days a week an internship asks for
//       `school_tier:985|211|double_first_class`  a stated school-tier wish
//                                             ("不限 / 非 / 不卡 985" is not one)
//     When in doubt these readers give no tag: a missing tag only leaves a
//     filter or a date empty, a wrong one hides or mislabels a job (D3).
//     `mergePostingTags` replaces all of this module's tag families together
//     and keeps every other tag (央国企 / 可落户 … from enrichment).
//   - No applicant counts, view counts or funding data, ever.

import { CN_MARKET_TAGS, type CnCardMeta, type CnMarketTag } from './contract.js';
import type { CnJobCapabilities } from './mode.js';
import { cnFlagsOf } from './fraud/flags.js';
import { quoteAround, splitSentences, type Sentence } from './text.js';

/** GoHire's display name (a real source name, D3). */
export const GOHIRE_SOURCE_NAME = 'GoHire';

export interface MarketTagEntry {
  tag: string;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Valid `marketTags` entries (every one must carry a non-empty quote). */
export function readMarketTags(v: unknown): MarketTagEntry[] {
  if (!Array.isArray(v)) return [];
  const out: MarketTagEntry[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { tag, evidenceQuote, evidenceUrl } = item as Record<string, unknown>;
    if (typeof tag !== 'string' || typeof evidenceQuote !== 'string' || !evidenceQuote.trim()) continue;
    out.push({ tag, evidenceQuote: evidenceQuote.trim(), evidenceUrl: typeof evidenceUrl === 'string' && evidenceUrl ? evidenceUrl : null });
  }
  return out;
}

// ── Source line ──────────────────────────────────────────────────────────

/** H13: 企业直招 only for a verified, non-agency employer from our recruiter bank. */
export function isDirectFromEmployer(job: Record<string, unknown>): boolean {
  return job.fromRecruiterBank === true && job.employerVerified === true && job.isAgency !== true;
}

/** The source name shown on the card. GoHire bank rows always name GoHire. */
export function sourceNameOf(job: Record<string, unknown>): string | null {
  if (job.provider === 'bank_gohire' || job.sourceBoard === 'gohire') return str(job.sourceName) ?? GOHIRE_SOURCE_NAME;
  return str(job.sourceName);
}

// ── Pay ──────────────────────────────────────────────────────────────────

const HAS_FIGURE = /[0-9０-９一二三四五六七八九十百千万]/u;

function fmtK(n: number): string {
  const k = n / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
}

function fmtWan(n: number): string {
  const w = n / 10000;
  return Number.isInteger(w) ? String(w) : w.toFixed(1).replace(/\.0$/, '');
}

function range(a: string | null, b: string | null): string | null {
  if (a && b) return a === b ? a : `${a}-${b}`;
  return a ?? b;
}

/**
 * Structured CNY pay in mainland notation, or null when it cannot be stated
 * without guessing (no figure, no period, another currency).
 */
export function formatCnSalary(job: Record<string, unknown>): string | null {
  const min = num(job.salaryMin);
  const max = num(job.salaryMax);
  if (min === null && max === null) return null;
  const currency = str(job.salaryCurrency)?.toUpperCase() ?? null;
  if (currency !== 'CNY' && currency !== 'RMB') return null;
  const months = num(job.salaryMonths);
  switch (job.salaryPeriod) {
    case 'month': {
      const r = range(min !== null ? fmtK(min) : null, max !== null ? fmtK(max) : null);
      const base = min !== null && max === null ? `${r}K起` : min === null ? `${r}K以内` : `${r}K`;
      return months && months > 12 ? `${base}·${months}薪` : base;
    }
    case 'day': {
      const r = range(min !== null ? String(min) : null, max !== null ? String(max) : null);
      return `${r}元/天`;
    }
    case 'hour': {
      const r = range(min !== null ? String(min) : null, max !== null ? String(max) : null);
      return `${r}元/时`;
    }
    case 'year': {
      const r = range(min !== null ? fmtWan(min) : null, max !== null ? fmtWan(max) : null);
      return `${r}万/年`;
    }
    default:
      return null;
  }
}

/** The label a pasted pay line carries ("薪资：18-28K·15薪"); the row it is shown in is already labelled 薪资. */
const PAY_LABEL = /^\s*(?:薪资|薪資|薪酬|待遇|月薪|年薪|日薪|时薪|時薪|工资|工資|薪水|salary|pay)(?:范围|範圍|\s+range)?\s*[:：]\s*/i;

/** The pay line for a GoApply card. */
export function cnSalary(job: Record<string, unknown>): CnCardMeta['salary'] {
  if (job.salaryDisclosed !== true) return { text: null, disclosed: false };
  const stored = str(job.salaryText);
  const verbatim = stored ? stored.replace(PAY_LABEL, '').trim() || stored : null;
  if (verbatim && HAS_FIGURE.test(verbatim)) return { text: verbatim.slice(0, 80), disclosed: true };
  const structured = formatCnSalary(job);
  return structured ? { text: structured, disclosed: true } : { text: null, disclosed: false };
}

// ── Tags ─────────────────────────────────────────────────────────────────

const MARKET_TAG_SET = new Set<string>(CN_MARKET_TAGS);
const CLASS_YEAR_TAG = /^class_year:(\d{4})$/;

/** 可落户 / 央国企 / 事业编 / 外企 that carry a quote. A tag without a quote never renders. */
export function cnTags(job: Record<string, unknown>): CnCardMeta['tags'] {
  const out: CnCardMeta['tags'] = [];
  for (const t of readMarketTags(job.marketTags)) {
    if (!MARKET_TAG_SET.has(t.tag) || out.some((o) => o.tag === t.tag)) continue;
    out.push({ tag: t.tag as CnMarketTag, evidenceQuote: t.evidenceQuote, evidenceUrl: t.evidenceUrl });
  }
  return out;
}

export function cnClassYears(job: Record<string, unknown>): CnCardMeta['classYears'] {
  const out: CnCardMeta['classYears'] = [];
  for (const t of readMarketTags(job.marketTags)) {
    const m = CLASS_YEAR_TAG.exec(t.tag);
    if (!m) continue;
    const year = Number(m[1]);
    if (!out.some((o) => o.year === year)) out.push({ year, evidenceQuote: t.evidenceQuote });
  }
  return out.sort((a, b) => a.year - b.year);
}

/** Plausible 届别 years (a posting typed "1027届" is not a class). */
const MIN_CLASS_YEAR = 2000;
const MAX_CLASS_YEAR = 2100;

/** Separators between two years that share one 届 ("2026/2027届", "2026-2027届", "2026和2027届"). */
const YEAR_JOIN = '[/／、,，\\-–—~～至和及与或]';

/**
 * 届别 the posting states ("2027届"; a pair sharing one 届 such as
 * "2026/2027届" or "2026-2027届" gives both years; "27届" is not read: too
 * ambiguous), each with the sentence it rests on, as `class_year:<yyyy>`
 * market tags.
 */
export function extractClassYearTags(text: string): MarketTagEntry[] {
  const out: MarketTagEntry[] = [];
  const add = (year: number, sentence: Sentence, index: number) => {
    if (year < MIN_CLASS_YEAR || year > MAX_CLASS_YEAR) return;
    const tag = `class_year:${year}`;
    if (!out.some((o) => o.tag === tag)) out.push({ tag, evidenceQuote: quoteAround(sentence, index), evidenceUrl: null });
  };
  for (const sentence of splitSentences(text)) {
    const re = new RegExp(`(?<![0-9])(20[0-9]{2})(?:\\s*${YEAR_JOIN}\\s*(20[0-9]{2}))?\\s*届`, 'gu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence.norm))) {
      add(Number(m[1]), sentence, m.index);
      if (m[2]) add(Number(m[2]), sentence, m.index);
    }
  }
  return out;
}

/** Replace this module's `class_year:` tags in `existing` with `next`, keeping every other tag. Null when empty. */
export function mergeClassYearTags(existing: unknown, next: readonly MarketTagEntry[]): MarketTagEntry[] | null {
  const kept = readMarketTags(existing).filter((t) => !CLASS_YEAR_TAG.test(t.tag));
  const all = [...kept, ...next];
  return all.length ? all : null;
}

// ── 校招 / 社招, 网申截止, 实习天数, 院校层次 ─────────────────────────────
//
// All matching runs on `Sentence.norm` (NFKC): full-width ，；：（） are
// already , ; : ( ) there.

const CLAUSE_END = /[,;。!?]/u;

/** The comma-delimited clause of `norm` that holds `index`, and where it starts. */
function clauseAround(norm: string, index: number): { text: string; start: number } {
  let start = Math.min(Math.max(index, 0), norm.length);
  while (start > 0 && !CLAUSE_END.test(norm[start - 1]!)) start -= 1;
  let end = start;
  while (end < norm.length && !CLAUSE_END.test(norm[end]!)) end += 1;
  return { text: norm.slice(start, end), start };
}

/**
 * A negation right before a match ("不接受校招", "非社招岗位"): the posting
 * says it is NOT that. A bare 无 is not read as one ("无锡校招岗位").
 */
function negatedBefore(norm: string, index: number): boolean {
  return /(?:非|不是|不属于|不接受|不招|不含|不限于?|无需)[^,。;]{0,2}$/u.test(norm.slice(Math.max(0, index - 6), index));
}

const CAMPUS_RE = /校园招聘|校招|秋招|春招|提前批/gu;
const SOCIAL_RE = /社会招聘|社招/gu;
/**
 * Recruiting as the WORK of the role, not the hire type of the posting: a
 * verb of doing earlier in the same clause ("负责公司校园招聘及社会招聘全流程",
 * "协助开展校招宣讲"). "欢迎参与我司校招" is an invitation, not a duty.
 */
const HIRE_DUTY_BEFORE = /(?:负责|组织|协助|支持|开展|统筹|主导|策划|推进|执行|承担|跟进|对接|制定|搭建|优化|完善|熟悉|了解|擅长|(?<!欢迎|欢迎您|诚邀|诚邀您|邀请|邀请您)参与)[^,。;]*$/u;
/** The word names a role, a skill or a channel, not a hire type: "校招专员", "社招经验", "校招渠道", "校招方向". */
const HIRE_NOT_TYPE_AFTER = /^\s*(?:工作)?(?:经验|经历|渠道|体系|策略|方向|专员|经理|主管|负责人|顾问|助理|总监|组长|hr|bp)/u;

/** True when the match at `index` states the posting's hire type (see the two rules above). */
function statesHireType(norm: string, index: number, length: number): boolean {
  if (negatedBefore(norm, index)) return false;
  const clause = clauseAround(norm, index);
  if (HIRE_DUTY_BEFORE.test(norm.slice(clause.start, index))) return false;
  return !HIRE_NOT_TYPE_AFTER.test(norm.slice(index + length));
}

/**
 * `cn_hire:campus` / `cn_hire:social`, only when the posting uses the words
 * (校园招聘 / 校招 / 秋招 / 春招 / 提前批; 社会招聘 / 社招) for its own hire
 * type: not negated, not the duty of a recruiting role, not a job title or an
 * experience line. A posting that names both gets both tags. Never inferred
 * from a 届别, a seniority or a years-of-experience line (a campus posting
 * that only names a 届 is still found by the feed's 届别 fallback).
 */
export function extractHireTags(text: string): MarketTagEntry[] {
  const out: MarketTagEntry[] = [];
  const scan = (re: RegExp, tag: string) => {
    if (out.some((o) => o.tag === tag)) return;
    for (const sentence of splitSentences(text)) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence.norm))) {
        if (!statesHireType(sentence.norm, m.index, m[0].length)) continue;
        out.push({ tag, evidenceQuote: quoteAround(sentence, m.index), evidenceUrl: null });
        return;
      }
    }
  };
  scan(CAMPUS_RE, 'cn_hire:campus');
  scan(SOCIAL_RE, 'cn_hire:social');
  return out;
}

/** A full calendar date as postings write it: 2026年11月30日, 2026-11-30, 2026/11/30, 2026.11.30. */
const DATE = '(20[0-9]{2})\\s*[年\\-/.]\\s*([0-9]{1,2})\\s*[月\\-/.]\\s*([0-9]{1,2})\\s*日?';
/**
 * "网申截止时间：2026年11月30日", "投递截止至 2026-11-30", "截止日期为2026/11/30".
 * Group 1: an application word right before 截止; group 2: the label noun
 * (时间 / 日期 / 日); groups 3-5: the date.
 */
const CLOSE_THEN_DATE = new RegExp(`(网申|申请|投递|报名|应聘|简历投递|简历接收|招聘)?截止(时间|日期|日)?\\s*(?:为|是|至|到)?\\s*:?\\s*${DATE}`, 'gu');
/** "请于2026年11月30日前完成网申", "2026-11-30 截止" — needs an application word in the same clause. */
const DATE_THEN_CLOSE = new RegExp(`${DATE}\\s*(?:[0-9]{1,2}:[0-9]{2})?\\s*(?:之前|以前|前(?!后)|截止|止)`, 'gu');
const APPLY_WORD = /网申|投递|申请|报名|应聘|简历/u;
/** Only list markers before the label: "截止日期：…" is a field of the posting, "项目交付截止日期：…" is not. */
const LIST_MARKER_ONLY = /^[\s0-9.、()\-*·•#\[\]【】]*$/u;
/** What the date bounds is something else: starting work, graduating, an age or a certificate. */
const NOT_APPLYING_AFTER = /^\s*(?:能够?|可以?|须|需要?|应|必须)?\s*(?:到岗|入职|报到|上岗|毕业|离校|返校|取得|获得|拿到|出生|年满|满[0-9一二三四五六七八九十]|完成学业)/u;

function isoDate(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 2月30日 and the like (Date would roll it over).
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `apply_closes:<yyyy-mm-dd>` for each application close date the posting
 * states in full. The date must be tied to applying:
 *   - "…截止 <date>": an application word right before 截止 ("网申截止"), or
 *     one in the same clause, or the bare label opening its line
 *     ("截止日期：2026/12/1"). "截止2025年12月31日，集团员工总数超过10000人"
 *     is an "as of" date and gives no tag;
 *   - "<date> 前 / 截止": an application word in the same clause as the date,
 *     and the date not bounding something else ("2026年7月1日前到岗，简历投递
 *     邮箱见下" and "2027年7月31日前毕业的同学可申请" give no tag).
 * A date without a year ("11月30日截止") is not completed from the posting
 * date: that would be a guess (D3), so it gives no tag.
 */
export function extractApplyClosesTags(text: string): MarketTagEntry[] {
  const out: MarketTagEntry[] = [];
  const add = (date: string | null, sentence: Sentence, index: number) => {
    if (!date) return;
    const tag = `apply_closes:${date}`;
    if (!out.some((o) => o.tag === tag)) out.push({ tag, evidenceQuote: quoteAround(sentence, index), evidenceUrl: null });
  };
  for (const sentence of splitSentences(text)) {
    const norm = sentence.norm;
    CLOSE_THEN_DATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLOSE_THEN_DATE.exec(norm))) {
      const tied = !!m[1] || APPLY_WORD.test(clauseAround(norm, m.index).text) || (!!m[2] && LIST_MARKER_ONLY.test(norm.slice(0, m.index)));
      if (tied) add(isoDate(m[3]!, m[4]!, m[5]!), sentence, m.index);
    }
    DATE_THEN_CLOSE.lastIndex = 0;
    while ((m = DATE_THEN_CLOSE.exec(norm))) {
      if (!APPLY_WORD.test(clauseAround(norm, m.index).text)) continue;
      if (NOT_APPLYING_AFTER.test(norm.slice(m.index + m[0].length))) continue;
      add(isoDate(m[1]!, m[2]!, m[3]!), sentence, m.index);
    }
  }
  return out;
}

const CN_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
const DAY_NUM = '([1-7一二两三四五六七])';
/** "每周至少实习4天", "一周到岗3天", "每周3-5天" (the first number: the least the posting asks for). */
const PER_WEEK_DAYS = new RegExp(`(?:每周|一周|每星期)[^，,。；;0-9一二两三四五六七]{0,8}${DAY_NUM}\\s*(?:[-~至到][1-7一二两三四五六七]\\s*)?(?:天|日|个工作日)`, 'gu');
/** "4天/周", "实习3天每周". */
const DAYS_PER_WEEK = new RegExp(`${DAY_NUM}\\s*(?:天|日)\\s*(?:/|每)\\s*周`, 'gu');
const INTERN_WORD = /实习/u;

/**
 * `intern_days:<n>` — the days a week an internship asks for, only for an
 * internship posting (its type, its title or the sentence says 实习), so a
 * full-time job's "每周工作五天" is never read as an internship rule.
 */
export function extractInternDaysTags(text: string, job: Record<string, unknown> = {}): MarketTagEntry[] {
  const internship = job.employmentType === 'internship' || (typeof job.title === 'string' && INTERN_WORD.test(job.title));
  for (const sentence of splitSentences(text)) {
    if (!internship && !INTERN_WORD.test(sentence.norm)) continue;
    for (const re of [PER_WEEK_DAYS, DAYS_PER_WEEK]) {
      re.lastIndex = 0;
      const m = re.exec(sentence.norm);
      if (!m) continue;
      const n = CN_DIGITS[m[1]!] ?? Number(m[1]);
      if (n >= 1 && n <= 7) return [{ tag: `intern_days:${n}`, evidenceQuote: quoteAround(sentence, m.index), evidenceUrl: null }];
    }
  }
  return [];
}

/** The posting must be talking about schools, not a phone number or a salary that contains 985. */
const SCHOOL_CUE = /院校|高校|大学|学校|毕业|学历|本科|硕士|博士|学位|背景/u;
const TIERS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![0-9])985(?![0-9])/gu, 'school_tier:985'],
  [/(?<![0-9])211(?![0-9])/gu, 'school_tier:211'],
  [/双一流/gu, 'school_tier:double_first_class'],
];
const TIER_WORD = '(?:985|211|双一流)';
const TIER_JOIN = '[\\s/、,和及与或]*';
/** Other tiers of the same list right before this one ("非985/" before "211"): a negation covers the whole list. */
const TIER_LIST_BEFORE = new RegExp(`(?:${TIER_WORD}${TIER_JOIN})+$`, 'u');
/** "不限 / 非 / 不卡 / 不要求 985": the posting says the tier is NOT asked for. */
const TIER_NEGATED_BEFORE = /(?:非|不是|不卡|不限|不要求|不看|不强求|不强制|不需要?|无需|无|不区分|不论|无论|没有)(?:是否)?(?:只招|仅限|只限|只要|必须是?|一定是?|要求|为|是|于)?\s*$/u;
/** "985/211不限", "是否985院校不作要求". */
const TIER_NEGATED_AFTER = new RegExp(
  `^(?:${TIER_JOIN}${TIER_WORD})*\\s*(?:院校|高校|学校|大学)?(?:背景|毕业生?|学历|出身)?\\s*的?\\s*(?:不限|不作要求|不做要求|无要求|没有要求|无硬性要求|不作限制|不做限制|不是必须|非必须|非必需|不强求|不卡)`,
  'u',
);

/** "非211院校勿投": a negation followed by a refusal asks FOR the tier. */
const TIER_REFUSAL_AFTER = /勿投|勿扰|请勿|免投|慎投|不予考虑|不考虑|不招|不收|不要/u;
/** "双非均可", "双非也欢迎": schools outside 985/211 are accepted, so the tiers named next to it are not a wish. */
const NON_TIER_ACCEPTED = /双非[^,。;]{0,6}(?:均可|也可|亦可|皆可|都可|可投|可以|欢迎|不限)/u;

/** True when the tier at `index` is said NOT to be asked for. */
function tierNegated(norm: string, index: number, length: number): boolean {
  const after = norm.slice(index + length);
  if (TIER_NEGATED_AFTER.test(after)) return true;
  const before = norm.slice(0, index).replace(TIER_LIST_BEFORE, '');
  if (!TIER_NEGATED_BEFORE.test(before)) return false;
  const clauseEnd = after.search(CLAUSE_END);
  return !TIER_REFUSAL_AFTER.test(clauseEnd < 0 ? after : after.slice(0, clauseEnd));
}

/**
 * `school_tier:985 | 211 | double_first_class` for each tier the posting asks
 * for or prefers, in a school context. A posting that says the tier does not
 * matter ("不限院校，非985/211毕业生同样欢迎投递", "不卡985、211") gets no tag:
 * the feed's school filter would otherwise hide an open-to-all posting.
 */
export function extractSchoolTierTags(text: string): MarketTagEntry[] {
  const out: MarketTagEntry[] = [];
  for (const sentence of splitSentences(text)) {
    if (!SCHOOL_CUE.test(sentence.norm) || NON_TIER_ACCEPTED.test(sentence.norm)) continue;
    for (const [re, tag] of TIERS) {
      if (out.some((o) => o.tag === tag)) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence.norm))) {
        if (tierNegated(sentence.norm, m.index, m[0].length)) continue;
        out.push({ tag, evidenceQuote: quoteAround(sentence, m.index), evidenceUrl: null });
        break;
      }
    }
  }
  return out;
}

/** Tag families this module reads from the posting text and owns in `marketTags`. */
export const POSTING_TAG_PREFIXES = ['class_year:', 'cn_hire:', 'apply_closes:', 'intern_days:', 'school_tier:'] as const;

const isPostingTag = (tag: string): boolean => POSTING_TAG_PREFIXES.some((p) => tag.startsWith(p));

/** Every posting-stated tag of a GoApply job: 届别, 校招 / 社招, 网申截止, 实习天数, 院校层次. */
export function extractPostingTags(text: string, job: Record<string, unknown> = {}): MarketTagEntry[] {
  return [...extractClassYearTags(text), ...extractHireTags(text), ...extractApplyClosesTags(text), ...extractInternDaysTags(text, job), ...extractSchoolTierTags(text)];
}

/**
 * Replace this module's tag families in `existing` with `next`, keeping every
 * other tag (央国企 / 可落户 … from enrichment). A tag the posting no longer
 * states is dropped; nothing here survives without its quote. Null when empty.
 */
export function mergePostingTags(existing: unknown, next: readonly MarketTagEntry[]): MarketTagEntry[] | null {
  const kept = readMarketTags(existing).filter((t) => !isPostingTag(t.tag));
  const all = [...kept, ...next];
  return all.length ? all : null;
}

// ── Card meta ────────────────────────────────────────────────────────────

/** Calendar date in China (UTC+8, no daylight time) as yyyy-mm-dd; the feed's `cnDate` rule. */
function cnToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The application close date the posting states (`apply_closes:<date>` with
 * its quote), as the last second of that day in Beijing time. A posting can
 * state several (a first batch that has closed, a second still open): the
 * soonest one that has not passed is the deadline, the same date the feed's
 * deadline sort and filter use (`statedCloseSql`). When every stated date has
 * passed, the latest of them. Null when the posting states none.
 */
export function statedCloseAt(marketTags: unknown, now: Date = new Date()): string | null {
  const dates = readMarketTags(marketTags)
    .map((t) => /^apply_closes:(\d{4}-\d{2}-\d{2})$/.exec(t.tag)?.[1])
    .filter((d): d is string => !!d && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))
    .sort();
  if (!dates.length) return null;
  const today = cnToday(now);
  const date = dates.find((d) => d >= today) ?? dates[dates.length - 1]!;
  // 23:59:59 in Asia/Shanghai (UTC+8, no daylight time).
  return `${date}T15:59:59.000Z`;
}

/** `CnCardMeta` for one GoApply job (marketHooks.cardMeta). */
export function buildCnCardMeta(job: Record<string, unknown>, caps: Pick<CnJobCapabilities, 'licence'>, now: Date = new Date()): CnCardMeta {
  const sourceName = sourceNameOf(job);
  const isGoHire = sourceName === GOHIRE_SOURCE_NAME;
  const ownImport = job.visibility === 'private' || job.provider === 'user_import';
  return {
    sourceLine: {
      kind: isDirectFromEmployer(job) ? 'direct' : 'source',
      sourceName,
      originalSourceName: str(job.originalSourceName),
      licence: isGoHire ? caps.licence : null,
    },
    salary: cnSalary(job),
    // "Updated" is the source's own date; our crawl time is only ever "Last checked" (D3).
    updatedAt: iso(job.postedAt),
    lastCheckedAt: iso(job.lastSeenAt),
    // The application close date the posting itself states (网申截止：2026年11月30日) comes first;
    // a job with no source expiry (every pasted import) used to read "截止日期未注明" despite stating one.
    expiresAt: statedCloseAt(job.marketTags, now) ?? iso(job.expiresAt),
    tags: cnTags(job),
    classYears: cnClassYears(job),
    warnings: ownImport ? cnFlagsOf(job.fraudFlags).map((f) => ({ rule: f.rule, evidence: f.evidence, ai: f.method === 'llm' })) : [],
  };
}

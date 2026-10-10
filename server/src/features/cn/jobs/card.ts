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

/** The pay line for a GoApply card. */
export function cnSalary(job: Record<string, unknown>): CnCardMeta['salary'] {
  if (job.salaryDisclosed !== true) return { text: null, disclosed: false };
  const verbatim = str(job.salaryText);
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

// ── Card meta ────────────────────────────────────────────────────────────

/** `CnCardMeta` for one GoApply job (marketHooks.cardMeta). */
export function buildCnCardMeta(job: Record<string, unknown>, caps: Pick<CnJobCapabilities, 'licence'>): CnCardMeta {
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
    expiresAt: iso(job.expiresAt),
    tags: cnTags(job),
    classYears: cnClassYears(job),
    warnings: ownImport ? cnFlagsOf(job.fraudFlags).map((f) => ({ rule: f.rule, evidence: f.evidence, ai: f.method === 'llm' })) : [],
  };
}

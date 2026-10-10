// server/src/features/cn/jobs/salary.ts — the pay line of a GoApply posting
// (F-SAL-01 cn; MARKET_STRATEGY §1.5 "Pay": shown as posted, never invented).
//
// Pay: the posting's own words (`salaryText`, e.g. "15-25K·13薪") when it has
// a figure; else structured pay in the same notation ("15-25K·13薪",
// "200-300元/天", "30-50万/年"); else not disclosed ("薪资未披露"). Never
// estimated (D3). 面议 / negotiable is not disclosed pay.
//
// A small pure module (no imports but a type) so the feed card, the job page
// and the card meta all read ONE rule: re-exported by contract.ts for other
// areas and by card.ts for this one.

import type { CnCardMeta } from './contract.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const figure = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

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
  // A stored 0 (or less) is a source's "nothing here", never pay: it is no figure (D3).
  const min = figure(job.salaryMin);
  const max = figure(job.salaryMax);
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

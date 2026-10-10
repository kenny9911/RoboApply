// components/features/market/cn/meta.ts — reads `meta.cn` (the server's
// CnCardMeta from marketHooks.cardMeta) defensively: anything malformed is
// dropped, never guessed. A tag without a quote is never returned.

import type { CnCardMeta, CnMarketTag } from '../../../../lib/api/contracts/cn/jobs';
import type { MarketCardMeta } from '../types';

const MARKET_TAGS: readonly CnMarketTag[] = ['hukou', 'soe', 'bianzhi', 'foreign'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function readCnMeta(meta: MarketCardMeta | null | undefined): CnCardMeta | null {
  const m = obj(meta?.cn);
  if (!m) return null;
  const source = obj(m.sourceLine) ?? {};
  const licence = obj(source.licence);
  const salary = obj(m.salary) ?? {};
  const salaryText = str(salary.text);
  return {
    sourceLine: {
      kind: source.kind === 'direct' ? 'direct' : 'source',
      sourceName: str(source.sourceName),
      originalSourceName: str(source.originalSourceName),
      licence: licence && str(licence.holder) && str(licence.number) ? { holder: str(licence.holder)!, number: str(licence.number)! } : null,
    },
    salary: salary.disclosed === true && salaryText ? { text: salaryText, disclosed: true } : { text: null, disclosed: false },
    updatedAt: str(m.updatedAt),
    lastCheckedAt: str(m.lastCheckedAt),
    expiresAt: str(m.expiresAt),
    tags: arr(m.tags).flatMap((t) => {
      const o = obj(t);
      const tag = o?.tag;
      const quote = str(o?.evidenceQuote);
      if (!o || !quote || typeof tag !== 'string' || !(MARKET_TAGS as readonly string[]).includes(tag)) return [];
      return [{ tag: tag as CnMarketTag, evidenceQuote: quote, evidenceUrl: str(o.evidenceUrl) }];
    }),
    classYears: arr(m.classYears).flatMap((c) => {
      const o = obj(c);
      const quote = str(o?.evidenceQuote);
      return o && quote && typeof o.year === 'number' && Number.isInteger(o.year) ? [{ year: o.year, evidenceQuote: quote }] : [];
    }),
    warnings: arr(m.warnings).flatMap((w) => {
      const o = obj(w);
      const rule = str(o?.rule);
      const evidence = str(o?.evidence);
      return o && rule && evidence ? [{ rule, evidence, ai: o.ai === true }] : [];
    }),
  };
}

/** A parseable ISO date, or null. */
export function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Known fraud rule ids (labels under jobsCn.rules.*); anything else reads as "other". */
export const FRAUD_RULE_KEYS = ['training_to_hire', 'training_loan', 'upfront_fee', 'mlm', 'gambling', 'telecom_lure', 'blacklisted_employer', 'other'] as const;
export function ruleKey(rule: string): (typeof FRAUD_RULE_KEYS)[number] {
  return (FRAUD_RULE_KEYS as readonly string[]).includes(rule) ? (rule as (typeof FRAUD_RULE_KEYS)[number]) : 'other';
}

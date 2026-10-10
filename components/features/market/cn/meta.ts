// components/features/market/cn/meta.ts — reads `meta.cn` (the server's
// CnCardMeta from marketHooks.cardMeta) defensively: anything malformed is
// dropped, never guessed. A tag without a quote is never returned.

import type { CnCardMeta, CnMarketTag } from '../../../../lib/api/contracts/cn/jobs';
import { payUndisclosed, safeHttpUrl, type ListingApply, type ListingSource } from '../../../../lib/api/feed';
import type { MarketCardMeta } from '../types';

const MARKET_TAGS: readonly CnMarketTag[] = ['hukou', 'soe', 'bianzhi', 'foreign'];

/** A pay line that only says "negotiable" (面议 / 薪资面议 / 待遇面议 / 面議). */
const NEGOTIABLE_RE = /^(?:薪资|薪酬|工资|待遇|月薪)?\s*面[议議]$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** True for a pay line that only says "negotiable": it states no pay. */
export function isNegotiablePay(text: unknown): boolean {
  const words = str(text);
  return !!words && NEGOTIABLE_RE.test(words);
}

/**
 * The one GoApply rule for pay stated in words, wherever it is printed outside
 * the market block (the similar-jobs list, the job header when there is no
 * market block, the share card, a card's own pay line): the words as the
 * posting states them, or null when the posting states no pay. A posting
 * states no pay when the server says so (`salary: null` in the contract) and
 * when its pay line only says 面议. Null is shown as 薪资未披露 ("Pay not
 * listed"), never as 面议.
 */
export function cnPayWords(row: { salary?: unknown; pay?: unknown; payText?: unknown } | null | undefined): string | null {
  if (!row || payUndisclosed(row)) return null;
  const words = str(row.payText);
  return words && !NEGOTIABLE_RE.test(words) ? words : null;
}

export function readCnMeta(meta: MarketCardMeta | null | undefined): CnCardMeta | null {
  const m = obj(meta?.cn);
  if (!m) return null;
  const source = obj(m.sourceLine) ?? {};
  const licence = obj(source.licence);
  const salary = obj(m.salary) ?? {};
  // "面议" is a statement that no pay is given: it is shown as "pay not listed", never as a figure.
  const statedText = str(salary.text);
  const salaryText = statedText && !NEGOTIABLE_RE.test(statedText) ? statedText : null;
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

/**
 * Marks `meta.cn` as a job the user added themselves, so the slot's source
 * line reads "Added by you" (such a job has no source name) instead of
 * "Source not listed". The server's CnCardMeta has no field for this; the feed
 * card and the job page know it from the job's source and say so here, which
 * keeps the slot's props (jobId, meta, variant) as they are. Returns `meta`
 * untouched when `own` is false or there is no `cn` block.
 */
export function withOwnImport(meta: MarketCardMeta | null | undefined, own: boolean): MarketCardMeta | null | undefined {
  const m = obj(meta?.cn);
  if (!own || !meta || !m) return meta;
  return { ...meta, cn: { ...m, ownImport: true } };
}

/**
 * The listing facts of the contract (who published the posting, the original
 * link, when it was last verified, where the apply button leads), as the slot
 * reads them. The server's CnCardMeta has no field for them: the feed card and
 * the job page read them from the item (lib/api/feed.ts `listingSource` /
 * `listingApply`) and hand them over here, as `withOwnImport` does.
 */
export interface CnListing {
  /** The original publisher: the employer for a board row, the bank for a bank row. */
  original: string | null;
  /** The original posting (http or https only). */
  url: string | null;
  lastVerifiedAt: string | null;
  via: 'bank' | 'ats' | 'import' | null;
  applyTarget: 'gohire' | 'employer' | null;
}

export function withListing(
  meta: MarketCardMeta | null | undefined,
  listing: { source: ListingSource; apply: ListingApply } | null | undefined,
): MarketCardMeta | null | undefined {
  const m = obj(meta?.cn);
  if (!listing || !meta || !m) return meta;
  const value: CnListing = {
    original: listing.source.original,
    url: listing.source.url,
    lastVerifiedAt: listing.source.lastVerifiedAt,
    via: listing.source.via,
    applyTarget: listing.apply.target,
  };
  return { ...meta, cn: { ...m, listing: value } };
}

/** The listing facts handed over by `withListing`, or all-null when there are none. Malformed values are dropped. */
export function readCnListing(meta: MarketCardMeta | null | undefined): CnListing {
  const l = obj(obj(meta?.cn)?.listing) ?? {};
  return {
    original: str(l.original),
    url: safeHttpUrl(l.url),
    lastVerifiedAt: str(l.lastVerifiedAt),
    via: l.via === 'bank' || l.via === 'ats' || l.via === 'import' ? l.via : null,
    applyTarget: l.applyTarget === 'gohire' || l.applyTarget === 'employer' ? l.applyTarget : null,
  };
}

/**
 * The name on the source line (来源：…). A posting read from an employer's
 * careers board names its original publisher (the employer), and falls back
 * to the names the card meta carries when the publisher is not known. A
 * recruiter-bank row, and a row the item does not classify, names the source
 * the card meta carries (the bank), as before.
 */
export function cnSourceName(m: CnCardMeta, listing: CnListing): string | null {
  if (listing.via === 'ats') return listing.original ?? m.sourceLine.originalSourceName ?? m.sourceLine.sourceName;
  return m.sourceLine.sourceName ?? listing.original;
}

/** True when `meta.cn` is marked as the user's own job (see withOwnImport). */
export function isOwnImport(meta: MarketCardMeta | null | undefined): boolean {
  return obj(meta?.cn)?.ownImport === true;
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

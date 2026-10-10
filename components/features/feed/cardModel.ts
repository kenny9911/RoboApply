// components/features/feed/cardModel.ts — pure helpers behind the job card
// (PRODUCT F-FEED-05/06/07, F-SAL-01; D3). No React, no copy: callers pass
// the results to `t()`.
//
// Honesty rules enforced here, not in the markup:
//   • pay: currency and period from the post or provider; nothing listed →
//     null ("Pay not listed"), never 0. GoApply shows the post's own text
//     ("15-25K·13薪") when the server sends it;
//   • "Direct from employer" only when the job came from our recruiter bank,
//     the poster is the account's verified employer and not an agency
//     (`fromRecruiterBank && employerVerified && !isAgency`), even if a badge
//     arrives without those facts; otherwise a bank job gets the source line
//     "Posted on {sourceName} by a recruiter";
//   • the sponsorship badge needs the quote it is based on (its tooltip shows
//     it). WP-32 sends the post's stance as the badge kind: 'sponsorship' →
//     "Visa sponsorship mentioned", 'no_sponsorship' → "Says no visa
//     sponsorship". Without a quote it is dropped — never guessed;
//   • clearance / citizens-only requirements and GoApply employer tags show
//     only with the quote they rest on (tooltip);
//   • a deadline is shown only when the post states one (`campus.applyClosesAt`,
//     from an `apply_closes:` tag with its quote); there is no invented
//     urgency — the reserved `closing_soon` badge is never used;
//   • at most 3 badges, fixed priority.

import type { FeedItem } from '../../../lib/api/contracts/feed';
import { marketPayLineText, type MarketCardMeta } from '../market';

export type CardBadge =
  | { kind: 'direct' }
  | { kind: 'sponsorship'; status: SponsorshipStatus; quote: string }
  | { kind: 'clearance'; quote: string }
  | { kind: 'citizens'; quote: string }
  | { kind: 'agency' }
  | { kind: 'market'; label: string; quote: string | null }
  | { kind: 'closes'; at: string; quote: string | null }
  | { kind: 'new' };

export type SponsorshipStatus = 'offered' | 'not_offered';

export const MAX_BADGES = 3;

/** The post's sponsorship stance from a feed badge: WP-32 encodes it in the kind. Pure. */
export function sponsorshipStatus(badge: FeedItem['badges'][number]): SponsorshipStatus | null {
  if (badge.kind === 'sponsorship') return 'offered';
  if (badge.kind === 'no_sponsorship') return 'not_offered';
  return null;
}

const BADGE_ORDER: Record<CardBadge['kind'], number> = {
  direct: 0,
  sponsorship: 1,
  clearance: 2,
  citizens: 3,
  agency: 4,
  market: 5,
  closes: 6,
  new: 7,
};

function quoteOf(badge: FeedItem['badges'][number]): string | null {
  const q = typeof badge.quote === 'string' ? badge.quote.trim() : '';
  return q || null;
}

export function isDirectFromEmployer(item: Pick<FeedItem, 'fromRecruiterBank' | 'employerVerified' | 'isAgency'>): boolean {
  return item.fromRecruiterBank === true && item.employerVerified === true && item.isAgency !== true;
}

function validDate(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso));
}

/** The badges a card shows, in priority order, at most 3. */
export function cardBadges(item: FeedItem): CardBadge[] {
  const out: CardBadge[] = [];
  const kinds = new Set<string>();
  const push = (b: CardBadge) => {
    const key = b.kind === 'market' ? `market:${b.label}` : b.kind;
    if (kinds.has(key)) return;
    kinds.add(key);
    out.push(b);
  };
  if (isDirectFromEmployer(item)) push({ kind: 'direct' });
  if (item.isAgency) push({ kind: 'agency' });
  for (const b of item.badges ?? []) {
    switch (b.kind) {
      case 'sponsorship':
      case 'no_sponsorship': {
        const status = sponsorshipStatus(b);
        const quote = quoteOf(b);
        if (status && quote) push({ kind: 'sponsorship', status, quote });
        break;
      }
      case 'clearance_required': {
        const quote = quoteOf(b);
        if (quote) push({ kind: 'clearance', quote });
        break;
      }
      case 'citizens_only': {
        const quote = quoteOf(b);
        if (quote) push({ kind: 'citizens', quote });
        break;
      }
      case 'market_tag':
        if (typeof b.label === 'string' && b.label.trim()) push({ kind: 'market', label: b.label.trim(), quote: quoteOf(b) });
        break;
      case 'new':
        push({ kind: 'new' });
        break;
      // 'direct_from_employer' is decided from the fields above, never from the badge alone;
      // 'closing_soon' is reserved and never emitted (the stated date below is the only deadline).
      default:
        break;
    }
  }
  const closes = item.campus?.applyClosesAt;
  if (validDate(closes)) {
    const quote = typeof item.campus?.applyClosesQuote === 'string' ? item.campus.applyClosesQuote.trim() : '';
    push({ kind: 'closes', at: closes, quote: quote || null });
  }
  return out.sort((a, b) => BADGE_ORDER[a.kind] - BADGE_ORDER[b.kind]).slice(0, MAX_BADGES);
}

export type SourceLine =
  | { key: 'provider'; name: string }
  | { key: 'bank'; sourceName: string }
  | { key: 'ats_public'; name: string }
  | { key: 'user_import' }
  | null;

/** The source line under the facts. A verified direct post needs none (its badge says it). */
export function sourceLine(item: FeedItem): SourceLine {
  const name = item.source?.name?.trim() ?? '';
  switch (item.source?.kind) {
    case 'bank':
      if (isDirectFromEmployer(item)) return null;
      return name ? { key: 'bank', sourceName: name } : null;
    case 'ats_public':
      return name ? { key: 'ats_public', name } : null;
    case 'user_import':
      return { key: 'user_import' };
    case 'provider':
      return name ? { key: 'provider', name } : null;
    default:
      return null;
  }
}

/**
 * GoApply shows no card without a source (D3; MARKET_STRATEGY §1.4): a public
 * posting must name where it was published. The user's own added jobs have no
 * publisher and say "Added by you" instead, so they always pass. Pure.
 */
export function hasNamedSource(item: FeedItem): boolean {
  if (item.source?.kind === 'user_import') return true;
  const source = item.source as (FeedItem['source'] & { original?: unknown }) | undefined;
  const named = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return named(source?.name) || named(source?.original);
}

export interface PayText {
  /** Already formatted amount or range ("$120K–$150K"), or the post's own text. */
  amount: string;
  /** null when `amount` is the post's own text (it carries its own period). */
  period: 'year' | 'month' | 'week' | 'day' | 'hour' | null;
}

function money(locale: string, currency: string, value: number, period: string): string {
  const compact = (period === 'year' || period === 'month') && Math.abs(value) >= 10_000;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : period === 'hour' ? 2 : 0,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/**
 * Pay for the card, or null for "Pay not listed". `range` builds "{min}–{max}"
 * (the caller passes the translated pattern). GoApply prefers the post's text,
 * and never prints a line that only says 面议: with no figures that is null.
 */
export function payText(
  pay: FeedItem['pay'],
  opts: { locale: string; market: 'intl' | 'cn'; range: (min: string, max: string) => string; from: (a: string) => string; upTo: (a: string) => string },
): PayText | null {
  if (!pay) return null;
  // GoApply: a pay line that only says 面议 states no pay (market `marketPayLineText`).
  const text = marketPayLineText(opts.market, pay.text);
  if (opts.market === 'cn' && text) return { amount: text, period: null };
  const min = typeof pay.min === 'number' && Number.isFinite(pay.min) && pay.min > 0 ? pay.min : null;
  const max = typeof pay.max === 'number' && Number.isFinite(pay.max) && pay.max > 0 ? pay.max : null;
  if (min === null && max === null) return text ? { amount: text, period: null } : null;
  if (!pay.currency) return text ? { amount: text, period: null } : null;
  const fmt = (v: number) => money(opts.locale, pay.currency, v, pay.period);
  let amount: string;
  if (min !== null && max !== null) amount = min === max ? fmt(min) : opts.range(fmt(Math.min(min, max)), fmt(Math.max(min, max)));
  else if (min !== null) amount = opts.from(fmt(min));
  else amount = opts.upTo(fmt(max as number));
  return { amount, period: pay.period };
}

/** "3 Oct 2026" in the UI locale; null for a missing or broken date. A bare yyyy-mm-dd is that calendar day in every time zone. */
export function shortDate(iso: string | null | undefined, locale: string): string | null {
  if (!validDate(iso)) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) }).format(new Date(iso));
  } catch {
    return null;
  }
}

/** Optional server fields WP-33 renders when present (requested from WP-32; see handoff). */
interface FeedItemExtras {
  /** `marketHooks.cardMeta()` output for MarketJobMeta (CN/TW). */
  cardMeta?: MarketCardMeta | null;
  /** explainMatch() lines for WhyThisJob (WP-13). */
  explanation?: import('../../../lib/api/contracts/compliance').MatchExplanation | null;
}

/** Narrow typed adapter over fields the contract does not name yet. */
export function itemExtras(item: FeedItem): FeedItemExtras {
  const raw = item as FeedItem & Record<string, unknown>;
  const cardMeta = raw.cardMeta && typeof raw.cardMeta === 'object' ? (raw.cardMeta as MarketCardMeta) : null;
  const explanation =
    raw.explanation && typeof raw.explanation === 'object' && 'headline' in (raw.explanation as object)
      ? (raw.explanation as FeedItemExtras['explanation'])
      : null;
  return { cardMeta, explanation };
}

/** Initial for the logo placeholder. */
export function companyInitial(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toLocaleUpperCase() : '·';
}

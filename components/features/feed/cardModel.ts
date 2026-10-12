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
//     sponsorship". Without a quote it is dropped — never guessed. A
//     provider's own reading is another badge (`sponsorship_provider`): it
//     names the provider, has no quote and never uses the wording of the
//     quoted badge; without a provider name it is dropped (JI-11);
//   • clearance / citizens-only requirements and GoApply employer tags show
//     only with the quote they rest on (tooltip);
//   • a deadline is shown only when the post states one (`campus.applyClosesAt`,
//     from an `apply_closes:` tag with its quote); there is no invented
//     urgency — the reserved `closing_soon` badge is never used;
//   • at most 3 badges, fixed priority;
//   • dates are three separate facts (JI-10): "Posted" only for the
//     employer's own date; a date we assigned is never called posted (the card
//     says when we first saw the job instead) and "Last checked" is when a
//     source last confirmed the posting listed;
//   • "New" comes from `isNew` alone (first seen by us since the last visit,
//     or in the last 48 hours), never from the posted date and never from a
//     badge of the list. It is ours, not a fact from the post, so it is not
//     one of the three badges.
//
// Also here, because the card and the job page share it: how "Apply on
// company site" opens its tab (`applyTabOpener`). The tab goes where the
// server's answer to the click says, never to a link the page already holds:
// the click first asks whether the posting is still listed, and a posting
// that is gone must not be opened (MARKET_STRATEGY 1.5 "Closure").

import type { FeedItem } from '../../../lib/api/contracts/feed';
import type { TabOpener } from '../../../hooks/shared/useJobActions';
import { detectInAppBrowser } from '../../../lib/auth/inAppBrowser';
import { marketPayLineText, type MarketCardMeta } from '../market';

export type CardBadge =
  | { kind: 'direct' }
  | { kind: 'sponsorship'; status: SponsorshipStatus; quote: string }
  /** A provider's reading that the job offers sponsorship: `provider` is its display name. No quote. */
  | { kind: 'sponsorship_provider'; provider: string }
  | { kind: 'clearance'; quote: string }
  | { kind: 'citizens'; quote: string }
  | { kind: 'agency' }
  | { kind: 'market'; label: string; quote: string | null }
  | { kind: 'closes'; at: string; quote: string | null };

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
  sponsorship_provider: 1,
  clearance: 2,
  citizens: 3,
  agency: 4,
  market: 5,
  closes: 6,
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
      case 'sponsorship_provider': {
        // A provider's reading: shown only with the provider's name, which the label states.
        const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
        if (provider) push({ kind: 'sponsorship_provider', provider });
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
      // 'direct_from_employer' is decided from the fields above, never from the badge alone;
      // 'closing_soon' is reserved and never emitted (the stated date below is the only deadline);
      // 'new' is not read from the list: "New" is the field `isNew` (`cardIsNew`).
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

/** "New": first seen by us since the viewer's last visit, or in the last 48 hours (the server's `isNew`). Never the posted date. */
export function cardIsNew(item: Pick<FeedItem, 'isNew'>): boolean {
  return item.isNew === true;
}

/** One date fact of a card, with the instant it states. */
export type CardDate = { kind: 'posted' | 'first_seen' | 'last_verified'; at: string };

export interface CardDates {
  /**
   * The line that leads: the employer's own posted date when the posting
   * states one; otherwise when we first saw the posting; null when neither is
   * known ("Posting date not listed").
   */
  lead: CardDate | null;
  /** When a source last confirmed the posting listed ("Last checked"); null when unknown. */
  verified: CardDate | null;
}

/**
 * The card's dates as three separate facts. A date we assigned
 * (`postedAtEstimated`) is never a posted date, whatever `postedAt` holds: a
 * server from before the three-date wire sent our first-seen date there, so
 * it is read as "first seen" and nothing else.
 */
export function cardDates(item: Pick<FeedItem, 'postedAt' | 'postedAtEstimated' | 'firstSeenAt' | 'lastSeenAt'>): CardDates {
  const estimated = item.postedAtEstimated === true;
  const posted = !estimated && validDate(item.postedAt) ? item.postedAt : null;
  const firstSeen = validDate(item.firstSeenAt) ? item.firstSeenAt : estimated && validDate(item.postedAt) ? item.postedAt : null;
  const lead: CardDate | null = posted ? { kind: 'posted', at: posted } : firstSeen ? { kind: 'first_seen', at: firstSeen } : null;
  return { lead, verified: validDate(item.lastSeenAt) ? { kind: 'last_verified', at: item.lastSeenAt } : null };
}

export type SourceLine =
  | { key: 'provider'; name: string }
  | { key: 'bank'; sourceName: string }
  | { key: 'ats_public'; name: string }
  | { key: 'user_import' }
  | null;

/** The source line under the facts. A verified direct post needs none (its badge says it). */
/**
 * A row found through Google's job index (a JSearch row located in Taiwan: `cardMeta.tw_sources.via`,
 * server twHooks.ts). The Taiwan slot names the original publisher with the link (JobMetaTw); the
 * aggregator is not the source and is not named beside it (JT-8; MARKET_STRATEGY 1.5).
 */
export function foundThroughJobSearch(meta: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const set = meta?.tw_sources;
  return !!set && typeof set === 'object' && (set as { via?: unknown }).via === 'google_jobs';
}

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
      if (foundThroughJobSearch(itemExtras(item).cardMeta)) return null;
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

// ── The apply tab ─────────────────────────────────────────────────────────

/**
 * Does this browser have one window only? A social app's built-in browser
 * (WeChat, LinkedIn, …), an Android WebView (`; wv)`) and an iOS web view
 * inside an app (an iPhone or iPad user agent with no `Safari/` token) load
 * whatever `window.open` is given in the page itself. Pure.
 */
export function isOneWindowBrowser(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? '';
  if (detectInAppBrowser(ua)) return true;
  if (/;\s*wv\)/.test(ua)) return true;
  return /\b(iPhone|iPad|iPod)\b/.test(ua) && !/Safari\//.test(ua);
}

/** What the apply tab needs from the browser (the test seam of `createApplyTabOpener`). */
export interface ApplyTabBrowser {
  userAgent(): string;
  open(url: string, target: string, features?: string): Window | null;
  /** Take the page itself to `url`. */
  go(url: string): void;
}

/**
 * How "Apply on company site" opens the employer's page, for
 * `useJobActions(jobId, { opener })` WITHOUT a link (the hook then opens an
 * empty tab inside the click, points it at the link the server answers with,
 * and closes it when the click is refused, so a posting that is gone is never
 * opened).
 *   - a browser with tabs: exactly the hook's own way;
 *   - a browser with one window: no empty tab (it would replace this page with
 *     a blank one, and the answer would never arrive). Nothing is opened inside
 *     the click; when the server has answered, the page itself goes to the
 *     link, which is what "open" does there anyway and needs no pop-up
 *     permission.
 */
export function createApplyTabOpener(browser: ApplyTabBrowser): TabOpener {
  return {
    blank() {
      return isOneWindowBrowser(browser.userAgent()) ? null : browser.open('about:blank', '_blank');
    },
    open(url) {
      if (isOneWindowBrowser(browser.userAgent())) browser.go(url);
      else browser.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}

/** The opener of the card and the job page, on the real browser (nothing happens during server rendering). */
export const applyTabOpener: TabOpener = createApplyTabOpener({
  userAgent: () => (typeof navigator === 'undefined' ? '' : navigator.userAgent),
  open: (url, target, features) => (typeof window === 'undefined' ? null : features === undefined ? window.open(url, target) : window.open(url, target, features)),
  go: (url) => {
    if (typeof window !== 'undefined') window.location.assign(url);
  },
});

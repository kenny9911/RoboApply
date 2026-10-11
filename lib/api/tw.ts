// lib/api/tw.ts — Taiwan routes of the international brand (MKT-5F; JT-6, JT-7).
//
// Thin typed wrappers over the area contract, plus the few pure helpers the
// note and the filters share (no React here). Owner: MKT-5F.
// Types are the contract's own (server/src/features/tw/contract.ts, type-only
// import: nothing of the server reaches the browser bundle).
//
// Endpoints (every one answers 404 feature_disabled on GoApply, so GoApply
// screens never call them):
//   GET /api/v1/roboapply/tw/pay-rule
//   GET /api/v1/roboapply/tw/districts
//   GET /api/v1/roboapply/admin/tw/pay-rule
//   PUT /api/v1/roboapply/admin/tw/pay-rule

import { call, type CallOptions, type In } from './contracts/wire';
import type * as TW from '../../server/src/features/tw/contract';

export type { TwCountyView, TwDistrictView, TwDistrictsResponse, TwPayRuleAdminView, TwPayRuleView } from '../../server/src/features/tw/contract';

/** Body of PUT /admin/tw/pay-rule (contract `PutTwPayRuleBodySchema`). */
export type PutTwPayRuleBody = In<typeof TW.PutTwPayRuleBodySchema>;

/** `tw.payRule` — GET /api/v1/roboapply/tw/pay-rule */
export function getTwPayRule(opts?: CallOptions): Promise<TW.TwPayRuleView | null> {
  return call<TW.TwPayRuleView | null>('GET', `/api/v1/roboapply/tw/pay-rule`, opts);
}

/** `tw.districts` — GET /api/v1/roboapply/tw/districts */
export function getTwDistricts(opts?: CallOptions): Promise<TW.TwDistrictsResponse> {
  return call<TW.TwDistrictsResponse>('GET', `/api/v1/roboapply/tw/districts`, opts);
}

/** `tw.admin.payRule` — GET /api/v1/roboapply/admin/tw/pay-rule */
export function adminGetTwPayRule(opts?: CallOptions): Promise<TW.TwPayRuleAdminView> {
  return call<TW.TwPayRuleAdminView>('GET', `/api/v1/roboapply/admin/tw/pay-rule`, opts);
}

/** `tw.admin.putPayRule` — PUT /api/v1/roboapply/admin/tw/pay-rule */
export function adminPutTwPayRule(body: PutTwPayRuleBody, opts?: CallOptions): Promise<TW.TwPayRuleAdminView> {
  return call<TW.TwPayRuleAdminView>('PUT', `/api/v1/roboapply/admin/tw/pay-rule`, { ...opts, body });
}

// ── Query keys (one cache entry each; the hooks live with the components that use them) ──

export const twKeys = {
  payRule: ['tw', 'pay-rule'] as const,
  districts: ['tw', 'districts'] as const,
};

/**
 * How long a browser keeps the rule before asking again: 4 minutes, the
 * route's own `max-age`. The server keeps one read for a minute more
 * (server/src/features/tw/payRule.ts `TW_PAY_RULE_HOLD_MS`), so the note is at
 * most 5 minutes behind an admin's edit. A test holds the sum.
 */
export const TW_PAY_RULE_STALE_MS = 4 * 60_000;
/** The district table changes only with a deploy. */
export const TW_DISTRICTS_STALE_MS = 24 * 60 * 60_000;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * A New Taiwan dollar amount as it is written everywhere in the product:
 * `NT$` and a thousands separator (NT$40,000), in every locale. Null for
 * anything that is not a positive whole number, so a caller prints no amount
 * rather than a wrong one.
 */
export function formatTwd(amount: unknown): string | null {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return null;
  return `NT$${amount.toLocaleString('en-US')}`;
}

/**
 * A YYYY-MM-DD day in the reader's language ("October 11, 2026",
 * "2026年10月11日"). The day is a calendar day, not an instant, so it is
 * formatted in UTC and never moves with the reader's time zone. Null when the
 * text is not a real day.
 */
export function formatRuleDate(day: unknown, locale: string): string | null {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(at);
  } catch {
    return day;
  }
}

/** An https link, or null (the note never renders any other kind of link). */
export function httpsHref(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The comparison key of a place name: width and case folded, 臺 read as 台,
 * runs of spaces as one. The server folds a county's `keys` the same way
 * (server/src/features/jobs/geo/twSearch.ts `twPlaceKey`).
 */
export function twPlaceKey(text: string): string {
  return text.normalize('NFKC').replace(/臺/g, '台').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** One place of a search, as far as these helpers read it (a `FilterLocation` fits). */
export interface TwSearchPlace {
  label: string;
  city?: string;
  country?: string;
}

/**
 * The counties a place someone typed names: the county whose name the text
 * starts with (新竹縣竹北市), else every county one of whose keys is the
 * place's first name ("Taipei, Taiwan" → Taipei). Empty for a place that
 * states another country. One name can mean two counties ("Chiayi").
 */
export function twCountiesOfPlace(place: TwSearchPlace, counties: readonly TW.TwCountyView[]): TW.TwCountyView[] {
  const stated = place.country?.trim().toUpperCase();
  if (stated && stated !== 'TW') return [];
  for (const text of [place.label, place.city ?? '']) {
    const key = twPlaceKey(text).replace(/\s+/g, '');
    if (!key) continue;
    const byPrefix = counties.find((c) => [c.name, c.nameAlt ?? ''].filter(Boolean).some((name) => key.startsWith(twPlaceKey(name))));
    if (byPrefix) return [byPrefix];
  }
  const first = twPlaceKey((place.city?.trim() || place.label).split(/[,，]/)[0] ?? '');
  return first ? counties.filter((c) => c.keys.includes(first)) : [];
}

/**
 * True when a search is in Taiwan as far as the browser can tell: its country
 * is TW, one of its places says TW, or (with the county table loaded) one of
 * its places names a Taiwanese county. The server decides for good
 * (jobs/geo `isTaiwanSearch`); this only chooses which controls to show.
 */
export function isTaiwanSearch(search: { country?: string; locations?: readonly TwSearchPlace[] }, counties: readonly TW.TwCountyView[] = []): boolean {
  if (search.country?.trim().toUpperCase() === 'TW') return true;
  return (search.locations ?? []).some((l) => (l.country ? l.country.trim().toUpperCase() === 'TW' : twCountiesOfPlace(l, counties).length > 0));
}

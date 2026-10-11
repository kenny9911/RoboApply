// components/features/market/tw/meta.ts — reads `meta.ats_public` (the server's
// TwCardMeta from marketHooks.cardMeta) and `meta.tw_sources` (the open-data
// licence attribution, MKT-3E) defensively: a card always renders, so an odd
// or missing value yields null instead of throwing (WP-42).

import type { TwCardMeta, TwPermitTag, TwPermitTagView } from '../../../../lib/api/careerSources';
import type { MarketCardMeta } from '../types';

/** Client twin of the server's TW_PERMIT_TAGS. */
export const TW_PERMIT_TAGS: readonly TwPermitTag[] = ['tw_work_permit_support', 'tw_gold_card'];

/** Client twin of the server's PUBLIC_ATS_NAMES (vendor names are data, not copy). */
export const PUBLIC_ATS_NAMES = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
} as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** http(s) URLs only (a link we render must never be a script URL). */
export function safeHref(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function readTwMeta(meta: MarketCardMeta | null | undefined): TwCardMeta | null {
  const raw = meta?.ats_public as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || raw.country !== 'TW') return null;
  const pay = (raw.pay && typeof raw.pay === 'object' ? raw.pay : {}) as Record<string, unknown>;
  const source = (raw.source && typeof raw.source === 'object' ? raw.source : {}) as Record<string, unknown>;
  const permitTags: TwPermitTagView[] = [];
  for (const item of Array.isArray(raw.permitTags) ? raw.permitTags : []) {
    const t = item as Record<string, unknown>;
    const quote = str(t?.quote);
    // A tag without its quote is never shown (TW-09).
    if (!quote || !TW_PERMIT_TAGS.includes(t.tag as TwPermitTag)) continue;
    if (permitTags.some((p) => p.tag === t.tag)) continue;
    permitTags.push({ tag: t.tag as TwPermitTag, quote });
  }
  const board = str(source.board);
  return {
    country: 'TW',
    pay: {
      text: str(pay.text),
      posted: str(pay.posted),
      disclosed: pay.disclosed === true,
      negotiable: pay.negotiable === true && pay.disclosed !== true,
    },
    permitTags,
    source: {
      name: str(source.name),
      url: safeHref(source.url),
      board: board && board in PUBLIC_ATS_NAMES ? (board as TwCardMeta['source']['board']) : null,
    },
  };
}

/**
 * The attribution an open-data row must carry wherever it is shown
 * (政府資料開放授權條款 第1版: provider, year, dataset name, licence statement).
 * The sentence is the server's data, in Traditional Chinese for every locale;
 * `url` is the licence text, null when the server's value is not a safe link.
 */
export interface TwAttribution {
  text: string;
  url: string | null;
}

/** Longest attribution we render (the two sentences the server knows are under 80 characters). */
const MAX_ATTRIBUTION_CHARS = 300;

/**
 * Reads `meta.tw_sources` (the server's `TwSourcesCardMeta`, hook set
 * `tw_sources` in server/src/features/jobs/sources/twHooks.ts). Null when the
 * row has no attribution or the value is not one: nothing is rendered then.
 */
export function readTwSourcesMeta(meta: MarketCardMeta | null | undefined): { attribution: TwAttribution } | null {
  const raw = meta?.tw_sources as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const attribution = raw.attribution;
  if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) return null;
  const text = str((attribution as Record<string, unknown>).text);
  if (!text || text.length > MAX_ATTRIBUTION_CHARS) return null;
  return { attribution: { text, url: safeHref((attribution as Record<string, unknown>).url) } };
}

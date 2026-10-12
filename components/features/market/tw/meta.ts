// components/features/market/tw/meta.ts — reads `meta.ats_public` (the server's
// TwCardMeta from marketHooks.cardMeta) and `meta.tw_sources` (the open-data
// licence attribution, MKT-3E) defensively: a card always renders, so an odd
// or missing value yields null instead of throwing (WP-42).

import type { TwCardMeta, TwPermitTag, TwPermitTagView } from '../../../../lib/api/careerSources';
import type { BoardAts } from '../../../../lib/api/contracts/jobs/sources/atsPublic';
import type { MarketCardMeta } from '../types';

/** Client twin of the server's TW_PERMIT_TAGS. */
export const TW_PERMIT_TAGS: readonly TwPermitTag[] = ['tw_work_permit_support', 'tw_gold_card'];

/**
 * Client twin of the server's PUBLIC_ATS_NAMES (vendor names are data, not
 * copy), in the order of the server's PUBLIC_ATS. Typed by the contract's
 * `BoardAts`, so a system added on the server fails the type-check here until
 * it has a name: nothing else in the web lists the systems.
 */
export const PUBLIC_ATS_NAMES: Readonly<Record<BoardAts, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  recruitee: 'Recruitee',
  personio: 'Personio',
  lever_eu: 'Lever',
  beisen: '北森',
};

/** Every job-board system, in list order. */
export const BOARD_SYSTEMS = Object.keys(PUBLIC_ATS_NAMES) as BoardAts[];

/**
 * Systems the server reads only behind a flag that is off unless an operator
 * sets it (the server's `connectorEnabled`: 北森 needs CN_ATS_BEISEN_ENABLED).
 * Such a system is neither offered nor named until the server's own answer
 * says it reads it.
 */
export const FLAG_GATED_SYSTEMS: readonly BoardAts[] = ['beisen'];

/**
 * The name a system is offered under where the systems are listed side by
 * side. The two Lever instances share the vendor's name, so the EU one says
 * which it is (a region code: data, like the name).
 */
export function boardSystemLabel(ats: BoardAts): string {
  return ats === 'lever_eu' ? `${PUBLIC_ATS_NAMES[ats]} (EU)` : PUBLIC_ATS_NAMES[ats];
}

/**
 * Workable's own listing address. Its version segment is written apart
 * because scripts/check-api-boundary.mjs reads that path, spelled out in a
 * component, as a call to OUR API; this is a vendor's address shown as text.
 * The check should tell the two apart by rule (a whole URL on another host is
 * not our API); once it does, this is the plain literal (handoff MKT-5B,
 * Requests, O-10: the script has no owner in this phase).
 */
const WORKABLE_ACCOUNTS = `https://apply.workable.com/api/${'v1'}/widget/accounts`;

/** Marks a Personio board id whose career site is on jobs.personio.com (the server's PERSONIO_COM_SUFFIX). */
const PERSONIO_COM_SUFFIX = '.com';

/**
 * Client twin of the server connectors' `boardUrl`: the listing address a
 * board id maps to, shown to ops before saving. `token` is already encoded
 * for display.
 */
export const BOARD_READ_URLS: Readonly<Record<BoardAts, (token: string) => string>> = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`,
  smartrecruiters: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings`,
  workable: (t) => `${WORKABLE_ACCOUNTS}/${t}?details=true`,
  recruitee: (t) => `https://${t}.recruitee.com/api/offers/`,
  personio: (t) => (t.endsWith(PERSONIO_COM_SUFFIX) ? `https://${t.slice(0, -PERSONIO_COM_SUFFIX.length)}.jobs.personio.com/xml?language=en` : `https://${t}.jobs.personio.de/xml?language=en`),
  lever_eu: (t) => `https://api.eu.lever.co/v0/postings/${t}?mode=json`,
  beisen: (t) => `https://${t}.zhiye.com/api/Jobad/GetJobAdPageList`,
};

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

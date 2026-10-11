// server/src/features/jobs/sources/twHooks.ts — where a Taiwan row came from:
// the licence attribution of the open-data rows (MKT-3E; MARKET_STRATEGY §1.3,
// JT-2) and the provenance of rows read out of Google's job index (MKT-5F;
// §1.5 "Source label", JT-8). Statically imported by features/jobs/marketHooks.ts.
//
// Open data.
// The 政府資料開放授權條款 第1版 (OGDL v1) grants reuse only WITH attribution
// and voids itself without it. Its Exhibit asks for the provider, the year,
// the dataset's full name and the statement that the data is released under
// the licence. So every row of an open-data source carries exactly that
// sentence wherever it is shown, linked to the licence text:
//
//   afterNormalize  sourceName = the dataset's publisher label (台灣就業通);
//                   no separate "original source": the dataset is the
//                   original source.
//   cardMeta        { attribution: { text, url } } under the set id
//                   `tw_sources`, for the card and the job page (JobMetaTw).
//                   The year is the Taipei-time year the row was last seen in
//                   the dataset (of now when the row has no such date).
//
// The sentences are DATA, not UI copy: they are the licence's required
// wording, in Traditional Chinese for every locale, and they live here, not in
// an i18n bundle. The 台灣就業通 logo is never used (trademarks are outside the
// licence). Whether these rows may be listed on public pages stays governed by
// PUBLIC_DISPLAY_PROVIDERS (owner decision OPS-A4); this module only
// guarantees the attribution wherever a row is shown.
//
// Google's job index (JT-8). In Taiwan the JSearch provider is our window onto
// the postings 104, 1111 and other boards publish as job structured data: we
// do not read those boards, and we have no agreement with any of them. So a
// JSearch row located in Taiwan says exactly that, under the same set id:
//
//   cardMeta        { via: 'google_jobs', publisher, url }
//                   publisher  the original publisher as the row stores it
//                              (`originalSourceName`: 104人力銀行), null when
//                              none is known: the line then names only the
//                              search. Never a LinkedIn name (the normalizer
//                              drops it at ingest; it is checked again here),
//                              and never the aggregator's own name.
//                   url        the original posting (http or https, never a
//                              LinkedIn link), null when the row has none.
//
// The web prints "{publisher} · found through Google job search" from it
// (JobMetaTw). Nothing here names a partnership, and no board's logo is used.
// A row is one or the other: an open-data row never carries `via`, a JSearch
// row never carries an attribution. An employer-board row carries neither and
// keeps its "company · job board" line (sources/atsPublic/hooks.ts).
//
// Importing this module also registers the `tw_open_data` ingest adapter
// (./register.ts), because marketHooks is the module the pipeline always loads.

import type { MarketHookJob, MarketHookSet } from '../marketHooks.js';
import { PROVIDER_META, hostOf, isLinkedInBranded, isLinkedInHost, safeUrl } from '../normalize/index.js';
import './register.js';

/** 政府資料開放授權條款 第1版, the licence text every attribution links to. */
export const TW_OGDL_LICENCE_URL = 'https://data.gov.tw/license';

/**
 * The attribution sentence per open-data source, keyed by `RAJob.sourceBoard`:
 * provider, year, the dataset's full name, the licence statement.
 *   tw_open_data  dataset 44062, 勞動部勞動力發展署 (the 台灣就業通 sweep);
 *   tw_gov_jobs   dataset 7229, 行政院人事行政總處 (事求人; no adapter writes it yet).
 */
export const TW_OPEN_DATA_ATTRIBUTIONS: Readonly<Record<string, (year: number) => string>> = {
  tw_open_data: (year) => `資料來源：勞動部勞動力發展署 ${year}「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出`,
  tw_gov_jobs: (year) => `資料來源：行政院人事行政總處 ${year}「行政院人事行政總處事求人機關徵才資料」，依政府資料開放授權條款第1版公開釋出`,
};

/** The publisher label shown as a row's source name, per source board (data, not copy). */
export const TW_OPEN_DATA_SOURCE_NAMES: Readonly<Record<string, string>> = {
  tw_open_data: '台灣就業通',
  tw_gov_jobs: '事求人',
};

/** `RAJob.sourceBoard` of the rows read out of Google's job index (the JSearch provider). */
export const TW_GOOGLE_JOBS_BOARD = PROVIDER_META.jsearch.sourceBoard;

/**
 * What `cardMeta` returns under the set id (the web reads it defensively:
 * components/features/market/tw). An open-data row carries `attribution`; a
 * row found through Google's job index carries `via` with its publisher and
 * the original posting's link. Never both.
 */
export interface TwSourcesCardMeta {
  attribution?: { text: string; url: string };
  via?: 'google_jobs';
  /** The original publisher (104人力銀行); null when the row names none. */
  publisher?: string | null;
  /** The original posting; null when the row has no usable link. */
  url?: string | null;
}

const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The calendar year in Taipei (UTC+8, no daylight saving) of an instant. */
export function taipeiYear(at: Date): number {
  return new Date(at.getTime() + TAIPEI_OFFSET_MS).getUTCFullYear();
}

function boardOf(job: MarketHookJob): string | null {
  const board = typeof job.sourceBoard === 'string' ? job.sourceBoard.trim().toLowerCase() : '';
  return board && Object.hasOwn(TW_OPEN_DATA_ATTRIBUTIONS, board) ? board : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** The attribution of a row of an open-data source; null for every other row. Pure given `now`. */
export function twAttribution(job: MarketHookJob, now: Date = new Date()): TwSourcesCardMeta['attribution'] | null {
  const board = job.market === 'intl' ? boardOf(job) : null;
  if (!board) return null;
  const year = taipeiYear(toDate(job.lastSeenAt) ?? now);
  return { text: TW_OPEN_DATA_ATTRIBUTIONS[board]!(year), url: TW_OGDL_LICENCE_URL };
}

/** An open-data row names its dataset's publisher as the source; the dataset is the original source. */
export function withOpenDataSourceName(job: MarketHookJob): MarketHookJob {
  const board = boardOf(job);
  if (!board) return job;
  return { ...job, sourceName: TW_OPEN_DATA_SOURCE_NAMES[board] ?? job.sourceName, originalSourceName: null };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** True for a row of the international market, located in Taiwan, that was read out of Google's job index. */
export function isTwGoogleJobsRow(job: MarketHookJob): boolean {
  return job.market === 'intl' && text(job.sourceBoard)?.toLowerCase() === TW_GOOGLE_JOBS_BOARD && text(job.locationCountry)?.toUpperCase() === 'TW';
}

/** An http(s) link that is not LinkedIn's, or null. */
function originalLink(value: unknown): string | null {
  const url = safeUrl(text(value));
  return url && !isLinkedInHost(hostOf(url)) ? url : null;
}

/**
 * The provenance of a Taiwan row found through Google's job index; null for
 * every other row. `publisher` is the stored original publisher, unless it is
 * LinkedIn-branded or only repeats the aggregator's name: then the line names
 * the search alone (null). Pure.
 */
export function twGoogleJobsProvenance(job: MarketHookJob): Required<Pick<TwSourcesCardMeta, 'via' | 'publisher' | 'url'>> | null {
  if (!isTwGoogleJobsRow(job)) return null;
  const named = text(job.originalSourceName);
  const aggregator = PROVIDER_META.jsearch.aggregatorName?.toLowerCase() ?? '';
  const publisher = named && !isLinkedInBranded(named) && named.toLowerCase() !== aggregator ? named : null;
  return { via: 'google_jobs', publisher, url: originalLink(job.sourceUrl) ?? originalLink(job.applyUrl) };
}

export interface TwSourcesHookDeps {
  now?: () => Date;
}

export function createTwSourcesHooks(deps: TwSourcesHookDeps = {}): MarketHookSet {
  return {
    id: 'tw_sources',
    appliesTo: (job) => job.market === 'intl' && (boardOf(job) !== null || isTwGoogleJobsRow(job)),
    // Only an open-data row gets a source name here; every other row is returned as it came.
    afterNormalize: (job) => withOpenDataSourceName(job),
    cardMeta: (job) => {
      const attribution = twAttribution(job, deps.now?.() ?? new Date());
      if (attribution) return { attribution } satisfies TwSourcesCardMeta;
      return twGoogleJobsProvenance(job) satisfies TwSourcesCardMeta | null;
    },
  };
}

export const twSourcesHooks: MarketHookSet = createTwSourcesHooks();

// server/src/features/jobs/normalize/source.ts
//
// Where a job came from: provider metadata (dedupe priority, the RAJob
// sourceBoard, the aggregator's display name) and the source line fields
// (sourceName = aggregator or bank, originalSourceName = original publisher,
// originalHost = the original posting's host).
//
// H9 / F-FEED-08: no LinkedIn branding on any source field. A LinkedIn
// publisher name or linkedin.com URL is never written to sourceName,
// originalSourceName, originalHost or sourceUrl; the source line falls back
// to the aggregator and the employer's own host. Applicant counts are never
// taken from the 'linkedin' or 'jsearch' providers (they are LinkedIn
// click counts, not applications).

import { isJobBoardHost } from './ats.js';
import { cleanOrNull, hostOf, safeUrl } from './text.js';
import type { NormalizeProvider } from './types.js';

export interface ProviderMeta {
  /** Lower wins when duplicates collapse to one canonical row (ARCH §4.2). */
  sourcePriority: number;
  /** Default RAJob.sourceBoard. */
  sourceBoard: string;
  /** Display name of the aggregator / bank, or null when the posting itself is the source. */
  aggregatorName: string | null;
  /** May this provider's data ever carry an applicant count? */
  applicantCountAllowed: boolean;
  fromRecruiterBank: boolean;
}

/**
 * One entry per provider. `activejobs_feed` (the licensed window feed, JI-7)
 * writes the same `sourceBoard` as the `activejobs` search provider, so both
 * address the same rows. KEY ORDER MATTERS for that pair: the feed's entry
 * sits BEFORE `activejobs`, so a reader that builds a board → provider map
 * from this object in key order (`providerOfBoard` in ingest/verifyFeed.ts)
 * keeps resolving the board 'activejobs' to the search provider
 * (normalizeProviderJob.test.ts pins it).
 *
 * Priorities (lower wins): usajobs 8 (the federal government's own listing),
 * activejobs / activejobs_feed / ats_public 10, the Taiwan government sources
 * 12, the recruiter banks 15, linkedin 20, jsearch 30, user_import 90.
 * A government open-data source publishes no applicant count.
 */
export const PROVIDER_META: Readonly<Record<NormalizeProvider, ProviderMeta>> = {
  activejobs_feed: { sourcePriority: 10, sourceBoard: 'activejobs', aggregatorName: 'Active Jobs DB', applicantCountAllowed: true, fromRecruiterBank: false },
  activejobs: { sourcePriority: 10, sourceBoard: 'activejobs', aggregatorName: 'Active Jobs DB', applicantCountAllowed: true, fromRecruiterBank: false },
  ats_public: { sourcePriority: 10, sourceBoard: 'ats_public', aggregatorName: null, applicantCountAllowed: true, fromRecruiterBank: false },
  bank_robohire: { sourcePriority: 15, sourceBoard: 'robohire', aggregatorName: 'RoboHire', applicantCountAllowed: true, fromRecruiterBank: true },
  bank_gohire: { sourcePriority: 15, sourceBoard: 'gohire', aggregatorName: 'GoHire', applicantCountAllowed: true, fromRecruiterBank: true },
  linkedin: { sourcePriority: 20, sourceBoard: 'linkedin', aggregatorName: 'Fantastic Jobs', applicantCountAllowed: false, fromRecruiterBank: false },
  jsearch: { sourcePriority: 30, sourceBoard: 'jsearch', aggregatorName: 'JSearch', applicantCountAllowed: false, fromRecruiterBank: false },
  user_import: { sourcePriority: 90, sourceBoard: 'user_import', aggregatorName: null, applicantCountAllowed: false, fromRecruiterBank: false },
  tw_open_data: { sourcePriority: 12, sourceBoard: 'tw_open_data', aggregatorName: '台灣就業通', applicantCountAllowed: false, fromRecruiterBank: false },
  tw_gov_jobs: { sourcePriority: 12, sourceBoard: 'tw_gov_jobs', aggregatorName: '事求人', applicantCountAllowed: false, fromRecruiterBank: false },
  usajobs: { sourcePriority: 8, sourceBoard: 'usajobs', aggregatorName: 'USAJOBS', applicantCountAllowed: false, fromRecruiterBank: false },
};

/**
 * Providers whose applicant counts are never stored: LinkedIn-derived click
 * counts (linkedin, jsearch) and sources that publish no count at all (the
 * government open-data sources).
 */
export const NO_APPLICANT_COUNT_PROVIDERS: readonly NormalizeProvider[] = (Object.keys(PROVIDER_META) as NormalizeProvider[]).filter(
  (p) => !PROVIDER_META[p].applicantCountAllowed && p !== 'user_import',
);

const LINKEDIN_RE = /linked\s*-?\s*in|lnkd\.in|領英|领英/i;

export function isLinkedInBranded(value: string | null | undefined): boolean {
  return !!value && LINKEDIN_RE.test(value);
}

export function isLinkedInHost(host: string | null): boolean {
  return !!host && (host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in');
}

/** LinkedIn pages and its media CDN (media.licdn.com logo hotlinks). */
export function isLinkedInAssetHost(host: string | null): boolean {
  return isLinkedInHost(host) || (!!host && (host === 'licdn.com' || host.endsWith('.licdn.com')));
}

const ATS_DISPLAY: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  icims: 'iCIMS',
  workable: 'Workable',
  taleo: 'Taleo',
  successfactors: 'SuccessFactors',
};

/** "greenhouse" → "Greenhouse"; free text kept as written. */
function publisherDisplay(name: string | null): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return ATS_DISPLAY[key] ?? name.trim();
}

export interface SourceFields {
  sourceBoard: string;
  sourcePriority: number;
  sourceName: string | null;
  originalSourceName: string | null;
  originalHost: string | null;
  sourceUrl: string | null;
  fromRecruiterBank: boolean;
}

export interface SourceInput {
  provider: NormalizeProvider;
  sourceBoard?: string | null;
  sourcePublisher?: string | null;
  sourceUrl?: string | null;
  applyUrl?: string | null;
}

/**
 * The source line: aggregator (or bank) + original publisher + original host,
 * never LinkedIn. For ats_public the ATS is the source board and the publisher.
 */
export function sourceFields(input: SourceInput): SourceFields {
  const meta = PROVIDER_META[input.provider];
  const board = cleanOrNull(input.sourceBoard)?.toLowerCase() ?? meta.sourceBoard;

  const candidates = [safeUrl(input.sourceUrl ?? null), safeUrl(input.applyUrl ?? null)];
  const nonLinkedIn = candidates.filter((u): u is string => !!u && !isLinkedInHost(hostOf(u)));
  const sourceUrl = nonLinkedIn[0] ?? null;
  // The original host is the employer / ATS host when we have one; a job board's host is still a real source.
  const hosts = nonLinkedIn.map((u) => hostOf(u)).filter((h): h is string => !!h);
  const originalHost = hosts.find((h) => !isJobBoardHost(h)) ?? hosts[0] ?? null;

  let publisher = publisherDisplay(cleanOrNull(input.sourcePublisher));
  if (input.provider === 'ats_public') publisher ??= publisherDisplay(board);
  if (isLinkedInBranded(publisher)) publisher = null;

  const sourceName = input.provider === 'ats_public' ? publisher : meta.aggregatorName;
  return {
    sourceBoard: board,
    sourcePriority: meta.sourcePriority,
    sourceName: isLinkedInBranded(sourceName) ? null : sourceName,
    originalSourceName: publisher && publisher !== sourceName ? publisher : null,
    originalHost,
    sourceUrl,
    fromRecruiterBank: meta.fromRecruiterBank,
  };
}

/** True when this provider may carry an applicant count at all (never linkedin / jsearch). */
export function applicantCountAllowed(provider: NormalizeProvider): boolean {
  return PROVIDER_META[provider].applicantCountAllowed;
}

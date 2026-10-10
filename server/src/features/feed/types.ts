// server/src/features/feed/types.ts — internal row and context types of the feed (WP-32).

import type { Market } from '../../platform/brand/registry.js';
import type { MatchJobRecord } from '../match/index.js';

/** One RAJob row as `FEED_COLUMNS` (sql.ts) selects it, with the company join. */
export interface FeedJobRow {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  title: string;
  titleNormalized: string;
  companyName: string;
  companyNameNormalized: string;
  companyId: string | null;
  companyLogoUrl: string | null;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  seniority: string | null;
  roleType: string | null;
  minYears: number | null;
  maxYears: number | null;
  educationLevel: string | null;
  skills: string[];
  skillsDetail: unknown;
  workModel: string | null;
  remoteScope: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  geoLat: number | null;
  geoLng: number | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryDisclosed: boolean;
  salaryText: string | null;
  salaryMonths: number | null;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  citizenshipRequired: boolean | null;
  clearanceRequired: boolean | null;
  employerTags: string[];
  marketTags: unknown;
  postedAt: Date | null;
  postedAtEstimated: boolean;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  expiresAt: Date | null;
  sourceBoard: string;
  sourceName: string | null;
  originalSourceName: string | null;
  atsType: string | null;
  isAgency: boolean | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  sourcePriority: number | null;
  archivedAt: Date | null;
  hasBenefits: boolean | null;
  descriptionLength: number | null;
  companyIndustries: string[] | null;
  companySizeBand: string | null;
  companyFacts: unknown;
  companyDisplayName: string | null;
  companyLogo: string | null;
}

/** Who and where a feed call runs for. */
export interface FeedCtx {
  userId: string;
  market: Market;
  brandId: string;
  now: Date;
}

/** The matcher's view of a feed row (description fields are not read by the pre-score). */
export function toMatchRecord(row: FeedJobRow): MatchJobRecord {
  return {
    id: row.id,
    market: row.market,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    title: row.title,
    companyName: row.companyName,
    description: '',
    descriptionPlain: '',
    qualifications: null,
    responsibilities: null,
    benefits: null,
    taxonomyIds: row.taxonomyIds ?? [],
    primaryTaxonomyId: row.primaryTaxonomyId,
    seniority: row.seniority,
    minYears: row.minYears,
    maxYears: row.maxYears,
    educationLevel: row.educationLevel,
    skills: row.skills ?? [],
    skillsDetail: row.skillsDetail,
    workModel: row.workModel,
    remoteScope: row.remoteScope,
    location: row.location,
    locationCity: row.locationCity,
    locationCountry: row.locationCountry,
    geoLat: row.geoLat,
    geoLng: row.geoLng,
    salaryAnnualMin: row.salaryAnnualMin,
    salaryAnnualMax: row.salaryAnnualMax,
    salaryCurrency: row.salaryCurrency,
    sponsorship: row.sponsorship,
    sponsorshipEvidence: row.sponsorshipEvidence,
    marketTags: row.marketTags,
    archivedAt: row.archivedAt,
    companyIndustries: row.companyIndustries ?? [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** marketTags entries `{ tag, evidenceQuote? }` (anything else is ignored). */
export function marketTagsOf(v: unknown): Array<{ tag: string; evidenceQuote: string | null }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .filter((t) => typeof t.tag === 'string')
    .map((t) => ({ tag: t.tag as string, evidenceQuote: typeof t.evidenceQuote === 'string' && t.evidenceQuote.trim() ? t.evidenceQuote : null }));
}

/** Required skills of a posting: `skillsDetail[].required`, else every listed skill. */
export function requiredSkills(row: Pick<FeedJobRow, 'skills' | 'skillsDetail'>): string[] {
  if (Array.isArray(row.skillsDetail)) {
    const req = row.skillsDetail.filter(isRecord).filter((s) => s.required === true && typeof s.skill === 'string').map((s) => s.skill as string);
    if (req.length) return req;
  }
  return row.skills ?? [];
}

const APPLY_CLOSES = /^apply_closes:(\d{4}-\d{2}-\d{2})/;

/**
 * The posting's own stated application close date (GoApply 网申截止), from
 * marketTags `apply_closes:<yyyy-mm-dd>` entries with an evidence quote: the
 * earliest date on or after `today`, else the latest one already past. Null
 * when nothing is stated. RAJob.expiresAt is never used: for most providers
 * it is postedAt + 45 days, an estimate (D3).
 */
export function statedApplyClose(marketTags: unknown, today: string): { date: string; quote: string; upcoming: boolean } | null {
  const stated = marketTagsOf(marketTags)
    .map((t) => ({ m: t.tag.match(APPLY_CLOSES), quote: t.evidenceQuote }))
    .filter((x): x is { m: RegExpMatchArray; quote: string } => !!x.m && !!x.quote && !Number.isNaN(Date.parse(x.m[1]!)))
    .map((x) => ({ date: x.m[1]!, quote: x.quote }));
  if (!stated.length) return null;
  const upcoming = stated.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) return { ...upcoming[0]!, upcoming: true };
  const past = stated.sort((a, b) => b.date.localeCompare(a.date))[0]!;
  return { ...past, upcoming: false };
}

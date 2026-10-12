// server/src/features/jobs/detail/view.ts — pure mappers for job detail (WP-34).
//
// No I/O here: rows in, wire views out, so every honesty rule is unit-tested.
//   - pay: only what the posting (or provider) states; never 0, never estimated;
//   - sponsorship / requirement lines: only with the posting's own words (C18,
//     H36). A provider's reading that the job sponsors is its own field and
//     its own badge kind, named after the provider, never worded as the
//     posting's statement; a provider's "does not sponsor" alone is nothing
//     (feed contract `sponsorshipSignalOf`, JI-11);
//   - badges: at most 3, from real fields; "Direct from employer" only when the
//     job came from our recruiter bank, the bank verified the employer and it
//     is not an agency (D3). "New" is not one of them: it is the field `isNew`;
//   - dates (JI-10): three separate facts. `postedAt` is the employer's date
//     or null (a date we assigned never travels under that name),
//     `firstSeenAt` is ours, `lastSeenAt` is when a source last confirmed the
//     posting listed; `isNew` rests on `firstSeenAt` alone;
//   - share: the public page only when the provider licence allows public
//     display (`publicDisplay`), else the app link;
//   - People: LinkedIn search links the user opens themselves; we fetch nothing;
//   - source and apply contract: the same rule as the feed card
//     (feed/sourceLine.ts), so the card and the page never disagree. `salary`
//     is null when the posting states no pay; on GoApply the line is the
//     posting's own words or the mainland notation of its figures (cn/jobs
//     card.ts `cnSalary`).

import type { ProductBrand } from '../../../platform/brand/registry.js';
import { cnSalary } from '../../cn/jobs/contract.js';
import {
  applyLinkOf,
  bankListable,
  hasPayFigure,
  isNewPosting,
  salaryLineOf,
  sourceFactsOf,
  sourceKindOf,
  sponsorshipSignalOf,
  type FeedItem,
  type FitBadge,
  type SalaryLine,
} from '../../feed/contract.js';
import { toWireKind } from '../../match/contract.js';
import type { Fit } from '../../match/index.js';
import { htmlToPlain, payPlausible, statesAmount } from '../normalize/index.js';
import { bestTaxonomyMatch, taxonomyLabel } from '../taxonomy/index.js';
import { findCity, resolveCountry } from '../geo/index.js';
import {
  JOB_REQUIREMENT_TAGS,
  PRE_APPLY_STATUSES,
  type CompanySummary,
  type JobCampusInfo,
  type JobChecklist,
  type JobDetail,
  type JobListing,
  type JobPay,
  type JobRequirementTag,
  type JobTrackerState,
  type PeopleSearchLink,
  type SimilarJobItem,
} from './contract.js';
import type { CompanyProfile } from '../companies/contract.js';

/** Columns job detail reads (typed Prisma `select`). */
export const JOB_ROW_SELECT = {
  id: true,
  title: true,
  titleNormalized: true,
  companyId: true,
  companyName: true,
  companyLogoUrl: true,
  location: true,
  locationCountry: true,
  workModel: true,
  employmentType: true,
  seniority: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryText: true,
  salaryDisclosed: true,
  description: true,
  qualifications: true,
  responsibilities: true,
  benefits: true,
  summary: true,
  skillsDetail: true,
  sponsorship: true,
  sponsorshipEvidence: true,
  // 'posting_quote' or 'provider:<provider id>': whose word a stored sponsorship value is (JI-11).
  sponsorshipSource: true,
  marketTags: true,
  fraudFlags: true,
  applyUrl: true,
  atsType: true,
  postedAt: true,
  postedAtEstimated: true,
  firstSeenAt: true,
  lastSeenAt: true,
  closedAt: true,
  archivedAt: true,
  sourceBoard: true,
  sourceName: true,
  originalSourceName: true,
  sourceUrl: true,
  fromRecruiterBank: true,
  employerVerified: true,
  isAgency: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  isCanonical: true,
  publicDisplay: true,
  slug: true,
  primaryTaxonomyId: true,
  // Read by the market card hooks only (marketHooks.cardMeta → JobMetaCn / JobMetaTw):
  // every location of the posting, the plain posting text a quoted tag is re-checked
  // against, the stated N薪 and the source's own expiry date.
  locations: true,
  descriptionPlain: true,
  salaryMonths: true,
  expiresAt: true,
  // Read by the posting check only (jobs/liveness): the posting's id on its ATS, and a board row's own id.
  atsPostingKey: true,
  externalId: true,
} as const;

export interface JobRow {
  id: string;
  title: string;
  titleNormalized: string;
  companyId: string | null;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCountry: string | null;
  workModel: string | null;
  employmentType: string | null;
  seniority: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryText: string | null;
  salaryDisclosed: boolean;
  description: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  summary: string | null;
  skillsDetail: unknown;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  /** Whose word `sponsorship` is: 'posting_quote', 'provider:<id>', or null (absent on rows built by older callers and fixtures). */
  sponsorshipSource?: string | null;
  marketTags: unknown;
  fraudFlags: unknown;
  applyUrl: string;
  atsType: string | null;
  postedAt: Date | null;
  postedAtEstimated: boolean;
  /** When ingest first wrote the row (absent on rows built by older callers and fixtures). */
  firstSeenAt?: Date | null;
  lastSeenAt: Date;
  closedAt: Date | null;
  archivedAt: Date | null;
  sourceBoard: string;
  sourceName: string | null;
  originalSourceName: string | null;
  sourceUrl: string | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean | null;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  isCanonical: boolean;
  publicDisplay: boolean;
  slug: string | null;
  primaryTaxonomyId: string | null;
  /** `[{ city, region, country, lat, lng }]` (market card hooks). */
  locations?: unknown;
  descriptionPlain?: string | null;
  salaryMonths?: number | null;
  expiresAt?: Date | null;
  /** `<ats>:<tenant>:<postingId>` when one of the posting's links names a posting on an ATS (ingest writes it). */
  atsPostingKey?: string | null;
  externalId?: string | null;
}

/** Same market as the brand; a private (imported) job only for its owner. */
export function isVisibleTo(row: Pick<JobRow, 'market' | 'visibility' | 'ownerUserId'>, userId: string, market: string): boolean {
  if (row.market !== market) return false;
  return row.visibility === 'public' || (row.visibility === 'private' && row.ownerUserId === userId);
}

export function isClosed(row: Pick<JobRow, 'closedAt' | 'archivedAt'>): boolean {
  return row.closedAt != null || row.archivedAt != null;
}

const PAY_PERIODS = new Set(['year', 'month', 'week', 'day', 'hour']);
const API_BOARDS = new Set(['activejobs', 'linkedin', 'jsearch']);

/** Stated pay only. Null renders "Pay not listed" (never 0). */
export function toPay(row: Pick<JobRow, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod' | 'salaryText' | 'salaryDisclosed'>): JobPay | null {
  const positive = (n: number | null) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
  const min = positive(row.salaryMin);
  const max = positive(row.salaryMax);
  if (!row.salaryDisclosed || (min == null && max == null) || !row.salaryCurrency || !PAY_PERIODS.has(row.salaryPeriod ?? '')) return null;
  // A stored figure that cannot be pay for its period ("$60,000,000 an hour") is never shown as a number.
  if (!payPlausible({ min, max, currency: row.salaryCurrency, period: row.salaryPeriod, months: (row as { salaryMonths?: number | null }).salaryMonths ?? null })) return null;
  return { min, max, currency: row.salaryCurrency, period: row.salaryPeriod as JobPay['period'], text: clean(row.salaryText) };
}

/**
 * "Pay as stated": the post's own pay words, only when there is no numeric pay
 * to show and the words carry an amount. "Competitive pay and benefits" and
 * 面議 are not pay a reader can use, so they render "Pay not listed".
 */
export function toPayText(row: Pick<JobRow, 'salaryText'> & Partial<Pick<JobRow, 'locationCountry' | 'market'>>, pay: JobPay | null): string | null {
  if (pay) return null;
  const text = clean(row.salaryText);
  // The row's own country and market decide which clauses are a statutory line and no amount (Taiwan's threshold).
  const market = row.market === 'cn' ? 'cn' : row.market === 'intl' ? 'intl' : undefined;
  return text && statesAmount(text, { country: row.locationCountry ?? null, ...(market ? { market } : {}) }) ? text : null;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

/**
 * The posting's own sections, verbatim; the full description when none were split out.
 * The description is its text: an employer board's row keeps the posting's HTML in
 * `description` and the same words as text in `descriptionPlain` (ingest), and the page
 * renders a section as Markdown, which drops raw HTML blocks whole. Sent as HTML, every
 * board posting showed an empty "About the job".
 */
export function toSections(row: Pick<JobRow, 'responsibilities' | 'qualifications' | 'benefits' | 'description' | 'descriptionPlain'>): JobDetail['sections'] {
  const out: JobDetail['sections'] = [];
  const r = clean(row.responsibilities);
  const q = clean(row.qualifications);
  const b = clean(row.benefits);
  if (r) out.push({ kind: 'responsibilities', body: r });
  if (q) out.push({ kind: 'qualifications', body: q });
  if (b) out.push({ kind: 'benefits', body: b });
  const d = clean(row.descriptionPlain) ?? clean(htmlToPlain(row.description));
  if (!out.length && d) out.push({ kind: 'description', body: d });
  return out;
}

/**
 * Who the view is built for. `providerReading`: a provider's reading of
 * sponsorship is shown to this reader on this row (feed contract
 * `sponsorshipLabelsShown`: an international row, and a person who needs
 * sponsorship in the job's country). Absent → not shown: a caller that does
 * not know the reader never prints one.
 */
export interface ViewReader {
  providerReading?: boolean;
}

/**
 * Sponsorship with the posting's quote; a status without a quote is "not
 * stated" (C18). Where the posting states nothing and a provider's reading
 * says the job sponsors, that reading rides beside it under the provider's
 * name (`providerReading`), for a reader it is shown to (`ViewReader`); the
 * status stays 'not_stated', because the posting did not state it. One rule
 * with the feed card (`sponsorshipSignalOf`, `sponsorshipLabelsShown`).
 */
export function toSponsorship(row: Pick<JobRow, 'sponsorship' | 'sponsorshipEvidence' | 'sponsorshipSource'>, reader: ViewReader = {}): JobDetail['sponsorship'] {
  const signal = sponsorshipSignalOf(row);
  if (signal?.basis === 'quote') return { status: signal.status, quote: signal.quote };
  if (signal?.basis === 'provider' && reader.providerReading === true) {
    return { status: 'not_stated', quote: null, providerReading: { status: 'offered', provider: signal.provider } };
  }
  return { status: 'not_stated', quote: null };
}

/** Does the row carry a provider's reading of sponsorship at all (whoever reads it)? The service asks who the reader is only then. */
export function carriesProviderReading(row: Pick<JobRow, 'sponsorship' | 'sponsorshipEvidence' | 'sponsorshipSource'>): boolean {
  return sponsorshipSignalOf(row)?.basis === 'provider';
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
}

/** Citizenship / clearance lines from `marketTags`, each with its quote. */
export function toRequirements(marketTags: unknown): JobDetail['requirements'] {
  const out: JobDetail['requirements'] = [];
  for (const t of asArray(marketTags)) {
    const tag = t.tag;
    const quote = typeof t.evidenceQuote === 'string' ? t.evidenceQuote.trim() : '';
    if (typeof tag === 'string' && (JOB_REQUIREMENT_TAGS as readonly string[]).includes(tag) && quote && !out.some((o) => o.tag === tag)) {
      out.push({ tag: tag as JobRequirementTag, quote });
    }
  }
  return out;
}

export function toSkills(skillsDetail: unknown): JobDetail['skills'] {
  return asArray(skillsDetail)
    .filter((s) => typeof s.skill === 'string' && s.skill.trim())
    .map((s) => ({ skill: String(s.skill), kind: s.kind === 'soft' ? ('soft' as const) : ('hard' as const), required: s.required === true }));
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return /(^|\.)linkedin\.com$/i.test(h) ? null : h;
  } catch {
    return null;
  }
}

/** The columns the source and apply contract reads. */
export type SourceRow = Pick<
  JobRow,
  'fromRecruiterBank' | 'sourceBoard' | 'sourceName' | 'originalSourceName' | 'sourceUrl' | 'applyUrl' | 'companyName' | 'lastSeenAt' | 'visibility'
>;

/**
 * The source line of the job page. `kind` keeps the page's own reading (a
 * board the page does not know as an aggregator reads as a public board, as it
 * always has); the contract facts (`original`, `url`, `lastVerifiedAt`, `via`)
 * come from the shared rule, which calls a row an employer board only when its
 * source is a known board (feed/sourceLine.ts `sourceKindOf`, D3).
 */
export function sourceOf(row: Pick<JobRow, 'fromRecruiterBank' | 'sourceBoard' | 'sourceName' | 'originalSourceName' | 'sourceUrl'> & Partial<SourceRow>): JobDetail['source'] {
  const kind: JobDetail['source']['kind'] = row.fromRecruiterBank
    ? 'bank'
    : row.sourceBoard === 'user_import'
      ? 'user_import'
      : API_BOARDS.has(row.sourceBoard)
        ? 'provider'
        : 'ats_public';
  const facts = sourceFactsOf({ ...row, companyName: row.companyName ?? '' }, sourceKindOf(row));
  return { name: row.sourceName ?? row.originalSourceName ?? hostOf(row.sourceUrl) ?? '', kind, originalName: row.originalSourceName, ...facts };
}

/** The posting's own apply link and where it leads (feed/sourceLine.ts); null without a usable link. */
export function applyOf(row: Pick<JobRow, 'applyUrl' | 'sourceBoard' | 'fromRecruiterBank' | 'visibility'>): JobDetail['apply'] {
  return applyLinkOf(row, sourceKindOf(row));
}

/**
 * Pay as posted for the contract's `salary`; null when the posting states no
 * pay. Mainland rows use the card's own line (`cnSalary`: the posting's words
 * when they carry a figure, else the mainland notation of the stated figures;
 * 面议 is not disclosed pay). `salary` is never null while `pay` holds
 * figures: pay the mainland notation cannot write keeps its figures.
 */
export function toSalary(row: Pick<JobRow, 'market' | 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod' | 'salaryText' | 'salaryDisclosed' | 'salaryMonths'>, pay: JobPay | null, payText: string | null): SalaryLine | null {
  if (row.market !== 'cn') return salaryLineOf(pay, pay?.text ?? payText, null);
  const line = cnSalary(row as unknown as Record<string, unknown>);
  if (line.disclosed && line.text) return salaryLineOf(pay, line.text, row.salaryMonths ?? null);
  // Stated pay the mainland notation has no line for (another currency, a weekly rate) is still stated pay.
  return hasPayFigure(pay) ? salaryLineOf(pay, pay?.text ?? payText, row.salaryMonths ?? null) : null;
}

/**
 * Badge rules shared with the feed card (WP-33): ≤3, real fields only. "New"
 * is not a badge of this list: it is the field `isNew`, which rests on when
 * we first saw the posting and never on its posted date. The posting's own
 * quoted statement is a badge for every reader (as it always was on this
 * page); a provider's reading only for a reader it is shown to (`ViewReader`:
 * the card's rule, so the page and the card agree).
 */
export function toBadges(
  row: Pick<JobRow, 'fromRecruiterBank' | 'employerVerified' | 'isAgency' | 'sponsorship' | 'sponsorshipEvidence' | 'sponsorshipSource'>,
  _now?: Date,
  reader: ViewReader = {},
): FeedItem['badges'] {
  const out: FeedItem['badges'] = [];
  if (row.fromRecruiterBank && row.employerVerified && row.isAgency !== true) out.push({ kind: 'direct_from_employer', label: 'direct_from_employer' });
  const signal = sponsorshipSignalOf(row);
  if (signal?.basis === 'quote' && signal.status === 'offered') out.push({ kind: 'sponsorship', label: 'offered', quote: signal.quote });
  // A provider's reading: its own kind, the provider named, no quote.
  else if (signal?.basis === 'provider' && reader.providerReading === true) out.push({ kind: 'sponsorship_provider', label: 'sponsorship_provider', provider: signal.provider });
  return out.slice(0, 3);
}

const isoOf = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** The employer's own date on the wire: null when the stored date is one we assigned. */
export function toPostedAt(row: Pick<JobRow, 'postedAt' | 'postedAtEstimated'>): string | null {
  return row.postedAtEstimated ? null : isoOf(row.postedAt);
}

/** What the posting check found in this request, when it asked the ATS's posting API. */
export interface ListingCheck {
  checkedAt: Date;
}

/**
 * `job.listing`: when and how the status was last confirmed. A job nobody
 * lists (the user's own import) has neither. With the answer of this
 * request's posting check: that moment, 'ats_api'. Otherwise our own records:
 * the last sighting of an open job, the closing of a closed one.
 */
export function toListing(row: Pick<JobRow, 'visibility' | 'sourceBoard' | 'lastSeenAt' | 'closedAt' | 'archivedAt'>, check: ListingCheck | null = null): JobListing {
  if (row.visibility !== 'public' || row.sourceBoard === 'user_import') return { checkedAt: null, via: null };
  if (check) return { checkedAt: check.checkedAt.toISOString(), via: 'ats_api' };
  const at = isClosed(row) ? (row.closedAt ?? row.archivedAt) : row.lastSeenAt;
  return at ? { checkedAt: new Date(at).toISOString(), via: 'sync' } : { checkedAt: null, via: null };
}

const WORK_MODELS = new Set(['remote', 'hybrid', 'onsite']);

export function toJobDetail(row: JobRow, now: Date, campus: JobCampusInfo | null = null, check: ListingCheck | null = null, reader: ViewReader = {}): JobDetail {
  const pay = toPay(row);
  const payText = toPayText(row, pay);
  const summary = clean(row.summary);
  return {
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    location: clean(row.location),
    workModel: WORK_MODELS.has(row.workModel ?? '') ? (row.workModel as JobDetail['workModel']) : null,
    employmentType: row.employmentType,
    seniority: row.seniority,
    pay,
    payText,
    salary: toSalary(row, pay, payText),
    summary: summary ? { text: summary, aiWritten: true } : null,
    sections: toSections(row),
    skills: toSkills(row.skillsDetail),
    sponsorship: toSponsorship(row, reader),
    requirements: toRequirements(row.marketTags),
    // A recruiter-bank row whose bank has no posting page hands out no link at all (the stored one is "Page not found").
    applyUrl: bankListable(row) ? clean(row.applyUrl) : null,
    apply: applyOf(row),
    // Three date facts, each under its own name: the employer's date (never one we assigned), our first sight, the last sighting.
    postedAt: toPostedAt(row),
    postedAtEstimated: row.postedAtEstimated,
    firstSeenAt: isoOf(row.firstSeenAt),
    lastSeenAt: isoOf(row.lastSeenAt),
    isNew: isNewPosting(row.firstSeenAt, now),
    closedAt: (row.closedAt ?? row.archivedAt)?.toISOString() ?? null,
    status: isClosed(row) ? 'closed' : 'open',
    listing: toListing(row, check),
    source: sourceOf(row),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    badges: toBadges(row, now, reader),
    campus,
  };
}

export function toCompanySummary(row: Pick<JobRow, 'companyId' | 'companyName' | 'companyLogoUrl'>, profile: CompanyProfile | null): CompanySummary {
  if (!profile) {
    return { id: row.companyId, name: row.companyName, slug: null, logoUrl: row.companyLogoUrl, domain: null, facts: {}, openJobs: null };
  }
  return {
    id: profile.id,
    name: profile.name,
    slug: profile.slug,
    logoUrl: profile.logoUrl ?? row.companyLogoUrl,
    domain: profile.domain,
    facts: profile.facts,
    openJobs: profile.openJobs,
  };
}

/**
 * The feed card's fit badge from THE fit (null score → no badge, never 0):
 * the same fields the feed builds from the same `Fit` (feed/ranking.ts
 * `fitBadge`; a test keeps the two equal). The kind is kept: a stored AI score
 * is the number the feed card shows and is not labelled "Quick estimate"; an
 * estimate carries its confidence and, when that is low, the reason.
 */
export function toFitBadge(fit: Fit | null | undefined): FitBadge | null {
  if (!fit || fit.score === null || fit.tier === null) return null;
  return {
    tier: fit.tier,
    score: fit.score,
    kind: toWireKind(fit.kind),
    topGap: fit.topGap,
    topOverlap: fit.topOverlap,
    confidence: fit.confidence,
    confidenceReason: fit.confidenceReason,
  };
}

/**
 * A similar job as a feed card; pay keeps the posting's own period (weekly
 * too) and its words-only text. `cardMeta` is the market card lines of a row
 * that owes a credit line, for a caller that prints it (left off otherwise).
 */
export function toSimilarItem(
  row: JobRow,
  now: Date,
  fit: FitBadge | null,
  tracker: { status: string } | null,
  cardMeta: Record<string, Record<string, unknown>> | null = null,
  reader: ViewReader = {},
): SimilarJobItem {
  const pay = toPay(row);
  const payText = toPayText(row, pay);
  const source = sourceOf(row);
  return {
    ...(cardMeta && Object.keys(cardMeta).length ? { cardMeta } : {}),
    jobId: row.id,
    title: row.title,
    company: { id: row.companyId, name: row.companyName, logoUrl: row.companyLogoUrl },
    location: clean(row.location),
    workModel: WORK_MODELS.has(row.workModel ?? '') ? (row.workModel as FeedItem['workModel']) : null,
    employmentType: row.employmentType,
    seniority: row.seniority,
    pay,
    payText,
    salary: toSalary(row, pay, payText),
    postedAt: toPostedAt(row),
    postedAtEstimated: row.postedAtEstimated,
    firstSeenAt: isoOf(row.firstSeenAt),
    lastSeenAt: isoOf(row.lastSeenAt),
    isNew: isNewPosting(row.firstSeenAt, now),
    source: { name: source.name, kind: source.kind, original: source.original, url: source.url, lastVerifiedAt: source.lastVerifiedAt, ...(source.via ? { via: source.via } : {}) },
    apply: applyOf(row),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    badges: toBadges(row, now, reader),
    fit,
    tracker,
  };
}

/** Jobs carrying any fraud flag stay out of recommendations until reviewed (WP-17, WP-41). */
export function isFlagged(fraudFlags: unknown): boolean {
  return asArray(fraudFlags).length > 0;
}

// ── Share ─────────────────────────────────────────────────────────────────

/** URL slug from a title (ASCII; CJK titles fall back to the id alone). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Public page `/job/<id>-<slug>` (R-05) only with `publicDisplay` on a live public canonical job; else the app link. */
export function shareTarget(
  brand: Pick<ProductBrand, 'canonicalOrigin'>,
  row: Pick<JobRow, 'id' | 'title' | 'slug' | 'publicDisplay' | 'visibility' | 'isCanonical' | 'closedAt' | 'archivedAt'>,
): { url: string; public: boolean } {
  const origin = brand.canonicalOrigin.replace(/\/+$/, '');
  const isPublic = row.publicDisplay && row.visibility === 'public' && row.isCanonical && !isClosed(row);
  if (!isPublic) return { url: `${origin}/jobs/${encodeURIComponent(row.id)}`, public: false };
  const slug = clean(row.slug) ?? slugify(row.title);
  return { url: `${origin}/job/${encodeURIComponent(slug ? `${row.id}-${slug}` : row.id)}`, public: true };
}

// ── People (F-NET-02/03 deep links) ──────────────────────────────────────

const LINKEDIN_PEOPLE = 'https://www.linkedin.com/search/results/people/';
const MAX_PAST_COMPANIES = 3;
const MAX_SCHOOLS = 2;

function linkedinSearch(keywords: string): string {
  return `${LINKEDIN_PEOPLE}?${new URLSearchParams({ keywords, origin: 'GLOBAL_SEARCH_HEADER' }).toString()}`;
}

const quoted = (s: string) => `"${s.replace(/"/g, '').trim()}"`;

function distinct(values: string[], exclude: string, max: number): string[] {
  const seen = new Set<string>([exclude.trim().toLowerCase()]);
  const out: string[] = [];
  for (const v of values) {
    const t = v.replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** "Senior", "Sr.", "II", "Lead" …: who holds the role, not the role (people at any level do the job). */
const LEVEL_WORDS = /\b(?:senior|sr|junior|jr|staff|principal|lead|intern|internship|entry[- ]level|mid[- ]level|associate|i{1,3}|iv|v)\b\.?/gi;
/** A comma part that is nothing but level words ("Senior", "Staff II"). */
const LEVEL_WORDS_ONLY = /^(?:\s*(?:senior|sr|junior|jr|staff|principal|lead|intern|internship|entry[- ]level|mid[- ]level|associate|i{1,3}|iv|v)\.?\s*)+$/i;

/**
 * A taxonomy name that names one role ("Product designer"). Some names group
 * several ("Server, barista or bartender", "Finance manager / controller",
 * "NLP and LLM engineer"): searched as keywords every word must match, so they
 * find fewer people than the posting's own title would, and they read wrongly
 * ("People working as Server, barista or bartender").
 */
function namesOneRole(label: string): boolean {
  return !/[\/,(&]|\s(?:or|and)\s/i.test(label);
}

/**
 * The role to search people by: the posting title is often a headline
 * ("Product Designer - Gaming Communities (In-Office NYC)"), and searching it
 * word for word finds nobody. The role our taxonomy placed the job in is used
 * when its name is one role ("Product designer"); for a grouped name, or a job
 * we could not place, the title's first part without notes in brackets and
 * level words ("Barista"). A first part that is one bare word with its field
 * after a comma ("Sr. Manager, Strategic Finance - EMEA") keeps that field
 * ("Strategic Finance Manager"): "Manager" alone finds everyone and no one.
 */
export function searchRole(job: { title: string; primaryTaxonomyId?: string | null }): string {
  const placed = job.primaryTaxonomyId ? taxonomyLabel(job.primaryTaxonomyId, 'en') : null;
  if (placed && namesOneRole(placed)) return placed;
  if (!placed) {
    const matched = bestTaxonomyMatch(job.title);
    const label = matched ? taxonomyLabel(matched.id, 'en') : null;
    if (label && namesOneRole(label)) return label;
  }
  const [first = '', ...fields] = job.title
    .normalize('NFKC')
    .replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
    .split(/\s+[-–—|:]\s+|[;|@]|\s+(?:at|for|in)\s+(?=[A-Z])/)[0]!
    .split(',');
  const head = first.replace(LEVEL_WORDS, ' ').replace(/\s+/g, ' ').trim();
  if (!head) return job.title.replace(/\s+/g, ' ').trim();
  // "Manager, Strategic Finance": one bare word, and the field it works in right after the comma.
  const field = /\s/.test(head) ? null : fields.map((f) => f.replace(/\s+/g, ' ').trim()).find(isRoleField);
  return field ? `${field} ${head}` : head;
}

/** Words after a title's comma that say where, how or at what level, not which field. */
const NOT_A_FIELD = /^(?:remote|hybrid|on-?site|contract|contractor|temporary|temp|part[- ]time|full[- ]time|intern(?:ship)?|i{1,3}|iv|v)$/i;
/** A region or country code as the title wrote it, in capitals (EMEA, APAC, UK). "Legal", "Risk", "Tax" are fields. */
const REGION_CODE = /^[A-Z]{2,5}$/;

/**
 * Is this comma part of a title the field of the role ("Strategic Finance",
 * "Product Management")? One to four plain words; not a place (a city, a
 * country, a region code such as EMEA), a work arrangement or a level.
 */
function isRoleField(part: string): boolean {
  if (!part || part.length > 48 || !/^[A-Za-z][A-Za-z&/+ .'-]*$/.test(part)) return false;
  if (part.split(' ').length > 4 || NOT_A_FIELD.test(part) || REGION_CODE.test(part) || LEVEL_WORDS_ONLY.test(part)) return false;
  return !findCity(part) && !resolveCountry(part);
}

/** Three people searches at the company; nothing is fetched by us. Empty for markets without LinkedIn search. */
export function peopleSearchLinks(
  job: { title: string; companyName: string; primaryTaxonomyId?: string | null },
  profile: { pastCompanies: string[]; schools: string[] },
  market: string,
): PeopleSearchLink[] {
  if (market !== 'intl') return [];
  const company = job.companyName.trim();
  if (!company) return [];
  const companies = distinct(profile.pastCompanies, company, MAX_PAST_COMPANIES);
  const schools = distinct(profile.schools, '', MAX_SCHOOLS);
  const role = searchRole(job);
  return [
    { kind: 'role', url: linkedinSearch(`${quoted(company)} ${role}`.trim()), params: { company, title: role } },
    {
      kind: 'past_companies',
      url: companies.length ? linkedinSearch(`${quoted(company)} (${companies.map(quoted).join(' OR ')})`) : null,
      params: { company, companies: companies.join(', ') },
    },
    {
      kind: 'schools',
      url: schools.length ? linkedinSearch(`${quoted(company)} (${schools.map(quoted).join(' OR ')})`) : null,
      params: { company, schools: schools.join(', ') },
    },
  ];
}

// ── Checklist and tracker ────────────────────────────────────────────────

export interface TrackerRow {
  id: string;
  status: string;
  dateApplied: Date | null;
  tailoredVariantId: string | null;
  coverLetterId: string | null;
}

export function isPreApply(status: string): boolean {
  return (PRE_APPLY_STATUSES as readonly string[]).includes(status);
}

export function toTrackerState(row: TrackerRow | null): JobTrackerState | null {
  return row ? { id: row.id, status: row.status, dateApplied: row.dateApplied ? row.dateApplied.toISOString() : null } : null;
}

export function toChecklist(
  tracker: TrackerRow | null,
  tailoredResumeId: string | null,
  coverLetterId: string | null,
  practiced: boolean | null,
): JobChecklist {
  return {
    saved: tracker != null,
    tailoredResumeId: tailoredResumeId ?? tracker?.tailoredVariantId ?? null,
    coverLetterId: coverLetterId ?? tracker?.coverLetterId ?? null,
    practiced,
    applied: tracker != null && !isPreApply(tracker.status),
  };
}

// ── GoApply campus programme ─────────────────────────────────────────────

export interface CampusEventRow {
  title: string;
  graduationClass: string;
  applyOpensAt: Date | null;
  applyClosesAt: Date | null;
  officialUrl: string;
  verifiedAt: Date | null;
}

/** '2027届' / '2026-2027届' → [2027] / [2026, 2027]. */
export function classYearsOf(graduationClass: string): number[] {
  const years = (graduationClass.match(/(?:19|20)\d{2}/g) ?? []).map(Number);
  return [...new Set(years)].sort((a, b) => a - b);
}

export const CAMPUS_RECHECK_DAYS = 14;

export function toCampusInfo(ev: CampusEventRow | null, now: Date): JobCampusInfo | null {
  if (!ev || !ev.officialUrl) return null;
  return {
    title: ev.title,
    graduationClass: ev.graduationClass,
    classYears: classYearsOf(ev.graduationClass),
    applyOpensAt: ev.applyOpensAt ? ev.applyOpensAt.toISOString() : null,
    applyClosesAt: ev.applyClosesAt ? ev.applyClosesAt.toISOString() : null,
    officialUrl: ev.officialUrl,
    verifiedAt: ev.verifiedAt ? ev.verifiedAt.toISOString() : null,
    needsCheck: !ev.verifiedAt || now.getTime() - ev.verifiedAt.getTime() > CAMPUS_RECHECK_DAYS * 86_400_000,
  };
}

// server/src/features/jobs/detail/view.ts — pure mappers for job detail (WP-34).
//
// No I/O here: rows in, wire views out, so every honesty rule is unit-tested.
//   - pay: only what the posting (or provider) states; never 0, never estimated;
//   - sponsorship / requirement lines: only with the posting's own words (C18, H36);
//   - badges: at most 3, from real fields; "Direct from employer" only when the
//     job came from our recruiter bank, the bank verified the employer and it
//     is not an agency (D3);
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
import { applyLinkOf, bankListable, hasPayFigure, salaryLineOf, sourceFactsOf, sourceKindOf, type FeedItem, type FitBadge, type SalaryLine } from '../../feed/contract.js';
import type { PreScoreResult } from '../../match/contract.js';
import { payPlausible, statesAmount } from '../normalize/index.js';
import { bestTaxonomyMatch, taxonomyLabel } from '../taxonomy/index.js';
import { findCity, resolveCountry } from '../geo/index.js';
import {
  JOB_REQUIREMENT_TAGS,
  PRE_APPLY_STATUSES,
  type CompanySummary,
  type JobCampusInfo,
  type JobChecklist,
  type JobDetail,
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
  marketTags: true,
  fraudFlags: true,
  applyUrl: true,
  atsType: true,
  postedAt: true,
  postedAtEstimated: true,
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
  marketTags: unknown;
  fraudFlags: unknown;
  applyUrl: string;
  atsType: string | null;
  postedAt: Date | null;
  postedAtEstimated: boolean;
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
export function toPayText(row: Pick<JobRow, 'salaryText'>, pay: JobPay | null): string | null {
  if (pay) return null;
  const text = clean(row.salaryText);
  return text && statesAmount(text) ? text : null;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

/** The posting's own sections, verbatim; the full description when none were split out. */
export function toSections(row: Pick<JobRow, 'responsibilities' | 'qualifications' | 'benefits' | 'description'>): JobDetail['sections'] {
  const out: JobDetail['sections'] = [];
  const r = clean(row.responsibilities);
  const q = clean(row.qualifications);
  const b = clean(row.benefits);
  if (r) out.push({ kind: 'responsibilities', body: r });
  if (q) out.push({ kind: 'qualifications', body: q });
  if (b) out.push({ kind: 'benefits', body: b });
  const d = clean(row.description);
  if (!out.length && d) out.push({ kind: 'description', body: d });
  return out;
}

/** Sponsorship with the posting's quote; a status without a quote is "not stated" (C18). */
export function toSponsorship(row: Pick<JobRow, 'sponsorship' | 'sponsorshipEvidence'>): JobDetail['sponsorship'] {
  const quote = clean(row.sponsorshipEvidence);
  if ((row.sponsorship === 'offered' || row.sponsorship === 'not_offered') && quote) return { status: row.sponsorship, quote };
  return { status: 'not_stated', quote: null };
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

/** Badge rules shared with the feed card (WP-33): ≤3, real fields only. */
export function toBadges(
  row: Pick<JobRow, 'fromRecruiterBank' | 'employerVerified' | 'isAgency' | 'sponsorship' | 'sponsorshipEvidence' | 'postedAt' | 'postedAtEstimated'>,
  now: Date,
): FeedItem['badges'] {
  const out: FeedItem['badges'] = [];
  if (row.fromRecruiterBank && row.employerVerified && row.isAgency !== true) out.push({ kind: 'direct_from_employer', label: 'direct_from_employer' });
  const sp = toSponsorship(row);
  if (sp.status === 'offered' && sp.quote) out.push({ kind: 'sponsorship', label: 'offered', quote: sp.quote });
  if (row.postedAt && !row.postedAtEstimated && now.getTime() - row.postedAt.getTime() <= 3 * 86_400_000 && row.postedAt.getTime() <= now.getTime()) {
    out.push({ kind: 'new', label: 'new' });
  }
  return out.slice(0, 3);
}

const WORK_MODELS = new Set(['remote', 'hybrid', 'onsite']);

export function toJobDetail(row: JobRow, now: Date, campus: JobCampusInfo | null = null): JobDetail {
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
    sponsorship: toSponsorship(row),
    requirements: toRequirements(row.marketTags),
    // A recruiter-bank row whose bank has no posting page hands out no link at all (the stored one is "Page not found").
    applyUrl: bankListable(row) ? clean(row.applyUrl) : null,
    apply: applyOf(row),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    postedAtEstimated: row.postedAtEstimated,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    closedAt: (row.closedAt ?? row.archivedAt)?.toISOString() ?? null,
    status: isClosed(row) ? 'closed' : 'open',
    source: sourceOf(row),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    badges: toBadges(row, now),
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
 * Feed fit badge from a list score (null score → no badge, never 0). The kind
 * is kept: a stored AI score is the same number the feed card shows and is
 * not labelled "Quick estimate".
 */
export function toFitBadge(pre: PreScoreResult | undefined): FitBadge | null {
  if (!pre || pre.score == null || !pre.tier) return null;
  return { tier: pre.tier, score: pre.score, kind: pre.kind, topGap: pre.topGap, topOverlap: pre.topOverlap };
}

/** A similar job as a feed card; pay keeps the posting's own period (weekly too) and its words-only text. */
export function toSimilarItem(row: JobRow, now: Date, fit: FitBadge | null, tracker: { status: string } | null): SimilarJobItem {
  const pay = toPay(row);
  const payText = toPayText(row, pay);
  const source = sourceOf(row);
  return {
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
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    source: { name: source.name, kind: source.kind, original: source.original, url: source.url, lastVerifiedAt: source.lastVerifiedAt, ...(source.via ? { via: source.via } : {}) },
    apply: applyOf(row),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    badges: toBadges(row, now),
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

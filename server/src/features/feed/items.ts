// server/src/features/feed/items.ts — FeedItem from a feed row (WP-32; ARCH §4.8 step 5, PRODUCT F-FEED-05/07).
//
// Honesty rules applied here (D3):
//   - pay is null ("Pay not listed") unless the posting discloses it; never 0;
//   - "Direct from employer" only when fromRecruiterBank && employerVerified && !isAgency;
//   - the sponsorship badges only for users who need sponsorship, and only
//     with the posting's own quote; "says no sponsorship" also needs a
//     negation in that quote;
//   - citizenship / clearance badges only with their quote (marketTags);
//   - CN market tags (央国企 / 事业编 / 可落户 / 外企) only with an evidence quote;
//   - the 网申 close date only when the posting states it (marketTags
//     `apply_closes:<date>` + quote), never RAJob.expiresAt (often postedAt + 45 days);
//   - no applicant count, no "new" / "closing soon" urgency badges;
//   - "Last checked {date}" comes from lastSeenAt.

import type { MatchExplanation } from '../compliance/contract.js';
import { payPlausible, statesAmount } from '../jobs/normalize/index.js';
import type { MatchUser } from '../match/index.js';
import type { FeedBadge, FeedItem, FitBadge, PublicFeedItem } from './contract.js';
import type { FeedJobRow } from './types.js';
import { marketTagsOf, statedApplyClose } from './types.js';
import { SPONSORSHIP_NEGATION_REGEX, cnDate } from './sql.js';

const MAX_BADGES = 3;
const ATS_PUBLIC_BOARDS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'ats_public']);
const PERIODS = new Set(['year', 'month', 'week', 'day', 'hour']);
const NEGATION = new RegExp(SPONSORSHIP_NEGATION_REGEX.replace(/\\m|\\M/g, '\\b'), 'i');

const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Does the user need sponsorship for this job's country? (search-profile answer, or the per-country work-auth answer). */
export function needsSponsorshipFor(user: Pick<MatchUser, 'needsSponsorship' | 'workAuth'> | null, country: string | null): boolean {
  if (!user) return false;
  const entry = country ? user.workAuth.find((w) => w.country === country) : undefined;
  if (entry && entry.sponsorship) return entry.sponsorship === 'now' || entry.sponsorship === 'later';
  return user.needsSponsorship === true;
}

function payOf(row: FeedJobRow): FeedItem['pay'] {
  if (!row.salaryDisclosed) return null;
  if (row.salaryMin === null && row.salaryMax === null && !row.salaryText) return null;
  // A stored figure that cannot be pay for its period (a posting typo: "$60,000,000 an hour") is not shown as a number.
  if (!payPlausible({ min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, months: row.salaryMonths })) return null;
  // No figures, only words: they are shown only when they state an amount.
  if (row.salaryMin === null && row.salaryMax === null && !statesAmount(row.salaryText)) return null;
  const period = row.salaryPeriod && PERIODS.has(row.salaryPeriod) ? (row.salaryPeriod as NonNullable<FeedItem['pay']>['period']) : 'year';
  return { min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency ?? '', period, text: row.salaryText };
}

function sourceOf(row: FeedJobRow): FeedItem['source'] {
  const name = row.sourceName || row.originalSourceName || row.sourceBoard;
  if (row.sourceBoard === 'user_import' || row.visibility === 'private') return { name, kind: 'user_import' };
  if (row.fromRecruiterBank) return { name, kind: 'bank' };
  if (ATS_PUBLIC_BOARDS.has(row.sourceBoard)) return { name, kind: 'ats_public' };
  return { name, kind: 'provider' };
}

function sizeBandOf(row: FeedJobRow): NonNullable<FeedItem['company']['sizeBand']> | null {
  if (!row.companySizeBand || !isRecord(row.companyFacts)) return null;
  const fact = row.companyFacts.sizeBand;
  if (!isRecord(fact) || typeof fact.source !== 'string') return null;
  const asOf = typeof fact.fetchedAt === 'string' ? fact.fetchedAt : null;
  return asOf ? { value: row.companySizeBand, source: fact.source, asOf } : null;
}

function quoteFor(row: FeedJobRow, tag: string): string | null {
  return marketTagsOf(row.marketTags).find((t) => t.tag === tag)?.evidenceQuote ?? null;
}

/** Badges in fixed priority, at most three, each from a real field. */
export function badgesFor(row: FeedJobRow, user: Pick<MatchUser, 'needsSponsorship' | 'workAuth'> | null): FeedBadge[] {
  const out: FeedBadge[] = [];
  if (row.fromRecruiterBank && row.employerVerified && row.isAgency !== true) out.push({ kind: 'direct_from_employer', label: 'direct_from_employer' });
  if (row.market === 'intl' && needsSponsorshipFor(user, row.locationCountry)) {
    const quote = row.sponsorshipEvidence?.trim();
    if (quote && row.sponsorship === 'offered') out.push({ kind: 'sponsorship', label: 'sponsorship', quote });
    else if (quote && row.sponsorship === 'not_offered' && NEGATION.test(quote)) out.push({ kind: 'no_sponsorship', label: 'no_sponsorship', quote });
  }
  if (row.market === 'intl' && row.clearanceRequired === true) {
    const quote = quoteFor(row, 'clearance_required');
    if (quote) out.push({ kind: 'clearance_required', label: 'clearance_required', quote });
  }
  if (row.market === 'intl' && row.citizenshipRequired === true) {
    const quote = quoteFor(row, 'citizenship_required');
    if (quote) out.push({ kind: 'citizens_only', label: 'citizens_only', quote });
  }
  if (row.market === 'cn') {
    for (const tag of row.employerTags ?? []) {
      const quote = quoteFor(row, tag);
      if (quote) out.push({ kind: 'market_tag', label: tag, quote });
    }
  }
  if (row.isAgency === true) out.push({ kind: 'agency', label: 'agency' });
  if (row.workModel === 'remote') out.push({ kind: 'remote', label: 'remote' });
  if (payOf(row)) out.push({ kind: 'pay_listed', label: 'pay_listed' });
  if (row.hasBenefits) out.push({ kind: 'benefits_listed', label: 'benefits_listed' });
  return out.slice(0, MAX_BADGES);
}

function classYearsOf(row: FeedJobRow): number[] {
  return marketTagsOf(row.marketTags)
    .map((t) => t.tag.match(/^class_year:(\d{4})$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => Number(m[1]));
}

function campusOf(row: FeedJobRow, now: Date): FeedItem['campus'] {
  if (row.market !== 'cn') return null;
  const classYears = classYearsOf(row);
  const campus = marketTagsOf(row.marketTags).some((t) => t.tag === 'cn_hire:campus');
  const closes = statedApplyClose(row.marketTags, cnDate(now));
  if (!classYears.length && !campus && !closes) return null;
  return { applyClosesAt: closes?.date ?? null, applyClosesQuote: closes?.quote ?? null, classYears };
}

export interface ItemContext {
  user: Pick<MatchUser, 'needsSponsorship' | 'workAuth'> | null;
  fit: FitBadge | null;
  tracker: { status: string } | null;
  position: number | null;
  /** Today's date for the stated 网申 close (defaults to the clock). */
  now?: Date;
  /** `marketHooks.cardMeta` output for this job (CN / TW card lines); left off the item when empty. */
  cardMeta?: Record<string, Record<string, unknown>> | null;
  /** `explainMatch` lines ("Why this job"); left off the item when absent. */
  explanation?: MatchExplanation | null;
}

/** The public part of a card (no fit, no tracker) — also the visitor list item. */
export function publicItem(row: FeedJobRow, user: ItemContext['user'] = null, now: Date = new Date()): PublicFeedItem {
  const workModel = row.workModel === 'remote' || row.workModel === 'hybrid' || row.workModel === 'onsite' ? row.workModel : null;
  return {
    jobId: row.id,
    title: row.title,
    company: {
      id: row.companyId,
      name: row.companyDisplayName || row.companyName,
      logoUrl: row.companyLogo || row.companyLogoUrl || null,
      sizeBand: sizeBandOf(row),
    },
    location: row.location ?? row.locationCity ?? null,
    workModel,
    employmentType: row.employmentType,
    seniority: row.seniority,
    pay: payOf(row),
    payMonths: row.market === 'cn' ? row.salaryMonths : null,
    postedAt: iso(row.postedAt),
    postedAtEstimated: row.postedAtEstimated === true,
    lastSeenAt: iso(row.lastSeenAt),
    source: sourceOf(row),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    badges: badgesFor(row, user),
    campus: campusOf(row, now),
    position: null,
  };
}

export function toFeedItem(row: FeedJobRow, ctx: ItemContext): FeedItem {
  const item: FeedItem = { ...publicItem(row, ctx.user, ctx.now), fit: ctx.fit, tracker: ctx.tracker, position: ctx.position };
  if (ctx.cardMeta && Object.keys(ctx.cardMeta).length) item.cardMeta = ctx.cardMeta;
  if (ctx.explanation) item.explanation = ctx.explanation;
  return item;
}

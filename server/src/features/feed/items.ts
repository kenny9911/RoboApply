// server/src/features/feed/items.ts — FeedItem from a feed row (WP-32; ARCH §4.8 step 5, PRODUCT F-FEED-05/07).
//
// Honesty rules applied here (D3):
//   - pay is null ("Pay not listed") unless the posting discloses it; never 0;
//   - "Direct from employer" only when fromRecruiterBank && employerVerified && !isAgency;
//   - the sponsorship badges only for users who need sponsorship. A badge that
//     says the job sponsors rests on the posting's own quote, or it is a
//     provider's reading shown under its own kind (`sponsorship_provider`)
//     with that provider's name and no quote; "says no sponsorship" needs the
//     posting's quote and a negation in it, never a provider's flag alone
//     (contract.ts `sponsorshipSignalOf`, JI-11). A company's sponsorship
//     history is a company fact and is never read here;
//   - citizenship / clearance badges only with their quote (marketTags);
//   - CN market tags (央国企 / 事业编 / 可落户 / 外企) only with an evidence quote;
//   - the 网申 close date only when the posting states it (marketTags
//     `apply_closes:<date>` + quote), never RAJob.expiresAt (often postedAt + 45 days);
//   - no applicant count, no "closing soon" urgency badge;
//   - three date facts (JI-10): `postedAt` is the employer's date or null (a
//     date we assigned never travels under that name), `firstSeenAt` is ours,
//     `lastSeenAt` is "last checked"; `isNew` rests on `firstSeenAt` alone
//     (after the viewer's previous visit when the caller knows it, else the
//     last 48 hours) and is a field, not one of the three badges;
//   - every card names its source and carries its own apply link
//     (`source.original / url / lastVerifiedAt / via`, `apply { url, target }`:
//     sourceLine.ts; D1: the user opens the link, nothing is submitted);
//   - `salary` is null when the posting states no pay ("薪资未披露", never
//     面议): on GoApply the line is the posting's own words or the mainland
//     notation of its figures (cn/jobs/card.ts `cnSalary`, the rule the card
//     meta uses).

import { cnSalary } from '../cn/jobs/contract.js';
import type { MatchExplanation } from '../compliance/contract.js';
import { payPlausible, statesAmount } from '../jobs/normalize/index.js';
import type { MatchUser } from '../match/index.js';
import { isNewPosting, sponsorshipLabelsShown, sponsorshipSignalOf, type FeedBadge, type FeedItem, type FitBadge, type PublicFeedItem } from './contract.js';
import type { FeedJobRow } from './types.js';
import { marketTagsOf, statedApplyClose } from './types.js';
import { SPONSORSHIP_NEGATION_REGEX, cnDate } from './sql.js';
import { applyLinkOf, hasPayFigure, salaryLineOf, sourceFactsOf, sourceKindOf } from './sourceLine.js';

const MAX_BADGES = 3;
const PERIODS = new Set(['year', 'month', 'week', 'day', 'hour']);
const NEGATION = new RegExp(SPONSORSHIP_NEGATION_REGEX.replace(/\\m|\\M/g, '\\b'), 'i');

const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Does the user need sponsorship for this job's country? The rule lives in the contract (the job page reads it
// too); it is re-exported here under the name and signature this module always had.
export { needsSponsorshipFor } from './contract.js';

/** Where a posting's pay words are read (normalize/salary.ts `statesAmount`). */
function payContextOf(row: Pick<FeedJobRow, 'locationCountry' | 'market'>): { country?: string | null; market?: 'intl' | 'cn' } {
  const market = row.market === 'cn' ? 'cn' : row.market === 'intl' ? 'intl' : undefined;
  return { country: row.locationCountry, ...(market ? { market } : {}) };
}

function payOf(row: FeedJobRow): FeedItem['pay'] {
  if (!row.salaryDisclosed) return null;
  if (row.salaryMin === null && row.salaryMax === null && !row.salaryText) return null;
  // A stored figure that cannot be pay for its period (a posting typo: "$60,000,000 an hour") is not shown as a number.
  if (!payPlausible({ min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, months: row.salaryMonths })) return null;
  // No figures, only words: they are shown only when they state an amount.
  // The row's own country and market decide which pay clauses are a statutory line and no amount (Taiwan's threshold).
  if (row.salaryMin === null && row.salaryMax === null && !statesAmount(row.salaryText, payContextOf(row))) return null;
  const period = row.salaryPeriod && PERIODS.has(row.salaryPeriod) ? (row.salaryPeriod as NonNullable<FeedItem['pay']>['period']) : 'year';
  return { min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency ?? '', period, text: row.salaryText };
}

function sourceOf(row: FeedJobRow): FeedItem['source'] {
  const name = row.sourceName || row.originalSourceName || row.sourceBoard;
  const kind = sourceKindOf(row);
  return { name, kind, ...sourceFactsOf(row, kind) };
}

/** Pay as posted for the contract's `salary` (null = the posting states none). */
function salaryOf(row: FeedJobRow, pay: FeedItem['pay']): FeedItem['salary'] {
  if (row.market !== 'cn') return salaryLineOf(pay, pay?.text ?? null, null);
  // Mainland: the line the card meta shows (the posting's own words when they carry a figure, else the
  // mainland notation of the stated figures). Not disclosed, 面议 and figure-less text all give null.
  const line = cnSalary(row as unknown as Record<string, unknown>);
  if (line.disclosed && line.text) return salaryLineOf(pay, line.text, row.salaryMonths);
  // The mainland notation covers CNY by the month, day, hour or year. Pay stated another way (USD at a
  // multinational, a weekly rate) has no such line but is still stated pay: `salary` carries its figures,
  // and null keeps meaning "the posting states none" (D3). A stored 0 is not a figure.
  return hasPayFigure(pay) ? salaryLineOf(pay, pay?.text ?? null, row.salaryMonths) : null;
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
  if (sponsorshipLabelsShown(row, user)) {
    const signal = sponsorshipSignalOf(row);
    if (signal?.basis === 'quote' && signal.status === 'offered') out.push({ kind: 'sponsorship', label: 'sponsorship', quote: signal.quote });
    else if (signal?.basis === 'quote' && NEGATION.test(signal.quote)) out.push({ kind: 'no_sponsorship', label: 'no_sponsorship', quote: signal.quote });
    // A provider's reading: its own kind, the provider named, no quote, never the wording of the quoted badge.
    else if (signal?.basis === 'provider') out.push({ kind: 'sponsorship_provider', label: 'sponsorship_provider', provider: signal.provider });
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
  /** Today's date for the stated 网申 close and the clock of "New" (defaults to the clock). */
  now?: Date;
  /**
   * The viewer's previous visit to the list (the instant the new-count badge
   * counts from). With it, `isNew` = first seen after it; null or absent =
   * no known visit, so first seen in the last 48 hours (contract.ts `isNewPosting`).
   */
  newSince?: Date | null;
  /** `marketHooks.cardMeta` output for this job (CN / TW card lines); left off the item when empty. */
  cardMeta?: Record<string, Record<string, unknown>> | null;
  /** `explainMatch` lines ("Why this job"); left off the item when absent. */
  explanation?: MatchExplanation | null;
}

/** The public part of a card (no fit, no tracker) — also the visitor list item. */
export function publicItem(row: FeedJobRow, user: ItemContext['user'] = null, now: Date = new Date(), newSince: Date | null = null): PublicFeedItem {
  const workModel = row.workModel === 'remote' || row.workModel === 'hybrid' || row.workModel === 'onsite' ? row.workModel : null;
  const pay = payOf(row);
  const source = sourceOf(row);
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
    pay,
    salary: salaryOf(row, pay),
    payMonths: row.market === 'cn' ? row.salaryMonths : null,
    // The employer's date only: a date we assigned (first sight, an open-data set's update date) is never sent as "posted".
    postedAt: row.postedAtEstimated === true ? null : iso(row.postedAt),
    postedAtEstimated: row.postedAtEstimated === true,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    isNew: isNewPosting(row.firstSeenAt, now, newSince),
    source,
    apply: applyLinkOf(row, source.kind),
    fromRecruiterBank: row.fromRecruiterBank,
    employerVerified: row.employerVerified,
    isAgency: row.isAgency === true,
    badges: badgesFor(row, user),
    campus: campusOf(row, now),
    position: null,
  };
}

export function toFeedItem(row: FeedJobRow, ctx: ItemContext): FeedItem {
  const item: FeedItem = { ...publicItem(row, ctx.user, ctx.now, ctx.newSince ?? null), fit: ctx.fit, tracker: ctx.tracker, position: ctx.position };
  if (ctx.cardMeta && Object.keys(ctx.cardMeta).length) item.cardMeta = ctx.cardMeta;
  if (ctx.explanation) item.explanation = ctx.explanation;
  return item;
}

// components/features/marketing/catalog.ts — the marketing site map per brand
// (PRODUCT_PLAN.md §3.2) and the published ranking factors (WP-32).
// Pure data: server pages (metadata, notFound) and client components share it.

import type { BrandId } from '../../../lib/brand/registry.generated';
import type { FlagKey } from '../../../lib/flags';

/**
 * What a feature page needs before it may show:
 *   - a capability flag (fail closed on the client);
 *   - 'hiringContacts:on' — people data from recruiters who opted in (OPS-A10);
 *   - 'extensionPublished' — a store listing exists for the brand's extension
 *     (`NEXT_PUBLIC_EXT_ID` / `NEXT_PUBLIC_CN_EXT_ID`, R-03) AND the
 *     `extension` flag is on. No page advertises an extension nobody can install.
 */
export type FeatureGate = FlagKey | 'hiringContacts:on' | 'extensionPublished' | null;

export interface FeatureDef {
  slug: string;
  brand: BrandId;
  /** Key under `landing.features.<brand>.<key>`. */
  key: string;
  gate: FeatureGate;
  /**
   * A capability the page is about, on by default, that an operator can
   * switch off for the brand. Once it is known to be off the page has no
   * card and no footer link and says the feature is not available (R-04).
   * Unlike `gate` it does not fail closed: the page keeps its body in the
   * server HTML, so it stays indexable and in the sitemap.
   */
  needs?: FlagKey;
}

export const FEATURES: readonly FeatureDef[] = [
  { slug: 'job-matches', brand: 'roboapply', key: 'jobMatches', gate: null },
  { slug: 'resume-tailoring', brand: 'roboapply', key: 'resumeTailoring', gate: null },
  { slug: 'cover-letters', brand: 'roboapply', key: 'coverLetters', gate: null },
  { slug: 'ready-to-apply', brand: 'roboapply', key: 'readyToApply', gate: 'agent' },
  // Spoken practice needs the voice stack (LiveKit credentials); there is no
  // text-only mode, so the page shows only while voice practice works.
  { slug: 'interview-practice', brand: 'roboapply', key: 'interviewPractice', gate: 'ai.interviewVoice' },
  { slug: 'assistant', brand: 'roboapply', key: 'assistant', gate: 'copilot' },
  { slug: 'visa-sponsorship', brand: 'roboapply', key: 'visaSponsorship', gate: null },
  { slug: 'referrals', brand: 'roboapply', key: 'referrals', gate: 'hiringContacts:on' },
  { slug: 'chrome-extension', brand: 'roboapply', key: 'chromeExtension', gate: 'extensionPublished' },
  // GoApply (owner ruling D5): a page for every capability the two brands
  // share, under the same gates as RoboApply's page, plus GoApply's own
  // (campus calendar, 内推码, the form filler). What stays RoboApply-only is
  // market-specific: visa sponsorship. `chrome-extension` and `form-filler`
  // are the two brands' pages for the same extension.
  // The page says where listed jobs come from. GoApply's operator can close
  // every third-party posting (CN_RECRUITMENT_INFO_MODE=off turns `jobs.feed`
  // off): the page and its links then go away.
  { slug: 'job-matches', brand: 'goapply', key: 'jobMatches', gate: null, needs: 'jobs.feed' },
  { slug: 'resume-tailoring', brand: 'goapply', key: 'resumeTailoring', gate: null },
  { slug: 'cover-letters', brand: 'goapply', key: 'coverLetters', gate: null },
  { slug: 'ready-to-apply', brand: 'goapply', key: 'readyToApply', gate: 'agent' },
  { slug: 'campus-calendar', brand: 'goapply', key: 'campusCalendar', gate: 'jobs.campusCalendar' },
  { slug: 'resume', brand: 'goapply', key: 'resume', gate: null },
  // GoApply practice has a written mode, so the page needs AI text only (on
  // by default; it no longer waits for a domestic model). The voice line on
  // the home page follows `ai.interviewVoice`.
  { slug: 'interview-practice', brand: 'goapply', key: 'interviewPractice', gate: 'ai.text' },
  { slug: 'assistant', brand: 'goapply', key: 'assistant', gate: 'copilot' },
  // 内推码: referral codes other users shared, each checked by a moderator.
  { slug: 'referral-codes', brand: 'goapply', key: 'referralCodes', gate: 'cn.referralCodes' },
  { slug: 'form-filler', brand: 'goapply', key: 'formFiller', gate: 'extensionPublished' },
];

export function featuresFor(brand: BrandId): FeatureDef[] {
  return FEATURES.filter((f) => f.brand === brand);
}

/**
 * May search engines index this feature page? Only a page with no gate.
 * A gated page (a capability, a published extension, opted-in people data)
 * prints its body in the browser once the capability is known to be on; the
 * HTML a crawler receives has no body, and the capability can be switched off
 * per brand at any time. So it is `noindex` (app/features/[slug]/page.tsx) and
 * is left out of /sitemaps/static.xml (app/sitemaps/[file]/route.ts) — a
 * sitemap must never list a URL its own page marks noindex — even while the
 * footer links it for visitors. Both places read this one rule.
 */
export function isFeatureIndexable(def: Pick<FeatureDef, 'gate'>): boolean {
  return def.gate === null;
}

/** `/features/<slug>` of the brand's indexable feature pages: what the static sitemap lists. */
export function indexableFeaturePaths(brand: BrandId): string[] {
  return featuresFor(brand)
    .filter(isFeatureIndexable)
    .map((f) => `/features/${f.slug}`);
}

/** The feature page for a slug on this brand, or null (→ 404). */
export function findFeature(brand: BrandId, slug: string): FeatureDef | null {
  return FEATURES.find((f) => f.brand === brand && f.slug === slug) ?? null;
}

/**
 * Does this brand sell plans that renew? RoboApply does (Stripe
 * subscriptions). GoApply does not: the mainland rails sell one-time passes
 * only (MARKET_STRATEGY M-19), so there is nothing to cancel there. A
 * consequence of the payment rail, not a missing feature: the "cancel a
 * subscription" entries and the renewal rules read this one rule.
 */
export function brandPlansRenew(brand: { market: 'intl' | 'cn' }): boolean {
  return brand.market !== 'cn';
}

/** The brand's published extension id (inlined at build), or null. */
export function extensionStoreId(brand: BrandId): string | null {
  const id = brand === 'goapply' ? process.env.NEXT_PUBLIC_CN_EXT_ID : process.env.NEXT_PUBLIC_EXT_ID;
  return id && id.trim() ? id.trim() : null;
}

/**
 * The published "How ranking works" numbers: a mirror of
 * server/src/features/feed/contract.ts (`RANKING_FACTORS`, `ORDERING_RULES`,
 * `GOAL_ADJUSTMENTS`, `FEED_LIMITS`), which the ranking code itself reads
 * (rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality,
 * plus the goal and skills points). The page cannot import the server module
 * (it would pull zod into every marketing bundle), so
 * __tests__/links.test.ts compares this table with the contract entry by
 * entry: a weight, a rule or a goal changed on the server fails that test
 * until this file and the page copy say the same.
 *
 * `server` is the contract's key; `key` names the copy under
 * `landing.ranking.*`.
 */
export const RANKING_FACTORS = [
  { key: 'fit', server: 'fit', pct: 55 },
  { key: 'freshness', server: 'freshness', pct: 20 },
  { key: 'affinity', server: 'affinity', pct: 15 },
  { key: 'source', server: 'source_quality', pct: 10 },
] as const;

/**
 * Ordering rules besides the four factors (server `ORDERING_RULES`).
 * `points` null = the rule reorders or hides instead of adding points.
 * `markets`: sponsorship is a RoboApply question (GoApply has no such filter).
 */
export const ORDERING_RULES = [
  { key: 'sponsorshipFirst', server: 'sponsorship_first', points: null, markets: ['intl'] },
  { key: 'skillsBoost', server: 'skills_boost', points: 10, markets: ['intl', 'cn'] },
] as const;

/**
 * Points a career goal adds to a matching job (server `GOAL_ADJUSTMENTS`).
 * Only the goals that change the order are listed; the server's other goals
 * add 0 and the page says so in one line. The goal is a RoboApply onboarding
 * answer, so the block shows on RoboApply only.
 */
export const GOAL_ADJUSTMENTS = [
  { key: 'moreSenior', server: 'more_senior', points: 6 },
  { key: 'management', server: 'management', points: 6 },
  { key: 'higherPay', server: 'higher_pay', points: 6 },
  { key: 'flexibility', server: 'flexibility', points: 4 },
] as const;

/**
 * The feed's sorts besides Recommended, as "How ranking works" names them.
 * `sort` is the key of `jobs.workspace.sort.*` — the label the sort menu
 * itself prints — and `param` its placeholder in `landing.ranking.otherSorts`.
 * The page reads the menu's labels instead of repeating them, so a renamed
 * sort cannot leave the page behind (it said "Best fit" while the menu said
 * "Your best fits"). The key keeps its name on purpose: a locale whose
 * sentence still spells the labels out keeps showing that translated sentence
 * (the extra values are ignored) until it is translated again, instead of
 * falling back to English.
 * components/features/feed/SortMenu.tsx owns the list of sorts;
 * __tests__/pages.test.tsx compares the two.
 */
export const OTHER_SORTS = [
  { sort: 'newest', param: 'newest' },
  { sort: 'best_fit', param: 'bestFit' },
  { sort: 'highest_pay', param: 'highestPay' },
] as const;

/** Fit score parts (server `DEFAULT_MATCH_WEIGHTS`, R-09 35/30/15/10/10; parity-tested). */
export const FIT_PARTS = [
  { key: 'titleLevel', server: 'title_level', pct: 35 },
  { key: 'skills', server: 'skills', pct: 30 },
  { key: 'industry', server: 'industry', pct: 15 },
  { key: 'logistics', server: 'logistics', pct: 10 },
  { key: 'careerPath', server: 'career_path', pct: 10 },
] as const;

/** Fit tiers: the shared client mirror of the server's `DEFAULT_MATCH_TIERS` (R-09). */
export { DEFAULT_MATCH_TIERS as FIT_TIER_FLOORS } from '../common';

/** Company spread in the Recommended order (server `FEED_LIMITS.companyMaxPerWindow` / `companyWindow`; parity-tested). */
export const COMPANY_SPREAD = { max: 2, window: 20 } as const;

// ── FAQ keys per page (shared by the client pages and the server JSON-LD) ──

export const HOME_FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;
export const CN_HOME_FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;
/** GoApply home questions about listed jobs ("Where do the jobs come from?"): true only while `jobs.feed` is on. */
export const CN_HOME_FAQ_FEED_KEYS: readonly (typeof CN_HOME_FAQ_KEYS)[number][] = ['q4'];
/**
 * The GoApply home questions to print. `feed` false leaves out the questions
 * about listed jobs. The page passes what it knows; the route's FAQ JSON-LD
 * is built on the server, which has no capability reader, so it passes
 * `false` and lists only the questions that are true whatever the operator
 * has switched off (structured data never says more than the page).
 */
export function cnHomeFaqKeys(feed: boolean): (typeof CN_HOME_FAQ_KEYS)[number][] {
  return CN_HOME_FAQ_KEYS.filter((k) => feed || !CN_HOME_FAQ_FEED_KEYS.includes(k));
}
export const FEATURE_FAQ_KEYS = ['q1', 'q2'] as const;
export const PRICING_FAQ_KEYS = ['q1', 'q2', 'q3'] as const;
export const HELP_FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

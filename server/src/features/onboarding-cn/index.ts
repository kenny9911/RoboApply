// server/src/features/onboarding-cn/index.ts — public surface (FND-5; owner WP-31).
//
// GoApply onboarding G1–G7 (PRODUCT_PLAN.md §4.4–§4.5). WP-30's onboarding
// service dispatches GoApply steps here:
//
//   const v = await validateCnStep(step, body, { answers: stored.onboardingAnswers });
//   if (!v.ok) → 422 invalid_request { issues: v.issues }
//   store onboardingAnswers[step] = v.answers, advance the stage, then
//   await applyCnStep(userId, brand, v, { locale })   // consents, cnFields, default filters
//
// Also here: 届别 defaults, the cn market snapshot (G4 panel, G7 counts), the
// school/place data, the first-value context (R-14) and the 个性化推荐 seam the
// feed reads (`rankingModeForUser`, `feedSortFor`). `createOnboardingCnRouter`
// is exported for INT to mount at /api/v1/roboapply/onboarding/cn.

import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import type { FirstValueContext, MarketSnapshotResponse } from '../onboarding/contract.js';
import type {
  CnMarketSnapshotQuery,
  CnMarketSnapshotResponse,
  CnRankingMode,
  CnStepContext,
  CnStepValidation,
} from './contract.js';
import { applyCnStep, type ApplyCnStepDeps, type ApplyCnStepOptions, type ApplyCnStepResult } from './apply.js';
import { defaultGraduationClass } from './classYear.js';
import { cnMarketSnapshot, type SnapshotDb } from './marketSnapshot.js';
import { rankingModeForUser, type PersonalizationDb } from './personalization.js';
import { identityFrom, validateCnStep as validateCnStepPure } from './validate.js';

export * from './contract.js';
export { createOnboardingCnRouter, type OnboardingCnRouterDeps } from './routes.js';
export { applyCnStep, type ApplyCnStepDeps, type ApplyCnStepOptions, type ApplyCnStepResult } from './apply.js';
export { CN_ISSUE, identityFrom } from './validate.js';
export { CAMPUS_SEASON_ROLLOVER_MONTH, CN_DEFAULT_GRADUATION_MONTH, classYearOptions, clampClassYear, currentCampusClass } from './classYear.js';
export { formatMonthlyK, median, monthlyMidpointYuan, parseMonthlyKSalary, quantile, type MonthlyKSalary } from './salary.js';
export {
  INDUSTRIES,
  INDUSTRIES_SOURCE,
  PROVINCES,
  PROVINCES_SOURCE,
  SCHOOLS,
  SCHOOLS_SOURCE,
  findSchool,
  industryName,
  provinceOfCity,
  provincesResponse,
  schoolSearchResponse,
  schoolTagsFor,
  searchSchools,
} from './data.js';
export { cnMarketSnapshot, cnCampusWhere, cnJobWhere, NOT_FRAUD_FLAGGED, SNAPSHOT_WINDOW_DAYS } from './marketSnapshot.js';
export { feedRankingFor, feedSortFor, personalizedChoice, rankingModeFor, rankingModeForUser, type FeedRanking } from './personalization.js';

export interface OnboardingCnService {
  /** Validate a GoApply step body; `ctx.answers` (stored onboardingAnswers) enables the cross-step rules. */
  validateCnStep(step: string, body: unknown, ctx?: CnStepContext): Promise<CnStepValidation>;
  /** Default 届别 for a date (Oct 2026 → 2027届 for 应届, 2028届 for 在校). */
  defaultGraduationClass(identity: 'yingjie' | 'zaixiao', now?: Date): number;
  /** Write a validated step's consents, cnFields and default filters. */
  applyCnStep(userId: string, brand: ProductBrand, result: CnStepValidation, opts?: ApplyCnStepOptions): Promise<ApplyCnStepResult>;
  /** G4 panel / G7 counts over the GoApply index and campus calendar. */
  marketSnapshot(query: CnMarketSnapshotQuery): Promise<CnMarketSnapshotResponse>;
  /** The same counts in WP-30's `GET /onboarding/market-snapshot` shape (GoApply dispatch). */
  marketSnapshotForOnboarding(query: { taxonomyId: string; country: string; city?: string }): Promise<MarketSnapshotResponse>;
  /** PIPL Art. 24: may the feed rank this user with their profile? */
  rankingMode(userId: string, brand: BrandId): Promise<CnRankingMode>;
}

export interface OnboardingCnServiceDeps extends ApplyCnStepDeps {
  db?: SnapshotDb;
  consentDb?: PersonalizationDb;
  now?: () => Date;
}

/** Convert the cn snapshot to the onboarding area's shape (pay range = middle half; no skills list for cn). */
export function toOnboardingSnapshot(s: CnMarketSnapshotResponse): MarketSnapshotResponse {
  return {
    jobCount: { value: s.jobCount.value, source: 'index', asOf: s.jobCount.asOf },
    windowDays: s.windowDays,
    pay: s.pay
      ? {
          listedCount: s.pay.listedCount,
          sampleSize: s.pay.sampleSize,
          currency: 'CNY',
          period: 'month',
          low: s.pay.p25Monthly,
          high: s.pay.p75Monthly,
          source: 'index',
          asOf: s.pay.asOf,
        }
      : null,
    topSkills: [],
  };
}

export function createOnboardingCnService(deps: OnboardingCnServiceDeps = {}): OnboardingCnService {
  const now = deps.now ?? (() => new Date());
  return {
    async validateCnStep(step, body, ctx) {
      return validateCnStepPure(step, body, ctx);
    },
    defaultGraduationClass(identity, at) {
      return defaultGraduationClass(identity, at ?? now());
    },
    applyCnStep(userId, brand, result, opts) {
      return applyCnStep(userId, brand, result, opts, deps);
    },
    marketSnapshot(query) {
      return cnMarketSnapshot(query, { db: deps.db, now: now() });
    },
    async marketSnapshotForOnboarding(query) {
      const cn = await cnMarketSnapshot({ taxonomyIds: [query.taxonomyId], cities: query.city ? [query.city] : undefined }, { db: deps.db, now: now() });
      return toOnboardingSnapshot(cn);
    },
    rankingMode(userId, brand) {
      return rankingModeForUser(userId, brand, deps.consentDb);
    },
  };
}

export const onboardingCnService: OnboardingCnService = createOnboardingCnService();

/** WP-30 calls this for GoApply steps (FND seam; the optional `ctx` enables cross-step rules). */
export const validateCnStep = (step: string, body: unknown, ctx?: CnStepContext) => onboardingCnService.validateCnStep(step, body, ctx);

/** First-value context for `firstValueRoute` (R-14: `/campus` → `/jobs` → `/resume`; 社招 → `/jobs`). */
export function cnFirstValueContext(answers: CnStepContext['answers'], caps: { campusCalendar: boolean; jobsFeed: boolean }): FirstValueContext {
  return { campusCalendar: caps.campusCalendar, jobsFeed: caps.jobsFeed, cnIdentity: identityFrom(answers) };
}

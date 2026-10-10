// server/src/features/match/CompetitivenessService.ts
//
// "You and what employers ask" (PRODUCT F-MATCH-04; TASK_PLAN.md WP-77).
//
//   create(userId, searchProfileId, idempotencyKey)
//     1. the saved search (404 for an unknown / other user's id);
//     2. the user's side (degree, dated years, skills, resume text) — the
//        same builder as the fit score, no sensitive fields, no school tier;
//     3. an identical report from the last 24 h (same search version, same
//        inputs, same day) is returned free;
//     4. otherwise: the newest posts of the search (feed seam), a live count
//        of the search and the feed's per-filter removal counts, then the
//        pure computation in competitiveness.ts. D3 aggregate scope (TASK_PLAN
//        §2.2): the sample keeps only PUBLIC rows of the brand's market — the
//        feed preview also lists the user's own imports, and those never
//        count (the live counts are public-only too);
//     5. a report with a usable sample spends one `competitiveness` credit
//        (free 1 a week, Pro up to 3 a day; idempotency key from the client);
//        a sample under 20 posts is saved without charging — it only offers
//        ways to broaden the search.
//   latest(userId, searchProfileId?)  the newest stored report (or null),
//        marked `stale` when the search changed or was deleted since.
//
// No model call anywhere: the report is counted from our index, so it needs
// no AI consent and carries no AI label. Never compares the user with other
// applicants (we have no applicant data).

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { ReserveOptions } from '../../platform/credits/index.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import type { FeedCountResult, LimitingFilter } from '../feed/index.js';
import { buildReportBody, parseStoredReport, reportInputHash, toReportView, type ReportPost } from './competitiveness.js';
import { COMPETITIVENESS_LIMITS, type CompetitivenessReport, type CompetitivenessReportBody } from './contract.js';
import { toMatchJob, type MatchJobRecord } from './context.js';
import type { MatchUser } from './preScore.js';
import { createDefaultReportInventory, type ReportInventory } from './reportInventory.js';
import { createPrismaFitReportStore, type FitReportRow, type FitReportStore } from './reportStore.js';

/** The feed's count ceiling (FEED_LIMITS.countCap). */
const COUNT_CAP = 5000;
/** How many stored reports `latest` scans for one search. */
const LATEST_SCAN = 20;

export interface CompetitivenessServiceDeps {
  inventory?: ReportInventory;
  store?: FitReportStore;
  /** The user's side of the pre-score (MatchService.userContext). */
  userContext: (userId: string) => Promise<MatchUser>;
  getJobs: (ids: string[]) => Promise<MatchJobRecord[]>;
  withCredit?: <T>(opts: ReserveOptions, fn: (reservation: { id: string }) => Promise<T>) => Promise<T>;
  /** `competitivenessFull` and whether a sellable plan would grant it. */
  entitlements?: (userId: string) => Promise<{ full: boolean; upgradable: boolean }>;
  brand?: () => ProductBrand;
  now?: () => Date;
}

export interface CompetitivenessService {
  create(userId: string, searchProfileId: string, idempotencyKey: string): Promise<CompetitivenessReport>;
  latest(userId: string, searchProfileId?: string): Promise<CompetitivenessReport | null>;
}

async function defaultWithCredit<T>(opts: ReserveOptions, fn: (reservation: { id: string }) => Promise<T>): Promise<T> {
  const { creditService } = await import('../../platform/credits/index.js');
  return creditService.withCredit(opts, fn);
}

async function defaultEntitlements(userId: string): Promise<{ full: boolean; upgradable: boolean }> {
  const { entitlementService } = await import('../../platform/credits/index.js');
  const ent = await entitlementService.resolve(userId);
  return { full: ent.entitlements.competitivenessFull === true, upgradable: ent.proSellable && ent.planProfile === 'free' };
}

function toPost(row: MatchJobRecord): ReportPost {
  return { ...toMatchJob(row), minYears: row.minYears };
}

export function createCompetitivenessService(deps: CompetitivenessServiceDeps): CompetitivenessService {
  const inventory = deps.inventory ?? createDefaultReportInventory();
  const store = deps.store ?? createPrismaFitReportStore();
  const withCredit = deps.withCredit ?? defaultWithCredit;
  const entitlements = deps.entitlements ?? defaultEntitlements;
  const brandOf = deps.brand ?? getCurrentBrandOrDefault;
  const now = deps.now ?? (() => new Date());

  async function view(
    row: FitReportRow,
    body: CompetitivenessReportBody,
    userId: string,
    flags: { charged: boolean; stale: boolean; reused?: boolean },
  ): Promise<CompetitivenessReport> {
    const ent = await entitlements(userId).catch((err) => {
      logger.warn('MATCH', 'competitiveness: entitlements unreadable; showing the free view', { error: String(err) });
      return { full: false, upgradable: false };
    });
    return toReportView({ id: row.id, createdAt: row.createdAt, body }, { ...ent, ...flags });
  }

  /**
   * The search's newest PUBLIC posts on this brand, in the feed's order. The
   * preview seam also returns the user's own imported (private) jobs; they are
   * dropped here so no aggregate ever counts them (TASK_PLAN §2.2).
   */
  async function samplePosts(userId: string, profile: Parameters<ReportInventory['sampleJobIds']>[1]): Promise<ReportPost[]> {
    const ids = await inventory.sampleJobIds(userId, profile, COMPETITIVENESS_LIMITS.sampleMax);
    if (!ids.length) return [];
    const market = brandOf().market;
    const byId = new Map((await deps.getJobs(ids)).map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is MatchJobRecord => !!r && !r.archivedAt && r.market === market && r.visibility === 'public')
      .map(toPost);
  }

  async function create(userId: string, searchProfileId: string, idempotencyKey: string): Promise<CompetitivenessReport> {
    const profile = await inventory.getProfile(userId, searchProfileId);
    const user = await deps.userContext(userId);
    const at = now();
    const inputHash = reportInputHash({ profile, user, now: at });

    const reusable = await store.findReusable(userId, inputHash, new Date(at.getTime() - COMPETITIVENESS_LIMITS.reuseHours * 3_600_000));
    const reusedBody = reusable ? parseStoredReport(reusable.report) : null;
    if (reusable && reusedBody) return view(reusable, reusedBody, userId, { charged: false, stale: false, reused: true });

    const [posts, total, limiting] = await Promise.all([
      samplePosts(userId, profile),
      inventory.count(userId, profile.filters).catch((err): FeedCountResult | null => {
        logger.warn('MATCH', 'competitiveness: the search could not be counted', { error: String(err) });
        return null;
      }),
      inventory.limiting(userId, profile.id).catch((err): LimitingFilter[] => {
        logger.warn('MATCH', 'competitiveness: filter removal counts unavailable', { error: String(err) });
        return [];
      }),
    ]);
    const body = buildReportBody({ user, posts, profile, total, limiting, now: at, countCap: COUNT_CAP });

    if (body.suppressed) {
      const row = await store.save({ userId, inputHash, report: body, creditLedgerId: null });
      return view(row, body, userId, { charged: false, stale: false });
    }
    const row = await withCredit(
      { userId, bucket: 'competitiveness', idempotencyKey, refType: 'ra_search_profile', refId: profile.id, brand: brandOf().id },
      (reservation) => store.save({ userId, inputHash, report: body, creditLedgerId: reservation?.id ?? null }),
    );
    return view(row, body, userId, { charged: true, stale: false });
  }

  async function latest(userId: string, searchProfileId?: string): Promise<CompetitivenessReport | null> {
    const rows = await store.latest(userId, LATEST_SCAN);
    for (const row of rows) {
      const body = parseStoredReport(row.report);
      if (!body || (searchProfileId && body.searchProfileId !== searchProfileId)) continue;
      let stale = true;
      try {
        const current = await inventory.getProfile(userId, body.searchProfileId);
        stale = current.version !== body.searchProfileVersion;
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'not_found')) throw err;
      }
      return view(row, body, userId, { charged: false, stale });
    }
    return null;
  }

  return { create, latest };
}


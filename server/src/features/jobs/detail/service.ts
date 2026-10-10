// server/src/features/jobs/detail/service.ts — job detail service (WP-34).
//
//   get           GET /jobs/:id: the job, its company (sourced facts only),
//                 the cached fit (no model call), "Why this job", tracker and
//                 checklist state, similar ids, autofill, People links,
//                 market card meta
//   similar       GET /jobs/:id/similar
//   save/unsave   tracker `bookmarked` upsert / soft delete; save calls
//                 growth.markChecklistStep('save_job') every time (C20)
//   recordApplyClick / markApplied / undoApplied
//                 tracker → applied at once (R1/C11), idempotent, undoable;
//                 every apply response carries `alreadyApplied` (true when
//                 nothing changed: no Undo then). Undo reverts a move to
//                 Applied made in the last 24 h by ANY apply action —
//                 the apply click, "I applied", opening a Ready to apply kit
//                 (`agent_open`) or the extension's "I submitted" — and
//                 never a stage change made by hand in the tracker
//   every tracker write for one (user, job) — save, unsave, apply click,
//   "I applied", undo — runs under a transaction-scoped advisory lock
//   (`trackerEntryLockKey`), so concurrent first clicks or saves never
//   create two live entries
//   similar jobs are empty while `jobs.recommendations` is off (on GoApply
//   that is CN_RECRUITMENT_INFO_MODE=off; on by default, D5); a public mainland
//   posting with no usable apply link is never a similar job (feed/sourceLine.ts
//   `cnListable`)
//   share         public page only with publicDisplay, else the app link
//   companyNews   V2: the `companyNews` flag and a configured search only, on
//                 both brands (no market term, D5)
//
// D1: nothing here contacts an employer. "Applied" is what the user did on
// the employer's own page (or told us), never something we submitted.
// Every read is market-scoped; a private import is visible only to its owner.

import type prisma from '../../../lib/prisma.js';
import { HttpError } from '../../../platform/http.js';
import type { ProductBrand } from '../../../platform/brand/registry.js';
import type { HiringContactsMode } from '../../../platform/brand/registry.js';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import type { CompanyProfile } from '../companies/contract.js';
import type { MatchFitView, PreScoreResult } from '../../match/contract.js';
import type { MatchExplanation } from '../../compliance/contract.js';
import { cnPostingVisible } from '../../cn/jobs/index.js';
import { cnListableWhere } from '../../feed/contract.js';
import { OUTCOME_STATUS } from '../../tracker/contract.js';
import {
  JOB_DETAIL_ERROR_CODES,
  UNDOABLE_APPLY_VIA,
  UNDO_APPLIED_WINDOW_MS,
  type ApplyClickResponse,
  type CompanyNewsResponse,
  type JobCampusInfo,
  type JobDetailResponse,
  type JobTrackerState,
  type MarkAppliedResponse,
  type SaveJobResponse,
  type ShareResponse,
  type SimilarJobsResponse,
  type UndoAppliedResponse,
} from './contract.js';
import {
  JOB_ROW_SELECT,
  isClosed,
  isFlagged,
  isPreApply,
  isVisibleTo,
  peopleSearchLinks,
  shareTarget,
  toCampusInfo,
  toChecklist,
  toCompanySummary,
  toFitBadge,
  toJobDetail,
  toSimilarItem,
  toTrackerState,
  type CampusEventRow,
  type JobRow,
  type TrackerRow,
} from './view.js';

export type JobDetailDb = Pick<
  typeof prisma,
  | 'rAJob'
  | 'rATrackerEntry'
  | 'rATrackerEvent'
  | 'rAJobUserState'
  | 'rAJobInteraction'
  | 'rAResumeVariant'
  | 'rACoverLetter'
  | 'rACampusEvent'
  | '$transaction'
>;

/** What a tracker write needs inside its transaction. */
type TrackerTx = Pick<typeof prisma, 'rATrackerEntry' | 'rATrackerEvent' | '$executeRaw'>;

/**
 * Advisory-lock key for one user's tracker entry on one job. The (userId,
 * jobId) partial-unique rule lives in application code (RATrackerEntry), so
 * every writer that may create an entry takes this lock first.
 */
export function trackerEntryLockKey(userId: string, jobId: string): string {
  return `ra_tracker_entry:${userId}:${jobId}`;
}

/** Flags this service reads (a key the resolver does not know yet resolves false). */
export type DetailFlag = 'extension' | 'jobs.campusCalendar' | 'jobs.recommendations' | 'companyNews';

/** `payload.via` values of a move to Applied that "Undo · I didn't apply" may revert. */
const UNDOABLE_VIA: ReadonlySet<string> = new Set(UNDOABLE_APPLY_VIA);

/** A recorded move: the tracker core writes `created` when the apply action made the entry, `status` otherwise. */
interface MoveEvent {
  kind: string;
  fromValue: string | null;
  payload: unknown;
  createdAt: Date | null;
}

export interface JobDetailServiceDeps {
  db: JobDetailDb;
  brand: () => ProductBrand;
  env?: EnvSource;
  now?: () => Date;
  /** Company profile for a signed-in viewer (public rows counted); throws 404 when missing. */
  companyProfile?: (companyId: string) => Promise<CompanyProfile>;
  /** Cached fit or quick estimate; never a model call. */
  cachedFit?: (userId: string, jobId: string) => Promise<MatchFitView | null>;
  preScore?: (userId: string, jobIds: string[]) => Promise<PreScoreResult[]>;
  explain?: (input: { market: 'intl' | 'cn'; personalized: boolean; fit: MatchFitView }) => MatchExplanation;
  /** GoApply: a live `personalized_recommendation` grant; RoboApply: always true. */
  personalized?: (userId: string, brand: ProductBrand) => Promise<boolean>;
  /** Past employers and schools from the profile (for the People search links). */
  peopleContext?: (userId: string) => Promise<{ pastCompanies: string[]; schools: string[] }>;
  /** Has the user completed a practice for this job (live or written)? Null only when the seam is absent or fails. */
  practicedForJob?: (userId: string, jobId: string) => Promise<boolean | null>;
  markChecklistStep?: (userId: string, step: 'save_job') => Promise<unknown>;
  /**
   * Feed affinity (WP-32 `feedService.recordInteraction`): +0.1 save, +0.15 apply click,
   * +0.25 applied; it honours the GoApply 个性化推荐 grant itself. Called softly after a
   * tracker write that changed something.
   */
  recordInteraction?: (userId: string, jobId: string, kind: 'save' | 'apply_click' | 'applied') => Promise<unknown>;
  isEnabled?: (key: DetailFlag, userId: string) => Promise<boolean>;
  hiringContacts?: (userId: string) => Promise<HiringContactsMode>;
  marketMeta?: (row: JobRow, brand: ProductBrand) => Record<string, Record<string, unknown>>;
  searchNews?: (brand: ProductBrand, companyName: string) => Promise<JobDetailNewsItems | null>;
  /** ATS types the extension can fill (WP-55a/WP-70 register them). */
  extensionAts?: () => ReadonlySet<string>;
  /**
   * Whether the brand's extension can run on this job's application page
   * (market list, adapter host patterns, no page-by-page forms until R4).
   * Registered by the extension area with the types; absent = types only.
   */
  extensionFillsJob?: () => ((market: 'intl' | 'cn', atsType: string, applyUrl: string | null) => boolean) | null;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

type JobDetailNewsItems = CompanyNewsResponse['items'];

export const SIMILAR_LIMIT = 6;
export const SIMILAR_CANDIDATES = 40;

export interface JobDetailServiceImpl {
  get(userId: string, jobId: string): Promise<JobDetailResponse>;
  similar(userId: string, jobId: string): Promise<SimilarJobsResponse>;
  save(userId: string, jobId: string): Promise<SaveJobResponse>;
  unsave(userId: string, jobId: string): Promise<SaveJobResponse>;
  recordApplyClick(userId: string, jobId: string): Promise<ApplyClickResponse>;
  markApplied(userId: string, jobId: string, appliedAt?: string): Promise<MarkAppliedResponse>;
  undoApplied(userId: string, jobId: string): Promise<UndoAppliedResponse>;
  share(userId: string, jobId: string): Promise<ShareResponse>;
  companyNews(userId: string, jobId: string): Promise<CompanyNewsResponse>;
}

const TRACKER_SELECT = { id: true, status: true, dateApplied: true, tailoredVariantId: true, coverLetterId: true } as const;

/** Who ended it, for an ended stage (the tracker's own rule: `OUTCOME_STATUS` read backwards); null otherwise. */
function outcomeOfStatus(status: string): string | null {
  for (const [outcome, ended] of Object.entries(OUTCOME_STATUS)) if (ended === status) return outcome;
  return null;
}

function notFound(): HttpError {
  return new HttpError('not_found', 'Job not found.', { code: JOB_DETAIL_ERROR_CODES.notFound });
}

export function createJobDetailService(deps: JobDetailServiceDeps): JobDetailServiceImpl {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const flag = async (key: DetailFlag, userId: string) => {
    try {
      return deps.isEnabled ? await deps.isEnabled(key, userId) : false;
    } catch {
      return false;
    }
  };
  /** Optional enrichments never break the page: a failing one contributes nothing. */
  async function soft<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log('job detail: optional part failed', { what, error: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  }

  /** "Fill this form" is offered: a registered ATS type and, when registered, a page the brand's extension runs on. */
  function extensionFills(row: JobRow, market: string): boolean {
    const atsType = row.atsType ?? null;
    if (!atsType || !(deps.extensionAts?.().has(atsType) ?? false)) return false;
    const fills = deps.extensionFillsJob?.() ?? null;
    return fills ? fills(market === 'cn' ? 'cn' : 'intl', atsType, row.applyUrl?.trim() || null) : true;
  }

  async function loadJob(userId: string, jobId: string): Promise<JobRow> {
    const row = (await db.rAJob.findUnique({ where: { id: jobId }, select: JOB_ROW_SELECT })) as JobRow | null;
    if (!row || !isVisibleTo(row, userId, deps.brand().market)) throw notFound();
    // GoApply recruitment-info mode (WP-41 R41-1b; on by default, D5): with the
    // mode set to `off` a third-party posting is invisible (same 404 as a
    // missing job); the user's own import stays visible. Non-cn rows pass through.
    if (!cnPostingVisible(row, userId, deps.env ?? process.env)) throw notFound();
    return row;
  }

  /** Run a tracker write for (userId, jobId) under its advisory lock. */
  async function withEntryLock<T>(userId: string, jobId: string, fn: (tx: TrackerTx) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${trackerEntryLockKey(userId, jobId)}))`;
      return fn(tx as unknown as TrackerTx);
    });
  }

  async function trackerOf(userId: string, jobId: string, client: Pick<TrackerTx, 'rATrackerEntry'> = db): Promise<TrackerRow | null> {
    return (await client.rATrackerEntry.findFirst({
      where: { userId, jobId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: TRACKER_SELECT,
    })) as TrackerRow | null;
  }

  async function interaction(userId: string, jobId: string, kind: string, detail?: Record<string, unknown>) {
    await soft('interaction', () => db.rAJobInteraction.create({ data: { userId, jobId, kind, ...(detail ? { detail: detail as object } : {}) } }), null);
  }

  /** Feed affinity for a save / apply click / applied that changed the tracker (never blocks the action). */
  async function affinity(userId: string, jobId: string, kind: 'save' | 'apply_click' | 'applied') {
    if (deps.recordInteraction) await soft('affinity', () => deps.recordInteraction!(userId, jobId, kind), null);
  }

  async function touchUserState(userId: string, jobId: string, data: { viewedAt?: Date; applyClickedAt?: Date }) {
    await soft(
      'userState',
      () =>
        db.rAJobUserState.upsert({
          where: { userId_jobId: { userId, jobId } },
          create: { userId, jobId, ...data },
          update: data,
        }),
      null,
    );
  }

  async function campusFor(userId: string, row: JobRow): Promise<JobCampusInfo | null> {
    if (row.market !== 'cn' || row.seniority !== 'intern_newgrad') return null;
    if (!(await flag('jobs.campusCalendar', userId))) return null;
    const where = {
      market: 'cn',
      status: 'published',
      kind: 'application',
      ...(row.companyId ? { companyId: row.companyId } : { companyName: row.companyName }),
    };
    const events = (await db.rACampusEvent.findMany({
      where,
      orderBy: [{ applyClosesAt: 'desc' }],
      take: 5,
      select: { title: true, graduationClass: true, applyOpensAt: true, applyClosesAt: true, officialUrl: true, verifiedAt: true },
    })) as CampusEventRow[];
    // The open (or next) programme first, otherwise the most recent one.
    const t = now().getTime();
    const open = events.filter((e) => !e.applyClosesAt || e.applyClosesAt.getTime() >= t).sort((a, b) => (a.applyClosesAt?.getTime() ?? Infinity) - (b.applyClosesAt?.getTime() ?? Infinity));
    return toCampusInfo(open[0] ?? events[0] ?? null, now());
  }

  function similarWhere(row: JobRow) {
    const base = {
      market: row.market,
      visibility: 'public',
      isCanonical: true,
      archivedAt: null,
      closedAt: null,
      id: { not: row.id },
      ...(row.locationCountry ? { locationCountry: row.locationCountry } : {}),
      // Mainland: a posting with no usable apply link is never recommended (the feed's own rule).
      ...(row.market === 'cn' ? { AND: [cnListableWhere()] } : {}),
    };
    return row.primaryTaxonomyId ? { ...base, primaryTaxonomyId: row.primaryTaxonomyId } : { ...base, titleNormalized: row.titleNormalized };
  }

  /** Drop fraud-flagged jobs and the ones this user hid. */
  async function visibleCandidates<T extends { id: string; fraudFlags: unknown }>(userId: string, candidates: T[]): Promise<T[]> {
    const clean = candidates.filter((c) => !isFlagged(c.fraudFlags));
    if (!clean.length) return [];
    const hidden = await db.rAJobUserState.findMany({
      where: { userId, jobId: { in: clean.map((c) => c.id) }, hiddenAt: { not: null } },
      select: { jobId: true },
    });
    const hiddenIds = new Set(hidden.map((h) => h.jobId));
    return clean.filter((c) => !hiddenIds.has(c.id));
  }

  async function similarRows(userId: string, row: JobRow): Promise<JobRow[]> {
    const candidates = (await db.rAJob.findMany({
      where: similarWhere(row),
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: SIMILAR_CANDIDATES,
      select: JOB_ROW_SELECT,
    })) as JobRow[];
    return visibleCandidates(userId, candidates);
  }

  /** `similarIds` for GET /:id: an id-only query, newest first, no scoring (GET /:id/similar ranks by fit). */
  async function similarIdsOf(userId: string, row: JobRow): Promise<string[]> {
    const candidates = await db.rAJob.findMany({
      where: similarWhere(row),
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: SIMILAR_LIMIT * 3,
      select: { id: true, fraudFlags: true },
    });
    return (await visibleCandidates(userId, candidates)).slice(0, SIMILAR_LIMIT).map((c) => c.id);
  }

  async function rankSimilar(userId: string, row: JobRow): Promise<{ rows: JobRow[]; pre: Map<string, PreScoreResult> }> {
    const rows = await similarRows(userId, row);
    const pre = new Map<string, PreScoreResult>();
    if (rows.length && deps.preScore) {
      for (const p of await soft('preScore', () => deps.preScore!(userId, rows.map((r) => r.id)), [] as PreScoreResult[])) pre.set(p.jobId, p);
    }
    // Best fit first (unknown fit last), then newest.
    const order = rows.map((r, i) => ({ r, i, s: pre.get(r.id)?.score ?? null }));
    order.sort((a, b) => (a.s === null ? (b.s === null ? a.i - b.i : 1) : b.s === null ? -1 : b.s - a.s || a.i - b.i));
    return { rows: order.slice(0, SIMILAR_LIMIT).map((o) => o.r), pre };
  }

  async function writeStatus(
    userId: string,
    row: JobRow,
    opts: { appliedAt: Date; via: 'apply_click' | 'manual'; source: string },
  ): Promise<{ entry: TrackerRow; changed: boolean }> {
    return withEntryLock(userId, row.id, (tx) => writeStatusLocked(tx, userId, row, opts));
  }

  async function writeStatusLocked(
    tx: TrackerTx,
    userId: string,
    row: JobRow,
    opts: { appliedAt: Date; via: 'apply_click' | 'manual'; source: string },
  ): Promise<{ entry: TrackerRow; changed: boolean }> {
    const existing = await trackerOf(userId, row.id, tx);
    if (existing && !isPreApply(existing.status)) return { entry: existing, changed: false };
    let entry: TrackerRow;
    if (existing) {
      entry = (await tx.rATrackerEntry.update({
        where: { id: existing.id },
        data: { status: 'applied', dateApplied: existing.dateApplied ?? opts.appliedAt, appliedVia: 'manual' },
        select: TRACKER_SELECT,
      })) as TrackerRow;
    } else {
      entry = (await tx.rATrackerEntry.create({
        data: {
          userId,
          jobId: row.id,
          status: 'applied',
          dateApplied: opts.appliedAt,
          appliedVia: 'manual',
          source: opts.source,
          // Never the column's "USD" default: the posting's currency, or none (the drawer starts from the brand's).
          maxSalaryCurrency: row.salaryCurrency ?? null,
          externalSnapshot: { title: row.title, companyName: row.companyName, location: row.location, applyUrl: row.applyUrl },
        },
        select: TRACKER_SELECT,
      })) as TrackerRow;
    }
    await tx.rATrackerEvent.create({
      data: { entryId: entry.id, userId, kind: 'status', fromValue: existing?.status ?? null, toValue: 'applied', payload: { via: opts.via } },
    });
    return { entry, changed: true };
  }

  return {
    async get(userId, jobId) {
      const brand = deps.brand();
      const row = await loadJob(userId, jobId);
      const [tracker, tailored, letter, practiced, profile, fit, campus, similarIds, people, autofillOn] = await Promise.all([
        trackerOf(userId, jobId),
        db.rAResumeVariant.findFirst({
          where: { userId, targetJobId: jobId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
        db.rACoverLetter.findFirst({ where: { userId, jobId, deletedAt: null }, orderBy: { updatedAt: 'desc' }, select: { id: true } }),
        soft('practiced', () => (deps.practicedForJob ? deps.practicedForJob(userId, jobId) : Promise.resolve(null)), null),
        row.companyId && deps.companyProfile ? soft('company', () => deps.companyProfile!(row.companyId!), null) : Promise.resolve(null),
        deps.cachedFit ? soft('fit', () => deps.cachedFit!(userId, jobId), null) : Promise.resolve(null),
        soft('campus', () => campusFor(userId, row), null),
        soft('similar', async () => ((await flag('jobs.recommendations', userId)) ? similarIdsOf(userId, row) : []), [] as string[]),
        soft(
          'people',
          async () => {
            const mode: HiringContactsMode = deps.hiringContacts ? await deps.hiringContacts(userId) : 'deeplinks_only';
            if (mode === 'off') return { mode, searchLinks: [] };
            const ctx = deps.peopleContext ? await soft('peopleContext', () => deps.peopleContext!(userId), { pastCompanies: [], schools: [] }) : { pastCompanies: [], schools: [] };
            return { mode, searchLinks: peopleSearchLinks(row, ctx, brand.market) };
          },
          { mode: 'off' as HiringContactsMode, searchLinks: [] },
        ),
        flag('extension', userId),
      ]);
      const personalized = fit && deps.personalized ? await soft('personalized', () => deps.personalized!(userId, brand), false) : false;
      const explanation =
        fit && deps.explain ? deps.explain({ market: brand.market === 'cn' ? 'cn' : 'intl', personalized, fit }) : null;
      await touchUserState(userId, jobId, { viewedAt: now() });
      const atsType = row.atsType ?? null;
      return {
        job: toJobDetail(row, now(), campus),
        company: toCompanySummary(row, profile),
        fit,
        explanation,
        tracker: toTrackerState(tracker),
        checklist: toChecklist(tracker, tailored?.id ?? null, letter?.id ?? null, practiced),
        similarIds,
        autofill: { supported: autofillOn && extensionFills(row, brand.market), atsType },
        people,
        marketMeta: deps.marketMeta ? deps.marketMeta(row, brand) : {},
      };
    },

    async similar(userId, jobId) {
      const row = await loadJob(userId, jobId);
      if (!(await flag('jobs.recommendations', userId))) return { items: [] };
      const { rows, pre } = await rankSimilar(userId, row);
      if (!rows.length) return { items: [] };
      const trackers = await db.rATrackerEntry.findMany({
        where: { userId, jobId: { in: rows.map((r) => r.id) }, deletedAt: null },
        select: { jobId: true, status: true },
      });
      const byJob = new Map(trackers.map((t) => [t.jobId, { status: t.status }]));
      return { items: rows.map((r) => toSimilarItem(r, now(), toFitBadge(pre.get(r.id)), byJob.get(r.id) ?? null)) };
    },

    async save(userId, jobId) {
      const row = await loadJob(userId, jobId);
      let isNew = false;
      const entry = await withEntryLock(userId, jobId, async (tx) => {
        const existing = await trackerOf(userId, jobId, tx);
        if (existing) return existing;
        isNew = true;
        const created = (await tx.rATrackerEntry.create({
          data: {
            userId,
            jobId,
            status: 'bookmarked',
            source: 'feed',
            maxSalaryCurrency: row.salaryCurrency ?? null,
            externalSnapshot: { title: row.title, companyName: row.companyName, location: row.location, applyUrl: row.applyUrl },
          },
          select: TRACKER_SELECT,
        })) as TrackerRow;
        await tx.rATrackerEvent.create({ data: { entryId: created.id, userId, kind: 'status', fromValue: null, toValue: 'bookmarked', payload: { via: 'save' } } });
        return created;
      });
      await interaction(userId, jobId, 'save');
      if (isNew) await affinity(userId, jobId, 'save');
      // Every save counts (idempotent on the growth side; ruling C20). Never blocks the save.
      if (deps.markChecklistStep) await soft('checklist', () => deps.markChecklistStep!(userId, 'save_job'), null);
      return { tracker: toTrackerState(entry) };
    },

    async unsave(userId, jobId) {
      await loadJob(userId, jobId);
      const entry = await trackerOf(userId, jobId);
      if (!entry) return { tracker: null };
      if (!isPreApply(entry.status)) {
        throw new HttpError('conflict', 'This job is already in your applications.', { code: JOB_DETAIL_ERROR_CODES.inTracker, status: entry.status });
      }
      // Under the entry lock, re-read: an apply click may have moved it since.
      const movedTo = await withEntryLock(userId, jobId, async (tx): Promise<string | null> => {
        const current = await trackerOf(userId, jobId, tx);
        if (!current) return null;
        if (!isPreApply(current.status)) return current.status;
        await tx.rATrackerEntry.update({ where: { id: current.id }, data: { deletedAt: now() } });
        return null;
      });
      if (movedTo) {
        throw new HttpError('conflict', 'This job is already in your applications.', { code: JOB_DETAIL_ERROR_CODES.inTracker, status: movedTo });
      }
      await interaction(userId, jobId, 'unsave');
      return { tracker: null };
    },

    async recordApplyClick(userId, jobId) {
      const row = await loadJob(userId, jobId);
      if (isClosed(row)) throw new HttpError('conflict', 'This job is no longer listed.', { code: JOB_DETAIL_ERROR_CODES.closed });
      const applyUrl = row.applyUrl?.trim() || null;
      // Nowhere to send the user: nothing moves to Applied ("I applied" covers this case).
      if (!applyUrl) throw new HttpError('conflict', 'This job has no application link.', { code: JOB_DETAIL_ERROR_CODES.noApplyLink });
      const at = now();
      const { entry, changed } = await writeStatus(userId, row, { appliedAt: at, via: 'apply_click', source: 'feed' });
      await touchUserState(userId, jobId, { applyClickedAt: at });
      if (changed) {
        await interaction(userId, jobId, 'apply_click');
        await affinity(userId, jobId, 'apply_click');
      }
      const atsType = row.atsType ?? null;
      const extOn = await flag('extension', userId);
      return {
        applyUrl,
        atsType,
        extensionSupported: extOn && extensionFills(row, deps.brand().market),
        trackerEntryId: entry.id,
        alreadyApplied: !changed,
      };
    },

    async markApplied(userId, jobId, appliedAt) {
      const row = await loadJob(userId, jobId);
      const at = appliedAt ? new Date(appliedAt) : now();
      if (at.getTime() > now().getTime() + 60_000) throw new HttpError('invalid_request', 'The date applied is in the future.');
      const { entry, changed } = await writeStatus(userId, row, { appliedAt: at, via: 'manual', source: 'manual' });
      if (changed) {
        await interaction(userId, jobId, 'applied');
        await affinity(userId, jobId, 'applied');
      }
      return { tracker: toTrackerState(entry)!, alreadyApplied: !changed };
    },

    async undoApplied(userId, jobId) {
      await loadJob(userId, jobId);
      const result = await withEntryLock(userId, jobId, async (tx) => {
        const entry = await trackerOf(userId, jobId, tx);
        if (!entry || entry.status !== 'applied') return { next: entry, reverted: false };
        // The newest move INTO Applied, whoever recorded it: this service writes a
        // `status` event; the tracker core (Ready to apply, the extension)
        // writes `status`, or `created` when the apply action made the entry.
        const last = (await tx.rATrackerEvent.findFirst({
          where: { entryId: entry.id, kind: { in: ['status', 'created'] }, toValue: 'applied' },
          orderBy: { createdAt: 'desc' },
          select: { kind: true, fromValue: true, payload: true, createdAt: true },
        })) as MoveEvent | null;
        // Only a recent move made by an apply action is undone; an older
        // application, or a stage change made by hand in the tracker (no
        // apply `via`), stays as it is.
        const payload = last?.payload && typeof last.payload === 'object' ? (last.payload as Record<string, unknown>) : {};
        const via = payload.via;
        const recent = !!last?.createdAt && now().getTime() - new Date(last.createdAt).getTime() <= UNDO_APPLIED_WINDOW_MS;
        if (!last || typeof via !== 'string' || !UNDOABLE_VIA.has(via) || !recent) return { next: entry, reverted: false };
        const previous = last.kind === 'created' ? null : (last.fromValue ?? null);
        // The move stamped the applied date unless it says the entry already had one
        // (the tracker core then records the channel it replaced).
        const hadDate = 'previousAppliedVia' in payload && payload.stampedDateApplied !== true;
        const restoreVia = typeof payload.previousAppliedVia === 'string' ? payload.previousAppliedVia : null;
        let next: TrackerRow | null;
        if (previous) {
          // Back to where it was: Saved, or (a re-application) the ended stage it had.
          // The move to Applied cleared who ended it; an ended stage gets that
          // back, as the tracker's own undo does (the export and the weekly
          // facts read `outcome`).
          const outcome = outcomeOfStatus(previous);
          const before = outcome
            ? ((await tx.rATrackerEntry.findFirst({ where: { id: entry.id }, select: { outcome: true } })) as { outcome: string | null } | null)
            : null;
          next = (await tx.rATrackerEntry.update({
            where: { id: entry.id },
            data: {
              ...(hadDate ? { status: previous, appliedVia: restoreVia } : { status: previous, dateApplied: null, appliedVia: null }),
              ...(outcome ? { outcome } : {}),
            },
            select: TRACKER_SELECT,
          })) as TrackerRow;
          if (outcome) {
            await tx.rATrackerEvent.create({
              data: { entryId: entry.id, userId, kind: 'outcome', fromValue: before?.outcome ?? null, toValue: outcome, payload: { via: 'undo' } },
            });
          }
        } else {
          // The apply action created the entry: undo removes it (soft delete), as if never applied.
          await tx.rATrackerEntry.update({ where: { id: entry.id }, data: { deletedAt: now() } });
          next = null;
        }
        await tx.rATrackerEvent.create({
          data: { entryId: entry.id, userId, kind: 'status', fromValue: 'applied', toValue: next ? next.status : 'removed', payload: { via: 'undo' } },
        });
        return { next, reverted: true };
      });
      if (result.reverted) await interaction(userId, jobId, 'unapplied');
      return { tracker: toTrackerState(result.next) };
    },

    async share(userId, jobId) {
      const row = await loadJob(userId, jobId);
      await interaction(userId, jobId, 'share');
      return shareTarget(deps.brand(), row);
    },

    async companyNews(userId, jobId) {
      const brand = deps.brand();
      // The `companyNews` flag and a configured search only: no market term (D5). The search itself
      // carries the company name and nothing personal, and answers "no news" where it may not run.
      if (!(await flag('companyNews', userId)) || !deps.searchNews) {
        throw new HttpError('feature_disabled');
      }
      const row = await loadJob(userId, jobId);
      const items = (await deps.searchNews(brand, row.companyName)) ?? [];
      return { items, kind: 'search_results', fetchedAt: now().toISOString() };
    },
  };
}

/** Exposed for tests and other callers that already hold a tracker entry view. */
export type { JobTrackerState };

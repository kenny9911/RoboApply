// server/src/features/lifecycle/repo.ts
//
// Typed, lazy Prisma adapter for the lifecycle sequence. Batch reads per
// chunk of users; the costly per-person facts (top job, practice credits,
// the re-engagement count) are separate calls the service makes only when a
// row would otherwise be sent.

import type prismaClient from '../../lib/prisma.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId, Market } from '../../platform/brand/registry.js';
import type { FitSnapshot } from '../match/contract.js';
import type { Fit } from '../match/index.js';
import { LIFECYCLE_TEMPLATE_KEYS, type LifecycleFacts, type SentRecord } from './rules.js';

export interface LifecyclePerson extends LifecycleFacts {
  userId: string;
  brand: BrandId;
  /** GoApply identity (应届 / 在校 / 社招) for the first-value route. */
  cnIdentity: 'yingjie' | 'zaixiao' | 'shezhao' | null;
}

/** The job a lifecycle message may name, with what its fit was when the message was built. */
export interface TopFitJob {
  id: string;
  title: string;
  company: string;
  fit?: FitSnapshot;
}

/** The fields of a `Fit` (match/fit.ts) the tip reads. */
type TipFit = Pick<Fit, 'score' | 'tier' | 'kind' | 'version' | 'scoredAt'>;

/** How many different jobs with a stored score the tip looks at (their live fit decides). */
export const TOP_FIT_CANDIDATES = 20;

export interface LifecycleRepo {
  /**
   * Live accounts new enough for rows 2–6 or idle long enough for row 10 (one
   * brand), ordered by id and paged with `afterId` so a run walks all of them.
   */
  candidates(input: { brandId: BrandId; now: Date; afterId: string | null; limit: number }): Promise<string[]>;
  people(userIds: readonly string[], now: Date): Promise<Map<string, LifecyclePerson>>;
  /**
   * Record a lifecycle send whatever channel carried it (in-app off, email
   * suppressed, push only): once-only rows and the one-a-day budget read it back.
   */
  recordSent(userId: string, templateKey: string, at: Date): Promise<void>;
  /**
   * The open public job (not hidden) whose fit is an AI fit at Good or better
   * right now, best first, for the tailoring tip. `fit` is the snapshot that
   * travels with the message (kind, versions, scoredAt; strategy 2.2 I6).
   */
  topFitJob(userId: string, market: Market): Promise<TopFitJob | null>;
  /** The active (else default) saved search. */
  activeSearch(userId: string): Promise<{ id: string; name: string; filters: unknown } | null>;
}

type LifecycleDb = Pick<
  typeof prismaClient,
  | 'user'
  | 'seekerNotification'
  | 'rAEmailLog'
  | 'rARateCounter'
  | 'rAResumeGrade'
  | 'rATailorSession'
  | 'mockInterviewCreditLedger'
  | 'rASearchProfile'
  | 'rAJobMatchScore'
  | 'rAJobUserState'
>;

export interface PrismaLifecycleRepoOptions {
  /** Tests pass a fake client; production loads Prisma on first use. */
  getDb?: () => Promise<LifecycleDb>;
  /** Where the GoApply recruitment-info mode is read from (default `process.env`). */
  env?: EnvSource;
  /**
   * THE fit of each candidate (match/fit.ts `getFits`; never a model call).
   * Default: the production functions, loaded on first use. Runs in the brand
   * of the cron run.
   */
  fits?: (userId: string, jobIds: string[]) => Promise<ReadonlyMap<string, TipFit>>;
  /** `fitSnapshot` of match/fit.ts (default: the production function). */
  snapshot?: (fit: TipFit) => FitSnapshot;
}

async function defaultFits(userId: string, jobIds: string[]): Promise<ReadonlyMap<string, TipFit>> {
  return (await import('../match/index.js')).getFits(userId, jobIds);
}

async function defaultSnapshot(fit: TipFit): Promise<FitSnapshot> {
  return (await import('../match/index.js')).fitSnapshot(fit);
}

async function defaultDb(): Promise<LifecycleDb> {
  return (await import('../../lib/prisma.js')).default;
}

const DAY = 24 * 3_600_000;
/** Lifecycle history read back this far. */
export const HISTORY_DAYS = 90;
/** New accounts: rows 2–6 run within ~2 weeks of signup. */
const NEW_ACCOUNT_DAYS = 14;
/** Idle accounts: row 10 runs between 14 and 31 days of inactivity. */
const IDLE_FROM_DAYS = 14;
const IDLE_TO_DAYS = 31;

/**
 * Channel-independent send record: one `RARateCounter` row per send
 * (key `lifecycle:sent:<userId>:<templateKey>`, windowStart = send time),
 * kept for HISTORY_DAYS and then pruned by `jobs-maintain` like any counter.
 */
export const SENT_MARKER_PREFIX = 'lifecycle:sent:';

export function sentMarkerKey(userId: string, templateKey: string): string {
  return `${SENT_MARKER_PREFIX}${userId}:${templateKey}`;
}

/**
 * Env: the ISO time the resume-check view stamp went live (the release that
 * started writing `RAResumeGrade.viewedAt`). A check completed before it has
 * `viewedAt = null` whether or not it was opened, so only checks completed
 * from this time on can be known as "not viewed". Unset or unreadable: no
 * check is known as unopened and lifecycle row 4 is not sent.
 */
export const RESUME_CHECK_VIEW_SIGNAL_SINCE_ENV = 'RESUME_CHECK_VIEW_SIGNAL_SINCE';

export function resumeCheckViewSignalSince(env: EnvSource = process.env): Date | null {
  const raw = env[RESUME_CHECK_VIEW_SIGNAL_SINCE_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}

function cnIdentityOf(v: unknown): LifecyclePerson['cnIdentity'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = (v as { identity?: unknown }).identity;
  return id === 'yingjie' || id === 'zaixiao' || id === 'shezhao' ? id : null;
}

function issueCountOf(counts: unknown): number | null {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const c = counts as { urgent?: unknown; critical?: unknown };
  const urgent = typeof c.urgent === 'number' && Number.isFinite(c.urgent) ? c.urgent : null;
  const critical = typeof c.critical === 'number' && Number.isFinite(c.critical) ? c.critical : null;
  if (urgent === null && critical === null) return null;
  return (urgent ?? 0) + (critical ?? 0);
}

export function createPrismaLifecycleRepo(options: PrismaLifecycleRepoOptions = {}): LifecycleRepo {
  const db = options.getDb ?? defaultDb;
  const env = options.env ?? process.env;
  return {
    async candidates({ brandId, now, afterId, limit }) {
      const p = await db();
      const rows = await p.user.findMany({
        where: {
          brand: brandId,
          isActive: true,
          seekerProfile: { is: { deletedAt: null } },
          ...(afterId ? { id: { gt: afterId } } : {}),
          OR: [
            { createdAt: { gte: new Date(now.getTime() - NEW_ACCOUNT_DAYS * DAY) } },
            { lastActiveAt: { gte: new Date(now.getTime() - IDLE_TO_DAYS * DAY), lte: new Date(now.getTime() - IDLE_FROM_DAYS * DAY) } },
            { lastActiveAt: null, createdAt: { gte: new Date(now.getTime() - IDLE_TO_DAYS * DAY) } },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => r.id);
    },

    async recordSent(userId, templateKey, at) {
      const p = await db();
      await p.rARateCounter.createMany({
        data: [{ key: sentMarkerKey(userId, templateKey), windowStart: at, count: 1, expiresAt: new Date(at.getTime() + HISTORY_DAYS * DAY) }],
        skipDuplicates: true,
      });
    },

    async people(userIds, now) {
      const out = new Map<string, LifecyclePerson>();
      const ids = [...new Set(userIds)];
      if (!ids.length) return out;
      const p = await db();
      const since = new Date(now.getTime() - HISTORY_DAYS * DAY);
      const viewSignalSince = resumeCheckViewSignalSince(env);
      const keys = [...LIFECYCLE_TEMPLATE_KEYS];
      const markerKeys = new Map<string, { userId: string; templateKey: string }>();
      for (const id of ids) for (const k of keys) markerKeys.set(sentMarkerKey(id, k), { userId: id, templateKey: k });
      const [users, inApp, emails, markers, grades, tailored, practiced, searches] = await Promise.all([
        p.user.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            brand: true,
            createdAt: true,
            lastActiveAt: true,
            seekerProfile: { select: { onboardingStep: true, onboardingCompletedAt: true } },
            raProfile: { select: { cnFields: true } },
          },
        }),
        p.seekerNotification.findMany({
          where: { userId: { in: ids }, templateKey: { in: keys }, createdAt: { gte: since } },
          select: { userId: true, templateKey: true, createdAt: true },
        }),
        p.rAEmailLog.findMany({
          where: { userId: { in: ids }, template: { in: keys }, status: 'sent', createdAt: { gte: since } },
          select: { userId: true, template: true, createdAt: true },
        }),
        p.rARateCounter.findMany({
          where: { key: { in: [...markerKeys.keys()] }, windowStart: { gte: since } },
          select: { key: true, windowStart: true },
        }),
        p.rAResumeGrade.findMany({
          where: { userId: { in: ids }, status: 'done', completedAt: { not: null } },
          select: { userId: true, variantId: true, completedAt: true, counts: true, viewedAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        p.rATailorSession.findMany({ where: { userId: { in: ids }, status: 'finalized' }, select: { userId: true }, distinct: ['userId'] }),
        p.mockInterviewCreditLedger.findMany({ where: { userId: { in: ids }, reason: 'debit_interview' }, select: { userId: true }, distinct: ['userId'] }),
        p.rASearchProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true }, distinct: ['userId'] }),
      ]);

      const history = new Map<string, SentRecord[]>();
      const push = (userId: string | null, templateKey: string | null, at: Date) => {
        if (!userId || !templateKey) return;
        const list = history.get(userId) ?? [];
        // The in-app row and the email of one send are a few seconds apart: count them once.
        if (!list.some((h) => h.templateKey === templateKey && Math.abs(h.at.getTime() - at.getTime()) < 10 * 60_000)) list.push({ templateKey, at });
        history.set(userId, list);
      };
      for (const r of inApp) push(r.userId, r.templateKey, r.createdAt);
      for (const r of emails) push(r.userId, r.template, r.createdAt);
      for (const r of markers) {
        const m = markerKeys.get(r.key);
        if (m) push(m.userId, m.templateKey, r.windowStart);
      }

      const firstGrade = new Map<string, (typeof grades)[number]>();
      // SR-39a-1: `viewedAt` is stamped on the owner's first authenticated read
      // of a completed check. Opening ANY completed check counts: the message is
      // about the person's first check, and whoever opened a later one has seen
      // what the message would point to. A null stamp only means "not opened"
      // for a check completed after the stamp went live (`viewSignalSince`).
      const viewedAny = new Set<string>();
      for (const g of grades) {
        if (!firstGrade.has(g.userId)) firstGrade.set(g.userId, g);
        if (g.viewedAt) viewedAny.add(g.userId);
      }
      const tailoredSet = new Set(tailored.map((r) => r.userId));
      const practicedSet = new Set(practiced.map((r) => r.userId));
      const searchSet = new Set(searches.map((r) => r.userId));

      for (const u of users) {
        const g = firstGrade.get(u.id);
        out.set(u.id, {
          userId: u.id,
          brand: u.brand === 'goapply' ? 'goapply' : 'roboapply',
          createdAt: u.createdAt,
          lastActiveAt: u.lastActiveAt,
          onboardingStep: u.seekerProfile?.onboardingStep ?? null,
          onboardingCompletedAt: u.seekerProfile?.onboardingCompletedAt ?? null,
          cnIdentity: cnIdentityOf(u.raProfile?.cnFields),
          history: history.get(u.id) ?? [],
          resumeCheck:
            g && g.completedAt
              ? // `viewed` is the server's own record (RAResumeGrade.viewedAt), not a
                // consent-gated product event. false = completed after the stamp
                // went live and never opened; null = completed before it (or the
                // go-live time is not set), so whether it was opened is not known.
                {
                  resumeId: g.variantId,
                  completedAt: g.completedAt,
                  issueCount: issueCountOf(g.counts),
                  viewed: viewedAny.has(u.id) ? true : viewSignalSince && g.completedAt.getTime() >= viewSignalSince.getTime() ? false : null,
                }
              : null,
          hasTailored: tailoredSet.has(u.id),
          practiceUsed: practicedSet.has(u.id),
          hasSearch: searchSet.has(u.id),
        });
      }
      return out;
    },

    async topFitJob(userId, market) {
      // R-14 / R41-1b: on GoApply with the recruitment-info mode off no message
      // names a third-party posting, so the tip goes out without a job.
      if (market === 'cn') {
        const { cnJobCapabilities } = await import('../cn/jobs/index.js');
        if (!cnJobCapabilities(env).postings) return null;
      }
      const p = await db();
      // Candidate ids only. A stored row may be for another resume version, of
      // any age, or written for a resume the person has since replaced, so the
      // row decides nothing: THE fit of each candidate does (below).
      // `distinct` before `take`: a job has one row per resume version, and
      // tailored versions hold the highest rows, so without it a handful of
      // jobs could fill every place and crowd out the job that has an AI fit
      // for the main resume. The candidates are TOP_FIT_CANDIDATES different jobs.
      const rows = await p.rAJobMatchScore.findMany({
        where: {
          userId,
          tier: { in: ['great', 'good'] },
          job: { market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
        },
        select: { jobId: true, score: true, job: { select: { title: true, companyName: true } } },
        orderBy: { score: 'desc' },
        distinct: ['jobId'],
        take: TOP_FIT_CANDIDATES,
      });
      if (!rows.length) return null;
      const byId = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!byId.has(r.jobId)) byId.set(r.jobId, r);
      const ids = [...byId.keys()];
      const hidden = await p.rAJobUserState.findMany({
        where: { userId, jobId: { in: ids }, hiddenAt: { not: null } },
        select: { jobId: true },
      });
      const hiddenSet = new Set(hidden.map((h) => h.jobId));
      const open = ids.filter((id) => !hiddenSet.has(id));
      if (!open.length) return null;
      // The mail names a job only by the fit every surface shows now: an AI fit
      // of the primary resume at Good or better. A stale or version-specific
      // stored row, or a job that only has a quick estimate, is not named.
      const fits = await (options.fits ?? defaultFits)(userId, open);
      const named = open
        .map((id) => ({ id, fit: fits.get(id) }))
        .filter((c): c is { id: string; fit: TipFit } => !!c.fit && c.fit.kind === 'ai' && c.fit.score !== null && (c.fit.tier === 'great' || c.fit.tier === 'good'))
        .sort((a, b) => (b.fit.score ?? 0) - (a.fit.score ?? 0) || open.indexOf(a.id) - open.indexOf(b.id));
      const top = named[0];
      if (!top) return null;
      const row = byId.get(top.id)!;
      const fit = options.snapshot ? options.snapshot(top.fit) : await defaultSnapshot(top.fit);
      return { id: top.id, title: row.job.title, company: row.job.companyName, fit };
    },

    async activeSearch(userId) {
      const p = await db();
      const row = await p.rASearchProfile.findFirst({
        where: { userId },
        select: { id: true, name: true, filters: true },
        orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }],
      });
      return row ? { id: row.id, name: row.name, filters: row.filters } : null;
    },
  };
}

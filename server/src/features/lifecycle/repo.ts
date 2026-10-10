// server/src/features/lifecycle/repo.ts
//
// Typed, lazy Prisma adapter for the lifecycle sequence. Batch reads per
// chunk of users; the costly per-person facts (top job, practice credits,
// the re-engagement count) are separate calls the service makes only when a
// row would otherwise be sent.

import type { BrandId, Market } from '../../platform/brand/registry.js';
import { LIFECYCLE_TEMPLATE_KEYS, type LifecycleFacts, type SentRecord } from './rules.js';

export interface LifecyclePerson extends LifecycleFacts {
  userId: string;
  brand: BrandId;
  /** GoApply identity (应届 / 在校 / 社招) for the first-value route. */
  cnIdentity: 'yingjie' | 'zaixiao' | 'shezhao' | null;
}

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
  /** Highest Great/Good fit open public job (not hidden) for the tailoring tip. */
  topFitJob(userId: string, market: Market): Promise<{ id: string; title: string; company: string } | null>;
  /** The active (else default) saved search. */
  activeSearch(userId: string): Promise<{ name: string; filters: unknown } | null>;
}

async function db() {
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

export function createPrismaLifecycleRepo(): LifecycleRepo {
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
          select: { userId: true, variantId: true, completedAt: true, counts: true },
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
      for (const g of grades) if (!firstGrade.has(g.userId)) firstGrade.set(g.userId, g);
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
              ? // No reliable "viewed" signal exists yet (nothing emits resume_check_viewed, and
                // product events are consent-gated): unknown → row 4 is not sent. SR-39a-1.
                { resumeId: g.variantId, completedAt: g.completedAt, issueCount: issueCountOf(g.counts), viewed: null }
              : null,
          hasTailored: tailoredSet.has(u.id),
          practiceUsed: practicedSet.has(u.id),
          hasSearch: searchSet.has(u.id),
        });
      }
      return out;
    },

    async topFitJob(userId, market) {
      const p = await db();
      const rows = await p.rAJobMatchScore.findMany({
        where: {
          userId,
          tier: { in: ['great', 'good'] },
          job: { market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
        },
        select: { jobId: true, score: true, job: { select: { title: true, companyName: true } } },
        orderBy: { score: 'desc' },
        take: 10,
      });
      if (!rows.length) return null;
      const hidden = await p.rAJobUserState.findMany({
        where: { userId, jobId: { in: rows.map((r) => r.jobId) }, hiddenAt: { not: null } },
        select: { jobId: true },
      });
      const hiddenSet = new Set(hidden.map((h) => h.jobId));
      const top = rows.find((r) => !hiddenSet.has(r.jobId));
      return top ? { id: top.jobId, title: top.job.title, company: top.job.companyName } : null;
    },

    async activeSearch(userId) {
      const p = await db();
      const row = await p.rASearchProfile.findFirst({
        where: { userId },
        select: { name: true, filters: true },
        orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }],
      });
      return row ? { name: row.name, filters: row.filters } : null;
    },
  };
}

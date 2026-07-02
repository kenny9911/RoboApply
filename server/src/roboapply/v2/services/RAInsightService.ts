// backend/src/roboapply/v2/services/RAInsightService.ts
//
// Weekly career insight. GET /weekly returns the latest cached row for the
// week; POST /refresh regenerates via RACareerInsightAgent (BE3-owned).
// Rate-limited to 1 refresh per hour per user — enforced in-process. Quota:
// `ra_insight` SKU on success.

import prisma from '../../../lib/prisma.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { pickCareerInsightModel } from '../agents/RACareerInsightAgent.js';

export interface RACareerInsightView {
  id: string;
  userId: string;
  weekStartUtc: string;
  summaryMarkdown: string;
  citedTrackerIds: string[];
  metrics: {
    applicationsCount: number;
    interviewsCount: number;
    offerCount: number;
    weeksToOfferEstimate: number | null;
    recruiterViewsCount: number | null;
    topSkillsObserved: string[];
  } | null;
  modelUsed: string;
  citationGuardPassed: boolean;
  generatedAt: string;
  createdAt: string;
}

function isoDate(d: any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function isoDateOnly(d: any): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function toView(row: any): RACareerInsightView {
  return {
    id: row.id,
    userId: row.userId,
    weekStartUtc: isoDateOnly(row.weekStartUtc),
    summaryMarkdown: row.summaryMarkdown ?? '',
    citedTrackerIds: Array.isArray(row.citedTrackerIds) ? row.citedTrackerIds : [],
    metrics: (row.metrics as RACareerInsightView['metrics']) ?? null,
    modelUsed: row.modelUsed ?? '',
    citationGuardPassed: !!row.citationGuardPassed,
    generatedAt: isoDate(row.generatedAt),
    createdAt: isoDate(row.createdAt),
  };
}

export function currentWeekStartUtc(): string {
  const now = new Date();
  const dow = now.getUTCDay();
  const sunday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow),
  );
  return sunday.toISOString().slice(0, 10);
}

export function weekRangeFor(weekStartUtc: string): { startUtc: string; endUtc: string } {
  const start = new Date(weekStartUtc + 'T00:00:00.000Z');
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return {
    startUtc: start.toISOString().slice(0, 10),
    endUtc: end.toISOString().slice(0, 10),
  };
}

function computeMetrics(tracker: any[]): RACareerInsightView['metrics'] {
  return {
    applicationsCount: tracker.filter((t) => !!t.dateApplied).length,
    interviewsCount: tracker.filter((t) => t.status === 'interviewing').length,
    offerCount: tracker.filter(
      (t) => t.status === 'accepted' || t.status === 'negotiating',
    ).length,
    weeksToOfferEstimate: null,
    recruiterViewsCount: null,
    topSkillsObserved: [],
  };
}

// In-memory throttle: 1 refresh / hour per user. Matches stub semantics. Lost
// on restart — acceptable for a developer-facing refresh button.
const lastRefreshAt = new Map<string, number>();
const COOLDOWN_MS = 60 * 60 * 1000;

export class InsightRateLimitedError extends Error {
  constructor() {
    super('Already refreshed recently');
    this.name = 'InsightRateLimitedError';
  }
}

export class RAInsightService {
  /** GET /weekly. Returns null when no row for the week. */
  async getWeekly(
    userId: string,
    weekStartUtc?: string,
  ): Promise<{ insight: RACareerInsightView | null; weekStartUtc: string }> {
    const p = prisma as any;
    const week = weekStartUtc ?? currentWeekStartUtc();
    const row = await p.rACareerInsight.findUnique({
      where: {
        userId_weekStartUtc: {
          userId,
          weekStartUtc: new Date(week + 'T00:00:00.000Z'),
        },
      },
    });
    return { insight: row ? toView(row) : null, weekStartUtc: week };
  }

  /** POST /refresh. Throws InsightRateLimitedError when called within the
   *  cooldown window. Calls BE3's `RACareerInsightAgent` if a goal exists,
   *  otherwise falls back to a deterministic summary. On agent success,
   *  writes a `ra_insight` deduction log row. */
  async refresh(userId: string, locale?: string): Promise<RACareerInsightView> {
    const last = lastRefreshAt.get(userId) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) {
      throw new InsightRateLimitedError();
    }
    const p = prisma as any;
    const week = currentWeekStartUtc();

    const [goal, tracker, resumes] = await Promise.all([
      p.rACareerGoal.findUnique({ where: { userId } }),
      p.rATrackerEntry.findMany({
        where: {
          userId,
          updatedAt: { gte: new Date(Date.now() - 28 * 86_400_000) },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      p.rAResumeVariant.findMany({
        where: { userId, deletedAt: null },
        orderBy: { lastEditedAt: 'desc' },
        take: 20,
      }),
    ]);

    let summary = '';
    let citedTrackerIds: string[] = [];
    let metrics: RACareerInsightView['metrics'] = null;
    const modelUsed = pickCareerInsightModel();
    let citationGuardPassed = true;
    let agentSucceeded = false;

    if (goal) {
      try {
        const { RACareerInsightAgent } = await import(
          '../agents/RACareerInsightAgent.js'
        );
        const agent = new RACareerInsightAgent();
        const out = await agent.run({
          goal: {
            targetTitle: goal.targetTitle,
            targetDate: goal.targetDate
              ? (goal.targetDate instanceof Date
                  ? goal.targetDate.toISOString().slice(0, 10)
                  : String(goal.targetDate))
              : null,
            weeklyApplicationGoal: goal.weeklyApplicationGoal ?? 5,
            targetSalaryMin: goal.targetSalaryMin ?? null,
            targetSalaryMax: goal.targetSalaryMax ?? null,
            targetSalaryCurrency: goal.targetSalaryCurrency ?? null,
            preferredWorkType: goal.preferredWorkType ?? null,
            seniority: goal.seniority ?? null,
            notesMarkdown: goal.notesMarkdown ?? null,
          },
          trackerEntriesLast4Weeks: (tracker as any[]).map((t) => ({
            id: t.id,
            status: t.status,
            excitementStars: t.excitementStars ?? null,
            dateSaved: t.dateSaved instanceof Date
              ? t.dateSaved.toISOString()
              : String(t.dateSaved),
            dateApplied: t.dateApplied
              ? (t.dateApplied instanceof Date
                  ? t.dateApplied.toISOString()
                  : String(t.dateApplied))
              : null,
            notesMarkdown: t.notesMarkdown ?? null,
            externalSnapshot: t.externalSnapshot ?? null,
          })),
          resumeVariants: (resumes as any[]).map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            targetJobId: r.targetJobId ?? null,
            lastEditedAt: r.lastEditedAt instanceof Date
              ? r.lastEditedAt.toISOString()
              : String(r.lastEditedAt),
          })),
        }, { locale });
        const headline = typeof out?.headline === 'string' ? out.headline : '';
        const body = typeof out?.bodyMarkdown === 'string' ? out.bodyMarkdown : '';
        summary = headline ? `## ${headline}\n\n${body}` : body;
        citedTrackerIds = Array.isArray(out?.citedTrackerIds) ? out.citedTrackerIds : [];
        metrics = computeMetrics(tracker as any[]);
        citationGuardPassed = true;
        agentSucceeded = true;
      } catch (err) {
        logger.warn('RA_V2_INSIGHT', 'insight agent failed; using deterministic fallback', {
          userId,
          weekStartUtc: week,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!agentSucceeded) {
      const recent = (tracker as any[])
        .filter((t) => t.status === 'applied' || t.status === 'interviewing')
        .slice(0, 2)
        .map((t) => t.id);
      citedTrackerIds = recent;
      summary =
        `## Week summary\n\nYou're moving steadily through the funnel. ` +
        `Top priority this week: keep momentum on your active interviews ` +
        `and follow up on applications past their 5-day window.`;
      metrics = computeMetrics(tracker as any[]);
      citationGuardPassed = false;
    }

    const row = await p.rACareerInsight.upsert({
      where: {
        userId_weekStartUtc: {
          userId,
          weekStartUtc: new Date(week + 'T00:00:00.000Z'),
        },
      },
      create: {
        userId,
        weekStartUtc: new Date(week + 'T00:00:00.000Z'),
        summaryMarkdown: summary,
        citedTrackerIds,
        metrics: (metrics ?? {}) as any,
        modelUsed,
        citationGuardPassed,
        generatedAt: new Date(),
      },
      update: {
        summaryMarkdown: summary,
        citedTrackerIds,
        metrics: (metrics ?? {}) as any,
        modelUsed,
        citationGuardPassed,
        generatedAt: new Date(),
      },
    });

    if (agentSucceeded) {
      const cost = costPatchFromTally(getCurrentRequestId());
      await writeDeductionLog({
        userId,
        sku: 'ra_insight',
        source: 'plan',
        platformCostUsd: cost.platformCostUsd,
        units: 1,
        requestId: getCurrentRequestId() ?? null,
        relatedEntityType: 'ra_career_insight',
        relatedEntityId: row.id,
        metadata: {
          ...cost.metadata,
          source: 'roboapply_v2',
          agent: 'RACareerInsightAgent',
        },
      });
    }

    lastRefreshAt.set(userId, Date.now());
    logger.info('RA_V2_INSIGHT', 'insight refreshed', {
      userId,
      insightId: row.id,
      weekStartUtc: week,
      agentSucceeded,
    });
    return toView(row);
  }
}

export const raInsightService = new RAInsightService();

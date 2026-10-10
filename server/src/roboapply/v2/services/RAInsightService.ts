// backend/src/roboapply/v2/services/RAInsightService.ts
//
// The weekly card on /applications?view=date (ruling C40; WP-38).
//
//   getWeekly(userId, week?) → the week's counts (always, from the user's own
//                               tracker rows) + the AI summary for that week
//                               when one was written
//   refresh(userId, locale)  → writes this week's AI summary with
//                               RACareerInsightAgent (route: 1 per hour)
//
// Honesty (D3, WP-38): the counts are real counts; the summary exists only
// when a model wrote it and is flagged `aiGenerated` (GoApply renders
// AiGeneratedBadge). There is no canned fallback narrative any more: rows the
// pre-clone code stored with `modelUsed = 'deterministic'` are never shown.
// AI consent (TASK_PLAN §2.2): no LLM call unless `aiAllowed(user)` and the
// brand's `ai.text` capability is on. Free-text notes are redacted before
// they reach the prompt.
// Job scope (R-14; INT-13): the prompt names a tracked job only when this
// viewer may read it (`legacyJobVisible`: the brand's market, public or the
// user's own import, and on GoApply with CN_RECRUITMENT_INFO_MODE=off no
// third-party posting). A tracked job that fails the check is sent without a
// title or company, including its stored snapshot (a copy of that posting).
// The stored text is checked again on every read: `refresh` records which job
// rows the prompt named (`metrics.namedJobIds`), and `getWeekly` shows the
// summary only while the viewer may still read each of them. So a GoApply
// summary written while postings were allowed is not shown after the mode is
// switched off; the counts stay and a refresh writes a clean one. A summary
// stored before the marker existed is shown except on GoApply with the mode off.

import type { Prisma } from '../../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { aiAllowed as defaultAiAllowed } from '../../../platform/consent/index.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { cnJobCapabilities } from '../../../features/cn/jobs/index.js';
import { isEnabledForBrand } from '../../../platform/flags.js';
import { HttpError } from '../../../platform/http.js';
import { LLM_PII_KINDS, redactPii } from '../../../platform/pii/index.js';
import {
  trackerCore,
  weekStartFor,
  type TrackerCore,
  type WeeklyFacts,
  type WeeklyInsightResponse,
  type WeeklyInsightView,
} from '../../../features/tracker/index.js';
import type { RACareerInsightInput, RACareerInsightOutput } from '../agents/RACareerInsightAgent.js';
import { LEGACY_JOB_SCOPE_SELECT, legacyJobVisible, type LegacyJobScopeRow } from '../lib/legacyJobScope.js';

/** The marker the pre-clone fallback wrote; such rows hold canned text and are never shown. */
export const DETERMINISTIC_MODEL = 'deterministic';
const DAY_MS = 86_400_000;

type InsightDb = Pick<ExtendedPrismaClient, 'rACareerInsight' | 'rACareerGoal' | 'rATrackerEntry' | 'rAResumeVariant' | 'rAJob'>;

export interface InsightServiceDeps {
  getDb?: () => Promise<InsightDb>;
  tracker?: Pick<TrackerCore, 'weeklyFacts'>;
  aiAllowed?: (userId: string) => Promise<boolean>;
  /** The brand's `ai.text` capability (default: the flag resolver). */
  aiTextEnabled?: () => boolean;
  runAgent?: (input: RACareerInsightInput, locale?: string) => Promise<RACareerInsightOutput & { model: string }>;
  /** May this user read this job row? (default: `legacyJobVisible`, the request brand and R-14 mode.) */
  jobVisible?: (row: LegacyJobScopeRow, userId: string) => boolean;
  /** Can a public third-party posting be read on the request brand now? (default: false only on GoApply with the R-14 mode off.) */
  postingsReadable?: () => boolean;
  now?: () => Date;
}

export function currentWeekStartUtc(now: Date = new Date()): string {
  return weekStartFor(now);
}

export function weekRangeFor(weekStartUtc: string): { startUtc: string; endUtc: string } {
  const start = new Date(`${weekStartUtc}T00:00:00.000Z`);
  return { startUtc: weekStartUtc, endUtc: new Date(start.getTime() + 6 * DAY_MS).toISOString().slice(0, 10) };
}

interface InsightRow {
  id: string;
  weekStartUtc: Date;
  summaryMarkdown: string;
  citedTrackerIds: string[];
  modelUsed: string;
  generatedAt: Date;
  metrics?: unknown;
}

/** `metrics.namedJobIds`: the job rows the prompt named. Null for a row written before the marker existed. */
export function namedJobIdsOf(metrics: unknown): string[] | null {
  const value = metrics && typeof metrics === 'object' ? (metrics as { namedJobIds?: unknown }).namedJobIds : undefined;
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : null;
}

export function toInsightView(row: InsightRow): WeeklyInsightView | null {
  if (!row.summaryMarkdown.trim() || row.modelUsed === DETERMINISTIC_MODEL) return null;
  return {
    id: row.id,
    weekStartUtc: row.weekStartUtc.toISOString().slice(0, 10),
    summaryMarkdown: row.summaryMarkdown,
    citedTrackerIds: row.citedTrackerIds ?? [],
    aiGenerated: true,
    modelUsed: row.modelUsed,
    generatedAt: row.generatedAt.toISOString(),
  };
}

function metricsFrom(facts: WeeklyFacts, namedJobIds: string[]): Prisma.InputJsonValue {
  return {
    applicationsCount: facts.applied,
    interviewsCount: facts.interviews,
    offerCount: facts.offers,
    endedCount: facts.ended,
    noReply10dCount: facts.noReply10d,
    namedJobIds,
  };
}

const redact = (text: string | null | undefined): string | null =>
  text ? redactPii(text, { kinds: LLM_PII_KINDS }).text : null;

const defaultGetDb = async (): Promise<InsightDb> => (await import('../../../lib/prisma.js')).default;

async function defaultRunAgent(input: RACareerInsightInput, locale?: string) {
  const { RACareerInsightAgent, pickCareerInsightModel } = await import('../agents/RACareerInsightAgent.js');
  const out = await new RACareerInsightAgent().run(input, { locale, requestId: getCurrentRequestId() ?? undefined });
  return { ...out, model: pickCareerInsightModel() };
}

function passThroughAiError(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'content_blocked' || code === 'ai_unavailable' || code === 'phone_binding_required') throw err;
}

export function createInsightService(deps: InsightServiceDeps = {}) {
  const getDb = deps.getDb ?? defaultGetDb;
  const tracker = deps.tracker ?? trackerCore;
  const allowed = deps.aiAllowed ?? ((userId: string) => defaultAiAllowed(userId));
  const aiTextEnabled = deps.aiTextEnabled ?? (() => isEnabledForBrand('ai.text'));
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const jobVisible = deps.jobVisible ?? ((row: LegacyJobScopeRow, userId: string) => legacyJobVisible(row, userId));
  const postingsReadable = deps.postingsReadable ?? (() => getCurrentBrandOrDefault().market !== 'cn' || cnJobCapabilities().postings);
  const clock = deps.now ?? (() => new Date());

  async function aiAvailable(userId: string): Promise<boolean> {
    if (!aiTextEnabled()) return false;
    return allowed(userId);
  }

  /** May the stored summary still be shown? False once it names a job row this viewer may no longer read. */
  async function summaryReadable(db: InsightDb, row: InsightRow, userId: string): Promise<boolean> {
    const ids = namedJobIdsOf(row.metrics);
    if (ids === null) return postingsReadable();
    if (!ids.length) return true;
    const jobs = await db.rAJob.findMany({ where: { id: { in: ids } }, select: { id: true, ...LEGACY_JOB_SCOPE_SELECT } });
    // A row that no longer exists cannot be read by anyone; only a row that exists and is refused hides the text.
    return jobs.every((j) => jobVisible(j, userId));
  }

  return {
    async getWeekly(userId: string, weekStartUtc?: string): Promise<WeeklyInsightResponse> {
      const db = await getDb();
      const week = weekStartUtc ?? currentWeekStartUtc(clock());
      const [row, facts, ai] = await Promise.all([
        db.rACareerInsight.findUnique({ where: { userId_weekStartUtc: { userId, weekStartUtc: new Date(`${week}T00:00:00.000Z`) } } }),
        tracker.weeklyFacts(userId, week),
        aiAvailable(userId),
      ]);
      const view = row ? toInsightView(row) : null;
      const insight = view && row && (await summaryReadable(db, row, userId)) ? view : null;
      return { insight, facts, week: weekRangeFor(week), aiAvailable: ai };
    },

    /** Write this week's AI summary. Throws `ai_unavailable` when consent, model or the call is missing. */
    async refresh(userId: string, locale?: string): Promise<WeeklyInsightResponse> {
      if (!(await aiAvailable(userId))) throw new HttpError('ai_unavailable', 'AI summaries are not available for this account.');
      const db = await getDb();
      const now = clock();
      const week = currentWeekStartUtc(now);
      const [goal, entries, resumes, facts] = await Promise.all([
        db.rACareerGoal.findUnique({ where: { userId } }),
        db.rATrackerEntry.findMany({
          where: { userId, deletedAt: null, updatedAt: { gte: new Date(now.getTime() - 28 * DAY_MS) } },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        }),
        db.rAResumeVariant.findMany({ where: { userId, deletedAt: null }, orderBy: { lastEditedAt: 'desc' }, take: 20 }),
        tracker.weeklyFacts(userId, week),
      ]);
      const jobIds = [...new Set(entries.map((e) => e.jobId).filter((x): x is string => Boolean(x)))];
      const jobs = jobIds.length
        ? await db.rAJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, companyName: true, ...LEGACY_JOB_SCOPE_SELECT } })
        : [];
      // Only jobs this viewer may read are named in the prompt (see the header).
      const jobById = new Map(jobs.filter((j) => jobVisible(j, userId)).map((j) => [j.id, j]));
      const refusedJobIds = new Set(jobs.filter((j) => !jobById.has(j.id)).map((j) => j.id));
      // Recorded with the summary so a later read can re-check the scope (see the header).
      const namedJobIds = [...jobById.keys()].sort();

      const input: RACareerInsightInput = {
        goal: goal
          ? {
              targetTitle: goal.targetTitle,
              targetDate: goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : null,
              weeklyApplicationGoal: goal.weeklyApplicationGoal ?? 5,
              targetSalaryMin: goal.targetSalaryMin ?? null,
              targetSalaryMax: goal.targetSalaryMax ?? null,
              targetSalaryCurrency: goal.targetSalaryCurrency ?? null,
              preferredWorkType: (goal.preferredWorkType as 'remote' | 'hybrid' | 'onsite' | null) ?? null,
              seniority: goal.seniority ?? null,
              notesMarkdown: redact(goal.notesMarkdown),
            }
          : null,
        weekFacts: facts,
        trackerEntriesLast4Weeks: entries.map((t) => {
          const job = t.jobId ? jobById.get(t.jobId) : undefined;
          // An entry tied to a job row the viewer may not read is sent nameless: its snapshot is a copy of that posting.
          const hidden = Boolean(t.jobId) && refusedJobIds.has(t.jobId as string);
          const snap = (!hidden && t.externalSnapshot && typeof t.externalSnapshot === 'object' ? t.externalSnapshot : null) as { title?: string; companyName?: string } | null;
          return {
            id: t.id,
            status: t.status,
            excitementStars: t.excitementStars ?? null,
            dateSaved: t.dateSaved.toISOString(),
            dateApplied: t.dateApplied ? t.dateApplied.toISOString() : null,
            notesMarkdown: redact(t.notesMarkdown),
            job: job ? { title: job.title, companyName: job.companyName } : null,
            externalSnapshot: snap ? { title: snap.title, companyName: snap.companyName } : null,
          };
        }),
        resumeVariants: resumes.map((r) => ({ id: r.id, name: r.name, kind: r.kind, lastEditedAt: r.lastEditedAt.toISOString() })),
      };

      let out: RACareerInsightOutput & { model: string };
      try {
        out = await runAgent(input, locale);
      } catch (err) {
        passThroughAiError(err);
        logger.warn('RA_V2_INSIGHT', 'insight agent failed', { userId, weekStartUtc: week, error: err instanceof Error ? err.message : String(err) });
        throw new HttpError('ai_unavailable', 'The summary could not be written. Try again later.');
      }
      const summary = out.headline ? `## ${out.headline}\n\n${out.bodyMarkdown}` : out.bodyMarkdown;
      if (!summary.trim()) throw new HttpError('ai_unavailable', 'The summary could not be written. Try again later.');

      const weekDate = new Date(`${week}T00:00:00.000Z`);
      const values = {
        summaryMarkdown: summary,
        citedTrackerIds: out.citedTrackerIds,
        metrics: metricsFrom(facts, namedJobIds),
        modelUsed: out.model,
        citationGuardPassed: true,
        generatedAt: now,
      };
      const row = await db.rACareerInsight.upsert({
        where: { userId_weekStartUtc: { userId, weekStartUtc: weekDate } },
        create: { userId, weekStartUtc: weekDate, ...values },
        update: values,
      });

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
        metadata: { ...cost.metadata, source: 'roboapply_v2', agent: 'RACareerInsightAgent' },
      });
      logger.info('RA_V2_INSIGHT', 'insight written', { userId, insightId: row.id, weekStartUtc: week });
      return { insight: toInsightView(row), facts, week: weekRangeFor(week), aiAvailable: true };
    },
  };
}

export type InsightService = ReturnType<typeof createInsightService>;
export const raInsightService: InsightService = createInsightService();

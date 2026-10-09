// server/src/features/resume/ResumeCheckService.ts
//
// Resume check (WP-22; PRODUCT_PLAN.md F-RES-03…06, F-RES-08; ARCH §3.6).
//
//   grade(userId, variantId)        rules (+ AI pass when allowed) → RAResumeGrade
//   latest(userId, variantId)       newest check + the previous one (re-check comparison)
//   cancel(userId, gradeId)         running → cancelled; the reserved credit goes back
//   fixIssue(...)                   AI version of one issue's text (credit `rewrite`)
//   applyFix(...)                   replace the issue's text in the resume
//   keywordReport(...)              deterministic requirement rows; free
//   grantOnboardingCheck(userId)    the free first check during onboarding (idempotent)
//
// AI consent (TASK_PLAN.md §2.2): `aiAvailable` = aiAllowed(user) AND the
// brand's `ai.text` capability. When false, grading runs the rules only (zero
// LLM calls, no credit spent: nothing metered ran) and fixes answer
// 503 ai_unavailable before any LLM call. The AI pass costs one
// `resume_check` credit, reserved before it runs, committed only when the AI
// pass succeeded, released on any failure or cancel. With no `resume_check`
// credit left the check still runs the free checklist (method 'rules',
// aiSkipped 'credits_exhausted'): only the AI pass is ever withheld.

import { logger } from '../../services/LoggerService.js';
import { HttpError } from '../../platform/http.js';
import { CreditReplayError, CreditsExhaustedError, type CreditService, type Reservation } from '../../platform/credits/index.js';
import type { RAResumeRewriteAction, RAResumeRewriteAgentOutput, RAResumeRewriteInput } from '../../roboapply/v2/agents/RAResumeRewriteAgent.js';
import {
  GRADE_LABELS,
  GRADE_LETTERS,
  GradeIssuesSchema,
  GradeCountsSchema,
  type ApplyFixResponse,
  type CancelGradeResponse,
  type FixIssueResponse,
  type GradeAiSkipped,
  type GradeIssue,
  type GradeLabel,
  type GradeProfile,
  type GradeStartResponse,
  type GradeStatus,
  type GradeSummaryView,
  type GradeView,
  type KeywordReportResponse,
  type LatestGradeResponse,
} from './contract.js';
import type { AiPassInput, AiPassOutput } from './check/aiPass.js';
import { aiIssues } from './check/aiPass.js';
import { hasInventedNumber, inventedNumbers } from './check/citationGuard.js';
import { isSensitiveLine, resumeForLlm } from './check/resumeText.js';
import { runRules, withIds } from './check/rules.js';
import { gradeIssues } from './check/score.js';
import { rulesCountFor } from './check/taxonomy.js';
import { buildKeywordReport } from './keywords/keywordReport.js';
import type { GradeRow, ResumeCheckStore } from './store.js';

export const GRADE_TIMEOUT_MS = 40_000;
/** A `running` row older than this is shown as failed (the request died). */
export const RUNNING_STALE_MS = 5 * 60_000;
export const ONBOARDING_GRANT_REASON = 'onboarding_check';

export type FixVariant = 'ai' | 'longer' | 'shorter' | 'stronger';

export interface ResumeCheckDeps {
  store: ResumeCheckStore;
  credits: Pick<CreditService, 'reserve' | 'commit' | 'release' | 'withCredit' | 'grant'>;
  /** aiAllowed(user) AND isEnabled('ai.text'). */
  aiAvailable: (userId: string) => Promise<boolean>;
  /** The grading profile of the current brand (GoApply → 'cn'). */
  profile: () => GradeProfile;
  /** Brand market of the current request (AI labels on GoApply). */
  market: () => 'intl' | 'cn';
  runAiPass: (input: AiPassInput, options: { locale?: string; signal?: AbortSignal }) => Promise<AiPassOutput>;
  rewrite: (input: RAResumeRewriteInput & { instruction?: string }, options: { locale?: string; signal?: AbortSignal }) => Promise<RAResumeRewriteAgentOutput>;
  /** GoApply AI-content label log (WP-13 seam); failures are logged, never thrown. */
  logAiLabel: (input: { userId: string; contentId: string; kind: string }) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
}

export interface GradeOptions {
  targetTitle?: string;
  idempotencyKey?: string | null;
  locale?: string;
}

function randomKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function letterToLabel(letter: string | null): GradeLabel | null {
  if (!letter) return null;
  const hit = (Object.entries(GRADE_LETTERS) as Array<[GradeLabel, string]>).find(([, l]) => l === letter);
  if (hit) return hit[0];
  return (GRADE_LABELS as readonly string[]).includes(letter) ? (letter as GradeLabel) : null;
}

function parseIssues(raw: unknown): GradeIssue[] {
  const parsed = GradeIssuesSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

function parseCounts(raw: unknown) {
  const parsed = GradeCountsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const AI_SKIPPED: readonly GradeAiSkipped[] = ['credits_exhausted', 'ai_failed', 'ai_unavailable'];

/** `RAResumeGrade.model`: 'rules_ai', 'rules', or 'rules:<why the AI pass did not run>'. */
export function modelOf(method: 'rules' | 'rules_ai', aiSkipped: GradeAiSkipped | null): string {
  return method === 'rules' && aiSkipped ? `rules:${aiSkipped}` : method;
}

function methodOf(model: string | null): 'rules' | 'rules_ai' | null {
  if (model === 'rules' || model === 'rules_ai') return model;
  if (model?.startsWith('rules:')) return 'rules';
  return null;
}

function aiSkippedOf(model: string | null): GradeAiSkipped | null {
  if (!model?.startsWith('rules:')) return null;
  const why = model.slice('rules:'.length) as GradeAiSkipped;
  return AI_SKIPPED.includes(why) ? why : null;
}

function profileOf(issues: GradeIssue[], fallback: GradeProfile): GradeProfile {
  if (issues.some((i) => i.type.startsWith('cn_'))) return 'cn';
  return fallback;
}

export class ResumeCheckService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ResumeCheckDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? GRADE_TIMEOUT_MS;
  }

  // ── views ──

  toView(row: GradeRow, profile: GradeProfile = this.deps.profile()): GradeView {
    const issues = parseIssues(row.issues);
    const method = methodOf(row.model);
    let status = row.status as GradeStatus;
    if (status === 'running' && this.now().getTime() - row.createdAt.getTime() > RUNNING_STALE_MS) status = 'failed';
    const p = profileOf(issues, profile);
    return {
      id: row.id,
      resumeVariantId: row.variantId,
      status,
      label: letterToLabel(row.grade),
      score: row.score,
      counts: parseCounts(row.counts),
      issues,
      profile: p,
      method,
      aiSkipped: aiSkippedOf(row.model),
      rulesChecked: method ? rulesCountFor(p, method === 'rules_ai') : null,
      targetTitle: row.targetTitle,
      contentHash: row.contentHash,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  private summaryOf(row: GradeRow): GradeSummaryView {
    const issues = parseIssues(row.issues);
    return {
      id: row.id,
      label: letterToLabel(row.grade),
      score: row.score,
      counts: parseCounts(row.counts),
      issueTypes: [...new Set(issues.map((i) => i.type))],
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async variantOrThrow(userId: string, variantId: string) {
    const v = await this.deps.store.findVariant(userId, variantId);
    if (!v) throw new HttpError('not_found', 'Resume not found.');
    return v;
  }

  private async reserve(userId: string, bucket: 'resume_check' | 'rewrite', key: string, refType: string): Promise<Reservation> {
    try {
      const r = await this.deps.credits.reserve({ userId, bucket, idempotencyKey: key, refType });
      if (r.replayed) throw new CreditReplayError(r.id, r.status === 'committed' ? 'committed' : 'reserved');
      return r;
    } catch (err) {
      throw toHttp(err);
    }
  }

  private async safeRelease(reservationId: string, reason: string): Promise<boolean> {
    try {
      await this.deps.credits.release(reservationId, reason);
      return true;
    } catch (err) {
      logger.warn('RESUME_CHECK', 'credit release failed (jobs-maintain releases stale reservations)', {
        reservationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── grade ──

  async grade(userId: string, variantId: string, options: GradeOptions = {}): Promise<GradeStartResponse> {
    const variant = await this.variantOrThrow(userId, variantId);
    const profile = this.deps.profile();
    const ai = await this.deps.aiAvailable(userId);
    let aiSkipped: GradeAiSkipped | null = ai ? null : 'ai_unavailable';

    // Only the AI pass is metered: a rules-only check runs no paid model. With
    // no credit left the free checklist still runs; only the AI pass is skipped.
    let reservation: Reservation | null = null;
    if (ai) {
      try {
        reservation = await this.reserve(userId, 'resume_check', options.idempotencyKey || randomKey('grade'), 'resume_grade');
      } catch (err) {
        if (!(err instanceof CreditsExhaustedError)) throw err;
        aiSkipped = 'credits_exhausted';
      }
    }

    let row: GradeRow;
    try {
      row = await this.deps.store.createGrade({
        userId,
        variantId,
        contentHash: variant.resumeContentHash,
        targetTitle: options.targetTitle?.trim() || null,
        creditLedgerId: reservation?.id ?? null,
      });
    } catch (err) {
      if (reservation) await this.safeRelease(reservation.id, 'grade_create_failed');
      throw err;
    }

    try {
      const template = templateOf(variant.layout);
      const rules = runRules({ markdown: variant.resumeMarkdown, profile, template, now: this.now() });
      let issues: GradeIssue[] = rules;
      let method: 'rules' | 'rules_ai' = 'rules';

      if (reservation) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const output = await Promise.race([
            this.deps.runAiPass(
              { resumeText: resumeForLlm(variant.resumeMarkdown), profile, targetTitle: options.targetTitle ?? null },
              { locale: options.locale, signal: controller.signal },
            ),
            new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('ai_pass_timeout')), { once: true })),
          ]);
          issues = withIds([...rules.map(({ id: _id, ...rest }) => rest), ...aiIssues(output, variant.resumeMarkdown)]);
          method = 'rules_ai';
        } catch (err) {
          aiSkipped = 'ai_failed';
          logger.warn('RESUME_CHECK', 'AI pass failed; rules-only report, credit released', {
            userId,
            variantId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timer);
        }
      }

      // The completion write is conditional on the row still being `running`,
      // so a cancel that lands at any point before it wins: no result, no commit.
      const { score, label, counts } = gradeIssues(issues);
      const updated = await this.deps.store.completeRunningGrade(row.id, {
        status: 'done',
        grade: GRADE_LETTERS[label],
        score,
        counts,
        issues,
        model: modelOf(method, aiSkipped),
        completedAt: this.now(),
      });
      if (!updated) {
        if (reservation) await this.safeRelease(reservation.id, 'grade_cancelled');
        const current = await this.deps.store.findGrade(userId, row.id);
        return current ? { gradeId: row.id, grade: this.toView(current, profile) } : { gradeId: row.id };
      }

      if (reservation) {
        if (method === 'rules_ai') {
          try {
            await this.deps.credits.commit(reservation.id, { refId: row.id });
          } catch (err) {
            logger.warn('RESUME_CHECK', 'credit commit failed', { reservationId: reservation.id, error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          await this.safeRelease(reservation.id, 'ai_pass_failed');
        }
      }
      return { gradeId: row.id, grade: this.toView(updated, profile) };
    } catch (err) {
      try {
        await this.deps.store.completeRunningGrade(row.id, { status: 'failed', completedAt: this.now() });
      } catch {
        /* the row stays running and reads as failed after RUNNING_STALE_MS */
      }
      if (reservation) await this.safeRelease(reservation.id, 'grade_failed');
      throw err;
    }
  }

  async latest(userId: string, variantId: string): Promise<LatestGradeResponse> {
    const variant = await this.variantOrThrow(userId, variantId);
    const [rows, aiAvailable] = await Promise.all([this.deps.store.listGrades(userId, variantId, 20), this.deps.aiAvailable(userId)]);
    const gradeRow = rows.find((r) => r.status !== 'cancelled') ?? null;
    const previousRow = gradeRow
      ? (rows.find((r) => r.id !== gradeRow.id && r.status === 'done' && r.createdAt.getTime() < gradeRow.createdAt.getTime()) ?? null)
      : null;
    return {
      grade: gradeRow ? this.toView(gradeRow) : null,
      previous: previousRow ? this.summaryOf(previousRow) : null,
      stale: gradeRow ? gradeRow.contentHash !== variant.resumeContentHash : false,
      aiAvailable,
    };
  }

  async cancel(userId: string, gradeId: string): Promise<CancelGradeResponse> {
    const existing = await this.deps.store.findGrade(userId, gradeId);
    if (!existing) throw new HttpError('not_found', 'Check not found.', { reason: 'grade_not_found' });
    if (existing.status === 'cancelled') return { gradeId, status: 'cancelled', released: false };
    if (existing.status !== 'running') throw new HttpError('conflict', 'This check has already finished.', { status: existing.status });
    const cancelled = await this.deps.store.cancelRunningGrade(userId, gradeId);
    if (!cancelled) {
      const now = await this.deps.store.findGrade(userId, gradeId);
      throw new HttpError('conflict', 'This check has already finished.', { status: now?.status ?? 'unknown' });
    }
    const released = existing.creditLedgerId ? await this.safeRelease(existing.creditLedgerId, 'grade_cancelled') : false;
    return { gradeId, status: 'cancelled', released };
  }

  // ── fixes ──

  private async issueOf(userId: string, variantId: string, issueId: string): Promise<{ grade: GradeRow; issue: GradeIssue }> {
    const rows = await this.deps.store.listGrades(userId, variantId, 5);
    const grade = rows.find((r) => r.status === 'done');
    const issue = grade ? parseIssues(grade.issues).find((i) => i.id === issueId) : undefined;
    if (!grade || !issue) throw new HttpError('not_found', 'Issue not found. Run the check again.', { reason: 'grade_not_found' });
    return { grade, issue };
  }

  async fixIssue(
    userId: string,
    variantId: string,
    issueId: string,
    input: { variant: FixVariant; instruction?: string; idempotencyKey?: string | null; locale?: string },
  ): Promise<FixIssueResponse> {
    const variant = await this.variantOrThrow(userId, variantId);
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');
    const { grade, issue } = await this.issueOf(userId, variantId, issueId);
    const target = issue.target?.trim();
    if (!issue.fixable || !target || isSensitiveLine(target)) {
      throw new HttpError('invalid_request', 'This issue has no text an AI version can rewrite.', { reason: 'issue_not_fixable' });
    }
    if (!variant.resumeMarkdown.includes(target)) {
      throw new HttpError('conflict', 'This text changed since the check. Run the check again.', { reason: 'target_changed' });
    }

    const mode: RAResumeRewriteInput['mode'] = issue.section === 'summary' ? 'summary' : 'bullet';
    const action = actionFor(input.variant, issue.type);
    const llmResume = resumeForLlm(variant.resumeMarkdown);
    const sources = mode === 'summary' ? [target, llmResume] : [target];
    const key = input.idempotencyKey || randomKey('fix');

    try {
      const result = await this.deps.credits.withCredit(
        { userId, bucket: 'rewrite', idempotencyKey: key, refType: 'resume_issue_fix', refId: `${grade.id}:${issue.id}` },
        async () => {
          let out: RAResumeRewriteAgentOutput;
          try {
            out = await this.deps.rewrite(
              { mode, text: target, action, resumeMarkdown: llmResume, instruction: input.instruction?.trim() || undefined },
              { locale: input.locale },
            );
          } catch (err) {
            logger.warn('RESUME_CHECK', 'fix rewrite failed', { userId, variantId, issueId, error: err instanceof Error ? err.message : String(err) });
            throw new HttpError('ai_unavailable', 'The AI version could not be written right now. No credit was used.');
          }
          const candidates = (mode === 'bullet' ? [out.rewrite] : (out.options ?? []))
            .map((c) => (typeof c === 'string' ? c.trim() : ''))
            .filter((c) => c.length > 0 && c !== target);
          const kept: string[] = [];
          let blocked = 0;
          for (const c of candidates) {
            if (hasInventedNumber(c, sources)) {
              blocked += 1;
              logger.warn('RESUME_CHECK', 'CitationGuard dropped a fix with invented numbers', { userId, issueId, numbers: inventedNumbers(c, sources) });
              continue;
            }
            kept.push(c);
          }
          if (kept.length === 0) {
            throw new HttpError(
              'conflict',
              blocked > 0 ? 'The AI version added numbers that are not in your resume, so it was not used. No credit was used.' : 'No AI version came back. No credit was used.',
              { reason: blocked > 0 ? 'citation_guard' : 'no_suggestion', blocked },
            );
          }
          return { suggestions: kept.map((text) => ({ text, aiWritten: true as const })), blocked };
        },
      );
      if (this.deps.market() === 'cn') {
        try {
          await this.deps.logAiLabel({ userId, contentId: `resume_fix:${grade.id}:${issue.id}`, kind: 'resume_fix' });
        } catch (err) {
          logger.debug('RESUME_CHECK', 'AI label log unavailable', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return result;
    } catch (err) {
      throw toHttp(err);
    }
  }

  async applyFix(userId: string, variantId: string, issueId: string, text: string): Promise<ApplyFixResponse> {
    const variant = await this.variantOrThrow(userId, variantId);
    const { issue } = await this.issueOf(userId, variantId, issueId);
    const target = issue.target?.trim();
    if (!target) throw new HttpError('invalid_request', 'This issue has no text to replace.', { reason: 'issue_not_fixable' });
    const md = variant.resumeMarkdown;
    const at = md.indexOf(target);
    if (at < 0) throw new HttpError('conflict', 'This text changed since the check. Run the check again.', { reason: 'target_changed' });
    const replacement = issue.section === 'summary' ? text.trim() : text.replace(/\s*\n+\s*/g, ' ').trim();
    const next = md.slice(0, at) + replacement + md.slice(at + target.length);
    const saved = await this.deps.store.saveMarkdown(userId, variantId, next);
    return { applied: true, resumeContentHash: saved.resumeContentHash };
  }

  // ── keyword report ──

  async keywordReport(
    userId: string,
    variantId: string,
    body: { jobId: string } | { jd: { title: string; company: string; text: string } },
  ): Promise<KeywordReportResponse> {
    const variant = await this.variantOrThrow(userId, variantId);
    if ('jobId' in body) {
      const job = await this.deps.store.findJob(userId, body.jobId);
      if (!job) throw new HttpError('not_found', 'Job not found.');
      const [extraction, fitRow] = await Promise.all([
        this.deps.store.findKeywordExtraction(job.id),
        this.deps.store.findFitRow(userId, job.id, variantId),
      ]);
      const keywords = Array.isArray(extraction?.keywords) ? (extraction!.keywords as Array<{ keyword: string; importance?: string }>) : [];
      return buildKeywordReport({
        resumeMarkdown: variant.resumeMarkdown,
        job: {
          title: job.title,
          text: [job.descriptionPlain, job.qualifications, job.responsibilities].filter(Boolean).join('\n'),
          minYears: job.minYears,
          educationLevel: job.educationLevel,
          skills: job.skills,
        },
        extraction: keywords.length ? { keywords } : null,
        fit: fitRow
          ? { score: fitRow.score, tier: fitRow.tier, generatedAt: fitRow.generatedAt, stale: fitRow.resumeContentHashAtScore !== variant.resumeContentHash }
          : null,
        now: this.now(),
      });
    }
    return buildKeywordReport({
      resumeMarkdown: variant.resumeMarkdown,
      job: { title: body.jd.title, text: body.jd.text },
      now: this.now(),
    });
  }

  // ── onboarding ──

  /**
   * The free first check during onboarding: one `resume_check` grant with
   * reason `onboarding_check`, at most once per user. The check and the grant
   * run under a per-user claim lock in the store (a Postgres advisory lock), so
   * concurrent calls on any number of server instances grant once. A crash
   * after the grant and before the unlock still leaves the grant row, which the
   * next claim sees.
   */
  async grantOnboardingCheck(userId: string): Promise<'granted' | 'already_granted'> {
    return this.deps.store.withGrantClaim(userId, ONBOARDING_GRANT_REASON, async (alreadyGranted) => {
      if (alreadyGranted) return { created: false, value: 'already_granted' as const };
      await this.deps.credits.grant({ userId, bucket: 'resume_check', amount: 1, reason: ONBOARDING_GRANT_REASON });
      return { created: true, value: 'granted' as const };
    });
  }
}

export function actionFor(variant: FixVariant, issueType: string): RAResumeRewriteAction {
  if (variant === 'shorter') return 'shorten';
  if (variant === 'longer') return 'expand';
  if (variant === 'stronger') return 'confident';
  switch (issueType) {
    case 'no_numbers':
      return 'metrics';
    case 'weak_verb':
      return 'confident';
    case 'bullet_too_long':
    case 'summary_too_long':
      return 'shorten';
    case 'summary_too_short':
      return 'expand';
    default:
      return 'improve';
  }
}

/** The layout template key (`layout.template`, or the editor theme's `templateKey`). */
function templateOf(layout: unknown): string | null {
  if (!layout || typeof layout !== 'object') return null;
  const l = layout as { template?: unknown; templateKey?: unknown };
  if (typeof l.template === 'string') return l.template;
  return typeof l.templateKey === 'string' ? l.templateKey : null;
}

/** Credit-layer errors → the platform envelope (402 passes through mapError on its own). */
function toHttp(err: unknown): unknown {
  if (err instanceof CreditReplayError) {
    return new HttpError('conflict', err.code === 'request_already_completed' ? 'This request was already completed.' : 'This request is still running.', {
      reason: err.code,
    });
  }
  return err;
}

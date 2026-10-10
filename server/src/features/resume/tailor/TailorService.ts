// server/src/features/resume/tailor/TailorService.ts
//
// Tailor sessions (WP-36a; PRODUCT_PLAN.md F-RES-09, F-RES-10, F-RES-15;
// ARCHITECTURE.md §3.6; ruling C12; D3).
//
//   create(userId, body)          one `tailor` credit → tailored version in `review`
//   get(userId, id)               the session with its changes and claims
//   updateClaim(userId, id, …)    Verify details: kept · removed · edited
//   finalize(userId, id)          409 unverified_claims while any claim is pending;
//                                 marks the checklist step 'tailor' once
//   unverifiedClaimsCount(id)     the export guard (WP-36b) and the extension (WP-55a)
//   reviewSessionIds(userId, ids) the hub's "Verify details" links (version → session in review)
//
// AI consent (TASK_PLAN.md §2.2): `aiAvailable` = aiAllowed(user) AND the
// brand's `ai.text`. When false, `create` answers 503 ai_unavailable before
// any credit or LLM call. Credits: reserved before the model runs, committed
// only once the tailored version is saved, released on every failure. A
// replayed Idempotency-Key returns the session it already paid for.
//
// Honesty: the prompt carries `resumeForLlm(base)` and the profile snapshot
// only; the header and sensitive lines are put back after the model ran; only
// the picked sections change; every keyword, number, statement or posting
// phrase the base does not show becomes a pending claim; the two fit scores
// are real AI fit scores of the two versions (or "—"), never an estimate, and
// the "after" score is computed only at finalize, once no claim is pending.

import crypto from 'node:crypto';
import { logger } from '../../../services/LoggerService.js';
import { HttpError } from '../../../platform/http.js';
import { CreditReplayError, type CreditService, type Reservation } from '../../../platform/credits/index.js';
import type { RAResumeTailorInput, RAResumeTailorOutput } from '../../../roboapply/v2/agents/RAResumeTailorAgent.js';
import { resumeForLlm } from '../check/resumeText.js';
import {
  JdSnapshotSchema,
  RESUME_ERROR_CODES,
  TailorClaimsSchema,
  type CreateTailorSessionBodySchema,
  TAILOR_SECTIONS,
  type ExperienceDepth,
  type SourcedNumber,
  type TailorClaim,
  type TailorSection,
  type TailorSessionView,
} from '../contract.js';
import type { z } from 'zod';
import { diffChanges, MAX_CHANGES, mergeTailored } from './blocks.js';
import { applyClaimDecision, ClaimDecisionError, extractClaims, pendingCount } from './claims.js';
import { plausibleSkill } from '../keywords/keywordReport.js';
import type { TailorJobRow, TailorSessionRow, TailorStore } from './store.js';

export type CreateTailorBody = z.output<typeof CreateTailorSessionBodySchema>;

/** A tailor run that passes this is shown as stopped (the request died). */
export const GENERATING_STALE_MS = 5 * 60_000;
export const TAILOR_TIMEOUT_MS = 90_000;
export const SCORE_TIMEOUT_MS = 20_000;

export interface FitScoreResult {
  score: number | null;
  kind: 'pre' | 'ai';
  scoredAt: string;
}

export interface TailorServiceDeps {
  store: TailorStore;
  credits: Pick<CreditService, 'reserve' | 'commit' | 'release'>;
  /** aiAllowed(user) AND isEnabled('ai.text'). */
  aiAvailable: (userId: string) => Promise<boolean>;
  /**
   * auth-cn `assertPhoneBound(userId)`: throws 403 `phone_binding_required` for
   * a GoApply WeChat account without a verified phone. Called by `create`
   * itself, so every caller (route, Ready to apply, Assistant) is gated.
   */
  assertPhoneBound: (userId: string) => Promise<void>;
  /** Brand market of the current request. */
  market: () => 'intl' | 'cn';
  tailor: (input: RAResumeTailorInput, options: { locale?: string; signal?: AbortSignal }) => Promise<RAResumeTailorOutput>;
  /** `profileSnapshotForLlm(userId).text` — the only profile context a prompt may carry. */
  profileContext: (userId: string) => Promise<string | null>;
  /** MATCH `scoreJob` for one resume version (null when it cannot run). */
  score: (userId: string, jobId: string, variantId: string, locale?: string) => Promise<FitScoreResult | null>;
  /** growth.markChecklistStep(userId, 'tailor'). */
  markChecklist: (userId: string) => Promise<void>;
  /** GoApply AI-content label log (WP-13); failures are logged, never thrown. */
  logAiLabel: (input: { userId: string; contentId: string; kind: string }) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  scoreTimeoutMs?: number;
}

/** Finalize refused while claims are pending: 409 `unverified_claims` (ruling C12). */
export class UnverifiedClaimsError extends Error {
  readonly code = RESUME_ERROR_CODES.unverifiedClaims;
  readonly status = 409;
  constructor(readonly pending: number) {
    super('Check every highlighted detail before you use this resume.');
    this.name = 'UnverifiedClaimsError';
  }
  get details() {
    return { pending: this.pending };
  }
}

class TailorTimeoutError extends Error {
  constructor() {
    super('tailor timed out');
    this.name = 'TailorTimeoutError';
  }
}

function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(ctrl.signal),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new TailorTimeoutError());
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Errors the client must see as they are (content safety, AI policy, credits). */
function passThrough(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'content_blocked' || code === 'ai_unavailable' || code === 'brand_policy' || code === 'credits_exhausted' || err instanceof HttpError;
}

function readClaims(raw: unknown): TailorClaim[] {
  const parsed = TailorClaimsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

/** Stored sections → the picked sections and the experience depth ('work_quick' | 'work_full'). */
export function readSections(stored: readonly string[]): { sections: TailorSection[]; experienceDepth: ExperienceDepth | null } {
  const sections = TAILOR_SECTIONS.filter((s) => stored.includes(s));
  const depth: ExperienceDepth = stored.includes('work_full') ? 'full' : 'quick';
  return { sections, experienceDepth: sections.includes('experience') ? depth : null };
}

function fitOf(value: number | null, asOf: Date): SourcedNumber | null {
  return value === null ? null : { value, source: 'ai', asOf: asOf.toISOString(), method: 'fit_score' };
}

export class TailorService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly scoreTimeoutMs: number;

  constructor(private readonly deps: TailorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? TAILOR_TIMEOUT_MS;
    this.scoreTimeoutMs = deps.scoreTimeoutMs ?? SCORE_TIMEOUT_MS;
  }

  // ── view ──

  private async view(session: TailorSessionRow): Promise<TailorSessionView> {
    const { store } = this.deps;
    const claims = readClaims(session.claims);
    const stale = session.status === 'generating' && this.now().getTime() - session.createdAt.getTime() > GENERATING_STALE_MS;
    const status = (stale ? 'failed' : session.status) as TailorSessionView['status'];
    const [base, result, job] = await Promise.all([
      store.findVariant(session.userId, session.baseVariantId),
      session.resultVariantId ? store.findVariant(session.userId, session.resultVariantId) : Promise.resolve(null),
      session.jobId ? store.findJob(session.userId, session.jobId, this.deps.market()) : Promise.resolve(null),
    ]);
    const jd = JdSnapshotSchema.safeParse(session.jdSnapshot);
    const changes = base && result ? diffChanges(base.resumeMarkdown, result.resumeMarkdown, '', MAX_CHANGES) : [];
    // "Before" is the base's AI fit score. "After" exists only once the session
    // is finalized (every claim decided) and both are real AI fit scores.
    const before = session.scoreBefore;
    const after = status === 'finalized' && before !== null ? session.scoreAfter : null;
    return {
      id: session.id,
      status,
      baseVariantId: session.baseVariantId,
      jobId: session.jobId,
      scoreBefore: before,
      scoreAfter: after,
      changes,
      claims,
      resultVariantId: result ? session.resultVariantId : null,
      mode: session.mode === 'fast' ? 'fast' : 'guided',
      ...readSections(session.sections),
      target: {
        title: job?.title ?? (jd.success ? jd.data.title : null),
        company: job?.companyName ?? (jd.success ? jd.data.company || null : null),
      },
      pendingClaims: pendingCount(claims),
      fit: {
        before: fitOf(before, session.updatedAt),
        after: fitOf(after, session.updatedAt),
      },
      aiWritten: true,
      failure: status === 'failed' ? (stale ? 'stopped' : 'ai_failed') : null,
      createdAt: session.createdAt.toISOString(),
    };
  }

  private async sessionOrThrow(userId: string, sessionId: string): Promise<TailorSessionRow> {
    const s = await this.deps.store.findSession(userId, sessionId);
    if (!s) throw new HttpError('not_found', 'Tailoring not found.', { reason: RESUME_ERROR_CODES.sessionNotFound });
    return s;
  }

  // ── scores ──

  private async safeScore(userId: string, jobId: string, variantId: string, locale?: string): Promise<FitScoreResult | null> {
    try {
      return await withTimeout(this.scoreTimeoutMs, () => this.deps.score(userId, jobId, variantId, locale));
    } catch (err) {
      logger.debug('RESUME_TAILOR', 'fit score unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** A real AI fit score rounded to 0–100, or null (never a pre-score or an estimate, D3). */
  private async aiScore(userId: string, jobId: string, variantId: string, locale?: string): Promise<number | null> {
    const r = await this.safeScore(userId, jobId, variantId, locale);
    return r?.kind === 'ai' && r.score !== null ? Math.round(r.score) : null;
  }

  // ── create ──

  async create(userId: string, body: CreateTailorBody, options: { idempotencyKey?: string | null; locale?: string } = {}): Promise<TailorSessionView> {
    const { store, credits } = this.deps;
    const base = await store.findVariant(userId, body.baseVariantId);
    if (!base) throw new HttpError('not_found', 'Resume not found.');
    let job: TailorJobRow | null = null;
    if (body.jobId) {
      job = await store.findJob(userId, body.jobId, this.deps.market());
      if (!job) throw new HttpError('not_found', 'Job not found.');
    }
    // Consent before anything is reserved or any model is called.
    if (!(await this.deps.aiAvailable(userId))) {
      throw new HttpError('ai_unavailable', 'AI tailoring is not available for this account.');
    }
    // GoApply: a WeChat account binds a phone before any AI feature (before any credit is reserved).
    await this.deps.assertPhoneBound(userId);

    const key = options.idempotencyKey?.trim() || `tailor:${crypto.randomUUID()}`;
    let reservation: Reservation;
    try {
      reservation = await credits.reserve({ userId, bucket: 'tailor', idempotencyKey: key, refType: 'tailor_session' });
    } catch (err) {
      if (err instanceof CreditReplayError) {
        const done = await store.findSessionByLedger(userId, err.reservationId);
        if (done) return this.view(done);
        throw new HttpError('conflict', 'This request is still running.', { reason: err.code });
      }
      throw err;
    }
    if (reservation.replayed) {
      const existing = await store.findSessionByLedger(userId, reservation.id);
      if (existing) return this.view(existing);
      throw new HttpError('conflict', 'This request is still running.', { reason: 'request_in_progress' });
    }

    const sections = TAILOR_SECTIONS.filter((s) => body.sections.includes(s));
    const experienceDepth: ExperienceDepth | null = sections.includes('experience') ? body.experienceDepth : null;
    const keywords = [...new Set(body.keywords.map((k) => k.trim()).filter(Boolean))];
    const session = await store.createSession({
      userId,
      baseVariantId: base.id,
      jobId: job?.id ?? null,
      jdSnapshot: body.jd ?? null,
      mode: body.mode,
      sections: experienceDepth ? [...sections, experienceDepth === 'full' ? 'work_full' : 'work_quick'] : sections,
      customPrompt: body.customPrompt?.trim() || null,
      keywordsSelected: keywords,
      creditLedgerId: reservation.id,
    });

    const posting = job
      ? { title: job.title, company: job.companyName, text: [job.descriptionPlain, job.qualifications, job.responsibilities].filter(Boolean).join('\n') }
      : { title: body.jd!.title, company: body.jd!.company, text: body.jd!.text };

    let completed: TailorSessionRow | null = null;
    try {
      const profile = await this.deps.profileContext(userId).catch(() => null);
      const out = await withTimeout(this.timeoutMs, (signal) =>
        this.deps.tailor(
          {
            baseResumeMarkdown: resumeForLlm(base.resumeMarkdown),
            jobTitle: posting.title,
            companyName: posting.company || undefined,
            jobDescription: posting.text,
            parsedJD: job ? { qualifications: job.qualifications ?? undefined, responsibilities: job.responsibilities ?? undefined } : undefined,
            complexity: 'standard',
            sections,
            experienceDepth: experienceDepth ?? undefined,
            instruction: body.customPrompt?.trim() || undefined,
            confirmedKeywords: keywords,
            profileContext: profile ?? undefined,
          },
          { locale: options.locale, signal },
        ),
      );
      if (!out?.tailoredResumeMarkdown?.trim()) throw new Error('empty tailor output');

      const resultMd = mergeTailored(base.resumeMarkdown, out.tailoredResumeMarkdown, sections);
      // The job's own skills only. The stored keyword rows also hold plain
      // frequent words of the posting ("了解", "协作", "paid"); used as terms
      // they titled Verify-details cards with words that are not skills.
      // (claims.ts adds the hard-skill vocabulary and the confirmed keywords.)
      const jobTerms = job ? job.skills.filter(plausibleSkill) : [];
      const claims = extractClaims({
        baseMarkdown: base.resumeMarkdown,
        resultMarkdown: resultMd,
        jobTerms,
        confirmedKeywords: keywords,
        posting: { text: posting.text, company: posting.company },
      });
      const label = [posting.company, posting.title].filter(Boolean).join(' · ');
      completed = await store.completeGeneration(session.id, {
        variant: {
          name: `${base.name} · ${label}`.slice(0, 200),
          markdown: resultMd,
          targetJobId: job?.id ?? null,
          basedOnVariantId: base.id,
          unverifiedClaims: pendingCount(claims),
        },
        claims,
      });
      if (!completed) throw new Error('tailor session left generating');
    } catch (err) {
      await this.safeRelease(reservation.id, 'tailor_failed');
      await store.updateSession(session.id, { status: 'failed' }).catch(() => undefined);
      logger.warn('RESUME_TAILOR', 'tailor failed; credit released', { userId, sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
      if (passThrough(err)) throw err;
      throw new HttpError('ai_unavailable', 'Tailoring could not finish right now. No credit was used.', { reason: 'ai_failed' });
    }

    try {
      await credits.commit(reservation.id, { refId: session.id });
    } catch (err) {
      logger.error('RESUME_TAILOR', 'credit commit failed after a saved tailor', { userId, sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
    }

    if (this.deps.market() === 'cn') {
      try {
        await this.deps.logAiLabel({ userId, contentId: `resume_tailor:${session.id}`, kind: 'resume_tailor' });
      } catch (err) {
        logger.debug('RESUME_TAILOR', 'AI label log unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Only the base is scored now. The tailored version still holds unchecked
    // claims, so its score is computed at finalize, once every claim is decided.
    if (job) {
      const before = await this.aiScore(userId, job.id, base.id, options.locale);
      if (before !== null) {
        completed = await store.updateSession(session.id, { scoreBefore: before, scoreAfter: null }).catch(() => completed!);
      }
    }
    return this.view(completed);
  }

  private async safeRelease(reservationId: string, reason: string): Promise<void> {
    try {
      await this.deps.credits.release(reservationId, reason);
    } catch (err) {
      logger.warn('RESUME_TAILOR', 'credit release failed', { reservationId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── read ──

  async get(userId: string, sessionId: string): Promise<TailorSessionView> {
    return this.view(await this.sessionOrThrow(userId, sessionId));
  }

  /**
   * The posting one of the user's sessions was tailored for, as a keyword
   * report target: the job, or the pasted posting kept on the session.
   * 404 for another user's session or one with neither.
   */
  async postingOf(userId: string, sessionId: string): Promise<{ jobId: string } | { jd: { title: string; company: string; text: string } }> {
    const session = await this.sessionOrThrow(userId, sessionId);
    if (session.jobId) return { jobId: session.jobId };
    const jd = JdSnapshotSchema.safeParse(session.jdSnapshot);
    if (!jd.success) throw new HttpError('not_found', 'The job post of this tailoring was not kept.', { reason: RESUME_ERROR_CODES.sessionNotFound });
    return { jd: jd.data };
  }

  // ── Verify details ──

  async updateClaim(
    userId: string,
    sessionId: string,
    claimId: string,
    decision: { status: 'kept' | 'removed' | 'edited'; text?: string },
  ): Promise<TailorSessionView> {
    const { store } = this.deps;
    const session = await this.sessionOrThrow(userId, sessionId);
    if (session.status !== 'review' || !session.resultVariantId) {
      throw new HttpError('conflict', 'This tailored version can no longer be changed here.', { reason: RESUME_ERROR_CODES.sessionNotReviewable, status: session.status });
    }
    const result = await store.findVariant(userId, session.resultVariantId);
    if (!result) throw new HttpError('not_found', 'The tailored resume was deleted.', { reason: RESUME_ERROR_CODES.sessionNotFound });
    const claims = readClaims(session.claims);
    const index = claims.findIndex((c) => c.id === claimId);
    if (index < 0) throw new HttpError('not_found', 'Detail not found.', { reason: RESUME_ERROR_CODES.claimNotFound });

    let next: { markdown: string; claim: TailorClaim };
    try {
      next = applyClaimDecision(result.resumeMarkdown, claims[index]!, decision);
    } catch (err) {
      if (err instanceof ClaimDecisionError) {
        throw new HttpError('conflict', err.message, { reason: err.reason === 'claim_locked' ? RESUME_ERROR_CODES.claimLocked : 'target_changed' });
      }
      throw err;
    }
    const updated = claims.map((c, i) => (i === index ? next.claim : c));
    const saved = await store.saveReview(userId, sessionId, { claims: updated, markdown: next.markdown, unverifiedClaims: pendingCount(updated) });
    if (!saved) throw new HttpError('conflict', 'This tailored version can no longer be changed here.', { reason: RESUME_ERROR_CODES.sessionNotReviewable });
    return this.view(saved);
  }

  // ── finalize ──

  async finalize(userId: string, sessionId: string, options: { locale?: string } = {}): Promise<TailorSessionView> {
    const { store } = this.deps;
    const session = await this.sessionOrThrow(userId, sessionId);
    if (session.status === 'finalized') return this.view(session);
    if (session.status !== 'review') {
      throw new HttpError('conflict', 'This tailored version is not ready.', { reason: RESUME_ERROR_CODES.sessionNotReviewable, status: session.status });
    }
    const pending = pendingCount(readClaims(session.claims));
    if (pending > 0) throw new UnverifiedClaimsError(pending);

    const moved = await store.finalize(userId, sessionId);
    if (!moved) {
      const now = await this.sessionOrThrow(userId, sessionId);
      if (now.status === 'finalized') return this.view(now);
      if (now.status === 'review') throw new UnverifiedClaimsError(pendingCount(readClaims(now.claims)));
      throw new HttpError('conflict', 'This tailored version is not ready.', { reason: RESUME_ERROR_CODES.sessionNotReviewable });
    }

    // Checklist step 'tailor': only on this transition, so it fires once per session.
    try {
      await this.deps.markChecklist(userId);
    } catch (err) {
      logger.warn('RESUME_TAILOR', 'checklist step not recorded', { userId, error: err instanceof Error ? err.message : String(err) });
    }

    let row = (await store.findSession(userId, sessionId)) ?? session;
    // Every claim is decided now: score the final, checked text. Never earlier,
    // so the "after" number never rests on unchecked claims.
    if (row.jobId && row.resultVariantId && row.scoreBefore !== null) {
      const value = await this.aiScore(userId, row.jobId, row.resultVariantId, options.locale);
      row = await store.updateSession(sessionId, { scoreAfter: value }).catch(() => row);
    }
    return this.view({ ...row, status: 'finalized' });
  }

  // ── export guard ──

  async unverifiedClaimsCount(variantId: string): Promise<number> {
    return this.deps.store.unverifiedClaims(variantId);
  }

  // ── hub: "Verify details" links ──

  /**
   * For each tailored version that still has details to check: the id of the
   * session in review that made it (variant id → session id). A version with
   * no such session is absent.
   */
  async reviewSessionIds(userId: string, variantIds: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (variantIds.length === 0) return out;
    for (const row of await this.deps.store.findReviewSessions(userId, variantIds)) {
      // Newest first: keep the first session seen for a version.
      out[row.resultVariantId] ??= row.id;
    }
    return out;
  }
}

// backend/src/roboapply/v2/services/RAOnboardingService.ts
//
// First-run setup. TWO steps: add a resume, then confirm what we read from it.
//
// WHAT THIS FILE USED TO BE, AND WHY IT ISN'T
//
// It was a forty-turn conversational state machine. `bootstrap()` read the
// parsed resume, built display rows out of it, and then wrote
// `draftPreferences: {}` — after which the chat asked seven questions in
// sequence (targetRoles → workMode → salary → industry → employmentType →
// location → seniority), one LLM round trip each, about facts that were
// sitting in the document it had just parsed.
//
// The replacement is one idea: CONFIRMATION, NOT INTERROGATION. The draft is
// seeded from the parse before the user is asked anything, and step 2 shows it
// back as editable chips. A correct prefilled chip costs a one-second glance;
// a wrong one costs one tap. Seven questions cost seven answers and, in the
// measured funnel, most of the users.
//
// WHAT SURVIVES
//   - the variant lookup, the `resume_unusable` guard, supersede-previous;
//   - `buildIngestRows` — the "what your resume says" recap, which is the
//     evidence that earns the prefill and the only trust device in the flow;
//   - `RAOnboardingPrefExtractAgent`, for the single free-text line on step 2.
//
// WHAT IS DELETED
//   - `runTurn`, `pickNextTopic`, the chip/quick-reply composers, the wrap
//     state machine, `resolveQuickReply`, `composeSummary`, `pass()`;
//   - `RAOnboardingChatAgent`, `RAOnboardingKickoffAgent`;
//   - `RECOMMEND_MIN_TURN`, `FORCED_RECOMMEND_TURN`, `MAX_ROUNDS`,
//     `ROUND_SPACING_TURNS`, `MAX_TURNS`, `MAX_SCORER_PER_*`,
//     `MAX_JSEARCH_PER_SESSION`;
//   - `SESSIONS_PER_DAY` and the 429 it produced. A rate-limit lockout during
//     first-run setup is indefensible: the user has done nothing yet, and the
//     thing being refused is the thing that makes the product work at all.
//   - `aggressiveness` — dead since ruling R1 removed auto-apply.
//
// HANDOFF (now done): the orphans this file flagged are gone.
// `RAOnboardingRecommendService.runRound` / `rehydrateCards` / `toCard` /
// `scoreRows` / `upsertExternalJob` / `composeWhyMatched` had no caller once
// setup stopped running a recommendation round, and were deleted along with
// `RAOnboardingSearchPlannerAgent` (its only importer). What is left under
// that filename is the two pure functions other surfaces still import:
// `evaluateCachedScore` (RACrossBankSearchService) and `passesPrefilter`.
// Consequence to know about: the external job providers
// (`lib/raJobProviders.ts` and the JSearch / Fantastic Jobs clients under it)
// lost their last production caller with `runRound`. They are kept, with their
// tests, as the seam a future `RAJobIngestService` (spec §6.5) plugs into —
// but nothing in the running app reaches them today.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { buildIngestRows } from '../lib/raOnboardingIngestRows.js';
import {
  draftToGoalInput,
  draftToPreferencesPatch,
  normalizeDraftUpdates,
  replaceDraft,
} from '../lib/raOnboardingDraft.js';
import { seedDraftFromParsedResume } from '../lib/raResumeSeed.js';
import type { RaLocale } from '../lib/raLocale.js';
import type {
  IngestRow,
  OnboardingConfirmResponse,
  OnboardingDraftPreferences,
  OnboardingSeedEvidence,
  OnboardingSeedFieldMeta,
  OnboardingSetupState,
  OnboardingStep,
} from '../types/onboarding.js';

// ─── Constants ─────────────────────────────────────────────────────────

/** A session older than this is not restorable; the panel starts fresh. */
export const RESTORE_WINDOW_DAYS = 7;

/** Written into preferences on confirm, and disclosed in Settings → Hunt. */
export const ONBOARDING_DAILY_CAP = 10;

/** Provenance version stamped into `preferencesBlob.onboarding.version`. */
const ONBOARDING_VERSION = 'v5-confirm';

const MAX_FREE_TEXT_LEN = 2000;

// ─── Typed lifecycle errors (route → machine codes) ────────────────────

export class OnboardingVariantNotFoundError extends Error {
  code = 'not_found';
}
export class OnboardingResumeUnusableError extends Error {
  code = 'resume_unusable';
}
export class OnboardingNoActiveSessionError extends Error {
  code = 'no_active_session';
}
export class OnboardingInvalidDraftError extends Error {
  code = 'invalid_draft';
}

// ─── Postgres-safety helpers (forked, raRapidApiJobs.ts precedent) ─────

function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

function deepClean<T>(value: T): T {
  if (typeof value === 'string') return stripControl(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepClean(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClean((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

// ─── Session meta (persisted in the `chips` Json column) ───────────────
//
// The Prisma model has no columns for seed provenance, and orchestrator
// state is not worth a migration — so `chips` (Json, historically a string
// array) carries a meta object. parseSessionMeta tolerates the legacy bare
// array and the legacy chat-era keys; this service is the sole writer.

interface SessionMeta {
  /** Per-field provenance from the seed, keyed by draft field name. */
  fieldMeta: Record<string, OnboardingSeedFieldMeta>;
  /** Seeded but NOT applied — rendered as suggestions, never as values. */
  proposedFields: string[];
  evidence: OnboardingSeedEvidence;
  thin: boolean;
  /** The parallel LLM seed had not landed when the session row was written. */
  enrichmentPending: boolean;
}

function defaultMeta(): SessionMeta {
  return {
    fieldMeta: {},
    proposedFields: [],
    evidence: {},
    thin: true,
    enrichmentPending: false,
  };
}

function parseSeedFieldMeta(raw: unknown): Record<string, OnboardingSeedFieldMeta> {
  const out: Record<string, OnboardingSeedFieldMeta> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const source = v.source === 'resume' || v.source === 'inferred' ? v.source : null;
    if (!source) continue;
    const confidence =
      typeof v.confidence === 'number' && Number.isFinite(v.confidence)
        ? Math.max(0, Math.min(1, v.confidence))
        : 0.5;
    out[key] = { source, confidence };
  }
  return out;
}

function parseEvidence(raw: unknown): OnboardingSeedEvidence {
  const out: OnboardingSeedEvidence = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
  const roles = strings(r.roles);
  if (roles?.length) out.roles = roles;
  const employers = strings(r.employers);
  if (employers?.length) out.employers = employers;
  if (typeof r.years === 'number' && Number.isFinite(r.years)) out.years = r.years;
  if (typeof r.city === 'string' && r.city.trim()) out.city = r.city.trim();
  return out;
}

function parseSessionMeta(raw: unknown): SessionMeta {
  const meta = defaultMeta();
  // Legacy shapes (bare chip array, or the chat-era meta object) parse to the
  // defaults rather than throwing — a stale row must not 500 a restore.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return meta;
  const r = raw as Record<string, unknown>;
  meta.fieldMeta = parseSeedFieldMeta(r.fieldMeta);
  if (Array.isArray(r.proposedFields)) {
    meta.proposedFields = r.proposedFields.filter((f): f is string => typeof f === 'string');
  }
  meta.evidence = parseEvidence(r.evidence);
  meta.thin = r.thin === true;
  meta.enrichmentPending = r.enrichmentPending === true;
  return meta;
}

/** What the LLM seed contributes, when it contributes anything. */
interface SeedEnrichment {
  updates: OnboardingDraftPreferences;
  fieldConfidence: Record<string, number>;
}

// ─── The onboarding stamp on preferencesBlob ───────────────────────────
//
// `onboarding` is NOT in RAPreferencesService's DEEP_MERGE_PREF_KEYS, so a
// PATCH replaces the whole object. Every writer therefore has to read the
// current stamp and merge by hand — otherwise `POST /skip` silently erases
// the `autoOpens` counter, and the cap that stops the panel reopening forever
// resets itself.

interface OnboardingStamp {
  completedAt?: string;
  skippedAt?: string;
  version?: string;
  completedSteps?: string[];
  sessionId?: string;
  autoOpens?: number;
  lastSeenStep?: string;
}

async function readStamp(userId: string): Promise<OnboardingStamp> {
  const p = prisma as any;
  const row = await p.rACareerGoal.findUnique({
    where: { userId },
    select: { preferencesBlob: true },
  });
  const blob =
    row?.preferencesBlob && typeof row.preferencesBlob === 'object'
      ? (row.preferencesBlob as Record<string, unknown>)
      : null;
  const stamp = blob?.onboarding;
  return stamp && typeof stamp === 'object' && !Array.isArray(stamp)
    ? ({ ...(stamp as OnboardingStamp) })
    : {};
}

// ─── Service ───────────────────────────────────────────────────────────

export class RAOnboardingService {
  // ── Step 1 → Step 2: bootstrap ──────────────────────────────────────

  /**
   * Read the variant, seed the draft from its parse, open a session, and
   * answer with everything step 2 needs to render.
   *
   * The deterministic seed is computed synchronously and is what the response
   * is built from. The LLM seed is dispatched alongside it and is NEVER
   * awaited: whatever has landed by the time the remaining DB work finishes is
   * folded in for free, and anything later is folded into the session row in
   * the background. This is the reason step 2 can promise "zero mandatory
   * typing" without also promising "wait for a model" — and it is safe because
   * nothing the agent contributes is rendered on step 2 at all
   * (`industriesTarget` lives in Settings; `targetRoles` only arrives from the
   * agent on a thin resume, which has its own degraded screen).
   */
  async bootstrap(
    userId: string,
    resumeVariantId: string,
    locale: RaLocale,
    opts: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<OnboardingSetupState> {
    const startedAt = Date.now();
    const requestId = opts.requestId ?? getCurrentRequestId() ?? undefined;
    const p = prisma as any;

    const variant = await p.rAResumeVariant.findFirst({
      where: { id: resumeVariantId, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        parsedData: true,
        summary: true,
        highlight: true,
        resumeMarkdown: true,
      },
    });
    if (!variant) throw new OnboardingVariantNotFoundError('resume variant not found');
    if (!variant.resumeMarkdown?.trim() && !variant.parsedData) {
      throw new OnboardingResumeUnusableError('variant has neither markdown nor parsedData');
    }

    // ── The deterministic seed. No LLM, no DB, single-digit ms. ──
    const seed = seedDraftFromParsedResume(variant.parsedData, variant.resumeMarkdown ?? null);
    let draft = seed.draft;
    const fieldMeta: Record<string, OnboardingSeedFieldMeta> = { ...seed.fieldMeta };

    // ── Dispatch the LLM seed NOW, and never await it. ──
    // Everything below this line is DB work we owe anyway; the agent runs
    // through it for free. Whatever has landed by the fold below is taken;
    // anything later goes into the session row in the background.
    const seedAgentStartedAt = Date.now();
    // A box rather than a bare `let`: nothing between here and the fold below
    // may accidentally await this, and a mutable box makes that obvious.
    const box: { value: SeedEnrichment | null; settled: boolean } = {
      value: null,
      settled: false,
    };
    const enrichmentPromise = this.runSeedAgent(
      variant.parsedData,
      variant.resumeMarkdown ?? null,
      seed.draft.targetRoles ?? [],
      { requestId, locale, signal: opts.signal },
    ).then((result) => {
      box.value = result;
      box.settled = true;
      return result;
    });

    // A second bootstrap (second device, re-upload, back button) wins; the
    // older session is abandoned rather than left racing for the same writes.
    await p.rAOnboardingSession.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'abandoned' },
    });

    const stamp = await readStamp(userId);
    const returning = Boolean(stamp.completedAt);

    const variantName = variant.name ?? 'My résumé';
    const ingestRows: IngestRow[] = buildIngestRows(
      {
        variantName,
        parsedData: variant.parsedData,
        summary: variant.summary,
        highlight: variant.highlight,
        resumeMarkdown: variant.resumeMarkdown,
      },
      locale,
    );

    // Take the enrichment only if it is ALREADY resolved — zero added latency.
    const settled = box.settled ? box.value : null;
    if (settled) {
      for (const [field, value] of Object.entries(settled.updates)) {
        // The deterministic pass always wins a contested field — it read the
        // structured parse, the model read prose about the same person.
        if ((draft as Record<string, unknown>)[field] !== undefined) continue;
        (draft as Record<string, unknown>)[field] = value;
        fieldMeta[field] = {
          source: 'inferred',
          confidence: settled.fieldConfidence[field] ?? 0.6,
        };
      }
      draft = normalizeDraftUpdates(draft);
    }

    const meta: SessionMeta = {
      fieldMeta,
      proposedFields: seed.proposedFields,
      evidence: seed.evidence,
      thin: seed.thin && !draft.targetRoles?.length,
      enrichmentPending: !box.settled,
    };

    const session = await p.rAOnboardingSession.create({
      data: {
        userId,
        resumeVariantId: variant.id,
        locale,
        draftPreferences: deepClean(draft),
        chips: deepClean(meta),
      },
    });

    // If the agent was still running when the deadline passed, keep waiting in
    // the background and fold the result into the row. The user's screen is
    // already right; this only improves what a reload would show.
    if (meta.enrichmentPending) {
      void this.foldLateEnrichment(session.id, enrichmentPromise, requestId);
    }

    logger.info('RA_V2_ONBOARDING_BOOTSTRAP', 'setup session bootstrapped', {
      requestId,
      userId,
      sessionId: session.id,
      variantId: variant.id,
      returning,
      ingestRowCount: ingestRows.length,
      seededFields: Object.keys(draft),
      proposedFields: meta.proposedFields,
      thin: meta.thin,
      seedAgentMs: Date.now() - seedAgentStartedAt,
      seedAgentPending: meta.enrichmentPending,
      durationMs: Date.now() - startedAt,
    });

    return {
      sessionId: session.id,
      returning,
      resumeVariant: { id: variant.id, name: variantName },
      ingestRows,
      draft,
      fieldMeta: meta.fieldMeta,
      proposedFields: meta.proposedFields,
      evidence: meta.evidence,
      thin: meta.thin,
      enrichmentPending: meta.enrichmentPending,
    };
  }

  /**
   * Run the seed agent. NEVER rejects — a failed model call is not an error
   * condition for this flow, it is the absence of an improvement.
   */
  private async runSeedAgent(
    parsedData: unknown,
    markdown: string | null,
    deterministicRoles: string[],
    options: { requestId?: string; locale?: string; signal?: AbortSignal },
  ): Promise<SeedEnrichment | null> {
    try {
      const { raOnboardingResumeSeedAgent } = await import(
        '../agents/RAOnboardingResumeSeedAgent.js'
      );
      const out = await raOnboardingResumeSeedAgent.run(
        {
          parsedJson: parsedData ? JSON.stringify(parsedData) : '',
          resumeMarkdown: markdown ?? '',
          deterministicRoles,
        },
        options,
      );
      return Object.keys(out.updates).length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  /** Persist a seed-agent result that arrived after the response shipped. */
  private async foldLateEnrichment(
    sessionId: string,
    promise: Promise<SeedEnrichment | null>,
    requestId?: string,
  ): Promise<void> {
    const p = prisma as any;
    try {
      const result = await promise;
      const row = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
      // The user may already have confirmed — never reopen a closed session.
      if (!row || row.status !== 'active') return;

      const meta = parseSessionMeta(row.chips);
      const draft = (row.draftPreferences ?? {}) as OnboardingDraftPreferences;
      if (result) {
        for (const [field, value] of Object.entries(result.updates)) {
          if ((draft as Record<string, unknown>)[field] !== undefined) continue;
          (draft as Record<string, unknown>)[field] = value;
          meta.fieldMeta[field] = {
            source: 'inferred',
            confidence: result.fieldConfidence[field] ?? 0.6,
          };
        }
      }
      meta.enrichmentPending = false;
      meta.thin = meta.thin && !draft.targetRoles?.length;
      await p.rAOnboardingSession.update({
        where: { id: sessionId },
        data: {
          draftPreferences: deepClean(normalizeDraftUpdates(draft)),
          chips: deepClean(meta),
        },
      });
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_BOOTSTRAP', 'late seed enrichment failed (non-fatal)', {
        requestId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Session restore (GET /session) ──────────────────────────────────

  /** Same shape as bootstrap, so a mid-step reload has one code path. */
  async getSession(userId: string, locale: RaLocale): Promise<OnboardingSetupState> {
    const p = prisma as any;
    const row = await p.rAOnboardingSession.findFirst({
      where: { userId, status: 'active' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) throw new OnboardingNoActiveSessionError('no active session');

    const cutoff = Date.now() - RESTORE_WINDOW_DAYS * 86_400_000;
    if (new Date(row.updatedAt).getTime() < cutoff) {
      await p.rAOnboardingSession
        .update({ where: { id: row.id }, data: { status: 'abandoned' } })
        .catch(() => undefined);
      logger.info('RA_V2_ONBOARDING_ABANDON_SWEEP', 'stale active session abandoned on restore', {
        userId,
        sessionId: row.id,
      });
      throw new OnboardingNoActiveSessionError('no active session');
    }

    const meta = parseSessionMeta(row.chips);
    const draft = (row.draftPreferences ?? {}) as OnboardingDraftPreferences;

    let ingestRows: IngestRow[] = [];
    let variantName = 'My résumé';
    if (row.resumeVariantId) {
      const variant = await p.rAResumeVariant.findFirst({
        where: { id: row.resumeVariantId, userId, deletedAt: null },
        select: { name: true, parsedData: true, summary: true, highlight: true, resumeMarkdown: true },
      });
      if (variant) {
        variantName = variant.name ?? variantName;
        ingestRows = buildIngestRows(
          {
            variantName,
            parsedData: variant.parsedData,
            summary: variant.summary,
            highlight: variant.highlight,
            resumeMarkdown: variant.resumeMarkdown,
          },
          locale,
        );
      }
    }

    const stamp = await readStamp(userId);

    return {
      sessionId: row.id,
      returning: Boolean(stamp.completedAt),
      resumeVariant: { id: row.resumeVariantId ?? '', name: variantName },
      ingestRows,
      draft,
      fieldMeta: meta.fieldMeta,
      proposedFields: meta.proposedFields,
      evidence: meta.evidence,
      thin: meta.thin,
      enrichmentPending: meta.enrichmentPending,
    };
  }

  // ── Confirm (the whole of step 2's submit) ──────────────────────────

  /**
   * Persist the user's confirmed preferences and close the session.
   *
   * The submitted draft REPLACES the seeded one (`replaceDraft`, not
   * `mergeDraft`). This is not a style preference: the central interaction of
   * step 2 is removing a chip, and the union semantics the chat used would
   * make that silently do nothing.
   *
   * Everything the user submits is confirmed by the act of submitting —
   * `proposedFields` and any confidence bookkeeping are cleared. That is only
   * legitimate because nothing on the screen is a guess presented as a fact:
   * the seeded city arrives unselected, salary is never inferred, and the
   * inferred chips carry their marker.
   *
   * Exactly one LLM call is possible here, and only when `freeText` is
   * non-empty. A blank notes line costs zero tokens.
   */
  async confirm(
    userId: string,
    sessionId: string,
    submitted: OnboardingDraftPreferences,
    freeText: string | undefined,
    locale: RaLocale,
    requestId?: string,
  ): Promise<OnboardingConfirmResponse> {
    const startedAt = Date.now();
    const p = prisma as any;
    const rid = requestId ?? getCurrentRequestId() ?? undefined;

    if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) {
      throw new OnboardingInvalidDraftError('draft must be an object');
    }

    const session = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new OnboardingNoActiveSessionError('no session');
    }

    const { raCareerGoalService } = await import('./RACareerGoalService.js');
    const { raPreferencesService } = await import('./RAPreferencesService.js');

    // Idempotent: a re-POST (double tap, retried request) returns current
    // state instead of re-running the writes.
    if (session.status === 'completed') {
      const [goal, prefs] = await Promise.all([
        raCareerGoalService.get(userId),
        raPreferencesService.get(userId),
      ]);
      return {
        goal: (goal ?? {}) as Record<string, unknown>,
        preferences: prefs.preferences as unknown as Record<string, unknown>,
        capturedFromNotes: [],
      };
    }

    const seeded = (session.draftPreferences ?? {}) as OnboardingDraftPreferences;
    let draft = replaceDraft(seeded, submitted);

    // ── The one free-text line. One configured onboarding call, or none. ──
    const notes = typeof freeText === 'string' ? freeText.trim().slice(0, MAX_FREE_TEXT_LEN) : '';
    let capturedFromNotes: string[] = [];
    let extractorRan = false;
    if (notes) {
      try {
        const { raOnboardingPrefExtractAgent } = await import(
          '../agents/RAOnboardingPrefExtractAgent.js'
        );
        extractorRan = true;
        const extracted = await raOnboardingPrefExtractAgent.run(
          {
            userMessage: notes,
            currentDraft: draft,
            askedTopics: [],
            lastQuestionTopic: 'none',
          },
          { requestId: rid, locale },
        );
        // The notes line ADDS to the confirmed chips — it is the user typing
        // something the controls could not express, not a correction of them.
        // So its updates replace only the fields it actually names.
        const before = JSON.stringify(draft);
        draft = replaceDraft(draft, extracted.updates);
        if (JSON.stringify(draft) !== before) {
          capturedFromNotes = Object.keys(extracted.updates);
        }
      } catch (err) {
        // A failed notes extraction must never block the submit — the user's
        // chips are the substance; the line was optional.
        logger.warn('RA_V2_ONBOARDING_CONFIRM', 'notes extraction failed (non-fatal)', {
          requestId: rid,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 1. Goal upsert (sparse; unset fields keep their stored values). ──
    let goal: Record<string, unknown> = {};
    try {
      goal = (await raCareerGoalService.upsert(
        userId,
        draftToGoalInput(draft, locale),
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_CONFIRM', 'goal upsert failed; continuing', {
        requestId: rid,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 2. The preferences blob — the write that changes the feed. ──
    //
    // This is the same store `hooks/usePreferences.ts` reads and
    // `preferencesToFilters()` consumes, which is what makes any of this
    // matter: `roleTitles` becomes `q`, a single-mode `workModes` becomes
    // `workType`, a single `cities` entry becomes `location`. Salary is
    // written for Settings but is deliberately never sent as a filter.
    let preferences: Record<string, unknown> = {};
    try {
      const stamp = await readStamp(userId);
      const patch = {
        ...draftToPreferencesPatch(draft),
        ...(notes ? { intentMarkdown: notes } : {}),
        ...(session.resumeVariantId ? { defaultResumeId: session.resumeVariantId } : {}),
        dailyCap: ONBOARDING_DAILY_CAP,
        huntActive: true,
        onboarding: {
          ...stamp, // preserve autoOpens / lastSeenStep — the key replaces wholesale
          completedAt: new Date().toISOString(),
          version: ONBOARDING_VERSION,
          completedSteps: ['resume', 'preferences'],
          sessionId,
        },
      };
      const updated = await raPreferencesService.update(userId, patch as never);
      preferences = updated.preferences as unknown as Record<string, unknown>;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_CONFIRM', 'preferences patch failed; continuing', {
        requestId: rid,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 3. Primary flip — the variant every score is computed against. ──
    if (session.resumeVariantId) {
      try {
        const variant = await p.rAResumeVariant.findFirst({
          where: { id: session.resumeVariantId, userId, deletedAt: null },
          select: { id: true, isPrimary: true },
        });
        if (variant && !variant.isPrimary) {
          const { raResumeService } = await import('./RAResumeService.js');
          await raResumeService.setPrimary(userId, variant.id);
        }
      } catch (err) {
        logger.warn('RA_V2_ONBOARDING_CONFIRM', 'primary flip failed; continuing', {
          requestId: rid,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 4. Close the session. ──
    try {
      await p.rAOnboardingSession.update({
        where: { id: sessionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          draftPreferences: deepClean(draft),
        },
      });
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_CONFIRM', 'session status update failed', {
        requestId: rid,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit-only cost row, and ONLY when a model actually ran. A confirm with
    // a blank notes line is free and should leave no billing trace at all.
    if (extractorRan) {
      const cost = costPatchFromTally(rid);
      await writeDeductionLog({
        userId,
        sku: 'ra_onboarding_turn',
        source: 'free_tier',
        platformCostUsd: cost.platformCostUsd,
        apiKeyId: null,
        units: 1,
        requestId: rid ?? null,
        relatedEntityType: 'ra_onboarding_session',
        relatedEntityId: sessionId,
        metadata: { ...cost.metadata, source: 'roboapply_v2', step: 'confirm_notes' },
      });
    }

    logger.info('RA_V2_ONBOARDING_CONFIRM', 'setup confirmed', {
      requestId: rid,
      userId,
      sessionId,
      fields: Object.keys(draft),
      notesUsed: Boolean(notes),
      capturedFromNotes,
      durationMs: Date.now() - startedAt,
    });

    return { goal, preferences, capturedFromNotes };
  }

  // ── Skip — always succeeds, flushes nothing ─────────────────────────

  /**
   * Stamp `skippedAt` and get out of the way. Deliberately writes NO
   * preferences: the user declined to confirm, so nothing on that screen was
   * agreed to, and persisting the seed anyway would be putting words in their
   * mouth. `autoOpens` is preserved so the cap survives.
   */
  async skip(userId: string, sessionId?: string, requestId?: string): Promise<void> {
    const p = prisma as any;
    try {
      if (sessionId) {
        const session = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
        if (session && session.userId === userId && session.status === 'active') {
          await p.rAOnboardingSession
            .update({ where: { id: sessionId }, data: { status: 'skipped' } })
            .catch(() => undefined);
        }
      }
      const stamp = await readStamp(userId);
      const { raPreferencesService } = await import('./RAPreferencesService.js');
      await raPreferencesService.update(userId, {
        onboarding: {
          ...stamp,
          skippedAt: new Date().toISOString(),
          version: ONBOARDING_VERSION,
        },
      } as never);
    } catch (err) {
      // Skip must never block leaving setup — log and return 200 regardless.
      logger.warn('RA_V2_ONBOARDING_SKIP', 'skip stamp failed (non-fatal)', {
        requestId,
        userId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('RA_V2_ONBOARDING_SKIP', 'setup skipped', {
      requestId,
      userId,
      sessionId: sessionId ?? null,
    });
  }

  // ── Seen — the auto-open counter (fix F4) ───────────────────────────

  /**
   * Record that the panel auto-opened, and return the new count.
   *
   * This lives on PANEL OPEN rather than on bootstrap because bootstrap needs
   * a `resumeVariantId` — which the no-resume user, the one the whole flow
   * exists for, does not have. A counter that only increments on bootstrap
   * would never fire for them, so the panel would reopen on every single visit
   * forever. The cap is 2 for both states.
   *
   * Never throws: a failed counter write must not stop the panel from opening.
   */
  async markSeen(userId: string, step: OnboardingStep, requestId?: string): Promise<number> {
    try {
      const stamp = await readStamp(userId);
      const autoOpens = (typeof stamp.autoOpens === 'number' ? stamp.autoOpens : 0) + 1;
      const { raPreferencesService } = await import('./RAPreferencesService.js');
      await raPreferencesService.update(userId, {
        onboarding: { ...stamp, autoOpens, lastSeenStep: step },
      } as never);
      return autoOpens;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_SEEN', 'auto-open counter write failed (non-fatal)', {
        requestId,
        userId,
        step,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}

export const raOnboardingService = new RAOnboardingService();
export default raOnboardingService;

// Test surface — deterministic helpers only (no LLM, no DB).
export const __test = {
  parseSessionMeta,
  parseSeedFieldMeta,
  parseEvidence,
};

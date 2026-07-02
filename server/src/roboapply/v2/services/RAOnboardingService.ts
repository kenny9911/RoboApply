// backend/src/roboapply/v2/services/RAOnboardingService.ts
//
// Orchestrator + deterministic state machine for the conversational
// onboarding chat (spec §3.3, S1–S4). The LLM NEVER controls state
// transitions, budgets, caps, or persistence — every transition, trigger,
// chip, quick-reply, and write below is deterministic; agents only produce
// prose / structured extractions and every agent stage sits in its own
// try/catch with a catalog-localized fallback (the turn pipeline itself never
// throws; only the lifecycle validators throw typed errors the route maps to
// 4xx machine codes).
//
// Session lifecycle on prisma.rAOnboardingSession: create / supersede /
// restore (≤7 days) / abandon / complete / skip. Caps (server-enforced,
// restart-safe because they live on the row): 40 turns, 3 recommendation
// rounds, 16 scorer calls, 2 billed JSearch calls, 3 sessions/day.
//
// Critic fixes implemented here:
//   E9a — ONE fire-and-forget checkpoint write after extraction (user message
//         + draft); the only awaited write is the final pre-done persist.
//   E9c/R12 — complete() responds first; the Sonnet notesMarkdown SUMMARY call
//         runs fire-and-forget AFTER the response with a deterministic
//         transcript-digest fallback.
//   E10 — quickReplyId turns resolve deterministically (decline topic / set
//         enum / show jobs) WITHOUT invoking the extractor.
//   E11/R6 — per-field confidence: only fields <0.7 are unconfirmed;
//         unconfirmed fields do NOT count toward the S2→S3 trigger threshold.
//   R8  — implicit-confirm: a locale-market-consistent inferred salary
//         currency with an explicit period token is confirmed inline
//         (confirmed-unless-corrected), not via a standalone question.
//   R13 — the forced turn-5 round with the signal threshold unmet runs
//         internal-only and never bills JSearch.
//   R14 — superseded sessions with turnCount === 0 don't count toward the
//         daily session cap (S0 re-picks can't lock a new user out).
//
// Turn billing: success-only `writeDeductionLog` sku 'ra_onboarding_turn'
// (audit-only, free tier) — failed / fallback turns pay zero.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { format, getMessages, type OnboardingMessages } from '../lib/raOnboardingMessages.js';
import { buildIngestRows } from '../lib/raOnboardingIngestRows.js';
import {
  draftToGoalInput,
  draftToPreferencesPatch,
  marketDefaultsForLocale,
  mergeDraft,
  normalizeDraftUpdates,
} from '../lib/raOnboardingDraft.js';
import {
  raOnboardingRecommendService,
  type RecommendRoundResult,
} from './RAOnboardingRecommendService.js';
import type { RaLocale } from '../lib/raLocale.js';
import type {
  IngestRow,
  OnboardingAggressiveness,
  OnboardingBootstrapResponse,
  OnboardingCompleteResponse,
  OnboardingDraftPreferences,
  OnboardingQuickReplyOption,
  OnboardingSessionResponse,
  OnboardingTopic,
  OnboardingTranscriptMessage,
  RAOnboardingSessionState,
  RAOnboardingStreamEvent,
} from '../types/onboarding.js';

type SessionState = RAOnboardingSessionState;

// ─── Caps / trigger constants (spec §3.3) ──────────────────────────────

export const RECOMMEND_MIN_TURN = 2;
export const FORCED_RECOMMEND_TURN = 5;
export const MAX_ROUNDS = 3;
export const ROUND_SPACING_TURNS = 2;
export const MAX_TURNS = 40;
export const MAX_SCORER_PER_ROUND = 8;
export const MAX_SCORER_PER_SESSION = 16;
export const MAX_JSEARCH_PER_SESSION = 2;
export const SESSIONS_PER_DAY = 3;
export const RESTORE_WINDOW_DAYS = 7;
/** Disclosed in the wrap recap (R5) and written on complete. */
export const ONBOARDING_DAILY_CAP = 10;

const MAX_MESSAGE_LEN = 4000;
const CONFIDENCE_FLOOR = 0.7;
const KICKOFF_RESUME_CLIP = 2400;
const NOTES_MARKDOWN_CLIP = 4000;

// ─── Typed lifecycle errors (route → machine codes) ────────────────────

export class OnboardingVariantNotFoundError extends Error {
  code = 'not_found';
}
export class OnboardingResumeUnusableError extends Error {
  code = 'resume_unusable';
}
export class OnboardingDailyLimitError extends Error {
  code = 'session_daily_limit';
}
export class OnboardingNoActiveSessionError extends Error {
  code = 'no_active_session';
}
export class OnboardingSessionSupersededError extends Error {
  code = 'session_superseded';
}
export class OnboardingSessionNotActiveError extends Error {
  code = 'session_not_active';
}
export class OnboardingJobNotFoundError extends Error {
  code = 'not_found';
}
export class OnboardingInvalidAggressivenessError extends Error {
  code = 'invalid_aggressiveness';
}

// ─── Local Postgres-safety helpers (forked, raRapidApiJobs.ts precedent) ─

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
// The Prisma model has no dedicated columns for the headline / per-topic
// suggestion cache / wrap flag / scorer counter, and adding columns for
// orchestrator-internal state isn't worth a migration — so the `chips` Json
// column holds a meta object instead of a bare array. parseSessionMeta is
// tolerant of the bare-array shape (defensive only; this service is the sole
// writer).

interface SessionMeta {
  list: string[];
  headline: string;
  topicSuggestions: Record<string, string>;
  state: SessionState;
  /** Topic of the assistant's last question — resolves bare quick replies. */
  lastQuestionTopic: string | null;
  /** Turn number of the last recommendation round (0 = none yet). */
  lastRecommendAtTurn: number;
  /** Fields whose latest capture stayed below the confidence floor. */
  unconfirmedFields: string[];
  /** Fresh scorer calls used session-wide (cap 16, survives restore). */
  scorerCallsUsed: number;
}

function defaultMeta(): SessionMeta {
  return {
    list: [],
    headline: '',
    topicSuggestions: {},
    state: 'greeting',
    lastQuestionTopic: null,
    lastRecommendAtTurn: 0,
    unconfirmedFields: [],
    scorerCallsUsed: 0,
  };
}

function parseSessionMeta(raw: unknown): SessionMeta {
  const meta = defaultMeta();
  if (Array.isArray(raw)) {
    meta.list = raw.filter((c): c is string => typeof c === 'string');
    return meta;
  }
  if (!raw || typeof raw !== 'object') return meta;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.list)) meta.list = r.list.filter((c): c is string => typeof c === 'string');
  if (typeof r.headline === 'string') meta.headline = r.headline;
  if (r.topicSuggestions && typeof r.topicSuggestions === 'object' && !Array.isArray(r.topicSuggestions)) {
    for (const [k, v] of Object.entries(r.topicSuggestions as Record<string, unknown>)) {
      if (typeof v === 'string') meta.topicSuggestions[k] = v;
    }
  }
  if (r.state === 'greeting' || r.state === 'elicitation' || r.state === 'recommend' || r.state === 'wrap') {
    meta.state = r.state;
  }
  if (typeof r.lastQuestionTopic === 'string') meta.lastQuestionTopic = r.lastQuestionTopic;
  if (typeof r.lastRecommendAtTurn === 'number') meta.lastRecommendAtTurn = r.lastRecommendAtTurn;
  if (Array.isArray(r.unconfirmedFields)) {
    meta.unconfirmedFields = r.unconfirmedFields.filter((f): f is string => typeof f === 'string');
  }
  if (typeof r.scorerCallsUsed === 'number') meta.scorerCallsUsed = r.scorerCallsUsed;
  return meta;
}

function parseTranscript(raw: unknown): OnboardingTranscriptMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: OnboardingTranscriptMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if ((e.role === 'user' || e.role === 'assistant') && typeof e.content === 'string') {
      out.push({
        role: e.role,
        content: e.content,
        at: typeof e.at === 'string' ? e.at : new Date(0).toISOString(),
      });
    }
  }
  return out;
}

function asStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

// ─── Deterministic extractor shape for quick replies (E10) ─────────────

interface TurnExtraction {
  updates: OnboardingDraftPreferences;
  declinedTopics: OnboardingTopic[];
  fieldConfidence: Record<string, number>;
  wantsJobsNow: boolean;
  wantsToFinish: boolean;
  pastedResumeDetected: boolean;
}

function emptyExtraction(): TurnExtraction {
  return {
    updates: {},
    declinedTopics: [],
    fieldConfidence: {},
    wantsJobsNow: false,
    wantsToFinish: false,
    pastedResumeDetected: false,
  };
}

const QUICK_REPLY_WORK_MODES = new Set(['remote', 'hybrid', 'onsite']);
const QUICK_REPLY_EMPLOYMENT = new Set(['full_time', 'contract', 'part_time', 'internship']);
const QUICK_REPLY_AGGRESSIVENESS = new Set(['manual', 'balanced', 'aggressive']);
const DECLINABLE_TOPICS: ReadonlySet<string> = new Set([
  'salary',
  'workMode',
  'industry',
  'employmentType',
  'location',
  'seniority',
]);

/** Resolve a tapped quick-reply id deterministically — the extractor never
 *  runs for these turns (machine choice stays machine, E10). */
export function resolveQuickReply(
  id: string,
  lastQuestionTopic: string | null,
): TurnExtraction {
  const out = emptyExtraction();
  if (QUICK_REPLY_WORK_MODES.has(id)) {
    out.updates = { workModes: [id as 'remote' | 'hybrid' | 'onsite'] };
    out.fieldConfidence = { workModes: 1 };
  } else if (QUICK_REPLY_EMPLOYMENT.has(id)) {
    out.updates = { employmentTypes: [id as never] };
    out.fieldConfidence = { employmentTypes: 1 };
  } else if (id === 'no_preference') {
    if (lastQuestionTopic && DECLINABLE_TOPICS.has(lastQuestionTopic)) {
      out.declinedTopics = [lastQuestionTopic as OnboardingTopic];
    }
  } else if (id === 'show_jobs') {
    out.wantsJobsNow = true;
  }
  // manual / balanced / aggressive: the S4 pills short-circuit to POST
  // /complete on the frontend; arriving here they're a conversational no-op.
  void QUICK_REPLY_AGGRESSIVENESS;
  return out;
}

// ─── Deterministic next-topic / chip / quick-reply composers ────────────

type ComposerTopic = 'targetRoles' | OnboardingTopic;

const TOPIC_SUGGESTION_KEY: Partial<Record<ComposerTopic, string>> = {
  targetRoles: 'roles',
  workMode: 'workMode',
  salary: 'salary',
  industry: 'industries',
  employmentType: 'employmentType',
};

export function pickNextTopic(
  draft: OnboardingDraftPreferences,
  askedTopics: string[],
): ComposerTopic | 'none' {
  const asked = new Set(askedTopics);
  if (!draft.targetRoles?.length && !asked.has('targetRoles')) return 'targetRoles';
  if (!draft.workModes?.length && !asked.has('workMode')) return 'workMode';
  if (draft.salary?.min == null && !asked.has('salary')) return 'salary';
  if (!draft.industriesTarget?.length && !asked.has('industry')) return 'industry';
  if (!draft.employmentTypes?.length && !asked.has('employmentType')) return 'employmentType';
  if (!draft.locations?.cities?.length && !draft.locations?.countries?.length && !asked.has('location')) {
    return 'location';
  }
  if (!draft.seniority && !asked.has('seniority')) return 'seniority';
  return 'none';
}

function composeChips(args: {
  m: OnboardingMessages;
  meta: SessionMeta;
  nextTopic: ComposerTopic | 'none';
  draft: OnboardingDraftPreferences;
  roundsLeft: boolean;
  zeroResultsRound: boolean;
  wrap: boolean;
}): string[] {
  const { m, meta, nextTopic, draft, roundsLeft, zeroResultsRound, wrap } = args;
  const chips: string[] = [];
  if (zeroResultsRound) {
    if ((draft.salary?.min ?? 0) > 0) chips.push(m.relaxChipSalary);
    if (draft.locations?.cities?.length) chips.push(m.relaxChipLocation);
    if (draft.workModes?.length === 1 && draft.workModes[0] === 'remote') {
      chips.push(m.relaxChipHybrid);
    }
  }
  if (!wrap && nextTopic !== 'none') {
    const suggestionKey = TOPIC_SUGGESTION_KEY[nextTopic];
    const suggestion = suggestionKey ? meta.topicSuggestions[suggestionKey] : undefined;
    const catalogChip =
      nextTopic !== 'targetRoles' ? m.nextTopicChip[nextTopic as OnboardingTopic] : undefined;
    const chip = suggestion ?? catalogChip;
    if (chip && !chips.includes(chip)) chips.push(chip);
  }
  if (!wrap && roundsLeft && !zeroResultsRound && !chips.includes(m.showJobsChip)) {
    chips.push(m.showJobsChip);
  }
  return chips.slice(0, 4);
}

function composeQuickReplies(
  m: OnboardingMessages,
  nextTopic: ComposerTopic | 'none',
  wrap: boolean,
): OnboardingQuickReplyOption[] {
  if (wrap) {
    return (['manual', 'balanced', 'aggressive'] as const).map((id) => ({
      id,
      label: m.quickReply[id],
    }));
  }
  if (nextTopic === 'workMode') {
    return (['remote', 'hybrid', 'onsite', 'no_preference'] as const).map((id) => ({
      id,
      label: m.quickReply[id],
    }));
  }
  if (nextTopic === 'employmentType') {
    return (['full_time', 'contract', 'part_time', 'no_preference'] as const).map((id) => ({
      id,
      label: m.quickReply[id],
    }));
  }
  if (nextTopic === 'salary' || nextTopic === 'industry' || nextTopic === 'location' || nextTopic === 'seniority') {
    return [{ id: 'no_preference', label: m.quickReply.no_preference }];
  }
  return [];
}

// ─── Shortlist block (recommend-turn chat context) ─────────────────────

export function composeShortlistBlock(round: RecommendRoundResult, locale: RaLocale): string {
  const m = getMessages(locale);
  if (round.zeroResults) {
    const parts = ['SHORTLIST: ZERO RESULTS', 'No jobs cleared the bar this round.'];
    if (round.salaryFloorStated && !round.salaryFilterApplied) {
      parts.push(`SALARY NOTE — convey this plainly in your own words: ${m.salaryNotFilterable}`);
    }
    return parts.join('\n');
  }
  const lines = round.cards.map((c, i) => {
    const bits = [`${i + 1}. ${c.title} @ ${c.companyName} — score ${c.matchScore}`];
    if (c.isExternal && c.sourcePublisher) bits.push(`via ${c.sourcePublisher}`);
    if (c.salaryMin != null || c.salaryMax != null) {
      bits.push(
        `Salary: ${[c.salaryMin, c.salaryMax].filter((v) => v != null).join('–')} ${c.salaryCurrency ?? ''}`.trim(),
      );
    }
    return `${bits.join(' — ')}\n   why: ${c.whyMatched}`;
  });
  const parts = [
    'SHORTLIST (already shown to the user as cards; scores are for YOUR judgment only — never write them):',
    ...lines,
  ];
  if (round.salaryFloorStated && !round.salaryFilterApplied) {
    parts.push(`SALARY NOTE — convey this plainly in your own words: ${m.salaryNotFilterable}`);
  }
  return parts.join('\n');
}

// ─── Returning-user stored-prefs digest (deterministic, catalog labels) ─

function buildStoredPrefsDigest(blob: Record<string, unknown> | null, m: OnboardingMessages): string {
  if (!blob) return '';
  const parts: string[] = [];
  const roles = asStringList(blob.roleTitles).slice(0, 2);
  if (roles.length) parts.push(roles.join(' / '));
  const modes = blob.workModes && typeof blob.workModes === 'object' ? (blob.workModes as Record<string, unknown>) : {};
  const modeLabels = (['remote', 'hybrid', 'onsite'] as const)
    .filter((k) => modes[k] === true)
    .map((k) => m.quickReply[k]);
  if (modeLabels.length) parts.push(modeLabels.join(' · '));
  const industries = asStringList(blob.industriesTarget).slice(0, 2);
  if (industries.length) parts.push(industries.join(' · '));
  return parts.join(' · ');
}

// ─── Service ───────────────────────────────────────────────────────────

export class RAOnboardingService {
  // ── S0 → S1: bootstrap ──────────────────────────────────────────────

  async bootstrap(
    userId: string,
    resumeVariantId: string,
    locale: RaLocale,
    opts: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<OnboardingBootstrapResponse> {
    const startedAt = Date.now();
    const requestId = opts.requestId ?? getCurrentRequestId() ?? undefined;
    const p = prisma as any;
    const m = getMessages(locale);

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

    // Daily-cap check BEFORE any write — a 429 must never destroy the
    // prior active session it is refusing to replace. Zero-turn sessions
    // that are abandoned (R14) or still active (they would have become
    // zero-turn abandoned rows in the supersede below) are exempt.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const createdToday = await p.rAOnboardingSession.count({
      where: {
        userId,
        createdAt: { gte: dayStart },
        NOT: { turnCount: 0, status: { in: ['abandoned', 'active'] } },
      },
    });
    if (createdToday >= SESSIONS_PER_DAY) {
      throw new OnboardingDailyLimitError('daily onboarding session limit reached');
    }

    // Cap passed — only now supersede the prior active session.
    await p.rAOnboardingSession.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'abandoned' },
    });

    // Returning user? (preferencesBlob.onboarding.completedAt)
    const goalRow = await p.rACareerGoal.findUnique({
      where: { userId },
      select: { preferencesBlob: true },
    });
    const blob =
      goalRow?.preferencesBlob && typeof goalRow.preferencesBlob === 'object'
        ? (goalRow.preferencesBlob as Record<string, unknown>)
        : null;
    const onboardingStamp =
      blob?.onboarding && typeof blob.onboarding === 'object'
        ? (blob.onboarding as Record<string, unknown>)
        : null;
    const returning = Boolean(onboardingStamp?.completedAt);
    const prefsDigest = returning ? buildStoredPrefsDigest(blob, m) : '';

    const variantName = variant.name ?? 'My résumé';
    const ingestRows = buildIngestRows(
      {
        variantName,
        parsedData: variant.parsedData,
        summary: variant.summary,
        highlight: variant.highlight,
        resumeMarkdown: variant.resumeMarkdown,
      },
      locale,
    );

    // Kickoff agent — catalog fallback on failure or unusable output.
    const kickoffStartedAt = Date.now();
    let headline = '';
    let openingPrompt = '';
    let chips: string[] = [];
    let topicSuggestions: Record<string, string> = {};
    let kickoffFallback = false;
    try {
      const { raOnboardingKickoffAgent, isUsableKickoffOutput } = await import(
        '../agents/RAOnboardingKickoffAgent.js'
      );
      const out = await raOnboardingKickoffAgent.run(
        {
          summary: variant.summary ?? null,
          resumeMarkdown: (variant.resumeMarkdown ?? '').slice(0, KICKOFF_RESUME_CLIP),
          variantName,
          returning,
          ...(prefsDigest ? { storedPrefsDigest: prefsDigest } : {}),
        },
        { requestId, locale, signal: opts.signal },
      );
      if (isUsableKickoffOutput(out)) {
        headline = out.candidateHeadline;
        openingPrompt = out.openingPrompt;
        chips = out.chips;
        topicSuggestions = Object.fromEntries(
          Object.entries(out.topicSuggestions ?? {}).filter(
            (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0,
          ),
        );
      } else {
        kickoffFallback = true;
      }
    } catch {
      kickoffFallback = true;
    }
    if (kickoffFallback) {
      headline = ingestRows.find((r) => r.kind === 'identity')?.value ?? variantName;
      openingPrompt = m.genericOpeningPrompt;
      chips = [...m.genericChips];
    }

    const greeting = returning
      ? format(m.greetingReturning, { headline, prefsDigest: prefsDigest || m.defaultTargetTitle })
      : format(m.greetingNew, { headline });

    const meta: SessionMeta = {
      ...defaultMeta(),
      list: chips,
      headline,
      topicSuggestions,
    };
    const session = await p.rAOnboardingSession.create({
      data: {
        userId,
        resumeVariantId: variant.id,
        locale,
        openingPrompt: stripControl(openingPrompt),
        chips: deepClean(meta),
        transcript: deepClean([
          { role: 'assistant', content: greeting, at: new Date().toISOString() },
        ]),
      },
    });

    logger.info('RA_V2_ONBOARDING_BOOTSTRAP', 'onboarding session bootstrapped', {
      requestId,
      userId,
      sessionId: session.id,
      variantId: variant.id,
      returning,
      ingestRowCount: ingestRows.length,
      kickoffMs: Date.now() - kickoffStartedAt,
      kickoffFallback,
      durationMs: Date.now() - startedAt,
    });

    return {
      sessionId: session.id,
      state: 'greeting',
      returning,
      resumeVariant: { id: variant.id, name: variantName },
      ingestRows,
      greeting,
      openingPrompt,
      chips,
    };
  }

  // ── Session restore (GET /session) ──────────────────────────────────

  async getSession(userId: string, locale: RaLocale): Promise<OnboardingSessionResponse> {
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
        turnCount: row.turnCount,
      });
      throw new OnboardingNoActiveSessionError('no active session');
    }

    const meta = parseSessionMeta(row.chips);
    const draft = (row.draftPreferences ?? {}) as OnboardingDraftPreferences;
    const surfacedJobIds = asStringList(row.surfacedJobIds);

    let ingestRows: IngestRow[] = [];
    if (row.resumeVariantId) {
      const variant = await p.rAResumeVariant.findFirst({
        where: { id: row.resumeVariantId, userId, deletedAt: null },
        select: { name: true, parsedData: true, summary: true, highlight: true, resumeMarkdown: true },
      });
      if (variant) {
        ingestRows = buildIngestRows(
          {
            variantName: variant.name ?? 'My résumé',
            parsedData: variant.parsedData,
            summary: variant.summary,
            highlight: variant.highlight,
            resumeMarkdown: variant.resumeMarkdown,
          },
          locale,
        );
      }
    }

    const surfacedJobs = await raOnboardingRecommendService.rehydrateCards(
      userId,
      surfacedJobIds,
      row.resumeVariantId,
      locale,
    );

    const capturedFields = Object.keys(draft).filter(
      (k) => !meta.unconfirmedFields.includes(k),
    );

    const response: OnboardingSessionResponse = {
      sessionId: row.id,
      state: row.turnCount === 0 ? 'greeting' : meta.state,
      resumeVariantId: row.resumeVariantId ?? null,
      transcript: parseTranscript(row.transcript),
      draftPreferences: draft,
      capturedFields,
      chips: meta.list,
      ingestRows,
      surfacedJobs,
      passedJobIds: asStringList(row.passedJobIds),
      turnCount: row.turnCount,
      recommendationRounds: row.recommendationRounds,
    };
    if (row.turnCount === 0 && row.openingPrompt) {
      response.openingPrompt = row.openingPrompt;
    }
    return response;
  }

  // ── Pre-stream validation (route calls before flushing headers) ──────

  async loadTurnSession(userId: string, sessionId: string): Promise<any> {
    const p = prisma as any;
    const row = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
    if (!row || row.userId !== userId) {
      throw new OnboardingNoActiveSessionError('no active session');
    }
    if (row.status === 'active') return row;
    if (row.status === 'abandoned') {
      const newer = await p.rAOnboardingSession.findFirst({
        where: { userId, status: 'active', createdAt: { gt: row.createdAt } },
        select: { id: true },
      });
      if (newer) throw new OnboardingSessionSupersededError('session superseded');
    }
    throw new OnboardingSessionNotActiveError('session not active');
  }

  // ── The conversational turn (spec §3.3 T1–T10) ───────────────────────

  async runTurn(opts: {
    session: any;
    userId: string;
    message: string;
    quickReplyId?: string;
    locale: RaLocale;
    requestId?: string;
    signal?: AbortSignal;
    emit: (event: RAOnboardingStreamEvent) => void;
  }): Promise<void> {
    const startedAt = Date.now();
    const { session, userId, locale, emit, signal } = opts;
    const requestId = opts.requestId ?? getCurrentRequestId() ?? undefined;
    const p = prisma as any;
    const m = getMessages(locale);
    const meta = parseSessionMeta(session.chips);
    const transcript = parseTranscript(session.transcript);
    const draft0 = (session.draftPreferences ?? {}) as OnboardingDraftPreferences;
    const askedTopics = asStringList(session.askedTopics);
    const surfacedJobIds = asStringList(session.surfacedJobIds);
    const passedJobIds = asStringList(session.passedJobIds);
    const turnNumber = session.turnCount + 1;
    const userText = stripControl(opts.message).trim().slice(0, MAX_MESSAGE_LEN);

    const currentState: SessionState = session.turnCount === 0 ? 'greeting' : meta.state;
    emit({ type: 'session', sessionId: session.id, state: currentState });

    // ── Turn cap: deterministic catalog wrap, no LLM, no billing ──
    if (session.turnCount >= MAX_TURNS) {
      emit({ type: 'text-delta', delta: m.turnCapWrap });
      emit({ type: 'state', state: 'wrap' });
      emit({ type: 'quick-replies', options: composeQuickReplies(m, 'none', true) });
      const finalMeta: SessionMeta = { ...meta, state: 'wrap', list: [] };
      await p.rAOnboardingSession
        .update({
          where: { id: session.id },
          data: {
            transcript: deepClean([
              ...transcript,
              { role: 'user', content: userText, at: new Date().toISOString() },
              { role: 'assistant', content: m.turnCapWrap, at: new Date().toISOString() },
            ]),
            chips: deepClean(finalMeta),
          },
        })
        .catch(() => undefined);
      emit({ type: 'done', turnCount: session.turnCount });
      return;
    }

    // ── [T1] Extraction — deterministic for quick replies (E10) ──
    const extractStartedAt = Date.now();
    let extract: TurnExtraction = emptyExtraction();
    let extractFallback = false;
    if (opts.quickReplyId) {
      extract = resolveQuickReply(opts.quickReplyId, meta.lastQuestionTopic);
    } else if (userText === m.showJobsChip) {
      // The deterministic "Show me jobs now" chip arrives as plain text.
      extract = { ...emptyExtraction(), wantsJobsNow: true };
    } else {
      try {
        const { raOnboardingPrefExtractAgent } = await import(
          '../agents/RAOnboardingPrefExtractAgent.js'
        );
        extract = await raOnboardingPrefExtractAgent.run(
          {
            userMessage: userText.slice(0, 2000),
            currentDraft: draft0,
            askedTopics,
            lastQuestionTopic: meta.lastQuestionTopic ?? 'none',
          },
          { requestId, locale, signal },
        );
      } catch {
        extractFallback = true;
        extract = emptyExtraction();
      }
    }
    const extractMs = Date.now() - extractStartedAt;

    // ── Merge + confidence bookkeeping (E11/R6 + R8) ──
    const normalizedUpdates = normalizeDraftUpdates(extract.updates);
    const draft1 = mergeDraft(draft0, extract.updates, extract.declinedTopics);
    const capturedRaw = Object.keys(normalizedUpdates).filter(
      (k) => (draft1 as Record<string, unknown>)[k] !== undefined,
    );
    const capturedChanged = capturedRaw.filter(
      (k) =>
        JSON.stringify((draft1 as Record<string, unknown>)[k]) !==
        JSON.stringify((draft0 as Record<string, unknown>)[k]),
    );

    const market = marketDefaultsForLocale(locale);
    const unconfirmedThisTurn: string[] = [];
    const implicitConfirmThisTurn: string[] = [];
    const unconfirmedBefore = new Set(meta.unconfirmedFields);
    const unconfirmedSet = new Set(meta.unconfirmedFields);
    for (const field of capturedRaw) {
      const confidence = extract.fieldConfidence[field] ?? 1;
      if (confidence >= CONFIDENCE_FLOOR) {
        unconfirmedSet.delete(field); // re-captured confidently → confirmed
        continue;
      }
      // R8 — locale-market-consistent inferred currency with an explicit
      // period token: confirmed inline, never a standalone question.
      if (
        field === 'salary' &&
        draft1.salary?.currency === market.currency &&
        normalizedUpdates.salary?.period != null
      ) {
        implicitConfirmThisTurn.push(field);
        unconfirmedSet.delete(field);
      } else {
        unconfirmedThisTurn.push(field);
        unconfirmedSet.add(field);
      }
    }

    // The wire event carries the FULL standing unconfirmed set (the frontend
    // tray replaces, never merges) — and a confirmation-only turn (the set
    // shrank but nothing new was captured) must still emit so the tray
    // un-suppresses the now-confirmed field.
    const unconfirmedSetChanged =
      unconfirmedSet.size !== unconfirmedBefore.size ||
      [...unconfirmedSet].some((f) => !unconfirmedBefore.has(f));
    if (capturedChanged.length > 0 || unconfirmedSetChanged) {
      emit({
        type: 'prefs-update',
        draft: draft1,
        captured: capturedChanged,
        unconfirmed: [...unconfirmedSet],
      });
    }

    // ── Single fire-and-forget checkpoint (E9a) ──
    const transcriptWithUser: OnboardingTranscriptMessage[] = [
      ...transcript,
      { role: 'user', content: userText, at: new Date().toISOString() },
    ];
    void p.rAOnboardingSession
      .update({
        where: { id: session.id },
        data: {
          transcript: deepClean(transcriptWithUser),
          draftPreferences: deepClean(draft1),
        },
      })
      .catch((err: unknown) => {
        logger.warn('RA_V2_ONBOARDING_TURN', 'mid-turn checkpoint failed', {
          requestId,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // ── [T2] Recommendation trigger (deterministic; unconfirmed never count) ──
    const confirmed = (field: keyof OnboardingDraftPreferences): boolean => {
      const value = (draft1 as Record<string, unknown>)[field];
      if (value === undefined || unconfirmedSet.has(field)) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
      return true;
    };
    const hasRoles = confirmed('targetRoles');
    const signalCount = (
      ['industriesTarget', 'workModes', 'salary', 'employmentTypes', 'locations'] as const
    ).filter((f) => confirmed(f)).length;
    const signalMet = hasRoles || signalCount >= 2;

    const roundsUsed: number = session.recommendationRounds;
    const spacingOk =
      meta.lastRecommendAtTurn === 0 ||
      turnNumber - meta.lastRecommendAtTurn >= ROUND_SPACING_TURNS;
    let runRound = false;
    let forcedInternalOnly = false;
    if (roundsUsed < MAX_ROUNDS && spacingOk && meta.state !== 'wrap') {
      if (extract.wantsJobsNow) {
        runRound = true;
      } else if (signalMet && turnNumber >= RECOMMEND_MIN_TURN) {
        runRound = true;
      } else if (turnNumber >= FORCED_RECOMMEND_TURN && roundsUsed === 0) {
        runRound = true;
        forcedInternalOnly = !signalMet; // R13 — never bill JSearch on a blind round
      }
    }

    // ── [T3–T7] Recommendation round (never throws) ──
    let roundResult: RecommendRoundResult | null = null;
    let shortlistBlock: string | undefined;
    if (runRound) {
      const allowJSearch =
        !forcedInternalOnly && session.jsearchCallCount < MAX_JSEARCH_PER_SESSION;
      const scorerBudget = Math.max(
        0,
        Math.min(MAX_SCORER_PER_ROUND, MAX_SCORER_PER_SESSION - meta.scorerCallsUsed),
      );
      roundResult = await raOnboardingRecommendService.runRound({
        userId,
        sessionId: session.id,
        resumeVariantId: session.resumeVariantId ?? null,
        locale,
        requestId,
        signal,
        draft: draft1,
        candidateHeadline: meta.headline,
        round: roundsUsed + 1,
        allowJSearch,
        scorerBudget,
        excludeJobIds: [...new Set([...surfacedJobIds, ...passedJobIds])],
        emit,
      });
      if (roundResult.cards.length > 0) {
        emit({ type: 'job-cards', jobs: roundResult.cards });
      }
      emit({ type: 'state', state: 'recommend' });
      shortlistBlock = composeShortlistBlock(roundResult, locale);
    }

    // ── Mode + next topic (deterministic) ──
    let mode: 'greeting' | 'elicitation' | 'recommend' | 'wrap';
    if (runRound) mode = 'recommend';
    else if (extract.wantsToFinish || meta.state === 'wrap' || roundsUsed >= MAX_ROUNDS) mode = 'wrap';
    else if (session.turnCount === 0) mode = 'greeting';
    else mode = 'elicitation';

    const askedWithDeclines = [...new Set([...askedTopics, ...extract.declinedTopics])];
    const nextTopic = mode === 'wrap' ? 'none' : pickNextTopic(draft1, askedWithDeclines);

    // Wrap-mode extras: saved count + the dailyCap disclosure (R5).
    let savedCount = 0;
    if (mode === 'wrap' && surfacedJobIds.length > 0) {
      try {
        savedCount = await p.rATrackerEntry.count({
          where: { userId, jobId: { in: surfacedJobIds } },
        });
      } catch {
        /* best-effort */
      }
    }

    // ── [T8] Chat agent streams (catalog apology on failure; never throws) ──
    const chatStartedAt = Date.now();
    let chatOk = false;
    let chatText = '';
    try {
      const { raOnboardingChatAgent } = await import('../agents/RAOnboardingChatAgent.js');
      const generator = raOnboardingChatAgent.streamTurn(
        {
          mode,
          locale,
          candidateHeadline: meta.headline,
          draft: draft1,
          capturedThisTurn: capturedChanged,
          unconfirmedFields: unconfirmedThisTurn,
          implicitConfirmFields: implicitConfirmThisTurn,
          askedTopics: askedWithDeclines,
          nextTopic,
          returning: false,
          shortlistBlock,
          resumeVariantName: undefined,
          savedCount,
          dailyCap: ONBOARDING_DAILY_CAP,
          forcedWrap: mode === 'wrap' && !extract.wantsToFinish,
          transcript: transcript.map((t) => ({ role: t.role, content: t.content })),
          userMessage: userText,
        },
        { requestId, signal },
      );
      // Manual iteration so the generator's RETURN value (the turn result)
      // is observable — for-await discards it.
      for (;;) {
        const step = await generator.next();
        if (step.done) {
          chatOk = step.value.ok && step.value.text.trim().length > 0;
          chatText = step.value.text;
          break;
        }
        emit({ type: 'text-delta', delta: step.value });
      }
    } catch {
      chatOk = false;
    }
    const chatMs = Date.now() - chatStartedAt;

    // Shared final-persist payload pieces.
    const newSurfaced = roundResult
      ? [...surfacedJobIds, ...roundResult.cards.map((c) => c.id)]
      : surfacedJobIds;
    const metaFinal: SessionMeta = {
      ...meta,
      unconfirmedFields: [...unconfirmedSet],
      scorerCallsUsed: meta.scorerCallsUsed + (roundResult?.scorerCallsUsed ?? 0),
      lastRecommendAtTurn: roundResult ? turnNumber : meta.lastRecommendAtTurn,
    };
    const roundData = roundResult
      ? {
          recommendationRounds: roundsUsed + 1,
          jsearchCallCount: session.jsearchCallCount + roundResult.jsearchCalls,
          surfacedJobIds: newSurfaced,
        }
      : {};

    if (!chatOk) {
      // Catalog apology — the turn is NOT billed and the turn counter does
      // not advance; round side-effects (cards, budgets) still persist.
      const aborted = signal?.aborted === true;
      if (!aborted) emit({ type: 'text-delta', delta: m.apologyTurn });
      emit({
        type: 'error',
        code: aborted ? 'aborted' : 'turn_failed',
        message: aborted ? 'client_closed' : 'chat_agent_failed',
      });
      await p.rAOnboardingSession
        .update({
          where: { id: session.id },
          data: {
            transcript: deepClean(
              aborted
                ? transcriptWithUser
                : [
                    ...transcriptWithUser,
                    { role: 'assistant', content: m.apologyTurn, at: new Date().toISOString() },
                  ],
            ),
            draftPreferences: deepClean(draft1),
            chips: deepClean(metaFinal),
            ...roundData,
          },
        })
        .catch(() => undefined);
      emit({ type: 'done', turnCount: session.turnCount });
      logger.info('RA_V2_ONBOARDING_TURN', 'onboarding turn failed (not billed)', {
        requestId,
        sessionId: session.id,
        turn: turnNumber,
        state: mode,
        extractMs,
        extractFallback,
        capturedFields: capturedChanged.length,
        chatMs,
        chatFallback: true,
        ...(roundResult ? { recommendRound: roundsUsed + 1 } : {}),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // ── [T9] Deterministic chips + quick replies ──
    const roundsLeftAfter = (roundResult ? roundsUsed + 1 : roundsUsed) < MAX_ROUNDS;
    const chips = composeChips({
      m,
      meta,
      nextTopic,
      draft: draft1,
      roundsLeft: roundsLeftAfter,
      zeroResultsRound: roundResult?.zeroResults === true,
      wrap: mode === 'wrap',
    });
    if (chips.length > 0) emit({ type: 'chips', chips });
    const quickReplies = composeQuickReplies(m, nextTopic, mode === 'wrap');
    if (quickReplies.length > 0) emit({ type: 'quick-replies', options: quickReplies });

    // ── [T10] Transition + final awaited persist + billing ──
    const nextState: SessionState =
      mode === 'wrap' ? 'wrap' : mode === 'recommend' ? 'recommend' : 'elicitation';
    if (nextState !== currentState && nextState !== 'recommend') {
      // 'recommend' was already emitted with the cards; avoid a duplicate.
      emit({ type: 'state', state: nextState });
    }
    const askedFinal =
      nextTopic !== 'none' && !askedWithDeclines.includes(nextTopic)
        ? [...askedWithDeclines, nextTopic]
        : askedWithDeclines;
    metaFinal.state = nextState;
    metaFinal.list = chips;
    metaFinal.lastQuestionTopic = nextTopic === 'none' ? null : nextTopic;

    try {
      await p.rAOnboardingSession.update({
        where: { id: session.id },
        data: {
          transcript: deepClean([
            ...transcriptWithUser,
            { role: 'assistant', content: chatText, at: new Date().toISOString() },
          ]),
          draftPreferences: deepClean(draft1),
          askedTopics: askedFinal,
          turnCount: turnNumber,
          chips: deepClean(metaFinal),
          ...roundData,
        },
      });
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_TURN', 'final turn persist failed', {
        requestId,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const cost = costPatchFromTally(requestId);
    await writeDeductionLog({
      userId,
      sku: 'ra_onboarding_turn',
      source: 'free_tier',
      platformCostUsd: cost.platformCostUsd,
      apiKeyId: null,
      units: 1,
      requestId: requestId ?? null,
      relatedEntityType: 'ra_onboarding_session',
      relatedEntityId: session.id,
      metadata: { ...cost.metadata, source: 'roboapply_v2', turn: turnNumber, state: nextState },
    });

    emit({ type: 'done', turnCount: turnNumber });
    logger.info('RA_V2_ONBOARDING_TURN', 'onboarding turn completed', {
      requestId,
      sessionId: session.id,
      turn: turnNumber,
      state: nextState,
      extractMs,
      extractFallback,
      capturedFields: capturedChanged.length,
      chatMs,
      chatFallback: false,
      ...(roundResult ? { recommendRound: roundsUsed + 1 } : {}),
      durationMs: Date.now() - startedAt,
    });
  }

  // ── Completion (spec §6.2; E9c/R12 fire-and-forget summary) ──────────

  async complete(
    userId: string,
    sessionId: string,
    aggressiveness: OnboardingAggressiveness,
    locale: RaLocale,
    requestId?: string,
  ): Promise<OnboardingCompleteResponse> {
    const startedAt = Date.now();
    const p = prisma as any;
    if (!['manual', 'balanced', 'aggressive'].includes(aggressiveness)) {
      throw new OnboardingInvalidAggressivenessError('invalid aggressiveness');
    }
    const session = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new OnboardingNoActiveSessionError('no session');
    }

    const { raCareerGoalService } = await import('./RACareerGoalService.js');
    const { raPreferencesService } = await import('./RAPreferencesService.js');

    // Idempotent: re-POST on a completed session returns current state.
    if (session.status === 'completed') {
      const [goal, prefs] = await Promise.all([
        raCareerGoalService.get(userId),
        raPreferencesService.get(userId),
      ]);
      return {
        goal: (goal ?? {}) as Record<string, unknown>,
        preferences: prefs.preferences as unknown as Record<string, unknown>,
      };
    }

    const meta = parseSessionMeta(session.chips);
    const transcript = parseTranscript(session.transcript);
    const fullDraft = (session.draftPreferences ?? {}) as OnboardingDraftPreferences;
    // Unconfirmed fields never persist silently (R6 — the tray suppressed
    // them, so writing them here would be a silent assumption).
    const draft: OnboardingDraftPreferences = { ...fullDraft };
    for (const field of meta.unconfirmedFields) {
      delete (draft as Record<string, unknown>)[field];
    }

    // 1. Goal upsert — best-effort; notesMarkdown comes later (E9c/R12).
    let goal: Record<string, unknown> = {};
    try {
      goal = (await raCareerGoalService.upsert(
        userId,
        draftToGoalInput(draft, locale),
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_COMPLETE', 'goal upsert failed; continuing', {
        requestId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Sparse preferences PATCH — only conversation-captured keys.
    let preferences: Record<string, unknown> = {};
    try {
      const firstUserMessage = transcript.find((t) => t.role === 'user')?.content ?? '';
      const patch = {
        ...draftToPreferencesPatch(draft),
        ...(firstUserMessage ? { intentMarkdown: firstUserMessage.slice(0, 4000) } : {}),
        ...(session.resumeVariantId ? { defaultResumeId: session.resumeVariantId } : {}),
        aggressiveness,
        dailyCap: ONBOARDING_DAILY_CAP,
        huntActive: true,
        onboarding: {
          completedAt: new Date().toISOString(),
          version: 'v4-chat',
          completedSteps: ['resume', 'preferences'],
          sessionId,
        },
      };
      const updated = await raPreferencesService.update(userId, patch as never);
      preferences = updated.preferences as unknown as Record<string, unknown>;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_COMPLETE', 'preferences patch failed; continuing', {
        requestId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Primary flip — exactly-one-primary invariant via setPrimary.
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
        logger.warn('RA_V2_ONBOARDING_COMPLETE', 'primary flip failed; continuing', {
          requestId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Session → completed.
    try {
      await p.rAOnboardingSession.update({
        where: { id: sessionId },
        data: { status: 'completed', completedAt: new Date() },
      });
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_COMPLETE', 'session status update failed', {
        requestId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('RA_V2_ONBOARDING_COMPLETE', 'onboarding completed', {
      requestId,
      sessionId,
      turnCount: session.turnCount,
      rounds: session.recommendationRounds,
      capturedFieldCount: Object.keys(draft).length,
      durationMs: Date.now() - startedAt,
    });

    // 5. notesMarkdown summary — FIRE-AND-FORGET after the response (E9c/R12):
    // the redirect never waits on a Sonnet call; the deterministic
    // transcript digest covers the failure path.
    void this.composeAndStoreSummary(userId, meta.headline, draft, transcript, locale, requestId);

    return { goal, preferences };
  }

  /** Deterministic fallback = the user's own words (locale-safe by
   *  construction), clipped to the notesMarkdown budget. */
  private buildTranscriptDigest(transcript: OnboardingTranscriptMessage[]): string {
    return transcript
      .filter((t) => t.role === 'user')
      .map((t) => `- ${t.content}`)
      .join('\n')
      .slice(0, NOTES_MARKDOWN_CLIP);
  }

  private async composeAndStoreSummary(
    userId: string,
    candidateHeadline: string,
    draft: OnboardingDraftPreferences,
    transcript: OnboardingTranscriptMessage[],
    locale: RaLocale,
    requestId?: string,
  ): Promise<void> {
    const p = prisma as any;
    try {
      let summary: string | null = null;
      try {
        const { raOnboardingChatAgent } = await import('../agents/RAOnboardingChatAgent.js');
        summary = await raOnboardingChatAgent.composeSummary(
          {
            locale,
            candidateHeadline,
            draft,
            transcript: transcript.map((t) => ({ role: t.role, content: t.content })),
          },
          { requestId },
        );
      } catch {
        summary = null;
      }
      const notesMarkdown = stripControl(summary ?? this.buildTranscriptDigest(transcript)).slice(
        0,
        NOTES_MARKDOWN_CLIP,
      );
      if (!notesMarkdown.trim()) return;
      await p.rACareerGoal.update({ where: { userId }, data: { notesMarkdown } });
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_COMPLETE', 'notesMarkdown summary failed (non-fatal)', {
        requestId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Skip (spec §2.5 / PRD §9.1) — always succeeds ─────────────────────

  async skip(
    userId: string,
    sessionId: string | undefined,
    locale: RaLocale,
    requestId?: string,
  ): Promise<void> {
    const p = prisma as any;
    let draft: OnboardingDraftPreferences = {};
    let resumeVariantId: string | null = null;
    let turnCount = 0;
    try {
      if (sessionId) {
        const session = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
        if (session && session.userId === userId) {
          const meta = parseSessionMeta(session.chips);
          const fullDraft = (session.draftPreferences ?? {}) as OnboardingDraftPreferences;
          draft = { ...fullDraft };
          for (const field of meta.unconfirmedFields) {
            delete (draft as Record<string, unknown>)[field]; // confirmed fields only
          }
          resumeVariantId = session.resumeVariantId ?? null;
          turnCount = session.turnCount;
          if (session.status === 'active') {
            await p.rAOnboardingSession
              .update({ where: { id: sessionId }, data: { status: 'skipped' } })
              .catch(() => undefined);
          }
        }
      }
      const { raPreferencesService } = await import('./RAPreferencesService.js');
      await raPreferencesService.update(userId, {
        ...draftToPreferencesPatch(draft),
        ...(resumeVariantId ? { defaultResumeId: resumeVariantId } : {}),
        onboarding: { skippedAt: new Date().toISOString(), version: 'v4-chat' },
      } as never);
    } catch (err) {
      // Skip must never block leaving onboarding — log and return.
      logger.warn('RA_V2_ONBOARDING_SKIP', 'skip flush failed (non-fatal)', {
        requestId,
        userId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('RA_V2_ONBOARDING_SKIP', 'onboarding skipped', {
      requestId,
      userId,
      sessionId: sessionId ?? null,
      turnCount,
      capturedFieldCount: Object.keys(draft).length,
    });
  }

  // ── Pass (spec §2.6) — idempotent negative signal ─────────────────────

  async pass(userId: string, sessionId: string, jobId: string): Promise<void> {
    const p = prisma as any;
    const session = await p.rAOnboardingSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new OnboardingNoActiveSessionError('no session');
    }
    const surfaced = asStringList(session.surfacedJobIds);
    if (!surfaced.includes(jobId)) {
      throw new OnboardingJobNotFoundError('job was not surfaced in this session');
    }
    const passed = asStringList(session.passedJobIds);
    if (passed.includes(jobId)) return; // idempotent
    await p.rAOnboardingSession.update({
      where: { id: sessionId },
      data: { passedJobIds: [...passed, jobId] },
    });
  }
}

export const raOnboardingService = new RAOnboardingService();
export default raOnboardingService;

// Test surface — deterministic composers + meta parsing (no LLM needed).
export const __test = {
  parseSessionMeta,
  resolveQuickReply,
  pickNextTopic,
  composeShortlistBlock,
  composeChips,
  composeQuickReplies,
  buildStoredPrefsDigest,
};

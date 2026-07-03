// backend/src/roboapply/agents/RoboApplyDigestAgent.ts
//
// Agent #5 in docs/roboapply/02-architecture.md §2 — the daily morning
// narration. Streamed to /mission via SSE and emailed via existing
// EmailService at 07:00 user-local.
//
// Tone is fixed per arch §3.3: names the user, names companies, names
// what was skipped *and why*, calls out wins, names a clear time pressure,
// ends with a clear escape. No marketing voice. No "Hope this finds you well."
//
// CitationGuard discipline: every `{{runId}}` mentioned in the narration
// is verified against the set of real RoboApplyRun.id values passed in.
// Sentences referencing unknown ids are dropped (best-effort) and a
// `citationGuardPassed=false` row is persisted with the sanitized output so
// the digest still goes out — but admin analytics can flag high CG-failure
// missions.
//
// Quota: writes one `roboapply_digest` audit row on success. Failures cost
// zero — but the digest service surfaces a deterministic fallback narrative
// ("X submitted, Y queued, Z skipped") instead of throwing.

import { BaseAgent } from '../../agents/BaseAgent.js';
import { writeDeductionLog } from '../../lib/matchBilling.js';
import { costPatchFromTally } from '../../lib/deductionCost.js';
import { logger } from '../../services/LoggerService.js';
import type { RoboApplyLocale } from './RoboApplyIntentParserAgent.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface DigestRunReference {
  runId: string;
  jobTitle: string;
  companyName: string;
  matchScore: number;
  status?: string; // e.g. 'submitted', 'previewing', 'failed', 'undone'
  /** A 1-sentence rationaleForPick from the run. */
  aiAngle?: string;
}

export interface DigestStandoutResponse {
  runId: string;
  companyName: string;
  /** e.g. 'recruiter_viewed', 'interview_invited', 'rejected'. */
  signal: string;
  /** When the signal was observed. */
  at: string;
}

export interface RoboApplyDigestInput {
  missionId: string;
  /** Recipient's first name for the greeting. */
  firstName: string;
  /** True if this is the user's first ever digest. Drives onboarding tone. */
  isFirstDay: boolean;
  /** Mission tier — narration tone calibrated. */
  tier: 'free' | 'premium' | 'premium_plus';
  /** Today's queued runs (status='previewing'). */
  todayQueued: DigestRunReference[];
  /** Yesterday's submission outcomes. */
  yesterday: {
    submittedCount: number;
    failedCount: number;
    skippedCount: number;
    standouts: DigestStandoutResponse[];
  };
  /** Counts from the matcher run. */
  marketWatcher: {
    boardsScanned: number;
    jobsConsidered: number;
    lastScanIso: string;
  };
  /** Recent skips with reasons — the narration may mention them. */
  recentSkips: Array<{ runId: string; reason: string; companyName: string }>;
  /** Output locale + tone. */
  locale: RoboApplyLocale;
  /** Default 'warm_coach'. */
  tone?: 'warm_coach' | 'concise_assistant';
}

export interface RoboApplyDigestOutput {
  emailSubject: string;
  /** Markdown, ≤ 600 words. */
  emailBody: string;
  /** Markdown, ≤ 200 words — the shorter version surfaced on /mission. */
  appNarration: string;
  /** Every RoboApplyRun.id mentioned in narration; verified. */
  citedRunIds: string[];
  modelUsed: string;
  /** True iff CitationGuard found no unknown ids; false rows are still saved
   *  with the sanitized output. */
  citationGuardPassed: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────

// Default model. Used when the env override is unset. Resolved at CALL TIME
// (not module-load) so it picks up dotenv values regardless of ESM import
// order — the backend's `dotenv.config()` runs after this module is hoisted.
const MODEL_DIGEST_DEFAULT = 'openrouter/anthropic/claude-sonnet-4.6';

function digestModel(): string {
  return process.env.RA_DIGEST_MODEL?.trim() || MODEL_DIGEST_DEFAULT;
}

function clipString(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function sanitizeStringArray(value: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RoboApplyDigestAgent extends BaseAgent<
  RoboApplyDigestInput,
  RoboApplyDigestOutput
> {
  constructor() {
    super('RoboApplyDigestAgent');
  }

  protected getTemperature(): number {
    return 0.6; // Warm voice; some creative range.
  }

  protected getMaxTokens(): number | undefined {
    return 3000;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's morning briefer. Each day you write a digest for ONE candidate. The voice is warm, opinionated, and matter-of-fact. The user is the passenger; you are the agent that did the work overnight.

## Hard rules — these are absolute

1. **Strict JSON output.** No prose, no markdown around the JSON. The first character is \`{\` and the last is \`}\`.
2. **Cite every concrete run.** When you mention a queued job or a yesterday-submission, embed the run id in the narration as \`{{runId}}\`. Example: "Top of the list: Stripe Senior PM in NY {{run_abc123}}." The CitationGuard pass enforces every \`{{xxx}}\` is a real RoboApplyRun.id from the input.
3. **Name the user. Name companies. Name what was skipped *and why*.** Generic "you have 7 queued" is rejected on the rewrite pass. Specific is the only acceptable register.
4. **One email per day.** The body ends with a clear time pressure ("you've got 2 hours") AND a clear escape ("skip individual jobs from Mission Control"). Both, not one or the other.
5. **Quiet days.** If todayQueued is empty, still send the digest. Narrate the gap honestly: "I scanned 14 boards and nothing cleared your bar — your $220k floor is doing real work here." Do NOT pretend you queued something. Do NOT pad. Empty queues are a feature.
6. **First day.** When isFirstDay=true, welcome the user briefly. Mention their tier and what to expect tomorrow.
7. **No marketing voice.** No "Hope this finds you well." No "Based on my analysis." No "I trust you'll find this valuable." Speak as if you're a chief-of-staff with strong opinions about which jobs to apply to.
8. **Tone calibration.** \`warm_coach\` (default) is the production voice. \`concise_assistant\` is reserved for power users who toggled it on. If concise: cut all warmth, no humor, strict bullet form.

## Length

- \`emailBody\`: markdown, 250-500 words. The "hero" — what the user reads in their inbox.
- \`appNarration\`: markdown, 80-200 words. The shorter version that surfaces on /mission. Same facts, fewer connective tissue sentences.

## Output schema

\`\`\`
{
  "emailSubject":   "RoboApply: 7 applications going out at 9am — skip with one tap",
  "emailBody":      "<markdown>",
  "appNarration":   "<markdown — 80-200 words>",
  "citedRunIds":    ["run_abc123", "run_def456", ...]   // every {{runId}} you mentioned
}
\`\`\`

The \`emailSubject\` should be a short imperative phrase that names the queue size. Pattern: "RoboApply: N going out at 9am — skip with one tap". Quiet day: "RoboApply: quiet morning — nothing cleared your bar".

You output ONLY the JSON object.`;
  }

  protected formatInput(input: RoboApplyDigestInput): string {
    const blocks: string[] = [];
    blocks.push(`Locale: ${input.locale}`);
    blocks.push(`Tone: ${input.tone ?? 'warm_coach'}`);
    blocks.push(`First name: ${input.firstName || 'there'}`);
    blocks.push(`Tier: ${input.tier}`);
    blocks.push(`Is first day: ${input.isFirstDay}`);
    blocks.push(`## Today's queue (status=previewing)\n${JSON.stringify(input.todayQueued, null, 2).slice(0, 6_000)}`);
    blocks.push(`## Yesterday\n${JSON.stringify(input.yesterday, null, 2).slice(0, 3_000)}`);
    blocks.push(`## Market watcher\n${JSON.stringify(input.marketWatcher, null, 2)}`);
    if (input.recentSkips.length > 0) {
      blocks.push(`## Recent skips\n${JSON.stringify(input.recentSkips, null, 2).slice(0, 2_000)}`);
    }
    blocks.push(`Write the digest. Cite every concrete run as {{runId}}. Output ONLY the JSON.`);
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): RoboApplyDigestOutput {
    if (!response || typeof response !== 'string') {
      return {
        emailSubject: '',
        emailBody: '',
        appNarration: '',
        citedRunIds: [],
        modelUsed: 'none',
        citationGuardPassed: false,
      };
    }
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        emailSubject: '',
        emailBody: '',
        appNarration: '',
        citedRunIds: [],
        modelUsed: 'none',
        citationGuardPassed: false,
      };
    }
    return {
      emailSubject: clipString(parsed.emailSubject, 200),
      emailBody: clipString(parsed.emailBody, 12_000),
      appNarration: clipString(parsed.appNarration, 4_000),
      citedRunIds: sanitizeStringArray(parsed.citedRunIds, 100, 100),
      modelUsed: '', // overwritten by `compose()`
      citationGuardPassed: false, // overwritten by `compose()`
    };
  }

  /**
   * Compose the daily digest. Runs the Sonnet pass, applies CitationGuard
   * to verify every cited run id is real, sanitizes (drops sentences with
   * unknown ids), and writes the `roboapply_digest` audit row on success.
   *
   * Failure modes:
   *   - LLM error → returns a deterministic fallback narrative; no audit
   *     row written (failure is free).
   *   - CitationGuard failure → output is sanitized + persisted with
   *     `citationGuardPassed=false`. Audit row is still written (the LLM
   *     work happened; we just dropped a sentence or two). Admin analytics
   *     can spike on the CG-failure rate.
   */
  async compose(
    input: RoboApplyDigestInput,
    ctx: {
      userId: string;
      requestId?: string | null;
    },
  ): Promise<RoboApplyDigestOutput> {
    let output: RoboApplyDigestOutput;
    const model = digestModel();
    try {
      output = await this.execute(
        input,
        '',
        ctx.requestId ?? undefined,
        input.locale,
        model,
      );
    } catch (err) {
      logger.error(
        'AGENT',
        'RoboApplyDigestAgent: LLM call failed; falling back to deterministic narrative',
        {
          userId: ctx.userId,
          missionId: input.missionId,
          error: err instanceof Error ? err.message : String(err),
        },
        ctx.requestId ?? undefined,
      );
      return buildDeterministicFallback(input);
    }
    output.modelUsed = model;

    // ─ CitationGuard: drop sentences referencing unknown run ids ────────
    const knownRunIds = new Set<string>(input.todayQueued.map((r) => r.runId));
    for (const s of input.yesterday.standouts) knownRunIds.add(s.runId);
    for (const s of input.recentSkips) knownRunIds.add(s.runId);

    const sanitized = sanitizeCitations({
      emailBody: output.emailBody,
      appNarration: output.appNarration,
      citedRunIds: output.citedRunIds,
      knownRunIds,
    });
    output.emailBody = sanitized.emailBody;
    output.appNarration = sanitized.appNarration;
    output.citedRunIds = sanitized.acceptedCitedRunIds;
    output.citationGuardPassed = sanitized.passed;

    if (!sanitized.passed) {
      logger.warn(
        'AGENT',
        'RoboApplyDigestAgent: dropped citations to unknown run ids',
        {
          userId: ctx.userId,
          missionId: input.missionId,
          droppedCount: sanitized.droppedCount,
          unknownIds: sanitized.unknownIds.slice(0, 10),
        },
        ctx.requestId ?? undefined,
      );
    }

    const cost = costPatchFromTally(ctx.requestId);
    await writeDeductionLog({
      userId: ctx.userId,
      sku: 'roboapply_digest',
      source: 'plan',
      platformCostUsd: cost.platformCostUsd,
      tierAtCommit: input.tier,
      requestId: ctx.requestId ?? null,
      relatedEntityType: 'roboapply_mission',
      relatedEntityId: input.missionId,
      metadata: {
        ...cost.metadata,
        source: 'roboapply.digest',
        locale: input.locale,
        todayQueuedCount: input.todayQueued.length,
        yesterdaySubmittedCount: input.yesterday.submittedCount,
        citationGuardPassed: sanitized.passed,
        droppedCitationCount: sanitized.droppedCount,
      },
    });

    return output;
  }
}

export const roboApplyDigestAgent = new RoboApplyDigestAgent();

// ─── CitationGuard helpers ──────────────────────────────────────────────

function sanitizeCitations(args: {
  emailBody: string;
  appNarration: string;
  citedRunIds: string[];
  knownRunIds: Set<string>;
}): {
  emailBody: string;
  appNarration: string;
  acceptedCitedRunIds: string[];
  passed: boolean;
  droppedCount: number;
  unknownIds: string[];
} {
  const unknownIds = new Set<string>();
  const accepted: string[] = [];
  for (const id of args.citedRunIds) {
    if (args.knownRunIds.has(id)) {
      accepted.push(id);
    } else {
      unknownIds.add(id);
    }
  }
  // Strip {{runId}} markers — keep known ids as plain ids, remove unknowns
  // along with their surrounding sentence.
  const cleanText = (text: string): { out: string; dropped: number } => {
    const segments = text.split(/(?<=[.!?])\s+/);
    let droppedHere = 0;
    const kept: string[] = [];
    for (const seg of segments) {
      const refs = seg.match(/\{\{(run_[a-zA-Z0-9_-]+)\}\}/g) ?? [];
      const hasUnknown = refs.some((m) => {
        const id = m.slice(2, -2);
        return !args.knownRunIds.has(id);
      });
      if (hasUnknown) {
        droppedHere += 1;
        continue;
      }
      // Strip the `{{runId}}` braces so the user-facing text reads naturally.
      // Show as an opaque "run id" anchor — frontend can rewrite as a link.
      const stripped = seg.replace(/\s*\{\{(run_[a-zA-Z0-9_-]+)\}\}/g, '');
      kept.push(stripped);
    }
    return { out: kept.join(' ').trim(), dropped: droppedHere };
  };

  const bodyResult = cleanText(args.emailBody);
  const narrationResult = cleanText(args.appNarration);

  return {
    emailBody: bodyResult.out,
    appNarration: narrationResult.out,
    acceptedCitedRunIds: accepted,
    passed: unknownIds.size === 0,
    droppedCount: bodyResult.dropped + narrationResult.dropped,
    unknownIds: Array.from(unknownIds),
  };
}

function buildDeterministicFallback(input: RoboApplyDigestInput): RoboApplyDigestOutput {
  const firstName = input.firstName || 'there';
  const queuedCount = input.todayQueued.length;
  const submittedYesterday = input.yesterday.submittedCount;

  const body = queuedCount === 0
    ? `Good morning, ${firstName}.\n\nQuiet morning — nothing cleared your bar overnight. I scanned ${input.marketWatcher.boardsScanned} boards and looked at ${input.marketWatcher.jobsConsidered} roles. None made the cut.\n\nI'll keep watching. If you want me to widen the net, edit your intent.`
    : `Good morning, ${firstName}.\n\nYesterday I sent ${submittedYesterday}. Today I've queued ${queuedCount} for 9am submission.\n\n${input.todayQueued
        .slice(0, 7)
        .map((r) => `- ${r.companyName} — ${r.jobTitle} · match ${r.matchScore}`)
        .join('\n')}\n\nYou've got 2 hours. Skip individual jobs from Mission Control.`;

  const narration = queuedCount === 0
    ? `Quiet morning. Nothing cleared your bar overnight. I'll keep watching.`
    : `${queuedCount} queued for 9am. ${submittedYesterday} went out yesterday.`;

  return {
    emailSubject: queuedCount === 0
      ? 'RoboApply: quiet morning — nothing cleared your bar'
      : `RoboApply: ${queuedCount} applications going out at 9am — skip with one tap`,
    emailBody: body,
    appNarration: narration,
    citedRunIds: [],
    modelUsed: 'fallback_deterministic',
    citationGuardPassed: true,
  };
}

export const __test = {
  sanitizeCitations,
  buildDeterministicFallback,
};

export default roboApplyDigestAgent;

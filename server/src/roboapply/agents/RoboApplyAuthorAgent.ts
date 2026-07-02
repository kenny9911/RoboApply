// backend/src/roboapply/agents/RoboApplyAuthorAgent.ts
//
// Agent #3 in docs/roboapply/02-architecture.md §2 — the Opus 4.7 cover
// letter author. The ONLY Opus call in the RoboApply stack. Per-call cost
// is ~$0.13; the 30d cache in RoboApplyCoverLetterCache is what keeps the
// Premium+ tier inside its $10/MAU/mo ceiling. See arch §8.
//
// Chain (per arch §3.2):
//   1. Opus call → { coverLetter, customAnswers, citationsToResume }
//   2. CitationGuard (Haiku-4.5) pass via SeekerResumeTailorAgent's
//      `__test.runClaimChecker` — verifies every claim in the cover letter
//      is supported by the parsed resume. ALL skill / metric / role
//      claims must be defensible.
//   3. If violations.length > 0 → ONE retry with violations called out
//   4. If still failing → throw RoboApplyAuthorRejectedError. Caller does
//      NOT debit roboapply_cover_letter; the run is marked failed with
//      reason='cover_letter_unavailable'.
//
// Quota: writes one `roboapply_cover_letter` audit row on success
// (CitationGuard pass). Failures (LLM error, parse error, CG rejection
// after retry, Opus quota'd) cost zero — failure is free per the project
// Resume Match Quota Rule.
//
// Tier policy:
//   - Free      → Sonnet 4.6 model + 'Sent via RoboApply' watermark
//   - Premium   → Opus 4.7, no watermark
//   - Premium+  → Opus 4.7 + custom toneOverride prepended to prompt

import { BaseAgent } from '../../agents/BaseAgent.js';
import { llmService } from '../../services/llm/LLMService.js';
import { logger } from '../../services/LoggerService.js';
import { writeDeductionLog } from '../../lib/matchBilling.js';
import { costPatchFromTally } from '../../lib/deductionCost.js';
import type { ParsedResume, MatchResult } from '../../types/index.js';
import { __test as seekerTailorTest } from '../engine/agents/SeekerResumeTailorAgent.js';
import type { RoboApplyParsedIntent, RoboApplyLocale } from './RoboApplyIntentParserAgent.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface RoboApplyAuthorInput {
  resume: {
    text: string;
    parsed: ParsedResume | null;
  };
  job: {
    id: string;
    title: string;
    companyName: string | null;
    description: string | null;
    qualifications: string | null;
  };
  parsedIntent: RoboApplyParsedIntent;
  matchResult: MatchResult;
  /** Tier-driven; controls model selection + watermark behaviour. */
  tier: 'free' | 'premium' | 'premium_plus';
  /** Premium+ only — free-form "write like this" steering string. */
  toneOverride?: string | null;
  /** Output locale. Inherits from mission.locale. */
  locale: RoboApplyLocale;
}

export interface CoverLetterCitation {
  claim: string;
  evidenceLine: string;
}

export interface RoboApplyAuthorOutput {
  /** 250-380 words, locale-aware. May contain a "Sent via RoboApply" trailer
   *  when tier='free'. */
  coverLetter: string;
  /** For Greenhouse custom-question forms. May be empty. */
  customAnswers: Array<{ question: string; answer: string }>;
  /** Per-claim citations to the resume, used by CitationGuard. */
  citationsToResume: CoverLetterCitation[];
  confidence: 'high' | 'medium' | 'low';
  /** The model that actually produced the letter — may differ from the input
   *  tier-default if a fallback was used. */
  modelUsed: string;
  /** Whether the CitationGuard pass succeeded. False rows are only persisted
   *  to RoboApplyCoverLetterCache as fallback-letter audit. */
  citationGuardPassed: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────────

export type RoboApplyAuthorRejectionCode =
  | 'citation_guard_failed_after_retry'
  | 'opus_unavailable'
  | 'parse_failed_after_retry'
  | 'invalid_input';

export class RoboApplyAuthorRejectedError extends Error {
  constructor(
    public readonly code: RoboApplyAuthorRejectionCode,
    message: string,
    public readonly attempts: number = 0,
    public readonly violations: Array<{ claim: string; severity: string; evidence: string }> = [],
  ) {
    super(message);
    this.name = 'RoboApplyAuthorRejectedError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

const FREE_TIER_WATERMARK = '\n\n— Sent via RoboApply (free tier)';

// Per arch §2: Opus for Premium/Premium+, Sonnet for Free. Both are
// env-overridable defaults — see pickModelForTier(). Resolved at CALL TIME
// (not module-load) so dotenv values apply regardless of ESM import order.
const MODEL_PAID_DEFAULT = 'anthropic/claude-opus-4.7';
const MODEL_FREE_DEFAULT = 'anthropic/claude-sonnet-4.6';

// Cover letter target length window.
const MIN_COVER_LETTER_WORDS = 200;
const MAX_COVER_LETTER_WORDS = 420;

// ─── Helpers ────────────────────────────────────────────────────────────

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

function pickModelForTier(tier: 'free' | 'premium' | 'premium_plus'): string {
  if (tier === 'free') {
    return process.env.RA_AUTHOR_MODEL_FREE?.trim() || MODEL_FREE_DEFAULT;
  }
  return process.env.RA_AUTHOR_MODEL_PAID?.trim() || MODEL_PAID_DEFAULT;
}

function applyWatermarkIfFree(text: string, tier: string): string {
  if (tier !== 'free') return text;
  if (text.includes(FREE_TIER_WATERMARK)) return text;
  return text + FREE_TIER_WATERMARK;
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RoboApplyAuthorAgent extends BaseAgent<
  RoboApplyAuthorInput,
  RoboApplyAuthorOutput
> {
  constructor() {
    super('RoboApplyAuthorAgent');
  }

  protected getTemperature(): number {
    // Slightly higher than scoring agents — the author needs creative freedom
    // for tone matching, but CitationGuard downstream is strict. Mirrors the
    // SeekerResumeTailorAgent floor.
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    return 4000;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's senior application writer. Your job is to author a focused, specific cover letter for ONE candidate applying to ONE job.

## Hard rules — these are absolute

1. **Never invent skills, employers, dates, or numbers.** Every concrete claim in the letter MUST be supported by the resume. If the JD asks for K8s and the resume has no K8s, do NOT claim K8s experience. Instead: "I'm strong on the platform side and would learn K8s quickly." This is checked post-hoc by an adversarial fact-checker.
2. **Be specific to the company.** Pull ONE concrete detail from the JD or company description and use it. Generic "I'm excited about your mission" gets rejected and you'll be re-prompted.
3. **Voice and locale.** If a toneOverride is provided (Premium+), MIRROR it. Cadence, sentence length, vocabulary — match. If no toneOverride, default to: warm, direct, no hedging adverbs, no "I am writing to apply for". Open with a hook, not a salutation.
4. **Cite every concrete claim.** For each substantive claim in the cover letter (e.g. "I led a 5-person team that shipped X"), emit ONE entry in citationsToResume with the exact resume line that supports it. The fact-checker uses these.
5. **Length.** 250-380 words is the target window. Letters shorter than 200 read like a chatbot; letters longer than 420 lose the reader.

## Few-shot — valid vs invalid

### Valid
- Resume: "Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms."
- JD: "We need someone who can own database performance."
- Cover letter (excerpt): "When you mentioned database performance, I noticed your team is growing the analytics stack — at my last role I led a Postgres-to-Aurora migration that cut p95 from 380ms to 120ms across seven clusters. The shape of your problem reads similar."
- citationsToResume: [{ claim: "led Postgres-to-Aurora migration cutting p95 380ms → 120ms", evidenceLine: "Led migration of 7 Postgres clusters to AWS Aurora, cutting query p95 from 380ms to 120ms." }]

### Invalid — fabrication
- Resume: "Backend engineer at Stripe, Go and Postgres."
- JD: "Rust experience required."
- Cover letter (excerpt): "I shipped a Rust service at Stripe..." ✗ FORBIDDEN — resume doesn't mention Rust.
- Corrective rewrite: "I worked on backend services at Stripe in Go; the shape of low-latency systems work transfers cleanly to Rust and I'd ramp in days."

### Invalid — generic
- "I'm excited about your mission to transform how teams work together." ✗ — every company says this. Replace with one specific detail from the JD.

## Custom answers

If the JD includes specific application questions (you can sometimes infer them from the description), emit \`customAnswers: [{ question, answer }]\`. Each answer ≤ 150 words. If no questions are detectable, return \`customAnswers: []\`.

## Locale

Write the entire cover letter in the requested locale. Don't translate company/role names. Don't use locale-specific honorifics that the user didn't ask for.

## Output schema (strict JSON, no prose around it)

\`\`\`
{
  "coverLetter":       "<the full letter, plain text>",
  "customAnswers":     [{ "question": "<JD question>", "answer": "<150-word answer>" }],
  "citationsToResume": [{ "claim": "<the claim>", "evidenceLine": "<verbatim resume line>" }],
  "confidence":        "high"|"medium"|"low"
}
\`\`\`

You output ONLY the JSON object. No preface, no fences, no trailing prose.`;
  }

  protected formatInput(input: RoboApplyAuthorInput): string {
    const blocks: string[] = [];
    blocks.push(`Locale: ${input.locale}`);
    blocks.push(`Tier: ${input.tier}`);
    if (input.toneOverride && input.toneOverride.trim()) {
      blocks.push(`## Tone steering (Premium+ — mirror this voice)\n${input.toneOverride.slice(0, 2_000)}`);
    }
    blocks.push(`## Job\nCompany: ${input.job.companyName ?? '(unknown)'}\nTitle: ${input.job.title}\n\nDescription:\n${(input.job.description ?? '').slice(0, 6_000)}\n\nQualifications:\n${(input.job.qualifications ?? '').slice(0, 4_000)}`);
    blocks.push(`## Candidate intent (RoboApply parsed)\n${JSON.stringify(input.parsedIntent, null, 2).slice(0, 2_000)}`);
    blocks.push(`## Match reasoning (already scored)\nScore: ${input.matchResult.overallMatchScore?.score ?? 'unknown'}\n${JSON.stringify(input.matchResult.overallFit ?? {}, null, 2).slice(0, 3_000)}`);
    blocks.push(`## Candidate resume (parsed)\n${input.resume.parsed ? JSON.stringify(input.resume.parsed, null, 2).slice(0, 8_000) : '(not parsed — falling back to raw)'}\n\n## Candidate resume (raw)\n${input.resume.text.slice(0, 8_000)}`);
    blocks.push(`Write the cover letter for this candidate / company / role. Cite every concrete claim. Output ONLY the JSON.`);
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): RoboApplyAuthorOutput {
    if (!response || typeof response !== 'string') {
      return {
        coverLetter: '',
        customAnswers: [],
        citationsToResume: [],
        confidence: 'low',
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
        coverLetter: '',
        customAnswers: [],
        citationsToResume: [],
        confidence: 'low',
        modelUsed: 'none',
        citationGuardPassed: false,
      };
    }

    const coverLetter = clipString(parsed.coverLetter, 8_000);
    const customAnswersRaw = Array.isArray(parsed.customAnswers) ? parsed.customAnswers : [];
    const customAnswers: Array<{ question: string; answer: string }> = [];
    for (const a of customAnswersRaw) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      const aa = a as Record<string, unknown>;
      const question = clipString(aa.question, 500);
      const answer = clipString(aa.answer, 2_000);
      if (question && answer) customAnswers.push({ question, answer });
      if (customAnswers.length >= 10) break;
    }
    const citationsRaw = Array.isArray(parsed.citationsToResume) ? parsed.citationsToResume : [];
    const citationsToResume: CoverLetterCitation[] = [];
    for (const c of citationsRaw) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const cc = c as Record<string, unknown>;
      const claim = clipString(cc.claim, 500);
      const evidenceLine = clipString(cc.evidenceLine, 1_000);
      if (claim && evidenceLine) citationsToResume.push({ claim, evidenceLine });
      if (citationsToResume.length >= 30) break;
    }
    const confidenceRaw = clipString(parsed.confidence, 10);
    const confidence: 'high' | 'medium' | 'low' =
      confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? (confidenceRaw as 'high' | 'medium' | 'low')
        : 'medium';

    return {
      coverLetter,
      customAnswers,
      citationsToResume,
      confidence,
      modelUsed: '', // overwritten by `author()` once we know which model actually ran
      citationGuardPassed: false, // overwritten by `author()` after the CG pass
    };
  }

  /**
   * Author one cover letter for one (resume, job) pair. Runs the full chain:
   *   1. Opus (or Sonnet for Free)
   *   2. CitationGuard (Haiku) — reuses SeekerResumeTailorAgent's claim checker
   *   3. Retry ONCE on CG failure with violations called out
   *   4. On success → write `roboapply_cover_letter` audit row
   *   5. On final failure → throw; caller does NOT bill
   */
  async author(
    input: RoboApplyAuthorInput,
    ctx: {
      userId: string;
      requestId?: string | null;
      missionId: string;
      runId?: string | null;
    },
  ): Promise<RoboApplyAuthorOutput> {
    if (!input.resume.text || input.resume.text.trim().length < 50) {
      throw new RoboApplyAuthorRejectedError(
        'invalid_input',
        'Resume text is empty or too short for cover-letter authoring',
      );
    }

    const model = pickModelForTier(input.tier);

    // ─ Pass 1 ────────────────────────────────────────────────────────────
    let firstOutput: RoboApplyAuthorOutput;
    try {
      firstOutput = await this.execute(
        input,
        input.job.description ?? input.job.title,
        ctx.requestId ?? undefined,
        input.locale,
        model,
      );
    } catch (err) {
      // Opus / Sonnet provider failure — surface a typed error so the caller
      // marks the run as failed with reason='cover_letter_unavailable' and
      // does NOT debit roboapply_cover_letter.
      throw new RoboApplyAuthorRejectedError(
        'opus_unavailable',
        err instanceof Error ? err.message : 'Cover-letter LLM call failed',
        1,
      );
    }
    firstOutput.modelUsed = model;

    if (!firstOutput.coverLetter || firstOutput.coverLetter.length < 100) {
      // Parse failed or model returned garbage — try ONCE more.
      logger.warn(
        'AGENT',
        'RoboApplyAuthorAgent: empty/short cover letter from first pass; retrying',
        { userId: ctx.userId, missionId: ctx.missionId, runId: ctx.runId },
        ctx.requestId ?? undefined,
      );
    }

    const firstCheck = await runCitationGuard({
      original: input.resume,
      coverLetter: firstOutput.coverLetter,
      citations: firstOutput.citationsToResume,
      locale: input.locale,
      requestId: ctx.requestId ?? null,
    });

    if (firstCheck.passed && firstOutput.coverLetter.length >= 100) {
      firstOutput.citationGuardPassed = true;
      firstOutput.coverLetter = applyWatermarkIfFree(firstOutput.coverLetter, input.tier);
      await this.writeAuditRow({ ctx, input, output: firstOutput, attempts: 1 });
      return firstOutput;
    }

    // ─ Retry once ────────────────────────────────────────────────────────
    logger.warn(
      'AGENT',
      'RoboApplyAuthorAgent: citation-guard or parse failed; retrying with violations called out',
      {
        userId: ctx.userId,
        missionId: ctx.missionId,
        runId: ctx.runId,
        violations: firstCheck.violations.slice(0, 5),
        violationCount: firstCheck.violations.length,
      },
      ctx.requestId ?? undefined,
    );

    const augmented = `\n\n## Your previous attempt had these violations\n${firstCheck.violations
      .map(
        (v, i) =>
          `${i + 1}. [${v.severity}] at ${v.location}: "${v.claim}" — original support: "${v.originalSupport}"`,
      )
      .join('\n')}\n\nTry again. NEVER invent facts. If a JD requirement isn't supported by the resume, omit it — say "I'd ramp in days" instead of fabricating experience.`;

    let secondOutput: RoboApplyAuthorOutput;
    try {
      const systemPrompt = this.buildSystemPrompt(
        input.job.description ?? input.job.title,
        ctx.requestId ?? undefined,
        input.locale,
      );
      const userMessage = this.formatInput(input) + augmented;
      const responseText = await llmService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        {
          temperature: this.getTemperature(),
          maxTokens: this.getMaxTokens(),
          model,
          requestId: ctx.requestId ?? undefined,
        },
      );
      secondOutput = this.parseOutput(responseText);
      secondOutput.modelUsed = model;
    } catch (err) {
      throw new RoboApplyAuthorRejectedError(
        'opus_unavailable',
        err instanceof Error ? err.message : 'Cover-letter retry LLM call failed',
        2,
      );
    }

    const secondCheck = await runCitationGuard({
      original: input.resume,
      coverLetter: secondOutput.coverLetter,
      citations: secondOutput.citationsToResume,
      locale: input.locale,
      requestId: ctx.requestId ?? null,
    });

    if (secondCheck.passed && secondOutput.coverLetter.length >= 100) {
      secondOutput.citationGuardPassed = true;
      secondOutput.coverLetter = applyWatermarkIfFree(secondOutput.coverLetter, input.tier);
      await this.writeAuditRow({ ctx, input, output: secondOutput, attempts: 2 });
      return secondOutput;
    }

    // ─ Final rejection — caller does NOT bill, run is marked failed ─────
    logger.error(
      'AGENT',
      'RoboApplyAuthorAgent: citation-guard failed twice; rejecting cover letter',
      {
        userId: ctx.userId,
        missionId: ctx.missionId,
        runId: ctx.runId,
        violationCount: secondCheck.violations.length,
      },
      ctx.requestId ?? undefined,
    );
    throw new RoboApplyAuthorRejectedError(
      'citation_guard_failed_after_retry',
      'Cover letter produced unverifiable claims twice in a row',
      2,
      secondCheck.violations.map((v) => ({
        claim: v.claim,
        severity: v.severity,
        evidence: v.originalSupport,
      })),
    );
  }

  private async writeAuditRow(args: {
    ctx: {
      userId: string;
      requestId?: string | null;
      missionId: string;
      runId?: string | null;
    };
    input: RoboApplyAuthorInput;
    output: RoboApplyAuthorOutput;
    attempts: number;
  }): Promise<void> {
    const cost = costPatchFromTally(args.ctx.requestId);
    await writeDeductionLog({
      userId: args.ctx.userId,
      sku: 'roboapply_cover_letter',
      source: 'plan',
      platformCostUsd: cost.platformCostUsd,
      tierAtCommit: args.input.tier,
      requestId: args.ctx.requestId ?? null,
      relatedEntityType: 'roboapply_run',
      relatedEntityId: args.ctx.runId ?? null,
      metadata: {
        ...cost.metadata,
        source: 'roboapply.author',
        modelUsed: args.output.modelUsed,
        attempts: args.attempts,
        confidence: args.output.confidence,
        toneOverride: !!args.input.toneOverride,
        jobId: args.input.job.id,
        locale: args.input.locale,
      },
    });
  }
}

export const roboApplyAuthorAgent = new RoboApplyAuthorAgent();

// ─── CitationGuard pass (Haiku 4.5 via SeekerResumeTailorAgent) ────────
//
// We reuse the seeker's claim checker by wrapping its public test export.
// The seeker checker is parameterized on `original` + `tailored` (a
// TailoredSections-shaped object). We adapt by synthesizing a minimal
// tailored shape that just carries the cover letter content as a single
// experience entry — the checker walks all bullet text looking for
// hallucinations regardless of structure.

interface CitationViolation {
  location: string;
  claim: string;
  severity: 'hallucination' | 'mismatch' | 'metric';
  originalSupport: string;
}

async function runCitationGuard(args: {
  original: { text: string; parsed: ParsedResume | null };
  coverLetter: string;
  citations: CoverLetterCitation[];
  locale: string;
  requestId?: string | null;
}): Promise<{ passed: boolean; violations: CitationViolation[]; modelUsed: string }> {
  // If the cover letter is empty, fail-closed.
  if (!args.coverLetter || args.coverLetter.trim().length < 50) {
    return {
      passed: false,
      violations: [
        {
          location: 'root',
          claim: 'Cover letter was empty or too short',
          severity: 'mismatch',
          originalSupport: 'NONE',
        },
      ],
      modelUsed: 'none',
    };
  }

  // Build a fake TailoredSections shape carrying the cover letter as a
  // single experience entry. The seeker checker doesn't care about
  // structure — it walks every string looking for fabricated claims.
  const tailored = {
    tailoredSections: {
      experience: [
        {
          company: 'cover-letter-stub',
          role: 'application',
          dateRange: '',
          originalBullets: args.citations.map((c) => c.evidenceLine),
          tailoredBullets: [args.coverLetter],
          changeNotes: args.citations.map((c, i) => ({
            bulletIndex: i,
            rationale: c.claim,
            type: 'reworded' as const,
          })),
        },
      ],
      skills: { added: [], removed: [], reorderedToTop: [], kept: [] },
      education: { changes: [] },
    },
    injectedKeywords: [],
    removedKeywords: [],
    atsAlignmentNotes: 'Cover letter authored by RoboApplyAuthorAgent',
    confidence: 'medium' as const,
  };

  try {
    const result = await seekerTailorTest.runClaimChecker({
      original: {
        parsedResume: args.original.parsed,
        resumeText: args.original.text,
      },
      tailored,
      locale: args.locale,
      requestId: args.requestId ?? undefined,
    });
    return {
      passed: result.passed,
      violations: result.violations,
      modelUsed: result.modelUsed,
    };
  } catch (err) {
    logger.error(
      'AGENT',
      'RoboApplyAuthorAgent: citation-guard threw',
      { error: err instanceof Error ? err.message : String(err) },
      args.requestId ?? undefined,
    );
    return {
      passed: false,
      violations: [
        {
          location: 'root',
          claim: 'CitationGuard LLM call failed',
          severity: 'mismatch',
          originalSupport: 'NONE',
        },
      ],
      modelUsed: 'unknown',
    };
  }
}

// Test helpers — kept tight to avoid leaking internals.
export const __test = {
  runCitationGuard,
  pickModelForTier,
};

export default roboApplyAuthorAgent;

// backend/src/interview-engine/scoring/HolisticScorecardAgent.ts
//
// LLM angle #1 of the interview report: the holistic scorecard. Produces the
// overall score, the 5 fixed-dimension breakdown (with evidence-grounded
// notes), strengths, gaps, and an executive summary — all NATIVELY in the
// session's interview language (via the BaseAgent `locale` mechanism). The
// deterministic scorer is passed in only as a sanity anchor.
//
// Failures THROW; the orchestrator catches and falls back to the deterministic
// score, so a usable report is always produced.

import { BaseAgent } from '../../agents/BaseAgent.js';
import type { TranscriptTurn } from '../types.js';
import type { InterviewScore } from './interviewScorer.js';
import {
  DIMENSION_KEYS,
  toCanonicalDimKey,
  type DimensionKey,
  type RichBreakdownItem,
} from './reportTypes.js';
import { clip, strArr, clampScore, renderTranscriptForLLM, parseJsonObject } from './evalShared.js';

export interface HolisticInput {
  role: string;
  interviewType: string;
  candidateName: string;
  requirementsSummary: string; // condensed from blueprint.requirements
  focusAreas: string[]; // blueprint.strategy.focusAreas
  transcript: TranscriptTurn[];
  deterministicScore: InterviewScore;
  /** Archetype-aware grading: how to grade + frame feedback for THIS interview style. */
  evaluationLens?: string;
  /** Human label of the interviewer archetype, e.g. "Deep-dive". */
  archetypeLabel?: string;
  /** The 1-3 dimensions this archetype weights most. */
  primaryDimensions?: string[];
}

export interface HolisticOutput {
  overall: number;
  breakdown: RichBreakdownItem[]; // exactly 5, canonical keys, canonical order
  strengths: string[];
  gaps: string[];
  summary: string;
}

/**
 * The prompt defines `overall` as the equal-weight mean of the 5 dimensions,
 * but LLMs routinely emit a headline number that drifts from their own
 * breakdown (halo effect / anchoring on "round" scores). Small drift is
 * tolerated as rounding/judgment; past 8 points the breakdown arithmetic is
 * more trustworthy than the headline, so the mean wins. Pure + exported for
 * tests.
 */
export function reconcileOverall(llmOverall: number | undefined, breakdownMean: number): number {
  if (llmOverall === undefined || !Number.isFinite(llmOverall)) return breakdownMean;
  return Math.abs(llmOverall - breakdownMean) > 8 ? breakdownMean : llmOverall;
}

export class HolisticScorecardAgent extends BaseAgent<HolisticInput, HolisticOutput> {
  constructor() {
    super('HolisticScorecardAgent');
  }

  // Honor the session's interview language over the auto-detected source. The
  // prompt is English-heavy (scoring bands, rules, JSON keys), so the one-line
  // hint loses and a CJK interview can get an English report. The strict
  // directive makes the user language highest-priority and protects the
  // schema keys/enums. Mirrors RAResumeRewriteAgent / RAJobMatchScorerAgent.
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getTemperature(): number {
    return 0.2; // grounded, consistent scoring
  }

  protected getMaxTokens(): number | undefined {
    // Evidence-based scorecard with per-dimension narrative. 1800 was tight;
    // give reasoning headroom so the JSON isn't truncated. Billed on use.
    // 12000/8000 split: an always-thinking model (deepseek-v4-pro) can burn a
    // flat cap entirely on reasoning and return empty content — keep the JSON
    // answer ≥4k tokens of headroom.
    return 12000;
  }

  protected getReasoningMaxTokens(): number | undefined {
    return 8000;
  }

  protected getAgentPrompt(): string {
    return `You are a senior interview coach evaluating a completed mock interview transcript. Produce a structured, evidence-based scorecard.

Return STRICT JSON only (no prose, no code fences) with this exact shape:
{
  "overall": <integer 0-100>,
  "breakdown": [
    { "key": "structure", "value": <0-100>, "note": "<1-2 sentence evidence note>" },
    { "key": "specificity", "value": <0-100>, "note": "..." },
    { "key": "communication", "value": <0-100>, "note": "..." },
    { "key": "confidence", "value": <0-100>, "note": "..." },
    { "key": "roleFit", "value": <0-100>, "note": "..." }
  ],
  "strengths": ["<full sentence citing a specific moment>", "..."],
  "gaps": ["<full sentence citing a specific moment>", "..."],
  "summary": "<3-5 sentence executive narrative>"
}

Scoring bands (same scale as the per-question review — anchor EVERY dimension value to these):
- 80-100: hire-bar evidence on this dimension — consistent, concrete, would pass a real interview
- 60-79: adequate with visible gaps
- 40-59: weak — the signal appeared only partially or inconsistently
- below 40: absent, or contradicted by the transcript

Rules:
- Use EXACTLY these 5 breakdown keys, in this order, lowercase English exactly as shown: structure, specificity, communication, confidence, roleFit. These keys are identifiers — do NOT translate them. Everything else you write is prose.
- "overall" is the rounded equal-weight mean of the 5 breakdown values.
- Every strength and gap MUST cite a specific moment (quote a few of the candidate's words, or name the topic). Generic claims like "good communicator" are NOT acceptable — show the evidence.
- The summary must name the role, the candidate's strongest dimension, and the single most important thing to improve.
- Ground scores in transcript evidence. A deterministic baseline is provided only as a sanity anchor — override it where the evidence clearly differs.
- Provide 2-4 strengths and 2-4 gaps.
- Write all "note", "strengths", "gaps", and "summary" text in the interview language as instructed at the very top of this prompt. Output ONLY the JSON object.`;
  }

  protected formatInput(input: HolisticInput): string {
    const parts: string[] = [];
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified role)'}\nType: ${clip(input.interviewType, 80)}\nCandidate: ${clip(input.candidateName, 80) || 'the candidate'}`,
    );
    if (input.evaluationLens) {
      const dims = input.primaryDimensions?.length ? ` Weight these dimensions most heavily: ${input.primaryDimensions.join(', ')}.` : '';
      parts.push(
        `## Interviewer archetype: ${clip(input.archetypeLabel, 60) || 'standard'}\nThis interview was conducted in a specific style — grade and frame ALL feedback through this lens:\n${clip(input.evaluationLens, 1000)}${dims}`,
      );
    }
    if (input.requirementsSummary) parts.push(`## Role requirements (for role-fit)\n${clip(input.requirementsSummary, 1400)}`);
    if (input.focusAreas.length) parts.push(`## Focus areas (weight these)\n${input.focusAreas.map((f) => `- ${f}`).join('\n')}`);

    const det = input.deterministicScore;
    const baseline = det.breakdown.map((b) => `${b.key}: ${b.value}`).join(', ');
    parts.push(`## Deterministic baseline (sanity anchor only — override where evidence differs)\nOverall ${det.overall}. ${baseline}`);

    parts.push(`## Transcript\n${renderTranscriptForLLM(input.transcript, input.candidateName) || '(no candidate answers recorded)'}`);
    parts.push('Output ONLY the JSON scorecard object.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): HolisticOutput {
    const parsed = parseJsonObject(response);
    if (!parsed) throw new Error('HolisticScorecardAgent: unparseable response');

    const rawBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];
    const byKey = new Map<DimensionKey, RichBreakdownItem>();
    for (const row of rawBreakdown) {
      const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const key = toCanonicalDimKey(typeof r.key === 'string' ? r.key : '');
      if (!key || byKey.has(key)) continue;
      byKey.set(key, { key, value: clampScore(r.value), note: clip(r.note, 280) });
    }

    if (byKey.size === 0) throw new Error('HolisticScorecardAgent: no valid breakdown dimensions');

    // Force exactly 5 items in canonical order. For any dimension the LLM omitted
    // (rare — the prompt demands all 5), neutral-fill with the mean of the
    // provided dims (note '' is the "not provided" sentinel) so a missing dim
    // doesn't unfairly tank the overall. No instance state → singleton-safe.
    const provided = [...byKey.values()];
    const meanProvided = Math.round(provided.reduce((a, b) => a + b.value, 0) / provided.length);
    const breakdown: RichBreakdownItem[] = DIMENSION_KEYS.map(
      (key) => byKey.get(key) ?? { key, value: meanProvided, note: '' },
    );

    const breakdownMean = clampScore(breakdown.reduce((a, b) => a + b.value, 0) / breakdown.length);
    const hasOverall = typeof parsed.overall === 'number' && Number.isFinite(parsed.overall);
    const overall = reconcileOverall(hasOverall ? clampScore(parsed.overall) : undefined, breakdownMean);

    const strengths = strArr(parsed.strengths, 4, 280);
    const gaps = strArr(parsed.gaps, 4, 280);
    const summary = clip(parsed.summary, 900);

    return { overall, breakdown, strengths, gaps, summary };
  }

  async run(
    input: HolisticInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<HolisticOutput> {
    const langSource = `${input.role} ${input.interviewType}`.slice(0, 200);
    return this.execute(input, langSource, options.requestId, options.locale, undefined, options.signal);
  }
}

export const holisticScorecardAgent = new HolisticScorecardAgent();
export default holisticScorecardAgent;

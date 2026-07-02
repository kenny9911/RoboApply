// backend/src/interview-engine/scoring/RecommendationsAgent.ts
//
// LLM angle #3 of the interview report: the concrete action plan. Runs AFTER
// the holistic scorecard + per-question deep dive so it can target the real
// weak/missed moments. Each recommendation is forced to be SPECIFIC and
// CONCRETE (the user's ask): it must cite a real moment, give a before → after
// rewrite using the candidate's own words, and name a doable drill. All prose
// is NATIVE in the session's interview language (BaseAgent locale).
//
// The rendered transcript is part of the input: the "before" side of every
// example must be quotable from it. Without the transcript the model had no
// choice but to fabricate the candidate's "actual words".
//
// An unparseable response THROWS (the orchestrator catches and records the
// section as failed) — silently returning [] here made an agent failure
// indistinguishable from "nothing to recommend", and the UI rendered praise.

import { BaseAgent } from '../../agents/BaseAgent.js';
import {
  toCanonicalDimKey,
  type Recommendation,
  type RecommendationPriority,
  type RichBreakdownItem,
  type QuestionAnalysisItem,
} from './reportTypes.js';
import { clip, parseJsonObject } from './evalShared.js';

export interface RecommendationsInput {
  role: string;
  interviewType: string;
  candidateName: string;
  overall: number;
  gaps: string[]; // from Holistic
  weakOrMissed: QuestionAnalysisItem[]; // DeepDive items with score<60 OR missed
  breakdown: RichBreakdownItem[]; // for linkedDimension grounding
  /** Archetype lens — tailor the action plan to what THIS interview tested. */
  evaluationLens?: string;
  archetypeLabel?: string;
  /** renderTranscriptForLLM output — the ONLY legitimate source of "before" quotes. */
  transcriptRendered?: string;
}

export type RecommendationsOutput = Recommendation[];

const PRIORITIES: readonly RecommendationPriority[] = ['high', 'medium', 'low'];
const PRIORITY_ORDER: Record<RecommendationPriority, number> = { high: 0, medium: 1, low: 2 };
const MAX_ITEMS = 5;

export class RecommendationsAgent extends BaseAgent<RecommendationsInput, RecommendationsOutput> {
  constructor() {
    super('RecommendationsAgent');
  }

  // Strict output-language directive so the recommendations come back in the
  // session language, not the prompt's English. Mirrors RAResumeRewriteAgent.
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    // Personalized multi-section action plan. 2200 was tight; give reasoning
    // headroom so the JSON isn't truncated. Billed on actual usage.
    return 6000;
  }

  protected getAgentPrompt(): string {
    return `You are a senior interview coach writing a concrete, personalized action plan after a mock interview. You have the overall score, the identified gaps, the dimension scores, and the specific questions the candidate struggled with.

Return STRICT JSON only (no prose, no code fences) with this exact shape:
{
  "recommendations": [
    {
      "title": "<short imperative, 4-8 words>",
      "priority": "high" | "medium" | "low",
      "detail": "<2-4 sentences citing a SPECIFIC moment from this interview and why it fell short for THIS role>",
      "example": "<a before → after rewrite. The 'before' reuses the candidate's actual phrasing; the 'after' is a model answer with at least one concrete number, name, or timeline. Label the two sides clearly in the interview language>",
      "drill": "<one specific practice exercise: name the format, the count, and a time constraint>",
      "linkedDimension": "structure" | "specificity" | "communication" | "confidence" | "roleFit"
    }
  ]
}

Hard rules — every recommendation must pass ALL of them or be rewritten:
1. "detail" cites a real moment (quote or paraphrase the candidate). It must NOT read as advice that could apply to any candidate.
2. "example" before-side must be a VERBATIM quote from the transcript provided in the input — copy the candidate's words exactly, do not invent or embellish them. If no verbatim quote fits the gap, write the before-side as a paraphrase explicitly labeled as such in the interview language (e.g. "(paraphrased)") — never present invented words as a quote. The after-side contains at least one concrete number, name, or timeline.
3. "drill" specifies format + count + duration. Banned: "practice more", "be more specific", "work on confidence", "improve structure".
4. Produce 3-5 items, ordered high → medium → low. If overall >= 85 still surface at least 2 medium/low polish items; if overall < 50 keep all items high or medium.
5. "linkedDimension" must be one of the 5 identifiers exactly as shown (do NOT translate the identifier). "title"/"detail"/"example"/"drill" are prose.

Write all prose in the interview language as instructed at the very top of this prompt. Output ONLY the JSON object. Omit "drill" only if genuinely no drill fits.`;
  }

  protected formatInput(input: RecommendationsInput): string {
    const parts: string[] = [];
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified role)'}\nType: ${clip(input.interviewType, 80)}\nCandidate: ${clip(input.candidateName, 80) || 'the candidate'}\nOverall score: ${input.overall}`,
    );
    if (input.evaluationLens) {
      parts.push(
        `## Interviewer archetype: ${clip(input.archetypeLabel, 60) || 'standard'}\nThis interview tested a specific dimension — make the action plan target exactly what THIS interviewer rewards and penalizes:\n${clip(input.evaluationLens, 1000)}`,
      );
    }

    if (input.breakdown.length) {
      parts.push(`## Dimension scores (for linkedDimension)\n${input.breakdown.map((b) => `- ${b.key}: ${b.value}`).join('\n')}`);
    }
    if (input.gaps.length) {
      parts.push(`## Identified gaps\n${input.gaps.map((g) => `- ${g}`).join('\n')}`);
    }

    if (input.weakOrMissed.length) {
      const probs = input.weakOrMissed
        .slice(0, 8)
        .map((q) => {
          const bits = [`- (${q.rating}, ${q.score}) ${clip(q.question, 240)}`];
          if (q.answerSummary) bits.push(`    candidate said: ${clip(q.answerSummary, 280)}`);
          if (q.correction) bits.push(`    gap: ${clip(q.correction, 280)}`);
          return bits.join('\n');
        })
        .join('\n');
      parts.push(`## Questions the candidate struggled with (ground recommendations on these)\n${probs}`);
    }

    if (input.transcriptRendered?.trim()) {
      parts.push(`## Transcript (the ONLY source for verbatim "before" quotes)\n${input.transcriptRendered.trim()}`);
    }

    parts.push('Output ONLY the JSON object with the recommendations array.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RecommendationsOutput {
    const parsed = parseJsonObject(response);
    if (!parsed) throw new Error('RecommendationsAgent: unparseable response');
    const raw = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

    const out: Recommendation[] = [];
    for (const row of raw) {
      const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const title = clip(r.title, 120);
      const detail = clip(r.detail, 600);
      const example = clip(r.example, 800);
      if (!title || !detail || !example) continue;

      const priority: RecommendationPriority = PRIORITIES.includes(r.priority as RecommendationPriority)
        ? (r.priority as RecommendationPriority)
        : 'medium';
      const drill = clip(r.drill, 400);
      const linkedDimension = toCanonicalDimKey(typeof r.linkedDimension === 'string' ? r.linkedDimension : '');

      out.push({
        title,
        priority,
        detail,
        example,
        ...(drill ? { drill } : {}),
        ...(linkedDimension ? { linkedDimension } : {}),
      });
      if (out.length >= MAX_ITEMS) break;
    }

    // Stable re-sort high → medium → low (preserve the model's intra-band order).
    return out
      .map((rec, i) => ({ rec, i }))
      .sort((a, b) => PRIORITY_ORDER[a.rec.priority] - PRIORITY_ORDER[b.rec.priority] || a.i - b.i)
      .map((x) => x.rec);
  }

  async run(
    input: RecommendationsInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RecommendationsOutput> {
    const langSource = `${input.role} ${input.interviewType}`.slice(0, 200);
    return this.execute(input, langSource, options.requestId, options.locale, undefined, options.signal);
  }
}

export const recommendationsAgent = new RecommendationsAgent();
export default recommendationsAgent;

// backend/src/interview-engine/scoring/QuestionDeepDiveAgent.ts
//
// LLM angle #2 of the interview report: the per-question deep dive — the new
// section the user asked for. For each planned blueprint question (plus any
// off-script questions the interviewer improvised), it aligns the candidate's
// answer in the transcript and produces:
//   intent            — WHY the interviewer asked this (what signal they probe)
//   analysis  (分析) — what the answer demonstrated vs. the ideal signal
//   correction(纠正) — the specific gap or error
//   suggestion(建议) — concrete, forward-looking advice
//   modelAnswer       — a reference answer grounded in THIS candidate's context
//   tips              — sharp, tactical professional/technical pointers
// All prose is NATIVE in the session's interview language (BaseAgent locale).
//
// An unparseable response THROWS (the orchestrator catches and records the
// section as failed) — silently returning [] here made an agent failure
// indistinguishable from "no questions to flag", and the UI rendered praise.

import { BaseAgent } from '../../agents/BaseAgent.js';
import type { TranscriptTurn } from '../types.js';
import type { BlueprintQuestion } from '../prompt/InterviewBlueprintAgent.js';
import type { QuestionAnalysisItem, QuestionRating } from './reportTypes.js';
import { clip, strArr, clampScore, renderTranscriptForLLM, parseJsonArray, TRANSCRIPT_TRUNCATION_MARKER } from './evalShared.js';

export interface DeepDiveInput {
  role: string;
  interviewType: string;
  candidateName: string;
  blueprintQuestions: BlueprintQuestion[];
  transcript: TranscriptTurn[];
  /** Archetype grading lens — frame each question's analysis through this style. */
  evaluationLens?: string;
  archetypeLabel?: string;
}

export type DeepDiveOutput = QuestionAnalysisItem[];

const RATINGS: readonly QuestionRating[] = ['strong', 'adequate', 'weak', 'missed'];
const MAX_ITEMS = 12;

function ratingFromScore(score: number, missed: boolean): QuestionRating {
  if (missed) return 'missed';
  if (score >= 80) return 'strong';
  if (score >= 60) return 'adequate';
  if (score >= 40) return 'weak';
  return 'missed';
}

function scoreFromRating(rating: QuestionRating): number {
  switch (rating) {
    case 'strong': return 85;
    case 'adequate': return 65;
    case 'weak': return 35;
    default: return 0;
  }
}

export class QuestionDeepDiveAgent extends BaseAgent<DeepDiveInput, DeepDiveOutput> {
  constructor() {
    super('QuestionDeepDiveAgent');
  }

  // Strict output-language directive so the per-question analysis/correction/
  // advice come back in the session language, not the prompt's English.
  // Mirrors RAResumeRewriteAgent / RAJobMatchScorerAgent.
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getTemperature(): number {
    return 0.3;
  }

  protected getMaxTokens(): number | undefined {
    // One coaching analysis per planned question (often 8-12 items, each with
    // multiple prose fields — now also `intent` + a `tips` list, which grew the
    // per-item payload). 4000 truncated the JSON array on longer interviews —
    // worse on reasoning models — so headroom matters: a truncated array fails
    // to parse and the whole section degrades. Billed on actual usage.
    return 18000;
  }

  protected getReasoningMaxTokens(): number | undefined {
    // The default model is always-thinking (over OpenRouter, reasoning tokens
    // count toward getMaxTokens). Without a cap, reasoning can consume the whole
    // budget and the JSON array truncates → parseOutput throws → the section
    // degrades to "unavailable". Cap reasoning so the enlarged intent+tips array
    // keeps ≥12k tokens of guaranteed answer headroom. Mirrors HolisticScorecardAgent.
    return 6000;
  }

  protected getAgentPrompt(): string {
    return `You are an expert interview coach reviewing a mock interview against its planned blueprint. For each planned question, find the candidate's answer in the transcript, then give a rigorous, candidate-grounded coaching analysis. Never give generic advice.

Return STRICT JSON only (no prose, no code fences) — a single JSON array:
[
  {
    "blueprintIndex": <integer 0-based, or null for an off-script question the interviewer improvised>,
    "missed": <true if this planned question was never asked or answered, else false>,
    "question": "<the question as actually asked; for a missed item, the planned question text>",
    "intent": "<why THIS interviewer asked this — the competency/signal they were probing for, in plain candidate-facing language so the candidate understands the purpose. Ground it in the provided intent/idealSignal when available; infer it for off-script questions. Never reveal the interviewer's follow-up traps.>",
    "answerSummary": "<1-3 sentences summarizing what the candidate actually said; empty string if missed>",
    "keyQuote": "<a short verbatim candidate quote, or omit the field>",
    "analysis": "<what the answer demonstrated vs. the question's ideal signal, citing the candidate's actual words>",
    "correction": "<the specific gap or error; empty string ONLY if the answer was strong>",
    "suggestion": "<concrete, forward-looking advice for next time>",
    "modelAnswer": "<what a strong answer would contain, grounded in THIS candidate's context — a guideline, not a script to memorize>",
    "tips": ["<2-4 sharp, tactical pointers the candidate can act on — the professional/technical specifics: name the exact pattern/term/tool, the metric to cite, the framework to structure with. Each a short imperative phrase.>", "..."],
    "rating": "strong" | "adequate" | "weak" | "missed",
    "score": <integer 0-100>,
    "tags": ["<short signal, e.g. 'no metric'>", "..."]
  }
]

Alignment rules:
- Match transcript segments to blueprint questions by semantic intent, not keywords. An interviewer follow-up probe ("And the result?") belongs to the SAME question block as its parent question.
- A question the interviewer improvised that is not in the blueprint → blueprintIndex: null, missed: false.
- A planned question never reached → one item with missed: true, rating: "missed", score: 0, empty answerSummary; analysis/correction/suggestion/modelAnswer describe what a strong answer WOULD need so the candidate can practice it.
- If the transcript ends with "${TRANSCRIPT_TRUNCATION_MARKER}", the interview continued beyond the visible text: do NOT mark the remaining blueprint questions as missed — omit them entirely. Only grade what you can see.

Anti-genericness rules (every item must obey):
- "intent" explains the interviewer's purpose in one sentence the candidate can learn from, e.g.: "They're testing whether you can weigh trade-offs under real constraints, not just recall a definition." Never restate the question; never say "to assess your skills".
- "correction" names the missing element concretely. Banned phrasings: "too vague", "be more specific", "needs more detail". Required style, e.g.: "You said 'we improved performance' but gave no baseline, no metric, and never said what YOU did versus the team."
- "suggestion" is actionable, e.g.: "Re-answer in 90 seconds naming one metric (before → after) and one tool you personally used."
- "modelAnswer" reuses the candidate's real context (their named project / tool / domain), not a placeholder.
- "tips" are the sharpest professional/technical specifics — the exact term of art, pattern name, metric, or framework the candidate should have reached for. e.g. for a systems answer: "Say 'idempotent consumer' and mention the dedup key"; "Anchor scale with a real QPS/latency number"; "Structure with STAR so the Result is explicit." Return [] only for a flawless answer with nothing to add.

Scoring bands: 80-100 strong, 60-79 adequate, 40-59 weak, 0-39 missed or fundamentally wrong. "rating" must match the band ("missed" only when the question was not asked/answered).
Cover every blueprint question. Cap total items at 12; if more than 10 were planned, prioritize the ones actually asked plus the 2-3 most important missed ones.
Write all human-facing text in the interview language as instructed at the very top of this prompt. Output ONLY the JSON array.`;
  }

  protected formatInput(input: DeepDiveInput): string {
    const parts: string[] = [];
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified role)'}\nType: ${clip(input.interviewType, 80)}\nCandidate: ${clip(input.candidateName, 80) || 'the candidate'}`,
    );
    if (input.evaluationLens) {
      parts.push(
        `## Interviewer archetype: ${clip(input.archetypeLabel, 60) || 'standard'}\nJudge each answer through this interviewer's lens — what THIS interviewer was probing for and rewards:\n${clip(input.evaluationLens, 2400)}`,
      );
    }

    if (input.blueprintQuestions.length) {
      const planned = input.blueprintQuestions
        .slice(0, MAX_ITEMS)
        .map((q, i) => {
          const bits = [`[${i}] ${clip(q.q, 400)}`];
          if (q.intent) bits.push(`    intent: ${clip(q.intent, 200)}`);
          if (q.idealSignal) bits.push(`    idealSignal: ${clip(q.idealSignal, 200)}`);
          if (q.probeIfWeak) bits.push(`    probeIfWeak: ${clip(q.probeIfWeak, 200)}`);
          return bits.join('\n');
        })
        .join('\n');
      parts.push(`## Planned blueprint questions (index is blueprintIndex)\n${planned}`);
    } else {
      parts.push('## Planned blueprint questions\n(none recorded — derive question blocks from the interviewer turns in the transcript; set blueprintIndex: null for each)');
    }

    parts.push(`## Transcript\n${renderTranscriptForLLM(input.transcript, input.candidateName) || '(no candidate answers recorded)'}`);
    parts.push('Output ONLY the JSON array of per-question analyses.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): DeepDiveOutput {
    const arr = parseJsonArray(response);
    if (!arr) throw new Error('QuestionDeepDiveAgent: unparseable response');

    const items: QuestionAnalysisItem[] = [];
    for (const row of arr) {
      const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const question = clip(r.question, 600);
      if (!question) continue;

      const missed = r.missed === true;
      let rating: QuestionRating = RATINGS.includes(r.rating as QuestionRating)
        ? (r.rating as QuestionRating)
        : ratingFromScore(clampScore(r.score), missed);
      if (missed) rating = 'missed';

      const hasScore = typeof r.score === 'number' && Number.isFinite(r.score);
      const score = hasScore ? clampScore(r.score) : scoreFromRating(rating);

      let blueprintIndex: number | null = null;
      if (typeof r.blueprintIndex === 'number' && Number.isInteger(r.blueprintIndex) && r.blueprintIndex >= 0) {
        blueprintIndex = r.blueprintIndex;
      }

      const keyQuote = clip(r.keyQuote, 160);
      const tags = strArr(r.tags, 4, 40);
      const tips = strArr(r.tips, 4, 200);

      items.push({
        questionIndex: items.length,
        blueprintIndex,
        missed,
        question,
        intent: clip(r.intent, 400),
        answerSummary: missed ? '' : clip(r.answerSummary, 500),
        ...(keyQuote ? { keyQuote } : {}),
        analysis: clip(r.analysis, 800),
        correction: clip(r.correction, 600),
        suggestion: clip(r.suggestion, 600),
        modelAnswer: clip(r.modelAnswer, 800),
        tips,
        rating,
        score,
        ...(tags.length ? { tags } : {}),
      });

      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  }

  async run(
    input: DeepDiveInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<DeepDiveOutput> {
    const langSource = `${input.role} ${input.interviewType}`.slice(0, 200);
    return this.execute(input, langSource, options.requestId, options.locale, undefined, options.signal);
  }
}

export const questionDeepDiveAgent = new QuestionDeepDiveAgent();
export default questionDeepDiveAgent;

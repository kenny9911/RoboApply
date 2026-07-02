// backend/src/roboapply/v2/agents/RAMockInterviewerAgent.ts
//
// RoboApply V3 Agent — the live mock-interview interviewer. One persona-aware
// agent that powers two surfaces behind the `mock.*` API:
//
//   - mode='plan'   → at `start`, generate the ordered question set
//                     [{ q, hint, coachTip }] for the chosen persona + type +
//                     role. Returns N questions (default 5).
//   - mode='turn'   → at `nextTurn`, react to the candidate's answer to the
//                     current question: produce 1–2 interviewer follow-up /
//                     next-prompt `turns` (markdown) + an optional live coach
//                     nudge. Persona-aware (a "Skeptical VP" pushes back; a
//                     "Warm Recruiter" affirms then digs gently).
//
// The persona (tone / difficulty / style) comes from the static catalog
// (raMockCatalog.ts) and is injected into the prompt. The interview TYPE
// (behavioral / technical / system / case / culture / panel) steers the
// question domain.
//
// Cost/latency: this is a Haiku-tier call (mirrors RAResumeRewriteAgent /
// RAKeywordExtractorAgent) — `nextTurn` fires on every answer, so latency
// matters more than depth. Returns STRICT JSON; RAMockService maps it to the
// wire shapes.
//
// Graceful degradation: failures THROW. RAMockService catches and falls back
// to a deterministic question bank / canned interviewer turn so every endpoint
// returns a valid shape even with no LLM key. The fallback path is not billed
// (mock isn't a billed SKU yet).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RAMockCoachKind = 'good' | 'careful';

export interface RAMockCoachTip {
  kind: RAMockCoachKind;
  text: string;
}

export type RAMockSpeaker = 'them' | 'you';

export interface RAMockTurn {
  who: RAMockSpeaker;
  /** MARKDOWN, rendered sanitized client-side. */
  text: string;
}

export interface RAMockQuestion {
  q: string;
  hint: string;
  coachTip: RAMockCoachTip;
}

export type RAMockAgentMode = 'plan' | 'turn';

/** The persona slice the agent needs (a projection of RAMockInterviewer). */
export interface RAMockPersona {
  id: string;
  name: string;
  role: string;
  /** 1..3 — higher = harder / more adversarial. */
  difficulty: number;
  style: string;
  blurb: string;
}

/** The interview type slice (a projection of RAMockType). */
export interface RAMockTypeContext {
  id: string;
  label: string;
  sub: string;
}

export interface RAMockPlanInput {
  mode: 'plan';
  persona: RAMockPersona;
  type: RAMockTypeContext;
  role: string;
  /** how many questions to generate (default 5). */
  count?: number;
}

export interface RAMockTurnInput {
  mode: 'turn';
  persona: RAMockPersona;
  type: RAMockTypeContext;
  role: string;
  /** the question the candidate just answered. */
  currentQuestion: string;
  /** the candidate's answer (may be empty on skip). */
  answer: string;
  /** the next question prompt, if the interview continues (null at the end). */
  nextQuestion: string | null;
  /**
   * Optional condensed interviewer brief from the Interview Prompt Generator
   * (RAInterviewPromptService). When present, the interviewer follows its
   * strategy + probing tactics + adaptation rules so follow-ups are ADAPTIVE
   * rather than a fixed reaction. Absent for legacy sessions.
   */
  interviewerBrief?: string;
}

export type RAMockAgentInput = RAMockPlanInput | RAMockTurnInput;

export interface RAMockAgentOutput {
  /** mode === 'plan' */
  questions?: RAMockQuestion[];
  /** mode === 'turn' */
  turns?: RAMockTurn[];
  /** mode === 'turn' — optional live nudge. */
  coachTip?: RAMockCoachTip | null;
}

// Haiku-tier default — cheap + fast, fires on every answer. Used when the env
// override below is unset. Exported so callers / tests can reference it.
export const RA_MOCK_INTERVIEWER_MODEL = RA_MODEL_HAIKU;

// Env var that overrides the model at runtime.
const ENV_MODEL = 'RA_V2_MOCK_INTERVIEWER_MODEL';

/**
 * Resolve the mock-interviewer model. Reads `process.env` at CALL TIME (not
 * module-load) so it picks up dotenv values regardless of ESM import order —
 * the backend's `dotenv.config()` runs after this module is hoisted, so a
 * module-level read would miss the override. Falls back to the default above.
 */
export function pickMockInterviewerModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_MOCK_INTERVIEWER_MODEL;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function coerceCoachKind(value: unknown): RAMockCoachKind {
  return value === 'careful' ? 'careful' : 'good';
}

/** Map a 1..3 difficulty to a tone directive the model can act on. */
function difficultyGuidance(difficulty: number): string {
  if (difficulty >= 3) {
    return 'HARD persona. Push back on every vague claim. Demand a metric or a concrete example. Follow-ups should probe one level deeper, not change the subject.';
  }
  if (difficulty === 2) {
    return 'MEDIUM persona. Warm but probing. Affirm a real specific, then dig once with a focused follow-up.';
  }
  return 'GENTLE persona. Conversational and encouraging. Draw the candidate out with an open follow-up; never adversarial.';
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAMockInterviewerAgent extends BaseAgent<
  RAMockAgentInput,
  RAMockAgentOutput
> {
  // The active mode — set in run() so parseOutput knows which shape to read.
  // Safe: RAMockService constructs a fresh agent per request and one agent
  // instance processes one call at a time.
  private activeMode: RAMockAgentMode = 'plan';

  constructor() {
    super('RAMockInterviewerAgent');
  }

  protected getTemperature(): number {
    // A touch of warmth/variety so two runs of the same persona don't read
    // identically, but still grounded. Above the scorer's 0.1.
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    // 'plan' returns ~5 questions with hints + tips; 'turn' is small. 900 is
    // generous for the plan path.
    return this.activeMode === 'plan' ? 900 : 400;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's mock-interview interviewer. You role-play a specific interviewer PERSONA conducting a specific kind of interview for a specific ROLE. You return STRICT JSON only — no prose, no code fences.

## Persona discipline
- Stay fully in character as the given persona. Match their TONE, DIFFICULTY, and STYLE.
- Never break character, never mention you are an AI, never explain the exercise.

## Two modes

### mode = "plan"
Generate the ordered set of interview questions this persona would actually ask, for the given interview TYPE and ROLE. For EACH question return:
  - "q": the question, phrased in the persona's voice (one or two sentences).
  - "hint": a short tactical tip to the CANDIDATE on how to answer well (coaching them, not the interviewer's voice).
  - "coachTip": { "kind": "good" | "careful", "text": "..." } — a one-line nudge the coach panel can surface for this question. Use "careful" for a common trap, "good" for an opportunity.
Output: { "questions": [ { "q": "...", "hint": "...", "coachTip": { "kind": "good", "text": "..." } }, ... ] }
Make the questions specific to the interview TYPE (behavioral = STAR/conflict/ownership; technical = data structures / coding; system = architecture & tradeoffs; case = open product/strategy; culture = values & motivation; panel = rapid-fire mix).

### mode = "turn"
The candidate just answered the CURRENT question. React IN CHARACTER:
  - If an "Interview brief" is provided, FOLLOW its strategy, probing tactics, and adaptation rules. Adapt to the answer (probe a vague answer one level deeper before moving on; if it was strong and specific, acknowledge briefly and raise the bar) rather than mechanically reading the next question.
  - Produce 1–2 "turns" with who="them" (the interviewer). The first turn reacts to / pushes on the answer per your difficulty. If a NEXT question is provided, the LAST turn should transition into it (you may rephrase it in your voice, or fold in a sharper follow-up the brief suggests). If there is NO next question, give a brief closing line.
  - "coachTip": { "kind": "good" | "careful", "text": "..." } OR null — a live nudge to the candidate about the answer they just gave (e.g. praise a concrete metric, or flag hedging). Use null if there is nothing useful to say.
Output: { "turns": [ { "who": "them", "text": "..." } ], "coachTip": { "kind": "careful", "text": "..." } }

## Rules
- Markdown is allowed inside "text" / "q" (bold, etc.) but keep it light.
- Never invent facts about the candidate — react only to what they said.
- Output ONLY the JSON object for the active mode.`;
  }

  protected formatInput(input: RAMockAgentInput): string {
    const parts: string[] = [];
    const p = input.persona;
    parts.push(
      `## Persona\nName: ${clipString(p.name, 80)}\nRole: ${clipString(p.role, 120)}\nStyle: ${clipString(p.style, 200)}\nBlurb: ${clipString(p.blurb, 300)}\nTone directive: ${difficultyGuidance(p.difficulty)}`,
    );
    parts.push(
      `## Interview\nType: ${clipString(input.type.label, 80)} — ${clipString(input.type.sub, 200)}\nCandidate target role: ${clipString(input.role, 160) || '(unspecified role)'}`,
    );

    if (input.mode === 'plan') {
      const count = Math.max(3, Math.min(input.count ?? 5, 8));
      parts.push(
        `MODE: plan\nGenerate exactly ${count} questions in order. Output ONLY {"questions": [...]}.`,
      );
    } else {
      parts.push('MODE: turn');
      if (input.interviewerBrief) {
        parts.push(
          `## Interview brief (follow this strategy + probing tactics; adapt, don't read a script)\n${clipString(input.interviewerBrief, 2000)}`,
        );
      }
      parts.push(
        `## Current question (just answered)\n${clipString(input.currentQuestion, 800)}`,
      );
      parts.push(
        `## Candidate's answer\n${clipString(input.answer, 3_000) || '(the candidate skipped / gave no answer)'}`,
      );
      if (input.nextQuestion) {
        parts.push(
          `## Next question (transition into this in your voice)\n${clipString(input.nextQuestion, 800)}`,
        );
      } else {
        parts.push(
          '## Next question\n(none — this was the last question; give a brief closing line)',
        );
      }
      parts.push('React in character. Output ONLY {"turns": [...], "coachTip": {...}|null}.');
    }

    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAMockAgentOutput {
    if (!response || typeof response !== 'string') return {};

    const cleaned = response
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

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
      return {};
    }

    if (this.activeMode === 'plan') {
      const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];
      const questions: RAMockQuestion[] = [];
      for (const rawRow of rawQs) {
        if (!rawRow || typeof rawRow !== 'object') continue;
        const row = rawRow as Record<string, unknown>;
        const q = clipString(row.q, 800);
        if (!q) continue;
        const hint = clipString(row.hint, 600);
        const tipObj =
          row.coachTip && typeof row.coachTip === 'object'
            ? (row.coachTip as Record<string, unknown>)
            : {};
        const coachTip: RAMockCoachTip = {
          kind: coerceCoachKind(tipObj.kind),
          text: clipString(tipObj.text, 400) || 'Be specific — concrete beats abstract.',
        };
        questions.push({ q, hint: hint || 'Lead with a concrete example.', coachTip });
        if (questions.length >= 8) break;
      }
      return questions.length > 0 ? { questions } : {};
    }

    // turn
    const rawTurns = Array.isArray(parsed.turns) ? parsed.turns : [];
    const turns: RAMockTurn[] = [];
    for (const rawRow of rawTurns) {
      if (!rawRow || typeof rawRow !== 'object') continue;
      const row = rawRow as Record<string, unknown>;
      const text = clipString(row.text, 1_500);
      if (!text) continue;
      // The interviewer agent should only voice "them" turns; coerce anything
      // else to 'them' (the candidate's own turn is appended by the service).
      turns.push({ who: row.who === 'you' ? 'you' : 'them', text });
      if (turns.length >= 3) break;
    }

    let coachTip: RAMockCoachTip | null = null;
    if (parsed.coachTip && typeof parsed.coachTip === 'object') {
      const tipObj = parsed.coachTip as Record<string, unknown>;
      const text = clipString(tipObj.text, 400);
      if (text) coachTip = { kind: coerceCoachKind(tipObj.kind), text };
    }

    return turns.length > 0 ? { turns, coachTip } : { coachTip };
  }

  /**
   * Run the agent. Failures THROW — RAMockService does NOT debit (mock is not
   * a billed SKU) and falls back to its deterministic bank on throw or on an
   * empty parse.
   */
  async run(
    input: RAMockAgentInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAMockAgentOutput> {
    this.activeMode = input.mode;
    // Detect language from the candidate's answer (turn) or the role/type
    // (plan) so the interview comes back in the candidate's language.
    const langSource =
      input.mode === 'turn'
        ? input.answer || input.currentQuestion
        : `${input.role} ${input.type.label}`;
    return this.execute(
      input,
      langSource,
      options.requestId,
      options.locale,
      pickMockInterviewerModel(),
      options.signal,
    );
  }
}

export const raMockInterviewerAgent = new RAMockInterviewerAgent();
export default raMockInterviewerAgent;

export const __test = {
  pickMockInterviewerModel,
  difficultyGuidance,
  coerceCoachKind,
};

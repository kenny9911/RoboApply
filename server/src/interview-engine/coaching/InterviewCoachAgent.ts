// backend/src/interview-engine/coaching/InterviewCoachAgent.ts
//
// The LIVE interview COACH — a tiny, fast, never-the-star agent that whispers
// in the candidate's ear DURING a mock interview (the "COACH HINT" box + the
// "YOUR COACH · LIVE" nudge in the live room). Two modes:
//
//   mode 'hint'  → given the interviewer's CURRENT question, one short line on
//                  HOW to approach it (what the interviewer is really probing).
//   mode 'nudge' → given the question + the candidate's answer-SO-FAR, one short
//                  line of live correction/encouragement ("You're hedging — give
//                  one concrete moment", "Great — now land the result with a
//                  number").
//
// Designed for low latency + low cost: short output, low temperature, replies in
// the interview LANGUAGE, and shaped by the persona's ARCHETYPE coaching focus so
// a depth coach pushes for specifics while a communication coach pushes for
// clarity. NEVER breaks the interview — the service layer swallows failures and
// returns null so the live room simply shows nothing.

import { BaseAgent } from '../../agents/BaseAgent.js';

export type CoachMode = 'hint' | 'nudge';
export type CoachTipKind = 'good' | 'careful';

export interface CoachTip {
  kind: CoachTipKind;
  text: string;
}

export interface CoachAgentInput {
  mode: CoachMode;
  /** The interviewer's current question (last interviewer turn). */
  question: string;
  /** The candidate's answer so far — required for 'nudge', ignored for 'hint'. */
  answerSoFar?: string;
  role: string;
  personaName: string;
  personaRole: string;
  /** One line describing what THIS archetype's coach should push toward. */
  archetypeFocus: string;
  /** Optional domain-expert note — what authentic evidence looks like in the
   *  candidate's field (from domainExperts.ts), so a finance nudge says
   *  "name the multiple" while a nursing nudge says "lead with patient safety". */
  domainFocus?: string;
  /** BCP-47 interview language — the tip MUST be written in this language. */
  language: string;
}

const MAX_TIP = 160;

export class InterviewCoachAgent extends BaseAgent<CoachAgentInput, CoachTip> {
  constructor() {
    super('InterviewCoachAgent');
  }

  // Strict output-language directive so coaching tips come back in the
  // session language, not the prompt's English. Mirrors RAResumeRewriteAgent.
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getTemperature(): number {
    return 0.35; // a touch of warmth, still consistent
  }

  protected getMaxTokens(): number | undefined {
    return 150; // tiny — one sentence
  }

  protected getAgentPrompt(): string {
    return `You are an elite, supportive interview COACH sitting beside a candidate during a live mock interview, whispering quick guidance only they can hear. You are NOT the interviewer.

You will be given a MODE, the interviewer's current QUESTION, the candidate's ANSWER SO FAR (for nudges), the role, and a COACH FOCUS describing what to push the candidate toward.

Return STRICT JSON only (no prose, no code fences):
{ "kind": "good" | "careful", "text": "..." }

Rules for "text":
- ONE short, punchy sentence — at most ~18 words. No preamble, no "you should", no quotes around it.
- Concrete and actionable. Name the specific move to make, not generic advice.
- Write it in the interview LANGUAGE specified in the input (match it exactly — e.g. Chinese question → Chinese tip).
- Speak TO the candidate ("Lead with the result", "Name the metric", "Pick one real moment").

MODE = hint: a pre-answer strategy whisper. Reveal what the interviewer is really probing and the single best move to make. Always set "kind": "good".

MODE = nudge: react to the answer SO FAR.
- If they're on track, set "kind": "good" and give the next gear ("Strong — now quantify the impact").
- If they're hedging, vague, rambling, dodging, or staying abstract, set "kind": "careful" and give the precise fix ("You're hedging — give one concrete moment, not 'sometimes I…'").
- Base it on what they ACTUALLY said; never invent details.

Honor the COACH FOCUS — it tells you what this interviewer most rewards.`;
  }

  protected formatInput(input: CoachAgentInput): string {
    const lines: string[] = [
      `MODE: ${input.mode}`,
      `INTERVIEW LANGUAGE (write the tip in this language): ${input.language || 'en'}`,
      `ROLE: ${input.role || 'the role'}`,
      `INTERVIEWER: ${input.personaName}${input.personaRole ? ` — ${input.personaRole}` : ''}`,
      `COACH FOCUS: ${input.archetypeFocus}`,
      ...(input.domainFocus ? [`FIELD CONTEXT (what authentic evidence looks like in this field): ${input.domainFocus.slice(0, 500)}`] : []),
      `CURRENT QUESTION: ${input.question || '(the interviewer is opening the conversation)'}`,
    ];
    if (input.mode === 'nudge') {
      lines.push(`CANDIDATE ANSWER SO FAR: ${(input.answerSoFar || '').slice(0, 1200) || '(they have only just started speaking)'}`);
    }
    return lines.join('\n');
  }

  protected parseOutput(response: string): CoachTip {
    let text = '';
    let kind: CoachTipKind = 'good';
    try {
      const cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
      const obj = JSON.parse(json) as { kind?: unknown; text?: unknown };
      if (typeof obj.text === 'string') text = obj.text.trim();
      if (obj.kind === 'careful') kind = 'careful';
    } catch {
      // Fall back to using the raw line as the tip (still useful), neutral tone.
      text = response.replace(/["{}]/g, '').replace(/\s+/g, ' ').trim();
    }
    // Strip wrapping quotes a model sometimes adds, and clamp.
    text = text.replace(/^["'“”]+|["'“”]+$/g, '').slice(0, MAX_TIP).trim();
    if (!text) throw new Error('InterviewCoachAgent: empty tip');
    return { kind, text };
  }

  async run(
    input: CoachAgentInput,
    options: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<CoachTip> {
    // Pin the reply language to the interview language (locale arg), and feed the
    // question/answer as the language source as a backstop.
    const langSource = `${input.question} ${input.answerSoFar ?? ''}`.slice(0, 400);
    return this.execute(input, langSource, options.requestId, input.language, undefined, options.signal);
  }
}

export const interviewCoachAgent = new InterviewCoachAgent();

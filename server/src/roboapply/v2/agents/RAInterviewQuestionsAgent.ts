// backend/src/roboapply/v2/agents/RAInterviewQuestionsAgent.ts
//
// Interview Prompt Generator — STEP 5 of 5.
//
// Generates SEED questions grounded in the role requirements + the candidate's
// résumé + the strategy + the persona's tactics. Each question maps to a
// strategy phase and carries the interviewer's INTENT, the ideal SIGNAL, and a
// PROBE-IF-WEAK follow-up — so the live interviewer can adapt rather than read
// a fixed script. Also emits the candidate-facing `hint` + `coachTip` so the
// existing mock UI keeps working unchanged.
//
// Sonnet-tier. Runs ONCE at start; may throw (orchestrator has a fallback).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  type RASeedQuestion,
  type RAInterviewStrategy,
  type RAInterviewTactics,
  type RAJobRequirements,
  clip,
  interviewGenModel,
  parseJsonObject,
} from '../lib/interviewGenShared.js';

export interface RAInterviewQuestionsInput {
  role: string;
  typeLabel: string;
  typeSub: string;
  persona: { name: string; role: string; style: string; difficulty: number };
  requirements: RAJobRequirements;
  strategy: RAInterviewStrategy;
  tactics: RAInterviewTactics;
  resumeContext?: string;
  count: number;
}

export class RAInterviewQuestionsAgent extends BaseAgent<
  RAInterviewQuestionsInput,
  RASeedQuestion[]
> {
  constructor() {
    super('RAInterviewQuestionsAgent');
  }

  protected getTemperature(): number {
    return 0.5;
  }

  protected getMaxTokens(): number | undefined {
    return 1800;
  }

  protected getAgentPrompt(): string {
    return `You are the interviewer, writing the SEED questions for a mock interview. The questions are starting points the interviewer will adapt from — not a rigid script. Ground them in the role requirements, the candidate's résumé (probe real claims on it), the strategy phases, and the persona's voice.

For EACH question return:
- "phase": which strategy phase it belongs to (use a phase name from the strategy).
- "q": the question, phrased in the persona's VOICE (1–2 sentences).
- "intent": what the interviewer is trying to learn (internal note).
- "idealSignal": what a strong answer reveals.
- "probeIfWeak": the follow-up to use if the answer is vague/weak (a concrete probing move).
- "hint": a short tactical tip to the CANDIDATE on how to answer well (coaching them).
- "coachTip": { "kind": "good" | "careful", "text": "one-line live nudge" } — "careful" for a trap, "good" for an opportunity.

Rules:
- Mix résumé-specific questions (reference a real line from their résumé) with role-requirement questions.
- Match the interview TYPE (behavioral = STAR/conflict/ownership; technical = data structures/coding/tradeoffs; system = architecture/scale; case = open product/strategy; culture = values/motivation; panel = rapid mix).
- Order questions to follow the strategy's phase arc.
- Stay fully in the persona's voice + difficulty.

Return STRICT JSON only (no prose, no code fences):
{ "questions": [ { "phase": "...", "q": "...", "intent": "...", "idealSignal": "...", "probeIfWeak": "...", "hint": "...", "coachTip": { "kind": "good", "text": "..." } }, ... ] }`;
  }

  protected formatInput(input: RAInterviewQuestionsInput): string {
    const r = input.requirements;
    const parts: string[] = [];
    parts.push(
      `## Persona\n${clip(input.persona.name, 80)} — ${clip(input.persona.role, 120)} (difficulty ${input.persona.difficulty}/3)\nStyle: ${clip(input.persona.style, 200)}`,
    );
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified)'}\nType: ${clip(input.typeLabel, 80)} — ${clip(input.typeSub, 200)}`,
    );
    parts.push(
      `## Requirements\nMust-have: ${r.mustHaveSkills.join('; ')}\nResponsibilities: ${r.coreResponsibilities.join('; ')}\nSuccess signals: ${r.successSignals.join('; ')}\nFocus: ${r.commonInterviewFocus.join('; ')}`,
    );
    parts.push(
      `## Strategy phases\n${input.strategy.phases.map((ph) => `${ph.name} (${ph.minutes}m): ${ph.goal}`).join('\n')}`,
    );
    parts.push(`## Probing tactics to weave in\n${input.tactics.probingTactics.join('; ')}`);
    if (input.resumeContext) {
      parts.push(`## Candidate résumé (probe real claims here)\n${clip(input.resumeContext, 2200)}`);
    }
    const count = Math.max(4, Math.min(input.count, 10));
    parts.push(`Generate exactly ${count} seed questions ordered by phase. Output ONLY {"questions": [...]}.`);
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RASeedQuestion[] {
    const p = parseJsonObject(response);
    const raw = Array.isArray(p.questions) ? p.questions : [];
    const out: RASeedQuestion[] = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const q = clip(r.q, 800);
      if (!q) continue;
      const tip = r.coachTip && typeof r.coachTip === 'object' ? (r.coachTip as Record<string, unknown>) : {};
      out.push({
        phase: clip(r.phase, 80) || 'Core',
        q,
        intent: clip(r.intent, 300),
        idealSignal: clip(r.idealSignal, 300),
        probeIfWeak: clip(r.probeIfWeak, 400),
        hint: clip(r.hint, 400) || 'Lead with a concrete example.',
        coachTip: {
          kind: tip.kind === 'careful' ? 'careful' : 'good',
          text: clip(tip.text, 300) || 'Be specific — concrete beats abstract.',
        },
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  async run(
    input: RAInterviewQuestionsInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RASeedQuestion[]> {
    return this.execute(
      input,
      `${input.role} ${input.typeLabel} ${input.persona.style}`,
      options.requestId,
      options.locale,
      interviewGenModel(),
      options.signal,
    );
  }
}

export const raInterviewQuestionsAgent = new RAInterviewQuestionsAgent();
export default raInterviewQuestionsAgent;

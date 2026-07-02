// backend/src/roboapply/v2/agents/RAInterviewStrategyAgent.ts
//
// Interview Prompt Generator — STEP 2 of 5.
//
// Designs the interview PLAN & STRATEGY: a phased, time-boxed approach tuned
// to BOTH the role requirements AND the chosen interviewer persona/difficulty,
// fitted to the selected duration. The phases' minutes should sum to ~the
// requested duration.
//
// Sonnet-tier. Runs ONCE at start; may throw (orchestrator has a fallback).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  type RAInterviewStrategy,
  type RAInterviewPhase,
  type RAJobRequirements,
  asStringArray,
  clip,
  interviewGenModel,
  parseJsonObject,
} from '../lib/interviewGenShared.js';

export interface RAInterviewStrategyInput {
  role: string;
  typeLabel: string;
  typeSub: string;
  durationMinutes: number;
  /** Persona projection — its style/difficulty must shape the strategy. */
  persona: { name: string; role: string; style: string; blurb: string; difficulty: number };
  requirements: RAJobRequirements;
}

function difficultyDirective(difficulty: number): string {
  if (difficulty >= 3) return 'HARD: adversarial, numbers-first, low patience for vagueness — strategy should front-load pressure and reserve time to dig deep on 2–3 areas.';
  if (difficulty === 2) return 'MEDIUM: warm but probing — affirm then dig; balanced coverage with one or two deep dives.';
  return 'GENTLE: conversational, draws the candidate out — broader coverage, encouraging pacing, lighter probing.';
}

export class RAInterviewStrategyAgent extends BaseAgent<
  RAInterviewStrategyInput,
  RAInterviewStrategy
> {
  constructor() {
    super('RAInterviewStrategyAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 1100;
  }

  protected getAgentPrompt(): string {
    return `You are an interview designer. Produce a PLAN & STRATEGY for ONE mock interview, tuned to the role requirements AND to the specific interviewer persona's style + difficulty, fitted to the available time.

Rules:
- The persona's STYLE and DIFFICULTY must visibly shape the strategy — a Skeptical VP runs a different room than a Warm Recruiter.
- Phases must be TIME-BOXED: the sum of phase minutes should be within ±2 of the total duration. Typical arc: Warm-up/Open → Core → Deep probe → Wrap/Candidate-questions, but adapt to the interview type and duration (a 15-min screen has fewer phases than a 60-min loop).
- Focus on what THIS role's requirements say matters most. Reference the success signals.

Return STRICT JSON only (no prose, no code fences):
{
  "overview": "2–3 sentences: the overall approach this interviewer takes for this interview",
  "phases": [ { "name": "Warm-up", "minutes": 5, "goal": "..." }, ... ],
  "focusAreas": ["the 2–4 areas to spend the most time on"],
  "signalsToElicit": ["concrete signals to surface from the candidate"],
  "redFlagsToProbe": ["things to watch for / pressure-test"],
  "openingApproach": "how this persona opens the interview (1–2 sentences, in their style)",
  "closingApproach": "how this persona closes (1–2 sentences)"
}`;
  }

  protected formatInput(input: RAInterviewStrategyInput): string {
    const r = input.requirements;
    const parts: string[] = [];
    parts.push(
      `## Interviewer persona\nName: ${clip(input.persona.name, 80)} — ${clip(input.persona.role, 120)}\nStyle: ${clip(input.persona.style, 200)}\nBlurb: ${clip(input.persona.blurb, 300)}\nDifficulty directive: ${difficultyDirective(input.persona.difficulty)}`,
    );
    parts.push(
      `## Interview\nRole: ${clip(input.role, 160) || '(unspecified)'}\nType: ${clip(input.typeLabel, 80)} — ${clip(input.typeSub, 200)}\nTotal duration: ${input.durationMinutes} minutes`,
    );
    parts.push(
      `## Role requirements (from step 1)\nSummary: ${clip(r.roleSummary, 400)}\nSeniority bar: ${clip(r.seniorityBar, 250)}\nMust-have: ${r.mustHaveSkills.join('; ')}\nCore responsibilities: ${r.coreResponsibilities.join('; ')}\nSuccess signals: ${r.successSignals.join('; ')}\nTypical interview focus: ${r.commonInterviewFocus.join('; ')}`,
    );
    parts.push(`Design phases whose minutes sum to ≈ ${input.durationMinutes}. Output ONLY the JSON object.`);
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAInterviewStrategy {
    const p = parseJsonObject(response);
    const phases: RAInterviewPhase[] = [];
    if (Array.isArray(p.phases)) {
      for (const row of p.phases) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const name = clip(r.name, 80);
        if (!name) continue;
        const minutes = typeof r.minutes === 'number' && r.minutes > 0 ? Math.round(r.minutes) : 5;
        phases.push({ name, minutes, goal: clip(r.goal, 240) });
        if (phases.length >= 8) break;
      }
    }
    return {
      overview: clip(p.overview, 600),
      phases,
      focusAreas: asStringArray(p.focusAreas, 6, 160),
      signalsToElicit: asStringArray(p.signalsToElicit, 8, 200),
      redFlagsToProbe: asStringArray(p.redFlagsToProbe, 8, 200),
      openingApproach: clip(p.openingApproach, 400),
      closingApproach: clip(p.closingApproach, 400),
    };
  }

  async run(
    input: RAInterviewStrategyInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAInterviewStrategy> {
    return this.execute(
      input,
      `${input.role} ${input.persona.style}`,
      options.requestId,
      options.locale,
      interviewGenModel(),
      options.signal,
    );
  }
}

export const raInterviewStrategyAgent = new RAInterviewStrategyAgent();
export default raInterviewStrategyAgent;

// backend/src/roboapply/v2/agents/RAInterviewTacticsAgent.ts
//
// Interview Prompt Generator — STEPS 3 & 4 of 5.
//
// Turns the strategy into concrete, persona-flavored INTERVIEW TACTICS (step 3)
// AND PROBING TACTICS (step 4), plus ADAPTATION RULES that make the live
// interview adaptive (escalate / de-escalate / pivot based on answer quality).
//
// Sonnet-tier. Runs ONCE at start; may throw (orchestrator has a fallback).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  type RAInterviewTactics,
  type RAInterviewStrategy,
  type RAJobRequirements,
  asStringArray,
  clip,
  interviewGenModel,
  parseJsonObject,
} from '../lib/interviewGenShared.js';

export interface RAInterviewTacticsInput {
  persona: { name: string; role: string; style: string; difficulty: number };
  typeLabel: string;
  requirements: RAJobRequirements;
  strategy: RAInterviewStrategy;
}

export class RAInterviewTacticsAgent extends BaseAgent<
  RAInterviewTacticsInput,
  RAInterviewTactics
> {
  constructor() {
    super('RAInterviewTacticsAgent');
  }

  protected getTemperature(): number {
    return 0.45;
  }

  protected getMaxTokens(): number | undefined {
    return 1000;
  }

  protected getAgentPrompt(): string {
    return `You are an interview-craft coach defining how a specific interviewer will actually CONDUCT an interview. Given the persona, the role requirements, and the strategy, produce three lists:

1. "tactics" — how this persona runs the room: pacing, how they frame questions, how much they push, how they react to strong vs weak answers. Persona-specific (a Skeptical VP interrupts and demands metrics; a Warm Recruiter mirrors and gives space).
2. "probingTactics" — concrete techniques to dig DEEPER when an answer is thin or unverified: e.g. laddering ("and then what?"), STAR-gap fills ("what was YOUR specific action?"), metric demands ("by how much?"), counterfactuals ("what if it had failed?"), evidence checks ("how do you know?"). Make them usable verbatim as follow-up moves.
3. "adaptationRules" — IF/THEN rules that make the interview ADAPTIVE rather than a fixed script: when to escalate pressure, when to ease off, when to skip ahead, when to chase a thread vs move on. Reference answer quality (vague / concrete / evasive / strong).

Rules:
- Everything must sound like THIS persona at THIS difficulty.
- Keep each item one actionable line.

Return STRICT JSON only (no prose, no code fences):
{ "tactics": ["..."], "probingTactics": ["..."], "adaptationRules": ["IF ... THEN ..."] }`;
  }

  protected formatInput(input: RAInterviewTacticsInput): string {
    const parts: string[] = [];
    parts.push(
      `## Persona\n${clip(input.persona.name, 80)} — ${clip(input.persona.role, 120)} (difficulty ${input.persona.difficulty}/3)\nStyle: ${clip(input.persona.style, 200)}`,
    );
    parts.push(`## Interview type\n${clip(input.typeLabel, 80)}`);
    parts.push(
      `## Strategy (from step 2)\nOverview: ${clip(input.strategy.overview, 400)}\nFocus areas: ${input.strategy.focusAreas.join('; ')}\nSignals to elicit: ${input.strategy.signalsToElicit.join('; ')}\nRed flags to probe: ${input.strategy.redFlagsToProbe.join('; ')}`,
    );
    parts.push(
      `## Role success signals\n${input.requirements.successSignals.join('; ')}`,
    );
    parts.push('Output ONLY the JSON object with tactics, probingTactics, adaptationRules.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAInterviewTactics {
    const p = parseJsonObject(response);
    return {
      tactics: asStringArray(p.tactics, 8, 220),
      probingTactics: asStringArray(p.probingTactics, 8, 220),
      adaptationRules: asStringArray(p.adaptationRules, 8, 240),
    };
  }

  async run(
    input: RAInterviewTacticsInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAInterviewTactics> {
    return this.execute(
      input,
      `${input.persona.style} ${input.typeLabel}`,
      options.requestId,
      options.locale,
      interviewGenModel(),
      options.signal,
    );
  }
}

export const raInterviewTacticsAgent = new RAInterviewTacticsAgent();
export default raInterviewTacticsAgent;

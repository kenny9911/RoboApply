// backend/src/roboapply/v2/lib/interviewGenShared.ts
//
// Shared types + tiny parse helpers for the Interview Prompt Generator
// pipeline (RAInterviewJobRequirements/Strategy/Tactics/Questions agents and
// the RAInterviewPromptService orchestrator).

import { getTaskModel, getTaskReasoningEffort } from '../../../lib/llm/llmTaskSettings.js';

// ─── Model selection ──────────────────────────────────────────────────────
//
// Both settings resolve at call time so env reloads and DB overrides take
// effect uniformly across the legacy and Interview Engine interview stacks.
export function interviewGenModel(): string | undefined {
  return getTaskModel('interview');
}

export function interviewGenReasoningEffort() {
  return getTaskReasoningEffort('interview');
}

// ─── Generation artifact types (the "blueprint") ──────────────────────────

export interface RAJobRequirements {
  roleSummary: string;
  seniorityBar: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  coreResponsibilities: string[];
  successSignals: string[];
  commonInterviewFocus: string[];
  domainContext: string;
}

export interface RAInterviewPhase {
  name: string;
  minutes: number;
  goal: string;
}

export interface RAInterviewStrategy {
  overview: string;
  phases: RAInterviewPhase[];
  focusAreas: string[];
  signalsToElicit: string[];
  redFlagsToProbe: string[];
  openingApproach: string;
  closingApproach: string;
}

export interface RAInterviewTactics {
  /** How this persona runs the room (pacing, framing, pushback level). */
  tactics: string[];
  /** Techniques to dig deeper (laddering, STAR enforcement, metric demands…). */
  probingTactics: string[];
  /** How to escalate / de-escalate based on answer quality. */
  adaptationRules: string[];
}

export interface RASeedQuestion {
  /** which strategy phase this seeds (free text, matches a phase name). */
  phase: string;
  q: string;
  /** what the interviewer is trying to learn. */
  intent: string;
  /** the signal a strong answer reveals. */
  idealSignal: string;
  /** a follow-up to use if the answer is weak / vague. */
  probeIfWeak: string;
  /** candidate-facing coaching hint (mirrors RAMockQuestion.hint). */
  hint: string;
  /** live coach nudge (mirrors RAMockQuestion.coachTip). */
  coachTip: { kind: 'good' | 'careful'; text: string };
}

export interface RAInterviewBlueprint {
  requirements: RAJobRequirements;
  strategy: RAInterviewStrategy;
  tactics: RAInterviewTactics;
  questions: RASeedQuestion[];
  webSources: Array<{ title: string; url: string }>;
  model: string;
  generatedAt: string;
}

// ─── Parse helpers ──────────────────────────────────────────────────────

export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export function asStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = clip(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Strip code fences + parse the first JSON object found. Returns {} on failure. */
export function parseJsonObject(response: string): Record<string, unknown> {
  if (!response || typeof response !== 'string') return {};
  const cleaned = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through */
      }
    }
  }
  return {};
}

// backend/src/interview-engine/prompt/characteristics.ts
//
// InterviewCharacteristics — the tunable "shape" of an interview beyond
// role + type + persona (requirement #4). Recruiters / external callers can
// dial difficulty, tone, pacing, follow-up depth, and the topics to cover.
// normalizeCharacteristics() always returns a complete, clamped object so
// downstream prompt composition never has to null-check.

import type { InterviewCharacteristics } from '../types.js';

export const TONES = ['warm', 'neutral', 'formal', 'skeptical', 'friendly'] as const;
export const PACINGS = ['relaxed', 'standard', 'brisk'] as const;

export const DEFAULT_CHARACTERISTICS: InterviewCharacteristics = {
  difficulty: 3,
  tone: 'neutral',
  pacing: 'standard',
  followUpDepth: 1,
  mustCoverTopics: [],
  focusAreas: [],
  allowCandidateQuestions: true,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanStringArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Coerce arbitrary input (API body / DB Json) into a complete, clamped
 * InterviewCharacteristics. `personaDifficulty` (1..3) seeds the default
 * difficulty when the caller doesn't specify one.
 */
export function normalizeCharacteristics(
  input: unknown,
  personaDifficulty?: number,
): InterviewCharacteristics {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const seededDifficulty = personaDifficulty ? clampInt(personaDifficulty * 1.6, 1, 5, 3) : DEFAULT_CHARACTERISTICS.difficulty;

  const tone = typeof raw.tone === 'string' && TONES.includes(raw.tone as any) ? (raw.tone as string) : DEFAULT_CHARACTERISTICS.tone;
  const pacing = typeof raw.pacing === 'string' && PACINGS.includes(raw.pacing as any) ? (raw.pacing as string) : DEFAULT_CHARACTERISTICS.pacing;

  return {
    difficulty: clampInt(raw.difficulty, 1, 5, seededDifficulty),
    tone,
    pacing,
    followUpDepth: clampInt(raw.followUpDepth, 0, 3, DEFAULT_CHARACTERISTICS.followUpDepth),
    mustCoverTopics: cleanStringArray(raw.mustCoverTopics, 8, 120),
    focusAreas: cleanStringArray(raw.focusAreas, 8, 120),
    allowCandidateQuestions:
      typeof raw.allowCandidateQuestions === 'boolean'
        ? raw.allowCandidateQuestions
        : DEFAULT_CHARACTERISTICS.allowCandidateQuestions,
  };
}

/** Human-readable difficulty/tone directives the prompt composer injects. */
export function describeDifficulty(difficulty: number): string {
  if (difficulty >= 5) return 'Very hard. Challenge every claim, demand metrics and specifics, follow up relentlessly, do not over-affirm.';
  if (difficulty === 4) return 'Hard. Push back on vague answers, require concrete examples, follow up to probe depth.';
  if (difficulty === 3) return 'Moderate. Warm but probing; affirm a real specific, then dig once.';
  if (difficulty === 2) return 'Approachable. Encouraging; draw the candidate out with open follow-ups.';
  return 'Gentle. Conversational and supportive; never adversarial.';
}

export function describePacing(pacing: string): string {
  if (pacing === 'brisk') return 'Move briskly; keep your turns short and cover more ground.';
  if (pacing === 'relaxed') return 'Take your time; let the candidate think and elaborate.';
  return 'Keep a natural, steady pace.';
}

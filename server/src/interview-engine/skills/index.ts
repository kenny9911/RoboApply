// server/src/interview-engine/skills/index.ts
//
// The interview SKILL registry: one place that knows every directive module
// the engine can apply and composes them for the stage that asks.
//
//   kind        what it carries                          source
//   archetype   HOW the interviewer probes               catalog/interviewArchetypes.ts
//   format      the STRUCTURE of the exercise            catalog/interviewFormats.ts
//   domain      the SUBSTANCE of a field                 catalog/domainExperts.ts
//   pattern     a recurring shape of a real loop          skills/patterns.ts
//   market      how interviews run in a job market        skills/markets.ts
//
// Agents never see the directives in full when they only need to choose: the
// planner reads the compact index (`renderSkillIndex`) and answers with ids;
// the stages that run the interview then receive the full directives of the
// chosen ids (`patternDirectives`, `marketDirectives`). Adding a skill is a
// data change in one of the files above; nothing here lists them by hand.

import { INTERVIEW_ARCHETYPES, getArchetype, type InterviewArchetype } from '../catalog/interviewArchetypes.js';
import { formatsForMarket, getFormat, type FormatMarket } from '../catalog/interviewFormats.js';
import { DEFAULT_PERSONA, INTERVIEW_PERSONAS, type InterviewPersona } from '../catalog/interviewCatalog.js';
import { INTERVIEW_PATTERNS, INTERVIEW_PATTERN_KEYS, getPattern, type InterviewPatternKey } from './patterns.js';
import { MARKET_NORMS, getMarketNorms, type InterviewMarketKey, type MarketNormPlaybook } from './markets.js';

export { INTERVIEW_PATTERNS, INTERVIEW_PATTERN_KEYS, getPattern } from './patterns.js';
export type { InterviewPatternKey, InterviewPatternPlaybook } from './patterns.js';
export { MARKET_NORMS, INTERVIEW_MARKET_KEYS, getMarketNorms, marketForCountry, resolveMarketNorms } from './markets.js';
export type { InterviewMarketKey, MarketNormPlaybook } from './markets.js';

export function isArchetype(value: unknown): value is InterviewArchetype {
  return typeof value === 'string' && (INTERVIEW_ARCHETYPES as readonly string[]).includes(value);
}

export function isPatternKey(value: unknown): value is InterviewPatternKey {
  return typeof value === 'string' && (INTERVIEW_PATTERN_KEYS as readonly string[]).includes(value);
}

/** A format id the market offers (GoApply's AI-interview format exists on `cn` only). */
export function isMarketFormat(id: unknown, market: FormatMarket = 'intl'): id is string {
  return typeof id === 'string' && formatsForMarket(market).some((format) => format.id === id);
}

/** Keep the known pattern keys of `values`, in order, without duplicates. */
export function cleanPatternKeys(values: unknown, max = 4): InterviewPatternKey[] {
  if (!Array.isArray(values)) return [];
  const out: InterviewPatternKey[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (isPatternKey(key) && !out.includes(key)) out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The compact index a planning agent chooses from: ids with one line each.
 * Formats are the market's own list; archetypes and patterns are shared.
 */
export function renderSkillIndex(market: FormatMarket = 'intl'): string {
  const formats = formatsForMarket(market)
    .map((format) => `- ${format.id}: ${format.labelEn} — ${format.subEn}`)
    .join('\n');
  const archetypes = INTERVIEW_ARCHETYPES
    .map((key) => {
      const playbook = getArchetype(key);
      return `- ${key}: ${playbook.labelEn} — ${playbook.summary}`;
    })
    .join('\n');
  const patterns = INTERVIEW_PATTERN_KEYS
    .map((key) => {
      const playbook = INTERVIEW_PATTERNS[key];
      return `- ${key}: ${playbook.labelEn} — ${playbook.summary} Use when: ${playbook.whenToUse}`;
    })
    .join('\n');
  return [
    `### Formats (the structure of one interview; "format" must be one of these ids)\n${formats}`,
    `### Interviewer archetypes (how an interviewer probes; "archetype" must be one of these ids)\n${archetypes}`,
    `### Interview patterns (recurring shapes of real loops; "patterns" use these ids)\n${patterns}`,
  ].join('\n\n');
}

export interface StageDirectives {
  blueprint: string[];
  voice: string[];
  evaluation: string[];
}

/** The chosen patterns' directives, per stage, labelled so a prompt can cite them. */
export function patternDirectives(keys: readonly string[]): StageDirectives {
  const out: StageDirectives = { blueprint: [], voice: [], evaluation: [] };
  for (const key of keys) {
    const playbook = getPattern(key);
    if (!playbook) continue;
    out.blueprint.push(`${playbook.labelEn}: ${playbook.blueprintDirective}`);
    out.voice.push(`${playbook.labelEn}: ${playbook.voiceDirective}`);
    out.evaluation.push(`${playbook.labelEn}: ${playbook.evaluationLens}`);
  }
  return out;
}

export function marketDirectives(key: string | null | undefined): (StageDirectives & { label: string }) | null {
  const playbook: MarketNormPlaybook | null = getMarketNorms(key);
  if (!playbook) return null;
  return {
    label: playbook.labelEn,
    blueprint: [playbook.blueprintDirective],
    voice: [playbook.voiceDirective],
    evaluation: [playbook.evaluationLens],
  };
}

/** One-line market summaries for a planner prompt. */
export function renderMarketSummary(key: InterviewMarketKey): string {
  const playbook = MARKET_NORMS[key];
  return `${playbook.labelEn}: ${playbook.summary}`;
}

/**
 * The catalog persona a generated interviewer runs on. The engine keeps one
 * catalog id per session (the voice, the base difficulty, older readers); a
 * generated interviewer maps onto the persona of the same archetype, with the
 * same voice where one exists and the closest difficulty.
 */
export function basePersonaFor(input: {
  archetype: InterviewArchetype;
  difficulty?: number | null;
  voiceGender?: 'female' | 'male' | 'neutral' | null;
}): InterviewPersona {
  const difficulty = typeof input.difficulty === 'number' ? input.difficulty : 2;
  const sameArchetype = INTERVIEW_PERSONAS.filter((persona) => persona.archetype === input.archetype);
  const pool = sameArchetype.length ? sameArchetype : INTERVIEW_PERSONAS;
  const ranked = [...pool].sort((a, b) => {
    const voiceA = input.voiceGender && a.voiceGender === input.voiceGender ? 0 : 1;
    const voiceB = input.voiceGender && b.voiceGender === input.voiceGender ? 0 : 1;
    if (voiceA !== voiceB) return voiceA - voiceB;
    return Math.abs(a.difficulty - difficulty) - Math.abs(b.difficulty - difficulty);
  });
  return ranked[0] ?? DEFAULT_PERSONA;
}

/** The format an interview runs as, or the safe default for the market. */
export function formatOrDefault(id: unknown, market: FormatMarket = 'intl'): string {
  if (isMarketFormat(id, market)) return id;
  return getFormat('behavioral') ? 'behavioral' : formatsForMarket(market)[0].id;
}

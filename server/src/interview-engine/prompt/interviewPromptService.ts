// backend/src/interview-engine/prompt/interviewPromptService.ts
//
// Orchestrates prompt generation for a session (requirement #4):
//   1. Tavily web search for the role's real requirements + interview focus.
//   2. InterviewBlueprintAgent (one structured call) → full blueprint.
//   3. Deterministic compose → voice system prompt + opening + master brief +
//      seed questions (UI shape) + web sources.
//
// NEVER throws: any failed stage degrades to a heuristic so a session can
// always start.

import { logger } from '../../services/LoggerService.js';
import { searchJobRequirements, formatWebEvidence } from '../webSearch.js';
import { getArchetype } from '../catalog/interviewArchetypes.js';
import { getFormat } from '../catalog/interviewFormats.js';
import { interviewBlueprintAgent, inferRoleFromJd, type InterviewBlueprint } from './InterviewBlueprintAgent.js';
import {
  composeVoiceSystemPrompt,
  composeOpeningInstruction,
  composeOpeningLine,
  composeMasterBrief,
  type ComposeParams,
} from './voiceSystemPrompt.js';
import type { InterviewCharacteristics } from '../types.js';

export interface SeedQuestion {
  q: string;
  hint: string;
  coachTip: { kind: 'good' | 'careful'; text: string };
}

export interface PromptGenerationInput {
  role: string;
  personaName: string;
  personaRole: string;
  personaStyle: string;
  personaDifficulty: number;
  /**
   * The persona's interviewer archetype key (warmup/behavioral/breadth/potential/
   * depth). REQUIRED so the preview and the live session can never silently
   * diverge on question style — every caller must pass persona.archetype.
   */
  archetype: string;
  typeLabel: string;
  typeSub: string;
  /** Interview format id (resolves the format's blueprintDirective). */
  typeId?: string;
  language: string;
  durationMinutes: number;
  characteristics: InterviewCharacteristics;
  candidateName?: string;
  resumeContext?: string;
  /** Pasted job description — AUTHORITATIVE for requirements when present. */
  jdText?: string;
  questionCount?: number;
  requestId?: string;
  signal?: AbortSignal;
}

/** Real job boards we prefer to ground requirements on (the "competitive market
 *  job board" signal). Tavily falls back to the open web if none match. */
export const JOB_BOARD_DOMAINS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'wellfound.com',
  'builtin.com',
  'ziprecruiter.com',
];

/** Blueprint + provenance: the heuristic fallback is flagged so the composer
 *  never speaks its hardcoded-English seed questions verbatim in a non-English
 *  session (the persisted blueprint keeps the flag for forensics). */
export type GeneratedBlueprint = InterviewBlueprint & { isFallback?: boolean };

export interface PromptGenerationResult {
  systemPrompt: string;
  openingInstruction: string;
  /** Deterministic localized greeting line the worker speaks verbatim. */
  openingLine: string;
  masterBrief: string;
  blueprint: GeneratedBlueprint;
  seedQuestions: SeedQuestion[];
  webSources: Array<{ title: string; url: string }>;
}

// ─── Heuristic fallback blueprint ─────────────────────────────────────────

function fallbackBlueprint(input: PromptGenerationInput): GeneratedBlueprint {
  const r = input.role.trim() || 'this role';
  const d = Math.max(10, input.durationMinutes);
  const open = Math.max(3, Math.round(d * 0.15));
  const close = Math.max(3, Math.round(d * 0.15));
  const core = Math.max(5, d - open - close);
  return {
    isFallback: true,
    requirements: {
      roleSummary: `Interview for ${r}. Focus on demonstrated impact, relevant skills, and clear reasoning.`,
      seniorityBar: 'Owns their work and explains decisions with evidence.',
      mustHaveSkills: ['Core role competencies', 'Clear communication', 'Problem decomposition'],
      coreResponsibilities: ['Deliver outcomes for the role', 'Collaborate with the team', 'Own quality'],
      successSignals: ['Concrete examples with measurable outcomes', 'Structured reasoning', 'Ownership'],
      domainContext: '',
    },
    strategy: {
      overview: `A focused ${input.typeLabel.toLowerCase()} interview: open to build rapport, spend the core probing real examples, then close and invite questions.`,
      phases: [
        { name: 'Warm-up', minutes: open, goal: 'Set context and ease the candidate in.' },
        { name: 'Core', minutes: core, goal: 'Probe the strongest signals for the role with concrete examples.' },
        { name: 'Wrap', minutes: close, goal: 'Close out and take candidate questions.' },
      ],
      focusAreas: ['Relevant experience', 'Reasoning and structure', 'Ownership'],
      signalsToElicit: ['Concrete metrics', 'Decision rationale', 'Lessons learned'],
      redFlagsToProbe: ['Vague claims without evidence', 'No ownership of outcomes'],
      openingApproach: 'Open warmly and orient the candidate to the format.',
      closingApproach: 'Summarize, invite questions, and thank them.',
    },
    tactics: {
      tactics: ['Affirm a real specific, then dig once.', 'Keep an encouraging pace.', 'Cover breadth before depth.'],
      probingTactics: ['Ask "and then what happened?"', 'Demand a metric: "by how much?"', 'STAR gap: "what was YOUR specific action?"', 'Evidence check: "how do you know it worked?"'],
      adaptationRules: [
        'IF the answer is vague THEN probe once for a concrete example before moving on.',
        'IF the answer is strong and specific THEN acknowledge briefly and raise the difficulty.',
        'IF the candidate stalls THEN offer a smaller concrete prompt to restart.',
      ],
    },
    questions: [
      { q: `Tell me about a recent project relevant to ${r} and your specific role in it.`, intent: 'Establish baseline + ownership', idealSignal: 'Concrete role, measurable outcome', probeIfWeak: 'Ask what they personally did.' },
      { q: 'Walk me through a hard decision you made and the tradeoffs you weighed.', intent: 'Judgment', idealSignal: 'Clear reasoning + alternatives', probeIfWeak: 'Ask what they would change.' },
      { q: 'Describe a time something went wrong. What did you own and learn?', intent: 'Accountability', idealSignal: 'Owns their part', probeIfWeak: 'Push past blaming others.' },
      { q: 'How do you measure success in your work?', intent: 'Outcome orientation', idealSignal: 'Names concrete metrics', probeIfWeak: 'Ask for a specific number.' },
      { q: 'What questions do you have for me?', intent: 'Engagement', idealSignal: 'Sharp, researched question', probeIfWeak: 'n/a' },
    ],
  };
}

function blueprintToSeedQuestions(bp: InterviewBlueprint): SeedQuestion[] {
  return bp.questions.slice(0, 8).map((q) => ({
    q: q.q,
    hint: q.idealSignal ? `Aim for: ${q.idealSignal}` : 'Lead with a concrete example.',
    coachTip: { kind: 'good', text: q.probeIfWeak && q.probeIfWeak !== 'n/a' ? `Be ready for: ${q.probeIfWeak}` : 'Be specific — concrete beats abstract.' },
  }));
}

export class InterviewPromptService {
  async generate(input: PromptGenerationInput): Promise<PromptGenerationResult> {
    const startedAt = Date.now();
    const { requestId, signal } = input;

    // 1) Market research (best-effort; JD-aware — see researchMarket).
    const { webEvidence, webSources } = await this.researchMarket(input);

    // 2) Blueprint (one structured agent call), heuristic fallback on throw.
    const blueprint = await this.runBlueprint(input, webEvidence);

    // 3) Deterministic compose.
    const composeParams: ComposeParams = {
      personaName: input.personaName,
      personaRole: input.personaRole,
      personaStyle: input.personaStyle,
      role: input.role,
      typeLabel: input.typeLabel,
      language: input.language,
      durationMinutes: input.durationMinutes,
      characteristics: input.characteristics,
      blueprint,
      blueprintIsFallback: blueprint.isFallback === true,
      candidateName: input.candidateName,
      resumeContext: input.resumeContext,
      archetypeVoiceDirective: getArchetype(input.archetype).voiceDirective,
    };
    const systemPrompt = composeVoiceSystemPrompt(composeParams);
    const openingInstruction = composeOpeningInstruction(composeParams);
    const openingLine = composeOpeningLine(composeParams);
    const masterBrief = composeMasterBrief(composeParams);
    const seedQuestions = blueprintToSeedQuestions(blueprint);

    logger.info('INTERVIEW_ENGINE_PROMPT', 'prompt generated', {
      requestId,
      role: input.role,
      typeLabel: input.typeLabel,
      language: input.language,
      durationMinutes: input.durationMinutes,
      questionCount: blueprint.questions.length,
      webSourceCount: webSources.length,
      promptChars: systemPrompt.length,
      durationMs: Date.now() - startedAt,
    });

    return { systemPrompt, openingInstruction, openingLine, masterBrief, blueprint, seedQuestions, webSources };
  }

  /**
   * Requirements-only generation for the pre-launch preview (requirement #1's
   * UI surfacing): runs ONLY market research + the blueprint agent and SKIPS the
   * compose step (no voice system prompt / no session / no LiveKit / no R2).
   * Inherits the never-throws posture — always returns sensible requirements.
   */
  async previewRequirements(input: PromptGenerationInput): Promise<{
    requirements: InterviewBlueprint['requirements'];
    questions: InterviewBlueprint['questions'];
    webSources: Array<{ title: string; url: string }>;
    groundedOn: 'jd' | 'market' | 'role';
    inferredRole: string;
  }> {
    const { webEvidence, webSources } = await this.researchMarket(input);
    const blueprint = await this.runBlueprint(input, webEvidence);
    const groundedOn: 'jd' | 'market' | 'role' = input.jdText?.trim()
      ? 'jd'
      : webSources.length
        ? 'market'
        : 'role';
    const inferredRole = (input.role ?? '').trim() || inferRoleFromJd(input.jdText ?? '');
    return { requirements: blueprint.requirements, questions: blueprint.questions, webSources, groundedOn, inferredRole };
  }

  // ─── Shared stages ────────────────────────────────────────────────────────

  /** Stage 1: market research. When an authoritative JD is pasted we skip the
   *  board search (the JD already IS the requirements, and skipping saves a
   *  Tavily call + latency at launch). Otherwise we target real job boards and
   *  fall back to the open web inside searchJobRequirements. Never throws. */
  private async researchMarket(input: PromptGenerationInput): Promise<{
    webEvidence: string;
    webSources: Array<{ title: string; url: string }>;
  }> {
    const jd = (input.jdText ?? '').trim();
    // A substantial JD is authoritative — don't spend a search on it.
    if (jd.length > 600) return { webEvidence: '', webSources: [] };
    try {
      const roleForQuery = input.role || input.typeLabel;
      const query = `${roleForQuery} job description requirements responsibilities qualifications`;
      const resp = await searchJobRequirements(query, {
        maxResults: 5,
        includeDomains: JOB_BOARD_DOMAINS,
        requestId: input.requestId,
        signal: input.signal,
      });
      return {
        webEvidence: formatWebEvidence(resp),
        webSources: (resp?.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url })),
      };
    } catch {
      // searchJobRequirements already swallows; belt-and-suspenders.
      return { webEvidence: '', webSources: [] };
    }
  }

  /** Stage 2: one structured blueprint call; heuristic fallback on any throw.
   *  Only the fallback path carries `isFallback` — agent blueprints are
   *  already generated in the session language. */
  private async runBlueprint(input: PromptGenerationInput, webEvidence: string): Promise<GeneratedBlueprint> {
    try {
      return await interviewBlueprintAgent.run(
        {
          role: input.role,
          typeLabel: input.typeLabel,
          typeSub: input.typeSub,
          personaName: input.personaName,
          personaRole: input.personaRole,
          personaStyle: input.personaStyle,
          archetypeDirective: getArchetype(input.archetype).blueprintDirective,
          typeFormatDirective: getFormat(input.typeId)?.blueprintDirective,
          difficultyDirective: `Difficulty ${input.characteristics.difficulty}/5.`,
          pacingDirective: `Pacing ${input.characteristics.pacing}.`,
          mustCoverTopics: input.characteristics.mustCoverTopics,
          focusAreas: input.characteristics.focusAreas,
          durationMinutes: input.durationMinutes,
          followUpDepth: input.characteristics.followUpDepth,
          webEvidence,
          jdText: input.jdText,
          resumeContext: input.resumeContext,
          questionCount: input.questionCount ?? 6,
        },
        { requestId: input.requestId, locale: input.language, signal: input.signal },
      );
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_PROMPT', 'blueprint agent failed; using heuristic', {
        requestId: input.requestId, role: input.role, error: err instanceof Error ? err.message : String(err),
      });
      return fallbackBlueprint(input);
    }
  }
}

export const interviewPromptService = new InterviewPromptService();
export default interviewPromptService;

export { fallbackBlueprint };
export const __test = { fallbackBlueprint, blueprintToSeedQuestions };

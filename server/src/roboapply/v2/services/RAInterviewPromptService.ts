// backend/src/roboapply/v2/services/RAInterviewPromptService.ts
//
// The Interview Prompt Generator orchestrator. Runs the 5-step multi-agent
// pipeline at "Start interview" and deterministically composes the artifacts
// into (a) a master interviewer brief saved on the session and (b) a condensed
// live brief that makes the conducting agent adaptive.
//
//   Tavily research → RAInterviewJobRequirementsAgent
//                    → RAInterviewStrategyAgent
//                    → RAInterviewTacticsAgent
//                    → RAInterviewQuestionsAgent
//                    → deterministic compose
//
// Every stage degrades gracefully: a thrown agent / missing LLM / missing
// Tavily key falls back to a heuristic so a session can ALWAYS start. The
// pipeline is fire-and-forget cost-wise (mock is not a billed SKU).

import { logger } from '../../../services/LoggerService.js';
import { raSearchWeb, formatWebEvidence } from '../lib/raWebSearch.js';
import {
  type RAInterviewBlueprint,
  type RAJobRequirements,
  type RAInterviewStrategy,
  type RAInterviewTactics,
  type RASeedQuestion,
  interviewGenModel,
} from '../lib/interviewGenShared.js';
import { raInterviewJobRequirementsAgent } from '../agents/RAInterviewJobRequirementsAgent.js';
import { raInterviewStrategyAgent } from '../agents/RAInterviewStrategyAgent.js';
import { raInterviewTacticsAgent } from '../agents/RAInterviewTacticsAgent.js';
import { raInterviewQuestionsAgent } from '../agents/RAInterviewQuestionsAgent.js';

export interface RAInterviewPromptPersona {
  id: string;
  name: string;
  role: string;
  style: string;
  blurb: string;
  difficulty: number;
}

export interface RAInterviewPromptInput {
  role: string;
  persona: RAInterviewPromptPersona;
  type: { id: string; label: string; sub: string };
  durationMinutes: number;
  /** BCP-47 interview language; drives LLM output language. */
  language?: string;
  /** Compact résumé context (summary or first ~2k chars). */
  resumeContext?: string;
  /** How many seed questions to aim for. */
  questionCount?: number;
  requestId?: string;
  signal?: AbortSignal;
}

export interface RAInterviewPromptResult {
  /** Full master brief (markdown) — saved on the session, the "interview prompt". */
  interviewPrompt: string;
  /** Condensed brief injected into the live turn-agent for adaptive conduct. */
  interviewerBrief: string;
  blueprint: RAInterviewBlueprint;
  /** Seed questions in the RAMockQuestion wire shape (q/hint/coachTip). */
  seedQuestions: Array<{ q: string; hint: string; coachTip: { kind: 'good' | 'careful'; text: string } }>;
  webSources: Array<{ title: string; url: string }>;
}

// ─── Heuristic fallbacks (used when an agent / LLM / Tavily is unavailable) ─

function fallbackRequirements(role: string, typeLabel: string): RAJobRequirements {
  const r = role.trim() || 'this role';
  return {
    roleSummary: `Interview for ${r}. Focus on demonstrated impact, relevant skills, and clear reasoning.`,
    seniorityBar: 'Calibrated to the candidate — owns their work and explains decisions with evidence.',
    mustHaveSkills: ['Core role competencies', 'Clear communication', 'Problem decomposition'],
    niceToHaveSkills: ['Cross-functional collaboration', 'Domain depth'],
    coreResponsibilities: ['Deliver outcomes for the role', 'Collaborate with the team', 'Own quality'],
    successSignals: ['Concrete examples with measurable outcomes', 'Structured reasoning', 'Ownership'],
    commonInterviewFocus: [`${typeLabel} competencies`, 'Past impact', 'How they handle ambiguity'],
    domainContext: '',
  };
}

function fallbackStrategy(durationMinutes: number, typeLabel: string): RAInterviewStrategy {
  const d = Math.max(5, durationMinutes);
  const open = Math.max(3, Math.round(d * 0.15));
  const close = Math.max(3, Math.round(d * 0.15));
  const core = Math.max(5, d - open - close);
  return {
    overview: `A focused ${typeLabel.toLowerCase()} interview: open to build rapport, spend the core probing real examples, then close with candidate questions.`,
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
  };
}

function fallbackTactics(difficulty: number): RAInterviewTactics {
  const hard = difficulty >= 3;
  return {
    tactics: hard
      ? ['Press for specifics on every claim.', 'Stay neutral; do not over-affirm.', 'Reserve time to go deep on two areas.']
      : ['Affirm a real specific, then dig once.', 'Keep an encouraging pace.', 'Cover breadth before depth.'],
    probingTactics: [
      'Ladder: "and then what happened?"',
      'Demand a metric: "by how much?"',
      'STAR-gap: "what was YOUR specific action?"',
      'Evidence check: "how do you know it worked?"',
    ],
    adaptationRules: [
      'IF the answer is vague THEN probe once for a concrete example before moving on.',
      'IF the answer is strong and specific THEN acknowledge briefly and raise the difficulty.',
      'IF the candidate stalls THEN offer a smaller, concrete prompt to restart.',
    ],
  };
}

// ─── Deterministic composers ──────────────────────────────────────────────

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)';
}

function composeMasterPrompt(
  input: RAInterviewPromptInput,
  bp: RAInterviewBlueprint,
): string {
  const { persona, role, type, durationMinutes } = input;
  const r = bp.requirements;
  const s = bp.strategy;
  const t = bp.tactics;
  const phaseLines = s.phases.map((p) => `- **${p.name}** (${p.minutes}m): ${p.goal}`).join('\n');
  const qLines = bp.questions
    .map(
      (q, i) =>
        `${i + 1}. [${q.phase}] ${q.q}\n   - intent: ${q.intent}\n   - ideal signal: ${q.idealSignal}\n   - probe if weak: ${q.probeIfWeak}`,
    )
    .join('\n');

  return `# Interviewer brief — ${persona.name}, ${persona.role}

You are **${persona.name}** (${persona.role}, ${persona.style}), conducting a **${type.label}** interview for the role of **${role || 'the target role'}**. Total time: **${durationMinutes} minutes**. Difficulty: ${persona.difficulty}/3.

Stay fully in character. Run this as a real, ADAPTIVE conversation — the seed questions below are starting points, not a script. Choose what to ask, probe, or skip based on the candidate's answers and the adaptation rules.

## Role requirements
${r.roleSummary}
Seniority bar: ${r.seniorityBar}
Must-have skills:
${bullets(r.mustHaveSkills)}
Core responsibilities:
${bullets(r.coreResponsibilities)}
What "great" looks like:
${bullets(r.successSignals)}
${r.domainContext ? `\nMarket context: ${r.domainContext}` : ''}

## Strategy & plan
${s.overview}
Phases:
${phaseLines}
Focus areas:
${bullets(s.focusAreas)}
Signals to elicit:
${bullets(s.signalsToElicit)}
Red flags to pressure-test:
${bullets(s.redFlagsToProbe)}
Opening: ${s.openingApproach}
Closing: ${s.closingApproach}

## Tactics
${bullets(t.tactics)}

## Probing tactics
${bullets(t.probingTactics)}

## Adaptation rules (keep the interview adaptive)
${bullets(t.adaptationRules)}

## Seed questions (adapt freely)
${qLines || '- (generate naturally from the requirements and strategy)'}`;
}

/** Short brief injected into every live turn — kept tight to bound latency. */
function composeLiveBrief(
  input: RAInterviewPromptInput,
  bp: RAInterviewBlueprint,
): string {
  const s = bp.strategy;
  const t = bp.tactics;
  return [
    `Persona: ${input.persona.name} — ${input.persona.role} (${input.persona.style}), difficulty ${input.persona.difficulty}/3.`,
    `Role: ${input.role || 'target role'} · Type: ${input.type.label} · ${input.durationMinutes} min.`,
    `Strategy: ${s.overview}`,
    `Focus: ${s.focusAreas.join('; ')}.`,
    `Probing tactics: ${t.probingTactics.join('; ')}.`,
    `Adaptation rules: ${t.adaptationRules.join(' ')}`,
    `Conduct adaptively — probe weak answers per the tactics; do not read a fixed script.`,
  ].join('\n');
}

function toWireQuestions(
  qs: RASeedQuestion[],
): Array<{ q: string; hint: string; coachTip: { kind: 'good' | 'careful'; text: string } }> {
  return qs.map((q) => ({ q: q.q, hint: q.hint, coachTip: q.coachTip }));
}

// ─── Service ────────────────────────────────────────────────────────────

export class RAInterviewPromptService {
  /**
   * Run the full generation pipeline. Never throws — always returns a usable
   * result (heuristic fallbacks fill any stage that fails).
   */
  async generate(input: RAInterviewPromptInput): Promise<RAInterviewPromptResult> {
    const { role, persona, type, durationMinutes, language, resumeContext, requestId, signal } = input;
    const opts = { requestId, locale: language, signal };
    const startedAt = Date.now();

    // ── Step 0: Tavily research (best-effort) ──
    let webEvidence = '';
    let webSources: Array<{ title: string; url: string }> = [];
    try {
      const query = `${role || type.label} role requirements, key skills, and interview focus`;
      const resp = await raSearchWeb(query, { maxResults: 5, requestId, signal });
      webEvidence = formatWebEvidence(resp);
      webSources = (resp?.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
    } catch {
      /* raSearchWeb already swallows; belt-and-suspenders */
    }

    // ── Step 1: requirements ──
    let requirements: RAJobRequirements;
    try {
      requirements = await raInterviewJobRequirementsAgent.run(
        {
          role,
          typeLabel: type.label,
          typeSub: type.sub,
          seniorityHint: persona.role,
          resumeContext,
          webEvidence,
        },
        opts,
      );
      if (!requirements.roleSummary && requirements.mustHaveSkills.length === 0) {
        requirements = fallbackRequirements(role, type.label);
      }
    } catch (err) {
      logger.warn('RA_V2_INTERVIEW_GEN', 'requirements agent failed; using fallback', {
        requestId, error: err instanceof Error ? err.message : String(err),
      });
      requirements = fallbackRequirements(role, type.label);
    }

    // ── Step 2: strategy ──
    let strategy: RAInterviewStrategy;
    try {
      strategy = await raInterviewStrategyAgent.run(
        { role, typeLabel: type.label, typeSub: type.sub, durationMinutes, persona, requirements },
        opts,
      );
      if (strategy.phases.length === 0) strategy = fallbackStrategy(durationMinutes, type.label);
    } catch (err) {
      logger.warn('RA_V2_INTERVIEW_GEN', 'strategy agent failed; using fallback', {
        requestId, error: err instanceof Error ? err.message : String(err),
      });
      strategy = fallbackStrategy(durationMinutes, type.label);
    }

    // ── Steps 3 & 4: tactics + probing tactics ──
    let tactics: RAInterviewTactics;
    try {
      tactics = await raInterviewTacticsAgent.run(
        { persona, typeLabel: type.label, requirements, strategy },
        opts,
      );
      if (tactics.tactics.length === 0 && tactics.probingTactics.length === 0) {
        tactics = fallbackTactics(persona.difficulty);
      }
    } catch (err) {
      logger.warn('RA_V2_INTERVIEW_GEN', 'tactics agent failed; using fallback', {
        requestId, error: err instanceof Error ? err.message : String(err),
      });
      tactics = fallbackTactics(persona.difficulty);
    }

    // ── Step 5: seed questions ──
    let questions: RASeedQuestion[] = [];
    try {
      questions = await raInterviewQuestionsAgent.run(
        {
          role,
          typeLabel: type.label,
          typeSub: type.sub,
          persona,
          requirements,
          strategy,
          tactics,
          resumeContext,
          count: input.questionCount ?? 6,
        },
        opts,
      );
    } catch (err) {
      logger.warn('RA_V2_INTERVIEW_GEN', 'questions agent failed; seed questions empty (caller falls back)', {
        requestId, error: err instanceof Error ? err.message : String(err),
      });
      questions = [];
    }

    const blueprint: RAInterviewBlueprint = {
      requirements,
      strategy,
      tactics,
      questions,
      webSources,
      model: interviewGenModel(),
      generatedAt: new Date().toISOString(),
    };

    const interviewPrompt = composeMasterPrompt(input, blueprint);
    const interviewerBrief = composeLiveBrief(input, blueprint);

    logger.info('RA_V2_INTERVIEW_GEN', 'interview prompt generated', {
      requestId,
      role,
      personaId: persona.id,
      typeId: type.id,
      durationMinutes,
      language: language ?? 'en',
      questionCount: questions.length,
      webSourceCount: webSources.length,
      promptChars: interviewPrompt.length,
      durationMs: Date.now() - startedAt,
    });

    return {
      interviewPrompt,
      interviewerBrief,
      blueprint,
      seedQuestions: toWireQuestions(questions),
      webSources,
    };
  }
}

export const raInterviewPromptService = new RAInterviewPromptService();
export default raInterviewPromptService;

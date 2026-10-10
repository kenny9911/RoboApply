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
//
// GoApply branch (WP-66): a text practice on the cn market in a general type
// (screening / behavioral / culture, or the cn format itself) runs the
// AI-interview format of features/cn/interview: the fixed 20–30 minute script
// and the zh question sets, with one role question written for the job when
// the model is available. Every other GoApply practice runs the pipeline
// above WITHOUT Step 0: no GoApply practice sends the role to the
// international web-search service (the saved job post is the only evidence).
// RoboApply practices run the pipeline above unchanged.

import { logger } from '../../../services/LoggerService.js';
import { llmService } from '../../../services/llm/LLMService.js';
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
import { RAInterviewQuestionsAgent } from '../agents/RAInterviewQuestionsAgent.js';
import { getBrand } from '../../../platform/brand/index.js';
import { getCurrentBrandId } from '../../../lib/requestContext.js';
import {
  CN_FORMAT_FOCUS_AREAS,
  buildCnScript,
  cnStrategyPhases,
  questionHint,
  questionText,
  questionTip,
  usesCnFormat,
  type CnScript,
  type CnSectionId,
} from '../../../features/cn/interview/index.js';

function resolvedInterviewModelLabel(): string {
  const taskModel = interviewGenModel();
  if (taskModel) return taskModel;
  try {
    return llmService.getModel();
  } catch {
    return 'deterministic';
  }
}

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
  /**
   * The job post the practice is for (optional). Given to the requirements
   * agent as evidence, ahead of any web research.
   */
  jdText?: string;
  /** The brand market; defaults to the request's brand (intl when none). */
  market?: 'intl' | 'cn';
  /** Question-selection seed for the cn format (defaults to the request id). */
  seed?: string;
}

/** The cn format's plan, saved in the blueprint (timing per question). */
export interface RACnFormatPlan {
  formatId: string;
  minutes: number;
  language: 'zh' | 'en';
  questions: Array<{ id: string; section: CnSectionId; story: boolean; prepSeconds: number; answerSeconds: number }>;
}

export interface RAInterviewPromptResult {
  /** Full master brief (markdown) — saved on the session, the "interview prompt". */
  interviewPrompt: string;
  /** Condensed brief injected into the live turn-agent for adaptive conduct. */
  interviewerBrief: string;
  blueprint: RAInterviewBlueprint & { cnFormat?: RACnFormatPlan };
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

// ─── GoApply AI-interview format (WP-66) ─────────────────────────────────

/** The market of the request's brand; intl when no brand is set. */
function currentMarket(): 'intl' | 'cn' {
  const id = getCurrentBrandId();
  return id ? getBrand(id).market : 'intl';
}

function jobPostEvidence(jdText: string | undefined): string {
  const jd = (jdText ?? '').trim();
  return jd ? `Job post (saved by the candidate):\n${jd.slice(0, 6000)}` : '';
}

function cnStrategy(minutes: number): RAInterviewStrategy {
  return {
    overview:
      'A timed, one-way practice in the AI-interview format mainland employers commonly use: each question is read once, ' +
      'the candidate gets thinking time and a time limit, and the interviewer stays neutral.',
    phases: cnStrategyPhases(minutes),
    focusAreas: [...CN_FORMAT_FOCUS_AREAS],
    signalsToElicit: ['A complete situation, task, action and result in each story', 'A clear conclusion first', 'Motivation tied to the role'],
    redFlagsToProbe: ['A story with no personal action', 'A story with no result', 'An answer with no structure'],
    openingApproach: 'Explain the format in one sentence (thinking time, time limit, no hints), then ask for the self-introduction.',
    closingApproach: 'Ask the closing question, then thank the candidate. Do not comment on how they did.',
  };
}

const CN_TACTICS: RAInterviewTactics = {
  tactics: [
    'Read each question once, plainly, in the session language.',
    'Stay neutral: no praise, no criticism, no hints during the interview.',
    'Keep to the script order; do not add questions beyond it.',
  ],
  probingTactics: [
    'At most one short follow-up per question.',
    'Story question missing a part: ask only for that part (for example "结果呢？" / "What was the result?").',
    'Structured-thinking question missing a step: ask for the missing step only.',
  ],
  adaptationRules: [
    'IF the answer is complete THEN move to the next question without comment.',
    'IF the answer is off topic THEN restate the question once, then move on.',
    'IF the candidate is silent THEN repeat the question once, then move on.',
  ],
};

function cnFallbackRequirements(role: string): RAJobRequirements {
  const r = role.trim() || 'this role';
  return {
    roleSummary: `Early-career practice for ${r} in the AI-interview format.`,
    seniorityBar: 'Campus or early-career: judged on clear stories, structure and motivation, not years of experience.',
    mustHaveSkills: ['Clear communication', 'Logical structure', 'Teamwork and ownership'],
    niceToHaveSkills: ['Relevant internship or project work'],
    coreResponsibilities: ['Deliver the tasks of the role', 'Work with the team', 'Learn quickly'],
    successSignals: ['Complete STAR stories with a personal action and a result', 'Conclusion-first answers', 'Specific motivation'],
    commonInterviewFocus: ['Self-introduction', 'Motivation', 'Story questions', 'Structured thinking'],
    domainContext: '',
  };
}

function cnSeedQuestions(script: CnScript): RASeedQuestion[] {
  const phaseOf: Record<CnSectionId, string> = {
    self_intro: 'Self-introduction',
    motivation: 'Motivation',
    behavioral: 'Story questions',
    situational: 'Situational and structured thinking',
    logic: 'Situational and structured thinking',
    role: 'Role and closing',
    closing: 'Role and closing',
  };
  return script.questions.map((q) => ({
    phase: phaseOf[q.section],
    q: questionText(q, script.language),
    intent: q.story ? 'One real story with situation, task, action and result.' : `Section: ${q.section.replace('_', ' ')}.`,
    idealSignal: q.story
      ? 'A real, personal story with all four STAR parts and a concrete result.'
      : 'A clear, structured answer: conclusion first, grouped points, a short summary.',
    probeIfWeak: q.story
      ? 'Ask only for the missing STAR part.'
      : 'Ask only for the missing step or reason.',
    hint: questionHint(q, script.language),
    // The answer tip is question-set content (format.ts), like the question
    // and hint. Timing (prep/answer seconds) is NOT written here: it ships as
    // numbers in blueprint.cnFormat and the UI renders practiceCn.format.timing.
    coachTip: { kind: 'good' as const, text: questionTip(q, script.language) },
  }));
}

function composeCnFormatSection(script: CnScript): string {
  const lines = script.questions.map(
    (q) => `- ${q.order + 1}. [${q.section}] thinking ${q.prepSeconds}s, answer ≤ ${q.answerSeconds}s${q.story ? ', STAR story' : ''}`,
  );
  return `## Format: AI-interview practice (${script.minutes} min)
Run the questions below in order, one at a time. Read each question once; give no hints and no feedback during the interview; at most one short follow-up per question, only for a missing STAR part or step. Never name an assessment vendor and never say the result predicts a real hiring decision.
${lines.join('\n')}`;
}

// ─── Service ────────────────────────────────────────────────────────────

export class RAInterviewPromptService {
  /**
   * Run the full generation pipeline. Never throws — always returns a usable
   * result (heuristic fallbacks fill any stage that fails).
   */
  async generate(input: RAInterviewPromptInput): Promise<RAInterviewPromptResult> {
    const market = input.market ?? currentMarket();
    // A general type runs the format only when the chosen length already fits
    // 20–30 min, so the script, the stored plan and the credit gate agree.
    if (usesCnFormat({ market, typeId: input.type.id, minutes: input.durationMinutes })) return this.generateCn(input);

    const { role, persona, type, durationMinutes, language, resumeContext, requestId, signal } = input;
    const opts = { requestId, locale: language, signal };
    const startedAt = Date.now();

    // ── Step 0: Tavily research (best-effort; intl only) ──
    // GoApply (market `cn`) never sends the role to the international search
    // service: the job post the candidate saved is the only evidence.
    let webEvidence = '';
    let webSources: Array<{ title: string; url: string }> = [];
    if (market !== 'cn') {
      try {
        const query = `${role || type.label} role requirements, key skills, and interview focus`;
        const resp = await raSearchWeb(query, { maxResults: 5, requestId, signal });
        webEvidence = formatWebEvidence(resp);
        webSources = (resp?.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
      } catch {
        /* raSearchWeb already swallows; belt-and-suspenders */
      }
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
          webEvidence: [jobPostEvidence(input.jdText), webEvidence].filter(Boolean).join('\n\n'),
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
      // Per-REQUEST instance (like RAMockService does with
      // RAMockInterviewerAgent): this agent stashes the call's locale on `this`
      // so parseOutput knows whether an English default literal is safe. A
      // shared instance would let a concurrent en interview overwrite a zh
      // one's locale mid-flight.
      const questionsAgent = new RAInterviewQuestionsAgent();
      questions = await questionsAgent.run(
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
      // The task selector wins. If every agent degraded because no model was
      // configured, preserve this service's never-throws contract and label
      // the heuristic artifact accurately.
      model: resolvedInterviewModelLabel(),
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

  /**
   * The GoApply AI-interview format (WP-66). Never throws: the script and the
   * zh question sets need no model; the requirements agent and the one role
   * question fall back to fixed text when the model is unavailable.
   */
  private async generateCn(input: RAInterviewPromptInput): Promise<RAInterviewPromptResult> {
    const { role, persona, type, durationMinutes, language, resumeContext, requestId, signal } = input;
    const opts = { requestId, locale: language, signal };
    const startedAt = Date.now();

    let requirements: RAJobRequirements;
    try {
      requirements = await raInterviewJobRequirementsAgent.run(
        {
          role,
          typeLabel: type.label,
          typeSub: type.sub,
          seniorityHint: persona.role,
          resumeContext,
          webEvidence: jobPostEvidence(input.jdText),
        },
        opts,
      );
      if (!requirements.roleSummary && requirements.mustHaveSkills.length === 0) requirements = cnFallbackRequirements(role);
    } catch (err) {
      logger.warn('RA_V2_INTERVIEW_GEN', 'cn format: requirements agent failed; using fallback', {
        requestId, error: err instanceof Error ? err.message : String(err),
      });
      requirements = cnFallbackRequirements(role);
    }

    const strategy = cnStrategy(durationMinutes);
    const tactics = CN_TACTICS;

    // One role question written for this role/job; the generic role set otherwise.
    let roleQuestions: string[] = [];
    if (role.trim() || input.jdText) {
      try {
        const agent = new RAInterviewQuestionsAgent();
        const out = await agent.run(
          {
            role,
            typeLabel: 'Role question',
            typeSub: 'One question about doing this specific role well, answerable by a student or early-career candidate.',
            persona,
            requirements,
            strategy,
            tactics,
            resumeContext,
            count: 1,
          },
          opts,
        );
        roleQuestions = out.map((q) => q.q).filter((q) => q.trim()).slice(0, 1);
      } catch (err) {
        logger.warn('RA_V2_INTERVIEW_GEN', 'cn format: role question failed; using the generic set', {
          requestId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const script = buildCnScript({
      seed: input.seed ?? requestId ?? `${role}:${startedAt}`,
      minutes: durationMinutes,
      language,
      roleQuestions,
    });
    const questions = cnSeedQuestions(script);

    const blueprint: RAInterviewBlueprint & { cnFormat: RACnFormatPlan } = {
      requirements,
      strategy,
      tactics,
      questions,
      webSources: [],
      model: resolvedInterviewModelLabel(),
      generatedAt: new Date().toISOString(),
      cnFormat: {
        formatId: script.formatId,
        minutes: script.minutes,
        language: script.language,
        questions: script.questions.map((q) => ({
          id: q.id, section: q.section, story: q.story, prepSeconds: q.prepSeconds, answerSeconds: q.answerSeconds,
        })),
      },
    };

    const cnInput = { ...input, durationMinutes: script.minutes };
    const interviewPrompt = `${composeMasterPrompt(cnInput, blueprint)}\n\n${composeCnFormatSection(script)}`;
    const interviewerBrief = [
      composeLiveBrief(cnInput, blueprint),
      'Format: AI-interview practice — one question at a time, neutral tone, no hints, at most one short follow-up for a missing STAR part or step.',
    ].join('\n');

    logger.info('RA_V2_INTERVIEW_GEN', 'cn format interview generated', {
      requestId,
      role,
      typeId: type.id,
      minutes: script.minutes,
      language: script.language,
      questionCount: questions.length,
      roleQuestionWritten: roleQuestions.length > 0,
      durationMs: Date.now() - startedAt,
    });

    return {
      interviewPrompt,
      interviewerBrief,
      blueprint,
      seedQuestions: toWireQuestions(questions),
      webSources: [],
    };
  }
}

export const raInterviewPromptService = new RAInterviewPromptService();
export default raInterviewPromptService;

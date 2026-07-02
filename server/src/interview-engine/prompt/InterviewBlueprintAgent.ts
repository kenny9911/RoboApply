// backend/src/interview-engine/prompt/InterviewBlueprintAgent.ts
//
// One comprehensive structured agent that turns (role + type + persona +
// characteristics + Tavily web evidence + résumé context) into a complete
// interview BLUEPRINT in a single LLM call. Replaces the 5-sequential-call
// RoboApply pipeline with one call to bound latency at session creation while
// still grounding on web-researched job requirements (requirement #4).
//
// Failures THROW — interviewPromptService catches and falls back to a heuristic
// blueprint so a session can ALWAYS start.

import { BaseAgent } from '../../agents/BaseAgent.js';

export interface BlueprintRequirements {
  roleSummary: string;
  seniorityBar: string;
  mustHaveSkills: string[];
  coreResponsibilities: string[];
  successSignals: string[];
  domainContext: string;
}

export interface BlueprintPhase {
  name: string;
  minutes: number;
  goal: string;
}

export interface BlueprintStrategy {
  overview: string;
  phases: BlueprintPhase[];
  focusAreas: string[];
  signalsToElicit: string[];
  redFlagsToProbe: string[];
  openingApproach: string;
  closingApproach: string;
}

export interface BlueprintTactics {
  tactics: string[];
  probingTactics: string[];
  adaptationRules: string[];
}

export interface BlueprintQuestion {
  q: string;
  intent: string;
  idealSignal: string;
  probeIfWeak: string;
}

export interface InterviewBlueprint {
  requirements: BlueprintRequirements;
  strategy: BlueprintStrategy;
  tactics: BlueprintTactics;
  questions: BlueprintQuestion[];
}

export interface BlueprintAgentInput {
  role: string;
  typeLabel: string;
  typeSub: string;
  personaName: string;
  personaRole: string;
  personaStyle: string;
  /** The archetype's blueprintDirective — what KIND of questions to design (HOW). */
  archetypeDirective?: string;
  /** The interview FORMAT's blueprintDirective — the STRUCTURE of the exercise (WHAT). */
  typeFormatDirective?: string;
  difficultyDirective: string;
  pacingDirective: string;
  mustCoverTopics: string[];
  focusAreas: string[];
  durationMinutes: number;
  followUpDepth: number;
  webEvidence?: string;
  /** Pasted job description. AUTHORITATIVE when present — outranks webEvidence. */
  jdText?: string;
  resumeContext?: string;
  questionCount: number;
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strArr(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = clip(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export class InterviewBlueprintAgent extends BaseAgent<BlueprintAgentInput, InterviewBlueprint> {
  constructor() {
    super('InterviewBlueprintAgent');
  }

  protected getTemperature(): number {
    return 0.4; // grounded but not robotic
  }

  protected getMaxTokens(): number | undefined {
    return 2200;
  }

  protected getAgentPrompt(): string {
    return `You are an expert interview designer. Given a role, interview type, interviewer persona, characteristics, web-researched job requirements, and (optionally) the candidate's résumé, design a complete, realistic interview BLUEPRINT.

Return STRICT JSON only (no prose, no code fences) with this exact shape:
{
  "requirements": { "roleSummary": "...", "seniorityBar": "...", "mustHaveSkills": ["..."], "coreResponsibilities": ["..."], "successSignals": ["..."], "domainContext": "..." },
  "strategy": { "overview": "...", "phases": [ { "name": "...", "minutes": 5, "goal": "..." } ], "focusAreas": ["..."], "signalsToElicit": ["..."], "redFlagsToProbe": ["..."], "openingApproach": "...", "closingApproach": "..." },
  "tactics": { "tactics": ["..."], "probingTactics": ["..."], "adaptationRules": ["IF ... THEN ..."] },
  "questions": [ { "q": "...", "intent": "...", "idealSignal": "...", "probeIfWeak": "..." } ]
}

Rules:
- If a "Target job description" is provided, it is AUTHORITATIVE: rewrite it into the requirements (roleSummary, seniorityBar, mustHaveSkills, coreResponsibilities, successSignals, domainContext) and base the questions on the competencies it names. Web evidence only supplements gaps the JD leaves open.
- If NO job description is provided, GROUND requirements in the provided web evidence when present; otherwise infer from the role title sensibly.
- If the target role is unspecified but a job description IS given, infer the role title from the JD and make it the subject of roleSummary.
- Do not invent facts about the candidate — only use the résumé context to tailor question targeting.
- Phases' minutes must sum to roughly the total duration.
- Questions must be specific to the interview TYPE and the role, ordered as they would actually be asked, matching the persona's voice and difficulty.
- The Interview FORMAT block (when present) and the Interviewing approach (archetype) block are ORTHOGONAL and BOTH binding: the FORMAT dictates the exercise STRUCTURE / deliverable / how it unfolds (a live role-play's turns, a take-home defense, a clinical scenario, a financial model build, a portfolio walkthrough), while the archetype dictates HOW the interviewer probes and grades. Every question must satisfy BOTH — the correct format/structure AND the archetype's probing style.
- adaptationRules make the interview adaptive (probe weak answers, raise the bar on strong ones).
- Keep every string concise. Output ONLY the JSON object.`;
  }

  protected formatInput(input: BlueprintAgentInput): string {
    const parts: string[] = [];
    parts.push(
      `## Interviewer persona\nName: ${clip(input.personaName, 80)}\nRole: ${clip(input.personaRole, 120)}\nStyle: ${clip(input.personaStyle, 200)}\nDifficulty directive: ${clip(input.difficultyDirective, 300)}\nPacing: ${clip(input.pacingDirective, 200)}`,
    );
    if (input.archetypeDirective) {
      parts.push(
        `## Interviewing approach (SHAPE the questions to this — it defines what KIND of interview this is)\n${clip(input.archetypeDirective, 900)}`,
      );
    }
    parts.push(
      `## Interview\nType: ${clip(input.typeLabel, 80)} — ${clip(input.typeSub, 200)}\nTarget role: ${clip(input.role, 160) || '(unspecified role)'}\nTotal duration: ${input.durationMinutes} minutes\nFollow-up depth on weak answers: ${input.followUpDepth}\nGenerate ${Math.max(4, Math.min(input.questionCount, 10))} questions.`,
    );
    if (input.typeFormatDirective) {
      parts.push(
        `## Interview format (defines the STRUCTURE of the exercise — design the questions to FIT this format)\n${clip(input.typeFormatDirective, 1000)}`,
      );
    }
    if (input.focusAreas.length) parts.push(`## Focus areas (weight these)\n${input.focusAreas.map((f) => `- ${f}`).join('\n')}`);
    if (input.mustCoverTopics.length) parts.push(`## Must-cover topics\n${input.mustCoverTopics.map((f) => `- ${f}`).join('\n')}`);
    if (input.jdText) parts.push(`## Target job description (AUTHORITATIVE — rewrite into structured requirements; outranks web evidence)\n${clip(input.jdText, 4000)}`);
    if (input.webEvidence) parts.push(`## Web-researched job requirements (${input.jdText ? 'supplement the JD where it is silent' : 'ground on this'})\n${clip(input.webEvidence, 2600)}`);
    if (input.resumeContext) parts.push(`## Candidate résumé context (tailor question targeting; do not invent)\n${clip(input.resumeContext, 2000)}`);
    parts.push('Output ONLY the JSON blueprint.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): InterviewBlueprint {
    const cleaned = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('InterviewBlueprintAgent: unparseable response');
    }

    const req = (parsed.requirements ?? {}) as Record<string, unknown>;
    const strat = (parsed.strategy ?? {}) as Record<string, unknown>;
    const tac = (parsed.tactics ?? {}) as Record<string, unknown>;
    const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];

    const phases: BlueprintPhase[] = (Array.isArray(strat.phases) ? strat.phases : [])
      .map((p) => {
        const row = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        const minutes = typeof row.minutes === 'number' ? Math.round(row.minutes) : Number.parseInt(String(row.minutes ?? ''), 10);
        return { name: clip(row.name, 60), minutes: Number.isFinite(minutes) ? minutes : 0, goal: clip(row.goal, 240) };
      })
      .filter((p) => p.name);

    const questions: BlueprintQuestion[] = [];
    for (const q of rawQs) {
      const row = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
      const text = clip(row.q, 600);
      if (!text) continue;
      questions.push({
        q: text,
        intent: clip(row.intent, 240),
        idealSignal: clip(row.idealSignal, 240),
        probeIfWeak: clip(row.probeIfWeak, 240),
      });
      if (questions.length >= 12) break;
    }

    const blueprint: InterviewBlueprint = {
      requirements: {
        roleSummary: clip(req.roleSummary, 600),
        seniorityBar: clip(req.seniorityBar, 400),
        mustHaveSkills: strArr(req.mustHaveSkills, 10, 120),
        coreResponsibilities: strArr(req.coreResponsibilities, 10, 160),
        successSignals: strArr(req.successSignals, 10, 160),
        domainContext: clip(req.domainContext, 600),
      },
      strategy: {
        overview: clip(strat.overview, 600),
        phases,
        focusAreas: strArr(strat.focusAreas, 10, 120),
        signalsToElicit: strArr(strat.signalsToElicit, 10, 160),
        redFlagsToProbe: strArr(strat.redFlagsToProbe, 10, 160),
        openingApproach: clip(strat.openingApproach, 300),
        closingApproach: clip(strat.closingApproach, 300),
      },
      tactics: {
        tactics: strArr(tac.tactics, 10, 200),
        probingTactics: strArr(tac.probingTactics, 10, 200),
        adaptationRules: strArr(tac.adaptationRules, 10, 240),
      },
      questions,
    };

    if (!blueprint.requirements.roleSummary && blueprint.questions.length === 0) {
      throw new Error('InterviewBlueprintAgent: empty blueprint');
    }
    return blueprint;
  }

  async run(
    input: BlueprintAgentInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<InterviewBlueprint> {
    const langSource = `${input.role} ${input.typeLabel} ${input.jdText ?? ''} ${input.webEvidence ?? ''}`.slice(0, 400);
    return this.execute(input, langSource, options.requestId, options.locale, undefined, options.signal);
  }
}

export const interviewBlueprintAgent = new InterviewBlueprintAgent();
export default interviewBlueprintAgent;

// ─── Role-title inference from a pasted JD ─────────────────────────────────
//
// Deterministic, dependency-free best-effort: used to seed a session's `role`
// when the candidate pasted a JD without picking a role. The LLM blueprint
// still infers the canonical title; this is only a cheap fallback so the
// session/report/recents never show an empty title.

const ROLE_KEYWORDS = /\b(engineer|developer|manager|designer|analyst|scientist|lead|director|architect|consultant|specialist|coordinator|administrator|recruiter|nurse|physician|doctor|pharmacist|accountant|controller|auditor|advisor|associate|representative|executive|officer|technician|electrician|therapist|researcher|marketer|strategist|writer|editor|producer|owner|partner|head\s+of|vp|chief)\b/i;
const TITLE_LABEL = /^(?:job\s*title|position|role|职位|岗位|職位|ポジション|職種)\s*[:：]\s*(.+)$/i;

export function inferRoleFromJd(jdText: string): string {
  const text = (jdText ?? '').trim();
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  // 1) An explicit "Title: ..." / "职位：..." label wins.
  for (const line of lines) {
    const m = line.match(TITLE_LABEL);
    if (m && m[1]) return m[1].trim().replace(/[.;,]+$/, '').slice(0, 80);
  }
  // 2) Otherwise the first short, title-like line that names a role.
  for (const line of lines) {
    if (line.length <= 70 && ROLE_KEYWORDS.test(line) && !/[.!?]$/.test(line)) {
      return line.replace(/[.;,]+$/, '').slice(0, 80);
    }
  }
  return '';
}
